import { describe, expect, it } from 'vitest';
import { TodoBoard, buildTodoCard } from '../src/todo.js';
import type { TodoBridge, TodoItem } from '../src/todo.js';
import type { Card } from '../src/card.js';
import { Logger } from '../src/log.js';

describe('buildTodoCard', () => {
  it('状態ごとに印と書式を付け、完了の数を見出しに出す', () => {
    const card = buildTodoCard([
      { content: '調べる', status: 'completed' },
      { content: '直す', status: 'in_progress' },
      { content: 'テストする', status: 'pending' },
    ]);
    expect(card).toEqual({
      color: 'info',
      title: '📋 TODO（1/3 完了）',
      body: '✅ ~~調べる~~\n▶️ **直す**\n⬜ テストする',
    });
  });

  it('全部終わったら緑。Markdown の記号と改行は無害にする', () => {
    expect(buildTodoCard([{ content: 'a', status: 'completed' }]).color).toBe('ok');
    expect(buildTodoCard([{ content: '*強調*\n2行目', status: 'pending' }]).body).toBe('⬜ \\*強調\\* 2行目');
  });

  it('空なら空の旨を出す（完了とはみなさない）', () => {
    expect(buildTodoCard([])).toEqual({ color: 'info', title: '📋 TODO（0/0 完了）', body: '（TODO は空）' });
  });
});

describe('TodoBoard', () => {
  function setup(opts: { failUpdate?: boolean; failPost?: boolean } = {}) {
    const calls: { method: string; channel: string; ts?: string; threadTs?: string | undefined; card: Card }[] = [];
    let seq = 0;
    const bridge: TodoBridge = {
      postCard: async (channel, card, threadTs) => {
        if (opts.failPost) throw new Error('Missing Access');
        seq += 1;
        calls.push({ method: 'post', channel, threadTs, card, ts: String(seq) });
        return { ts: String(seq) };
      },
      updateCard: async (channel, ts, card) => {
        if (opts.failUpdate) throw new Error('Unknown Message');
        calls.push({ method: 'update', channel, ts, card });
      },
    };
    return { board: new TodoBoard(bridge, new Logger({ stderr: false })), calls };
  }
  const at = { channel: 'D1', threadTs: '100' };
  const todos: TodoItem[] = [{ content: 'a', status: 'pending' }];

  it('最初は出し、同じ返信先なら同じカードを書き換える', async () => {
    const { board, calls } = setup();
    expect(await board.update(at, todos)).toBe('posted');
    expect(await board.update(at, [{ content: 'a', status: 'completed' }])).toBe('updated');
    expect(calls.map((c) => [c.method, c.ts])).toEqual([
      ['post', '1'],
      ['update', '1'],
    ]);
    expect(calls[1]?.card.color).toBe('ok');
  });

  it('返信先が変わったか、reset したら新しいカードにする', async () => {
    const { board, calls } = setup();
    await board.update(at, todos);
    await board.update({ channel: 'D1', threadTs: '200' }, todos);
    board.reset();
    await board.update({ channel: 'D1', threadTs: '200' }, todos);
    expect(calls.map((c) => [c.method, c.threadTs])).toEqual([
      ['post', '100'],
      ['post', '200'],
      ['post', '200'],
    ]);
  });

  it('書き換えに失敗したら新しく出す。新しく出すのに失敗したら投げる（ツールの結果で Claude に知らせる）', async () => {
    const { board, calls } = setup({ failUpdate: true });
    await board.update(at, todos);
    await board.update(at, todos);
    expect(calls.map((c) => c.method)).toEqual(['post', 'post']);

    const failing = setup({ failPost: true });
    await expect(failing.board.update(at, todos)).rejects.toThrow('Missing Access');
  });
});
