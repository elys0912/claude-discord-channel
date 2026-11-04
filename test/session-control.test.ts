import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionControl } from '../src/session-control.js';
import type { SessionControlOptions } from '../src/session-control.js';
import { parseTasklistName } from '../src/parent-process.js';
import { Logger } from '../src/log.js';
import type { ConsoleAccess, ConsoleCommand, ConsoleKey } from '../src/console.js';
import { fakeConsole } from './helpers/fake-console.js';

const AT = { channel: 'D1', threadTs: '1.0' };
const PROMPT = 'Claude: ok\n\n❯ \n';

describe('SessionControl', () => {
  let dir: string;
  let flag: string;
  let posted: string[];
  let commands: ConsoleCommand[];
  let killed: number;
  let screen: string;

  /** 今の screen を読み、送られたコマンドを commands に入れるターミナル */
  function consoleOnScreen(opts: { fail?: boolean } = {}): ConsoleAccess {
    return fakeConsole({ screen: () => screen, commands, failCommand: opts.fail });
  }

  /** overrides で、強制終了の失敗・印の置き場所・sessionId などを差し替える */
  function make(console: ConsoleAccess | undefined, overrides: Partial<SessionControlOptions> = {}): SessionControl {
    return new SessionControl({
      console,
      restartFlagFile: flag,
      bridge: { postText: async (_c, text) => ({ ts: [String(posted.push(text))] }) },
      logger: new Logger({ stderr: false }),
      killParent: () => void killed++,
      exitConfirmMs: 50,
      exitGiveUpMs: 150,
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-'));
    flag = path.join(dir, 'restart.flag');
    posted = [];
    commands = [];
    killed = 0;
    screen = PROMPT;
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('interrupt: 画面の状態によらず Esc を送る。コンソールが無い・送れないときは知らせて false', async () => {
    const keys: ConsoleKey[][] = [];
    const withKeys = fakeConsole({ screen: () => screen, keys });
    screen = 'Thinking… (esc to interrupt)';
    expect(await make(withKeys).interrupt(AT, 'U1')).toBe(true);
    expect(keys).toEqual([['Esc']]);

    expect(await make(undefined).interrupt(AT, 'U1')).toBe(false);
    const broken: ConsoleAccess = { ...consoleOnScreen(), sendKeys: async () => Promise.reject(new Error('gone')) };
    expect(await make(broken).interrupt(AT, 'U1')).toBe(false);
    expect(posted).toHaveLength(2);
  });

  it('restart: 印を置き、入力待ちなら /exit を送り、終了しなければ知らせる。印は 2 段目の時間まで残し、過ぎたら消す（D-SC-03）', async () => {
    const s = make(consoleOnScreen());
    await s.restart(AT, 'U1', false);
    expect(fs.existsSync(flag)).toBe(true);
    expect(commands).toEqual(['exit']);
    expect(posted).toEqual([expect.stringContaining('/exit を送った')]);

    await vi.advanceTimersByTimeAsync(50);
    expect(posted[1]).toContain('まだ終了していない');
    expect(posted[1]).toContain('このまま待てば起動し直す');
    // 遅れて終了したときに起動し直せるよう、1 段目の知らせでは印を消さない
    expect(fs.existsSync(flag)).toBe(true);

    await vi.advanceTimersByTimeAsync(99);
    expect(fs.existsSync(flag)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(posted[2]).toContain('印は消した');
    expect(fs.existsSync(flag)).toBe(false);
    s.stop();
  });

  it('restart: 1 段目の知らせの後に stop すれば、印を消さない（終了したので start.ps1 が起動し直す）', async () => {
    const s = make(consoleOnScreen());
    await s.restart(AT, 'U1', false);
    await vi.advanceTimersByTimeAsync(50);
    s.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(posted).toHaveLength(2);
    expect(fs.existsSync(flag)).toBe(true);
  });

  it('restart: stop すれば終了の確認を知らせない', async () => {
    const s = make(consoleOnScreen());
    await s.restart(AT, 'U1', false);
    s.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(posted).toHaveLength(1);
  });

  it('restart: 画面が選択画面・打ちかけなら送らず知らせる', async () => {
    const s = make(consoleOnScreen());
    screen = ' Choose\n  > One\n    Two\n';
    await s.restart(AT, 'U1', false);
    expect(commands).toEqual([]);
    expect(posted[0]).toContain('入力待ちでない');

    screen = '❯ git sta';
    await s.restart(AT, 'U1', false);
    expect(commands).toEqual([]);
    // 送らなかったので、後で手元で終了しても起動し直さないよう印は残さない
    expect(fs.existsSync(flag)).toBe(false);
  });

  it('restart: /exit の送信に失敗したら印を消す', async () => {
    await make(consoleOnScreen({ fail: true })).restart(AT, 'U1', false);
    expect(posted[0]).toContain('送れなかった');
    expect(fs.existsSync(flag)).toBe(false);
  });

  it('restart: 強制終了に失敗したら印を消す', async () => {
    const s = make(undefined, {
      killParent: () => {
        throw new Error('EPERM');
      },
    });
    await s.restart(AT, 'U1', true);
    expect(posted.at(-1)).toContain('強制終了に失敗した');
    expect(fs.existsSync(flag)).toBe(false);
  });

  it('restart: console が無ければ force を案内する。force は console が無くても止める', async () => {
    const s = make(undefined);
    await s.restart(AT, 'U1', false);
    expect(posted[0]).toContain('!restart force');
    expect(killed).toBe(0);
    expect(fs.existsSync(flag)).toBe(false);

    await s.restart(AT, 'U1', true);
    expect(killed).toBe(1);
    expect(fs.existsSync(flag)).toBe(true);
  });

  it('restart: 印を書けなければ何も送らない', async () => {
    const s = make(consoleOnScreen(), { restartFlagFile: path.join(dir, 'no-such-dir', 'restart.flag') });
    await s.restart(AT, 'U1', true);
    expect(killed).toBe(0);
    expect(posted[0]).toContain('書けなかった');
  });

  it('compact: /compact を送る。送信に失敗しても投げずに知らせる', async () => {
    await make(consoleOnScreen()).compact(AT, 'U1');
    expect(commands).toEqual(['compact']);
    expect(posted[0]).toContain('/compact を送った');

    await make(consoleOnScreen({ fail: true })).compact(AT, 'U1');
    expect(posted[1]).toContain('送れなかった');
    expect(fs.existsSync(flag)).toBe(false);
  });

  it('clear: /clear を送る。送信に失敗しても投げずに知らせる', async () => {
    await make(consoleOnScreen()).clear(AT, 'U1');
    expect(commands).toEqual(['clear']);
    expect(posted[0]).toContain('/clear を送った');

    await make(consoleOnScreen({ fail: true })).clear(AT, 'U1');
    expect(posted[1]).toContain('送れなかった');
    expect(fs.existsSync(flag)).toBe(false);
  });

  it('restart の印: sessionId を渡せば印に書き、無ければ書かない', async () => {
    await make(undefined, { sessionId: () => 'c2097ecd-29b0-4cee-9f3e-a9aeace64bc3' }).restart(AT, 'U1', true);
    expect(JSON.parse(fs.readFileSync(flag, 'utf8'))).toMatchObject({ sessionId: 'c2097ecd-29b0-4cee-9f3e-a9aeace64bc3' });

    await make(undefined).restart(AT, 'U1', true);
    expect(JSON.parse(fs.readFileSync(flag, 'utf8'))).not.toHaveProperty('sessionId');
  });
});

describe('parseTasklistName（!restart force で親の名前を確かめる）', () => {
  it('tasklist の CSV から pid の行のイメージ名を読む', () => {
    const csv = '"claude.exe","4321","Console","1","250,000 K"\r\n';
    expect(parseTasklistName(csv, 4321)).toBe('claude.exe');
  });

  it('pid が違う・見つからない（INFO: の行）なら undefined', () => {
    expect(parseTasklistName('"claude.exe","4321","Console","1","1 K"\r\n', 1234)).toBeUndefined();
    expect(parseTasklistName('INFO: No tasks are running which match the specified criteria.\r\n', 1234)).toBeUndefined();
  });
});
