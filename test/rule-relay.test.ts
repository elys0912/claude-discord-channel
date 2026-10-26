import { describe, expect, it } from 'vitest';
import { Logger } from '../src/log.js';
import { RuleRelay } from '../src/rule-relay.js';
import type { Card } from '../src/card.js';
import type { PermissionRequest } from '../src/permission.js';

function bash(command: string): PermissionRequest {
  return { request_id: 'abcde', tool_name: 'Bash', description: '', input_preview: JSON.stringify({ command }) };
}

/** カードの文言（Markdown のエスケープを外したもの）。ルールの * などを素の形で確かめるため */
function plain(card: Card): string {
  return [card.title, card.body, card.code].filter(Boolean).join('\n').replace(/\\(.)/g, '$1');
}

function setup(deny: string[] = []) {
  const rules: string[] = [];
  const posts: { kind: 'text' | 'card' | 'update'; text: string; card?: Card }[] = [];
  let t = 0;
  let denyNow = deny;
  const relay = new RuleRelay({
    store: {
      list: () => [...rules],
      add: (r) => {
        if (rules.includes(r)) return false;
        rules.push(r);
        return true;
      },
      remove: (r) => {
        const i = rules.indexOf(r);
        if (i < 0) return false;
        rules.splice(i, 1);
        return true;
      },
    },
    loadDeny: () => denyNow,
    logger: new Logger({ stderr: false }),
    now: () => t,
    newId: () => 'prop0001',
    bridge: {
      postText: async (_c, text) => {
        posts.push({ kind: 'text', text });
        return { ts: ['10'] };
      },
      postCard: async (_c, card) => {
        posts.push({ kind: 'card', text: plain(card), card });
        return { ts: '20' };
      },
      updateCard: async (_c, _ts, card) => {
        posts.push({ kind: 'update', text: plain(card), card });
      },
    },
  });
  const pressed = { channel: 'C1', ts: '20', threadTs: '90' };
  return { relay, rules, posts, pressed, advance: (ms: number) => (t += ms), setDeny: (d: string[]) => (denyNow = d) };
}

describe('RuleRelay', () => {
  it('候補を確認のカードに出し、追加するを押したら保存して、カードを結果に書き換える', async () => {
    const { relay, rules, posts, pressed } = setup();
    await relay.propose(bash('git status'), 'C1', '90');
    expect(posts[0]?.kind).toBe('card');
    expect(posts[0]?.text).toContain('Bash(git status)');
    expect(posts[0]?.card?.buttons?.flat().map((b) => [b.label, b.id])).toEqual([
      ['追加する', 'rule:add:prop0001'],
      ['やめる', 'rule:cancel:prop0001'],
    ]);

    await relay.confirm('prop0001', true, pressed, 'U1');
    expect(rules).toEqual(['Bash(git status)']);
    expect(posts.at(-1)?.kind).toBe('update');
    expect(posts.at(-1)?.text).toContain('追加した: Bash(git status)（by U1）');
  });

  it('既にあるルールは確認を出さず、その旨を返す', async () => {
    const { relay, rules, posts } = setup();
    rules.push('Bash(git status)');
    await relay.propose(bash('git status'), 'C1', '90');
    expect(posts).toEqual([{ kind: 'text', text: expect.stringContaining('既に許可リストにある') }]);
  });

  it('deny に当たるなら確認を出さず、当たった deny を知らせる', async () => {
    const { relay, rules, posts } = setup(['Bash(git status --porcelain:*)']);
    await relay.propose(bash('git status'), 'C1', '90');

    expect(rules).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain('deny に当たる');
    expect(posts[0]?.text).toContain('Bash(git status --porcelain:*)');
  });

  it('確認の後に deny が増えていたら、追加する前に照合し直して断る', async () => {
    const { relay, rules, posts, pressed, setDeny } = setup();
    await relay.propose(bash('git status'), 'C1', '90');
    setDeny(['Bash(git:*)']);
    await relay.confirm('prop0001', true, pressed, 'U1');

    expect(rules).toEqual([]);
    expect(posts.at(-1)?.text).toContain('deny に当たる');
  });

  it('許可リストに無いコマンドは候補を作らず理由を知らせる', async () => {
    const { relay, posts } = setup();
    await relay.propose(bash('rm -rf dist'), 'C1', '90');
    expect(posts[0]?.kind).toBe('text');
    expect(posts[0]?.text).toContain('許可リストのコマンドを引数なしで呼んだものではない');
  });

  it('やめる・期限切れでは保存しない', async () => {
    const { relay, rules, posts, pressed, advance } = setup();
    await relay.propose(bash('git status'), 'C1', '90');
    await relay.confirm('prop0001', false, pressed, 'U1');
    expect(posts.at(-1)?.text).toContain('追加しなかった');

    await relay.propose(bash('git status'), 'C1', '90');
    advance(10 * 60 * 1000 + 1);
    await relay.confirm('prop0001', true, pressed, 'U1');
    expect(posts.at(-1)?.text).toContain('期限切れ');
    expect(rules).toEqual([]);
  });

  it('押したメッセージが分からなければ、結果はスレッドに投稿する', async () => {
    const { relay, posts } = setup();
    await relay.propose(bash('git status'), 'C1', '90');
    await relay.confirm('prop0001', false, { channel: 'C1', threadTs: '90' }, 'U1');
    expect(posts.at(-1)).toEqual({ kind: 'text', text: expect.stringContaining('追加しなかった') });
  });

  it('一覧は選択メニュー（value は番号）付きで出し、選んだルールを消す', async () => {
    const { relay, rules, posts, pressed } = setup();
    rules.push('Bash(git status:*)', 'WebFetch');
    await relay.list('C1', '90');
    const select = posts[0]?.card?.select;
    expect(select?.id).toBe('rule:rm:prop0001');
    expect(select?.options).toEqual([
      { label: 'Bash(git status:*)', value: '0' },
      { label: 'WebFetch', value: '1' },
    ]);

    await relay.remove('prop0001', 1, pressed, 'U1');
    expect(rules).toEqual(['Bash(git status:*)']);
    expect(posts.at(-1)?.text).toContain('消した: WebFetch');
  });

  it('消したあとの一覧や、期限切れの一覧からは消さない', async () => {
    const { relay, rules, posts, pressed, advance } = setup();
    rules.push('A', 'B', 'C');
    await relay.list('C1', '90');
    await relay.remove('prop0001', 0, pressed, 'U1');
    // 同じ一覧から続けて選ぶと、番号がずれているので消さない
    await relay.remove('prop0001', 0, pressed, 'U1');
    expect(rules).toEqual(['B', 'C']);
    expect(posts.at(-1)?.text).toContain('期限切れ');

    await relay.list('C1', '90');
    advance(10 * 60 * 1000 + 1);
    await relay.remove('prop0001', 0, pressed, 'U1');
    expect(rules).toEqual(['B', 'C']);
  });

  it('一覧は選択肢の上限（25 件）までにして、残りの件数を添える', async () => {
    const { relay, rules, posts } = setup();
    for (let i = 0; i < 30; i++) rules.push(`Rule${i}`);
    await relay.list('C1', '90');
    expect(posts[0]?.card?.select?.options).toHaveLength(25);
    expect(posts[0]?.text).toContain('30 件');
    expect(posts[0]?.text).toContain('ほか 5 件');
  });

  it('一覧が空ならその旨を返す', async () => {
    const { relay, posts } = setup();
    await relay.list('C1', '90');
    expect(posts[0]?.text).toContain('無い');
  });
});
