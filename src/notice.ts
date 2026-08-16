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
