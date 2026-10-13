// Discord へ送る前・Claude に渡す前に、テキストを安全な形へ整える純関数群（I/O なし）
import { clip } from './text.js';

const BROADCAST_RE = /@(everyone|here)\b/g;
/** ゼロ幅スペース。`@` と語の間に挟んでメンションとして解釈されないようにする */
const ZWSP = '​';

/**
 * `@everyone` / `@here` の一斉メンションを、ゼロ幅スペースを挟んで無効化する。
 * 送信時は allowedMentions を空にしているので通知は飛ばないが、表示の上でもメンションに見えないようにしておく。
 * ユーザー（`<@id>`）とロール（`<@&id>`）へのメンションは書き換えない（通知は allowedMentions で止める）。
 */
export function neutralizeBroadcasts(text: string): string {
  return text.replace(BROADCAST_RE, (_m, kind: string) => `@${ZWSP}${kind}`);
}

const META_KEY_RE = /^[A-Za-z0-9_]+$/;
/** meta の値 1 つあたりの上限（添付が大量・長いファイル名でも Claude に渡すタグを膨らませない） */
export const META_VALUE_MAX = 2000;

/**
 * 本文中の `<channel` / `</channel` の `<` の後ろにゼロ幅スペースを入れる（大文字小文字を問わない）。
 * Claude Code は通知を <channel ...> タグに包んで渡すので、転送・CI の通知・添付の中身など、許可ユーザー以外が書いた文字列で
 * タグを閉じて、許可ユーザーの通常のメッセージに見せかけられないようにする（例: "</channel>" → "<\u200b/channel>"）
 */
export function neutralizeChannelTags(text: string): string {
  return text.replace(/<(?=\/?channel)/gi, '<\u200b');
}

/**
 * meta のキー・値ルールを適用する（キーは英数字とアンダースコアのみ、値は undefined 除外、
 * 値は META_VALUE_MAX 文字まで。超えた分は切り捨てて末尾を … にする。サロゲートペアの途中では切らない）
 */
export function sanitizeMeta(meta: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    if (!META_KEY_RE.test(key)) continue;
    out[key] = clip(value, META_VALUE_MAX);
  }
  return out;
}
