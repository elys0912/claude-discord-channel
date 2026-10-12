import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Card } from '../src/card.js';
import { Logger } from '../src/log.js';
import { FileSender, isWithin, secretReason } from '../src/send-file.js';

const logger = new Logger({ stderr: false });

describe('secretReason / isWithin', () => {
  it.each(['.env', '.env.local', 'server.pem', 'a.key', 'id_rsa', 'id_ed25519.pub', '.git-credentials', '.npmrc', 'credentials.json'])(
    '%s は秘密のファイルとして拒否する',
    (name) => {
      expect(secretReason(path.join(os.tmpdir(), name))).toBeDefined();
    }
  );

  it('.ssh や .claude の中は名前によらず拒否する', () => {
    expect(secretReason(path.join(os.homedir(), '.ssh', 'config'))).toMatch(/\.ssh/);
    expect(secretReason(path.join(os.homedir(), '.claude', 'channels', 'x.txt'))).toMatch(/\.claude/);
  });

  it('ふつうのファイルは拒否しない', () => {
    expect(secretReason(path.join(os.tmpdir(), 'report.pdf'))).toBeUndefined();
  });

  it('中か外かを、.. や似た名前のフォルダーで取り違えない', () => {
    const dir = path.join(os.tmpdir(), 'up');
    expect(isWithin(path.join(dir, 'a.txt'), dir)).toBe(true);
    expect(isWithin(path.join(dir, '..', 'a.txt'), dir)).toBe(false);
    expect(isWithin(path.join(os.tmpdir(), 'up2', 'a.txt'), dir)).toBe(false);
  });
});

describe('FileSender', () => {
  let root: string;
  let upload: string;
  let outside: string;
  let sent: { channel: string; files: { path: string; name: string }[]; text?: string | undefined; threadTs?: string | undefined }[];
  let cards: { channel: string; card: Card; threadTs?: string | undefined }[];
  let updates: { ts: string; card: Card }[];
  let told: { content: string; meta: Record<string, string> }[];

  const bridge = {
    sendFiles: (channel: string, files: { path: string; name: string }[], text?: string, threadTs?: string) => {
      sent.push({ channel, files, text, threadTs });
      return Promise.resolve({ ts: 'm1' });
    },
    postCard: (channel: string, card: Card, threadTs?: string) => {
      cards.push({ channel, card, threadTs });
      return Promise.resolve({ ts: 'card1' });
    },
    updateCard: (_channel: string, ts: string, card: Card) => {
      updates.push({ ts, card });
      return Promise.resolve();
    },
  };

  const make = (extra: Partial<ConstructorParameters<typeof FileSender>[0]> = {}) =>
    new FileSender({
      bridge,
      notify: (content, meta) => {
        told.push({ content, meta });
        return Promise.resolve();
      },
      uploadDirs: [upload],
      logger,
      newId: () => 'abcd1234',
      ...extra,
    });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'send-file-'));
    upload = path.join(root, 'upload');
    outside = path.join(root, 'outside');
    fs.mkdirSync(upload);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(upload, 'a.txt'), 'a');
    fs.writeFileSync(path.join(outside, 'b.txt'), 'b');
    sent = [];
    cards = [];
    updates = [];
    told = [];
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('送ってよい場所の中ならすぐ送る', async () => {
    const r = await make().send({ chat_id: 'c', paths: [path.join(upload, 'a.txt')], text: 'どうぞ', thread_id: 't' });
    expect(r).toBe('sent (1 file(s))');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'c', text: 'どうぞ', threadTs: 't' });
    expect(sent[0]?.files[0]?.name).toBe('a.txt');
  });

  it('相対パス・無いファイル・フォルダー・大きすぎるもの・秘密のファイルは、1 つでもあれば何も送らない', async () => {
    fs.writeFileSync(path.join(upload, '.env'), 'X=1');
    fs.writeFileSync(path.join(upload, 'big.bin'), Buffer.alloc(11));
    const sender = make({ maxBytes: 10 });
    const ok = path.join(upload, 'a.txt');
    for (const bad of ['a.txt', path.join(upload, 'none.txt'), upload, path.join(upload, 'big.bin'), path.join(upload, '.env')]) {
      expect(await sender.send({ chat_id: 'c', paths: [ok, bad] })).toMatch(/^error: .*どのファイルも送っていない/);
    }
    expect(sent).toHaveLength(0);
  });

  it('ブリッジの設定フォルダーの中は、送ってよい場所の中でも送らない', async () => {
    const r = await make({ protectedDirs: [upload] }).send({ chat_id: 'c', paths: [path.join(upload, 'a.txt')] });
    expect(r).toMatch(/設定フォルダー/);
  });

  it('ジャンクションで秘密のフォルダーを指していたら、たどった先で拒否する', async () => {
    const secretDir = path.join(root, '.ssh');
    fs.mkdirSync(secretDir);
    fs.writeFileSync(path.join(secretDir, 'config'), 'x');
    fs.symlinkSync(secretDir, path.join(upload, 'link'), 'junction');
    const r = await make().send({ chat_id: 'c', paths: [path.join(upload, 'link', 'config')] });
    expect(r).toMatch(/\.ssh/);
    expect(sent).toHaveLength(0);
  });

  it('場所の外が含まれていれば確認のカードを出して pending を返し、「送る」で送って結果を知らせる', async () => {
    const sender = make();
    const r = await sender.send({ chat_id: 'c', paths: [path.join(outside, 'b.txt')], thread_id: 't' });
    expect(r).toMatch(/^pending: .*id=abcd1234/);
    expect(sent).toHaveLength(0);
    expect(cards[0]?.card.buttons?.[0]?.map((b) => b.id)).toEqual(['file:ok:abcd1234', 'file:no:abcd1234']);

    await sender.confirm('abcd1234', true, { channel: 'c', ts: 'card1', threadTs: 't' }, 'u');
    expect(sent).toHaveLength(1);
    expect(updates[0]?.card.body).toContain('送った');
    expect(told[0]?.meta).toEqual({ kind: 'file_sent', result: 'sent', chat_id: 'c', thread_id: 't' });
    sender.stop();
  });

  it('「やめる」なら送らずに知らせ、二度目の答えは期限切れ扱い', async () => {
    const sender = make();
    await sender.send({ chat_id: 'c', paths: [path.join(outside, 'b.txt')] });
    await sender.confirm('abcd1234', false, { channel: 'c', ts: 'card1', threadTs: 'card1' }, 'u');
    await sender.confirm('abcd1234', true, { channel: 'c', ts: 'card1', threadTs: 'card1' }, 'u');
    expect(sent).toHaveLength(0);
    expect(told.map((t) => t.meta.result)).toEqual(['cancelled']);
    expect(updates.at(-1)?.card.body).toContain('期限切れ');
  });

  it('答えが無いまま期限を過ぎたら送らずに知らせる', async () => {
    const sender = make({ confirmTtlMs: 10 });
    await sender.send({ chat_id: 'c', paths: [path.join(outside, 'b.txt')] });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(0);
    expect(told[0]?.meta.result).toBe('expired');
  });
});
