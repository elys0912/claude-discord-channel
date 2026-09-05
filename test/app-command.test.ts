// ブリッジのコマンド（! で始まる発言・スラッシュコマンド）と、ターミナル画面・許可リストの操作のテスト。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KEEPALIVE_TEXT, REACTION } from '../src/app.js';
import { HELP_TEXT, parseCommand } from '../src/commands.js';
import { ACCESS, CH, DM1, STRANGER, cardText, componentIds, flush } from './helpers/fake-discord.js';
import { fakeConsole } from './helpers/fake-console.js';
import { channelMessages, closeHarness, sendBash, startHarness, verdicts } from './helpers/app-harness.js';
import type { Harness } from './helpers/app-harness.js';
import type { ConsoleKey } from '../src/console.js';

describe('parseCommand', () => {
  it('コマンドだけの本文を正規化して返す', () => {
    expect(parseCommand('!status')).toBe('status');
    expect(parseCommand('  !RESTART   FORCE ')).toBe('restart force');
    expect(parseCommand('!clear')).toBe('clear');
    expect(parseCommand('!Help')).toBe('help');
    expect(parseCommand('!stop')).toBe('stop');
    expect(parseCommand('!keepalive')).toBe('keepalive');
    expect(parseCommand('!keepalive  OFF')).toBe('keepalive off');
  });

  it('コマンドの後ろに普通の文があればコマンドにしない', () => {
    expect(parseCommand('!restart してから続けて')).toBeUndefined();
    expect(parseCommand('!restart\nそのあと *これ* を見て')).toBeUndefined();
    expect(parseCommand('!keepalive maybe')).toBeUndefined();
    expect(parseCommand('/clear')).toBeUndefined();
    expect(parseCommand('status')).toBeUndefined();
  });
});

describe('ターミナル画面と許可リスト（!screen / 今後も許可 / !rules）', () => {
  const CHROME = [
    ' Claude wants to use your browser',
    '    Install extension  Opens the install page in Chrome',
    '  > Not now            Continue without browser tools',
    "    Don't ask again    Revisit anytime with /chrome",
  ].join('\n');
  let h: Harness;
  let dir: string;
  let sent: ConsoleKey[][];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-rules-'));
    const denyFile = path.join(dir, 'settings.json');
    fs.writeFileSync(denyFile, JSON.stringify({ permissions: { deny: ['Bash(pwd -P:*)'] } }));
    sent = [];
    h = await startHarness({
      console: fakeConsole({ screen: CHROME, keys: sent }),
      allowExtraFile: path.join(dir, 'allow-extra.json'),
      denyFiles: [denyFile],
    });
  });

  afterEach(async () => {
    await closeHarness(h);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('!screen は Claude に渡さず、選択肢のメニューを出し、選ぶと選択キーを送る', async () => {
    await h.discord.dm('!screen', { id: '5000' });
    await flush();

    expect(channelMessages(h)).toEqual([]);
    const card = h.discord.of('postCard')[0];
    expect(card?.threadTs).toBe('5000');
    const select = card?.card?.select;
    expect(select?.options.map((o) => o.value)).toEqual(['0', '1', '2']);

    await h.discord.press(select?.id ?? '', { message: card?.ts, values: ['2'] });
    await flush();
    expect(sent).toEqual([['Down', 'Enter']]);
    expect(cardText(h.discord.of('updateCard')[0]?.card)).toContain("Don't ask again");
  });

  it('「画面を確認」ボタンでも同じように画面を出す', async () => {
    await h.discord.press('scr:show', { message: '5100' });
    await flush();
    expect(h.discord.of('postCard')[0]).toMatchObject({ channel: DM1, threadTs: '5100' });
  });

  it('今後も許可: 今回は許可し、確認のうえ allow-extra.json に書き込む', async () => {
    await sendBash(h, 'git status');
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
    await sendBash(h, 'pwd');
    h.discord.clear();

    await h.discord.press('perm:always:abcde');
    await flush();

    expect(verdicts(h)).toEqual([{ request_id: 'abcde', behavior: 'allow' }]);
    const notice = h.discord.texts().find((t) => t.includes('deny に当たる'));
    expect(notice).toContain('Bash(pwd -P:*)');
    expect(fs.existsSync(path.join(dir, 'allow-extra.json'))).toBe(false);
  });

  it('!rules で追加分を一覧し、メニューで選ぶと消せる', async () => {
    fs.writeFileSync(path.join(dir, 'allow-extra.json'), JSON.stringify({ allow: ['WebFetch', 'Bash(git status:*)'] }));
    await h.discord.dm('!rules', { id: '6000' });
    await flush();
    const card = h.discord.of('postCard')[0];
    expect(cardText(card?.card)).toContain('2 件');

    await h.discord.press(card?.card?.select?.id ?? '', { message: card?.ts, values: ['0'] });
    await flush();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'allow-extra.json'), 'utf8'))).toEqual({ allow: ['Bash(git status:*)'] });
  });
});

