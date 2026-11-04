// ブリッジからの知らせ（hook の通知・状態）を Discord に出す。
// 宛先は最後に話しかけられたスレッド。まだ無ければ許可ユーザー全員の DM。投げない。
import type { Card, CardColor } from './card.js';
import { md } from './card.js';
import type { DiscordBridge } from './discord.js';
import type { Logger } from './log.js';
import type { ThreadRef } from './types.js';

export type NoticeBridge = Pick<DiscordBridge, 'postCard' | 'postToAll'>;

/** 1 行の知らせのカード。本文は Markdown として解釈させない */
export function textCard(text: string, color: CardColor = 'info'): Card {
  return { color, body: md(text) };
}

/**
 * ボタンを押されたメッセージを、結果を知らせる 1 行のカードに書き換える。
 * 失敗しても投げず、failureLog をログに残す（結果の表示が出ないだけで、操作そのものは済んでいるため）
 */
export async function rewriteAsTextCard(
  deps: { bridge: Pick<DiscordBridge, 'updateCard'>; logger: Logger },
  message: { channel: string; ts: string },
  text: string,
  color: CardColor,
  failureLog: string
): Promise<void> {
  await deps.bridge.updateCard(message.channel, message.ts, textCard(text, color)).catch((e: unknown) => {
    deps.logger.warn(failureLog, e);
  });
}

export class NoticePoster {
  private readonly bridge: NoticeBridge;
  private readonly threadOf: () => ThreadRef | undefined;
  private readonly logger: Logger;

  constructor(bridge: NoticeBridge, threadOf: () => ThreadRef | undefined, logger: Logger) {
    this.bridge = bridge;
    this.threadOf = threadOf;
    this.logger = logger;
  }

  /** text を知らせる。card を省略すれば text だけのカードにする */
  async post(text: string, card?: Card): Promise<void> {
    const view = card ?? textCard(text);
    const thread = this.threadOf();
    try {
      if (thread) {
        await this.bridge.postCard(thread.channel, view, thread.threadTs);
      } else {
        await this.bridge.postToAll(view);
      }
    } catch (e) {
      this.logger.warn('知らせの投稿に失敗', e);
    }
  }
}
