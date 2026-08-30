import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionRelay } from '../src/permission-relay.js';
import type { RelayBridge, RelayClaude } from '../src/permission-relay.js';
import { PendingPermissions } from '../src/permission.js';
import type { PermissionRequest } from '../src/permission.js';
import type { Card } from '../src/card.js';
import { SessionAllowAll } from '../src/session-allow.js';
import { Logger } from '../src/log.js';
import type { Verdict } from '../src/types.js';

const REQ: PermissionRequest = {
  request_id: 'abcde',
  tool_name: 'Write',
  description: 'Write hello.txt',
  input_preview: '{"file_path":"hello.txt"}',
};

/** カードの見出しと本文をつないだもの（文言の確認用） */
function cardText(card: Card): string {
  return [card.title, card.body].filter(Boolean).join(' ');
}

/** スレッド返信（postCard）を使わないテスト用の実装 */
const noReply = async (): Promise<{ ts: string }> => ({ ts: '' });

function setup(now: () => number = () => 0, opts: { reply?: 'ok' | 'throw' | 'empty'; sessionAllow?: SessionAllowAll } = {}) {
  const posts: { card: Card | string; threadFor: (ch: string) => string | undefined }[] = [];
  const replies: { channel: string; threadTs: string | undefined; card: Card }[] = [];
  const updates: { channel: string; ts: string; text: string }[] = [];
  const verdicts: Verdict[] = [];

  const bridge: RelayBridge = {
    postToAll: async (card, threadFor) => {
      posts.push({ card, threadFor: threadFor ?? (() => undefined) });
      return [
        { channel: 'D1', ts: '10' },
        { channel: 'D2', ts: '' }, // 送信に失敗したチャンネル
      ];
    },
    postCard: async (channel, card, threadTs) => {
      if (opts.reply === 'throw') throw new Error('Missing Access');
      replies.push({ channel, threadTs, card });
      return { ts: opts.reply === 'empty' ? '' : '20' };
    },
    updateCard: async (channel, ts, card) => {
      updates.push({ channel, ts, text: cardText(card) });
    },
  };
  const claude: RelayClaude = {
    sendVerdict: async (v) => {
      verdicts.push(v);
    },
  };

  const pending = new PendingPermissions(1000, now);
  const relay = new PermissionRelay(bridge, claude, new Logger({ stderr: false }), pending, opts.sessionAllow);
  return { relay, posts, replies, updates, verdicts };
}

