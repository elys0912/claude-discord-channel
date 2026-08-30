// Discord との出入り口（slack.ts の代わり）。Gateway で受信し、REST で送る。
// relay 群が使う関数の形は Slack 版にそろえてある（channel = 会話の ID、ts = メッセージの ID、threadTs = 返信先）。
// - 会話の ID: DM ならその DM のチャンネル、サーバーなら access.channels のチャンネル（スレッドの中でも親チャンネル）
// - 返信先（threadTs）: サーバーではそのメッセージから作るスレッド（スレッドの ID は元メッセージの ID と同じ）、
//   DM ではそのメッセージへの返信。スレッドの中のメッセージを後で書き換えられるよう、メッセージのある場所を覚えておく
import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  MessageType,
  Partials,
  Routes,
} from 'discord.js';
import type {
  Channel,
  ChatInputCommandInteraction,
  Interaction,
  MessageContextMenuCommandInteraction,
  Message,
  MessageCreateOptions,
  MessageEditOptions,
  SendableChannels,
} from 'discord.js';
import type { Card } from './card.js';
import { toDiscord } from './card.js';
import { chunkText } from './chunk.js';
import type { ParsedAccess } from './config.js';
import { errMessage } from './errors.js';
import { neutralizeBroadcasts } from './format.js';
import { EventDedupe, conversationOf, forwardDelivery, gate, threadOf } from './gate.js';
import type { ChannelKind, GateResult, InboundMessage } from './gate.js';
import type { Logger } from './log.js';
import { DEFAULT_LONG_REPLY_CHARS, toLongReply } from './long-reply.js';
import { parseInteraction } from './permission.js';
import { PRESENCE_VIEW } from './presence.js';
import type { PresenceState } from './presence.js';
import type { ActionParse } from './permission.js';
import type { Command } from './app.js';
import { APP_COMMANDS, FORWARD_COMMAND_NAME, checkUse, parseSlashCommand, sameCommands, slashEcho } from './slash.js';

/** 1 通の上限（2000 字）に、コードブロックを閉じ直す分の余裕を持たせる */
export const TEXT_CHUNK_MAX = 1900;
/** ログインして Gateway の準備ができるまで待つ上限 */
const READY_TIMEOUT_MS = 30_000;
/** スレッドの名前に使う本文の長さ */
const THREAD_NAME_MAX = 40;
/** 覚えておくメッセージの場所・ボットが関わったスレッドの数（古いものから忘れる） */
const LOCATION_CAPACITY = 2000;
const ACTIVE_THREAD_CAPACITY = 500;
/** スレッドを作れなかった返信先の数（古いものから忘れる） */
const THREADLESS_TARGET_CAPACITY = 500;
/** 添付を取りに行ってよいホスト */
const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/** どの送信でも、誰も呼ばない（@everyone・ロール・ユーザー・返信先への通知を止める） */
const NO_MENTIONS = { parse: [], repliedUser: false } as const;

/** 受信メッセージの位置情報（リアクションやスレッド返信の宛先に使う） */
export interface InboundRef {
  /** 会話の ID */
  channel?: string | undefined;
  /** メッセージの ID */
  ts?: string | undefined;
  /** 返信先 */
  threadTs?: string | undefined;
  user?: string | undefined;
}

/** ボタンが押されたメッセージと押した人 */
export interface ActionContext {
  userId?: string | undefined;
  /** 会話の ID */
  channelId?: string | undefined;
  /** ボタンのあるメッセージの ID */
  messageTs?: string | undefined;
  /** ボタンのメッセージがスレッドの中にあるときのスレッドの ID */
  threadTs?: string | undefined;
}

export interface DiscordBridgeEvents {
  onMessage: (r: GateResult, raw: InboundRef) => void | Promise<void>;
  onAction: (parsed: ActionParse, ctx: ActionContext) => void | Promise<void>;
  /**
   * スラッシュコマンドが使われたとき（検証済み）。ctx.messageTs は、使ったことを残すためにボットが返した一言のメッセージ。
   * 省略時はスラッシュコマンドに何もしない
   */
  onCommand?: ((command: Command, ctx: ActionContext) => void | Promise<void>) | undefined;
  /** 保留中の permission request か（gate に渡す。省略時は `yes xxxxx` の形なら常に verdict） */
  isKnownRequest?: ((requestId: string) => boolean) | undefined;
  /**
   * Gateway が回復できない理由（トークンの無効化・Intent の不許可など）で閉じ、再接続しないとき。
   * 以後は受信が止まるので、手元のセッションに知らせる。detail は閉じた理由（ログ用）
   */
  onGatewayLost?: ((detail: string) => void | Promise<void>) | undefined;
}

