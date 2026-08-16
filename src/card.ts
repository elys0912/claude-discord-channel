// 中立な「カード」（題・本文・コード・注記・ボタン・選択メニュー）を、Discord の embed とコンポーネントの JSON に変える純関数（I/O なし）。
// relay 群は Discord の型を知らず Card だけを組む。上限（文字数・ボタンの数）はここで守る。
import { ButtonStyle, ComponentType, escapeMarkdown } from 'discord.js';
import type { APIActionRowComponent, APIComponentInMessageActionRow, APIEmbed } from 'discord.js';

/** Discord の上限（https://docs.discord.com/developers/resources/message の embed とコンポーネントの節） */
export const LIMITS = {
  title: 256,
  description: 4096,
  footer: 2048,
  buttonLabel: 80,
  customId: 100,
  rows: 5,
  buttonsPerRow: 5,
  selectOptions: 25,
  selectText: 100,
  placeholder: 150,
} as const;

export type CardColor = 'info' | 'ok' | 'warn' | 'error' | 'muted';

/** お知らせの色（D6） */
export const COLORS: Record<CardColor, number> = {
  info: 0x5b8def,
  ok: 0x30a46c,
  warn: 0xf5a524,
  error: 0xe5484d,
  muted: 0x8b8d98,
};

export interface CardButton {
  label: string;
  id: string;
  style?: 'primary' | 'secondary' | 'success' | 'danger' | undefined;
}

export interface CardSelect {
  id: string;
  placeholder: string;
  options: { label: string; value: string; description?: string | undefined }[];
}

export interface Card {
  color?: CardColor | undefined;
  title?: string | undefined;
  /** Markdown として表示される。外から来た文字は md() でエスケープしてから入れる */
  body?: string | undefined;
  /** コードブロックに入れて本文の後ろに置く（エスケープ不要） */
  code?: string | undefined;
  note?: string | undefined;
  /** 行 × ボタン。行は 5 つ、1 行のボタンは 5 つまで */
  buttons?: CardButton[][] | undefined;
  select?: CardSelect | undefined;
}

export interface DiscordPayload {
  embeds: APIEmbed[];
  components: APIActionRowComponent<APIComponentInMessageActionRow>[];
  /** 文字数の上限で切り詰めたか */
  truncated: boolean;
}

/** 外から来た文字を、embed の本文で Markdown として解釈されないようにする */
export function md(text: string): string {
  return escapeMarkdown(text);
}

/** 末尾を … にして max 文字に収める（サロゲートペアの途中では切らない） */
export function clipTo(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  let cut = Math.max(0, max - 1);
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return { text: text.slice(0, cut) + '…', clipped: true };
}

/** コードを ``` で包む。中の行頭の ``` はゼロ幅スペースを前置して、フェンスの開閉と誤認されないようにする */
export function fence(code: string): string {
  return '```\n' + code.replace(/^```/gm, '​```') + '\n```';
}

type CustomIdButtonStyle = ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Success | ButtonStyle.Danger;

const BUTTON_STYLES: Record<NonNullable<CardButton['style']>, CustomIdButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

function assertCustomId(id: string): void {
  if (id.length === 0 || id.length > LIMITS.customId) {
    throw new Error(`custom_id の長さが不正（${id.length} 文字。1〜${LIMITS.customId}）`);
  }
}

/** 本文とコードを、description の上限に収まるように組む。はみ出すときはコードを先に削る */
function buildDescription(body: string | undefined, code: string | undefined): { text: string | undefined; clipped: boolean } {
  const head = body ?? '';
  if (code === undefined) {
    if (head === '') return { text: undefined, clipped: false };
    return clipTo(head, LIMITS.description);
  }
  const sep = head === '' ? '' : '\n';
  const wrapperLength = fence('').length + sep.length;
  const budget = LIMITS.description - head.length - wrapperLength;
  if (budget < 1) {
    // 本文だけで上限に届くなら、コードは諦めて本文を切る
    return { text: clipTo(head, LIMITS.description).text, clipped: true };
  }
  const clippedCode = clipTo(code, budget);
  return { text: head + sep + fence(clippedCode.text), clipped: clippedCode.clipped };
}

/**
 * Card を Discord に送る形にする。文字数の上限を超えた部分は切り詰め、truncated で知らせる。
 * ボタンや行の数・custom_id の長さが上限を超えたら投げる（組み立てる側の誤りなので、黙って落とさない）。
 */
export function toDiscord(card: Card): DiscordPayload {
  let truncated = false;
  const embed: APIEmbed = {};
  if (card.color) embed.color = COLORS[card.color];
  if (card.title) {
    const t = clipTo(card.title, LIMITS.title);
    embed.title = t.text;
    truncated ||= t.clipped;
  }
  const description = buildDescription(card.body, card.code);
  if (description.text !== undefined) embed.description = description.text;
  truncated ||= description.clipped;
  if (card.note) {
    const n = clipTo(card.note, LIMITS.footer);
    embed.footer = { text: n.text };
    truncated ||= n.clipped;
  }
  // 中身の無い embed は送れないので、題も本文も無ければ空白を 1 つ入れる
  if (embed.title === undefined && embed.description === undefined) embed.description = '​';

  const components: DiscordPayload['components'] = [];
  for (const row of card.buttons ?? []) {
    if (row.length === 0) continue;
    if (row.length > LIMITS.buttonsPerRow) throw new Error(`1 行のボタンが多すぎる（${row.length} 個）`);
    components.push({
      type: ComponentType.ActionRow,
      components: row.map((b) => {
        assertCustomId(b.id);
        return {
          type: ComponentType.Button,
          style: BUTTON_STYLES[b.style ?? 'secondary'],
          label: clipTo(b.label, LIMITS.buttonLabel).text,
          custom_id: b.id,
        };
      }),
    });
  }
  if (card.select) {
    const s = card.select;
    assertCustomId(s.id);
    if (s.options.length === 0 || s.options.length > LIMITS.selectOptions) {
      throw new Error(`選択メニューの選択肢の数が不正（${s.options.length} 個）`);
    }
    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          custom_id: s.id,
          placeholder: clipTo(s.placeholder, LIMITS.placeholder).text,
          options: s.options.map((o) => ({
            label: clipTo(o.label, LIMITS.selectText).text,
            value: clipTo(o.value, LIMITS.selectText).text,
            ...(o.description ? { description: clipTo(o.description, LIMITS.selectText).text } : {}),
          })),
        },
      ],
    });
  }
  if (components.length > LIMITS.rows) throw new Error(`コンポーネントの行が多すぎる（${components.length} 行）`);

  return { embeds: [embed], components, truncated };
}
