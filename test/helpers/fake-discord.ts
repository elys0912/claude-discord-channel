// DiscordBridge を差し替えるテスト用の偽物（app.test.ts で使う）。
// 本物は discord.js の Client を持つので、app.ts が使うメソッド（AppBridge）の形で置き換える。
// 受信は本物の gate、ボタンとメニューは本物の parseInteraction を通してから app.ts に渡す。
// 送ったものは calls に記録し、メッセージの ID は 9001 から順に振る。
import type { AttachmentRef, DiscordBridgeEvents, RemoteFile } from '../../src/discord.js';
import { TEXT_CHUNK_MAX } from '../../src/discord.js';
import type { AppBridge } from '../../src/app.js';
import type { Card } from '../../src/card.js';
import { chunkText } from '../../src/chunk.js';
import type { ParsedAccess } from '../../src/config.js';
import { neutralizeBroadcasts } from '../../src/format.js';
import { EventDedupe, conversationOf, forwardDelivery, gate, threadOf } from '../../src/gate.js';
import type { FileInfo, InboundMessage } from '../../src/gate.js';
import { DEFAULT_LONG_REPLY_CHARS, toLongReply } from '../../src/long-reply.js';
import { parseInteraction } from '../../src/permission.js';
import type { PresenceState } from '../../src/presence.js';
import { checkUse, parseSlashCommand, slashEcho } from '../../src/slash.js';

export const GUILD = '100000000000000001';
export const USER1 = '200000000000000001';
export const USER2 = '200000000000000002';
export const STRANGER = '299999999999999999';
export const DM1 = '300000000000000001';
export const DM2 = '300000000000000002';
export const BOT = '400000000000000001';
export const CH = '500000000000000001';
export const ACCESS: ParsedAccess = { guildId: GUILD, allowFrom: [USER1, USER2] };

export type CallMethod = 'postText' | 'postCard' | 'updateText' | 'updateCard' | 'addReaction' | 'sendFiles' | 'sendTyping';

export interface Call {
  method: CallMethod;
  channel: string;
  /** 送ったメッセージの ID（postText / postCard / sendFiles）、または書き換え・リアクションの対象 */
  ts?: string | undefined;
  threadTs?: string | undefined;
  text?: string | undefined;
  card?: Card | undefined;
  emoji?: string | undefined;
  files?: string[] | undefined;
}

/** カードの見出し・本文・コード・注記をつないで、Markdown のエスケープを外したもの（文言の確認用） */
export function cardText(card: Card | undefined): string {
  if (!card) return '';
  return [card.title, card.body, card.code, card.note]
    .filter(Boolean)
    .join('\n')
    .replace(/\\(.)/g, '$1');
}

/** カードのボタンとメニューの custom_id */
export function componentIds(card: Card | undefined): string[] {
  return [...(card?.buttons ?? []).flat().map((b) => b.id), ...(card?.select ? [card.select.id] : [])];
}

/** マイクロタスクを吐き出して非同期ハンドラの完了を待つ */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

export interface MessageOptions {
  /** 送った人（既定は USER1） */
  user?: string | undefined;
  /** メッセージの ID（既定は振った番号） */
  id?: string | undefined;
  /** チャンネル: ボットへのメンションを付けるか（既定 true） */
  mention?: boolean | undefined;
  /** チャンネル: このスレッドの中の発言にする */
  thread?: string | undefined;
  /** チャンネル: ボットの発言への返信にする */
  replyToBot?: boolean | undefined;
  /** 送ったチャンネル（既定は DM なら送った人の DM、チャンネルなら CH） */
  channel?: string | undefined;
  files?: FileInfo[] | undefined;
  /** ピン留めの知らせなど、普通の発言でないもの */
  system?: boolean | undefined;
}

export interface PressOptions {
  user?: string | undefined;
  /** 押された会話（既定は DM1） */
  conversation?: string | undefined;
  /** ボタンのあるメッセージ */
  message?: string | undefined;
  /** ボタンのメッセージがスレッドの中なら、そのスレッド */
  thread?: string | undefined;
  /** 選択メニューで選んだ値 */
  values?: string[] | undefined;
  guildId?: string | null | undefined;
}

