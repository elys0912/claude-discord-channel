// 無操作が続いたときのコンテキストの自動圧縮と起動し直し。
// Claude の応答が終わってから idleMs の間操作が無く、コンテキストが minPct 以上なら /compact を送る。
// 圧縮が終わってもまだ無操作なら、!restart と同じ手順で同じ会話のまま起動し直す（claude.exe のメモリを戻すため）。
// 自動の操作は Discord に知らせない。圧縮・終了の知らせを黙らせ、起動し直した先のブリッジには
// 状態ディレクトリの quiet-start.flag で「開始の知らせを出さない」ことを伝える。失敗もログだけに残す。
import fs from 'node:fs';

import type { HookEvent } from './hook-event.js';
import type { Logger } from './log.js';
import { MS_PER_MINUTE } from './text.js';

export const DEFAULT_AUTO_COMPACT_PCT = 70;
/** キャッシュの期限（60 分）とつなぎ止めの合図（55 分）より前に圧縮し、キャッシュが残っているうちに安く読ませる */
export const DEFAULT_AUTO_COMPACT_IDLE_MIN = 30;

/** 起動し直した先のブリッジに開始の知らせを黙らせる印（状態ディレクトリ） */
export const QUIET_START_FILE = 'quiet-start.flag';
/**
 * 印を有効とみなす時間。/exit から終了を諦めるまでの 60 秒（session-control.ts の EXIT_GIVE_UP_MS）に起動の時間を足した値。
 * 起動し直しに失敗して印が残っても、後の手動の再起動の知らせまで黙らせないため
 */
const QUIET_START_VALID_MS = 3 * MS_PER_MINUTE;
/** 圧縮の知らせ（PostCompact）から /exit を送るまでの間。圧縮の直後は画面の描き直しで入力欄が空に見えないことがある */
const RESTART_DELAY_MS = 5000;

/** quiet-start.flag を読んで消す。新しい印があれば true */
export function takeQuietStart(file: string, now: number = Date.now()): boolean {
  let writtenAt: number;
  try {
    writtenAt = fs.statSync(file).mtimeMs;
    fs.rmSync(file, { force: true });
  } catch {
    return false;
  }

  return now - writtenAt < QUIET_START_VALID_MS;
}

export interface AutoCompactOptions {
  minPct: number;
  idleMs: number;
  /** 今の会話のコンテキストの使用率（%）。分からなければ undefined */
  contextUsed: () => number | undefined;
  /** 作業中・回答待ちなど、操作してはいけない状態か */
  isBusy: () => boolean;
  /** /compact を送る（入力欄が空でなければ送らない。結果は知らせずログに残す） */
  compact: () => Promise<void>;
  /** 同じ会話のまま起動し直す（同上） */
  restart: () => Promise<void>;
  /** 起動し直した先のブリッジに渡す印 */
  quietStartFile: string;
  /** 起動したときに印があった（このブリッジは自動の起動し直しで始まった） */
  quietStart: boolean;
  logger: Logger;
  now?: () => number;
}

export class AutoCompact {
  private readonly opts: AutoCompactOptions;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** /compact を送り、圧縮の知らせを待っている */
  private compactPending = false;
  /** /exit を送った（終了の知らせを黙らせる） */
  private restarting = false;
  /** 次の開始の知らせを黙らせる */
  private quietStart: boolean;

  constructor(opts: AutoCompactOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.quietStart = opts.quietStart;
  }

  /** Claude の応答が終わった（hook の Stop / StopFailure）。そこから idleMs 後に確かめる */
  requestEnded(at: number): void {
    this.reset();
    this.timer = setTimeout(() => void this.fire(), Math.max(0, at + this.opts.idleMs - this.now()));
    this.timer.unref?.();
  }

  /** メッセージの中継・手元の入力。予定と、圧縮の後の起動し直しを取り消す */
  activity(): void {
    this.reset();
  }

  /** hook の知らせを Discord に出さずに黙らせるか。自動の操作による圧縮・終了・開始なら true */
  silence(event: HookEvent): boolean {
    switch (event.hook_event_name) {
      case 'PostCompact':
        return this.compacted();
      case 'SessionEnd':
        return this.restarting;
      case 'SessionStart':
        if (event.source !== 'startup' && event.source !== 'resume') return false;
        if (!this.quietStart) return false;
        this.quietStart = false;
        return true;
      default:
        return false;
    }
  }

  stop(): void {
    this.reset();
  }

  private reset(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.compactPending = false;
    this.restarting = false;
  }

  private async fire(): Promise<void> {
    this.timer = undefined;
    const used = this.opts.contextUsed();
    if (used === undefined || used < this.opts.minPct) return;
    if (this.opts.isBusy()) {
      this.opts.logger.info('自動圧縮をしない（作業中か回答待ち）');
      return;
    }

    this.opts.logger.info(`コンテキスト ${Math.round(used)}% で無操作が続いたので /compact を送る`);
    this.compactPending = true;
    await this.opts.compact();
  }

  /** 圧縮が終わった。自動で送った圧縮なら、続けて起動し直す予定を立てて true */
  private compacted(): boolean {
    if (!this.compactPending) return false;

    this.compactPending = false;
    this.timer = setTimeout(() => void this.restart(), RESTART_DELAY_MS);
    this.timer.unref?.();
    return true;
  }

  private async restart(): Promise<void> {
    this.timer = undefined;
    if (this.opts.isBusy()) {
      this.opts.logger.info('自動の起動し直しをしない（作業中か回答待ち）');
      return;
    }

    try {
      fs.writeFileSync(this.opts.quietStartFile, '');
    } catch (e) {
      this.opts.logger.warn('quiet-start.flag を書けなかった（起動し直した先で開始を知らせる）', e);
    }
    this.opts.logger.info('自動圧縮の後、同じ会話のまま起動し直す');
    this.restarting = true;
    await this.opts.restart();
  }
}
