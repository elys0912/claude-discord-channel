import { describe, expect, it } from 'vitest';
import { ApplicationCommandType } from 'discord.js';
import { APP_COMMANDS, FORWARD_COMMAND, SLASH_COMMANDS, checkUse, parseSlashCommand, sameCommands, slashEcho } from '../src/slash.js';
import { parseCommand } from '../src/app.js';
import type { SlashInput } from '../src/slash.js';
import type { ParsedAccess } from '../src/config.js';

const ACCESS: ParsedAccess = { guildId: '100000000000000001', allowFrom: ['200000000000000001'] };
const DM = '300000000000000001';
const ALLOWED = new Set([DM]);

function input(name: string, extra: Partial<SlashInput> = {}): SlashInput {
  return { name, guildId: null, userId: '200000000000000001', conversationId: DM, ...extra };
}

describe('SLASH_COMMANDS', () => {
  it('Discord の制約（名前は英小文字 32 字まで、説明は 100 字まで、重複なし）を守る', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of SLASH_COMMANDS) {
      expect(c.name).toMatch(/^[a-z]{1,32}$/);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(100);
      for (const o of c.options ?? []) {
        expect(o.name).toMatch(/^[a-z]{1,32}$/);
        expect(o.description.length).toBeLessThanOrEqual(100);
      }
      // サーバーとボットとの DM（0, 1）だけに出す
      expect(c.contexts).toEqual([0, 1]);
    }
  });

  it('`!` のコマンドとすべて対応する（名前がそのまま ! のコマンドになる）', () => {
    for (const c of SLASH_COMMANDS) expect(parseCommand(`!${c.name}`)).toBe(c.name);
  });
});

describe('parseSlashCommand', () => {
  it('名前をブリッジのコマンドにする', () => {
    for (const name of ['help', 'status', 'screen', 'stop', 'rules', 'compact', 'clear', 'lock']) {
      expect(parseSlashCommand(input(name), ACCESS, ALLOWED)).toEqual({ ok: true, command: name });
    }
  });

  it('keepalive の mode と restart の force を引数として読む', () => {
    expect(parseSlashCommand(input('keepalive'), ACCESS, ALLOWED)).toEqual({ ok: true, command: 'keepalive' });
    expect(parseSlashCommand(input('keepalive', { mode: 'on' }), ACCESS, ALLOWED)).toEqual({ ok: true, command: 'keepalive on' });
    expect(parseSlashCommand(input('keepalive', { mode: 'off' }), ACCESS, ALLOWED)).toEqual({ ok: true, command: 'keepalive off' });
    expect(parseSlashCommand(input('keepalive', { mode: 'maybe' }), ACCESS, ALLOWED)).toEqual({ ok: true, command: 'keepalive' });
    expect(parseSlashCommand(input('restart'), ACCESS, ALLOWED)).toEqual({ ok: true, command: 'restart' });
    expect(parseSlashCommand(input('restart', { force: false }), ACCESS, ALLOWED)).toEqual({ ok: true, command: 'restart' });
    expect(parseSlashCommand(input('restart', { force: true }), ACCESS, ALLOWED)).toEqual({ ok: true, command: 'restart force' });
  });

  it.each([
    ['ほかのサーバー', { guildId: '199999999999999999' }, 'guild_mismatch'],
    ['許可外の人', { userId: '299999999999999999' }, 'user_not_allowed'],
    ['許可外の場所', { conversationId: '399999999999999999' }, 'channel_not_allowed'],
    ['知らないコマンド', { name: 'nope' }, 'unknown_command'],
  ])('%s なら使わせない', (_label, extra, reason) => {
    expect(parseSlashCommand(input('status', extra), ACCESS, ALLOWED)).toEqual({ ok: false, reason });
  });

  it('サーバーの中では guildId が合っていればよい', () => {
    expect(parseSlashCommand(input('status', { guildId: ACCESS.guildId }), ACCESS, ALLOWED).ok).toBe(true);
  });
});

describe('sameCommands', () => {
  it('Discord が足す項目（id など）や並び順の違いは同じとみなす', () => {
    const registered = [...APP_COMMANDS].reverse().map((c, i) => ({ ...c, id: String(i), version: '1', application_id: '9', dm_permission: true }));
    expect(sameCommands(registered)).toBe(true);
  });

  it('説明・引数・数が変わったら違うとみなす', () => {
    expect(sameCommands(APP_COMMANDS.slice(1))).toBe(false);
    expect(sameCommands(APP_COMMANDS.map((c) => (c.name === 'status' ? { ...c, description: '古い説明' } : c)))).toBe(false);
    expect(sameCommands(APP_COMMANDS.map((c) => (c.name === 'restart' ? { ...c, options: [] } : c)))).toBe(false);
    expect(sameCommands([])).toBe(false);
  });
});

describe('slashEcho', () => {
  it('使ったコマンドをコードの形で残す', () => {
    expect(slashEcho('restart force')).toBe('⌨️ `/restart force`');
  });
});

describe('右クリックメニュー（Claude に渡す）', () => {
  it('APP_COMMANDS にスラッシュコマンドとメッセージのメニューの両方が入る', () => {
    expect(APP_COMMANDS).toHaveLength(SLASH_COMMANDS.length + 1);
    expect(FORWARD_COMMAND).toMatchObject({ type: 3, name: 'Claude に渡す', contexts: [0, 1] });
    expect(FORWARD_COMMAND.name.length).toBeLessThanOrEqual(32);
  });

  it('sameCommands は種類も比べる。Discord がメニューに返す空の説明は同じとみなす', () => {
    const registered = APP_COMMANDS.map((c) => (c.type === ApplicationCommandType.Message ? { ...c, description: '' } : c));
    expect(sameCommands(registered)).toBe(true);
    expect(sameCommands(registered.map((c) => (c.type === ApplicationCommandType.Message ? { ...c, type: ApplicationCommandType.User } : c)))).toBe(false);
    // 前の版（スラッシュコマンドだけ）が登録されていれば、登録し直す
    expect(sameCommands(SLASH_COMMANDS)).toBe(false);
  });

  it('checkUse はサーバー・人・場所を確かめる', () => {
    expect(checkUse({ guildId: null, userId: '200000000000000001', conversationId: DM }, ACCESS, ALLOWED)).toBeUndefined();
    expect(checkUse({ guildId: '199999999999999999', userId: '200000000000000001', conversationId: DM }, ACCESS, ALLOWED)).toBe('guild_mismatch');
    expect(checkUse({ guildId: null, userId: '299999999999999999', conversationId: DM }, ACCESS, ALLOWED)).toBe('user_not_allowed');
    expect(checkUse({ guildId: null, userId: '200000000000000001', conversationId: 'x' }, ACCESS, ALLOWED)).toBe('channel_not_allowed');
  });
});
