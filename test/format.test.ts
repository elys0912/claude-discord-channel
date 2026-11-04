import { describe, expect, it } from 'vitest';
import { META_VALUE_MAX, neutralizeBroadcasts, sanitizeMeta } from '../src/format.js';

describe('neutralizeBroadcasts', () => {
  it('@everyone と @here を無効化する', () => {
    expect(neutralizeBroadcasts('hi @here please')).toBe('hi @​here please');
    expect(neutralizeBroadcasts('@everyone')).toBe('@​everyone');
  });

  it('ユーザーとロールへのメンション、ふつうの文は書き換えない', () => {
    expect(neutralizeBroadcasts('hello <@123456789012345678> <@&234567890123456789> world')).toBe(
      'hello <@123456789012345678> <@&234567890123456789> world'
    );
  });

  it('@everyones のように語の途中なら書き換えない', () => {
    expect(neutralizeBroadcasts('@everyones')).toBe('@everyones');
  });

  it('二度かけても変わらない', () => {
    const once = neutralizeBroadcasts('@here');
    expect(neutralizeBroadcasts(once)).toBe(once);
  });
});

describe('sanitizeMeta', () => {
  it('値が undefined の項目は落とす', () => {
    expect(sanitizeMeta({ a: '1', b: undefined })).toEqual({ a: '1' });
  });

  it('英数字と _ 以外を含むキーは落とす', () => {
    expect(sanitizeMeta({ 'a-b': '1', valid_key: '2', 'c.d': '3' })).toEqual({ valid_key: '2' });
  });

  it('英字・数字・_ だけのキーは残す', () => {
    expect(sanitizeMeta({ Chat_ID2: 'x' })).toEqual({ Chat_ID2: 'x' });
  });

  it('空のオブジェクトには空のオブジェクトを返す', () => {
    expect(sanitizeMeta({})).toEqual({});
  });

  it('値は META_VALUE_MAX 文字までに切り詰め、末尾を … にする', () => {
    expect(META_VALUE_MAX).toBe(2000);
    const out = sanitizeMeta({ ok: 'x'.repeat(2000), long: 'y'.repeat(2001) });
    expect(out.ok).toBe('x'.repeat(2000));
    expect(out.long).toBe('y'.repeat(1999) + '…');
  });

  it('切り詰めの境目がサロゲートペアの途中なら、その 1 文字ごと落とす', () => {
    const out = sanitizeMeta({ emoji: 'x'.repeat(1998) + '😀😀' });
    expect(out.emoji).toBe('x'.repeat(1998) + '…');
    expect(out.emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
