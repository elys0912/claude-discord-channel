import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoCompact, takeQuietStart } from '../src/auto-compact.js';
import type { AutoCompactOptions } from '../src/auto-compact.js';
import type { HookEvent } from '../src/hook-event.js';
import { Logger } from '../src/log.js';
import { MS_PER_MINUTE } from '../src/text.js';
import { useTempDir } from './helpers/temp-dir.js';

const IDLE_MS = 30 * MS_PER_MINUTE;
/** 圧縮の知らせから /exit を送るまでの間（auto-compact.ts の RESTART_DELAY_MS）を越える時間 */
const AFTER_RESTART_DELAY_MS = 6000;

const hook = (hook_event_name: string, extra: Partial<HookEvent> = {}): HookEvent => ({ at: Date.now(), hook_event_name, ...extra });

describe('AutoCompact', () => {
  const tempDir = useTempDir('auto-compact-test-');
  let context: number | undefined;
  let busy: boolean;
  let calls: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    context = 70;
    busy = false;
    calls = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function create(overrides: Partial<AutoCompactOptions> = {}): AutoCompact {
    return new AutoCompact({
      minPct: 70,
      idleMs: IDLE_MS,
      contextUsed: () => context,
      isBusy: () => busy,
      compact: () => {
        calls.push('compact');
        return Promise.resolve();
      },
      restart: () => {
        calls.push('restart');
        return Promise.resolve();
      },
      quietStartFile: path.join(tempDir(), 'quiet-start.flag'),
      quietStart: false,
      logger: new Logger({ stderr: false }),
      ...overrides,
    });
  }

  it('コンテキストが 70% で応答の終わりから 30 分無操作なら /compact を送る', async () => {
    const auto = create();
    auto.requestEnded(Date.now());

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['compact']);
  });

  it('コンテキストが 69% なら送らない', async () => {
    context = 69;
    const auto = create();
    auto.requestEnded(Date.now());

    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(calls).toEqual([]);
  });

  it('待っている間にメッセージを中継したら送らない', async () => {
    const auto = create();
    auto.requestEnded(Date.now());
    await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
    auto.activity();

    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(calls).toEqual([]);
  });

  it('自動の圧縮の知らせと終了の知らせを黙らせ、圧縮の後に印を置いて起動し直す', async () => {
    const auto = create();
    auto.requestEnded(Date.now());
    await vi.advanceTimersByTimeAsync(IDLE_MS);

    expect(auto.silence(hook('PostCompact', { trigger: 'manual' }))).toBe(true);
    await vi.advanceTimersByTimeAsync(AFTER_RESTART_DELAY_MS);
    expect(calls).toEqual(['compact', 'restart']);
    expect(fs.existsSync(path.join(tempDir(), 'quiet-start.flag'))).toBe(true);
    expect(auto.silence(hook('SessionEnd', { reason: 'prompt_input_exit' }))).toBe(true);
  });

  it('圧縮の後に手元で入力があれば起動し直さない', async () => {
    const auto = create();
    auto.requestEnded(Date.now());
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    auto.silence(hook('PostCompact'));
    auto.activity();

    await vi.advanceTimersByTimeAsync(AFTER_RESTART_DELAY_MS);
    expect(calls).toEqual(['compact']);
  });

  it('手動の圧縮と終了の知らせは黙らせない', () => {
    const auto = create();

    expect(auto.silence(hook('PostCompact'))).toBe(false);
    expect(auto.silence(hook('SessionEnd'))).toBe(false);
  });

  it('自動の起動し直しで始まったブリッジは、最初の開始の知らせだけを黙らせる', () => {
    const auto = create({ quietStart: true });

    expect(auto.silence(hook('SessionStart', { source: 'clear' }))).toBe(false);
    expect(auto.silence(hook('SessionStart', { source: 'resume' }))).toBe(true);
    expect(auto.silence(hook('SessionStart', { source: 'resume' }))).toBe(false);
  });
});

describe('takeQuietStart', () => {
  const tempDir = useTempDir('quiet-start-test-');

  // ファイルの時刻と Date.now() は時計の粒度がずれるので、書いた時刻を基準にする
  function writeFlag(): { file: string; writtenAt: number } {
    const file = path.join(tempDir(), 'quiet-start.flag');
    fs.writeFileSync(file, '');
    return { file, writtenAt: fs.statSync(file).mtimeMs };
  }

  it('書いてから 3 分未満の印なら true を返して消す', () => {
    const { file, writtenAt } = writeFlag();

    expect(takeQuietStart(file, writtenAt + 3 * MS_PER_MINUTE - 1)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('3 分たった印は false（起動し直しに失敗して残った印で、後の手動の再起動を黙らせない）', () => {
    const { file, writtenAt } = writeFlag();

    expect(takeQuietStart(file, writtenAt + 3 * MS_PER_MINUTE)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('印が無ければ false', () => {
    expect(takeQuietStart(path.join(tempDir(), 'quiet-start.flag'))).toBe(false);
  });
});
