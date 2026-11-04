// hook の記録（hooks.jsonl）・使用量の記録（usage.json）・想定外の終了の記録（crash.json）からの知らせのテスト。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DM1, DM2, cardText, componentIds, flush } from './helpers/fake-discord.js';
import type { Call } from './helpers/fake-discord.js';
import { fakeConsole } from './helpers/fake-console.js';
import { closeHarness, sendPermissionRequest, startHarness, useHarness } from './helpers/app-harness.js';
import type { Harness } from './helpers/app-harness.js';

/**
 * ここまでに hooks.jsonl に書いた行を、ブリッジが読み終えるまで待つ。必ず知らせる行（目印）を書き足し、その投稿が届くのを待つ。
 * 行は書いた順に処理されるので、目印が届いた時点でそれより前の行は処理済み。目印の投稿は calls から取り除く
 */
async function drainHooks(h: Harness, file: string, fields: Record<string, unknown> = {}): Promise<void> {
  const marker = `drain-${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(file, JSON.stringify({ at: Date.now(), hook_event_name: 'StopFailure', error_details: marker, ...fields }) + '\n');
  const isMarker = (c: Call) => cardText(c.card).includes(marker);
  await vi.waitFor(() => expect(h.discord.calls.some(isMarker)).toBe(true));
  for (let i = h.discord.calls.length - 1; i >= 0; i--) {
    const call = h.discord.calls[i];
    if (call && isMarker(call)) h.discord.calls.splice(i, 1);
  }
}

describe('hook の記録（hooks.jsonl）からの知らせ', () => {
  let dir: string;
  let file: string;
  const hookLine = (fields: Record<string, unknown>) => JSON.stringify({ at: Date.now(), session_id: 's1', ...fields }) + '\n';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-hooks-'));
    file = path.join(dir, 'hooks.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const h = useHarness(() => ({
    hookInboxFile: file,
    hookPollMs: 20,
    console: fakeConsole(),
  }));
  const cards = () => h.discord.of('postCard');

  it('ターミナル側の許可待ちは、画面を確認するボタン付きのカードで許可ユーザー全員の DM に出す', async () => {
    fs.appendFileSync(file, hookLine({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs permission' }));
    await vi.waitFor(() => expect(cards().map((c) => c.channel)).toEqual([DM1, DM2]));
    expect(cardText(cards()[0]?.card)).toContain('ターミナル側で入力待ち');
    expect(cards()[0]?.card?.color).toBe('warn');
    expect(componentIds(cards()[0]?.card)).toEqual(['scr:show']);
  });

  it('話しかけられた後は、その返信先に出す', async () => {
    await h.discord.dm('hello', { id: '7000' });
    await flush();
    h.discord.clear();
    fs.appendFileSync(file, hookLine({ hook_event_name: 'StopFailure', error: 'rate_limit' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]).toMatchObject({ channel: DM1, threadTs: '7000' });
    expect(cardText(cards()[0]?.card)).toContain('使用量の上限');
    expect(cards()[0]?.card?.color).toBe('error');
  });

  it('Discord に中継中の許可があるときは、ターミナル側の許可待ちを重ねて知らせない', async () => {
    await sendPermissionRequest(h.client);
    h.discord.clear();
    fs.appendFileSync(file, hookLine({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }));
    await drainHooks(h, file);
    expect(cards()).toEqual([]);
  });

  it('Stop は Discord への返事が無いときだけ知らせ、入力中の表示を止める', async () => {
    fs.appendFileSync(file, hookLine({ hook_event_name: 'Stop' }));
    await drainHooks(h, file);
    expect(cards()).toEqual([]);

    await h.discord.dm('hello', { id: '7100' });
    await flush();
    h.discord.clear();
    fs.appendFileSync(file, hookLine({ hook_event_name: 'Stop' }));
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(cardText(cards()[0]?.card)).toContain('返事をしないまま');
  });

  it('セッションの開始は緑のカードで知らせる', async () => {
    fs.appendFileSync(file, hookLine({ hook_event_name: 'SessionStart', source: 'startup', cwd: 'C:\\dev' }));
    await vi.waitFor(() => expect(cards().length).toBeGreaterThan(0));
    expect(cardText(cards()[0]?.card)).toContain('セッションを開始した: C:\\dev');
    expect(cards()[0]?.card?.color).toBe('ok');
  });
});

describe('自分のセッションの hook だけ扱う（session_tag）と、!restart で同じ会話を開き直す（session_id）', () => {
  let dir: string;
  let file: string;
  let flag: string;
  const hookLine = (fields: Record<string, unknown>) => JSON.stringify({ at: Date.now(), ...fields }) + '\n';
  const MINE = 'c2097ecd-29b0-4cee-9f3e-a9aeace64bc3';
  const OTHER = '0d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-tag-'));
    file = path.join(dir, 'hooks.jsonl');
    flag = path.join(dir, 'restart.flag');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const h = useHarness(() => ({
    hookInboxFile: file,
    hookPollMs: 20,
    sessionTag: 'tag-mine',
    restartFlagFile: flag,
    console: fakeConsole({ screen: '❯ ' }),
  }));

  beforeEach(() => {
    h.discord.clear();
  });

  it('タグが違う・無い行は知らせない。同じタグの行だけ知らせる', async () => {
    fs.appendFileSync(
      file,
      hookLine({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit', session_id: OTHER, session_tag: 'tag-other' }) +
        hookLine({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit', session_id: OTHER })
    );
    // 目印も自分のタグで書く（タグが違えば目印も届かない）
    await drainHooks(h, file, { session_tag: 'tag-mine' });
    expect(h.discord.of('postCard')).toEqual([]);

    fs.appendFileSync(file, hookLine({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit', session_id: MINE, session_tag: 'tag-mine' }));
    await vi.waitFor(() => expect(h.discord.of('postCard').length).toBeGreaterThan(0));
  });

  it('!restart の印に、自分のタグの行で最後に見た session_id を書く（別のタグの id は使わない）', async () => {
    fs.appendFileSync(
      file,
      hookLine({ hook_event_name: 'SessionStart', source: 'startup', session_id: MINE, session_tag: 'tag-mine' }) +
        hookLine({ hook_event_name: 'SessionStart', source: 'startup', session_id: OTHER, session_tag: 'tag-other' })
    );
    // 目印は session_id 無しで書く（覚えている id を上書きしない）
    await drainHooks(h, file, { session_tag: 'tag-mine' });

    await h.discord.dm('!restart');
    await flush();
    const written = JSON.parse(fs.readFileSync(flag, 'utf8')) as { sessionId?: string };
    expect(written.sessionId).toBe(MINE);
  });

  it('session_id がまだ分からなければ、印に id を書かない（start.ps1 は新しい会話にする）', async () => {
    await h.discord.dm('!restart');
    await flush();
    const written = JSON.parse(fs.readFileSync(flag, 'utf8')) as Record<string, unknown>;
    expect(written).not.toHaveProperty('sessionId');
  });
});

describe('使用量の見張りと、想定外の終了からの起動し直しの知らせ', () => {
  // 起動する前に記録のファイルを置くので、useHarness ではなく各テストで起動する
  let h: Harness | undefined;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-usage-'));
  });

  afterEach(async () => {
    if (h) await closeHarness(h);
    h = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('起動時に crash.json があれば知らせて消す', async () => {
    const crashFile = path.join(dir, 'crash.json');
    fs.writeFileSync(crashFile, JSON.stringify({ at: Date.now(), exit_code: 1, count: 1, max: 3, window_min: 10, resumed: true }));
    const started = await startHarness({ crashFile });
    h = started;

    expect(started.discord.texts().some((t) => t.includes('想定外に終了した（exit code 1）'))).toBe(true);
    expect(fs.existsSync(crashFile)).toBe(false);
  });

  it('usage.json の使用量がしきい値を越えたら知らせ、!status に使用量の行を出す', async () => {
    const file = path.join(dir, 'usage.json');
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), five_hour: { used: 85, resets_at: resetsAt } }));
    const started = await startHarness({
      usageWatch: { file, usageWarnPct: [80, 95], contextWarnPct: [70, 90], pollMs: 10 },
    });
    h = started;

    await vi.waitFor(() => expect(started.discord.texts().some((t) => t.includes('使用量（5 時間枠）が 85%'))).toBe(true));
    await started.discord.dm('!status');
    await flush();
    expect(started.discord.texts().at(-1)).toContain('使用量: 5 時間枠 85%');
  });
});
