import { describe, expect, it } from 'vitest';
import { toDiscord } from '../src/card.js';
import type { ParsedAccess } from '../src/config.js';
import { ACTION, buildPermissionCard, buildResolvedCard, customId, parseInteraction } from '../src/permission.js';
import type { InteractionInput } from '../src/permission.js';

const GUILD = '111111111111111111';
const USER = '222222222222222222';
const CHANNEL = '333333333333333333';
const access: ParsedAccess = { guildId: GUILD, allowFrom: [USER], channels: [CHANNEL] };
const allowed = new Set([CHANNEL]);

const req = { request_id: 'abcde', tool_name: 'Bash', description: 'ls を実行', input_preview: 'ls -la' };

function input(overrides: Partial<InteractionInput>): InteractionInput {
  return { kind: 'button', customId: 'perm:allow:abcde', guildId: GUILD, userId: USER, conversationId: CHANNEL, ...overrides };
}

describe('buildPermissionCard', () => {
  it('Allow / 今後も許可 / Deny を並べ、省略が無ければ See more は付けない', () => {
    const { card, truncated } = buildPermissionCard(req, undefined, false, true);
    expect(truncated).toBe(false);
    expect(card.buttons?.[0]?.map((b) => b.id)).toEqual(['perm:allow:abcde', 'perm:always:abcde', 'perm:deny:abcde']);
    expect(card.code).toBe('ls -la');
  });

  it('ルールを作れないリクエストには「今後も許可」を付けない（既定）', () => {
    const { card } = buildPermissionCard(req);
    expect(card.buttons?.[0]?.map((b) => b.id)).toEqual(['perm:allow:abcde', 'perm:deny:abcde']);
  });

  it('全部許可のボタンを付けられる。長いプレビューは省略して See more を付ける', () => {
    const { card, truncated } = buildPermissionCard({ ...req, input_preview: 'x'.repeat(5000) }, undefined, true);
    expect(truncated).toBe(true);
    expect(card.buttons?.[0]?.map((b) => b.id)).toContain('perm:session:abcde');
    expect(card.buttons?.[0]?.map((b) => b.id)).toContain('perm:more:abcde');
  });

  it('ツール名・説明の Markdown はエスケープし、Discord の上限に収まる', () => {
    const { card } = buildPermissionCard({ ...req, tool_name: '**x**', description: 'd'.repeat(5000), input_preview: 'p'.repeat(5000) });
    expect(card.body).toContain('\\*\\*x\\*\\*');
    const { embeds } = toDiscord(card);
    expect(embeds[0]?.description?.length).toBeLessThanOrEqual(4096);
  });

  it('不可視文字は見える形にする', () => {
    const { card } = buildPermissionCard({ ...req, input_preview: 'rm‮evil' });
    expect(card.code).toBe('rm\\u{202E}evil');
  });
});

describe('buildResolvedCard', () => {
  it('ユーザー ID の形ならメンション表示、それ以外は文字のまま', () => {
    expect(buildResolvedCard(req, 'allow', USER).body).toContain(`<@${USER}>`);
    expect(buildResolvedCard(req, 'deny', 'someone').body).toContain('someone');
  });
});

describe('parseInteraction', () => {
  it.each([
    ['perm:allow:abcde', { kind: 'verdict', verdict: { requestId: 'abcde', behavior: 'allow' } }],
    ['perm:deny:abcde', { kind: 'verdict', verdict: { requestId: 'abcde', behavior: 'deny' } }],
    ['perm:more:abcde', { kind: 'see_more', requestId: 'abcde' }],
    ['perm:always:abcde', { kind: 'allow_always', requestId: 'abcde' }],
    ['perm:session:abcde', { kind: 'allow_session', requestId: 'abcde' }],
    ['scr:show', { kind: 'screen_show' }],
    ['rule:add:abcd1234', { kind: 'rule_confirm', proposalId: 'abcd1234', accept: true }],
    ['rule:cancel:abcd1234', { kind: 'rule_confirm', proposalId: 'abcd1234', accept: false }],
    ['file:ok:abcd1234', { kind: 'file_confirm', confirmId: 'abcd1234', accept: true }],
    ['file:no:abcd1234', { kind: 'file_confirm', confirmId: 'abcd1234', accept: false }],
  ])('ボタン %s を解釈する', (id, expected) => {
    expect(parseInteraction(input({ customId: id }), access, allowed)).toEqual({ ok: true, ...expected });
  });

  it('選択メニューは選ばれた番号を読む', () => {
    expect(parseInteraction(input({ kind: 'select', customId: 'scr:pick:abcd1234', values: ['2'] }), access, allowed)).toEqual({
      ok: true,
      kind: 'screen_pick',
      snapshotId: 'abcd1234',
      index: 2,
    });
    expect(parseInteraction(input({ kind: 'select', customId: 'rule:rm:abcd1234', values: ['10'] }), access, allowed)).toEqual({
      ok: true,
      kind: 'rule_remove',
      listId: 'abcd1234',
      index: 10,
    });
  });

  it.each([
    ['別のサーバー', input({ guildId: '999999999999999999' }), 'guild_mismatch'],
    ['許可していない人', input({ userId: '999999999999999999' }), 'user_not_allowed'],
    ['許可していない場所', input({ conversationId: '999999999999999999' }), 'channel_not_allowed'],
    ['形の違う custom_id', input({ customId: 'perm:allow:ABCDE' }), 'invalid_custom_id'],
    ['l を含む request_id', input({ customId: 'perm:allow:abcdl' }), 'invalid_request_id'],
    ['知らない種類', input({ customId: 'perm:nope:abcde' }), 'unknown_action'],
    ['ボタンで送られた選択メニューの ID', input({ customId: 'scr:pick:abcd1234' }), 'invalid_value'],
    ['番号でない値', input({ kind: 'select', customId: 'rule:rm:abcd1234', values: ['x'] }), 'invalid_value'],
  ])('%sは受け付けない', (_label, value, reason) => {
    expect(parseInteraction(value, access, allowed)).toEqual({ ok: false, reason });
  });

  it('DM（guildId が null）でも、許可した会話なら受け付ける', () => {
    const dmChannel = '555555555555555555';
    const r = parseInteraction(input({ guildId: null, conversationId: dmChannel }), access, new Set([dmChannel]));
    expect(r.ok).toBe(true);
  });

  it('custom_id はどれも 100 字以内', () => {
    for (const action of Object.values(ACTION)) expect(customId(action, 'abcd1234').length).toBeLessThanOrEqual(100);
  });
});
