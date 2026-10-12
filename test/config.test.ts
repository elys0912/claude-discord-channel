import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAccess, loadTokens, parseDotenv, stateDir } from '../src/config.js';

describe('stateDir', () => {
  it('環境変数があればそれを使う', () => {
    const abs = path.resolve(os.tmpdir(), 'custom', 'dir');
    expect(stateDir({ DISCORD_CHANNEL_STATE_DIR: abs })).toBe(abs);
  });

  it('環境変数が相対パスなら絶対パスに解決する', () => {
    const result = stateDir({ DISCORD_CHANNEL_STATE_DIR: 'rel/state' });
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.resolve('rel/state'));
  });

  it('環境変数がなければ既定パスを使う', () => {
    const result = stateDir({});
    expect(result).toBe(path.join(os.homedir(), '.claude', 'channels', 'discord-bridge'));
  });
});

describe('parseDotenv', () => {
  it('基本的な KEY=VALUE を解釈する', () => {
    expect(parseDotenv('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('コメントと空行を無視する', () => {
    expect(parseDotenv('# comment\n\nFOO=bar\n  # another\n')).toEqual({ FOO: 'bar' });
  });

  it('前後の空白をトリムする', () => {
    expect(parseDotenv('  FOO = bar  \n')).toEqual({ FOO: 'bar' });
  });

  it('ダブルクォート・シングルクォートを剥がす', () => {
    expect(parseDotenv('FOO="bar"\nBAZ=\'qux\'')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('CRLF に対応する', () => {
    expect(parseDotenv('FOO=bar\r\nBAZ=qux\r\n')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('BOM 付きファイルに対応する', () => {
    expect(parseDotenv('\uFEFFFOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('export 接頭辞を許容する', () => {
    expect(parseDotenv('export FOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('空値を許容する', () => {
    expect(parseDotenv('FOO=')).toEqual({ FOO: '' });
  });

  it('値に = を含む場合も最初の = で分割する', () => {
    expect(parseDotenv('FOO=a=b=c')).toEqual({ FOO: 'a=b=c' });
  });

  it('引用符の無い値の後ろの " # ..." は行末コメントとして捨てる', () => {
    expect(parseDotenv('FOO=bar # comment\nBAZ=qux\t# tab')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('値が空で行末コメントだけなら空値にする', () => {
    expect(parseDotenv('FOO= # comment')).toEqual({ FOO: '' });
  });

  it('空白の無い # は値の一部として残す', () => {
    expect(parseDotenv('FOO=a#b')).toEqual({ FOO: 'a#b' });
  });

  it('引用符の中の # は残し、閉じ引用符の後ろのコメントは捨てる', () => {
    expect(parseDotenv('FOO="a # b" # comment\nBAZ=\'c # d\'')).toEqual({
      FOO: 'a # b',
      BAZ: 'c # d',
    });
  });

  it('途中に同じ引用符を含む値は両端の引用符だけを剥がす', () => {
    expect(parseDotenv('FOO="a"b"')).toEqual({ FOO: 'a"b' });
  });

  it('展開や複数行はしない', () => {
    expect(parseDotenv('FOO=$BAR\nBAR=baz')).toEqual({ FOO: '$BAR', BAR: 'baz' });
  });
});

describe('loadTokens', () => {
  let dir: string;
  // 実在しない、形だけを合わせた値
  const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDe.abcdefghijklmnopqrstuvwxyz0123';
  const write = (body: string): void => fs.writeFileSync(path.join(dir, '.env'), body);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('正常系: ボットのトークンを読み込める', () => {
    write(`DISCORD_BOT_TOKEN=${TOKEN}\n`);
    expect(loadTokens(dir)).toEqual({
      botToken: TOKEN,
      keepalive: { enabled: true, afterMin: 55, max: 6, quiet: { start: 60, end: 420 } },
      todoProgress: true,
    });
  });

  it('TODO_PROGRESS は既定で on、off で止め、それ以外は Error', () => {
    write(`DISCORD_BOT_TOKEN=${TOKEN}\nTODO_PROGRESS=off\n`);
    expect(loadTokens(dir).todoProgress).toBe(false);
    write(`DISCORD_BOT_TOKEN=${TOKEN}\nTODO_PROGRESS=ON\n`);
    expect(loadTokens(dir).todoProgress).toBe(true);
    write(`DISCORD_BOT_TOKEN=${TOKEN}\nTODO_PROGRESS=yes\n`);
    expect(() => loadTokens(dir)).toThrow(/TODO_PROGRESS は on か off/);
  });

  it('KEEPALIVE の設定を読み、off・時間帯なし・範囲外を扱う', () => {
    write(`DISCORD_BOT_TOKEN=${TOKEN}\nKEEPALIVE=off\nKEEPALIVE_AFTER_MIN=50\nKEEPALIVE_MAX=3\nKEEPALIVE_QUIET=\n`);
    expect(loadTokens(dir).keepalive).toEqual({ enabled: false, afterMin: 50, max: 3, quiet: undefined });
    write(`DISCORD_BOT_TOKEN=${TOKEN}\nKEEPALIVE_AFTER_MIN=60\n`);
    expect(() => loadTokens(dir)).toThrow(/KEEPALIVE_AFTER_MIN/);
    write(`DISCORD_BOT_TOKEN=${TOKEN}\nKEEPALIVE_QUIET=1-7\n`);
    expect(() => loadTokens(dir)).toThrow(/KEEPALIVE_QUIET/);
    write(`DISCORD_BOT_TOKEN=${TOKEN}\nKEEPALIVE=maybe\n`);
    expect(() => loadTokens(dir)).toThrow(/KEEPALIVE は on か off/);
  });

  it('ファイルが無ければ Error', () => {
    expect(() => loadTokens(dir)).toThrow(/.env が見つからない/);
  });

  it('トークンが無ければ Error', () => {
    write('DOWNLOAD_DIR=\n');
    expect(() => loadTokens(dir)).toThrow(/DISCORD_BOT_TOKEN が設定されていない/);
  });

  it('トークンの形が違えば Error（値を含まない）', () => {
    write('DISCORD_BOT_TOKEN=wrong-shape-TEST-DUMMY\n');
    let caught: unknown;
    try {
      loadTokens(dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain('wrong-shape-TEST-DUMMY');
    expect(message).toContain('DISCORD_BOT_TOKEN');
  });

  it('DOWNLOAD_DIR があれば絶対パスとして downloadDir に入れる', () => {
    const target = path.join(dir, 'dl');
    write(`DISCORD_BOT_TOKEN=${TOKEN}\nDOWNLOAD_DIR="${target}"\n`);
    expect(loadTokens(dir).downloadDir).toBe(target);
  });

  it('DOWNLOAD_DIR が相対パスなら Error', () => {
    write(`DISCORD_BOT_TOKEN=${TOKEN}\nDOWNLOAD_DIR=downloads\n`);
    expect(() => loadTokens(dir)).toThrow(/DOWNLOAD_DIR/);
  });

  it('SESSION_ALLOW_ALL=on なら sessionAllowAll を立てる', () => {
    write(`DISCORD_BOT_TOKEN=${TOKEN}\nSESSION_ALLOW_ALL=on\n`);
    expect(loadTokens(dir).sessionAllowAll).toBe(true);
  });

  it('INLINE_TEXT_MAX_KB を整数で読み、範囲外や数でなければ Error', () => {
    write(`DISCORD_BOT_TOKEN=${TOKEN}\nINLINE_TEXT_MAX_KB=0\n`);
    expect(loadTokens(dir).inlineTextMaxKb).toBe(0);
    write(`DISCORD_BOT_TOKEN=${TOKEN}\nINLINE_TEXT_MAX_KB=2048\n`);
    expect(() => loadTokens(dir)).toThrow(/INLINE_TEXT_MAX_KB/);
    write(`DISCORD_BOT_TOKEN=${TOKEN}\nINLINE_TEXT_MAX_KB=abc\n`);
    expect(() => loadTokens(dir)).toThrow(/INLINE_TEXT_MAX_KB/);
  });

  it('UPLOAD_DIRS を ; で区切って読み、相対パスがあれば Error。UPLOAD_MAX_MB は 1〜100', () => {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    write(`DISCORD_BOT_TOKEN=${TOKEN}\nUPLOAD_DIRS=${a};${b};\nUPLOAD_MAX_MB=25\n`);
    expect(loadTokens(dir)).toMatchObject({ uploadDirs: [a, b], uploadMaxMb: 25 });
    write(`DISCORD_BOT_TOKEN=${TOKEN}\nUPLOAD_DIRS=${a};rel\n`);
    expect(() => loadTokens(dir)).toThrow(/UPLOAD_DIRS/);
    write(`DISCORD_BOT_TOKEN=${TOKEN}\nUPLOAD_MAX_MB=0\n`);
    expect(() => loadTokens(dir)).toThrow(/UPLOAD_MAX_MB/);
  });

  it('process.env を変更しない', () => {
    write(`DISCORD_BOT_TOKEN=${TOKEN}\n`);
    loadTokens(dir);
    expect(process.env.DISCORD_BOT_TOKEN).toBeUndefined();
  });
});

describe('loadAccess', () => {
  let dir: string;
  const GUILD = '111111111111111111';
  const USER = '222222222222222222';
  const CHANNEL = '333333333333333333';
  const write = (v: unknown): void => fs.writeFileSync(path.join(dir, 'access.json'), JSON.stringify(v));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('正常系（channels は省略できる）', () => {
    write({ guildId: GUILD, allowFrom: [USER] });
    expect(loadAccess(dir)).toEqual({ guildId: GUILD, allowFrom: [USER] });
  });

  it('channels を読み込める', () => {
    write({ guildId: GUILD, allowFrom: [USER], channels: [CHANNEL] });
    expect(loadAccess(dir).channels).toEqual([CHANNEL]);
  });

  it.each([
    ['数字でない ID', { guildId: 'abc', allowFrom: [USER] }, /guildId の形式が不正/],
    ['短すぎる ID', { guildId: GUILD, allowFrom: ['12345'] }, /allowFrom の形式が不正/],
    ['channels の重複', { guildId: GUILD, allowFrom: [USER], channels: [CHANNEL, CHANNEL] }, /channels に重複がある/],
    ['allowFrom の重複', { guildId: GUILD, allowFrom: [USER, USER] }, /allowFrom に重複がある/],
    ['空の allowFrom', { guildId: GUILD, allowFrom: [] }, /allowFrom は1件以上必要/],
    ['未知のキー', { guildId: GUILD, allowFrom: [USER], teamId: 'T123' }, /access.json の検証に失敗/],
    ['ID が数値（文字列でない）', { guildId: 1234, allowFrom: [USER] }, /guildId/],
  ])('%sは拒否する', (_label, value, message) => {
    write(value);
    expect(() => loadAccess(dir)).toThrow(message);
  });

  it('BOM 付きの UTF-8 でも読み込める', () => {
    fs.writeFileSync(path.join(dir, 'access.json'), '﻿' + JSON.stringify({ guildId: GUILD, allowFrom: [USER] }));
    expect(loadAccess(dir)).toEqual({ guildId: GUILD, allowFrom: [USER] });
  });

  it('JSON の構文エラーなら拒否する', () => {
    fs.writeFileSync(path.join(dir, 'access.json'), '{ not valid json');
    expect(() => loadAccess(dir)).toThrow(/JSON 構文が不正/);
  });
});
