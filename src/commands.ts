// ブリッジ自身が処理するコマンド（`!help` など）の定義表。Claude には渡さず、Claude が止まっていても使える。
// `!` の構文・`!help` の文面・スラッシュコマンドの定義と引数の読み方は、すべて COMMAND_SPECS から作る（I/O なし）。
// コマンドを足すときは COMMAND_SPECS に 1 件足し、app.ts の handleCommand に case を足す（case の書き忘れは assertNever が型エラーにする）。
import { ApplicationCommandOptionType } from 'discord.js';
import type { APIApplicationCommandOption } from 'discord.js';

/** スラッシュコマンドの引数（slash.ts が interaction から読む） */
export interface SlashArgs {
  /** keepalive の mode */
  mode?: string | null | undefined;
  /** restart の force */
  force?: boolean | null | undefined;
}

interface CommandSpec<Form extends string> {
  /** スラッシュコマンドの名前。`!` の後ろの最初の語と同じ */
  name: NoInfer<Form>;
  /** `!` で受け付ける形（小文字・空白 1 つ）。引数の付いた形も 1 つずつ並べる */
  forms: readonly Form[];
  /** `!help` に出す行 */
  help: readonly string[];
  /** スラッシュコマンドの説明（Discord の上限は 100 字） */
  description: string;
  options?: APIApplicationCommandOption[];
  /** スラッシュコマンドの引数から forms のどれかを選ぶ。省略時は name */
  fromSlash?: (args: SlashArgs) => NoInfer<Form>;
}

/** forms の文字列をリテラルの型のまま受け取り、name と fromSlash がそのどれかであることを型で確かめる */
function spec<const Form extends string>(definition: CommandSpec<Form>): CommandSpec<Form> {
  return definition;
}

/** 並びは `!help` の行の順 */
const COMMAND_SPECS = [
  spec({
    name: 'help',
    forms: ['help'],
    help: ['• `!help` … この一覧'],
    description: 'ブリッジのコマンドの一覧',
  }),
  spec({
    name: 'status',
    forms: ['status'],
    help: ['• `!status` … ブリッジの稼働状態'],
    description: 'ブリッジの稼働状態（接続・返事待ち・実行許可・直近の hook）',
  }),
  spec({
    name: 'screen',
    forms: ['screen'],
    help: ['• `!screen` … ターミナルの画面を見る（選択画面なら選択メニューで選べる）'],
    description: 'ターミナルの画面を見る（選択画面ならメニューで選べる）',
  }),
  spec({
    name: 'stop',
    forms: ['stop'],
    help: ['• `!stop` … Esc を送って、Claude の今の作業を中断する'],
    description: 'Esc を送って、Claude の今の作業を中断する',
  }),
  spec({
    name: 'keepalive',
    forms: ['keepalive', 'keepalive on', 'keepalive off'],
    help: ['• `!keepalive on` / `!keepalive off` … キャッシュのつなぎ止めを切り替える（`!keepalive` だけなら状態を見る）'],
    description: 'キャッシュのつなぎ止めの状態を見る・切り替える',
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
    fromSlash: ({ mode }) => {
      if (mode === 'on') return 'keepalive on';
      if (mode === 'off') return 'keepalive off';
      return 'keepalive';
    },
  }),
  spec({
    name: 'rules',
    forms: ['rules'],
    help: ['• `!rules` … Discord から足した許可ルールの一覧と削除'],
    description: '「今後も許可」で足したルールの一覧と削除',
  }),
  spec({
    name: 'compact',
    forms: ['compact'],
    help: ['• `!compact` … /compact を送る（会話を要約して縮める）'],
    description: '/compact を送り、会話を要約して縮める',
  }),
  spec({
    name: 'clear',
    forms: ['clear'],
    help: ['• `!clear` … /clear を送る（会話を捨てて新しい会話にする）'],
    description: '/clear を送り、会話を捨てて新しい会話にする（元に戻せない）',
  }),
  spec({
    name: 'lock',
    forms: ['lock'],
    help: ['• `!lock` … 「このセッション中は全部許可」を解除する（使えるボットだけ）'],
    description: '「このセッション中は全部許可」を解除する',
  }),
  spec({
    name: 'restart',
    forms: ['restart', 'restart force'],
    help: [
      '• `!restart` … /exit を送って起動し直す（会話は引き継ぐ）',
      '• `!restart force` … Claude Code を強制終了して起動し直す（応答しないとき用）',
    ],
    description: '/exit を送り、同じ会話のまま Claude Code を起動し直す',
    options: [
      {
        type: ApplicationCommandOptionType.Boolean,
        name: 'force',
        description: 'true なら Claude Code を強制終了してから起動し直す（応答しないとき用）',
        required: false,
      },
    ],
    fromSlash: ({ force }) => (force === true ? 'restart force' : 'restart'),
  }),
] as const;

/** ブリッジのコマンド（`!` の形を小文字・空白 1 つに正規化したもの） */
export type Command = (typeof COMMAND_SPECS)[number]['forms'][number];

/** スラッシュコマンドとして登録する名前・説明・引数 */
export type CommandSlashSpec = Pick<CommandSpec<Command>, 'name' | 'description' | 'options'>;

const COMMANDS: readonly Command[] = COMMAND_SPECS.flatMap((s) => s.forms);

function isCommand(name: string): name is Command {
  return (COMMANDS as readonly string[]).includes(name);
}

/** Claude に渡さず、ブリッジ自身が処理するコマンド。形の中の空白は 1 つ以上の空白として受け付ける */
const COMMAND_RE = new RegExp(String.raw`^\s*!(${COMMANDS.map((c) => c.split(' ').join(String.raw`\s+`)).join('|')})\s*$`, 'i');

/** 本文がブリッジのコマンドならその名前（小文字・空白 1 つに正規化）を返す */
export function parseCommand(content: string): Command | undefined {
  const m = COMMAND_RE.exec(content);
  const name = m?.[1]?.toLowerCase().replace(/\s+/g, ' ');
  return name !== undefined && isCommand(name) ? name : undefined;
}

/** `!help` の文面 */
export const HELP_TEXT = [
  '📖 ブリッジのコマンド（Claude には渡さず、ブリッジが処理する。Claude が止まっていても使える。`!` の代わりに `/` で始めると、補完から選べる）',
  ...COMMAND_SPECS.flatMap((s) => s.help),
].join('\n');

/**
 * スラッシュコマンドとして登録するもの。並びは `!help` の行の順で、lock だけを最後にする。
 * Discord に登録する JSON の並びを、表にまとめる前の登録順（restart → lock）から変えないため
 */
export const COMMAND_SLASH_SPECS: readonly CommandSlashSpec[] = [
  ...COMMAND_SPECS.filter((s) => s.name !== 'lock'),
  ...COMMAND_SPECS.filter((s) => s.name === 'lock'),
];

/** スラッシュコマンドの名前と引数をブリッジのコマンドにする。知らない名前なら undefined */
export function commandFromSlash(name: string, args: SlashArgs): Command | undefined {
  const found = COMMAND_SPECS.find((s) => s.name === name);
  if (!found) return undefined;
  return found.fromSlash?.(args) ?? found.name;
}
