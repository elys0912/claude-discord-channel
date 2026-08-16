// 実行許可（permission relay）に関する純関数群（I/O なし）。
// 保留中のリクエストの管理、表示する前の文字の整え方（不可視文字・切り詰め）、実行許可のカード、ボタン・選択メニューの解釈を置く。
import type { Card, CardButton } from './card.js';
import { md } from './card.js';
import type { ParsedAccess } from './config.js';
import { TOKEN_ID_LENGTH } from './text.js';
import type { Verdict } from './types.js';

export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

/** request_id の文字集合（小文字 5 文字、l を除く）。gate.ts の返信パターンもこれから組み立てる */
export const PERMISSION_ID_BODY = '[a-km-z]{5}';
export const PERMISSION_ID_RE = new RegExp(`^${PERMISSION_ID_BODY}$`);

export function isValidRequestId(id: string): boolean {
  return PERMISSION_ID_RE.test(id);
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

interface PendingEntry {
  req: PermissionRequest;
  expiresAt: number;
}

/** 保留中の permission request を TTL 付きで管理する（時刻注入でテスト可能） */
export class PendingPermissions {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly store: Map<string, PendingEntry>;

  constructor(ttlMs: number = DEFAULT_TTL_MS, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.store = new Map();
  }

  /** 有効期限（ミリ秒） */
  get ttl(): number {
    return this.ttlMs;
  }

  add(req: PermissionRequest): void {
    this.store.set(req.request_id, { req, expiresAt: this.now() + this.ttlMs });
  }

  /** 期限内なら返すだけで残す（See more 用）。期限切れならここで消して undefined */
  get(id: string): PermissionRequest | undefined {
    const entry = this.store.get(id);
    if (!entry) return undefined;
    if (this.now() > entry.expiresAt) {
      this.store.delete(id);
      return undefined;
    }
    return entry.req;
  }

  /** 取り出して消す（回答用。同じ ID に二度答えさせない）。期限切れなら消したうえで undefined */
  take(id: string): PermissionRequest | undefined {
    const entry = this.store.get(id);
    if (!entry) return undefined;
    this.store.delete(id);
    if (this.now() > entry.expiresAt) return undefined;
    return entry.req;
  }

  /** 期限に関係なく取り出して消す（自動 deny 用） */
  remove(id: string): PermissionRequest | undefined {
    const entry = this.store.get(id);
    this.store.delete(id);
    return entry?.req;
  }

  prune(): void {
    const t = this.now();
    for (const [id, entry] of this.store) {
      if (t > entry.expiresAt) this.store.delete(id);
    }
  }
}

/** input_preview を表示する長さの既定（超えたら先頭と末尾を残して間を省略する） */
export const DEFAULT_PREVIEW_LIMIT = 2800;

/**
 * 表示を偽装できる不可視文字。承認画面で実際と違う内容に見せられないよう、`\u{202E}` の形で見えるようにする。
 * - 双方向制御: U+202A-202E / U+2066-2069 と、向きの印 U+200E-200F / U+061C
 * - ゼロ幅・結合制御: U+200B-200D / U+2060-2064 / U+034F / U+180E、BOM U+FEFF
 * - 空白に見える埋め文字: U+00AD（ソフトハイフン）/ U+115F-1160 / U+17B4-17B5 / U+3164 / U+FFA0
 * - C0・C1 制御文字（タブ・改行・復帰は除く）: U+0000-0008 / U+000B-000C / U+000E-001F / U+007F-009F
 */
// 制御文字・不可視文字をわざと列挙しているので、それらを禁じる lint は外す
const INVISIBLE_RE =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class, no-irregular-whitespace
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁦-⁩ㅤ﻿ﾠ]/;

function visibleUnit(ch: string): string {
  if (!INVISIBLE_RE.test(ch)) return ch;
  return `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase()}}`;
}

/** 表示単位（コードポイント 1 つ、または不可視文字のエスケープ 1 つ）に分ける。途中で切ってもサロゲートやエスケープが割れない */
function toVisibleUnits(text: string): string[] {
  return Array.from(text, visibleUnit);
}

/** 不可視文字を `\u{XXXX}` に置き換える（See more の全文表示でも使う） */
export function revealInvisible(text: string): string {
  return toVisibleUnits(text).join('');
}

