import { describe, expect, it } from 'vitest';
import { DiscordBridge, normalizeBotRoleMentions } from '../src/discord.js';
import { Logger } from '../src/log.js';

const BOT = '1558801069306282134';
const ROLE = '1558801938114547905';

describe('normalizeBotRoleMentions', () => {
  it('ボットのロールへのメンションを、ボット本人へのメンションに置き換える（何か所あっても）', () => {
    expect(normalizeBotRoleMentions(`<@&${ROLE}> !status <@&${ROLE}>`, [ROLE], BOT)).toBe(`<@${BOT}> !status <@${BOT}>`);
  });

  it('ほかのロールやユーザーへのメンションは変えない', () => {
    const text = `<@&999999999999999999> <@123456789012345678> hi`;
    expect(normalizeBotRoleMentions(text, [ROLE], BOT)).toBe(text);
  });

  it('ボットのロールが無ければそのまま', () => {
    expect(normalizeBotRoleMentions(`<@&${ROLE}> hi`, [], BOT)).toBe(`<@&${ROLE}> hi`);
  });
});

describe('DiscordBridge.fetchFile', () => {
  function bridgeWith(fetched: string[]): DiscordBridge {
    return new DiscordBridge({
      token: 'unused',
      access: { guildId: '100000000000000001', allowFrom: ['200000000000000001'] },
      logger: new Logger({ stderr: false }),
      fetch: async (input) => {
        fetched.push(input instanceof URL ? input.href : JSON.stringify(input));
        return new Response('ok');
      },
    });
  }

  it('Discord の CDN（https）からだけ取る', async () => {
    const fetched: string[] = [];
    const bridge = bridgeWith(fetched);
    for (const url of ['https://cdn.discordapp.com/attachments/1/2/a.txt', 'https://media.discordapp.net/attachments/1/2/a.png']) {
      await expect(bridge.fetchFile({ id: '2', name: 'a', url })).resolves.toBeInstanceOf(Response);
    }
    expect(fetched).toHaveLength(2);
  });

  it.each(['https://evil.example/a.txt', 'http://cdn.discordapp.com/a.txt', 'https://cdn.discordapp.com.evil.example/a.txt'])(
    'CDN 以外（%s）には取りに行かない',
    async (url) => {
      const fetched: string[] = [];
      await expect(bridgeWith(fetched).fetchFile({ id: '2', name: 'a', url })).rejects.toThrow(/CDN 以外/);
      expect(fetched).toEqual([]);
    }
  );
});
