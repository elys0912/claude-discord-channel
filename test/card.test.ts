import { ButtonStyle, ComponentType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { COLORS, LIMITS, clipTo, fence, md, toDiscord } from '../src/card.js';

describe('toDiscord', () => {
  it('題・本文・注記・色を embed にする', () => {
    const { embeds, components, truncated } = toDiscord({ color: 'ok', title: 'T', body: 'B', note: 'N' });
    expect(embeds).toEqual([{ color: COLORS.ok, title: 'T', description: 'B', footer: { text: 'N' } }]);
    expect(components).toEqual([]);
    expect(truncated).toBe(false);
  });

  it('コードは本文の後ろにコードブロックで置く', () => {
    const { embeds } = toDiscord({ body: 'B', code: 'ls -la' });
    expect(embeds[0]?.description).toBe('B\n```\nls -la\n```');
  });

  it('題も本文も無ければ空白だけの本文にする（空の embed は送れない）', () => {
    expect(toDiscord({}).embeds[0]?.description).toBe('​');
  });

  it('description の上限を超えたらコードを削り、フェンスは閉じたまま truncated にする', () => {
    const { embeds, truncated } = toDiscord({ body: 'B', code: 'x'.repeat(5000) });
    const d = embeds[0]?.description ?? '';
    expect(d.length).toBeLessThanOrEqual(LIMITS.description);
    expect(d.endsWith('…\n```')).toBe(true);
    expect(truncated).toBe(true);
  });

  it('本文だけで上限を超えたら本文を切る', () => {
    const { embeds, truncated } = toDiscord({ body: 'y'.repeat(5000), code: 'z' });
    expect(embeds[0]?.description?.length).toBe(LIMITS.description);
    expect(truncated).toBe(true);
  });

  it('ボタンを行ごとに並べ、style を変換し、ラベルを 80 字に切る', () => {
    const { components } = toDiscord({
      buttons: [[{ label: 'A', id: 'perm:allow:abcde', style: 'success' }, { label: 'L'.repeat(100), id: 'x' }]],
    });
    expect(components).toHaveLength(1);
    const [a, b] = components[0]?.components ?? [];
    expect(a).toMatchObject({ type: ComponentType.Button, style: ButtonStyle.Success, label: 'A', custom_id: 'perm:allow:abcde' });
    expect(b).toMatchObject({ style: ButtonStyle.Secondary });
    expect((b as { label: string }).label.length).toBe(LIMITS.buttonLabel);
  });

  it('1 行に 6 個以上のボタン、6 行以上、長すぎる custom_id は投げる', () => {
    const btn = (i: number) => ({ label: String(i), id: `b${i}` });
    expect(() => toDiscord({ buttons: [[0, 1, 2, 3, 4, 5].map(btn)] })).toThrow(/ボタンが多すぎる/);
    expect(() => toDiscord({ buttons: [0, 1, 2, 3, 4, 5].map((i) => [btn(i)]) })).toThrow(/行が多すぎる/);
    expect(() => toDiscord({ buttons: [[{ label: 'x', id: 'i'.repeat(101) }]] })).toThrow(/custom_id/);
  });

  it('選択メニューはボタンの後ろの行に置き、ボタンと合わせて 5 行までにする', () => {
    const select = { id: 'scr:pick:abcd1234', placeholder: '選ぶ', options: [{ label: '1. Yes', value: '0' }] };
    const { components } = toDiscord({ buttons: [[{ label: 'x', id: 'scr:show' }]], select });
    expect(components).toHaveLength(2);
    expect(components[1]?.components[0]).toMatchObject({ type: ComponentType.StringSelect, custom_id: 'scr:pick:abcd1234' });
    const rows = [0, 1, 2, 3, 4].map((i) => [{ label: 'x', id: `b${i}` }]);
    expect(() => toDiscord({ buttons: rows, select })).toThrow(/行が多すぎる/);
  });

  it('選択肢が 0 個や 26 個以上なら投げる', () => {
    const options = (n: number) => Array.from({ length: n }, (_, i) => ({ label: String(i), value: String(i) }));
    expect(() => toDiscord({ select: { id: 's', placeholder: 'p', options: options(0) } })).toThrow();
    expect(() => toDiscord({ select: { id: 's', placeholder: 'p', options: options(26) } })).toThrow();
  });
});

describe('clipTo / fence / md', () => {
  it('サロゲートペアの途中では切らない', () => {
    const r = clipTo('ab😀cd', 4);
    expect(r).toEqual({ text: 'ab…', clipped: true });
  });

  it('中の ``` を無効化する', () => {
    expect(fence('a\n```\nb')).toBe('```\na\n​```\nb\n```');
  });

  it('Markdown の記号をエスケープする', () => {
    expect(md('**x** _y_')).toBe('\\*\\*x\\*\\* \\_y\\_');
  });
});
