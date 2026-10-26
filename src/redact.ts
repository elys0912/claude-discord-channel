// ログと画面の中継から伏せる、Discord 固有のトークンの形（I/O なし）。

// Discord のボットのトークン（`<ユーザー ID の base64>.<時刻>.<署名>` の 3 つの部分）、Webhook の URL に含まれるトークン、
// Authorization ヘッダーの値（Bot / Bearer）をログから伏せる。
const DISCORD_TOKEN_RE = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{25,}/g;
const WEBHOOK_URL_RE = /(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[\w-]+/g;
// 「Bot ready」のような普通の文を伏せないよう、トークンらしい長さ（16 文字以上）の値だけを対象にする
const AUTH_HEADER_RE = /\b(Bot|Bearer)\s+[\w.~+/=-]{16,}/g;

/** このチャネルのトークンの形を伏せる（log.ts の redact が、共通の鍵の形と一緒に使う） */
export function redactChannelSecrets(s: string): string {
  return s
    .replace(WEBHOOK_URL_RE, '$1***')
    .replace(DISCORD_TOKEN_RE, '***')
    .replace(AUTH_HEADER_RE, (_m, kind: string) => `${kind} ***`);
}