describe('PermissionRelay', () => {
  it('request は最後に話しかけられたスレッドにだけ返信する（DM には配らない）', async () => {
    const { relay, posts, replies } = setup();
    relay.rememberThread('D1', '99');
    relay.rememberThread('C1', '77');
    await relay.request(REQ);

    expect(replies.map(({ channel, threadTs }) => ({ channel, threadTs }))).toEqual([{ channel: 'C1', threadTs: '77' }]);
    expect(posts).toHaveLength(0);
    expect(relay.lookup('abcde')).toEqual(REQ);
    expect(relay.unansweredCount()).toBe(1);
    expect(relay.lastThread).toEqual({ channel: 'C1', threadTs: '77' });
  });

  it.each([
    ['git status', true],
    ['cat README.md', false],
    ['npm.cmd test', false],
  ])('「今後も許可」は、許可リストからルールを作れるときだけ出す（%s → %s）', async (command, shown) => {
    const { relay, replies } = setup();
    relay.rememberThread('C1', '77');
    await relay.request({ ...REQ, tool_name: 'Bash', input_preview: JSON.stringify({ command }) });
    const labels = (replies[0]?.card.buttons ?? []).flat().map((b) => b.label);
    expect(labels.some((l) => l.includes('今後も許可'))).toBe(shown);
  });

  it('スレッドに返信した request は、回答後にその 1 通だけを書き換える', async () => {
    const { relay, updates } = setup();
    relay.rememberThread('C1', '77');
    await relay.request(REQ);
    await relay.answerByButton({ requestId: 'abcde', behavior: 'allow' }, 'U1', { channel: 'C1', ts: '20' });

    expect(updates).toEqual([expect.objectContaining({ channel: 'C1', ts: '20' })]);
    expect(relay.unansweredCount()).toBe(0);
  });

  it('まだ話しかけられていなければ、DM 全体に配信する', async () => {
    const { relay, posts, replies } = setup();
    await relay.request(REQ);

    expect(replies).toHaveLength(0);
    expect(posts).toHaveLength(1);
  });

  it.each([
    ['投げた', 'throw' as const],
    ['ID が返らなかった', 'empty' as const],
  ])('スレッドへの返信が%sら、覚えておいた DM のスレッドを使って DM 全体に配信する', async (_label, reply) => {
    const { relay, posts, verdicts } = setup(() => 0, { reply });
    relay.rememberThread('D1', '99');
    relay.rememberThread('C1', '77');
    await relay.request(REQ);

    expect(posts).toHaveLength(1);
    expect(posts[0]?.threadFor('D1')).toBe('99');
    expect(posts[0]?.threadFor('D2')).toBeUndefined();
    // DM に届いたので自動 deny はしない
    expect(verdicts).toEqual([]);
  });

  it('ボタンで回答すると Claude に送り、投稿済みのメッセージだけを書き換える', async () => {
    const { relay, updates, verdicts } = setup();
    await relay.request(REQ);
    await relay.answerByButton({ requestId: 'abcde', behavior: 'allow' }, 'U1', { channel: 'D1', ts: '10' });

    expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'allow' }]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ channel: 'D1', ts: '10' });
    expect(updates[0]?.text).toContain('✅ 許可した');
    expect(relay.lookup('abcde')).toBeUndefined();
  });

  it('保留中と同じ ID の request が再び届いても、出し直さず最初のボタンで答えられる', async () => {
    const { relay, posts, verdicts, updates } = setup();
    await relay.request(REQ);
    await relay.request({ ...REQ, description: 'resent' });
    expect(posts).toHaveLength(1);
    expect(relay.lookup('abcde')).toEqual(REQ);

    await relay.answerByButton({ requestId: 'abcde', behavior: 'deny' }, 'U1', { channel: 'D1', ts: '10' });
    expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'deny' }]);
    expect(updates).toEqual([expect.objectContaining({ channel: 'D1', ts: '10' })]);
  });

  it.each([
    ['ボタン', (relay: PermissionRelay) => relay.answerByButton({ requestId: 'abcde', behavior: 'allow' }, 'U1', { channel: 'D1', ts: '10' })],
    ['テキスト', (relay: PermissionRelay) => relay.answerByText({ requestId: 'abcde', behavior: 'allow' }, 'U1')],
  ])('%sの回答を Claude に送れなかったら、投げずにメッセージを「送れなかった」表示にし、期限のタイマーも止める', async (_label, answer) => {
    vi.useFakeTimers();
    const updates: string[] = [];
    const sent: Verdict[] = [];
    const relay = new PermissionRelay(
      {
        postToAll: async () => [{ channel: 'D1', ts: '10' }],
        postCard: noReply,
        updateCard: async (_channel, _ts, card) => void updates.push(cardText(card)),
      },
      {
        sendVerdict: async (v) => {
          sent.push(v);
          throw new Error('not connected');
        },
      },
      new Logger({ stderr: false }),
      new PendingPermissions(1000, () => 0)
    );
    await relay.request(REQ);
    updates.length = 0;
    await expect(answer(relay)).resolves.not.toThrow();

    expect(updates).toEqual([expect.stringContaining('Allow を Claude に送れなかった')]);
    expect(relay.lookup('abcde')).toBeUndefined();
    // 期限が来ても deny を重ねて送らない（Claude には既に届いていない）
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual([{ requestId: 'abcde', behavior: 'allow' }]);
    vi.useRealTimers();
  });

  it('期限切れのボタンは Claude に送らず、押されたメッセージを期限切れ表示にする', async () => {
    let t = 0;
    const { relay, updates, verdicts } = setup(() => t);
    await relay.request(REQ);
    t = 5000;
    await relay.answerByButton({ requestId: 'abcde', behavior: 'allow' }, 'U1', { channel: 'D1', ts: '10' });

    expect(verdicts).toEqual([]);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.text).toContain('期限切れ');
  });

  it('テキストの回答は、手元に記録が無い ID なら Claude に送らず false を返す', async () => {
    const { relay, updates, verdicts } = setup();
    expect(await relay.answerByText({ requestId: 'zzzzz', behavior: 'deny' }, 'U1')).toBe(false);

    expect(verdicts).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('テキストの回答でも、期限切れの ID は Claude に送らない', async () => {
    let t = 0;
    const { relay, verdicts } = setup(() => t);
    await relay.request(REQ);
    t = 5000;
    expect(await relay.answerByText({ requestId: 'abcde', behavior: 'allow' }, 'U1')).toBe(false);
    expect(verdicts).toEqual([]);
  });

  it('テキストの回答でも、記録がある ID ならメッセージを書き換える', async () => {
    const { relay, updates } = setup();
    await relay.request(REQ);
    expect(await relay.answerByText({ requestId: 'abcde', behavior: 'deny' }, 'U1')).toBe(true);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.text).toContain('❌ 拒否した');
  });

  describe('このセッション中は全部許可', () => {
    it('有効でなければ、カードに 🔓 のボタンを出す', async () => {
      const { relay, replies } = setup(() => 0, { sessionAllow: new SessionAllowAll(() => []) });
      relay.rememberThread('C1', '77');
      await relay.request(REQ);
      const labels = (replies[0]?.card.buttons ?? []).flat().map((b) => b.label);
      expect(labels).toContain('🔓 このセッション中は全部許可');
    });

    it('有効なら、ボタンを出さずに allow を返し、スレッドに自動許可を記録する', async () => {
      const sessionAllow = new SessionAllowAll(() => []);
      sessionAllow.enable('U1');
      const { relay, replies, posts, verdicts } = setup(() => 0, { sessionAllow });
      relay.rememberThread('C1', '77');
      await relay.request(REQ);

      expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'allow' }]);
      expect(posts).toHaveLength(0);
      expect(replies).toHaveLength(1);
      expect(replies[0]?.card.title).toBe('🔓 自動許可: Write');
      expect(replies[0]?.card.buttons).toBeUndefined();
      expect(relay.unansweredCount()).toBe(0);
    });

    it('自動許可の記録も不可視文字を見えるようにし、サロゲートペアの途中で切らない', async () => {
      const sessionAllow = new SessionAllowAll(() => []);
      sessionAllow.enable('U1');
      const { relay, replies } = setup(() => 0, { sessionAllow });
      relay.rememberThread('C1', '77');
      await relay.request({ ...REQ, request_id: 'fghij', input_preview: 'rm \u202E/' + 'a'.repeat(294) + '😀b' });
      const code = replies[0]?.card.code ?? '';
      expect(code.startsWith('rm \\u{202E}/')).toBe(true);
      expect(code.endsWith('a…')).toBe(true);
    });

    it('ask に当たる操作は、有効でもボタンで聞く', async () => {
      const sessionAllow = new SessionAllowAll(() => ['Write']);
      sessionAllow.enable('U1');
      const { relay, replies, verdicts } = setup(() => 0, { sessionAllow });
      relay.rememberThread('C1', '77');
      await relay.request(REQ);

      expect(verdicts).toEqual([]);
      expect(replies[0]?.card.title).toContain('実行許可');
      // 有効な間は 🔓 のボタンは出さない
      const labels = (replies[0]?.card.buttons ?? []).flat().map((b) => b.label);
      expect(labels).not.toContain('🔓 このセッション中は全部許可');
    });
  });

  describe('denyAll', () => {
    it('保留中の全件に deny を送り、メッセージを書き換え、回答済みのものには送らない', async () => {
      const { relay, updates, verdicts } = setup();
      await relay.request(REQ);
      await relay.request({ ...REQ, request_id: 'fghij' });
      await relay.request({ ...REQ, request_id: 'kmnop' });
      await relay.answerByText({ requestId: 'kmnop', behavior: 'allow' }, 'U1');
      updates.length = 0;
      verdicts.length = 0;

      await relay.denyAll('ブリッジ終了');
      expect(verdicts).toEqual([
        { requestId: 'abcde', behavior: 'deny' },
        { requestId: 'fghij', behavior: 'deny' },
      ]);
      expect(updates.map((u) => u.text)).toEqual([
        expect.stringContaining('ブリッジ終了のため自動で拒否した'),
        expect.stringContaining('ブリッジ終了のため自動で拒否した'),
      ]);
      expect(relay.lookup('abcde')).toBeUndefined();

      // 2 回目は何も送らない
      await relay.denyAll('ブリッジ終了');
      expect(verdicts).toHaveLength(2);
    });

    it('deny の送信や書き換えに失敗しても、残りを続けて投げない', async () => {
      const verdicts: string[] = [];
      const relay = new PermissionRelay(
        {
          postToAll: async () => [{ channel: 'D1', ts: '10' }],
          postCard: noReply,
          updateCard: async () => {
            throw new Error('discord down');
          },
        },
        {
          sendVerdict: async (v) => {
            verdicts.push(v.requestId);
            if (v.requestId === 'abcde') throw new Error('not connected');
          },
        },
        new Logger({ stderr: false }),
        new PendingPermissions(1000, () => 0)
      );
      await relay.request(REQ);
      await relay.request({ ...REQ, request_id: 'fghij' });
      await expect(relay.denyAll('ブリッジ終了')).resolves.toBeUndefined();
      expect(verdicts).toEqual(['abcde', 'fghij']);
    });
  });

  describe('配信先が 0 件', () => {
    function relayWith(results: { channel: string; ts: string }[]) {
      const verdicts: Verdict[] = [];
      const logger = new Logger({ stderr: false });
      const errorSpy = vi.spyOn(logger, 'error');
      const relay = new PermissionRelay(
        { postToAll: async () => results, postCard: noReply, updateCard: async () => undefined },
        { sendVerdict: async (v) => void verdicts.push(v) },
        logger,
        new PendingPermissions(1000, () => 0)
      );
      return { relay, verdicts, errorSpy };
    }

    it.each([
      ['全チャンネルで失敗', [{ channel: 'D1', ts: '' }, { channel: 'D2', ts: '' }]],
      ['DM チャンネルが無い', []],
    ])('%s なら、その場で deny を送って保留から消し、error を残す', async (_label, results) => {
      vi.useFakeTimers();
      const { relay, verdicts, errorSpy } = relayWith(results);
      await expect(relay.request(REQ)).resolves.toBeUndefined();

      expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'deny' }]);
      expect(relay.lookup('abcde')).toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
      // 期限が来ても重ねて送らない
      await vi.advanceTimersByTimeAsync(5000);
      expect(verdicts).toHaveLength(1);
      vi.useRealTimers();
    });

    it('postToAll が投げても、deny を送って投げない', async () => {
      const verdicts: Verdict[] = [];
      const relay = new PermissionRelay(
        {
          postToAll: async () => {
            throw new Error('boom');
          },
          postCard: noReply,
          updateCard: async () => undefined,
        },
        { sendVerdict: async (v) => void verdicts.push(v) },
        new Logger({ stderr: false }),
        new PendingPermissions(1000, () => 0)
      );
      await expect(relay.request(REQ)).resolves.toBeUndefined();
      expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'deny' }]);
    });
  });

  describe('期限切れの自動 deny', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('TTL を過ぎたら Claude に deny を送り、投稿済みのメッセージを自動拒否の表示にして保留から消す', async () => {
      vi.useFakeTimers();
      const { relay, updates, verdicts } = setup();
      await relay.request(REQ);
      await vi.advanceTimersByTimeAsync(999);
      expect(verdicts).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'deny' }]);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ channel: 'D1', ts: '10' });
      expect(updates[0]?.text).toContain('期限切れのため自動で拒否した');
      expect(relay.lookup('abcde')).toBeUndefined();

      // 自動 deny の後のボタンは Claude に送らない
      await relay.answerByButton({ requestId: 'abcde', behavior: 'allow' }, 'U1', { channel: 'D1', ts: '10' });
      expect(verdicts).toHaveLength(1);
    });

    it('期限前に回答済みなら、期限が来ても deny を重ねて送らない', async () => {
      vi.useFakeTimers();
      const { relay, updates, verdicts } = setup();
      await relay.request(REQ);
      expect(await relay.answerByText({ requestId: 'abcde', behavior: 'allow' }, 'U1')).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);

      expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'allow' }]);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.text).toContain('✅ 許可した');
    });

    it('期限切れ後・タイマー前に押されたボタンは送らず、その後のタイマーで deny を 1 回だけ送る', async () => {
      vi.useFakeTimers();
      let t = 0;
      const { relay, verdicts } = setup(() => t);
      await relay.request(REQ);
      t = 5000;
      await relay.answerByButton({ requestId: 'abcde', behavior: 'allow' }, 'U1', { channel: 'D1', ts: '10' });
      expect(verdicts).toEqual([]);

      await vi.advanceTimersByTimeAsync(1000);
      expect(verdicts).toEqual([{ requestId: 'abcde', behavior: 'deny' }]);
    });

    it('deny の送信に失敗しても投げず、メッセージの書き換えは行う', async () => {
      vi.useFakeTimers();
      const updates: string[] = [];
      const relay = new PermissionRelay(
        {
          postToAll: async () => [{ channel: 'D1', ts: '10' }],
          postCard: noReply,
          updateCard: async (_channel, _ts, card) => void updates.push(cardText(card)),
        },
        {
          sendVerdict: async () => {
            throw new Error('not connected');
          },
        },
        new Logger({ stderr: false }),
        new PendingPermissions(1000, () => 0)
      );
      await relay.request(REQ);
      await vi.advanceTimersByTimeAsync(1000);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toContain('自動で拒否した');
    });
  });
});
