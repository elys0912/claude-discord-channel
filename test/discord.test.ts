import { describe, expect, it } from 'vitest';
import { ChannelType, Collection, Events, MessageType } from 'discord.js';
import type { Message } from 'discord.js';
import { DiscordBridge, TEXT_CHUNK_MAX, embedText, normalizeBotRoleMentions, threadName, toInbound } from '../src/discord.js';
import { Logger } from '../src/log.js';

// 実在しない、形だけを合わせた ID（Discord の snowflake と同じ 19 桁）
const BOT = '1400000000000000001';
const ROLE = '1400000000000000002';

describe('normalizeBotRoleMentions', () => {
  it('ボットのロールへのメンションを、ボット本人へのメンションに置き換える（何か所あっても）', () => {
    expect(normalizeBotRoleMentions(`<@&${ROLE}> !status <@&${ROLE}>`, [ROLE], BOT)).toBe(`<@${BOT}> !status <@${BOT}>`);
  });

  it('ほかのロールやユーザーへのメンションは変えない', () => {
    const text = `<@&999999999999999999> <@123456789012345678> hi`;
    expect(normalizeBotRoleMentions(text, [ROLE], BOT)).toBe(text);
  });

  it('ボットのロールが無ければそのまま', () => {
    expect(normalizeBotRoleMentions(`<@&${ROLE}> hi`, [], BOT)).toBe(`<@&${ROLE}> hi`);
  });
});

describe('toInbound', () => {
  const CHANNEL = '500000000000000040';
  const PARENT = '500000000000000041';
  const AUTHOR = '200000000000000001';

  /** toInbound が読むところだけを持つ Message */
  function message(over: { content?: string; type?: MessageType; webhookId?: string | null; channelType?: ChannelType; roles?: [string, string][] } = {}): Message {
    const roles = new Collection((over.roles ?? []).map(([id, botId]) => [id, { id, tags: { botId } }]));
    return {
      id: '800000000000000001',
      guildId: '100000000000000001',
      channelId: CHANNEL,
      channel: { type: over.channelType ?? ChannelType.GuildText, parentId: PARENT },
      author: { id: AUTHOR, bot: false },
      webhookId: over.webhookId ?? null,
      type: over.type ?? MessageType.Default,
      content: over.content ?? 'hi',
      embeds: [],
      mentions: { roles, has: () => false, repliedUser: null },
      createdAt: new Date('2026-10-12T00:00:00.000Z'),
      attachments: new Collection(),
    } as unknown as Message;
  }

  it('webhook の発言はボットの発言として扱う', () => {
    const inbound = toInbound(message({ webhookId: '900000000000000001' }), BOT);
    expect(inbound).toMatchObject({ authorIsBot: true, webhookId: '900000000000000001' });
  });

  it.each([
    [MessageType.Default, true],
    [MessageType.Reply, true],
    [MessageType.ChannelPinnedMessage, false],
    [MessageType.ThreadCreated, false],
  ])('メッセージの種類 %s は、普通の発言か %s', (type, expected) => {
    expect(toInbound(message({ type }), BOT).isUserMessage).toBe(expected);
  });

  it('ボットのロールへのメンションは、ボットへのメンションとして扱う（ほかのボットのロールは扱わない）', () => {
    const OTHER_ROLE = '1400000000000000003';
    const roles: [string, string][] = [[ROLE, BOT], [OTHER_ROLE, '1400000000000000009']];
    const inbound = toInbound(message({ content: `<@&${ROLE}> <@&${OTHER_ROLE}> hi`, roles }), BOT);
    expect(inbound).toMatchObject({ mentionsBot: true, content: `<@${BOT}> <@&${OTHER_ROLE}> hi` });
  });

  it('スレッドの発言だけ親のチャンネルを持つ', () => {
    expect(toInbound(message({ channelType: ChannelType.PublicThread }), BOT)).toMatchObject({ kind: 'thread', parentId: PARENT });
    expect(toInbound(message(), BOT)).toMatchObject({ kind: 'channel', parentId: undefined });
  });
});

