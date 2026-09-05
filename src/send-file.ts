// PC → Discord のファイル送信（send_file ツールの実体）。
// 手元の何でも外に出せる口になるので、送ってよいかはブリッジが必ず判定する（Claude Code の許可設定には頼らない）。
// - 秘密のファイル（.env・鍵・証明書・~/.ssh など）は、どこにあっても拒否する
// - .env の UPLOAD_DIRS の中なら確認なしで送る。外なら確認のカードを出し、ツールはすぐ「確認待ち」を返す
//   （ツールの呼び出しを長く止めないため。結果は kind="file_sent" のメッセージで Claude に知らせる）
// 判定はジャンクションやシンボリックリンクをたどった先（realpath）で行う。
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Card, CardColor } from './card.js';
import type { DiscordBridge } from './discord.js';
import { errMessage } from './errors.js';
import type { Logger } from './log.js';
import { rewriteAsTextCard } from './notice.js';
import { ACTION, customId } from './permission.js';
import { newToken } from './text.js';
import type { PressedMessage } from './types.js';

/** 1 通に付けられる添付の数（Discord の上限） */
export const MAX_FILES_PER_MESSAGE = 10;
/** 確認の有効期限 */
export const FILE_CONFIRM_TTL_MS = 10 * 60 * 1000;
/** 送るファイル 1 つの既定の上限（ブーストしていないサーバーと DM の上限） */
export const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** 名前で拒否するファイル */
const SECRET_NAME_RES: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|pfx|p12|kdbx|ppk|jks|keystore|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^(\.git-credentials|\.netrc|_netrc|\.npmrc|\.pypirc|credentials(\.json)?)$/i,
];
/** 途中にあれば拒否するフォルダー */
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.claude', '.docker', '.kube', '.azure']);

export type FileSendBridge = Pick<DiscordBridge, 'sendFiles' | 'postCard' | 'updateCard'>;

export interface FileSenderOptions {
  bridge: FileSendBridge;
  /** 確認が済んだあと、結果を Claude に知らせる */
  notify: (content: string, meta: Record<string, string>) => Promise<void>;
  /** 確認なしで送ってよいフォルダー（絶対パス） */
  uploadDirs: readonly string[];
  maxBytes?: number | undefined;
  /** 送らないフォルダー（ブリッジの状態ディレクトリなど。ここも realpath で比べる） */
  protectedDirs?: readonly string[] | undefined;
  logger: Logger;
  newId?: () => string;
  /** 確認の有効期限（テスト用。省略時は FILE_CONFIRM_TTL_MS） */
  confirmTtlMs?: number | undefined;
}

export interface SendFileArgs {
  chat_id: string;
  paths: string[];
  text?: string | undefined;
  thread_id?: string | undefined;
}

interface CheckedFile {
  /** たどった先のパス（実際に読む場所） */
  real: string;
  name: string;
  size: number;
  /** UPLOAD_DIRS の中か */
  inside: boolean;
}

interface Pending {
  args: SendFileArgs;
  files: CheckedFile[];
  timer: ReturnType<typeof setTimeout>;
  message?: { channel: string; ts: string } | undefined;
}

