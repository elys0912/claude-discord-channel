import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/log.js';
import { TypingIndicator } from '../src/typing.js';

describe('TypingIndicator', () => {
  let calls: string[];
  const bridge = {
    sendTyping: (chat: string, thread?: string) => {
      calls.push(`${chat}:${thread ?? ''}`);
      return Promise.resolve();
    },
  };
  const make = () => new TypingIndicator(bridge, new Logger({ stderr: false }), 8_000, 30_000, () => Date.now());

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('すぐに出し、間隔ごとに出し直し、止めたら出さない', async () => {
    const t = make();
    t.start('c', 't');
    expect(calls).toEqual(['c:t']);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(calls).toHaveLength(3);
    t.stopAll();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(calls).toHaveLength(3);
    expect(t.size).toBe(0);
  });

  it('上限の時間を過ぎたら自分で止まる', async () => {
    const t = make();
    t.start('c', undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.size).toBe(0);
    // 間隔 8,000ms・上限 30,000ms なので、0・8,000・16,000・24,000ms の 4 回で止まる（32,000ms の回は上限を過ぎている）
    expect(calls).toHaveLength(4);
  });

  it('同じ返信先で始め直すと、上限の時間が延びて二重には出さない', async () => {
    const t = make();
    t.start('c', 't');
    await vi.advanceTimersByTimeAsync(24_000);
    t.start('c', 't');
    expect(t.size).toBe(1);
    await vi.advanceTimersByTimeAsync(24_000);
    expect(t.size).toBe(1);
  });

  it('表示に失敗しても投げない', async () => {
    const t = new TypingIndicator({ sendTyping: () => Promise.reject(new Error('x')) }, new Logger({ stderr: false }));
    expect(() => t.start('c', 't')).not.toThrow();
    t.stopAll();
  });
});
