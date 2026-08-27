// テキストの添付を本文に差し込む（長文の貼り付け対策）。
// Discord は 2000 字を超える貼り付けを message.txt の添付に変えるので、そのままだと Claude には「(attachment)」としか届かない。
// 小さなテキストの添付は中身を取ってきて本文の後ろに足し、それ以外は今までどおり download_file に任せる。
import type { AttachmentRef, DiscordBridge } from './discord.js';
import { errMessage } from './errors.js';
import type { FileInfo } from './gate.js';
import type { Logger } from './log.js';

export interface InlineLimits {
  /** 1 ファイルの上限（バイト） */
  maxFileBytes: number;
  /** 1 メッセージで差し込むファイルの数 */
  maxFiles: number;
  /** 1 メッセージで差し込む合計（バイト） */
  maxTotalBytes: number;
}

export const DEFAULT_INLINE_LIMITS: InlineLimits = {
  maxFileBytes: 100 * 1024,
  maxFiles: 3,
  maxTotalBytes: 200 * 1024,
};

const TEXT_EXTENSION_RE = /\.(txt|log|md|csv|tsv|json|jsonl|ya?ml|diff|patch|xml|ini|toml)$/i;

export type InlineBridge = Pick<DiscordBridge, 'attachmentInfo' | 'fetchFile'>;

/** テキストとして差し込める添付か（種類が text/ か、テキストの拡張子） */
export function isTextAttachment(f: FileInfo): boolean {
  const type = (f.mimetype ?? '').toLowerCase();
  return type.startsWith('text/') || type.startsWith('application/json') || TEXT_EXTENSION_RE.test(f.name ?? '');
}

/** 差し込む添付を選ぶ（前から順に、数・1 ファイル・合計の上限に収まるものだけ） */
export function pickInline(files: readonly FileInfo[], limits: InlineLimits): FileInfo[] {
  const out: FileInfo[] = [];
  let total = 0;
  for (const f of files) {
    if (out.length >= limits.maxFiles) break;
    if (!f.id || !isTextAttachment(f)) continue;
    const size = f.size ?? Number.POSITIVE_INFINITY;
    if (size > limits.maxFileBytes || total + size > limits.maxTotalBytes) continue;
    out.push(f);
    total += size;
  }
  return out;
}

export interface InlineDeps {
  bridge: InlineBridge;
  logger: Logger;
  limits?: InlineLimits | undefined;
}

export interface InlineResult {
  content: string;
  /** 差し込んだ添付の名前 */
  inlined: string[];
}

/**
 * テキストの添付の中身を本文の後ろに足す。本文が無かった（content が添付の代わりの文言）なら、差し込んだ中身だけにする。
 * 取得に失敗した添付は飛ばしてログに残す（その添付は attachment_ids から download_file で取れる）。投げない。
 */
export async function inlineTextAttachments(
  deps: InlineDeps,
  at: Omit<AttachmentRef, 'attachmentId'>,
  content: string,
  hasText: boolean,
  files: readonly FileInfo[]
): Promise<InlineResult> {
  const limits = deps.limits ?? DEFAULT_INLINE_LIMITS;
  const parts: string[] = hasText ? [content] : [];
  const inlined: string[] = [];
  for (const f of pickInline(files, limits)) {
    try {
      const info = await deps.bridge.attachmentInfo({ ...at, attachmentId: f.id ?? '' });
      const res = await deps.bridge.fetchFile(info);
      const buf = await res.arrayBuffer();
      if (buf.byteLength > limits.maxFileBytes) throw new Error(`大きすぎる（${buf.byteLength} バイト）`);
      // 壊れた文字は置き換え、先頭の BOM は取る（TextDecoder の既定）
      const text = new TextDecoder('utf-8').decode(buf);
      parts.push(`（添付 ${info.name} の中身）\n${text}`);
      // meta の値に載せるので、区切りやタグの区切りになり得る文字は _ にする（gate.ts の添付の要約と同じ）
      inlined.push(info.name.replace(/[;,\r\n<>"'=]/g, '_'));
    } catch (e) {
      deps.logger.warn(`テキストの添付を差し込めなかった attachment=${f.id ?? '-'}`, errMessage(e));
    }
  }
  if (inlined.length === 0) return { content, inlined };
  return { content: parts.join('\n\n'), inlined };
}