/** units の先頭から、UTF-16 長の合計が budget 以内に収まるだけ取る */
function takeHead(units: readonly string[], budget: number): string[] {
  const out: string[] = [];
  let len = 0;
  for (const u of units) {
    if (len + u.length > budget) break;
    out.push(u);
    len += u.length;
  }
  return out;
}

function unitsLength(units: readonly string[]): number {
  return units.reduce((n, u) => n + u.length, 0);
}

/** 不可視文字を見えるようにしたうえで、maxLen 以内に先頭だけ残して切り詰める */
export function truncatePlain(text: string, maxLen: number): { text: string; truncated: boolean } {
  const units = toVisibleUnits(text);
  if (unitsLength(units) <= maxLen) return { text: units.join(''), truncated: false };
  return { text: takeHead(units, Math.max(0, maxLen - 1)).join('') + '…', truncated: true };
}

/** 切り詰めたプレビューの末尾側に残す割合（既定 2800 なら 省略表示を除いて 先頭 約 2200 + 末尾 約 600） */
const PREVIEW_TAIL_RATIO = 0.22;

/**
 * input_preview 用: 長いときは先頭と末尾の両方を残し、間に省略した文字数を入れる。
 * コマンドの末尾に危険な部分を置いて先頭だけ見せる、という偽装を防ぐため。
 */
export function truncateHeadTail(text: string, maxLen: number): { text: string; truncated: boolean } {
  const units = toVisibleUnits(text);
  const total = unitsLength(units);
  if (total <= maxLen) return { text: units.join(''), truncated: false };

  // 省略表示の桁数は total 以下なので、total で見積もれば長さの上限を超えない
  const marker = (n: number) => `\n…（途中 ${n} 文字省略）…\n`;
  const budget = Math.max(0, maxLen - marker(total).length);
  const tailBudget = Math.floor(budget * PREVIEW_TAIL_RATIO);
  const head = takeHead(units, budget - tailBudget);
  const tail = takeHead([...units.slice(head.length)].reverse(), tailBudget).reverse();
  const omitted = total - unitsLength(head) - unitsLength(tail);
  return { text: head.join('') + marker(omitted) + tail.join(''), truncated: true };
}

export const PREVIEW_TRUNCATED_WARNING =
  '⚠️ 入力が長いため途中を省略している。許可する前に See more で全文を確認すること';

/** 空（空白だけ）の欄は、代わりの文言にして表示する */
export function orPlaceholder(text: string, placeholder: string): string {
  return text.trim() === '' ? placeholder : text;
}

/** 画面の控え・提案の ID（ブリッジが発行する英小文字と数字 TOKEN_ID_LENGTH 文字。text.ts の newToken が作る） */
export const TOKEN_ID_RE = new RegExp(`^[a-z0-9]{${TOKEN_ID_LENGTH}}$`);

// --- 実行許可のカード（Discord に出す形は card.ts が決める） ---------------------------

/** ツール名・説明を表示する長さの上限（embed の本文 4096 字に、プレビューと合わせて収める） */
const FIELD_LIMIT = 300;

/**
 * ボタン・選択メニューの custom_id。`<group>:<action>[:<value>]` の形で 100 字に収める。
 * 出す側（この module・screen-relay.ts・rule-relay.ts）と解釈する側（parseInteraction）で共用する
 */
export const ACTION = {
  ALLOW: 'perm:allow',
  ALLOW_ALWAYS: 'perm:always',
  ALLOW_SESSION: 'perm:session',
  DENY: 'perm:deny',
  SEE_MORE: 'perm:more',
  SCREEN_SHOW: 'scr:show',
  SCREEN_PICK: 'scr:pick',
  RULE_ADD: 'rule:add',
  RULE_CANCEL: 'rule:cancel',
  RULE_REMOVE: 'rule:rm',
} as const;

type ActionName = (typeof ACTION)[keyof typeof ACTION];

/** custom_id を組む（value は英小文字と数字） */
export function customId(action: ActionName, value?: string): string {
  return value === undefined ? action : `${action}:${value}`;
}

/** Discord のユーザー ID の形 */
const USER_ID_RE = /^\d{17,20}$/;

/**
 * 実行許可を求めるカードを組み立てる。不可視文字はどの欄も `\u{XXXX}` にして表示する。
 * - tool_name / description: FIELD_LIMIT で先頭だけ残し、末尾を … にする
 * - input_preview: previewLimit（既定 2800）を超えたら先頭と末尾を残し、間に省略した文字数を入れ、警告を足す
 * - どれかを省略したときだけ See more ボタンを付ける（戻り値の truncated も同じ条件）
 */
