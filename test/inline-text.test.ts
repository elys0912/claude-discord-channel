import { describe, expect, it } from 'vitest';
import type { AttachmentRef, RemoteFile } from '../src/discord.js';
import { DEFAULT_INLINE_LIMITS, inlineTextAttachments, isTextAttachment, pickInline } from '../src/inline-text.js';
import { Logger } from '../src/log.js';

const logger = new Logger({ stderr: false });
const at = { chatId: 'c', messageId: 'm', threadId: 't' };

/** 添付の ID → 中身。中身が Error なら取得に失敗する */
function fakeBridge(files: Record<string, { name: string; body: string | Uint8Array<ArrayBuffer> | Error }>) {
  const asked: AttachmentRef[] = [];
  return {
    asked,
    bridge: {
      attachmentInfo: (ref: AttachmentRef): Promise<RemoteFile> => {
        asked.push(ref);
        const f = files[ref.attachmentId];
        if (!f) return Promise.reject(new Error('not found'));
        return Promise.resolve({ id: ref.attachmentId, name: f.name, url: `https://cdn.discordapp.com/${ref.attachmentId}` });
      },
      fetchFile: (file: RemoteFile, signal?: AbortSignal): Promise<Response> => {
        const body = files[file.id]?.body;
        if (body instanceof Error) return Promise.reject(body);
        // 応答の無い CDN の代わり。signal が切れるまで返さない
        if (body === 'hang') {
          return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
        }
        return Promise.resolve(new Response(body ?? ''));
      },
    },
  };
}

describe('isTextAttachment / pickInline', () => {
  it('text/ の種類か、テキストの拡張子なら対象', () => {
    expect(isTextAttachment({ name: 'message.txt', mimetype: 'text/plain; charset=utf-8' })).toBe(true);
    expect(isTextAttachment({ name: 'build.log' })).toBe(true);
    expect(isTextAttachment({ name: 'a.json', mimetype: 'application/json' })).toBe(true);
    expect(isTextAttachment({ name: 'a.png', mimetype: 'image/png' })).toBe(false);
  });

  it('数・1 ファイル・合計の上限に収まるものだけを前から選ぶ。大きさの分からないものは選ばない', () => {
    const limits = { maxFileBytes: 100, maxFiles: 2, maxTotalBytes: 150 };
    const f = (id: string, size?: number) => ({ id, name: `${id}.txt`, size });
    expect(pickInline([f('a', 101), f('b', 80), f('c', 80), f('d', 60), f('e', 10)], limits).map((x) => x.id)).toEqual(['b', 'd']);
    expect(pickInline([f('a')], limits)).toEqual([]);
  });
});

describe('inlineTextAttachments', () => {
  it('本文の後ろに見出し付きで中身を足し、名前を返す（BOM は取る）', async () => {
    const { bridge, asked } = fakeBridge({ '1': { name: 'message.txt', body: '﻿ログの中身' } });
    const r = await inlineTextAttachments({ bridge, logger }, at, '見て', true, [{ id: '1', name: 'message.txt', size: 20 }]);
    expect(r).toEqual({ content: '見て\n\n（添付 message.txt の中身）\nログの中身', inlined: ['message.txt'] });
    expect(asked[0]).toEqual({ ...at, attachmentId: '1' });
  });

  it('本文が無ければ（添付の代わりの文言なら）中身だけにする', async () => {
    const { bridge } = fakeBridge({ '1': { name: 'message.txt', body: 'abc' } });
    const r = await inlineTextAttachments({ bridge, logger }, at, '(attachment)', false, [{ id: '1', name: 'message.txt', size: 3 }]);
    expect(r.content).toBe('（添付 message.txt の中身）\nabc');
  });

  it('取得に失敗したものと、実際の大きさが上限を超えたものは飛ばし、1 つも無ければ本文のまま', async () => {
    const big = new Uint8Array(DEFAULT_INLINE_LIMITS.maxFileBytes + 1);
    const { bridge } = fakeBridge({ '1': { name: 'a.txt', body: new Error('boom') }, '2': { name: 'b.txt', body: big } });
    const files = [
      { id: '1', name: 'a.txt', size: 10 },
      { id: '2', name: 'b.txt', size: 10 },
    ];
    expect(await inlineTextAttachments({ bridge, logger }, at, '本文', true, files)).toEqual({ content: '本文', inlined: [] });
  });

  it('応答の無い取得は上限の時間で諦めて飛ばし、ほかの添付は差し込む', async () => {
    const { bridge } = fakeBridge({ '1': { name: 'a.txt', body: 'hang' }, '2': { name: 'b.txt', body: 'b' } });
    const files = [
      { id: '1', name: 'a.txt', size: 10 },
      { id: '2', name: 'b.txt', size: 1 },
    ];
    const r = await inlineTextAttachments({ bridge, logger, fetchTimeoutMs: 20 }, at, '本文', true, files);
    expect(r.inlined).toEqual(['b.txt']);
  });

  it('名前の区切りになり得る文字は _ にする', async () => {
    const { bridge } = fakeBridge({ '1': { name: 'a"b,c.txt', body: 'x' } });
    const r = await inlineTextAttachments({ bridge, logger }, at, '', false, [{ id: '1', name: 'a"b,c.txt', size: 1 }]);
    expect(r.inlined).toEqual(['a_b_c.txt']);
  });
});