export class FakeDiscord implements AppBridge {
  readonly calls: Call[] = [];
  readonly presence: PresenceState[] = [];
  /** 使えなかったスラッシュコマンドの理由（本人にだけ見える返事の代わり） */
  readonly ephemeral: string[] = [];
  /** 次の送信（postText / postCard / sendFiles）を失敗させる条件 */
  failPost: ((channel: string) => Error | undefined) | undefined;
  /** start() を失敗させる */
  failStart: Error | undefined;
  /** start() の中で呼ぶ（起動の途中の出来事を模す） */
  onStart: (() => void) | undefined;
  /** attachmentInfo / fetchFile で返す添付（添付の ID → 名前と中身） */
  readonly attachments = new Map<string, { name: string; body: string; mimetype?: string }>();
  started = 0;
  stopped = 0;
  longReplyChars = DEFAULT_LONG_REPLY_CHARS;

  private handlers: DiscordBridgeEvents | undefined;
  private seq = 9000;
  private readonly dedupe = new EventDedupe();
  private readonly dmChannels = new Map<string, string>();
  private readonly allowed = new Set<string>();
  private readonly activeThreads = new Set<string>();

  constructor(readonly access: ParsedAccess = ACCESS) {
    const dms = [DM1, DM2];
    access.allowFrom.forEach((user, i) => {
      const dm = dms[i];
      if (dm) {
        this.dmChannels.set(user, dm);
        this.allowed.add(dm);
      }
    });
    for (const ch of access.channels ?? []) this.allowed.add(ch);
  }

  get isConnected(): boolean {
    return this.stopped === 0;
  }

  /** 指定した種類の呼び出しだけ */
  of(method: CallMethod): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** 送った本文（postText の本文と postCard の文言） */
  texts(): string[] {
    return this.calls.flatMap((c) => (c.method === 'postText' ? [c.text ?? ''] : c.method === 'postCard' ? [cardText(c.card)] : []));
  }

  clear(): void {
    this.calls.length = 0;
  }

  // --- AppBridge ---------------------------------------------------------------

  start(handlers: DiscordBridgeEvents): Promise<void> {
    this.started += 1;
    this.onStart?.();
    if (this.failStart) return Promise.reject(this.failStart);
    this.handlers = handlers;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopped += 1;
    this.handlers = undefined;
    return Promise.resolve();
  }

  async postText(channel: string, text: string, threadTs?: string): Promise<{ ts: string[]; asFile?: boolean }> {
    this.assertAllowed(channel);
    const safe = neutralizeBroadcasts(text);
    if (safe.trim() === '') return { ts: [] };
    const long = toLongReply(safe, this.longReplyChars);
    if (long) {
      const ts = this.record({ method: 'postText', channel, threadTs, text: long.content, files: [long.name] });
      return { ts: [ts], asFile: true };
    }
    // 本物（DiscordBridge.postText）と同じく、分けた結果が空白だけになったチャンクは送らない
    const pieces = chunkText(safe, TEXT_CHUNK_MAX).filter((piece) => piece.trim() !== '');
    return { ts: pieces.map((piece) => this.record({ method: 'postText', channel, threadTs, text: piece })) };
  }

  async postCard(channel: string, card: Card, threadTs?: string): Promise<{ ts: string }> {
    this.assertAllowed(channel);
    return { ts: this.record({ method: 'postCard', channel, threadTs, card }) };
  }

  async updateText(channel: string, ts: string, text: string): Promise<void> {
    this.assertAllowed(channel);
    this.calls.push({ method: 'updateText', channel, ts, text: neutralizeBroadcasts(text) });
  }

  async updateCard(channel: string, ts: string, card: Card): Promise<void> {
    this.assertAllowed(channel);
    this.calls.push({ method: 'updateCard', channel, ts, card });
  }

  async addReaction(channel: string, ts: string, emoji: string): Promise<void> {
    this.assertAllowed(channel);
    this.calls.push({ method: 'addReaction', channel, ts, emoji });
  }

  async addReactionOrThrow(channel: string, ts: string, emoji: string): Promise<void> {
    await this.addReaction(channel, ts, emoji);
  }

  async postToAll(content: Card | string, threadFor?: (channel: string) => string | undefined): Promise<{ channel: string; ts: string }[]> {
    const out: { channel: string; ts: string }[] = [];
    for (const channel of this.dmChannels.values()) {
      try {
        if (typeof content === 'string') {
          const res = await this.postText(channel, content, threadFor?.(channel));
          out.push({ channel, ts: res.ts[0] ?? '' });
        } else {
          const res = await this.postCard(channel, content, threadFor?.(channel));
          out.push({ channel, ts: res.ts });
        }
      } catch {
        // 本物はログに残して次へ進む
      }
    }
    return out;
  }

