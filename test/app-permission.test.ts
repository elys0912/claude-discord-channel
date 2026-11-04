// 実行許可まわりの設定（保存済みのルールの知らせ・今後も許可・このセッション中は全部許可）のテスト。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardText, componentIds, flush } from './helpers/fake-discord.js';
import { closeHarness, sendBash, startHarness, useHarness, verdicts } from './helpers/app-harness.js';
import type { Harness } from './helpers/app-harness.js';

describe('起動時の、今の方式では作れない保存済みのルールの知らせ（D-SD-03）', () => {
  let h: Harness | undefined;
  let dir: string;
  let file: string;
  const notices = (): string[] => (h?.discord.texts() ?? []).filter((t) => t.includes('作れないルール'));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-rejected-'));
    file = path.join(dir, 'allow-extra.json');
  });

  afterEach(async () => {
    if (h) await closeHarness(h);
    h = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('前の方式で足したルールがあれば、件数と一覧を知らせる。allow-extra.json は書き換えない', async () => {
    const saved = JSON.stringify({ allow: ['Bash(git status)', 'Bash(git log:*)', 'WebFetch'] });
    fs.writeFileSync(file, saved);
    h = await startHarness({ allowExtraFile: file });
    await flush();

    const notice = notices()[0] ?? '';
    expect(notice).toContain('2 件');
    expect(notice).toContain('git log');
    expect(notice).toContain('WebFetch');
    expect(notice).not.toContain('git status');
    expect(fs.readFileSync(file, 'utf8')).toBe(saved);
  });

  it('作れないルールが無ければ知らせない', async () => {
    fs.writeFileSync(file, JSON.stringify({ allow: ['Bash(git status)'] }));
    h = await startHarness({ allowExtraFile: file });
    await flush();
    expect(notices()).toEqual([]);
  });
});

describe('今後も許可（allow-extra.json への追記と、deny との突き合わせ）', () => {
  let dir: string;
  let denyFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-always-'));
    denyFile = path.join(dir, 'settings.json');
    fs.writeFileSync(denyFile, JSON.stringify({ permissions: { deny: ['Bash(pwd -P:*)'] } }));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const h = useHarness(() => ({
    allowExtraFile: path.join(dir, 'allow-extra.json'),
    denyFiles: [denyFile],
  }));

  it('今後も許可: 今回は許可し、確認のうえ allow-extra.json に書き込む', async () => {
    await sendBash(h.client, 'git status');
    const posted = h.discord.of('postCard')[0]?.ts;
    h.discord.clear();

    await h.discord.press('perm:always:abcde', { message: posted });
    await flush();

    expect(verdicts(h)).toEqual([{ request_id: 'abcde', behavior: 'allow' }]);
    const proposal = h.discord.of('postCard').find((c) => cardText(c.card).includes('Bash(git status)'));
    const add = componentIds(proposal?.card).find((id) => id.startsWith('rule:add:'));
    expect(add).toBeDefined();

    await h.discord.press(add ?? '', { message: proposal?.ts });
    await flush();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'allow-extra.json'), 'utf8'))).toEqual({ allow: ['Bash(git status)'] });
  });

  it('今後も許可: deny に当たるなら、今回は許可したうえで追加しない旨と当たった deny を知らせる', async () => {
    // 候補は Bash(pwd)。deny の Bash(pwd -P:*) と範囲が重なる
    await sendBash(h.client, 'pwd');
    h.discord.clear();

    await h.discord.press('perm:always:abcde');
    await flush();

    expect(verdicts(h)).toEqual([{ request_id: 'abcde', behavior: 'allow' }]);
    const notice = h.discord.texts().find((t) => t.includes('deny に当たる'));
    expect(notice).toContain('Bash(pwd -P:*)');
    expect(fs.existsSync(path.join(dir, 'allow-extra.json'))).toBe(false);
  });
});

