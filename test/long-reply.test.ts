import { describe, expect, it } from 'vitest';
import { LONG_REPLY_FILE_NAME, toLongReply } from '../src/long-reply.js';

describe('toLongReply', () => {
  it('上限以下なら分けて送る（undefined）', () => {
    expect(toLongReply('a'.repeat(6000))).toBeUndefined();
  });

  it('上限が 0 なら長さによらず分けて送る', () => {
    expect(toLongReply('a'.repeat(10_000), 0)).toBeUndefined();
  });

  it('上限を超えたら冒頭を本文に、全文を添付にし、本文は 2000 字に収める', () => {
    const text = 'あ'.repeat(7000);
    const r = toLongReply(text);
    expect(r?.name).toBe(LONG_REPLY_FILE_NAME);
    expect(r?.file.toString('utf8')).toBe(text);
    expect(r?.content.length).toBeLessThanOrEqual(2000);
    expect(r?.content).toContain('全文 7000 字は添付の reply.md');
  });

  it('冒頭がコードブロックの途中で切れたら閉じる', () => {
    const text = '```\n' + 'x\n'.repeat(4000) + '```';
    const content = toLongReply(text)?.content ?? '';
    const head = content.slice(0, content.indexOf('\n…（全文'));
    const fences = head.split('\n').filter((l) => l.startsWith('```'));

    expect(head.startsWith('```\n')).toBe(true);
    expect(head.endsWith('\n```')).toBe(true);
    expect(fences).toHaveLength(2);
  });
});
