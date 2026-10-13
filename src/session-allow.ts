// 「このセッション中は全部許可」の状態と判定。
// 有効な間は、settings の ask に当たる操作を除き、実行許可のリクエストにブリッジが自動で allow を返す。
// deny に当たる操作は Claude Code が確認を出す前に止めるので、ここまで届かない（照合しない）。
// 有効にできるのは .env で SESSION_ALLOW_ALL を指定したボットだけ。起動し直し・!clear・!lock で解除する。
import path from 'node:path';
import os from 'node:os';
import type { PermissionRequest } from './permission.js';
import { denyDirOf, isSameOrAncestor, normalizeCommandName, toRulePath } from './allow-rules.js';
import type { DenyContext } from './allow-rules.js';

const SHELL_TOOLS = new Set(['bash', 'powershell']);
/** パスのルール（Read / Edit）がどのツールに効くか（Claude Code の permission rule と同じ対応） */
const PATH_RULE_TARGETS: Record<string, readonly string[]> = {
  read: ['read', 'grep', 'glob'],
  edit: ['edit', 'write', 'multiedit', 'notebookedit'],
};
/** シェルのコマンドを部分に分ける区切り（`;` `&&` `||` `|` `&` 改行 `$(` バッククォート）。Claude Code は部分ごとに ask と照合する */
const COMMAND_SEPARATOR_RE = /&&|\|\||[;|&\n\r`]|\$\(/;
/** 部分の先頭の環境変数の代入（`FOO=1 git push`） */
const ENV_ASSIGNMENT_RE = /^[A-Za-z_]\w*=/;
/** 照合できる先頭の語の形（引用符・パス・括弧などを含むものは解釈しない） */
const PLAIN_COMMAND_RE = /^[A-Za-z][\w.-]*$/;
/** 後ろの語を別のコマンドとして実行するもの。先頭がこれなら、何を実行するかを解釈しない（当たりにする） */
const WRAPPER_COMMANDS = new Set([
  'env', 'sudo', 'runas', 'timeout', 'time', 'nohup', 'nice', 'xargs', 'command', 'builtin', 'exec', 'eval', 'source',
  'sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh', 'wsl', 'start', 'start-process', 'saps', 'invoke-expression', 'iex',
  'invoke-command', 'icm', 'start-job', 'call',
]);
/** ファイル名だけのパターンで、正規表現に直す前にエスケープする文字（* と ? はワイルドカードとして別に扱う） */
const REGEX_SPECIAL_RE = /[.+^$()|]/g;

/** input_preview（JSON）の文字列の項目。JSON でない（省略されている等）・文字列でなければ undefined */
function inputField(req: PermissionRequest, field: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(req.input_preview);
    if (typeof parsed === 'object' && parsed !== null) {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === 'string') return value;
    }
  } catch {
    // 中身が読めないときは呼び出し側で「当たる」とみなす
  }
  return undefined;
}

/** パスを取るツールのパス（file_path / path / notebook_path） */
function pathOf(req: PermissionRequest): string | undefined {
  return inputField(req, 'file_path') ?? inputField(req, 'path') ?? inputField(req, 'notebook_path');
}

/** ファイル名だけのパターン（`.env`・`*.pem` など。区切りを含まない）を正規表現にする。* と ? 以外の特殊文字があれば undefined */
function namePatternRe(pattern: string): RegExp | undefined {
  if (pattern.includes('/') || /[[\]{}!#\\]/.test(pattern)) return undefined;
  const source = pattern
    .replace(REGEX_SPECIAL_RE, (c) => `\\${c}`)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${source}$`, 'i');
}

/**
 * パスのルール（Read / Edit の中身付き）にリクエストのパスが当たるか。判断できないときは当たりにする（安全側）。
 * - `**\/name` / `name`（ファイル名だけ）: パスの最後の名前が一致すれば当たり
 * - フォルダー以下全部（`//x/**`・`~/x/**`・`./x/**` など）: パスがそのフォルダー以下なら当たり
 */