describe('threadName', () => {
  it('40 字目が絵文字の前半でも、サロゲートペアの途中で切らない', () => {
    const name = threadName('a'.repeat(39) + '😀' + 'b');
    expect(name).toBe('a'.repeat(39));
  });

  it('メンションを除いて 1 行にし、空なら Claude', () => {
    expect(threadName(`<@${BOT}>  調べて\nほしい`)).toBe('調べて ほしい');
    expect(threadName(`<@${BOT}>`)).toBe('Claude');
  });
});

describe('DiscordBridge の回復できない切断', () => {
  function setup() {
    const lost: string[] = [];
    const bridge = new DiscordBridge({
      token: 'unused',
      access: { guildId: '100000000000000001', allowFrom: ['200000000000000001'] },
      logger: new Logger({ stderr: false }),
    });
    const internals = bridge as unknown as { bindListeners: () => void; connected: boolean; client: { emit: (event: string, ...args: unknown[]) => boolean } };
    internals.bindListeners();
    internals.connected = true;
    void bridge.start({ onMessage: () => undefined, onAction: () => undefined, onGatewayLost: (detail) => void lost.push(detail) });
    return { bridge, lost, client: internals.client };
  }

  it('再接続しない切断（ShardDisconnect）は、つながっていない状態にして close code を知らせる', () => {
    const { bridge, lost, client } = setup();
    client.emit(Events.ShardDisconnect, { code: 4004 }, 0);
    expect(bridge.isConnected).toBe(false);
    expect(lost).toEqual(['close code 4004']);
  });

  it('再接続を試みる切断（ShardReconnecting）は知らせない', () => {
    const { lost, client } = setup();
    client.emit(Events.ShardReconnecting, 0);
    expect(lost).toEqual([]);
  });
});

describe('DiscordBridge.fetchFile', () => {
  function bridgeWith(fetched: string[]): DiscordBridge {
    return new DiscordBridge({
      token: 'unused',
      access: { guildId: '100000000000000001', allowFrom: ['200000000000000001'] },
      logger: new Logger({ stderr: false }),
      fetch: async (input) => {
        fetched.push(input instanceof URL ? input.href : JSON.stringify(input));
        return new Response('ok');
      },
    });
  }

  it('Discord の CDN（https）からだけ取る', async () => {
    const fetched: string[] = [];
    const bridge = bridgeWith(fetched);
    for (const url of ['https://cdn.discordapp.com/attachments/1/2/a.txt', 'https://media.discordapp.net/attachments/1/2/a.png']) {
      await expect(bridge.fetchFile({ id: '2', name: 'a', url })).resolves.toBeInstanceOf(Response);
    }
    expect(fetched).toHaveLength(2);
  });

  it.each(['https://evil.example/a.txt', 'http://cdn.discordapp.com/a.txt', 'https://cdn.discordapp.com.evil.example/a.txt'])(
    'CDN 以外（%s）には取りに行かない',
    async (url) => {
      const fetched: string[] = [];
      await expect(bridgeWith(fetched).fetchFile({ id: '2', name: 'a', url })).rejects.toThrow(/CDN 以外/);
      expect(fetched).toEqual([]);
    }
  );
});

describe('DiscordBridge の送り先（フォーラムとスレッド）', () => {
  const FORUM = '500000000000000009';
  const POST = '600000000000000001';
  const OTHER_POST = '600000000000000002';

  /** client.channels.fetch を差し替えた DiscordBridge。送った先を sent に残す */
  function setup() {
    const sent: { channel: string; content: unknown }[] = [];
    const thread = (id: string, parentId: string) => ({
      id,
      parentId,
      type: ChannelType.PublicThread,
      isThread: () => true,
      isSendable: () => true,
      send: async (options: { content?: unknown }) => {
        sent.push({ channel: id, content: options.content });
        return { id: `${id}-msg`, channelId: id };
      },
    });
    const channels: Record<string, unknown> = {
      [FORUM]: { id: FORUM, type: ChannelType.GuildForum, isThread: () => false, isSendable: () => false },
      [POST]: thread(POST, FORUM),
      [OTHER_POST]: thread(OTHER_POST, '599999999999999999'),
    };
    const bridge = new DiscordBridge({
      token: 'unused',
      access: { guildId: '100000000000000001', allowFrom: ['200000000000000001'], channels: [FORUM] },
      logger: new Logger({ stderr: false }),
    });
    const client = (bridge as unknown as { client: { channels: { fetch: (id: string) => Promise<unknown> } } }).client;
    client.channels.fetch = async (id: string) => channels[id] ?? null;
    return { bridge, sent };
  }

  it('フォーラムの投稿（スレッド）には、親のフォーラムに送れなくても届く', async () => {
    const { bridge, sent } = setup();
    await bridge.postText(FORUM, 'こんにちは', POST);
    expect(sent).toEqual([{ channel: POST, content: 'こんにちは' }]);
    expect(bridge.isActiveThread(POST)).toBe(true);
  });

  it('許可した会話の外のスレッドには送らない', async () => {
    const { bridge, sent } = setup();
    await expect(bridge.postText(FORUM, 'x', OTHER_POST)).rejects.toThrow(/送信できないチャンネル/);
    expect(sent).toEqual([]);
  });
});

