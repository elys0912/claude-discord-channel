// スラッシュコマンド（/status など）。`!` で始まるブリッジのコマンドを、Discord の入力欄の補完から選べるようにする。
// 定義（Discord に登録する JSON）と、押されたコマンドの検証・解釈を持つ純関数群（I/O なし。登録と受信は discord.ts）。
import { ApplicationCommandOptionType, ApplicationCommandType, ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import type { RESTPostAPIChatInputApplicationCommandsJSONBody, RESTPostAPIContextMenuApplicationCommandsJSONBody } from 'discord.js';
import type { Command } from './app.js';
import type { ParsedAccess } from './config.js';

type SlashDefinition = RESTPostAPIChatInputApplicationCommandsJSONBody;
type AppCommandDefinition = SlashDefinition | RESTPostAPIContextMenuApplicationCommandsJSONBody;

/** サーバーとボットとの DM の両方で使う（ほかの人の DM やグループには出さない） */
const CONTEXTS = [InteractionContextType.Guild, InteractionContextType.BotDM];

function simple(name: string, description: string): SlashDefinition {
  return {
    type: ApplicationCommandType.ChatInput,
    name,
    description,
    contexts: CONTEXTS,
    integration_types: [ApplicationIntegrationType.GuildInstall],
  };
}

/** Discord に登録するコマンド。名前は `!` のコマンドと同じにする */
export const SLASH_COMMANDS: readonly SlashDefinition[] = [
  simple('help', 'ブリッジのコマンドの一覧'),
  simple('status', 'ブリッジの稼働状態（接続・返事待ち・実行許可・直近の hook）'),
  simple('screen', 'ターミナルの画面を見る（選択画面ならメニューで選べる）'),
  simple('stop', 'Esc を送って、Claude の今の作業を中断する'),
  {
    ...simple('keepalive', 'キャッシュのつなぎ止めの状態を見る・切り替える'),
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'mode',
        description: '切り替えるとき（省略すると状態を見るだけ）',
        required: false,
        choices: [
          { name: 'on', value: 'on' },
          { name: 'off', value: 'off' },
        ],
      },
    ],
  },
  simple('rules', '「今後も許可」で足したルールの一覧と削除'),
  simple('compact', '/compact を送り、会話を要約して縮める'),
  simple('clear', '/clear を送り、会話を捨てて新しい会話にする（元に戻せない）'),
  {
    ...simple('restart', '/exit を送り、同じ会話のまま Claude Code を起動し直す'),
    options: [
      {
        type: ApplicationCommandOptionType.Boolean,
        name: 'force',
        description: 'true なら Claude Code を強制終了してから起動し直す（応答しないとき用）',
        required: false,
      },
    ],
  },
  simple('lock', '「このセッション中は全部許可」を解除する'),
];

/** メッセージの右クリックメニュー（アプリ）の名前 */
export const FORWARD_COMMAND_NAME = 'Claude に渡す';

/** メッセージの右クリックメニュー。選んだメッセージを Claude に渡す */
export const FORWARD_COMMAND: RESTPostAPIContextMenuApplicationCommandsJSONBody = {
  type: ApplicationCommandType.Message,
  name: FORWARD_COMMAND_NAME,
  contexts: CONTEXTS,
  integration_types: [ApplicationIntegrationType.GuildInstall],
};

/** Discord に登録するコマンドすべて（スラッシュコマンドと右クリックメニュー） */
export const APP_COMMANDS: readonly AppCommandDefinition[] = [...SLASH_COMMANDS, FORWARD_COMMAND];

/** コマンドを使ってよい人と場所か。だめならその理由 */
export function checkUse(
  input: Pick<SlashInput, 'guildId' | 'userId' | 'conversationId'>,
  access: ParsedAccess,
  allowedConversations: ReadonlySet<string>
): string | undefined {
  if (input.guildId !== null && input.guildId !== access.guildId) return 'guild_mismatch';
  if (!access.allowFrom.includes(input.userId)) return 'user_not_allowed';
  if (!allowedConversations.has(input.conversationId)) return 'channel_not_allowed';
  return undefined;
}

export interface SlashInput {
  name: string;
  /** keepalive の mode */
  mode?: string | null | undefined;
  /** restart の force */
  force?: boolean | null | undefined;
  /** サーバーの中なら ID、DM なら null */
  guildId: string | null;
  userId: string;
  /** 使われた場所。スレッドの中なら親チャンネル、DM なら DM のチャンネル */
  conversationId: string;
}

export type SlashParse = { ok: true; command: Command } | { ok: false; reason: string };

/**
 * 使われたスラッシュコマンドを検証して、ブリッジのコマンドにする。次の順に調べ、最初に外れた理由で ok: false を返す:
 * サーバーの中なら guildId が access.guildId → 使った人が allowFrom → 場所が許可した DM・チャンネル → 知っているコマンドか
 */
export function parseSlashCommand(input: SlashInput, access: ParsedAccess, allowedConversations: ReadonlySet<string>): SlashParse {
  const refused = checkUse(input, access, allowedConversations);
  if (refused) return { ok: false, reason: refused };

  switch (input.name) {
    case 'help':
    case 'status':
    case 'screen':
    case 'stop':
    case 'rules':
    case 'compact':
    case 'clear':
    case 'lock':
      return { ok: true, command: input.name };
    case 'keepalive':
      if (input.mode === 'on') return { ok: true, command: 'keepalive on' };
      if (input.mode === 'off') return { ok: true, command: 'keepalive off' };
      return { ok: true, command: 'keepalive' };
    case 'restart':
      return { ok: true, command: input.force === true ? 'restart force' : 'restart' };
    default:
      return { ok: false, reason: 'unknown_command' };
  }
}

/** 使ったことを会話に残す一言（スラッシュコマンドは、ふつうのメッセージのようには残らないため） */
export function slashEcho(command: Command): string {
  return `⌨️ \`/${command}\``;
}

/**
 * 登録済みのコマンドと APP_COMMANDS が同じか。同じなら登録し直さない（起動のたびに書き換えないため）。
 * Discord が足す項目（id・version など）は比べない
 */
export function sameCommands(registered: readonly unknown[], wanted: readonly AppCommandDefinition[] = APP_COMMANDS): boolean {
  const shape = (c: unknown): string => {
    const r = c as Partial<SlashDefinition>;
    return JSON.stringify({
      type: r.type ?? ApplicationCommandType.ChatInput,
      name: r.name,
      // 右クリックメニューの説明は、Discord が空文字で返す
      description: r.description ?? '',
      options: (r.options ?? []).map((o) => {
        const opt = o as { type: number; name: string; description: string; required?: boolean; choices?: { name: string; value: unknown }[] };
        return {
          type: opt.type,
          name: opt.name,
          description: opt.description,
          required: opt.required ?? false,
          choices: (opt.choices ?? []).map((ch) => [ch.name, ch.value]),
        };
      }),
      contexts: [...(r.contexts ?? [])].sort(),
    });
  };
  const a = registered.map(shape).sort();
  const b = wanted.map(shape).sort();
  return a.length === b.length && a.every((s, i) => s === b[i]);
}
