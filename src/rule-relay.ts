// 「♾ 今後も許可」から許可リスト（allow-extra.json）への追加を提案し、確認のうえ書き込む。`!rules` で一覧・削除もする。
// 書き込んだルールは start.ps1 が次の起動時に channel-settings.json の allow へ足す（起動中のセッションには効かない）。
import type { Card, CardColor } from './card.js';
import type { DiscordBridge } from './discord.js';
import type { Logger } from './log.js';
import { rewriteAsTextCard } from './notice.js';
import { ACTION, customId } from './permission.js';
import type { PermissionRequest } from './permission.js';
import { denyOverlaps, parseRuleForCheck, proposeRule } from './allow-rules.js';
import type { AllowRuleStore } from './allow-rule-store.js';
import { newToken } from './text.js';
import type { PressedMessage } from './types.js';

/** 追加の提案と、削除のための一覧の有効期限 */
const PROPOSAL_TTL_MS = 10 * 60 * 1000;
/** 一覧に並べる上限（選択メニューの選択肢の上限 25） */
const LIST_MAX = 25;
export type RuleBridge = Pick<DiscordBridge, 'postText' | 'postCard' | 'updateCard'>;

export interface RuleRelayOptions {
  store: Pick<AllowRuleStore, 'list' | 'add' | 'remove'>;
  /** その時点の deny（channel-settings.json と作業フォルダーの .claude/settings*.json）。呼ぶたびに読み直す */
  loadDeny: () => string[];
  bridge: RuleBridge;
  logger: Logger;
  now?: () => number;
  newId?: () => string;
}

/** 期限付きで値を覚える Map（控えの ID → 値）。期限を過ぎたものは get で返さず、prune で消す */
class ExpiringMap<V> {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(ttlMs: number, now: () => number) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  set(id: string, value: V): void {
    this.entries.set(id, { value, expiresAt: this.now() + this.ttlMs });
  }

  /** 期限内なら値。無い・期限切れなら undefined（消すのは delete か prune） */
  get(id: string): V | undefined {
    const entry = this.entries.get(id);
    return entry && this.now() <= entry.expiresAt ? entry.value : undefined;
  }

  delete(id: string): void {
    this.entries.delete(id);
  }

  prune(): void {
    const t = this.now();
    for (const [id, entry] of this.entries) if (t > entry.expiresAt) this.entries.delete(id);
  }
}

export class RuleRelay {
  private readonly opts: RuleRelayOptions;
  private readonly newId: () => string;
  /** 追加の提案の控え（ID → ルール） */
  private readonly proposals: ExpiringMap<string>;
  /** 一覧を出したときの控え（選択メニューの番号 → ルール） */
  private readonly lists: ExpiringMap<string[]>;

  constructor(opts: RuleRelayOptions) {
    this.opts = opts;
    this.newId = opts.newId ?? newToken;
    const now = opts.now ?? Date.now;
    this.proposals = new ExpiringMap(PROPOSAL_TTL_MS, now);
    this.lists = new ExpiringMap(PROPOSAL_TTL_MS, now);
  }

  /** 実行許可のリクエストから候補を作り、追加してよいかをスレッドで確認する。作れない・deny に当たるならその旨を知らせる。投げない */
  async propose(req: PermissionRequest, channel: string, threadTs: string): Promise<void> {
    const { bridge, logger } = this.opts;
    try {
      const result = proposeRule(req, this.opts.loadDeny());
      if (!result.ok) {
        const text = result.denyHits
          ? `🚫 ${result.reason}\n当たった deny: ${result.denyHits.join(', ')}\n（今回の操作は許可した）`
          : `ℹ️ 許可リストには追加しない: ${result.reason}\n（今回の操作は許可した）`;
        logger.info(`許可リストへの追加を見送り tool=${req.tool_name} 理由=${result.reason}`);
        await bridge.postText(channel, text, threadTs);
        return;
      }
      if (this.opts.store.list().includes(result.rule)) {
        await bridge.postText(channel, `ℹ️ ${result.rule} は既に許可リストにある（次に起動し直したときから有効）`, threadTs);
        return;
      }
      this.prune();
      const id = this.newId();
      this.proposals.set(id, result.rule);
      const card: Card = {
        color: 'warn',
        title: '♾ 許可リストにこのルールを追加する？',
        code: result.rule,
        note: '追加すると、次に起動し直したときから確認なしで実行される。今回の操作は許可済み。',
        buttons: [
          [
            { label: '追加する', id: customId(ACTION.RULE_ADD, id), style: 'primary' },
            { label: 'やめる', id: customId(ACTION.RULE_CANCEL, id) },
          ],
        ],
      };
      await bridge.postCard(channel, card, threadTs);
    } catch (e) {
      logger.warn('許可リストの提案に失敗', e);
    }
  }