describe('!status / !restart / !compact / !clear / !stop / !help', () => {
  const PROMPT = ['Claude: done.', '', '❯ ', '  ? for shortcuts'].join('\n');
  let h: Harness;
  let dir: string;
  let flag: string;
  let screen: string;
  let commands: string[];
  let keys: ConsoleKey[][];
  let killed: number;
  const texts = () => h.discord.texts();

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-session-'));
    flag = path.join(dir, 'restart.flag');
    screen = PROMPT;
    commands = [];
    keys = [];
    killed = 0;
    h = await startHarness({
      console: fakeConsole({ screen: () => screen, keys, commands }),
      restartFlagFile: flag,
      killParent: () => void killed++,
      workDir: 'C:\\dev\\app',
    });
    h.discord.clear();
  });

  afterEach(async () => {
    await closeHarness(h);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('!status は Claude に渡さず、稼働状態を返す（受け取った印の 👀 は付ける）', async () => {
    await h.discord.dm('!status', { id: '8000' });
    await flush();

    expect(channelMessages(h)).toEqual([]);
    expect(h.discord.of('addReaction')).toEqual([expect.objectContaining({ ts: '8000', emoji: REACTION.SEEN })]);
    expect(h.discord.of('postText')[0]).toMatchObject({ channel: DM1, threadTs: '8000' });
    const text = texts()[0] ?? '';
    expect(text).toContain('ブリッジの状態');
    expect(text).toContain('C:\\dev\\app');
    expect(text).toContain('返事待ち: 無し');
    expect(text).toContain('実行許可: 0 件');
  });

  it('!restart は restart.flag を置いて /exit を送る', async () => {
    await h.discord.dm('!restart');
    await flush();

    expect(fs.existsSync(flag)).toBe(true);
    expect(commands).toEqual(['exit']);
    expect(killed).toBe(0);
    expect(texts().join('\n')).toContain('/exit を送った');
  });

  it('入力待ちでなければ /exit を送らない', async () => {
    screen = 'Thinking…\n⠋ Working';
    await h.discord.dm('!restart');
    await flush();

    expect(commands).toEqual([]);
    expect(texts().join('\n')).toContain('入力待ちでない');
  });

  it('!restart force は印を置いて claude.exe を止める', async () => {
    await h.discord.dm('!restart  force');
    await flush();

    expect(fs.existsSync(flag)).toBe(true);
    expect(killed).toBe(1);
    expect(commands).toEqual([]);
  });

  it('!compact は /compact を送り、印は置かない', async () => {
    await h.discord.dm('!compact');
    await flush();

    expect(commands).toEqual(['compact']);
    expect(fs.existsSync(flag)).toBe(false);
  });

  it('!clear は /clear を送り、印は置かない', async () => {
    await h.discord.dm('!clear');
    await flush();

    expect(channelMessages(h)).toEqual([]);
    expect(commands).toEqual(['clear']);
    expect(fs.existsSync(flag)).toBe(false);
    expect(texts().join('\n')).toContain('/clear を送った');
  });

  it('!stop は Esc を送り、入力中の表示と無応答の見張りを止めて知らせる', async () => {
    await h.discord.dm('作業して', { id: '8100' });
    await flush();
    h.discord.clear();

    await h.discord.dm('!stop', { id: '8101' });
    await flush();

    expect(keys).toEqual([['Esc']]);
    expect(texts().join('\n')).toContain('Esc を送って中断した');
    expect(h.discord.of('postCard')[0]).toMatchObject({ channel: DM1, threadTs: '8101' });
  });

  it('!keepalive は、つなぎ止めが無いブリッジでは使えない旨を返す', async () => {
    await h.discord.dm('!keepalive');
    await flush();
    expect(texts()).toEqual(['⚠️ このブリッジでは !keepalive を使えない']);
  });

  it('!lock は、全部許可を有効にしていないボットでは使えない旨を返す', async () => {
    await h.discord.dm('!lock');
    await flush();
    expect(texts()).toEqual(['⚠️ このブリッジでは !lock を使えない']);
  });

  it('!help は Claude に渡さず、コマンドの一覧を返す', async () => {
    await h.discord.dm('!help', { id: '8600' });
    await flush();

    expect(channelMessages(h)).toEqual([]);
    expect(h.discord.of('postText')[0]).toMatchObject({ channel: DM1, threadTs: '8600', text: HELP_TEXT });
    for (const c of ['!help', '!status', '!screen', '!stop', '!rules', '!compact', '!clear', '!restart', '!restart force', '!lock']) {
      expect(HELP_TEXT).toContain(`\`${c}\``);
    }
  });
});

