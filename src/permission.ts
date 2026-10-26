// 実行許可（permission relay）に関する純関数群（I/O なし）。
// 実行許可のカード、ボタン・選択メニューの解釈。保留中のリクエストの管理と文字の整え方は permission-core.ts
import type { Card, CardButton } from './card.js';
import { md } from './card.js';
import type { ParsedAccess } from './config.js';
import type { Verdict } from './types.js';
import { isValidRequestId, DEFAULT_PREVIEW_LIMIT, truncatePlain, truncateHeadTail, PREVIEW_TRUNCATED_WARNING, orPlaceholder, TOKEN_ID_RE } from './permission-core.js';
import type { PermissionRequest } from './permission-core.js';

// チャネルによらない部分は permission-core.ts。ほかのモジュールからは今までどおりここから使える
export { PERMISSION_ID_BODY, PERMISSION_ID_RE, isValidRequestId, PendingPermissions, DEFAULT_PREVIEW_LIMIT, revealInvisible, truncatePlain, truncateHeadTail, PREVIEW_TRUNCATED_WARNING, orPlaceholder, TOKEN_ID_RE } from './permission-core.js';
export type { PermissionRequest } from './permission-core.js';

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
  FILE_OK: 'file:ok',
  FILE_NO: 'file:no',
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
  sessionButton = false,
  /** 「今後も許可」ボタンを付けるか（許可リストに足せるルールを作れるリクエストだけ） */
  alwaysButton = false
): { card: Card; truncated: boolean } {
  const toolName = truncatePlain(orPlaceholder(req.tool_name, '(不明なツール)'), FIELD_LIMIT);
  const description = truncatePlain(orPlaceholder(req.description, '(説明なし)'), FIELD_LIMIT);
  const preview = truncateHeadTail(orPlaceholder(req.input_preview, '(入力なし)'), previewLimit);
  const truncated = toolName.truncated || description.truncated || preview.truncated;

  const id = req.request_id;
  const buttons: CardButton[] = [
    { label: 'Allow', id: customId(ACTION.ALLOW, id), style: 'success' },
    ...(alwaysButton ? [{ label: '♾ 今後も許可', id: customId(ACTION.ALLOW_ALWAYS, id) }] : []),
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
  /** 送ってよい場所の外のファイルを送るかの確認に答える */
  | { ok: true; kind: 'file_confirm'; confirmId: string; accept: boolean }
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
    case ACTION.FILE_OK:
    case ACTION.FILE_NO:
      if (!token) return { ok: false, reason: 'invalid_value' };
      return { ok: true, kind: 'file_confirm', confirmId: token, accept: action === ACTION.FILE_OK };
    default:
      return { ok: false, reason: 'unknown_action' };
  }
}