describe('DiscordBridge の送信（長文の分割と途中の失敗）', () => {
  const CHANNEL = '500000000000000030';

  const USER = '200000000000000001';

  type SendOptions = { content?: string | undefined; files?: unknown[] | undefined; reply?: unknown };

  /**
   * 送ったメッセージを sent に残すチャンネル 1 つの DiscordBridge。failFrom 通目以降の送信は失敗する。
   * dm なら、init() で許可ユーザーの DM を開いたときと同じ状態にする
   */
  function setup(opts: { failFrom?: number; dm?: boolean; longReplyChars?: number } = {}) {
    const failFrom = opts.failFrom ?? Infinity;
    const sent: SendOptions[] = [];
    const channel = {
      id: CHANNEL,
      type: opts.dm ? ChannelType.DM : ChannelType.GuildText,
      isThread: () => false,
      isSendable: () => true,
      send: async (options: SendOptions) => {
        if (sent.length + 1 >= failFrom) throw new Error('Missing Permissions');
        sent.push({ content: options.content, files: options.files, reply: options.reply });
        return { id: `m${sent.length}`, channelId: CHANNEL };
      },
    };
    const bridge = new DiscordBridge({
      token: 'unused',
      access: { guildId: '100000000000000001', allowFrom: [USER], channels: opts.dm ? [] : [CHANNEL] },
      logger: new Logger({ stderr: false }),
      longReplyChars: opts.longReplyChars ?? 0,
    });
    const client = (bridge as unknown as { client: { channels: { fetch: (id: string) => Promise<unknown> } } }).client;
    client.channels.fetch = async (id: string) => (id === CHANNEL ? channel : null);
    if (opts.dm) {
      const internals = bridge as unknown as { dmChannels: Map<string, string>; allowedConversations: Set<string> };
      internals.dmChannels.set(USER, CHANNEL);
      internals.allowedConversations.add(CHANNEL);
    }
    return { bridge, sent };
  }

  it('reply の長文が途中で失敗したら、送れた件数（sent=N）を付けて投げる', async () => {
    const { bridge, sent } = setup({ failFrom: 3 });
    const text = 'a'.repeat(TEXT_CHUNK_MAX * 3);
    await expect(bridge.postText(CHANNEL, text)).rejects.toThrow(/Missing Permissions \(sent=2\)/);
    expect(sent).toHaveLength(2);
  });

  it('分けた結果が空白だけになるチャンクは送らない。本文が空白だけなら何も送らない', async () => {
    const { bridge, sent } = setup();
    // 1898 字 + 改行 5 個は、1900 字目（改行 2 個まで）で切れて、残りが改行 3 個だけになる
    const res = await bridge.postText(CHANNEL, 'a'.repeat(TEXT_CHUNK_MAX - 2) + '\n'.repeat(5));
    expect(res.ts).toHaveLength(1);
    expect(sent).toHaveLength(1);

    expect((await bridge.postText(CHANNEL, ' \n\t ')).ts).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it('reply の 1 通目で失敗したら、sent=N を付けずにそのまま投げる', async () => {
    const { bridge } = setup({ failFrom: 1 });
    await expect(bridge.postText(CHANNEL, 'x')).rejects.toThrow(/^Missing Permissions$/);
  });

  it('一斉メンションを無害化し、とても長い reply は冒頭を本文に、全文を添付にして 1 通で送る', async () => {
    const { bridge, sent } = setup({ longReplyChars: 100 });
    const res = await bridge.postText(CHANNEL, '@everyone ' + 'a'.repeat(200));
    expect(res.asFile).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).not.toContain('@everyone');
    expect(sent[0]?.files).toHaveLength(1);
  });

  it('DM の長文は、返信の参照を 1 通目にだけ付ける', async () => {
    const { bridge, sent } = setup({ dm: true });
    await bridge.postText(CHANNEL, 'a'.repeat(TEXT_CHUNK_MAX * 2), '900000000000000001');
    expect(sent.map((s) => s.reply)).toEqual([{ messageReference: '900000000000000001', failIfNotExists: false }, undefined]);
  });

  it('send_file の text が 1 通に収まらなければ、残りを続けて送る（捨てない）', async () => {
    const { bridge, sent } = setup();
    const text = 'a'.repeat(TEXT_CHUNK_MAX) + 'b'.repeat(10);
    await bridge.sendFiles(CHANNEL, [{ path: 'x.txt', name: 'x.txt' }], text);
    expect(sent.map((s) => s.content)).toEqual(['a'.repeat(TEXT_CHUNK_MAX), 'b'.repeat(10)]);
    expect(sent[0]?.files).toHaveLength(1);
    expect(sent[1]?.files).toBeUndefined();
  });

  it('send_file の続きの送信で失敗したら、送れた件数（sent=N）を付けて投げる', async () => {
    const { bridge } = setup({ failFrom: 2 });
    const text = 'a'.repeat(TEXT_CHUNK_MAX) + 'b';
    await expect(bridge.sendFiles(CHANNEL, [{ path: 'x.txt', name: 'x.txt' }], text)).rejects.toThrow(/Missing Permissions \(sent=1\)/);
  });
});

describe('DiscordBridge のボタン操作と受信の列', () => {
  const USER = '200000000000000001';
  const CHANNEL = '500000000000000060';
  const THREAD = '600000000000000061';

  function setup() {
    const actions: { parsed: unknown; ctx: unknown }[] = [];
    const bridge = new DiscordBridge({
      token: 'unused',
      access: { guildId: '100000000000000001', allowFrom: [USER], channels: [CHANNEL] },
      logger: new Logger({ stderr: false }),
    });
    const internals = bridge as unknown as {
      botUserId: string;
      allowedConversations: Set<string>;
      handleInteraction: (interaction: unknown) => Promise<void>;
      enqueue: (task: () => Promise<void>) => void;
      inbound: Promise<void>;
    };
    internals.botUserId = BOT;
    internals.allowedConversations.add(CHANNEL);
    void bridge.start({ onMessage: () => undefined, onAction: (parsed, ctx) => void actions.push({ parsed, ctx }) });
    return { actions, internals };
  }

  /** スレッドの中のボタン操作。author は押されたメッセージを投稿した人 */
  function buttonInThread(author: string) {
    return {
      isButton: () => true,
      isStringSelectMenu: () => false,
      channel: { id: THREAD, type: ChannelType.PublicThread, parentId: CHANNEL },
      message: { id: '800000000000000062', author: { id: author } },
      customId: 'perm:allow:abcde',
      guildId: '100000000000000001',
      user: { id: USER },
    };
  }

  it('ボット自身のメッセージ以外のボタンは扱わない', async () => {
    const { actions, internals } = setup();
    await internals.handleInteraction(buttonInThread('1400000000000000099'));
    expect(actions).toEqual([]);
  });

  it('スレッドの中のボタンは、親のチャンネルを会話、スレッドを返信先として渡す', async () => {
    const { actions, internals } = setup();
    await internals.handleInteraction(buttonInThread(BOT));
    expect(actions).toEqual([
      {
        parsed: expect.objectContaining({ ok: true }),
        ctx: { userId: USER, channelId: CHANNEL, messageTs: '800000000000000062', threadTs: THREAD },
      },
    ]);
  });

  it('受信の列は、前の処理が終わってから次を始め、例外が出ても次を続ける', async () => {
    const { internals } = setup();
    const order: string[] = [];
    internals.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('first');
      throw new Error('boom');
    });
    internals.enqueue(async () => {
      order.push('second');
    });
    await new Promise((r) => setTimeout(r, 60));
    await internals.inbound;
    expect(order).toEqual(['first', 'second']);
  });
});

