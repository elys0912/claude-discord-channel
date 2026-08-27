import { describe, expect, it } from 'vitest';
import type { ParsedAccess } from '../src/config.js';
import { EventDedupe, gate, parsePermissionReply } from '../src/gate.js';
import type { InboundMessage } from '../src/gate.js';

const GUILD = '111111111111111111';
const USER = '222222222222222222';
const CHANNEL = '333333333333333333';
const BOT = '444444444444444444';
const DM = '555555555555555555';
const THREAD = '666666666666666666';
const MESSAGE = '777777777777777777';

const access: ParsedAccess = { guildId: GUILD, allowFrom: [USER], channels: [CHANNEL] };

function dm(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    guildId: null,
    messageId: MESSAGE,
    kind: 'dm',
    channelId: DM,
    parentId: undefined,
    authorId: USER,
    authorIsBot: false,
    isUserMessage: true,
    content: 'hello',
    mentionsBot: false,
    repliesToBot: false,
    createdAt: '2026-10-11T00:00:00.000Z',
    files: undefined,
    ...overrides,
  };
}

function inChannel(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return dm({ guildId: GUILD, kind: 'channel', channelId: CHANNEL, ...overrides });
}

function inThread(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return dm({ guildId: GUILD, kind: 'thread', channelId: THREAD, parentId: CHANNEL, ...overrides });
}

const run = (msg: InboundMessage, opts: { known?: (id: string) => boolean; active?: (id: string) => boolean } = {}) =>
  gate(msg, access, BOT, new EventDedupe(), opts.known, opts.active);

describe('gate', () => {
  it('許可した人の DM は中継し、chat_id は DM、thread_id はそのメッセージにする', () => {
    const r = run(dm());
    expect(r).toEqual({
      kind: 'deliver',
      content: 'hello',
      meta: { chat_id: DM, thread_id: MESSAGE, message_id: MESSAGE, user_id: USER, ts: '2026-10-11T00:00:00.000Z', kind: 'dm' },
      hasText: true,
    });
  });

  it.each([
    ['別のサーバー', inChannel({ guildId: '999999999999999999', mentionsBot: true }), 'guild_mismatch'],
    ['許可していないチャンネル', inChannel({ channelId: '999999999999999999', mentionsBot: true }), 'channel_not_allowed'],
    ['許可していないチャンネルの中のスレッド', inThread({ parentId: '999999999999999999', mentionsBot: true }), 'channel_not_allowed'],
    ['サーバーの、DM でもチャンネルでもない場所', dm({ guildId: GUILD, kind: 'other' }), 'channel_not_allowed'],
    ['ボット・Webhook', dm({ authorIsBot: true }), 'bot_or_self'],
    ['自分自身', dm({ authorId: BOT }), 'bot_or_self'],
    ['ピン留めなどの知らせ', dm({ isUserMessage: false }), 'unsupported_type'],
    ['許可していない人', dm({ authorId: '888888888888888888' }), 'user_not_allowed'],
    ['チャンネルでメンションも返信も無い', inChannel(), 'not_addressed'],
    ['関わっていないスレッドでメンションが無い', inThread(), 'not_addressed'],
  ])('%sは捨てる', (_label, msg, reason) => {
    expect(run(msg)).toEqual({ kind: 'drop', reason });
  });

  it('チャンネルではメンションを取り除き、chat_id はチャンネル、thread_id はそのメッセージ（ここからスレッドを作る）', () => {
    const r = run(inChannel({ content: `<@${BOT}> 調べて`, mentionsBot: true }));
    expect(r.kind).toBe('deliver');
    if (r.kind !== 'deliver') return;
    expect(r.content).toBe('調べて');
    expect(r.meta).toMatchObject({ chat_id: CHANNEL, thread_id: MESSAGE, kind: 'channel' });
  });

  it('古い形のメンション <@!id> も取り除く', () => {
    const r = run(inChannel({ content: `<@!${BOT}> hi`, mentionsBot: true }));
    expect(r.kind === 'deliver' && r.content).toBe('hi');
  });

  it('ボットのメッセージへの返信はメンションが無くても中継する', () => {
    expect(run(inChannel({ repliesToBot: true })).kind).toBe('deliver');
  });

  it('関わったスレッドではメンションが無くても中継し、chat_id は親チャンネル、thread_id はスレッドにする', () => {
    const r = run(inThread(), { active: (id) => id === THREAD });
    expect(r.kind).toBe('deliver');
    if (r.kind !== 'deliver') return;
    expect(r.meta).toMatchObject({ chat_id: CHANNEL, thread_id: THREAD, message_id: MESSAGE, kind: 'thread' });
  });

  it('メンションだけで本文も添付も無ければ「(本文なし)」', () => {
    const r = run(inChannel({ content: `<@${BOT}>`, mentionsBot: true }));
    expect(r.kind === 'deliver' && r.content).toBe('(本文なし)');
  });

  it('添付があれば要約と ID を meta に付ける（名前の危険な文字は _ にする）', () => {
    const r = run(dm({ content: '', files: [{ id: '123', name: 'a"b.png', mimetype: 'image/png', size: 10 }] }));
    expect(r.kind).toBe('deliver');
    if (r.kind !== 'deliver') return;
    expect(r.content).toBe('(attachment)');
    expect(r.meta).toMatchObject({ attachment_count: '1', attachments: 'a_b.png(image/png, 10)', attachment_ids: '123' });
  });

  it('同じメッセージが二度届いたら二度目は捨てる', () => {
    const dedupe = new EventDedupe();
    expect(gate(dm(), access, BOT, dedupe).kind).toBe('deliver');
    expect(gate(dm(), access, BOT, dedupe)).toEqual({ kind: 'drop', reason: 'duplicate_event' });
  });

  it('保留中の ID への yes / no は回答にし、知らない ID ならふつうのメッセージにする', () => {
    expect(run(dm({ content: 'yes abcde' }), { known: (id) => id === 'abcde' })).toEqual({
      kind: 'verdict',
      verdict: { requestId: 'abcde', behavior: 'allow' },
    });
    expect(run(dm({ content: 'yes abcde' }), { known: () => false }).kind).toBe('deliver');
  });
});

describe('parsePermissionReply', () => {
  it('大文字や y / n も受け付け、ID は小文字にする', () => {
    expect(parsePermissionReply('Y ABCDE')).toEqual({ requestId: 'abcde', behavior: 'allow' });
    expect(parsePermissionReply(' no  fghij ')).toEqual({ requestId: 'fghij', behavior: 'deny' });
  });

  it('l を含む ID や、前後に別の文があるものは受け付けない', () => {
    expect(parsePermissionReply('yes abcdl')).toBeNull();
    expect(parsePermissionReply('yes abcde please')).toBeNull();
  });
});