export function buildPermissionCard(
  req: PermissionRequest,
  previewLimit: number = DEFAULT_PREVIEW_LIMIT,
  /** 「このセッション中は全部許可」ボタンを付けるか */
  sessionButton = false
): { card: Card; truncated: boolean } {
  const toolName = truncatePlain(orPlaceholder(req.tool_name, '(不明なツール)'), FIELD_LIMIT);
  const description = truncatePlain(orPlaceholder(req.description, '(説明なし)'), FIELD_LIMIT);
  const preview = truncateHeadTail(orPlaceholder(req.input_preview, '(入力なし)'), previewLimit);
  const truncated = toolName.truncated || description.truncated || preview.truncated;

  const id = req.request_id;
  const buttons: CardButton[] = [
    { label: 'Allow', id: customId(ACTION.ALLOW, id), style: 'success' },
    { label: '♾ 今後も許可', id: customId(ACTION.ALLOW_ALWAYS, id) },
    ...(sessionButton ? [{ label: '🔓 このセッション中は全部許可', id: customId(ACTION.ALLOW_SESSION, id) }] : []),
    { label: 'Deny', id: customId(ACTION.DENY, id), style: 'danger' },
    // 省略した部分があるときだけ、全文を出すボタンを付ける
    ...(truncated ? [{ label: 'See more', id: customId(ACTION.SEE_MORE, id) }] : []),
  ];

  const card: Card = {
    color: 'info',
    title: '🔐 実行許可',
    body: [`**Tool:** ${md(toolName.text)}`, md(description.text), ...(preview.truncated ? [PREVIEW_TRUNCATED_WARNING] : [])].join('\n'),
    code: preview.text,
    note: `ID: ${id} ／ "yes ${id}" / "no ${id}" と返信しても答えられる`,
    buttons: [buttons],
  };
  return { card, truncated };
}

/** ボタンのカードを、答えが決まった表示に書き換える */
export function buildResolvedCard(req: PermissionRequest, behavior: 'allow' | 'deny', byUserId: string): Card {
  const allow = behavior === 'allow';
  const toolName = truncatePlain(orPlaceholder(req.tool_name, '(不明なツール)'), FIELD_LIMIT);
  // ユーザー ID の形のときだけメンション表示にする（通知は allowedMentions で止めている）
  const by = USER_ID_RE.test(byUserId) ? `<@${byUserId}>` : md(orPlaceholder(byUserId, '(不明)'));
  return {
    color: allow ? 'ok' : 'muted',
    title: `${allow ? '✅ 許可した' : '❌ 拒否した'}: ${toolName.text}`,
    body: `ID: ${md(orPlaceholder(req.request_id, '-'))} ・ by ${by}`,
  };
}

export function buildExpiredCard(requestId: string): Card {
  return { color: 'muted', body: `⌛ 実行許可 ${md(requestId)} は期限切れ` };
}

/** 回答が無いまま自動で拒否したときの表示。reason は「期限切れ」のような固定の文言（「〜のため自動で拒否した」に続く） */
export function buildAutoDeniedCard(requestId: string, reason: string): Card {
  return { color: 'muted', body: `⌛ 実行許可 ${md(requestId)}: ${reason}のため自動で拒否した` };
}

/** 回答を Claude に送れなかったときの表示（MCP の切断など。Claude 側は自分の期限で止まる） */
export function buildVerdictFailedCard(requestId: string, behavior: 'allow' | 'deny'): Card {
  const verb = behavior === 'allow' ? 'Allow' : 'Deny';
  return { color: 'error', body: `⚠️ 実行許可 ${md(requestId)}: ${verb} を Claude に送れなかった。Claude Code のセッションを確かめること` };
}

// --- ボタン・選択メニューの解釈 ---------------------------------------------------------

export interface InteractionInput {
  /** ボタンか選択メニューか（それ以外は呼び出し側で捨てる） */
  kind: 'button' | 'select';
  customId: string;
  /** 選択メニューで選ばれた値 */
  values?: string[] | undefined;
  /** サーバーの中なら ID、DM なら null */
  guildId: string | null;
  userId: string;
  /** 押された場所。スレッドの中なら親チャンネル、DM なら DM のチャンネル */
  conversationId: string;
}

