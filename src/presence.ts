// ボットのステータス表示（presence）。メンバー一覧で、Claude が今どうしているかが分かるようにする。
// 状態は数秒ごとに組み立て直し、変わっていたら表示を変える。Discord の更新回数の制限に当たらないよう、
// 変えるのは最小の間隔ごとに 1 回まで（その間の変化は、最後の状態だけを反映する）。
import { errMessage } from './errors.js';
import type { Logger } from './log.js';

export type PresenceState = 'idle' | 'working' | 'waiting_permission' | 'limited';

export interface PresenceInputs {
  /** 使用量の上限に当たっている */
  limited: boolean;
  /** 回答待ちの実行許可の件数 */
  pendingPermissions: number;
  /** Claude がターンの途中 */
  working: boolean;
}

/** 状態を決める。上から順に優先する */
export function decidePresence(i: PresenceInputs): PresenceState {
  if (i.limited) return 'limited';
  if (i.pendingPermissions > 0) return 'waiting_permission';
  if (i.working) return 'working';
  return 'idle';
}

/** 状態ごとの Discord の表示（オンライン状態と、名前の下に出る一言） */
export const PRESENCE_VIEW: Record<PresenceState, { status: 'online' | 'idle' | 'dnd'; text: string }> = {
  idle: { status: 'online', text: '待機中' },
  working: { status: 'online', text: '作業中' },
  waiting_permission: { status: 'idle', text: '実行許可待ち' },
  limited: { status: 'dnd', text: '使用量の上限' },
};

export const PRESENCE_POLL_MS = 5_000;
export const PRESENCE_MIN_INTERVAL_MS = 15_000;

export interface PresenceUpdaterOptions {
  inputs: () => PresenceInputs;
  apply: (state: PresenceState) => void | Promise<void>;
  logger: Logger;
  pollMs?: number | undefined;
  minIntervalMs?: number | undefined;
  now?: () => number;
}

export class PresenceUpdater {
  private readonly opts: PresenceUpdaterOptions;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private shown: PresenceState | undefined;
  private lastAppliedAt = Number.NEGATIVE_INFINITY;

  constructor(opts: PresenceUpdaterOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs ?? PRESENCE_POLL_MS);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 今の状態を組み立て、変わっていて最小の間隔を過ぎていれば表示を変える。投げない */
  async tick(): Promise<void> {
    const next = decidePresence(this.opts.inputs());
    if (next === this.shown) return;
    if (this.now() - this.lastAppliedAt < (this.opts.minIntervalMs ?? PRESENCE_MIN_INTERVAL_MS)) return;
    this.shown = next;
    this.lastAppliedAt = this.now();
    try {
      await this.opts.apply(next);
    } catch (e) {
      this.opts.logger.warn('ステータス表示の更新に失敗', errMessage(e));
    }
  }
}
