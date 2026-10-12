import { describe, expect, it } from 'vitest';
import { buildStatusText } from '../src/status.js';

const now = new Date(2026, 9, 1, 10, 30);

describe('buildStatusText', () => {
  it('稼働時間・作業フォルダー・接続・返事待ち・許可件数・直近の hook を出す', () => {
    const text = buildStatusText({
      startedAt: new Date(2026, 9, 1, 9, 0),
      workDir: 'C:\\dev\\app',
      discordConnected: true,
      waitingSince: new Date(2026, 9, 1, 10, 25),
      pendingPermissions: 2,
      lastHooks: [
        { at: new Date(2026, 9, 1, 10, 20).getTime(), hook_event_name: 'Notification', notification_type: 'permission_prompt' },
        { at: new Date(2026, 9, 1, 10, 21).getTime(), hook_event_name: 'StopFailure', error: 'rate_limit' },
      ],
      now,
    });
    expect(text).toContain('稼働開始: 2026-10-01 09:00（1 時間 30 分 経過）');
    expect(text).toContain('作業フォルダー: C:\\dev\\app');
    expect(text).toContain('Discord 接続: 接続中');
    expect(text).toContain('返事待ち: 2026-10-01 10:25 から（5 分）');
    expect(text).toContain('回答待ちの実行許可: 2 件');
    expect(text).toContain('10:20 Notification/permission_prompt');
    expect(text).toContain('10:21 StopFailure (rate_limit)');
  });

  it('キャッシュのつなぎ止めの状態を書く（機能が無ければ書かない）', () => {
    const base = { startedAt: now, workDir: '', discordConnected: true, waitingSince: undefined, pendingPermissions: 0, lastHooks: [], now };
    expect(buildStatusText({ ...base, keepalive: { enabled: true, nextAt: new Date(2026, 9, 1, 11, 25), sent: 1, max: 6 } })).toContain(
      'キャッシュのつなぎ止め: 有効（次は 2026-10-01 11:25、送った回数 1/6）'
    );
    expect(buildStatusText({ ...base, keepalive: { enabled: false, nextAt: undefined, sent: 0, max: 6 } })).toContain('無効');
    expect(buildStatusText(base)).not.toContain('つなぎ止め');
  });

  it('待っていない・hook 無し・接続不明も書ける', () => {
    const text = buildStatusText({
      startedAt: now,
      workDir: '',
      discordConnected: undefined,
      waitingSince: undefined,
      pendingPermissions: 0,
      lastHooks: [],
      now,
    });
    expect(text).toContain('（0 分 経過）');
    expect(text).toContain('作業フォルダー: (不明)');
    expect(text).toContain('Discord 接続: (不明)');
    expect(text).toContain('返事待ち: 無し');
    expect(text).toContain('直近の hook: 無し');
  });
});
