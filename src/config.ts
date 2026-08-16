// 設定・トークン・アクセス許可リストのロード。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { errMessage } from './errors.js';
import { stripBom } from './text.js';

/** 状態ディレクトリの既定の場所（ホームからの相対。scripts/start.ps1 の $DefaultStateDirRelative と同じ値にすること） */
const DEFAULT_STATE_DIR_RELATIVE = ['.claude', 'channels', 'discord-bridge'];

/**
 * 状態ディレクトリ（.env / access.json / logs / instance.lock の置き場所）を返す。
 * DISCORD_CHANNEL_STATE_DIR があれば path.resolve で絶対パスにして使う（相対パスはこのプロセスのカレントディレクトリ基準）。
 * 無ければ `~/.claude/channels/discord-bridge`（公式の Discord プラグインの `discord` と分ける）。
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.DISCORD_CHANNEL_STATE_DIR;
  if (dir) return path.resolve(dir);
  return path.join(os.homedir(), ...DEFAULT_STATE_DIR_RELATIVE);
}

// `=` より右側を値として解釈する。引用符で囲まれていれば中身を返し、閉じ引用符の後ろの ` # ...` は捨てる。
// 引用符が無ければ、空白に続く `#` 以降を行末コメントとして捨てる（`a#b` のように空白が無い `#` は値の一部）。
function parseValue(raw: string): string {
  const value = raw.trim();
  const first = value[0];
  if (first === '"' || first === "'") {
    const close = value.indexOf(first, 1);
    if (close !== -1) {
      const rest = value.slice(close + 1).trim();
      if (rest === '' || rest.startsWith('#')) return value.slice(1, close);
    }
    // 途中に同じ引用符を含む `"a"b"` などは従来どおり両端の引用符だけを剥がす
    return value.length >= 2 && value.endsWith(first) ? value.slice(1, -1) : value;
  }
  const comment = raw.search(/(^|\s)#/);
  return (comment === -1 ? raw : raw.slice(0, comment)).trim();
}

// 自前の .env パーサー。KEY=VALUE / # コメント（行頭・値の後ろ）/ 空行 / 前後空白 / "..." '...' の引用符 /
// CRLF / BOM / `export ` 接頭辞に対応する。値の展開や複数行はしない。
export function parseDotenv(text: string): Record<string, string> {
  const stripped = stripBom(text);
  const result: Record<string, string> = {};

  for (const rawLine of stripped.split(/\r\n|\r|\n/)) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    if (line.startsWith('export ')) {
      line = line.slice('export '.length).trim();
    }

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    result[key] = parseValue(line.slice(eq + 1));
  }

  return result;
}

export interface Tokens {
  botToken: string;
  /**
   * 受け取った添付を保存するフォルダー（.env の DOWNLOAD_DIR を絶対パスにしたもの）。
   * 設定されているときだけ download_file ツールを出す
   */
  downloadDir?: string;
  /** .env の SESSION_ALLOW_ALL が on / true / 1 なら、実行許可に「このセッション中は全部許可」ボタンを出す */
  sessionAllowAll?: boolean;
  /** .env の INLINE_TEXT_MAX_KB。テキストの添付を本文に差し込む 1 ファイルの上限（KB）。0 なら差し込まない */
  inlineTextMaxKb?: number;
}

/** INLINE_TEXT_MAX_KB の上限（Claude に渡す本文を膨らませすぎない） */
const INLINE_TEXT_MAX_KB_LIMIT = 1024;

/** ボットのトークンの形（`.` で区切られた 3 つの部分）。値そのものはログやエラーに出さない */
const BOT_TOKEN_RE = /^[\w-]{20,}\.[\w-]{5,}\.[\w-]{25,}$/;

/**
 * dir/.env から DISCORD_BOT_TOKEN と、任意の DOWNLOAD_DIR・SESSION_ALLOW_ALL を読む。環境変数は見ない。
 * ファイルが読めない・キーが無い・トークンの形が違う・DOWNLOAD_DIR が絶対パスでないときは投げる（メッセージにトークンの値は含めない）。
 */
