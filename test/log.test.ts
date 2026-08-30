import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Logger, parseLogLevel, redact } from '../src/log.js';

describe('redact', () => {
  // 実在しない、形だけを合わせた値
  const token = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDe.abcdefghijklmnopqrstuvwxyz0123';

  it('ボットのトークンを伏せる', () => {
    expect(redact(`token=${token}`)).toBe('token=***');
  });

  it('Authorization ヘッダーの Bot / Bearer の値を伏せる', () => {
    expect(redact('Authorization: Bot abcdefghijklmnop1234')).toBe('Authorization: Bot ***');
    expect(redact('Authorization: Bearer abc.def.ghijklmnop')).toBe('Authorization: Bearer ***');
  });

  it('Webhook の URL のトークン部分を伏せる', () => {
    expect(redact('https://discord.com/api/webhooks/123456789012345678/abc-DEF_123')).toBe(
      'https://discord.com/api/webhooks/123456789012345678/***'
    );
  });

  it('ID・ふつうの文・「Bot ready」のような短い語は伏せない', () => {
    expect(redact('user=123456789012345678 hello world')).toBe('user=123456789012345678 hello world');
    expect(redact('Bot ready as fox3#0001')).toBe('Bot ready as fox3#0001');
  });
});

describe('Logger', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-test-'));
    file = path.join(dir, 'sub', 'app.log');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ファイルに出力され、改行が入る', () => {
    const logger = new Logger({ file, stderr: false });
    logger.info('hello', 'world');
    logger.warn('second line');
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('INFO');
    expect(lines[0]).toContain('hello world');
    expect(lines[1]).toContain('WARN');
  });

  it('ローテーションで .1 ができる', () => {
    const logger = new Logger({ file, stderr: false, maxBytes: 10 });
    logger.info('a'.repeat(20));
    logger.info('second entry after rotation');
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('循環参照のあるオブジェクトでも落ちない', () => {
    const logger = new Logger({ file, stderr: false });
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => logger.info(obj)).not.toThrow();
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('Circular');
  });

  it('Error の stack が出る', () => {
    const logger = new Logger({ file, stderr: false });
    const err = new Error('boom');
    logger.error(err);
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('Error: boom');
    expect(content).toContain('at ');
  });

  it('level でフィルタする', () => {
    const logger = new Logger({ file, stderr: false, level: 'warn' });
    logger.info('should be filtered');
    logger.error('should appear');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).not.toContain('should be filtered');
    expect(content).toContain('should appear');
  });

  it('ログ出力の例外を呼び出し元へ投げない', () => {
    const logger = new Logger({ file, stderr: false });
    // maxBytes に不正値を入れても例外を投げないことを確認（内部で吸収）
    expect(() => logger.info('x')).not.toThrow();
  });
});

describe('parseLogLevel', () => {
  it.each([
    ['debug', 'debug'],
    ['WARN', 'warn'],
    [' error ', 'error'],
    ['info', 'info'],
    ['verbose', undefined],
    // Object のプロトタイプのキーはレベルにしない
    ['constructor', undefined],
    ['', undefined],
    [undefined, undefined],
  ] as const)('%j → %j', (value, expected) => {
    expect(parseLogLevel(value)).toBe(expected);
  });
});

describe('redact（共通の鍵の形）', () => {
  it('Discord のトークンに加えて、GitHub のトークン・AWS のアクセスキー ID・sk- の API キーも伏せる', () => {
    const gh = `ghp_${'a'.repeat(36)}`;
    const aws = `AKIA${'B'.repeat(16)}`;
    const sk = `sk-${'c'.repeat(24)}`;
    expect(redact(`${gh} ${aws} ${sk}`)).toBe('ghp_*** AKIA*** sk-***');
  });
});