describe('このセッション中は全部許可', () => {
  let h: Harness;
  let dir: string;
  let hooks: string;
  const cards = () => h.discord.of('postCard');

  interface StartOptions {
    /** 全部許可を有効にできるボットか */
    sessionAllowAll: boolean;
    /** managed settings のファイルの中身（省略時はファイルを置かない） */
    managed?: string;
  }

  async function start({ sessionAllowAll, managed }: StartOptions): Promise<void> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-allowall-'));
    const settings = path.join(dir, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ permissions: { ask: ['Bash(git push:*)'], deny: ['Bash(rm:*)', 'Read(.env)', 'Read(~/.ssh/**)'] } }));
    const managedFile = path.join(dir, 'managed-settings.json');
    if (managed !== undefined) fs.writeFileSync(managedFile, managed);
    hooks = path.join(dir, 'hooks.jsonl');
    h = await startHarness({
      denyFiles: [settings],
      managedSettingsFiles: () => [managedFile],
      sessionAllowAll,
      hookInboxFile: hooks,
      hookPollMs: 20,
    });
    // 自動許可の記録を出す返信先を覚えさせる
    await h.discord.dm('作業して', { id: '2000' });
    await flush();
    h.discord.clear();
  }

  afterEach(async () => {
    await closeHarness(h);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 全部許可のボタンを押して有効にする。ボタンが出ることは「ボタンで有効にすると」のテストで確かめる */
  async function enableByButton(): Promise<void> {
    await sendBash(h.client, 'git status');
    if (!componentIds(cards()[0]?.card).includes('perm:session:abcde')) throw new Error('前提が崩れた: 全部許可のボタンが出ていない');
    await h.discord.press('perm:session:abcde', { message: cards()[0]?.ts });
    await flush();
    h.discord.clear();
  }

  it('無効なボットにはボタンを出さない', async () => {
    await start({ sessionAllowAll: false });
    await sendBash(h.client, 'git status');
    expect(componentIds(cards()[0]?.card)).not.toContain('perm:session:abcde');
  });

  it('ボタンで有効にすると、今回を許可し、以後は ask 以外をボタン無しで許可して記録する', async () => {
    await start({ sessionAllowAll: true });
    // enableByButton と同じ手順を、ボタンが出ることの確認を挟んで書く
    await sendBash(h.client, 'git status');
    expect(componentIds(cards()[0]?.card)).toContain('perm:session:abcde');
    await h.discord.press('perm:session:abcde', { message: cards()[0]?.ts });
    await flush();
    h.discord.clear();
    expect(verdicts(h)).toEqual([{ request_id: 'abcde', behavior: 'allow' }]);

    await sendBash(h.client, 'npm test', 'fghij');
    expect(verdicts(h).at(-1)).toEqual({ request_id: 'fghij', behavior: 'allow' });
    expect(cards()).toHaveLength(1);
    expect(cardText(cards()[0]?.card)).toContain('自動許可: Bash');
    expect(cards()[0]?.threadTs).toBe('2000');
    expect(componentIds(cards()[0]?.card)).toEqual([]);
  });

  it('deny は照合しない（Claude Code が確認の前に止めるため）。範囲付きの Read の deny があっても、別の場所の Read は自動許可する', async () => {
    await start({ sessionAllowAll: true });
    await enableByButton();

    await h.client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: { request_id: 'fghij', tool_name: 'Read', description: 'read', input_preview: JSON.stringify({ file_path: 'C:\\dev\\other\\a.ts' }) },
    });
    await flush();
    expect(verdicts(h).at(-1)).toEqual({ request_id: 'fghij', behavior: 'allow' });
    expect(cardText(cards()[0]?.card)).toContain('自動許可: Read');
  });

  it('有効でも、settings の ask に当たるものはボタンで聞く（全部許可のボタンはもう出さない）', async () => {
    await start({ sessionAllowAll: true });
    await enableByButton();

    await sendBash(h.client, 'git push origin main', 'fghij');
    expect(verdicts(h)).toHaveLength(1);
    // git push は許可リストに無いので「今後も許可」も出さない
    expect(componentIds(cards()[0]?.card)).toEqual(['perm:allow:fghij', 'perm:deny:fghij']);
  });

  it('managed settings の ask に当たるものも、ボタンで聞く', async () => {
    await start({ sessionAllowAll: true, managed: JSON.stringify({ permissions: { ask: ['Bash(npm publish:*)'] } }) });
    await enableByButton();

    await sendBash(h.client, 'cd pkg && npm publish', 'fghij');
    expect(verdicts(h)).toHaveLength(1);
    expect(componentIds(cards()[0]?.card)).toContain('perm:allow:fghij');
  });

  it('managed settings が読めない（JSON でない）ときは、全部許可のボタンを出さない', async () => {
    await start({ sessionAllowAll: true, managed: '{ broken' });
    await sendBash(h.client, 'git status');
    expect(componentIds(cards()[0]?.card)).not.toContain('perm:session:abcde');
  });

  it('!lock で解除すると、またボタンで聞く', async () => {
    await start({ sessionAllowAll: true });
    await enableByButton();

    await h.discord.dm('!lock');
    await flush();
    expect(h.discord.texts().at(-1)).toContain('解除した');

    h.discord.clear();
    await sendBash(h.client, 'npm test', 'fghij');
    expect(verdicts(h)).toHaveLength(1);
    expect(componentIds(cards()[0]?.card)).toContain('perm:session:fghij');
  });

  it('!clear などで新しい会話になったら（SessionStart source=clear）解除する', async () => {
    await start({ sessionAllowAll: true });
    await enableByButton();

    fs.appendFileSync(hooks, JSON.stringify({ at: Date.now(), session_id: 's2', hook_event_name: 'SessionStart', source: 'clear' }) + '\n');
    await vi.waitFor(() => expect(h.discord.texts().some((t) => t.includes('全部許可」を解除した'))).toBe(true));

    h.discord.clear();
    await sendBash(h.client, 'npm test', 'fghij');
    expect(verdicts(h)).toHaveLength(1);
    expect(componentIds(cards()[0]?.card)).toContain('perm:session:fghij');
  });
});
