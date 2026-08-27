import { describe, expect, it } from 'vitest';
import { Logger } from '../src/log.js';
import { ScreenRelay, noticeCard } from '../src/screen-relay.js';
import type { Card } from '../src/card.js';
import type { ConsoleAccess, ConsoleKey } from '../src/console.js';

const CHROME = [
  ' Claude wants to use your browser',
  '    Install extension  Opens the install page in Chrome',
  '  > Not now            Continue without browser tools',
  "    Don't ask again    Revisit anytime with /chrome",
].join('\n');

/** トークンの形をしたテスト用の文字列（本物ではない） */
const FAKE_TOKEN = `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(27)}`;

function plain(card: Card): string {
  return [card.title, card.body, card.code].filter(Boolean).join('\n').replace(/\\(.)/g, '$1');
}

function setup(screens: string[]) {
  const sent: ConsoleKey[][] = [];
  const posts: { kind: 'text' | 'card' | 'update'; channel: string; text: string; card?: Card; threadTs?: string | undefined }[] = [];
  let t = 0;
  const reads = [...screens];
  const console: ConsoleAccess = {
    read: async () => reads.shift() ?? screens[screens.length - 1] ?? '',
    sendKeys: async (keys) => void sent.push(keys),
    sendCommand: async () => undefined,
  };
  const relay = new ScreenRelay({
    console,
    logger: new Logger({ stderr: false }),
    now: () => t,
    newId: () => 'snap0001',
    bridge: {
      postText: async (channel, text, threadTs) => {
        posts.push({ kind: 'text', channel, text, threadTs });
        return { ts: ['10'] };
      },
      postCard: async (channel, card, threadTs) => {
        posts.push({ kind: 'card', channel, text: plain(card), card, threadTs });
        return { ts: '20' };
      },
      updateCard: async (channel, _ts, card) => {
        posts.push({ kind: 'update', channel, text: plain(card), card });
      },
    },
  });
  return { relay, sent, posts, advance: (ms: number) => (t += ms) };
}

describe('noticeCard', () => {
  it('withScreenButton なら「画面を確認」ボタンを添える', () => {
    expect(noticeCard('x', true).buttons).toEqual([[{ label: '🖥 画面を確認', id: 'scr:show' }]]);
    expect(noticeCard('x', false).buttons).toBeUndefined();
    expect(noticeCard('x', false).color).toBe('warn');
  });
});

describe('ScreenRelay', () => {
  it('選択画面なら選択肢を選択メニュー（value は番号）で出す', async () => {
    const { relay, posts } = setup([CHROME]);
    await relay.show('C1', '90');

    expect(posts[0]?.kind).toBe('card');
    expect(posts[0]?.threadTs).toBe('90');
    expect(posts[0]?.text).toContain('Claude wants to use your browser');
    const select = posts[0]?.card?.select;
    expect(select?.id).toBe('scr:pick:snap0001');
    expect(select?.options.map((o) => [o.label, o.value])).toEqual([
      ['Install extension', '0'],
      ['Not now', '1'],
      ["Don't ask again", '2'],
    ]);
  });

  it('選択画面でなければ画面の末尾をカードで送り、トークンは伏せる', async () => {
    const { relay, posts } = setup([`working...\nDISCORD_BOT_TOKEN=${FAKE_TOKEN}\n`]);
    await relay.show('C1', '90');
    expect(posts[0]?.kind).toBe('card');
    expect(posts[0]?.card?.title).toContain('ターミナルの画面');
    expect(posts[0]?.text).toContain('working...');
    expect(posts[0]?.text).not.toContain(FAKE_TOKEN);
  });

  it('同じ画面のままなら、カーソルから選んだ選択肢までのキーを送る', async () => {
    const { relay, sent, posts } = setup([CHROME, CHROME]);
    await relay.show('C1', '90');
    await relay.pick('snap0001', 2, { channel: 'C1', ts: '20', threadTs: '90' }, 'U1');

    expect(sent).toEqual([['Down', 'Enter']]);
    expect(posts.at(-1)).toMatchObject({ kind: 'update' });
    expect(posts.at(-1)?.text).toContain("Don't ask again");
  });

  it('画面が変わっていたら何も送らない', async () => {
    const { relay, sent, posts } = setup([CHROME, 'done\n> \n']);
    await relay.show('C1', '90');
    await relay.pick('snap0001', 1, { channel: 'C1', ts: '20', threadTs: '90' }, 'U1');

    expect(sent).toEqual([]);
    expect(posts.at(-1)?.text).toContain('画面が変わっていた');
  });

  it('期限切れ・2 回目の選択では何も送らない', async () => {
    const { relay, sent, posts, advance } = setup([CHROME, CHROME, CHROME]);
    await relay.show('C1', '90');
    advance(5 * 60 * 1000 + 1);
    await relay.pick('snap0001', 1, { channel: 'C1', ts: '20', threadTs: '90' }, 'U1');
    expect(posts.at(-1)?.text).toContain('期限切れ');

    await relay.pick('snap0001', 1, { channel: 'C1', ts: '20', threadTs: '90' }, 'U1');
    expect(sent).toEqual([]);
  });

  it('範囲外の番号は送らない', async () => {
    const { relay, sent, posts } = setup([CHROME, CHROME]);
    await relay.show('C1', '90');
    await relay.pick('snap0001', 9, { channel: 'C1', ts: '20', threadTs: '90' }, 'U1');
    expect(sent).toEqual([]);
    expect(posts.at(-1)?.text).toContain('選べない選択肢');
  });

  it('画面を読めない環境ならその旨を返す', async () => {
    const posts: string[] = [];
    const relay = new ScreenRelay({
      console: undefined,
      logger: new Logger({ stderr: false }),
      bridge: {
        postText: async (_c, text) => {
          posts.push(text);
          return { ts: [] };
        },
        postCard: async () => ({ ts: '' }),
        updateCard: async () => undefined,
      },
    });
    await relay.show('C1', '90');
    expect(posts[0]).toContain('画面を読めない');
  });
});