  async sendFiles(channel: string, files: { path: string; name: string }[], text?: string, threadTs?: string): Promise<{ ts: string }> {
    this.assertAllowed(channel);
    return { ts: this.record({ method: 'sendFiles', channel, threadTs, text, files: files.map((f) => f.name) }) };
  }

  async sendTyping(channel: string, threadTs?: string): Promise<void> {
    this.assertAllowed(channel);
    this.calls.push({ method: 'sendTyping', channel, threadTs });
  }

  setPresence(state: PresenceState): void {
    this.presence.push(state);
  }

  async attachmentInfo(ref: AttachmentRef): Promise<RemoteFile> {
    this.assertAllowed(ref.chatId);
    const a = this.attachments.get(ref.attachmentId);
    if (!a) throw new Error(`そのメッセージに添付が見つからない: ${ref.attachmentId}`);
    return { id: ref.attachmentId, name: a.name, size: Buffer.byteLength(a.body), mimetype: a.mimetype, url: `https://cdn.discordapp.com/attachments/${ref.attachmentId}` };
  }

  async fetchFile(file: RemoteFile): Promise<Response> {
    const a = this.attachments.get(file.id);
    if (!a) throw new Error('ダウンロードに失敗 status=404');
    return new Response(a.body);
  }

  // --- 受信とボタン操作の模擬 ----------------------------------------------------

  /** 許可ユーザー（既定は USER1）からの DM */
  async dm(text: string, opts: MessageOptions = {}): Promise<InboundMessage> {
    const user = opts.user ?? USER1;
    const msg = this.message(text, opts, { kind: 'dm', guildId: null, channelId: opts.channel ?? this.dmChannels.get(user) ?? '399999999999999999', parentId: undefined });
    await this.receive(msg);
    return msg;
  }

  /** サーバーのチャンネル（既定は CH。opts.thread ならそのスレッドの中）での発言 */
  async channel(text: string, opts: MessageOptions = {}): Promise<InboundMessage> {
    const parent = opts.channel ?? CH;
    const mention = opts.mention ?? true;
    const body = mention ? `<@${BOT}> ${text}` : text;
    const place = opts.thread
      ? { kind: 'thread' as const, guildId: GUILD, channelId: opts.thread, parentId: parent }
      : { kind: 'channel' as const, guildId: GUILD, channelId: parent, parentId: undefined };
    const msg = this.message(body, { ...opts, mention }, place);
    await this.receive(msg);
    return msg;
  }

  /** 本物の DiscordBridge.handleMessage と同じ手順で、gate を通して app.ts に渡す */
  async receive(msg: InboundMessage): Promise<void> {
    if (!this.handlers) return;
    const result = gate(msg, {
      access: this.access,
      selfBotUserId: BOT,
      dedupe: this.dedupe,
      isKnownRequest: this.handlers.isKnownRequest,
      isActiveThread: (t) => this.activeThreads.has(t),
    });
    if (result.kind !== 'drop' && msg.kind !== 'dm') this.activeThreads.add(threadOf(msg));
    await this.handlers.onMessage(result, { channel: conversationOf(msg), ts: msg.messageId, threadTs: threadOf(msg), user: msg.authorId });
  }

  /** Gateway が回復できずに閉じたことを模す（本物の DiscordBridge が onGatewayLost を呼ぶ場面） */
  async gatewayLost(detail: string): Promise<void> {
    await this.handlers?.onGatewayLost?.(detail);
  }

  /** ボタンを押す・メニューで選ぶ（本物の DiscordBridge.handleInteraction と同じく parseInteraction を通す） */
  async press(customId: string, opts: PressOptions = {}): Promise<void> {
    if (!this.handlers) return;
    const user = opts.user ?? USER1;
    const conversation = opts.conversation ?? DM1;
    const parsed = parseInteraction(
      {
        kind: opts.values ? 'select' : 'button',
        customId,
        values: opts.values,
        guildId: opts.guildId !== undefined ? opts.guildId : conversation === CH ? GUILD : null,
        userId: user,
        conversationId: conversation,
      },
      this.access,
      this.allowed
    );
    await this.handlers.onAction(parsed, { userId: user, channelId: conversation, messageTs: opts.message ?? '8001', threadTs: opts.thread });
  }