function pathRuleMatches(body: string, req: PermissionRequest, ctx: DenyContext): boolean {
  const raw = pathOf(req);
  const target = raw === undefined ? undefined : toRulePath(raw);
  if (target === undefined) return true;
  const nameRe = namePatternRe(body.replace(/^\*\*\//, ''));
  if (nameRe) return nameRe.test(path.posix.basename(target));
  const dir = denyDirOf(body, ctx);
  if (dir === undefined) return true;
  return isSameOrAncestor(dir, target);
}

function defaultContext(): DenyContext {
  return { workDir: process.cwd(), home: os.homedir() };
}

/**
 * シェルのコマンドの 1 部分が、ask のプレフィックス（`:*` と末尾の `*` を外したもの）に当たるか。
 * 解釈できない形（先頭の環境変数の代入・ラッパー・引用符やパスの付いた先頭の語・ワイルドカードを含むプレフィックス）は当たりにする。
 * 先頭の語はどちらも normalizeCommandName で正規化してから比べる（`git.exe push` も `git push` に当たる）
 */
function shellPartMatches(part: string, prefix: string): boolean {
  if (prefix.includes('*')) return true;
  const words = part.split(/\s+/);
  const first = words[0] ?? '';
  if (ENV_ASSIGNMENT_RE.test(first) || !PLAIN_COMMAND_RE.test(first)) return true;
  const name = normalizeCommandName(first);
  if (WRAPPER_COMMANDS.has(name)) return true;
  const [prefixFirst = '', ...prefixRest] = prefix.split(/\s+/);
  const normalizedPrefix = [normalizeCommandName(prefixFirst), ...prefixRest].join(' ').toLowerCase();
  return [name, ...words.slice(1)].join(' ').toLowerCase().startsWith(normalizedPrefix);
}

/** シェルのコマンドが ask のプレフィックスに当たるか。区切りで分けた部分のどれかが当たれば当たり */
function shellCommandMatches(command: string, prefix: string): boolean {
  return command
    .split(COMMAND_SEPARATOR_RE)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .some((part) => shellPartMatches(part, prefix));
}

/**
 * MCP のルール（`mcp__<サーバー>` / `mcp__<サーバー>__*` / `mcp__<サーバー>__<ツール>`）がツール（小文字）に当たるか。
 * MCP のルールでなければ undefined
 */
function mcpRuleMatches(rule: string, tool: string): boolean | undefined {
  const name = rule.trim().toLowerCase();
  if (!name.startsWith('mcp__')) return undefined;
  const scope = name.endsWith('__*') ? name.slice(0, -'__*'.length) : name;
  return tool === scope || tool.startsWith(`${scope}__`);
}

/**
 * リクエストが、ask のルールのどれかに当たるなら、そのルールを返す（当たらなければ undefined）。大文字小文字は区別しない。
 * - ツール全体のルール: そのツールの全リクエストに当たる
 * - MCP のルール: `mcp__<サーバー>` と `mcp__<サーバー>__*` は、そのサーバーの全ツールに当たる
 * - シェル（Bash / PowerShell）の中身付き: コマンドを区切りで分けた部分のどれかが当たれば当たり（shellPartMatches）。
 *   コマンドが読めなければ当たり
 * - Read / Edit の中身付き: pathRuleMatches（パスが読めない・複雑なパターンなら当たり）
 * - それ以外のツールの中身付き（WebFetch(domain:...) など）: 判断できないので当たり
 * - 形の読めないルール: 判断できないので、どのリクエストにも当たり
 */
export function matchingRule(req: PermissionRequest, rules: readonly string[], ctx: DenyContext = defaultContext()): string | undefined {
  const tool = req.tool_name.trim().toLowerCase();
  for (const rule of rules) {
    const mcp = mcpRuleMatches(rule, tool);
    if (mcp !== undefined) {
      if (mcp) return rule;
      continue;
    }
    const m = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/.exec(rule.trim());
    if (!m) return rule;
    const ruleTool = (m[1] ?? '').toLowerCase();
    const pathTargets = PATH_RULE_TARGETS[ruleTool];
    if (!(pathTargets ?? [ruleTool]).includes(tool)) continue;
    const body = m[2]?.trim();
    if (!body) return rule;
    if (pathTargets) {
      if (pathRuleMatches(body, req, ctx)) return rule;
      continue;
    }
    if (!SHELL_TOOLS.has(tool)) return rule;
    const command = inputField(req, 'command')?.trim();
    if (command === undefined) return rule;
    const prefix = body.replace(/:\*$|\s*\*$/, '').trim();
    if (shellCommandMatches(command, prefix)) return rule;
  }
  return undefined;
}

export interface SessionAllowState {
  since: Date;
  byUserId: string;
}

export class SessionAllowAll {
  private readonly loadRules: () => string[];
  private readonly ctx: DenyContext;
  private state: SessionAllowState | undefined;

  /** loadRules: 自動許可から外すルール（settings の ask）。判定のたびに読み直す */
  constructor(loadRules: () => string[], ctx: DenyContext = defaultContext()) {
    this.loadRules = loadRules;
    this.ctx = ctx;
  }

  get current(): SessionAllowState | undefined {
    return this.state;
  }

  enable(byUserId: string, now: Date = new Date()): void {
    this.state ??= { since: now, byUserId };
  }

  /** 解除する。有効だったら true */
  disable(): boolean {
    const was = this.state !== undefined;
    this.state = undefined;
    return was;
  }

  /**
   * 全部許可のボタンを出してよいか。ask を読めない（設定ファイルが読めない・JSON でない）なら、
   * 何を自動許可から外すべきか判断できないので false
   */
  available(): boolean {
    try {
      this.loadRules();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 自動で許可してよいか。無効なら false。ask に当たるか、ルールを読めなければ、当たったルール（または理由）付きで false
   */
  check(req: PermissionRequest): { allow: true } | { allow: false; rule?: string | undefined } {
    if (!this.state) return { allow: false };
    let rules: string[];
    try {
      rules = this.loadRules();
    } catch {
      return { allow: false, rule: '(settings を読めなかった)' };
    }
    const hit = matchingRule(req, rules, this.ctx);
    return hit === undefined ? { allow: true } : { allow: false, rule: hit };
  }
}