/** Windows では大文字小文字を区別しないので、比べる前にそろえる */
function norm(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** child が dir の中（dir そのものを含む）か */
export function isWithin(child: string, dir: string): boolean {
  const rel = path.relative(norm(dir), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 秘密のファイルとして拒否する理由。当たらなければ undefined */
export function secretReason(file: string): string | undefined {
  const name = path.basename(file);
  if (SECRET_NAME_RES.some((re) => re.test(name))) return `秘密のファイルの可能性がある名前（${name}）`;
  const dirs = path.dirname(path.resolve(file)).split(/[\\/]+/);
  const hit = dirs.find((d) => SECRET_DIRS.has(d.toLowerCase()));
  if (hit) return `秘密のファイルを置くフォルダー（${hit}）の中`;
  return undefined;
}

function fileNames(files: readonly CheckedFile[]): string {
  return files.map((f) => f.name).join(', ');
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}

export class FileSender {
  private readonly opts: FileSenderOptions;
  private readonly maxBytes: number;
  private readonly newId: () => string;
  private readonly pending = new Map<string, Pending>();

  constructor(opts: FileSenderOptions) {
    this.opts = opts;
    this.maxBytes = opts.maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
    this.newId = opts.newId ?? newToken;
  }

  /** 1 つのファイルを判定する。送れないなら理由を投げる */
  private async check(file: string): Promise<CheckedFile> {
    if (!path.isAbsolute(file)) throw new Error(`絶対パスで指定する: ${file}`);
    const direct = secretReason(file);
    if (direct) throw new Error(`送らない: ${direct}`);
    let real: string;
    try {
      real = await fsp.realpath(file);
    } catch {
      throw new Error(`ファイルが無い: ${file}`);
    }
    const viaLink = secretReason(real);
    if (viaLink) throw new Error(`送らない: ${viaLink}`);
    await this.assertNotProtected(real, file);
    const stat = await fsp.stat(real);
    if (!stat.isFile()) throw new Error(`ファイルではない: ${file}`);
    if (stat.size > this.maxBytes) {
      throw new Error(`大きすぎる: ${file}（${formatSize(stat.size)}、上限 ${formatSize(this.maxBytes)}）`);
    }

    return { real, name: path.basename(file), size: stat.size, inside: await this.isInsideUploadDirs(real) };
  }

  /** たどった先が送らないフォルダー（protectedDirs）の中なら投げる。file はエラーの文面に出す、指定されたパス */
  private async assertNotProtected(real: string, file: string): Promise<void> {
    for (const dir of this.opts.protectedDirs ?? []) {
      const realDir = await fsp.realpath(dir).catch(() => dir);
      if (isWithin(real, realDir)) throw new Error(`送らない: ブリッジの設定フォルダーの中（${file}）`);
    }
  }

  /** たどった先が UPLOAD_DIRS のどれかの中か */
  private async isInsideUploadDirs(real: string): Promise<boolean> {
    for (const dir of this.opts.uploadDirs) {
      const realDir = await fsp.realpath(dir).catch(() => undefined);
      if (realDir && isWithin(real, realDir)) return true;
    }
    return false;
  }

  /**
   * send_file ツール。送った・確認待ちにした・送らなかった理由の文面を返す。
   * 投げるのは、送信か確認のカードの投稿に失敗したときだけ（呼び出し側の run がエラーの文面にする）
   */
  async send(args: SendFileArgs): Promise<string> {
    if (args.paths.length === 0) return 'error: paths が空';
    if (args.paths.length > MAX_FILES_PER_MESSAGE) return `error: 1 回に送れるのは ${MAX_FILES_PER_MESSAGE} 個まで`;
    const files: CheckedFile[] = [];
    for (const p of args.paths) {
      try {
        files.push(await this.check(p));
      } catch (e) {
        this.opts.logger.warn(`send_file を拒否 path=${p}`, errMessage(e));
        return `error: ${errMessage(e)}（どのファイルも送っていない）`;
      }
    }

    if (files.every((f) => f.inside)) {
      await this.deliver(args, files);
      return `sent (${files.length} file(s))`;
    }

    const id = this.newId();
    const timer = setTimeout(() => void this.expire(id), this.opts.confirmTtlMs ?? FILE_CONFIRM_TTL_MS);
    timer.unref?.();
    const entry: Pending = { args, files, timer };
    this.pending.set(id, entry);
    let res: Awaited<ReturnType<FileSendBridge['postCard']>>;
    try {
      res = await this.opts.bridge.postCard(args.chat_id, buildConfirmCard(id, files), args.thread_id);
    } catch (e) {
      // カードを出せなかった確認は残さない。残すと期限切れで、出していない確認の結果を Claude に知らせる
      clearTimeout(timer);
      this.pending.delete(id);
      throw e;
    }
    entry.message = { channel: args.chat_id, ts: res.ts };
    this.opts.logger.info(`send_file を確認待ちにした id=${id} files=${files.length}`);
    return `pending: 送ってよい場所の外のファイルがあるので、Discord で確認している（id=${id}）。結果は kind="file_sent" のメッセージで届く。続けて同じファイルを送り直さないこと`;
  }

  private async deliver(args: SendFileArgs, files: CheckedFile[]): Promise<void> {
    await this.opts.bridge.sendFiles(
      args.chat_id,
      files.map((f) => ({ path: f.real, name: f.name })),
      args.text,
      args.thread_id
    );
    this.opts.logger.info(`send_file を送信 files=${files.map((f) => f.name).join(',')}`);
  }

  /** 確認のカードのボタンが押された。投げない */
  async confirm(id: string, accept: boolean, pressed: PressedMessage, byUserId: string): Promise<void> {
    const entry = this.pending.get(id);
    this.pending.delete(id);
    if (!entry) {
      await this.report(pressed, '⌛ この確認は期限切れか、もう答えてある。', 'muted');
      return;
    }
    clearTimeout(entry.timer);
    const names = fileNames(entry.files);
    if (!accept) {
      this.opts.logger.info(`send_file を取りやめ id=${id} by=${byUserId}`);
      await this.report(pressed, `🚫 送らなかった: ${names}`, 'muted');
      await this.tell(entry.args, 'cancelled', `ファイルの送信は取りやめになった（${names}）`);
      return;
    }
    try {
      await this.deliver(entry.args, entry.files);
      await this.report(pressed, `📎 送った: ${names}`, 'ok');
      await this.tell(entry.args, 'sent', `ファイルを送った（${names}）`);
    } catch (e) {
      this.opts.logger.warn(`send_file の送信に失敗 id=${id}`, e);
      await this.report(pressed, `⚠️ 送れなかった: ${names}（${errMessage(e)}）`, 'error');
      await this.tell(entry.args, 'failed', `ファイルを送れなかった（${names}）: ${errMessage(e)}`);
    }
  }

  private async expire(id: string): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    const names = fileNames(entry.files);
    if (entry.message) {
      const pressed = { ...entry.message, threadTs: entry.args.thread_id ?? entry.message.ts };
      await this.report(pressed, `⌛ 答えが無かったので送らなかった: ${names}`, 'muted');
    }
    await this.tell(entry.args, 'expired', `確認に答えが無かったので、ファイルは送らなかった（${names}）`);
  }

  /** 結果を Claude に知らせる。投げない */
  private async tell(args: SendFileArgs, result: 'sent' | 'cancelled' | 'expired' | 'failed', content: string): Promise<void> {
    try {
      await this.opts.notify(content, {
        kind: 'file_sent',
        result,
        chat_id: args.chat_id,
        ...(args.thread_id ? { thread_id: args.thread_id } : {}),
      });
    } catch (e) {
      this.opts.logger.warn('send_file の結果を Claude に知らせられなかった', e);
    }
  }

  private async report(pressed: PressedMessage, text: string, color: CardColor): Promise<void> {
    if (!pressed.ts) return;
    await rewriteAsTextCard(this.opts, { channel: pressed.channel, ts: pressed.ts }, text, color, 'ファイル送信の確認の書き換えに失敗');
  }

  /** 終了時。確認待ちのタイマーを止める（送らない） */
  stop(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }
}

/** 送ってよい場所の外のファイルを送るかの確認 */
export function buildConfirmCard(id: string, files: readonly CheckedFile[]): Card {
  return {
    color: 'warn',
    title: '📎 このファイルを送っていい？',
    body: '送ってよい場所（UPLOAD_DIRS）の外のファイルが含まれている。中身を外に出してよいものか確かめてから答える。',
    code: files.map((f) => `${f.inside ? '  ' : '⚠ '}${f.real}（${formatSize(f.size)}）`).join('\n'),
    note: `10 分答えなければ送らない ・ ID: ${id}`,
    buttons: [
      [
        { label: '送る', id: customId(ACTION.FILE_OK, id), style: 'danger' },
        { label: 'やめる', id: customId(ACTION.FILE_NO, id) },
      ],
    ],
  };
}