describe('DiscordBridge のスレッドを作れない返信先', () => {
  const CHANNEL = '500000000000000050';
  const ORIGIN = '800000000000000051';

  it('スレッドを作れなかった返信先は覚えて、2 回目からは作ろうとせず元のメッセージへの返信にする', async () => {
    const tried: string[] = [];
    const channel = {
      id: CHANNEL,
      type: ChannelType.GuildText,
      isThread: () => false,
      isSendable: () => true,
      sendTyping: async () => undefined,
      messages: {
        fetch: async () => {
          tried.push('fetch');
          return { thread: null, content: 'hi', startThread: async () => Promise.reject(new Error('Missing Permissions')) };
        },
      },
    };
    const bridge = new DiscordBridge({
      token: 'unused',
      access: { guildId: '100000000000000001', allowFrom: ['200000000000000001'], channels: [CHANNEL] },
      logger: new Logger({ stderr: false }),
    });
    const client = (bridge as unknown as { client: { channels: { fetch: (id: string) => Promise<unknown> } } }).client;
    client.channels.fetch = async (id: string) => {
      tried.push(`channels.fetch:${id}`);
      return id === CHANNEL ? channel : null;
    };

    await bridge.sendTyping(CHANNEL, ORIGIN);
    tried.length = 0;
    await bridge.sendTyping(CHANNEL, ORIGIN);
    expect(tried).toEqual([`channels.fetch:${CHANNEL}`]);
  });
});

