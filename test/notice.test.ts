import { describe, expect, it, vi } from 'vitest';
import { NoticePoster, textCard } from '../src/notice.js';
import type { NoticeBridge } from '../src/notice.js';
import type { Card } from '../src/card.js';
import { Logger } from '../src/log.js';
import type { ThreadRef } from '../src/types.js';

function fakeBridge(fail = false): NoticeBridge & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    postCard: async (...args) => {
      calls.push({ method: 'postCard', args });
      if (fail) throw new Error('Unknown Channel');
      return { ts: '1' };
    },
    postToAll: async (...args) => {
      calls.push({ method: 'postToAll', args });
      if (fail) throw new Error('401: Unauthorized');
      return [];
    },
  };
}

describe('textCard', () => {
  it('本文の Markdown の記号をエスケープし、既定は info の色にする', () => {
    expect(textCard('*太字* と `code`')).toEqual({ color: 'info', body: '\\*太字\\* と \\`code\\`' });
    expect(textCard('x', 'error').color).toBe('error');
  });
});

describe('NoticePoster', () => {
  it('話しかけられたスレッドがあれば、そのスレッドに出す', async () => {
    const bridge = fakeBridge();
    const thread: ThreadRef = { channel: 'D1', threadTs: '70' };
    const card: Card = { color: 'warn', body: 'hello' };
    await new NoticePoster(bridge, () => thread, new Logger({ stderr: false })).post('hello', card);
    expect(bridge.calls).toEqual([{ method: 'postCard', args: ['D1', card, '70'] }]);
  });

  it('スレッドが無ければ許可ユーザー全員の DM に出す。card を省略すれば text だけのカードにする', async () => {
    const bridge = fakeBridge();
    await new NoticePoster(bridge, () => undefined, new Logger({ stderr: false })).post('hello');
    expect(bridge.calls).toEqual([{ method: 'postToAll', args: [{ color: 'info', body: 'hello' }] }]);
  });

  it('投稿に失敗しても投げず、warn に残す', async () => {
    const logger = new Logger({ stderr: false });
    const warn = vi.spyOn(logger, 'warn');
    const thread: ThreadRef = { channel: 'D1', threadTs: '70' };
    await expect(new NoticePoster(fakeBridge(true), () => thread, logger).post('hello')).resolves.toBeUndefined();
    await expect(new NoticePoster(fakeBridge(true), () => undefined, logger).post('hello')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('知らせの投稿に失敗');
  });
});
