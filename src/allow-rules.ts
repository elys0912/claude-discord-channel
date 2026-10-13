// Discord から許可リスト（allow）にルールを恒久追加するための、ルールの生成・安全確認・保存。
// ルールは実行許可のリクエストの中身からだけ作り、自由な入力は受け付けない。
// 作ってよいものを許可リストで決め（シェルは SHELL_RULE_ALLOWLIST）、それ以外・広すぎるもの・deny と重なるものは作らない
// （Discord アカウントの乗っ取りや注入された指示で、何でも無確認実行されるのを防ぐ）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PermissionRequest } from './permission.js';
import { stripBom } from './text.js';
import { errMessage } from './errors.js';

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * パスを取るツール。ツール全体ではなく、対象のフォルダー以下に絞ったルールにする。
 * Claude Code がパスで照合するのは Read(path) と Edit(path) だけなので、ルールはこの 2 つのどちらかで作る
 * （Edit のルールはファイルを書き換える組み込みツール全部に、Read のルールは Grep / Glob にも効く）。
 * - field: 入力のうちパスの項目
 * - isDir: パスがフォルダーそのものか（Grep / Glob）。false ならファイルなので、その親フォルダーにする
 */
const PATH_TOOLS: ReadonlyMap<string, { ruleTool: 'Read' | 'Edit'; field: string; isDir: boolean }> = new Map([
  ['Read', { ruleTool: 'Read', field: 'file_path', isDir: false }],
  ['Grep', { ruleTool: 'Read', field: 'path', isDir: true }],
  ['Glob', { ruleTool: 'Read', field: 'path', isDir: true }],
  ['Edit', { ruleTool: 'Edit', field: 'file_path', isDir: false }],
  ['Write', { ruleTool: 'Edit', field: 'file_path', isDir: false }],
  ['MultiEdit', { ruleTool: 'Edit', field: 'file_path', isDir: false }],
  ['NotebookEdit', { ruleTool: 'Edit', field: 'notebook_path', isDir: false }],
]);
/** パスで照合されるルールのツール */
const PATH_RULE_TOOLS = new Set(['read', 'edit']);
/** フォルダーの深さ（ドライブ・ルートの下の段数）がこれ未満なら、広すぎるので作らない（例: //c/dev は 1 段） */
const MIN_DIR_DEPTH = 2;
/** gitignore のパターンで特別な意味を持つ文字。含むパスからは作らない（エスケープの取り違えで範囲が変わるのを避ける） */
const GLOB_CHARS_RE = /[*?[\]!#{}\\]/;
/**
 * 「♾ 今後も許可」でルールにできるシェルのコマンド（許可リスト）。ここに無いものからはルールを作らない。
 * 引数でファイルの中身を読めない・書けない・コードを実行しないものだけを置く（cat・Get-Content・git diff・npm・node なども置かない）。
 * キーは normalizeCommandName で正規化した先頭の語、name はルールに書く綴り、subcommands があればその 2 語目だけを許す。
 * 一覧は docs/security.md にも書いてある（変えるときは両方を直す）
 */
export const SHELL_RULE_ALLOWLIST: ReadonlyMap<string, { name: string; subcommands?: readonly string[] }> = new Map([
  ['ls', { name: 'ls' }],
  ['dir', { name: 'dir' }],
  ['pwd', { name: 'pwd' }],
  ['get-location', { name: 'Get-Location' }],
  ['get-childitem', { name: 'Get-ChildItem' }],
  ['git', { name: 'git', subcommands: ['status', 'log', 'branch'] }],
]);
/** 先頭の語の末尾から剥がす実行ファイルの拡張子 */
const EXECUTABLE_EXT_RE = /\.(?:exe|cmd|bat|com|ps1)$/;
/** 先頭の語の末尾から剥がす版番号（`python3.12` の `3.12`、`pip3` の `3`） */
const VERSION_SUFFIX_RE = /(?<=[a-z])\d+(?:\.\d+)*$/;
/**
 * ツール全体を許すルールにしてよい MCP のツールの、名前の先頭の語（読み取り専用と名前から分かるもの）。
 * MCP の個別のツール（`mcp__<サーバー>__<ツール>`）だけが対象で、名前に MCP_WRITE_WORDS を含むものは除く
 */
const READ_ONLY_MCP_VERBS = new Set(['get', 'list', 'read', 'search', 'find', 'describe', 'view', 'show']);
/** 読み取りの動詞で始まっても、含んでいれば読み取り専用とみなさない語 */
const MCP_WRITE_WORDS = new Set([
  'create', 'update', 'delete', 'remove', 'write', 'set', 'add', 'put', 'post', 'send', 'edit', 'modify', 'move',
  'rename', 'upload', 'download', 'install', 'run', 'exec', 'execute', 'push', 'merge', 'close', 'approve', 'or', 'and',
]);
const MCP_TOOL_RE = /^mcp__[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*__([A-Za-z0-9_-]+)$/;
/** 複数のコマンドをつなぐ・リダイレクトする記号 */
const COMPOUND_RE = /&&|\|\||[;|<>`\n\r]|\$\(|&\s*$|^\s*&/;

export type RuleResult =
  | { ok: true; rule: string; tool: string; prefix: string | undefined }
  | { ok: false; reason: string; denyHits?: string[] };

/** input_preview（JSON）の文字列の項目。JSON でない（省略されている等）・文字列でなければ undefined */
function inputField(req: PermissionRequest, field: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(req.input_preview);
    if (typeof parsed === 'object' && parsed !== null) {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === 'string') return value;
    }
  } catch {
    // input_preview が JSON でない（省略されている等）ときは作らない
  }
  return undefined;
}

function commandOf(req: PermissionRequest): string | undefined {
  return inputField(req, 'command');
}

/**
 * 絶対パスを、Claude Code の permission rule の形（POSIX 形式・`//` 始まり）にする。
 * Windows の `C:\\dev\\foo` は `//c/dev/foo`、POSIX の `/home/a` は `//home/a`。絶対パスでなければ undefined
 */
export function toRulePath(p: string): string | undefined {
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (win) {
    const rest = (win[2] ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    return `//${(win[1] ?? '').toLowerCase()}${rest ? `/${rest}` : ''}`;
  }
  if (p.startsWith('/') && !p.startsWith('//')) return `/${p.replace(/\/+$/, '')}`;
  return undefined;
}

/** ルール用のパス（`//c/dev/foo`）を区切りで分けた段（`['c', 'dev', 'foo']`） */
function segmentsOf(rulePath: string): string[] {
  return rulePath.replace(/^\/\//, '').split('/').filter((x) => x !== '');
}

/** パスを取るツールのリクエストから、対象のフォルダー以下に絞ったルールを作る */
function derivePathRule(req: PermissionRequest, spec: { ruleTool: 'Read' | 'Edit'; field: string; isDir: boolean }, home: string): RuleResult {
  const raw = inputField(req, spec.field);
  if (!raw) return { ok: false, reason: 'パスを読み取れなかった（入力が省略されているか、フォルダーの指定が無い）' };
  // `..` で範囲を広げられないよう、正規化する前の区切りごとに見る（正規化すると `..` が消える）
  if (raw.split(/[\\/]/).some((seg) => seg === '..' || seg === '.')) {
    return { ok: false, reason: `パスに .. や . を含むので作らない: ${raw}` };
  }
  const target = spec.isDir ? raw : /^[A-Za-z]:/.test(raw) ? path.win32.dirname(raw) : path.posix.dirname(raw);
  const dir = toRulePath(target);
  if (!dir) return { ok: false, reason: `絶対パスでないので作らない: ${raw}` };
  if (GLOB_CHARS_RE.test(dir.slice(2))) return { ok: false, reason: `パスに特殊な文字を含むので作らない: ${raw}` };

  const segments = segmentsOf(dir);
  // Windows はドライブ名の段を除いて数える（//c/dev/foo は 2 段）
  const depth = /^[a-z]$/.test(segments[0] ?? '') && /^[A-Za-z]:/.test(target) ? segments.length - 1 : segments.length;
  if (depth < MIN_DIR_DEPTH) return { ok: false, reason: `フォルダーが浅すぎる（広すぎる）ので作らない: ${raw}` };
  const homeRule = toRulePath(home);
  if (homeRule && isSameOrAncestor(dir, homeRule)) {
    return { ok: false, reason: `ホームフォルダーかその親は広すぎるので作らない: ${raw}` };
  }
  const pattern = `${dir}/**`;
  return { ok: true, rule: `${spec.ruleTool}(${pattern})`, tool: spec.ruleTool, prefix: pattern };
}

/** a が b と同じか、b の親（祖先）フォルダーか（大文字小文字は区別しない） */
export function isSameOrAncestor(a: string, b: string): boolean {
  const x = segmentsOf(a.toLowerCase());
  const y = segmentsOf(b.toLowerCase());
  return x.length <= y.length && x.every((seg, i) => seg === y[i]);
}

/**
 * シェルのコマンドの先頭の語を、許可リストと照合する 1 つの名前にする。
 * 小文字にし、末尾の実行ファイルの拡張子（`.exe` `.cmd` `.bat` `.com` `.ps1`）と版番号を剥がす（`Python3.12.EXE` → `python`）
 */
export function normalizeCommandName(word: string): string {
  return word.toLowerCase().replace(EXECUTABLE_EXT_RE, '').replace(VERSION_SUFFIX_RE, '');
}

/** MCP の個別のツールで、名前から読み取り専用と分かるか（`mcp__github__get_issue` など） */
export function isReadOnlyMcpTool(tool: string): boolean {
  const name = MCP_TOOL_RE.exec(tool)?.[1];
  if (name === undefined) return false;
  // snake_case・kebab-case・camelCase を語に分ける
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_-]+/).filter((w) => w !== '');
  return READ_ONLY_MCP_VERBS.has(words[0] ?? '') && !words.some((w) => MCP_WRITE_WORDS.has(w));
}

/** WebFetch のリクエストから、取得先のホストに絞ったルールを作る */
function deriveWebFetchRule(req: PermissionRequest): RuleResult {
  const raw = inputField(req, 'url');
  let url: URL | undefined;
  try {
    url = raw === undefined ? undefined : new URL(raw);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '') {
    return { ok: false, reason: 'URL のホストを読み取れなかった（入力が省略されている可能性）' };
  }
  const prefix = `domain:${url.hostname}`;
  return { ok: true, rule: `WebFetch(${prefix})`, tool: 'WebFetch', prefix };
}

/** Bash / PowerShell のリクエストから、許可リスト（SHELL_RULE_ALLOWLIST）にあるコマンドだけルールを作る */
function deriveShellRule(req: PermissionRequest, tool: string): RuleResult {
  const command = commandOf(req)?.trim();
  if (!command) return { ok: false, reason: 'コマンドを読み取れなかった（入力が省略されている可能性）' };
  if (COMPOUND_RE.test(command)) return { ok: false, reason: '複数のコマンドをつないだ・リダイレクトを含むコマンドからは作らない' };

  const words = command.split(/\s+/);
  const first = (words[0] ?? '').replace(/^["']|["']$/g, '');
  if (!/^[A-Za-z][\w.-]*$/.test(first) || /[\\/]/.test(first)) {
    return { ok: false, reason: `コマンド名が想定外の形: ${first}` };
  }
  const entry = SHELL_RULE_ALLOWLIST.get(normalizeCommandName(first));
  if (!entry) return { ok: false, reason: `許可リストに無いコマンドなので作らない: ${first}` };
  if (entry.subcommands === undefined) return { ok: true, rule: `${tool}(${entry.name}:*)`, tool, prefix: entry.name };

  const second = words[1];
  if (second === undefined || !entry.subcommands.includes(second)) {
    return { ok: false, reason: `許可リストに無いサブコマンドなので作らない: ${first} ${second ?? ''}`.trimEnd() };
  }
  const prefix = `${entry.name} ${second}`;
  return { ok: true, rule: `${tool}(${prefix}:*)`, tool, prefix };
}

/**
 * 実行許可のリクエストから、許可リストに足すルールの候補を作る。
 * - Bash / PowerShell: SHELL_RULE_ALLOWLIST にある先頭の語（git はサブコマンドまで）だけ `Tool(prefix:*)` にする
 * - Read / Grep / Glob: 対象のフォルダー以下の `Read(//c/dev/foo/**)`
 * - Edit / Write / MultiEdit / NotebookEdit: 対象のフォルダー以下の `Edit(//c/dev/foo/**)`
 *   （浅すぎるフォルダー・ホームとその親・特殊な文字を含むパス・相対パスからは作らない）
 * - WebFetch: 取得先のホストに絞った `WebFetch(domain:<ホスト>)`
 * - MCP の個別のツールで、名前から読み取り専用と分かるもの: ツール名だけのルール（例: `mcp__github__get_issue`）
 * それ以外・複合コマンド・プレフィックスが取れないものは ok: false。deny との照合はここではしない（proposeRule）。
 */
export function deriveRule(req: PermissionRequest, home: string = os.homedir()): RuleResult {
  const tool = req.tool_name.trim();
  if (!/^[A-Za-z][\w-]*$/.test(tool)) return { ok: false, reason: `ツール名が想定外の形: ${tool}` };
  const pathSpec = PATH_TOOLS.get(tool);
  if (pathSpec) return derivePathRule(req, pathSpec, home);
  if (SHELL_TOOLS.has(tool)) return deriveShellRule(req, tool);
  if (tool === 'WebFetch') return deriveWebFetchRule(req);
  if (isReadOnlyMcpTool(tool)) return { ok: true, rule: tool, tool, prefix: undefined };
  return { ok: false, reason: `ツール全体を許すルールは、読み取り専用と分かる MCP のツールにだけ作る: ${tool}` };
}

interface ParsedRule {
  tool: string;
  /** Tool(...) の中身（`:*` / `*` を外したもの）。中身が無ければ undefined（ツール全体） */
  body: string | undefined;
  /** Tool(...) の中身そのまま（パスのパターンの照合に使う） */
  raw: string | undefined;
}

function parseRule(rule: string): ParsedRule | undefined {
  const m = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return undefined;
  const raw = m[2]?.trim();
  const body = raw?.replace(/:\*$|\*$/, '').trim();
  return { tool: m[1] ?? '', body: body === '' ? undefined : body, raw: raw === '' ? undefined : raw };
}

/** 保存済みの候補（`Bash(git status:*)` / `WebFetch(domain:example.com)`）を denyOverlaps に渡せる形に戻す */
export function parseRuleForCheck(rule: string): { tool: string; prefix: string | undefined } | undefined {
  const parsed = parseRule(rule);
  if (!parsed) return undefined;
  // パスのルール（Read(//c/dev/foo/**) など）は、末尾の ** を削らずにそのまま渡す
  if (PATH_RULE_TOOLS.has(parsed.tool.toLowerCase()) && parsed.raw?.startsWith('//')) return { tool: parsed.tool, prefix: parsed.raw };
  return { tool: parsed.tool, prefix: parsed.body };
}

/** 照合に使う基準のフォルダー（deny の相対パス・`~/` の解決に使う） */
export interface DenyContext {
  /** 作業フォルダー（`./path`・`path/sub`・`/path` の基準） */
  workDir: string;
  home: string;
}

function defaultContext(): DenyContext {
  return { workDir: process.cwd(), home: os.homedir() };
}

/**
 * deny のパスのパターンが「あるフォルダー以下全部」を指すなら、そのフォルダー（ルール用のパス）を返す。
 * `//x/**`・`~/x/**`・`./x/**`・`x/y/**`・`/x/**`（作業フォルダー基準とみなす）と、末尾に `/**` の無い同じ形のフォルダー名を扱う。
 * ファイル名だけのもの（`.env`）や途中にワイルドカードがあるもの（`**\/secret/*`）は、フォルダー全体を指さないので undefined
 */
export function denyDirOf(body: string, ctx: DenyContext): string | undefined {
  // 末尾の /** と /*（直下だけ）はどちらもそのフォルダーとみなす（断る側に倒す）
  const pattern = body.replace(/\/\*{1,2}$/, '').replace(/\/+$/, '');
  if (pattern === '' || GLOB_CHARS_RE.test(pattern)) return undefined;
  if (pattern.startsWith('//')) return pattern;
  if (pattern.startsWith('~/')) {
    const home = toRulePath(ctx.home);
    return home ? `${home}/${pattern.slice(2)}` : undefined;
  }
  // gitignore では区切りを含まない名前はどの階層にも当たる（フォルダー全体の指定ではない）
  const relative = pattern.startsWith('/') ? pattern.slice(1) : pattern.replace(/^\.\//, '');
  if (!pattern.startsWith('/') && !pattern.startsWith('./') && !relative.includes('/')) return undefined;
  const base = toRulePath(ctx.workDir);
  return base ? `${base}/${relative}` : undefined;
}

/**
 * 候補のルールが deny のどれかと範囲が重なるかを調べ、重なった deny を返す（重ならなければ空）。大文字小文字は区別しない。
 * - パスのルール（`Read(//c/dev/foo/**)` / `Edit(...)`）: 候補のフォルダーが deny の範囲に丸ごと入るとき（deny がツール全体、
 *   または候補のフォルダーと同じか親のフォルダー以下全部を指すとき）だけ当たりにする。一部だけ重なる deny（`Read(.env)` など）は、
 *   Claude Code が allow より deny を優先するので許しても読めないままで、当たりにしない
 * - それ以外: 同じツールで、どちらかが全体（中身なし）か、シェルならプレフィックスの一方が他方の先頭に一致すれば重なるとみなす。
 *   シェル以外で中身のある deny（例: `Read(.env)`）は、ツール全体を許すルールと重なるとみなす
 */
export function denyOverlaps(
  candidate: { tool: string; prefix: string | undefined },
  deny: readonly string[],
  ctx: DenyContext = defaultContext()
): string[] {
  const hits: string[] = [];
  const candidateDir =
    PATH_RULE_TOOLS.has(candidate.tool.toLowerCase()) && candidate.prefix?.startsWith('//')
      ? candidate.prefix.replace(/\/\*\*$/, '')
      : undefined;
  for (const d of deny) {
    const parsed = parseRule(d);
    if (!parsed || parsed.tool.toLowerCase() !== candidate.tool.toLowerCase()) continue;
    if (candidateDir !== undefined) {
      const denyDir = parsed.raw === undefined ? undefined : denyDirOf(parsed.raw, ctx);
      if (parsed.body === undefined || (denyDir !== undefined && isSameOrAncestor(denyDir, candidateDir))) hits.push(d);
      continue;
    }
    if (parsed.body === undefined || candidate.prefix === undefined) {
      hits.push(d);
      continue;
    }
    const a = candidate.prefix.toLowerCase();
    const b = parsed.body.toLowerCase();
    if (a.startsWith(b) || b.startsWith(a)) hits.push(d);
  }
  return hits;
}

/** 候補のルールを作り、deny と重なるなら断る（重なった deny を添える） */
export function proposeRule(req: PermissionRequest, deny: readonly string[], ctx: DenyContext = defaultContext()): RuleResult {
  const derived = deriveRule(req, ctx.home);
  if (!derived.ok) return derived;
  const hits = denyOverlaps(derived, deny, ctx);
  if (hits.length > 0) {
    return { ok: false, reason: `deny に当たるので追加しない: ${derived.rule}`, denyHits: hits };
  }
  return derived;
}

/**
 * JSON ファイルを読む（BOM 付きでも可）。ファイルが無ければ undefined。
 * 読めない・JSON でないときは投げる（壊れたファイルを「空」と取り違えて、deny の照合抜けや既存ルールの消失を起こさないため）
 */
function readJson(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${file} を読めない: ${errMessage(e)}`, { cause: e });
  }
  try {
    return JSON.parse(stripBom(text)) as unknown;
  } catch (e) {
    throw new Error(`${file} の JSON 構文が不正: ${errMessage(e)}`, { cause: e });
  }
}

/** 配列のうち文字列だけを返す（配列でなければ空） */
function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** 設定ファイル（Claude Code の settings JSON）の permissions.deny を読む。ファイルが無ければ空、読めない・JSON でなければ投げる */
export function readDeny(file: string): string[] {
  return stringsOf((readJson(file) as { permissions?: { deny?: unknown } } | undefined)?.permissions?.deny);
}

/** 設定ファイルの permissions.ask を読む。ファイルが無ければ空、読めない・JSON でなければ投げる */
export function readAsk(file: string): string[] {
  return stringsOf((readJson(file) as { permissions?: { ask?: unknown } } | undefined)?.permissions?.ask);
}

/** 追加分のルール（状態ディレクトリの allow-extra.json）。start.ps1 が起動時に channel-settings.json の allow へ足す */
export class AllowRuleStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** 保存済みのルール。ファイルが無い・読めないときは空（表示用。書き換えには read を使う） */
  list(): string[] {
    try {
      return this.read();
    } catch {
      return [];
    }
  }

  /** 追加する。既にあれば false。ファイルが読めない・JSON でなければ投げる（既存のルールを消さないため） */
  add(rule: string): boolean {
    const rules = this.read();
    if (rules.includes(rule)) return false;
    this.write([...rules, rule]);
    return true;
  }

  /** 消す。無ければ false。ファイルが読めない・JSON でなければ投げる */
  remove(rule: string): boolean {
    const rules = this.read();
    if (!rules.includes(rule)) return false;
    this.write(rules.filter((r) => r !== rule));
    return true;
  }

  /** ファイルが無ければ空、読めない・JSON でなければ投げる */
  private read(): string[] {
    return stringsOf((readJson(this.file) as { allow?: unknown } | undefined)?.allow);
  }

  private write(rules: string[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ allow: rules }, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}