  /** 追加の提案に答えた。追加する前に deny を読み直して、もう一度照合する。投げない */
  async confirm(proposalId: string, accept: boolean, pressed: PressedMessage, byUserId: string): Promise<void> {
    const rule = this.proposals.get(proposalId);
    this.proposals.delete(proposalId);
    if (rule === undefined) {
      await this.report(pressed, '⌛ この提案は期限切れ。もう一度「今後も許可」から提案し直すこと。', 'muted');
      return;
    }
    if (!accept) {
      await this.report(pressed, `追加しなかった: ${rule}`, 'muted');
      return;
    }
    try {
      const parsed = parseRuleForCheck(rule);
      const hits = parsed ? denyOverlaps(parsed, this.opts.loadDeny()) : [];
      if (hits.length > 0) {
        await this.report(pressed, `🚫 deny に当たるので追加しない: ${rule}\n当たった deny: ${hits.join(', ')}`, 'error');
        return;
      }
      this.opts.store.add(rule);
      this.opts.logger.info(`許可リストに追加 rule=${rule} by=${byUserId}`);
      await this.report(pressed, `✅ 許可リストに追加した: ${rule}（by ${byUserId}）\n次に起動し直したときから有効。取り消すときは !rules から消す。`, 'ok');
    } catch (e) {
      this.opts.logger.warn('許可リストへの追加に失敗', e);
      await this.report(pressed, `⚠️ 追加できなかった: ${rule}`, 'error');
    }
  }

  /** 追加分のルールを一覧し、削除の選択メニューを付けて出す。投げない */
  async list(channel: string, threadTs: string): Promise<void> {
    const { bridge, logger } = this.opts;
    try {
      const rules = this.opts.store.list();
      if (rules.length === 0) {
        await bridge.postText(channel, 'Discord から追加したルールは無い。', threadTs);
        return;
      }
      this.prune();
      const shown = rules.slice(0, LIST_MAX);
      const id = this.newId();
      this.lists.set(id, shown);
      const more = rules.length > shown.length ? `\n（ほか ${rules.length - shown.length} 件。先に上のものを消すと出てくる）` : '';
      await bridge.postCard(
        channel,
        {
          color: 'info',
          title: `Discord から追加したルール ${rules.length} 件`,
          body: `次に起動し直したときに反映される。消すものを選ぶ。${more}`,
          code: shown.join('\n'),
          select: {
            id: customId(ACTION.RULE_REMOVE, id),
            placeholder: '🗑 消すルールを選ぶ',
            options: shown.map((r, i) => ({ label: r, value: String(i) })),
          },
        },
        threadTs
      );
    } catch (e) {
      logger.warn('許可リストの一覧に失敗', e);
    }
  }

  /** 一覧で選ばれたルールを消す。投げない */
  async remove(listId: string, index: number, pressed: PressedMessage, byUserId: string): Promise<void> {
    const rule = this.lists.get(listId)?.[index];
    if (rule === undefined) {
      await this.report(pressed, '⌛ この一覧は期限切れ。もう一度 !rules から選び直すこと。', 'muted');
      return;
    }
    try {
      const removed = this.opts.store.remove(rule);
      if (removed) this.opts.logger.info(`許可リストから削除 rule=${rule} by=${byUserId}`);
      // 同じ一覧から続けて消さないよう、一覧の表示を結果に書き換える
      this.lists.delete(listId);
      await this.report(
        pressed,
        removed ? `🗑 許可リストから消した: ${rule}（次に起動し直したときから反映）` : `ℹ️ 既に無かった: ${rule}`,
        removed ? 'ok' : 'muted'
      );
    } catch (e) {
      this.opts.logger.warn('許可リストからの削除に失敗', e);
    }
  }

  /** 押されたメッセージを結果に書き換える。押されたメッセージが分からなければスレッドに投稿する。投げない */
  private async report(pressed: PressedMessage, text: string, color: CardColor): Promise<void> {
    const failureLog = '許可リストの結果の表示に失敗';
    if (pressed.ts) {
      await rewriteAsTextCard(this.opts, { channel: pressed.channel, ts: pressed.ts }, text, color, failureLog);
      return;
    }
    try {
      await this.opts.bridge.postText(pressed.channel, text, pressed.threadTs);
    } catch (e) {
      this.opts.logger.warn(failureLog, e);
    }
  }

  private prune(): void {
    this.proposals.prune();
    this.lists.prune();
  }
}