export interface DiscordInitResult {
  botUserId: string;
  botTag: string;
  guildName: string;
  /** 開けた DM チャンネルの件数 */
  dmChannelCount: number;
}

/** 添付の場所（download_file の引数） */
export interface AttachmentRef {
  chatId: string;
  messageId: string;
  attachmentId: string;
  threadId?: string | undefined;
}

/** 取りに行く添付の情報 */
export interface RemoteFile {
  id: string;
  name: string;
  size?: number | undefined;
  mimetype?: string | undefined;
  url: string;
}

export interface DiscordDeps {
  token: string;
  access: ParsedAccess;
  logger: Logger;
  /** テスト用の差し替え口（省略時はグローバルの fetch。添付のダウンロードに使う） */
  fetch?: typeof fetch;
  /** これを超える返信は冒頭と全文の添付にする（.env の LONG_REPLY_CHARS。0 なら分けて送る） */
  longReplyChars?: number | undefined;
}

/** 古いものから忘れる、大きさに上限のある Map */
class BoundedMap<V> {
  private readonly store = new Map<string, V>();
  constructor(private readonly capacity: number) {}

  get(key: string): V | undefined {
    return this.store.get(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  set(key: string, value: V): void {
    this.store.delete(key);
    this.store.set(key, value);
    if (this.store.size > this.capacity) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
  }
}

function channelKind(channel: Channel): ChannelKind {
  switch (channel.type) {
    case ChannelType.DM:
      return 'dm';
    case ChannelType.GuildText:
    case ChannelType.GuildAnnouncement:
      return 'channel';
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread:
      return 'thread';
    default:
      return 'other';
  }
}

/**
 * ボットのロール（招待したときに Discord が自動で作る、ボットと同じ名前のロール）へのメンションを、ボット本人へのメンションに置き換える。
 * 入力欄のメンションの候補にはボット本人とこのロールの両方が出るので、どちらを選ばれても話しかけられたとみなすため
 */
export function normalizeBotRoleMentions(content: string, botRoleIds: readonly string[], botUserId: string): string {
  let out = content;
  for (const roleId of botRoleIds) out = out.split(`<@&${roleId}>`).join(`<@${botUserId}>`);
  return out;
}

/** embed の文字の上限（CI の通知を Claude に渡すときに膨らませない） */
const EMBED_TEXT_MAX = 4000;

/** embed の見出し・URL・本文・項目・注記を文字にする（CI の通知は本文が空で embed だけのことが多い）。無ければ undefined */
export function embedText(message: Pick<Message, 'embeds'>): string | undefined {
  const lines: string[] = [];
  for (const e of message.embeds) {
    if (e.title) lines.push(e.title);
    if (e.url) lines.push(e.url);
    if (e.description) lines.push(e.description);
    for (const f of e.fields) lines.push(`${f.name}: ${f.value}`);
    if (e.footer?.text) lines.push(e.footer.text);
  }
  const text = lines.join('\n').trim();
  return text === '' ? undefined : text.slice(0, EMBED_TEXT_MAX);
}

/** Discord の Message を gate 用の InboundMessage に詰め替える */
export function toInbound(message: Message, botUserId: string | undefined): InboundMessage {
  const kind = channelKind(message.channel);
  // このボットのロール（tags.botId がボット）へのメンションも、ボットへのメンションとして扱う
  const botRoleIds =
    botUserId === undefined ? [] : [...message.mentions.roles.filter((r) => r.tags?.botId === botUserId).keys()];
  const content = botUserId === undefined ? message.content : normalizeBotRoleMentions(message.content, botRoleIds, botUserId);
  const parentId = kind === 'thread' && 'parentId' in message.channel ? (message.channel.parentId ?? undefined) : undefined;
  return {
    guildId: message.guildId ?? null,
    messageId: message.id,
    kind,
    channelId: message.channelId,
    parentId,
    authorId: message.author.id,
    authorIsBot: message.author.bot || message.webhookId !== null,
    webhookId: message.webhookId ?? undefined,
    embedText: embedText(message),
    isUserMessage: message.type === MessageType.Default || message.type === MessageType.Reply,
    content,
    mentionsBot:
      botUserId !== undefined &&
      (botRoleIds.length > 0 ||
        message.mentions.has(botUserId, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true })),
    repliesToBot: botUserId !== undefined && message.mentions.repliedUser?.id === botUserId,
    createdAt: message.createdAt.toISOString(),
    files:
      message.attachments.size > 0
        ? message.attachments.map((a) => ({ id: a.id, name: a.name, mimetype: a.contentType ?? undefined, size: a.size }))
        : undefined,
  };
}

/**
 * limit ごとに分けたチャンクのうち、空白だけでないもの。分けた結果、末尾が改行だけのチャンクになることがあり、
 * そのまま送ると Discord に拒否されて、全部届いているのに失敗（sent=N）として返ってしまうため
 */
function nonBlankChunks(text: string, limit: number): string[] {
  return chunkText(text, limit).filter((piece) => piece.trim() !== '');
}

/** スレッドの名前（本文の先頭。空なら Claude）。THREAD_NAME_MAX で切り、サロゲートペアの途中では切らない */
export function threadName(content: string): string {
  const oneLine = content.replace(/<@!?\d+>/g, '').replace(/\s+/g, ' ').trim();
  if (oneLine === '') return 'Claude';

  const head = oneLine.slice(0, THREAD_NAME_MAX);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

export class DiscordBridge {
  private readonly access: ParsedAccess;
  private readonly logger: Logger;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly longReplyChars: number;
  private readonly client: Client;
  private readonly dedupe = new EventDedupe();
  /** 許可ユーザー → DM のチャンネル */
  private readonly dmChannels = new Map<string, string>();
  /** 送信やボタン操作を受け付ける会話（許可ユーザーの DM + access.channels） */
  private readonly allowedConversations = new Set<string>();
  /** メッセージの ID → そのメッセージのあるチャンネル（スレッドの中ならスレッドの ID） */
  private readonly locations = new BoundedMap<string>(LOCATION_CAPACITY);
  /** ボットが関わったスレッド（話しかけられた・投稿した）。古いものから忘れる */
  private readonly activeThreads = new BoundedMap<true>(ACTIVE_THREAD_CAPACITY);
  /**
   * スレッドを作れなかった返信先のメッセージ（権限不足など）。「入力中…」の出し直しなどで同じ返信先に何度も送るので、
   * 2 回目からは作ろうとせず、元のメッセージへの返信にする（失敗する API 呼び出しと警告を繰り返さない）。動いている間だけ覚える
   */
  private readonly threadlessTargets = new BoundedMap<true>(THREADLESS_TARGET_CAPACITY);

  private botUserId: string | undefined;
  private handlers: DiscordBridgeEvents | undefined;
  private connected = false;
  /** 受信イベントの処理の列（末尾） */
  private inbound: Promise<void> = Promise.resolve();

  constructor(deps: DiscordDeps) {
    this.access = deps.access;
    this.logger = deps.logger;
    this.token = deps.token;
    this.fetchFn = deps.fetch ?? fetch;
    this.longReplyChars = deps.longReplyChars ?? DEFAULT_LONG_REPLY_CHARS;
    for (const channel of deps.access.channels ?? []) this.allowedConversations.add(channel);
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      // DM のチャンネルは最初は partial で届くので、これが無いと messageCreate が来ない
      partials: [Partials.Channel, Partials.Message],
      allowedMentions: NO_MENTIONS,
    });
  }

