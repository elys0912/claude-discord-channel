// スラッシュコマンド（/status など）。`!` で始まるブリッジのコマンドを、Discord の入力欄の補完から選べるようにする。
// 定義（Discord に登録する JSON）と、押されたコマンドの検証・解釈を持つ純関数群（I/O なし。登録と受信は discord.ts）。
import { ApplicationCommandType, ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import type { RESTPostAPIChatInputApplicationCommandsJSONBody, RESTPostAPIContextMenuApplicationCommandsJSONBody } from 'discord.js';
import { COMMAND_SLASH_SPECS, commandFromSlash } from './commands.js';
import type { Command, SlashArgs } from './commands.js';
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

/** Discord に登録するコマンド。名前は `!` のコマンドと同じ（定義は commands.ts） */
export const SLASH_COMMANDS: readonly SlashDefinition[] = COMMAND_SLASH_SPECS.map((c) => ({
  ...simple(c.name, c.description),
  ...(c.options ? { options: c.options } : {}),
}));

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

export interface SlashInput extends SlashArgs {
  name: string;
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

  const command = commandFromSlash(input.name, input);
  if (command === undefined) return { ok: false, reason: 'unknown_command' };
  return { ok: true, command };
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
  const a = registered.map(commandShape).sort();
  const b = wanted.map(commandShape).sort();
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/** Discord が返す登録済みのコマンドのうち、比べる項目 */
interface RegisteredCommand {
  type?: number;
  name?: string;
  description?: string;
  options?: RegisteredOption[];
  contexts?: number[];
}

interface RegisteredOption {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  choices?: { name: string; value: unknown }[];
}

/**
 * 登録済みかを比べるための、コマンドを正規化した形。
 * 形は確かめずに読む。壊れた値（null の要素・配列でない options など）なら TypeError になり、
 * 呼び出し側（discord.ts）の catch が登録の失敗として扱って、登録し直さない
 */
function commandShape(command: unknown): string {
  const c = command as RegisteredCommand;
  return JSON.stringify({
    type: c.type ?? ApplicationCommandType.ChatInput,
    name: c.name,
    // 右クリックメニューの説明は、Discord が空文字で返す
    description: c.description ?? '',
    options: (c.options ?? []).map(optionShape),
    contexts: [...(c.contexts ?? [])].sort(),
  });
}

/** 引数を正規化した形（省略された required と choices は既定の値にそろえる） */
function optionShape(option: RegisteredOption): Record<string, unknown> {
  return {
    type: option.type,
    name: option.name,
    description: option.description,
    required: option.required ?? false,
    choices: (option.choices ?? []).map((choice) => [choice.name, choice.value]),
  };
}
