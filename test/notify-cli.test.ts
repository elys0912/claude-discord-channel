import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sendNotice } from '../src/notify-cli.js';
import type { NoticeRest } from '../src/notify-cli.js';
import { ACCESS, USER1 } from './helpers/fake-discord.js';

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDe.abcdefghijklmnopqrstuvwxyz0123';

/** DM を開くと `dm-<ユーザー>` を返す REST。failFor のユーザーは開けない */
function fakeRest(failFor?: string): NoticeRest & { calls: { route: string; body: unknown }[] } {
  const calls: { route: string; body: unknown }[] = [];
  return {
    calls,
    post: async (route, { body }) => {
      calls.push({ route, body });
      const recipient = (body as { recipient_id?: string }).recipient_id;
      if (failFor !== undefined && recipient === failFor) throw new Error('Cannot send messages to this user');
      return recipient ? { id: `dm-${recipient}` } : {};
    },
  };
}

describe('sendNotice', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-cli-test-'));
    fs.writeFileSync(path.join(dir, '.env'), `DISCORD_BOT_TOKEN=${TOKEN}\n`);
    fs.writeFileSync(path.join(dir, 'access.json'), JSON.stringify(ACCESS));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('許可ユーザー全員の DM を開いて送り、送れた数を返す', async () => {
    const rest = fakeRest();
    expect(await sendNotice(dir, '🛑 起動し直しを諦めた', rest)).toBe(ACCESS.allowFrom.length);
    const messages = rest.calls.filter((c) => c.route.endsWith('/messages'));
    expect(messages.map((c) => c.route)).toEqual(ACCESS.allowFrom.map((u) => `/channels/dm-${u}/messages`));
    expect(messages[0]?.body).toEqual({ content: '🛑 起動し直しを諦めた' });
  });

  it('DM を開けない人は飛ばして、ほかの人には送る', async () => {
    expect(await sendNotice(dir, 'x', fakeRest(USER1))).toBe(ACCESS.allowFrom.length - 1);
  });

  it('.env が無ければ投げる', async () => {
    fs.rmSync(path.join(dir, '.env'));
    await expect(sendNotice(dir, 'x', fakeRest())).rejects.toThrow(/\.env/);
  });
});
