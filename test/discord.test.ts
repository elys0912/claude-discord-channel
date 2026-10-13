import { describe, expect, it } from 'vitest';
import { ChannelType } from 'discord.js';
import { DiscordBridge, embedText, normalizeBotRoleMentions } from '../src/discord.js';
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
    return { bridge, touched };
  }

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