  /** Gateway がつながっている（!status 用） */
  get isConnected(): boolean {
    return this.connected;
  }

  // --- 初期化・起動・停止 -----------------------------------------------------

  /**
   * ログインして Gateway の準備を待ち、ボットのユーザー ID を覚える。ボットが access.guildId のサーバーに入っているかを確かめ、
   * allowFrom の各ユーザーと DM を開いて送信先に登録する（開けなかった人はログに残し、DM を受け取った時点で登録する）。
   * サーバーに入っていない、DM もチャンネルも 1 つも無いときは投げる。
   */
  async init(): Promise<DiscordInitResult> {
    this.bindListeners();
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Discord の準備が時間内に終わらなかった')), READY_TIMEOUT_MS);
      this.client.once(Events.ClientReady, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await this.client.login(this.token);
    await ready;
    this.connected = true;
    const user = this.client.user;
    if (!user) throw new Error('ボットのユーザーが取れなかった');
    this.botUserId = user.id;

    const guild = this.client.guilds.cache.get(this.access.guildId);
    if (!guild) throw new Error(`ボットが access.json の guildId のサーバーに入っていない（guildId=${this.access.guildId}）`);

    for (const userId of this.access.allowFrom) {
      try {
        const dm = await this.client.users.createDM(userId);
        this.dmChannels.set(userId, dm.id);
        this.allowedConversations.add(dm.id);
      } catch (e) {
        this.logger.warn(`DM を開けなかった user=${userId}（同じサーバーにいないと開けない）`, errMessage(e));
      }
    }
    if (this.dmChannels.size === 0 && (this.access.channels ?? []).length === 0) {
      throw new Error('許可ユーザーの DM を 1 つも開けず、access.json の channels も無い');
    }
    await this.registerCommands();
    return { botUserId: user.id, botTag: user.tag, guildName: guild.name, dmChannelCount: this.dmChannels.size };
  }

  /** 受信の処理を始める（init() の時点で Gateway にはつながっている。それまでに届いたものは捨てる） */
  start(handlers: DiscordBridgeEvents): Promise<void> {
    this.handlers = handlers;
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    this.handlers = undefined;
    try {
      await this.client.destroy();
    } catch (e) {
      this.logger.warn('Discord の切断に失敗', e);
    }
    this.connected = false;
  }

  private bindListeners(): void {
    this.client.on(Events.ShardReady, () => {
      this.connected = true;
      this.logger.info('gateway: ready');
    });
    this.client.on(Events.ShardResume, () => {
      this.connected = true;
      this.logger.info('gateway: resumed');
    });
    // discord.js 14 の ShardDisconnect は、回復できない close code（4004 認証の失敗・4014 Intent の不許可など）で閉じて再接続しないときだけ来る
    this.client.on(Events.ShardDisconnect, (event) => this.gatewayLost(`close code ${event.code}`));
    this.client.on(Events.ShardReconnecting, () => {
      this.connected = false;
      this.logger.info('gateway: reconnecting');
    });
    this.client.on(Events.Error, (e) => this.logger.error('discord.js のエラー', e));
    this.client.on(Events.MessageCreate, (message) => this.enqueue(() => this.handleMessage(message)));
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isMessageContextMenuCommand()) {
        // 右クリックメニューも 3 秒以内に応答が要るので、検証と一言の返信は先に済ませ、Claude に渡すのを列に積む
        const answered = this.answerForward(interaction);
        this.enqueue(async () => {
          const forwarded = await answered;
          if (forwarded && this.handlers) await this.handlers.onMessage(forwarded.result, forwarded.raw);
        });
        return;
      }
      if (interaction.isChatInputCommand()) {
        // スラッシュコマンドも 3 秒以内に応答が要るので、検証と一言の返信は列を待たずに済ませ、コマンドの処理だけを列に積む
        const answered = this.answerSlash(interaction);
        this.enqueue(async () => {
          const used = await answered;
          if (used && this.handlers?.onCommand) await this.handlers.onCommand(used.command, used.ctx);
        });
        return;
      }
      // ボタンの応答は 3 秒以内に返す必要があるので、列を待たずにすぐ受け取ったことを返す
      const acked = this.ack(interaction);
      this.enqueue(async () => {
        await acked;
        await this.handleInteraction(interaction);
      });
    });
  }

  /** 回復できない切断。受信の列を通さずに知らせる（列が詰まっていても届くように） */
  private gatewayLost(detail: string): void {
    this.connected = false;
    this.logger.error(`gateway: 回復できない切断で、再接続しない（${detail}）`);
    Promise.resolve(this.handlers?.onGatewayLost?.(detail)).catch((e: unknown) =>
      this.logger.error('回復できない切断の知らせで例外', e)
    );
  }

  /** 受信イベントを 1 本の Promise チェーンに積み、受け取った順に 1 件ずつ処理する */
  private enqueue(task: () => Promise<void>): void {
    this.inbound = this.inbound.then(task).catch((e: unknown) => this.logger.error('受信イベントの処理で例外', e));
  }

  // --- 受信 -----------------------------------------------------------------

  private async handleMessage(message: Message): Promise<void> {
    if (!this.handlers) return;
    // 自分の発言は捨てる（送った場所は send() で覚えている）
    if (message.author.id === this.botUserId) return;
    const msg = toInbound(message, this.botUserId);
    const result = gate(msg, this.access, this.botUserId, this.dedupe, this.handlers.isKnownRequest, (t) => this.activeThreads.has(t));
    if (result.kind !== 'drop') this.rememberSender(msg);
    await this.handlers.onMessage(result, {
      channel: conversationOf(msg),
      ts: msg.messageId,
      threadTs: threadOf(msg),
      user: msg.authorId,
    });
  }

  /** gate を通った受信から、送信先とメッセージの場所を覚える */
  private rememberSender(msg: InboundMessage): void {
    this.locations.set(msg.messageId, msg.channelId);
    if (msg.kind === 'dm') {
      if (!this.dmChannels.has(msg.authorId) && this.access.allowFrom.includes(msg.authorId)) {
        this.dmChannels.set(msg.authorId, msg.channelId);
        this.allowedConversations.add(msg.channelId);
        this.logger.info(`受信した DM から送信先を追加 user=${msg.authorId} channel=${msg.channelId}`);
      }
      return;
    }
    // チャンネルの発言はそのメッセージからスレッドを作るので、その ID を関わったスレッドとして覚える
    this.activeThreads.set(threadOf(msg), true);
  }

  private async ack(interaction: Interaction): Promise<void> {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
    try {
      await interaction.deferUpdate();
    } catch (e) {
      this.logger.warn('ボタンの応答に失敗', e);
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!this.handlers) return;
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
    const channel = interaction.channel;
    if (!channel) return;
    const kind = channelKind(channel);
    const parentId = kind === 'thread' && 'parentId' in channel ? (channel.parentId ?? '') : undefined;
    const conversationId = kind === 'thread' ? (parentId ?? '') : channel.id;
    // ボット自身のメッセージのボタンだけを扱う
    if (interaction.message.author.id !== this.botUserId) return;
    this.locations.set(interaction.message.id, channel.id);

    const parsed = parseInteraction(
      {
        kind: interaction.isButton() ? 'button' : 'select',
        customId: interaction.customId,
        values: interaction.isStringSelectMenu() ? interaction.values : undefined,
        guildId: interaction.guildId ?? null,
        userId: interaction.user.id,
        conversationId,
      },
      this.access,
      this.allowedConversations
    );
    await this.handlers.onAction(parsed, {
      userId: interaction.user.id,
      channelId: conversationId,
      messageTs: interaction.message.id,
      threadTs: kind === 'thread' ? channel.id : undefined,
    });
  }

  // --- スラッシュコマンド -----------------------------------------------------

  /**
   * APP_COMMANDS（スラッシュコマンドと右クリックメニュー）をアプリのコマンドとして登録する（サーバーとボットとの DM の両方に出る）。
   * 登録済みのものと同じなら何もしない。失敗しても投げない（`!` のコマンドは使えるので、ログに残して続ける）
   */
  private async registerCommands(): Promise<void> {
    const appId = this.client.application?.id;
    if (!appId) return;
    try {
      const route = Routes.applicationCommands(appId);
      const registered = (await this.client.rest.get(route)) as unknown[];
      if (sameCommands(registered)) return;
      await this.client.rest.put(route, { body: APP_COMMANDS });
      this.logger.info(`スラッシュコマンドと右クリックメニューを登録した 件数=${APP_COMMANDS.length}`);
    } catch (e) {
      this.logger.warn('スラッシュコマンドの登録に失敗（! のコマンドは使える）', errMessage(e));
    }
  }

  /**
   * スラッシュコマンドを検証し、使ってよければ使ったことを一言返して、その返信を返信先にした場所を返す。
   * 使えない人・場所なら本人にだけ見える返事をして undefined。投げない
   */
  private async answerSlash(interaction: ChatInputCommandInteraction): Promise<{ command: Command; ctx: ActionContext } | undefined> {
    try {
      const channel = interaction.channel ?? (await this.client.channels.fetch(interaction.channelId).catch(() => null));
      const kind = channel ? channelKind(channel) : interaction.guildId === null ? 'dm' : 'other';
      const parentId = kind === 'thread' && channel && 'parentId' in channel ? (channel.parentId ?? '') : undefined;
      const conversationId = kind === 'thread' ? (parentId ?? '') : interaction.channelId;
      const parsed = parseSlashCommand(
        {
          name: interaction.commandName,
          mode: interaction.options.getString('mode'),
          force: interaction.options.getBoolean('force'),
          guildId: interaction.guildId ?? null,
          userId: interaction.user.id,
          conversationId,
        },
        this.access,
        this.allowedConversations
      );
      if (!parsed.ok) {
        this.logger.warn(`スラッシュコマンドを無視 reason=${parsed.reason} user=${interaction.user.id}`);
        await interaction.reply({ content: '⚠️ ここでは、このボットのコマンドは使えない', flags: MessageFlags.Ephemeral });
        return undefined;
      }
      await interaction.reply({ content: slashEcho(parsed.command), allowedMentions: NO_MENTIONS });
      const echo = await interaction.fetchReply();
      this.locations.set(echo.id, echo.channelId);
      return {
        command: parsed.command,
        ctx: {
          userId: interaction.user.id,
          channelId: conversationId,
          messageTs: echo.id,
          threadTs: kind === 'thread' ? interaction.channelId : undefined,
        },
      };
    } catch (e) {
      this.logger.warn('スラッシュコマンドへの応答に失敗', errMessage(e));
      return undefined;
    }
  }

  /**
   * 右クリックメニュー「Claude に渡す」。使ってよい人・場所か確かめ、渡したことを一言返して、
   * 選ばれたメッセージを Claude に渡す形（返信先はその一言、スレッドの中ならそのスレッド）にして返す。
   * 使えなければ本人にだけ見える返事をして undefined。投げない
   */
  private async answerForward(
    interaction: MessageContextMenuCommandInteraction
  ): Promise<{ result: GateResult; raw: InboundRef } | undefined> {
    try {
      if (interaction.commandName !== FORWARD_COMMAND_NAME) return undefined;
      const channel = interaction.channel ?? (await this.client.channels.fetch(interaction.channelId).catch(() => null));
      const kind = channel ? channelKind(channel) : interaction.guildId === null ? 'dm' : 'other';
      const parentId = kind === 'thread' && channel && 'parentId' in channel ? (channel.parentId ?? '') : undefined;
      const conversationId = kind === 'thread' ? (parentId ?? '') : interaction.channelId;
      const refused = checkUse({ guildId: interaction.guildId ?? null, userId: interaction.user.id, conversationId }, this.access, this.allowedConversations);
      if (refused) {
        this.logger.warn(`右クリックメニューを無視 reason=${refused} user=${interaction.user.id}`);
        await interaction.reply({ content: '⚠️ ここでは、このボットのメニューは使えない', flags: MessageFlags.Ephemeral });
        return undefined;
      }
      const target = interaction.targetMessage;
      await interaction.reply({ content: `📨 Claude に渡した: ${target.url}`, allowedMentions: NO_MENTIONS });
      const echo = await interaction.fetchReply();
      this.locations.set(echo.id, echo.channelId);
      this.locations.set(target.id, target.channelId);
      const replyTo = kind === 'thread' ? interaction.channelId : echo.id;
      this.logger.info(`メッセージを Claude に渡す message=${target.id} by=${interaction.user.id}`);
      return {
        result: forwardDelivery(toInbound(target, this.botUserId), interaction.user.id, replyTo),
        raw: { channel: conversationId, ts: target.id, threadTs: replyTo, user: interaction.user.id },
      };
    } catch (e) {
      this.logger.warn('右クリックメニューへの応答に失敗', errMessage(e));
      return undefined;
    }
  }

  /** そのスレッドにボットが関わっているか */
  isActiveThread(threadId: string): boolean {
    return this.activeThreads.has(threadId);
  }

  // --- 送り先の解決 -----------------------------------------------------------

  private assertAllowed(conversation: string): void {
    if (!this.allowedConversations.has(conversation)) throw new Error('許可されていない送信先チャンネル');
  }

  private async sendable(channelId: string): Promise<SendableChannels> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error(`送信できないチャンネル: ${channelId}`);
    return channel;
  }

  /**
   * 会話と返信先から、実際に送るチャンネルと返信の参照を決める（設計書 D4）。
   * - DM: そのチャンネルに送り、threadTs のメッセージへの返信にする
   * - サーバー: threadTs のスレッドがあればそこ、無ければ threadTs のメッセージからスレッドを作る。作れなければ元メッセージへの返信
   */
  private async resolveTarget(conversation: string, threadTs: string | undefined): Promise<{ channel: SendableChannels; replyTo?: string }> {
    if (threadTs === undefined) return { channel: await this.sendable(conversation) };
    if (this.dmChannelIds().has(conversation)) return { channel: await this.sendable(conversation), replyTo: threadTs };
    if (this.threadlessTargets.has(threadTs)) return { channel: await this.sendable(conversation), replyTo: threadTs };

    // 既にあるスレッドならそこに送る。フォーラムの投稿もスレッドなので、親（フォーラム）に直接は送れなくても届く。
    // スレッドは許可した会話（親）の中にあるものだけ使う
    const existing = await this.client.channels.fetch(threadTs).catch(() => null);
    if (existing?.isThread() && existing.isSendable() && existing.parentId === conversation) {
      this.activeThreads.set(existing.id, true);
      return { channel: existing };
    }
    const base = await this.sendable(conversation);
    if (base.type === ChannelType.DM) return { channel: base, replyTo: threadTs };
    if (base.type !== ChannelType.GuildText && base.type !== ChannelType.GuildAnnouncement) return { channel: base, replyTo: threadTs };
    try {
      const origin = await base.messages.fetch(threadTs);
      const thread = origin.thread ?? (await origin.startThread({ name: threadName(origin.content), autoArchiveDuration: 1440 }));
      this.activeThreads.set(thread.id, true);
      return { channel: thread };
    } catch (e) {
      this.logger.warn(`スレッドを作れなかったので、元のメッセージへの返信にする thread=${threadTs}`, errMessage(e));
      this.threadlessTargets.set(threadTs, true);
      return { channel: base, replyTo: threadTs };
    }
  }

  /**
   * メッセージのあるチャンネル。覚えていなければ、スレッドの中（threadTs があってメッセージと違う）か会話そのもの。
   * threadTs は Claude が渡す任意の値なので、許可した会話（親）の中のスレッドだと確かめられたときだけ使う
   */
  private async locate(conversation: string, messageId: string, threadTs?: string): Promise<string> {
    const known = this.locations.get(messageId);
    if (known) return known;
    if (threadTs === undefined || threadTs === messageId || this.dmChannelIds().has(conversation)) return conversation;
    const thread = await this.client.channels.fetch(threadTs).catch(() => null);
    if (thread?.isThread() && thread.parentId === conversation) return threadTs;
    return conversation;
  }

  private dmChannelIds(): Set<string> {
    return new Set(this.dmChannels.values());
  }

  private async send(target: { channel: SendableChannels; replyTo?: string }, options: MessageCreateOptions): Promise<Message> {
    const sent = await target.channel.send({
      ...options,
      allowedMentions: NO_MENTIONS,
      ...(target.replyTo ? { reply: { messageReference: target.replyTo, failIfNotExists: false } } : {}),
    });
    this.locations.set(sent.id, sent.channelId);
    return sent;
  }

  // --- 送信 -----------------------------------------------------------------

  /**
   * テキストを送る。許可した会話以外には送らない（投げる）。一斉メンションは無効化し、空白だけなら何も送らない。
   * 長文は TEXT_CHUNK_MAX ごとに分けて順に送る。途中のチャンクで失敗した場合、1 通以上送れていれば
   * 例外のメッセージに `sent=N`（送れた件数）を付けて投げる（Claude が再送の範囲を判断できるように）。
   */
  async postText(channel: string, text: string, threadTs?: string): Promise<{ ts: string[]; asFile?: boolean }> {
    this.assertAllowed(channel);
    const safe = neutralizeBroadcasts(text);
    const ids: string[] = [];
    if (safe.trim() === '') return { ts: ids };
    const target = await this.resolveTarget(channel, threadTs);
    // 長い返信は、冒頭だけを本文にして全文を添付する
    const long = toLongReply(safe, this.longReplyChars);
    if (long) {
      const sent = await this.send(target, { content: long.content, files: [{ attachment: long.file, name: long.name }] });
      return { ts: [sent.id], asFile: true };
    }
    try {
      for (const [i, piece] of nonBlankChunks(safe, TEXT_CHUNK_MAX).entries()) {
        // DM で返信の参照を付けるのは最初の 1 通だけ
        const sent = await this.send(i === 0 ? target : { channel: target.channel }, { content: piece });
        ids.push(sent.id);
      }
    } catch (e) {
      if (ids.length === 0) throw e;
      throw new Error(`${errMessage(e)} (sent=${ids.length})`, { cause: e });
    }
    return { ts: ids };
  }

  async postCard(channel: string, card: Card, threadTs?: string): Promise<{ ts: string }> {
    this.assertAllowed(channel);
    const target = await this.resolveTarget(channel, threadTs);
    const { embeds, components } = toDiscord(card);
    const sent = await this.send(target, { embeds, components });
    return { ts: sent.id };
  }

  /** ボットのステータス表示を変える（状態ごとの表示は presence.ts） */
  setPresence(state: PresenceState): void {
    const view = PRESENCE_VIEW[state];
    this.client.user?.setPresence({
      status: view.status,
      activities: [{ name: view.text, state: view.text, type: ActivityType.Custom }],
    });
  }

  /** 返信先に「入力中…」を出す（約 10 秒で消える） */
  async sendTyping(channel: string, threadTs?: string): Promise<void> {
    this.assertAllowed(channel);
    const target = await this.resolveTarget(channel, threadTs);
    await target.channel.sendTyping();
  }

  /**
   * ファイルを添付して送る（send_file 用。送ってよいかの判定は send-file.ts が済ませている）。
   * text が TEXT_CHUNK_MAX を超えるときは、1 通目に先頭を、残りを続けて送る。
   * 続きの送信で失敗したら、例外のメッセージに `sent=N`（添付の 1 通を含む送れた件数）を付けて投げる
   */
  async sendFiles(channel: string, files: { path: string; name: string }[], text?: string, threadTs?: string): Promise<{ ts: string }> {
    this.assertAllowed(channel);
    const target = await this.resolveTarget(channel, threadTs);
    const [first, ...rest] = text === undefined ? [] : nonBlankChunks(neutralizeBroadcasts(text), TEXT_CHUNK_MAX);
    const sent = await this.send(target, {
      ...(first ? { content: first } : {}),
      files: files.map((f) => ({ attachment: f.path, name: f.name })),
    });

    let count = 1;
    try {
      for (const piece of rest) {
        await this.send({ channel: target.channel }, { content: piece });
        count++;
      }
    } catch (e) {
      throw new Error(`${errMessage(e)} (sent=${count})`, { cause: e });
    }
    return { ts: sent.id };
  }

  /** 本文だけに書き換える（edit_message ツール用。カードとボタンは外す） */
  async updateText(channel: string, ts: string, text: string, threadTs?: string): Promise<void> {
    this.assertAllowed(channel);
    await this.edit(await this.locate(channel, ts, threadTs), ts, { content: neutralizeBroadcasts(text), embeds: [], components: [] });
  }

  async updateCard(channel: string, ts: string, card: Card): Promise<void> {
    this.assertAllowed(channel);
    const { embeds, components } = toDiscord(card);
    await this.edit(await this.locate(channel, ts), ts, { content: '', embeds, components });
  }

  private async edit(channelId: string, messageId: string, options: MessageEditOptions): Promise<void> {
    const channel = await this.sendable(channelId);
    await channel.messages.edit(messageId, { ...options, allowedMentions: NO_MENTIONS });
  }

  /**
   * リアクション付与（MCP の react ツール用）。失敗（絵文字名の誤り・メッセージが無い・権限不足など）は投げる。
   * もう付いているリアクションは Discord が成功で返すので、特別扱いは要らない
   */
  async addReactionOrThrow(channel: string, ts: string, emoji: string, threadTs?: string): Promise<void> {
    this.assertAllowed(channel);
    const target = await this.sendable(await this.locate(channel, ts, threadTs));
    await target.messages.react(ts, emoji);
  }

  /** リアクション付与（受信時の 👀 や回答の印）。失敗しても投げない（ログに残す） */
  async addReaction(channel: string, ts: string, emoji: string, threadTs?: string): Promise<void> {
    this.assertAllowed(channel);
    try {
      await this.addReactionOrThrow(channel, ts, emoji, threadTs);
    } catch (e) {
      this.logger.warn(`リアクションに失敗 emoji=${emoji}`, errMessage(e));
    }
  }

  /**
   * 許可ユーザー全員の DM に送る。threadFor が返信先を返した DM ではそのメッセージへの返信に、
   * 返さなかった DM ではそのまま投稿する。
   */
  async postToAll(content: Card | string, threadFor?: (channel: string) => string | undefined): Promise<{ channel: string; ts: string }[]> {
    const out: { channel: string; ts: string }[] = [];
    for (const channel of this.dmChannels.values()) {
      const threadTs = threadFor?.(channel);
      try {
        if (typeof content === 'string') {
          const res = await this.postText(channel, content, threadTs);
          out.push({ channel, ts: res.ts[0] ?? '' });
        } else {
          const res = await this.postCard(channel, content, threadTs);
          out.push({ channel, ts: res.ts });
        }
      } catch (e) {
        this.logger.error(`DM への送信に失敗 channel=${channel}`, e);
      }
    }
    return out;
  }

  // --- 添付 -----------------------------------------------------------------

  /** 添付の情報を引く（URL には期限があるので、毎回メッセージを読み直して新しいものをもらう） */
  async attachmentInfo(ref: AttachmentRef): Promise<RemoteFile> {
    this.assertAllowed(ref.chatId);
    const channel = await this.sendable(await this.locate(ref.chatId, ref.messageId, ref.threadId));
    const message = await channel.messages.fetch({ message: ref.messageId, force: true });
    const attachment = message.attachments.get(ref.attachmentId);
    if (!attachment) throw new Error(`そのメッセージに添付が見つからない: ${ref.attachmentId}`);
    return {
      id: attachment.id,
      name: attachment.name,
      size: attachment.size,
      mimetype: attachment.contentType ?? undefined,
      url: attachment.url,
    };
  }

  /** 添付を取る。Discord の CDN 以外には取りに行かない（トークンは付けない） */
  async fetchFile(file: RemoteFile, signal?: AbortSignal): Promise<Response> {
    const target = new URL(file.url);
    if (target.protocol !== 'https:' || !CDN_HOSTS.has(target.hostname)) {
      throw new Error(`Discord の CDN 以外の URL には取りに行かない: ${target.hostname}`);
    }
    const res = await this.fetchFn(target, { signal: signal ?? null });
    if (!res.ok) throw new Error(`ダウンロードに失敗 status=${res.status}`);
    return res;
  }
}