export function loadTokens(dir: string): Tokens {
  const file = path.join(dir, '.env');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`.env が見つからない: ${file}`, { cause: e });
  }

  const parsed = parseDotenv(text);
  // process.env には書き込まない（子プロセスへ引き継がれるため）
  const botToken = parsed.DISCORD_BOT_TOKEN;
  if (!botToken) throw new Error('DISCORD_BOT_TOKEN が設定されていない');
  if (!BOT_TOKEN_RE.test(botToken)) throw new Error('DISCORD_BOT_TOKEN の形が不正（Developer Portal の Bot で発行したトークンを貼る）');
  const tokens: Tokens = { botToken };
  const downloadDir = parsed.DOWNLOAD_DIR;
  if (downloadDir) {
    // 相対パスはカレントディレクトリ（起動したプロジェクト）次第で保存先が変わるので受け付けない
    if (!path.isAbsolute(downloadDir)) throw new Error('DOWNLOAD_DIR は絶対パスで指定する');
    tokens.downloadDir = path.resolve(downloadDir);
  }
  if (/^(on|true|1)$/i.test(parsed.SESSION_ALLOW_ALL ?? '')) tokens.sessionAllowAll = true;
  const inlineKb = parsed.INLINE_TEXT_MAX_KB;
  if (inlineKb !== undefined && inlineKb !== '') {
    const n = Number(inlineKb);
    if (!Number.isInteger(n) || n < 0 || n > INLINE_TEXT_MAX_KB_LIMIT) {
      throw new Error(`INLINE_TEXT_MAX_KB は 0〜${INLINE_TEXT_MAX_KB_LIMIT} の整数で指定する`);
    }
    tokens.inlineTextMaxKb = n;
  }
  return tokens;
}

/** Discord の ID（snowflake）。数字だけの 17〜20 桁 */
export const SNOWFLAKE_RE = /^\d{17,20}$/;

const snowflake = (what: string) => z.string().regex(SNOWFLAKE_RE, `${what} の形式が不正（数字だけの Discord の ID）`);

/**
 * access.json のスキーマ。未知のキーはエラー（strictObject）。
 * guildId はボットを入れたサーバーの ID、allowFrom は話しかけてよい人のユーザー ID（1 件以上・重複不可）。
 * channels は DM に加えて使うチャンネルの ID で、省略時は DM のみ。重複不可。
 */
export const AccessSchema = z.strictObject({
  guildId: snowflake('guildId'),
  allowFrom: z
    .array(snowflake('allowFrom'))
    .min(1, 'allowFrom は1件以上必要')
    .refine((arr) => new Set(arr).size === arr.length, { message: 'allowFrom に重複がある' }),
  channels: z
    .array(snowflake('channels'))
    .refine((arr) => new Set(arr).size === arr.length, { message: 'channels に重複がある' })
    .optional(),
});

export type ParsedAccess = z.infer<typeof AccessSchema>;

/**
 * dir/access.json を読み、AccessSchema で検証して返す。先頭の BOM は取り除いてから JSON として解釈する。
 * 次の場合は投げる: ファイルが読めない（`access.json が見つからない`）、JSON 構文エラー（`JSON 構文が不正`）、
 * スキーマ違反（`access.json の検証に失敗: <パス>: <理由>; ...`）。
 */
export function loadAccess(dir: string): ParsedAccess {
  const file = path.join(dir, 'access.json');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`access.json が見つからない: ${file}`, { cause: e });
  }

  let json: unknown;
  try {
    json = JSON.parse(stripBom(text));
  } catch (e) {
    throw new Error(`access.json の JSON 構文が不正: ${errMessage(e)}`, { cause: e });
  }

  const result = AccessSchema.safeParse(json);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`access.json の検証に失敗: ${details}`);
  }

  return result.data;
}