export type ActionParse =
  | { ok: true; kind: 'verdict'; verdict: Verdict }
  | { ok: true; kind: 'see_more'; requestId: string }
  /** 今回は許可し、同じ種類の操作を許可リストに足す提案を出す */
  | { ok: true; kind: 'allow_always'; requestId: string }
  /** 今回は許可し、このセッション中は settings の ask / deny 以外を自動で許可する */
  | { ok: true; kind: 'allow_session'; requestId: string }
  /** ターミナルの画面を確認する */
  | { ok: true; kind: 'screen_show' }
  /** 画面の選択肢を選ぶ（snapshotId は画面を見せたときの控え） */
  | { ok: true; kind: 'screen_pick'; snapshotId: string; index: number }
  /** 許可リストへの追加の提案に答える */
  | { ok: true; kind: 'rule_confirm'; proposalId: string; accept: boolean }
  /** 許可リストから追加分のルールを消す（listId は一覧を出したときの控え、index はその中の番号） */
  | { ok: true; kind: 'rule_remove'; listId: string; index: number }
  | { ok: false; reason: string };

const CUSTOM_ID_RE = /^([a-z]+:[a-z]+)(?::([a-z0-9]{1,16}))?$/;
/** 選択メニューの値（番号）。screen.ts の選択肢は 9 個まで、rule-relay の一覧は 25 個まで */
const INDEX_VALUE_RE = /^\d{1,2}$/;

/**
 * ボタン・選択メニューの操作を検証して解釈する。次の順に調べ、最初に外れた理由で ok: false を返す:
 * サーバーの中なら guildId が access.guildId → 押した人が allowFrom → 場所が許可した DM・チャンネル
 * → custom_id の形 → 種類ごとの値の形。保留中の ID かどうかはここでは見ない（呼び出し側の relay が判断する）。
 */
export function parseInteraction(
  input: InteractionInput,
  access: ParsedAccess,
  allowedConversations: ReadonlySet<string>
): ActionParse {
  if (input.guildId !== null && input.guildId !== access.guildId) return { ok: false, reason: 'guild_mismatch' };
  if (!access.allowFrom.includes(input.userId)) return { ok: false, reason: 'user_not_allowed' };
  if (!allowedConversations.has(input.conversationId)) return { ok: false, reason: 'channel_not_allowed' };

  const m = CUSTOM_ID_RE.exec(input.customId);
  if (!m) return { ok: false, reason: 'invalid_custom_id' };
  const action = m[1] ?? '';
  const value = m[2];
  const requestId = value !== undefined && isValidRequestId(value) ? value : undefined;
  const token = value !== undefined && TOKEN_ID_RE.test(value) ? value : undefined;
  const picked = input.values?.[0];
  const index = picked !== undefined && INDEX_VALUE_RE.test(picked) ? Number(picked) : undefined;

  switch (action) {
    case ACTION.ALLOW:
    case ACTION.DENY:
      if (!requestId) return { ok: false, reason: 'invalid_request_id' };
      return { ok: true, kind: 'verdict', verdict: { requestId, behavior: action === ACTION.ALLOW ? 'allow' : 'deny' } };
    case ACTION.SEE_MORE:
      return requestId ? { ok: true, kind: 'see_more', requestId } : { ok: false, reason: 'invalid_request_id' };
    case ACTION.ALLOW_ALWAYS:
      return requestId ? { ok: true, kind: 'allow_always', requestId } : { ok: false, reason: 'invalid_request_id' };
    case ACTION.ALLOW_SESSION:
      return requestId ? { ok: true, kind: 'allow_session', requestId } : { ok: false, reason: 'invalid_request_id' };
    case ACTION.SCREEN_SHOW:
      return { ok: true, kind: 'screen_show' };
    case ACTION.SCREEN_PICK:
      if (input.kind !== 'select' || !token || index === undefined) return { ok: false, reason: 'invalid_value' };
      return { ok: true, kind: 'screen_pick', snapshotId: token, index };
    case ACTION.RULE_ADD:
    case ACTION.RULE_CANCEL:
      if (!token) return { ok: false, reason: 'invalid_value' };
      return { ok: true, kind: 'rule_confirm', proposalId: token, accept: action === ACTION.RULE_ADD };
    case ACTION.RULE_REMOVE:
      if (input.kind !== 'select' || !token || index === undefined) return { ok: false, reason: 'invalid_value' };
      return { ok: true, kind: 'rule_remove', listId: token, index };
    default:
      return { ok: false, reason: 'unknown_action' };
  }
}