describe('DiscordBridge のメッセージの在りか（thread_id の検証）', () => {
  const ALLOWED = '500000000000000010';
  const THREAD = '600000000000000011';
  const FOREIGN = '700000000000000012';
  const FOREIGN_THREAD = '700000000000000013';
  const MESSAGE = '800000000000000014';
  const ATTACHMENT = '900000000000000015';

  /** client.channels.fetch を差し替えた DiscordBridge。どのチャンネルで操作したかを touched に残す */
  function setup() {
    const touched: { channel: string; op: string }[] = [];
    const channel = (id: string, opts: { thread: boolean; parentId?: string }) => ({
      id,
      parentId: opts.parentId ?? null,
      type: opts.thread ? ChannelType.PublicThread : ChannelType.GuildText,
      isThread: () => opts.thread,
      isSendable: () => true,
      messages: {
        react: async () => void touched.push({ channel: id, op: 'react' }),
        edit: async () => void touched.push({ channel: id, op: 'edit' }),
        fetch: async () => {
          touched.push({ channel: id, op: 'fetch' });
          return { attachments: new Map([[ATTACHMENT, { id: ATTACHMENT, name: 'a.txt', size: 1, contentType: null, url: 'https://cdn.discordapp.com/a' }]]) };
        },
      },
    });
    const channels: Record<string, unknown> = {
      [ALLOWED]: channel(ALLOWED, { thread: false }),
      [THREAD]: channel(THREAD, { thread: true, parentId: ALLOWED }),
      [FOREIGN]: channel(FOREIGN, { thread: false }),
      [FOREIGN_THREAD]: channel(FOREIGN_THREAD, { thread: true, parentId: FOREIGN }),
    };
    const bridge = new DiscordBridge({
      token: 'unused',
      access: { guildId: '100000000000000001', allowFrom: ['200000000000000001'], channels: [ALLOWED] },
      logger: new Logger({ stderr: false }),
    });
    const client = (bridge as unknown as { client: { channels: { fetch: (id: string) => Promise<unknown> } } }).client;
    client.channels.fetch = async (id: string) => channels[id] ?? null;
    return { bridge, touched, client, channels, channel };
  }

  it('react ツール用の addReactionOrThrow は失敗を投げ、受信時の印の addReaction は投げない', async () => {
    const { bridge, channels } = setup();
    channels[ALLOWED] = {
      id: ALLOWED,
      isThread: () => false,
      isSendable: () => true,
      messages: { react: async () => Promise.reject(new Error('Unknown Emoji')) },
    };
    await expect(bridge.addReactionOrThrow(ALLOWED, MESSAGE, 'ok')).rejects.toThrow('Unknown Emoji');
    await expect(bridge.addReaction(ALLOWED, MESSAGE, 'ok')).resolves.toBeUndefined();
  });

  it('thread_id のチャンネルの取得が失敗（reject）したら、許可した会話で操作する（D-DC-05）', async () => {
    const { bridge, touched, client, channels } = setup();
    client.channels.fetch = async (id: string) => {
      if (id === THREAD) throw new Error('Missing Access');
      return channels[id] ?? null;
    };
    await bridge.addReaction(ALLOWED, MESSAGE, '👍', THREAD);
    await bridge.updateText(ALLOWED, MESSAGE, 'x', THREAD);
    expect(touched).toEqual([
      { channel: ALLOWED, op: 'react' },
      { channel: ALLOWED, op: 'edit' },
    ]);
  });

  it('DM では thread_id を使わず、取りにも行かない（D-DC-05）', async () => {
    const DM = '500000000000000020';
    const { bridge, touched, client, channels, channel } = setup();
    channels[DM] = channel(DM, { thread: false });
    // init() で DM を開いたときと同じ状態にする
    const internals = bridge as unknown as { dmChannels: Map<string, string>; allowedConversations: Set<string> };
    internals.dmChannels.set('200000000000000001', DM);
    internals.allowedConversations.add(DM);
    const fetched: string[] = [];
    const original = client.channels.fetch;
    client.channels.fetch = async (id: string) => {
      fetched.push(id);
      return original(id);
    };
    await bridge.addReaction(DM, MESSAGE, '👍', THREAD);
    expect(touched).toEqual([{ channel: DM, op: 'react' }]);
    expect(fetched).not.toContain(THREAD);
  });

  it('在りかを覚えているメッセージは、thread_id によらず覚えた場所で操作する（D-DC-05）', async () => {
    const { bridge, touched } = setup();
    (bridge as unknown as { locations: { set: (k: string, v: string) => void } }).locations.set(MESSAGE, THREAD);
    await bridge.addReaction(ALLOWED, MESSAGE, '👍', FOREIGN_THREAD);
    expect(touched).toEqual([{ channel: THREAD, op: 'react' }]);
  });

  it('許可した会話の中のスレッドなら、thread_id のチャンネルで操作する', async () => {
    const { bridge, touched } = setup();
    await bridge.addReaction(ALLOWED, MESSAGE, '👍', THREAD);
    await bridge.updateText(ALLOWED, MESSAGE, 'x', THREAD);
    await bridge.attachmentInfo({ chatId: ALLOWED, messageId: MESSAGE, attachmentId: ATTACHMENT, threadId: THREAD });
    expect(touched).toEqual([
      { channel: THREAD, op: 'react' },
      { channel: THREAD, op: 'edit' },
      { channel: THREAD, op: 'fetch' },
    ]);
  });

  it.each([
    ['許可外のチャンネル', FOREIGN],
    ['許可外のチャンネルのスレッド', FOREIGN_THREAD],
    ['存在しないチャンネル', '700000000000000099'],
  ])('thread_id が%sなら使わず、許可した会話で操作する（react / edit_message / download_file）', async (_label, threadId) => {
    const { bridge, touched } = setup();
    await bridge.addReaction(ALLOWED, MESSAGE, '👍', threadId);
    await bridge.updateText(ALLOWED, MESSAGE, 'x', threadId);
    await bridge.attachmentInfo({ chatId: ALLOWED, messageId: MESSAGE, attachmentId: ATTACHMENT, threadId });
    expect(touched).toEqual([
      { channel: ALLOWED, op: 'react' },
      { channel: ALLOWED, op: 'edit' },
      { channel: ALLOWED, op: 'fetch' },
    ]);
  });
});

describe('embedText', () => {
  it('embed の見出し・URL・本文・項目・注記を文字にする。無ければ undefined', () => {
    const message = {
      embeds: [
        {
          title: 'CI #12 failed',
          url: 'https://github.com/o/r/actions/runs/1',
          description: 'test (windows-latest)',
          fields: [{ name: 'branch', value: 'main' }],
          footer: { text: 'GitHub Actions' },
        },
      ],
    } as unknown as Parameters<typeof embedText>[0];
    expect(embedText(message)).toBe('CI #12 failed\nhttps://github.com/o/r/actions/runs/1\ntest (windows-latest)\nbranch: main\nGitHub Actions');
    expect(embedText({ embeds: [] })).toBeUndefined();
  });
});