  /**
   * スラッシュコマンドを使う（本物の DiscordBridge.answerSlash と同じく parseSlashCommand を通し、使ったことを一言返してから渡す）。
   * 使えなければ本人にだけ見える返事を ephemeral に残して何もしない
   */
  async slash(name: string, opts: PressOptions & { mode?: string | undefined; force?: boolean | undefined } = {}): Promise<void> {
    if (!this.handlers) return;
    const user = opts.user ?? USER1;
    const conversation = opts.conversation ?? DM1;
    const parsed = parseSlashCommand(
      {
        name,
        mode: opts.mode,
        force: opts.force,
        guildId: opts.guildId !== undefined ? opts.guildId : conversation === CH ? GUILD : null,
        userId: user,
        conversationId: conversation,
      },
      this.access,
      this.allowed
    );
    if (!parsed.ok) {
      this.ephemeral.push(parsed.reason);
      return;
    }
    const echo = this.record({ method: 'postText', channel: conversation, threadTs: opts.thread, text: slashEcho(parsed.command) });
    await this.handlers.onCommand?.(parsed.command, { userId: user, channelId: conversation, messageTs: echo, threadTs: opts.thread });
  }

  /**
   * 右クリックメニュー「Claude に渡す」（本物の DiscordBridge.answerForward と同じく checkUse を通し、渡したことを一言返してから渡す）。
   * target は選ばれたメッセージ。使えなければ本人にだけ見える返事を ephemeral に残して何もしない
   */
  async forward(target: InboundMessage, opts: PressOptions = {}): Promise<void> {
    if (!this.handlers) return;
    const user = opts.user ?? USER1;
    const conversation = conversationOf(target);
    const refused = checkUse({ guildId: target.guildId, userId: user, conversationId: conversation }, this.access, this.allowed);
    if (refused) {
      this.ephemeral.push(refused);
      return;
    }
    const inThread = target.kind === 'thread' ? target.channelId : undefined;
    const echo = this.record({ method: 'postText', channel: conversation, threadTs: inThread, text: `📨 Claude に渡した: ${target.messageId}` });
    const replyTo = inThread ?? echo;
    await this.handlers.onMessage(forwardDelivery(target, user, replyTo), { channel: conversation, ts: target.messageId, threadTs: replyTo, user });
  }

  /** 受信の判定を通さずに、メッセージの形だけを作る（forward の対象などに使う） */
  makeMessage(text: string, opts: MessageOptions & { kind?: 'dm' | 'channel' | 'thread' } = {}): InboundMessage {
    const kind = opts.kind ?? 'dm';
    const place =
      kind === 'dm'
        ? { kind, guildId: null, channelId: opts.channel ?? DM1, parentId: undefined }
        : kind === 'channel'
          ? { kind, guildId: GUILD, channelId: opts.channel ?? CH, parentId: undefined }
          : { kind, guildId: GUILD, channelId: opts.thread ?? '599999999999999998', parentId: opts.channel ?? CH };
    return this.message(text, opts, place);
  }

  private message(
    content: string,
    opts: MessageOptions,
    place: Pick<InboundMessage, 'kind' | 'guildId' | 'channelId' | 'parentId'>
  ): InboundMessage {
    this.seq += 1;
    return {
      ...place,
      messageId: opts.id ?? String(this.seq),
      authorId: opts.user ?? USER1,
      authorIsBot: false,
      isUserMessage: !opts.system,
      content,
      mentionsBot: place.kind !== 'dm' && (opts.mention ?? false),
      repliesToBot: opts.replyToBot ?? false,
      createdAt: '2026-10-12T00:00:00.000Z',
      files: opts.files,
    };
  }

  private assertAllowed(channel: string): void {
    if (!this.allowed.has(channel)) throw new Error('許可されていない送信先チャンネル');
  }

  private record(call: Omit<Call, 'ts'>): string {
    const error = this.failPost?.(call.channel);
    if (error) throw error;
    this.seq += 1;
    const ts = String(this.seq);
    this.calls.push({ ...call, ts });
    // サーバーのチャンネルでスレッドに送ったら、そのスレッドはボットが関わったものになる
    if (call.threadTs !== undefined && !this.isDm(call.channel)) this.activeThreads.add(call.threadTs);
    return ts;
  }

  private isDm(channel: string): boolean {
    return [...this.dmChannels.values()].includes(channel);
  }
}