describe('コンソールや再起動の印が無いブリッジ', () => {
  it('!restart / !stop / !rules は使えない旨を返し、!screen は画面を読めない旨を返す', async () => {
    const h = await startHarness();
    for (const c of ['!restart', '!stop', '!rules', '!screen']) await h.discord.dm(c);
    await flush();
    expect(h.discord.texts()).toEqual([
      '⚠️ このブリッジでは !restart を使えない',
      '⚠️ このブリッジでは !stop を使えない',
      '⚠️ このブリッジでは !rules を使えない',
      expect.stringContaining('画面を読めない'),
    ]);
    await closeHarness(h);
  });
});

describe('キャッシュのつなぎ止め', () => {
  it('!keepalive で状態を見て、off / on で切り替える', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-keepalive-'));
    const h = await startHarness({
      hookInboxFile: path.join(dir, 'hooks.jsonl'),
      keepalive: { enabled: true, afterMs: 55 * 60_000, max: 6, quiet: undefined },
    });
    try {
      await h.discord.dm('!keepalive');
      await h.discord.dm('!keepalive off');
      await h.discord.dm('!keepalive on');
      await flush();
      const texts = h.discord.texts();
      expect(texts[0]).toContain('有効');
      expect(texts[1]).toContain('無効');
      expect(texts[2]).toContain('有効');
      expect(channelMessages(h)).toEqual([]);
      expect(KEEPALIVE_TEXT).toContain('ok とだけ書く');
    } finally {
      await closeHarness(h);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('スラッシュコマンド', () => {
  let h: Harness;
  let commands: string[];

  beforeEach(async () => {
    commands = [];
    h = await startHarness({
      access: { ...ACCESS, channels: [CH] },
      console: fakeConsole({ screen: '❯ ', commands }),
      restartFlagFile: path.join(os.tmpdir(), `slash-${Math.random().toString(36).slice(2)}.flag`),
      workDir: 'C:\\dev\\app',
    });
  });

  afterEach(() => closeHarness(h));

  it('/status は使ったことを一言残し、その一言への返信として状態を返す（Claude には渡さない）', async () => {
    await h.discord.slash('status');
    await flush();

    const [echo, status] = h.discord.of('postText');
    expect(echo).toMatchObject({ channel: DM1, text: '⌨️ `/status`' });
    expect(status).toMatchObject({ channel: DM1, threadTs: echo?.ts });
    expect(status?.text).toContain('ブリッジの状態');
    expect(channelMessages(h)).toEqual([]);
  });

  it('チャンネルのスレッドの中で使えば、そのスレッドに返す', async () => {
    await h.discord.slash('help', { conversation: CH, thread: '3700' });
    await flush();
    expect(h.discord.of('postText').map((p) => [p.channel, p.threadTs])).toEqual([
      [CH, '3700'],
      [CH, '3700'],
    ]);
  });

  it('/compact と /keepalive などは ! のコマンドと同じに動く', async () => {
    await h.discord.slash('compact');
    await h.discord.slash('keepalive', { mode: 'off' });
    await flush();
    expect(commands).toEqual(['compact']);
    // つなぎ止めの無いブリッジなので、!keepalive off と同じく使えない旨を返す
    expect(h.discord.texts()).toContain('⚠️ このブリッジでは !keepalive を使えない');
  });

  it('許可外の人・場所では何もせず、本人にだけ使えない旨を返す', async () => {
    await h.discord.slash('status', { user: STRANGER });
    await h.discord.slash('status', { conversation: '399999999999999999' });
    await flush();
    expect(h.discord.ephemeral).toEqual(['user_not_allowed', 'channel_not_allowed']);
    expect(h.discord.calls).toEqual([]);
  });
});
