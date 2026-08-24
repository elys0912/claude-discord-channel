// 「入力中…」の表示。Claude が作業している間、返信先で出し続ける。
// Discord の表示は 1 回で約 10 秒しかもたないので、間隔を空けて出し直す。止めるのは応答の終わり（hook の Stop）・
// 実行許可を聞いたとき（利用者の番になる）・!stop・上限の時間。返信を送ると表示は消えるが、作業中なら次の間隔で出し直す。
import type { DiscordBridge } from './discord.js';
import { errMessage } from './errors.js';
import type { Logger } from './log.js';

export const TYPING_INTERVAL_MS = 8_000;
export const TYPING_MAX_MS = 15 * 60_000;

export type TypingBridge = Pick<DiscordBridge, 'sendTyping'>;

interface Entry {
  timer: ReturnType<typeof setInterval>;
  startedAt: number;
}

export class TypingIndicator {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly bridge: TypingBridge,
    private readonly logger: Logger,
    private readonly intervalMs = TYPING_INTERVAL_MS,
    private readonly maxMs = TYPING_MAX_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** その返信先で出し始める（出しているなら上限の時間を延ばす） */
  start(chatId: string, threadId: string | undefined): void {
    const key = `${chatId}:${threadId ?? ''}`;
    this.stopKey(key);
    const tick = (): void => {
      const entry = this.entries.get(key);
      if (entry && this.now() - entry.startedAt >= this.maxMs) {
        this.stopKey(key);
        return;
      }
      this.bridge.sendTyping(chatId, threadId).catch((e: unknown) => {
        this.logger.debug('入力中の表示に失敗', errMessage(e));
      });
    };
    const timer = setInterval(tick, this.intervalMs);
    timer.unref?.();
    this.entries.set(key, { timer, startedAt: this.now() });
    tick();
  }

  /** すべて止める */
  stopAll(): void {
    for (const key of [...this.entries.keys()]) this.stopKey(key);
  }

  /** 出している返信先の数（テスト用） */
  get size(): number {
    return this.entries.size;
  }

  private stopKey(key: string): void {
    const entry = this.entries.get(key);
    if (entry) clearInterval(entry.timer);
    this.entries.delete(key);
  }
}
