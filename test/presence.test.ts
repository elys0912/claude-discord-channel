import { describe, expect, it } from 'vitest';
import { Logger } from '../src/log.js';
import { PresenceUpdater, decidePresence } from '../src/presence.js';
import type { PresenceInputs, PresenceState } from '../src/presence.js';

describe('decidePresence', () => {
  it('上限 > 実行許可待ち > 作業中 > 待機中 の順に優先する', () => {
    expect(decidePresence({ limited: true, pendingPermissions: 1, working: true })).toBe('limited');
    expect(decidePresence({ limited: false, pendingPermissions: 1, working: true })).toBe('waiting_permission');
    expect(decidePresence({ limited: false, pendingPermissions: 0, working: true })).toBe('working');
    expect(decidePresence({ limited: false, pendingPermissions: 0, working: false })).toBe('idle');
  });
});

describe('PresenceUpdater', () => {
  it('変わったときだけ表示を変え、最小の間隔の間は最後の状態をあとで反映する', async () => {
    let t = 0;
    let inputs: PresenceInputs = { limited: false, pendingPermissions: 0, working: false };
    const applied: PresenceState[] = [];
    const u = new PresenceUpdater({
      inputs: () => inputs,
      apply: (s) => void applied.push(s),
      logger: new Logger({ stderr: false }),
      minIntervalMs: 15_000,
      now: () => t,
    });

    await u.tick();
    expect(applied).toEqual(['idle']);
    await u.tick();
    expect(applied).toEqual(['idle']);

    t = 5_000;
    inputs = { ...inputs, working: true };
    await u.tick();
    expect(applied).toEqual(['idle']); // 間隔が足りない
    t = 10_000;
    inputs = { ...inputs, pendingPermissions: 1 };
    await u.tick();
    t = 15_000;
    await u.tick();
    expect(applied).toEqual(['idle', 'waiting_permission']); // 途中の working は飛ばして最後の状態
  });

  it('表示の更新に失敗しても投げない', async () => {
    const u = new PresenceUpdater({
      inputs: () => ({ limited: false, pendingPermissions: 0, working: false }),
      apply: () => Promise.reject(new Error('x')),
      logger: new Logger({ stderr: false }),
    });
    await expect(u.tick()).resolves.toBeUndefined();
  });
});
