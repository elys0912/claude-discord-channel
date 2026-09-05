// 送り先の解決（discord.ts の DiscordBridge から分けた）。会話と返信先から実際に送るチャンネルを決める。
// スレッドの中のメッセージを後で書き換えられるよう、メッセージのある場所と、ボットが関わったスレッドを覚える。
import { ChannelType } from 'discord.js';
import type { Client, NewsChannel, SendableChannels, TextChannel } from 'discord.js';
import { BoundedMap } from './bounded-map.js';
import { errMessage } from './errors.js';
import type { Logger } from './log.js';
import { truncateUnits } from './text.js';

/** スレッドの名前に使う本文の長さ */
const THREAD_NAME_MAX = 40;
/** スレッドを自動でアーカイブするまでの時間（分）。Discord が受け付ける値のうち 1 日 */
const THREAD_AUTO_ARCHIVE_MIN = 1440;
/** 覚えておくメッセージの場所・ボットが関わったスレッドの数（古いものから忘れる） */
const LOCATION_CAPACITY = 2000;
const ACTIVE_THREAD_CAPACITY = 500;
/** スレッドを作れなかった返信先の数（古いものから忘れる） */
const THREADLESS_TARGET_CAPACITY = 500;

/** 実際に送るチャンネルと、返信の参照（DM・スレッドを作れなかったときの返信先のメッセージ） */
export type SendTarget = { channel: SendableChannels; replyTo?: string };

/** スレッドの名前（本文の先頭。空なら Claude）。THREAD_NAME_MAX で切り、サロゲートペアの途中では切らない */
export function threadName(content: string): string {
  const oneLine = content.replace(/<@!?\d+>/g, '').replace(/\s+/g, ' ').trim();
  if (oneLine === '') return 'Claude';

  return truncateUnits(oneLine, THREAD_NAME_MAX);
}

/** スレッドを使わず、チャンネルの中で messageId のメッセージへの返信として送る */
function replyInChannel(channel: SendableChannels, messageId: string): SendTarget {
  return { channel, replyTo: messageId };
}

export class TargetResolver {
  private readonly client: Client;
  private readonly logger: Logger;
  /** 許可ユーザーの DM のチャンネルか（DM の一覧は DiscordBridge が持つ） */
  private readonly isDmChannel: (channelId: string) => boolean;
  /** メッセージの ID → そのメッセージのあるチャンネル（スレッドの中ならスレッドの ID） */
  private readonly locations = new BoundedMap<string>(LOCATION_CAPACITY);
  /** ボットが関わったスレッド（話しかけられた・投稿した）。古いものから忘れる */
  private readonly activeThreads = new BoundedMap<true>(ACTIVE_THREAD_CAPACITY);
  /**
   * スレッドを作れなかった返信先のメッセージ（権限不足など）。「入力中…」の出し直しなどで同じ返信先に何度も送るので、
   * 2 回目からは作ろうとせず、元のメッセージへの返信にする（失敗する API 呼び出しと警告を繰り返さない）。動いている間だけ覚える
   */
  private readonly threadlessTargets = new BoundedMap<true>(THREADLESS_TARGET_CAPACITY);

  constructor(client: Client, logger: Logger, isDmChannel: (channelId: string) => boolean) {
    this.client = client;
    this.logger = logger;
    this.isDmChannel = isDmChannel;
  }

  rememberLocation(messageId: string, channelId: string): void {
    this.locations.set(messageId, channelId);
  }

  rememberActiveThread(threadId: string): void {
    this.activeThreads.set(threadId, true);
  }

  /** そのスレッドにボットが関わっているか */
  isActiveThread(threadId: string): boolean {
    return this.activeThreads.has(threadId);
  }

  async sendable(channelId: string): Promise<SendableChannels> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error(`送信できないチャンネル: ${channelId}`);
    return channel;
  }

  /**
   * 会話と返信先から、実際に送るチャンネルと返信の参照を決める（設計書 D4）。
   * - DM: そのチャンネルに送り、threadTs のメッセージへの返信にする
   * - サーバー: threadTs のスレッドがあればそこ、無ければ threadTs のメッセージからスレッドを作る。作れなければ元メッセージへの返信
   */
  async resolveTarget(conversation: string, threadTs: string | undefined): Promise<SendTarget> {
    if (threadTs === undefined) return { channel: await this.sendable(conversation) };
    if (this.isDmChannel(conversation) || this.threadlessTargets.has(threadTs)) {
      return replyInChannel(await this.sendable(conversation), threadTs);
    }

    const existing = await this.existingThread(conversation, threadTs);
    if (existing) return { channel: existing };

    const base = await this.sendable(conversation);
    // スレッドを作れるのはテキストチャンネルとアナウンスチャンネルだけ（DM などは元メッセージへの返信にする）
    if (base.type !== ChannelType.GuildText && base.type !== ChannelType.GuildAnnouncement) return replyInChannel(base, threadTs);
    return this.startThread(base, threadTs);
  }

  /**
   * 既にあるスレッド。フォーラムの投稿もスレッドなので、親（フォーラム）に直接は送れなくても届く。
   * スレッドは許可した会話（親）の中にあるものだけ使う
   */
  private async existingThread(conversation: string, threadTs: string): Promise<SendableChannels | undefined> {
    const existing = await this.client.channels.fetch(threadTs).catch(() => null);
    if (!existing?.isThread() || !existing.isSendable() || existing.parentId !== conversation) return undefined;

    this.activeThreads.set(existing.id, true);
    return existing;
  }

  /** threadTs のメッセージからスレッドを作る（もうあればそれを使う）。作れなければ元メッセージへの返信にし、以後は作ろうとしない */
  private async startThread(base: TextChannel | NewsChannel, threadTs: string): Promise<SendTarget> {
    try {
      const origin = await base.messages.fetch(threadTs);
      const thread = origin.thread ?? (await origin.startThread({ name: threadName(origin.content), autoArchiveDuration: THREAD_AUTO_ARCHIVE_MIN }));
      this.activeThreads.set(thread.id, true);
      return { channel: thread };
    } catch (e) {
      this.logger.warn(`スレッドを作れなかったので、元のメッセージへの返信にする thread=${threadTs}`, errMessage(e));
      this.threadlessTargets.set(threadTs, true);
      return replyInChannel(base, threadTs);
    }
  }

  /**
   * メッセージのあるチャンネル。覚えていなければ、スレッドの中（threadTs があってメッセージと違う）か会話そのもの。
   * threadTs は Claude が渡す任意の値なので、許可した会話（親）の中のスレッドだと確かめられたときだけ使う
   */
  async locate(conversation: string, messageId: string, threadTs?: string): Promise<string> {
    const known = this.locations.get(messageId);
    if (known) return known;
    if (threadTs === undefined || threadTs === messageId || this.isDmChannel(conversation)) return conversation;
    const thread = await this.client.channels.fetch(threadTs).catch(() => null);
    if (thread?.isThread() && thread.parentId === conversation) return threadTs;
    return conversation;
  }
}
