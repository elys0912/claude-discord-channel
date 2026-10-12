// Discord と Claude Code（MCP）をつなぐ配線。import 時の副作用は持たない（プロセス周りは main.ts）。
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { errMessage } from './errors.js';
import type { Logger } from './log.js';
import type { InstanceLock } from './lock.js';
import type { DiscordBridge, ActionContext, InboundRef } from './discord.js';
import { ChannelServer } from './mcp.js';
import type { McpDeps } from './mcp.js';
import { PermissionRelay } from './permission-relay.js';
import { revealInvisible } from './permission.js';
import type { ActionParse } from './permission.js';
import type { GateResult } from './gate.js';
import type { PressedMessage, ThreadRef } from './types.js';
import { SessionControl } from './session-control.js';
import type { SessionControlOptions } from './session-control.js';
import { buildStatusText } from './status.js';
import { ResponseWatchdog, buildNoResponseText } from './watchdog.js';
import type { ConsoleAccess } from './console.js';
import { ScreenRelay, noticeCard } from './screen-relay.js';
import { RuleRelay } from './rule-relay.js';
import { AllowRuleStore, readAsk, readDeny } from './allow-rules.js';
import { SessionAllowAll } from './session-allow.js';
import { downloadAttachment } from './download.js';
import type { DownloadDeps } from './download.js';
import { HookInbox } from './hook-inbox.js';
import { hookToNotice } from './hook-notices.js';
import { NoticePoster } from './notice.js';
import { FileSender } from './send-file.js';
import { Keepalive } from './keepalive.js';
import type { QuietHours } from './keepalive.js';
import { formatTime } from './text.js';
import { TypingIndicator } from './typing.js';
import { PresenceUpdater } from './presence.js';
import { inlineTextAttachments } from './inline-text.js';
import type { InlineDeps } from './inline-text.js';

// Discord 側で「読んだ」「許可した」「拒否した」を示すリアクション
export const REACTION = {
  SEEN: '👀',
  ALLOW: '✅',
  DENY: '❌',
} as const;

// --- 依存の型（テストで差し替えられるよう、使うメソッドだけに絞る） -------------

/** MCP ツール（reply / react / edit_message）が使う Discord 側の操作 */
export type ToolBridge = Pick<DiscordBridge, 'postText' | 'addReaction' | 'updateText'>;

/** 受信処理・起動停止まで含めた Discord 側の操作 */
export type AppBridge = Pick<
  DiscordBridge,
  'start' | 'stop' | 'postText' | 'postCard' | 'addReaction' | 'updateText' | 'postToAll' | 'updateCard' | 'sendFiles' | 'sendTyping'
> &
  Partial<Pick<DiscordBridge, 'isConnected' | 'setPresence'>>;

/** 受信処理が使う MCP サーバー側の操作 */
export type AppServer = Pick<ChannelServer, 'pushMessage'>;

/** 受信処理が使う permission relay の操作 */
export type AppRelay = Pick<PermissionRelay, 'answerByText' | 'answerByButton' | 'rememberThread' | 'lookup'>;

/** 無応答の見張りのうち、受信処理が使う操作 */
export type AppWatchdog = Pick<ResponseWatchdog, 'delivered' | 'activity'>;
export type AppScreen = Pick<ScreenRelay, 'show' | 'pick'>;
export type AppRules = Pick<RuleRelay, 'propose' | 'confirm' | 'list' | 'remove'>;
export type AppSession = Pick<SessionControl, 'restart' | 'compact' | 'clear' | 'interrupt'>;

export interface Wiring {
  bridge: AppBridge;
  server: AppServer;
  relay: AppRelay;
  logger: Logger;
  watchdog: AppWatchdog;
  /** ターミナル画面の確認・選択（コンソールが無ければ、読めない旨を返す） */
  screen: AppScreen;
  /** 許可リストへの追加（無ければ「今後も許可」は今回の許可だけになり、!rules は使えない） */
  rules?: AppRules | undefined;
  /** `!status` の文面 */
  status: () => string;
  /** `!restart` / `!compact` / `!clear`。無ければ使えない */
  session?: AppSession | undefined;
  /** 「このセッション中は全部許可」（.env で有効にしたボットだけ）。無ければボタンも !lock も使えない */
  sessionAllow?: SessionAllowAll | undefined;
  /** テキストの添付を本文に差し込む。無ければ差し込まない */
  inline?: InlineDeps | undefined;
  /** send_file の確認ボタンの処理。無ければ send_file は使えない */
  files?: Pick<FileSender, 'confirm'> | undefined;
  /** キャッシュのつなぎ止め。無ければ !keepalive は使えない */
  keepalive?: Pick<Keepalive, 'setEnabled' | 'status'> | undefined;
  /** 本物のメッセージを Claude に中継した（作業中の印・入力中の表示・つなぎ止めの回数を戻すのに使う） */
  onDelivered?: ((at: ThreadRef) => void) | undefined;
  /** 入力中の表示を止める（!stop など） */
  stopTyping?: (() => void) | undefined;
}

/** Claude に渡さず、ブリッジ自身が処理するコマンド（`!restart force` だけ引数を取る） */
const COMMAND_RE = /^\s*!(help|screen|rules|status|restart(?:\s+force)?|compact|clear|lock|stop|keepalive(?:\s+(?:on|off))?)\s*$/i;
/** COMMAND_RE が受け付けるコマンド（小文字・空白 1 つに正規化した形） */
const COMMANDS = [
  'help',
  'screen',
  'rules',
  'status',
  'restart',
  'restart force',
  'compact',
  'clear',
  'lock',
  'stop',
  'keepalive',
  'keepalive on',
  'keepalive off',
] as const;
export type Command = (typeof COMMANDS)[number];

function isCommand(name: string): name is Command {
  return (COMMANDS as readonly string[]).includes(name);
}

/** switch の網羅チェック。種類を足して case を書き忘れると、ここで型エラーになる */
export function assertNever(value: never): never {
  throw new Error(`想定外の値: ${JSON.stringify(value)}`);
}

/** キャッシュのつなぎ止めで Claude に送る本文（INSTRUCTIONS に、ツールを呼ばず ok とだけ書くよう書いてある） */
export const KEEPALIVE_TEXT = 'keepalive（キャッシュのつなぎ止め。ツールを呼ばずに ok とだけ書く）';

/** `!help` の文面 */
export const HELP_TEXT = [
  '📖 ブリッジのコマンド（Claude には渡さず、ブリッジが処理する。Claude が止まっていても使える。`!` の代わりに `/` で始めると、補完から選べる）',
  '• `!help` … この一覧',
  '• `!status` … ブリッジの稼働状態',
  '• `!screen` … ターミナルの画面を見る（選択画面なら選択メニューで選べる）',
  '• `!stop` … Esc を送って、Claude の今の作業を中断する',
  '• `!keepalive on` / `!keepalive off` … キャッシュのつなぎ止めを切り替える（`!keepalive` だけなら状態を見る）',
  '• `!rules` … Discord から足した許可ルールの一覧と削除',
  '• `!compact` … /compact を送る（会話を要約して縮める）',
  '• `!clear` … /clear を送る（会話を捨てて新しい会話にする）',
  '• `!lock` … 「このセッション中は全部許可」を解除する（使えるボットだけ）',
  '• `!restart` … /exit を送って起動し直す（会話は引き継ぐ）',
  '• `!restart force` … Claude Code を強制終了して起動し直す（応答しないとき用）',
].join('\n');

/** 本文がブリッジのコマンドならその名前（小文字・空白 1 つに正規化）を返す */
export function parseCommand(content: string): Command | undefined {
  const m = COMMAND_RE.exec(content);
  const name = m?.[1]?.toLowerCase().replace(/\s+/g, ' ');
  return name !== undefined && isCommand(name) ? name : undefined;
}

/** Claude が Slack 風の名前（`:eyes:` など）で渡してきたときに、Unicode の絵文字に直す分だけ */
const EMOJI_NAMES: Record<string, string> = {
  eyes: '👀',
  white_check_mark: '✅',
  heavy_check_mark: '✔️',
  x: '❌',
  thumbsup: '👍',
  '+1': '👍',
  thumbsdown: '👎',
  '-1': '👎',
  ok_hand: '👌',
  tada: '🎉',
  warning: '⚠️',
  hourglass: '⌛',
  rocket: '🚀',
  pray: '🙏',
  bow: '🙇',
};

/** react ツールの絵文字を Discord に渡せる形にする（`:name:` の形なら Unicode に直し、それ以外はそのまま） */
export function normalizeEmoji(emoji: string): string {
  const m = /^:?([a-z0-9_+-]+):?$/.exec(emoji.trim());
  return m?.[1] !== undefined ? (EMOJI_NAMES[m[1]] ?? emoji.trim()) : emoji.trim();
}

// --- Claude → Discord（MCP ツールの実体） ----------------------------------------

export type ToolHandlers = Pick<McpDeps, 'onReply' | 'onReact' | 'onEdit' | 'onDownload' | 'onSendFile'>;

/**
 * reply / react / edit_message / download_file の実体。失敗しても投げず、Claude が読めるエラー文を返す。
 * onActivity はツールが呼ばれるたびに（成否によらず）呼ぶ。無応答の見張りを解くのに使う。
 * download が無ければ download_file は出さない。
 */
export function createToolHandlers(
  bridge: ToolBridge,
  logger: Logger,
  onActivity?: () => void,
  download?: DownloadDeps,
  files?: Pick<FileSender, 'send'>
): ToolHandlers {
  const run = async (tool: string, action: () => Promise<string>): Promise<string> => {
    onActivity?.();
    try {
      return await action();
    } catch (e) {
      logger.error(`${tool} に失敗`, e);
      return `error: ${errMessage(e)}`;
    }
  };

  return {
    onReply: ({ chat_id, text, thread_id }) =>
      run('reply', async () => {
        const res = await bridge.postText(chat_id, text, thread_id);
        return res.asFile ? 'sent (冒頭を本文に、全文を reply.md として添付した)' : `sent (${res.ts.length} message(s))`;
      }),

    onReact: ({ chat_id, message_id, emoji, thread_id }) =>
      run('react', async () => {
        await bridge.addReaction(chat_id, message_id, normalizeEmoji(emoji), thread_id);
        return 'reacted';
      }),

    onEdit: ({ chat_id, message_id, text, thread_id }) =>
      run('edit_message', async () => {
        await bridge.updateText(chat_id, message_id, text, thread_id);
        return 'edited';
      }),

    onDownload: download
      ? ({ chat_id, message_id, attachment_id, thread_id, extract }) =>
          run('download_file', async () => {
            const ref = { chatId: chat_id, messageId: message_id, attachmentId: attachment_id, threadId: thread_id };
            const result = await downloadAttachment(download, ref, extract ?? false);
            logger.info(`download_file attachment=${attachment_id} extract=${extract ?? false}`);
            return result;
          })
      : undefined,

    onSendFile: files ? (args) => run('send_file', () => files.send(args)) : undefined,
  };
}

/** 縮退モード: ツールはすべてエラーを返し、permission_request は無視する */
export function createDegradedDeps(logger: Logger): McpDeps {
  const busy = (): Promise<string> =>
    Promise.resolve('error: 別のインスタンスが動いているため、この Discord ブリッジは送信できない');

  return {
    logger,
    onReply: busy,
    onReact: busy,
    onEdit: busy,
    onPermissionRequest: () => {
      logger.warn('縮退モードのため permission_request を無視する');
    },
  };
}

// --- Discord → Claude（受信イベントの処理） --------------------------------------

/** DM か許可チャンネルで届いたメッセージ。保留中の ID への `yes xxxxx` / `no xxxxx` なら許可の回答、それ以外は Claude へ中継する */
export async function handleMessage(wiring: Wiring, result: GateResult, raw: InboundRef): Promise<void> {
  const { bridge, server, relay, logger, watchdog } = wiring;

  // `!screen` などのコマンドは Claude に渡さずにここで処理する（Claude が止まっていても使えるように）
  const command = result.kind === 'deliver' ? parseCommand(result.content) : undefined;
  if (command && raw.channel && raw.threadTs) {
    if (raw.ts) await bridge.addReaction(raw.channel, raw.ts, REACTION.SEEN);
    await handleCommand(wiring, command, { channel: raw.channel, threadTs: raw.threadTs }, raw.user ?? '');
    return;
  }

  switch (result.kind) {
    case 'drop':
      logger.debug(`受信を破棄 reason=${result.reason}`);
      return;

    case 'verdict':
      // gate 通過後に期限が切れた場合は Claude に送っていないので、リアクションも付けない
      if (!(await relay.answerByText(result.verdict, raw.user ?? ''))) return;
      if (raw.channel && raw.ts) {
        const reaction = result.verdict.behavior === 'allow' ? REACTION.ALLOW : REACTION.DENY;
        await bridge.addReaction(raw.channel, raw.ts, reaction);
      }
      return;

    case 'deliver': {
      if (raw.channel && raw.threadTs) relay.rememberThread(raw.channel, raw.threadTs);
      let { content, meta } = result;
      if (wiring.inline && result.files && raw.channel && raw.ts) {
        const at = { chatId: raw.channel, messageId: raw.ts, threadId: raw.threadTs };
        const r = await inlineTextAttachments(wiring.inline, at, content, result.hasText ?? true, result.files);
        if (r.inlined.length > 0) {
          content = r.content;
          meta = { ...meta, inlined: r.inlined.join(',') };
        }
      }
      await server.pushMessage(content, meta);
      if (raw.channel && raw.threadTs) wiring.onDelivered?.({ channel: raw.channel, threadTs: raw.threadTs });
      if (raw.channel && raw.threadTs) watchdog.delivered({ channel: raw.channel, threadTs: raw.threadTs });
      if (raw.channel && raw.ts) await bridge.addReaction(raw.channel, raw.ts, REACTION.SEEN);
      return;
    }

    default:
      assertNever(result);
  }
}

/** ブリッジ自身のコマンド。使えない環境ではその旨をスレッドに返す */
async function handleCommand(
  { bridge, screen, rules, status, session, sessionAllow, logger, watchdog, keepalive, stopTyping }: Wiring,
  command: Command,
  at: ThreadRef,
  byUserId: string
): Promise<void> {
  const unavailable = (name: string): Promise<unknown> => bridge.postText(at.channel, `⚠️ このブリッジでは ${name} を使えない`, at.threadTs);
  switch (command) {
    case 'help':
      await bridge.postText(at.channel, HELP_TEXT, at.threadTs);
      return;
    case 'screen':
      await screen.show(at.channel, at.threadTs);
      return;
    case 'stop':
      if (!session) {
        await unavailable('!stop');
        return;
      }
      if (await session.interrupt(at, byUserId)) {
        // 中断したので、返事が無いという警告と入力中の表示はもう出さない
        watchdog.activity();
        stopTyping?.();
        const text = '⏹ Esc を送って中断した。次の指示を待っている。ターミナルで確認が開いていた場合は、それも拒否になる';
        await bridge.postCard(at.channel, noticeCard(text, true, 'muted'), at.threadTs);
      }
      return;
    case 'keepalive':
    case 'keepalive on':
    case 'keepalive off': {
      if (!keepalive) {
        await unavailable('!keepalive');
        return;
      }
      if (command !== 'keepalive') {
        keepalive.setEnabled(command === 'keepalive on');
        logger.info(`keepalive を ${command === 'keepalive on' ? '有効' : '無効'}にした by=${byUserId}`);
      }
      const s = keepalive.status();
      const next = s.nextAt ? `次は ${formatTime(s.nextAt)}` : '予定なし（Claude が次に応答を終えたら決まる）';
      const text = s.enabled
        ? `♻️ キャッシュのつなぎ止め: 有効（${next}、送った回数 ${s.sent}/${s.max}）`
        : '♻️ キャッシュのつなぎ止め: 無効（起動し直すと .env の設定に戻る）';
      await bridge.postText(at.channel, text, at.threadTs);
      return;
    }
    case 'rules':
      if (rules) await rules.list(at.channel, at.threadTs);
      else await unavailable('!rules');
      return;
    case 'status':
      await bridge.postText(at.channel, status(), at.threadTs);
      return;
    case 'restart':
    case 'restart force':
      if (session) await session.restart(at, byUserId, command === 'restart force');
      else await unavailable('!restart');
      return;
    case 'compact':
      if (session) await session.compact(at, byUserId);
      else await unavailable('!compact');
      return;
    case 'clear':
      if (session) await session.clear(at, byUserId);
      else await unavailable('!clear');
      return;
    case 'lock':
      if (!sessionAllow) {
        await unavailable('!lock');
        return;
      }
      if (sessionAllow.disable()) {
        logger.info(`全部許可を解除 by=${byUserId}（!lock）`);
        await bridge.postText(at.channel, '🔒 「このセッション中は全部許可」を解除した。次からはまたボタンで確認する', at.threadTs);
      } else {
        await bridge.postText(at.channel, '「このセッション中は全部許可」は有効になっていない', at.threadTs);
      }
      return;
    default:
      assertNever(command);
  }
}

/**
 * スラッシュコマンドが使われたとき（discord.ts で検証済み）。返信先は、使ったことを残した一言（スレッドの中ならそのスレッド）。
 * 処理は `!` のコマンドと同じ
 */
export async function handleSlashCommand(wiring: Wiring, command: Command, ctx: ActionContext): Promise<void> {
  const at = pressedMessage(ctx);
  if (!at) return;
  await handleCommand(wiring, command, { channel: at.channel, threadTs: at.threadTs }, ctx.userId ?? '');
}

/** permission request のボタン（Allow / Deny / See more）が押されたとき */
export async function handleAction(wiring: Wiring, parsed: ActionParse, ctx: ActionContext): Promise<void> {
  if (!parsed.ok) {
    wiring.logger.warn(`block_actions を無視 reason=${parsed.reason}`);
    return;
  }

  const pressed = ctx.channelId && ctx.messageTs ? { channel: ctx.channelId, ts: ctx.messageTs } : undefined;
  const at = pressedMessage(ctx);
  const byUserId = ctx.userId ?? '';

  switch (parsed.kind) {
    case 'verdict':
      await wiring.relay.answerByButton(parsed.verdict, byUserId, pressed);
      return;

    case 'see_more':
      await sendFullPreview(wiring, parsed.requestId, ctx);
      return;

    case 'allow_always': {
      // 回答すると保留から消えるので、先に中身を控えておく
      const req = wiring.relay.lookup(parsed.requestId);
      await wiring.relay.answerByButton({ requestId: parsed.requestId, behavior: 'allow' }, byUserId, pressed);
      if (req && at && wiring.rules) await wiring.rules.propose(req, at.channel, at.threadTs);
      return;
    }

    case 'allow_session':
      // 期限切れのボタンでは有効にしない（answerByButton が期限切れ表示に書き換える）
      if (wiring.sessionAllow && wiring.relay.lookup(parsed.requestId)) {
        wiring.sessionAllow.enable(byUserId);
        wiring.logger.info(`全部許可を開始 by=${byUserId}`);
        if (at) {
          await wiring.bridge.postText(
            at.channel,
            '🔓 このセッション中は、settings の ask に当たるもの以外を自動で許可する（deny は今までどおり実行されない）。自動で許可した操作はスレッドに残す。!lock で解除、!clear か起動し直しでも解除される',
            at.threadTs
          );
        }
      }
      await wiring.relay.answerByButton({ requestId: parsed.requestId, behavior: 'allow' }, byUserId, pressed);
      return;

    case 'screen_show':
      if (at) await wiring.screen.show(at.channel, at.threadTs);
      return;

    case 'screen_pick':
      if (at) await wiring.screen.pick(parsed.snapshotId, parsed.index, at, byUserId);
      return;

    case 'rule_confirm':
      if (at && wiring.rules) await wiring.rules.confirm(parsed.proposalId, parsed.accept, at, byUserId);
      return;

    case 'rule_remove':
      if (at && wiring.rules) await wiring.rules.remove(parsed.listId, parsed.index, at, byUserId);
      return;

    case 'file_confirm':
      if (at && wiring.files) await wiring.files.confirm(parsed.confirmId, parsed.accept, at, byUserId);
      return;

    default:
      assertNever(parsed);
  }
}

/**
 * ボタンが押されたメッセージの位置。結果の書き換え先（ts）と、投稿先のスレッド
 * （ボタンのメッセージが属するスレッド。スレッド外ならボタンのメッセージ自身を起点にする）。チャンネルが分からなければ undefined
 */
function pressedMessage(ctx: ActionContext): PressedMessage | undefined {
  const threadTs = ctx.threadTs ?? ctx.messageTs;
  if (!ctx.channelId || !threadTs) return undefined;
  return { channel: ctx.channelId, ts: ctx.messageTs, threadTs };
}

/**
 * input_preview をコードブロックで包む。中身の行頭の ``` はゼロ幅スペースを前置して、
 * フェンスの開閉と誤認されない（分割送信時の開き直しも崩れない）ようにする。
 */
export function fencePreview(preview: string): string {
  return '```\n' + preview.replace(/^```/gm, '\u200b```') + '\n```';
}

/**
 * See more: ボタンのメッセージでは省略した input_preview の全文をスレッドに送る。
 * 不可視文字（双方向制御・ゼロ幅・BOM）は revealInvisible で `\u{XXXX}` に置き換えてから送る。
 * 長いときは postText がコードブロックを保ったまま複数メッセージに分ける。期限切れならその旨だけ送る。
 * 送り先はボタンのメッセージが属するスレッド（スレッド外ならボタンのメッセージ自身を起点にする）。
 */
async function sendFullPreview({ bridge, relay, logger }: Wiring, requestId: string, ctx: ActionContext): Promise<void> {
  const at = pressedMessage(ctx);
  if (!at) return;

  const req = relay.lookup(requestId);
  try {
    if (req) {
      await bridge.postText(at.channel, fencePreview(revealInvisible(req.input_preview)), at.threadTs);
    } else {
      await bridge.postText(at.channel, `⌛ permission request ${requestId} は既に期限切れ`, at.threadTs);
    }
  } catch (e) {
    logger.warn('see_more の送信に失敗', e);
  }
}

// --- 起動 ---------------------------------------------------------------------

export interface RunningApp {
  /** 後片付け（lock.release → hook の読み取りと無応答の見張りを止める → 保留中の permission request を deny → ホームを停止中にする（通常モードのみ） → bridge.stop → server.close の順。2 回目以降の呼び出しは 1 回目と同じ Promise を返す） */
  stop: () => Promise<void>;
}

export interface BridgeAppOptions {
  /** init() 済みの DiscordBridge */
  bridge: AppBridge;
  logger: Logger;
  /** MCP のトランスポート。省略時は stdio */
  transport?: Transport | undefined;
  /** stop() の最初に release する（後片付けが固まってもロックを残さないため） */
  lock?: Pick<InstanceLock, 'release'> | undefined;
  /**
   * bridge.start() より前に、後片付けの関数を渡して呼ぶ。終了処理（stdin の終了・シグナル）の登録に使い、
   * Socket Mode の接続待ちの最中に Claude Code が終了しても後片付けされるようにする。
   */
  onCleanupReady?: ((stop: () => Promise<void>) => void) | undefined;
  /**
   * Claude に渡したメッセージへの応答（reply / react / edit_message / permission_request）を待つ時間（ミリ秒）。
   * 過ぎたらそのスレッドに無応答の警告を投稿する。0 以下なら見張らない。省略時は見張らない
   */
  replyTimeoutMs?: number | undefined;
  /** ターミナル画面の読み取り・選択キーの送信。省略時は !screen と画面のボタンが使えない */
  console?: ConsoleAccess | undefined;
  /** Discord から追加した許可ルールの保存先（状態ディレクトリの allow-extra.json）。省略時は「今後も許可」で追加しない */
  allowExtraFile?: string | undefined;
  /** 追加の前に照合する deny を読む設定ファイル（channel-settings.json と作業フォルダーの .claude/settings*.json） */
  denyFiles?: string[] | undefined;
  /** 作業フォルダー（!status とホームタブに出す）。省略時は「(不明)」 */
  workDir?: string | undefined;
  /** 添付の保存先と取得手段（.env の DOWNLOAD_DIR があるとき）。省略時は download_file を出さない */
  download?: DownloadDeps | undefined;
  /**
   * Claude Code の hook が追記する記録（状態ディレクトリの hooks.jsonl）。読んで、ターミナル側の入力待ち・
   * 使用量の上限・セッションの開始と終了・圧縮を Discord に知らせる。省略時は読まない
   */
  hookInboxFile?: string | undefined;
  /** hooks.jsonl を読みに行く間隔（ミリ秒。テスト用。省略時は hook-inbox.ts の既定） */
  hookPollMs?: number | undefined;
  /** hook の記録のうち扱う行の session_tag（start.ps1 が環境変数 DISCORD_CHANNEL_SESSION_TAG で渡す）。省略時は全部扱う */
  sessionTag?: string | undefined;
  /** `!restart` が置く印（状態ディレクトリの restart.flag。start.ps1 が見て起動し直す）。省略時は !restart・!compact・!clear を使えない */
  restartFlagFile?: string | undefined;
  /** `!restart force` で claude.exe を止める手段（テスト用。省略時は taskkill でプロセスツリーごと止める） */
  killParent?: SessionControlOptions['killParent'];
  /** 実行許可に「このセッション中は全部許可」ボタンを出すか（.env の SESSION_ALLOW_ALL）。除外する ask は denyFiles から読む */
  sessionAllowAll?: boolean | undefined;
  /** テキストの添付を本文に差し込む手段と上限。省略時は差し込まない */
  inline?: InlineDeps | undefined;
  /** キャッシュのつなぎ止めの設定。省略時はつなぎ止めない（hook の記録が無いと応答の終わりが分からないので、hookInboxFile も要る） */
  keepalive?: { enabled: boolean; afterMs: number; max: number; quiet: QuietHours | undefined } | undefined;
  /** send_file の設定（.env の UPLOAD_DIRS があるとき）。省略時は send_file を出さない */
  upload?: { dirs: string[]; maxBytes?: number | undefined; protectedDirs?: string[] | undefined } | undefined;
}

/**
 * 通常モード: Discord と Claude Code（MCP）をつないで中継を始める。
 * MCP の接続か受信の開始に失敗したら、後片付け（lock.release → relay.denyAll → bridge.stop → server.close）をしてから投げ直す。
 */
export async function startBridgeApp(opts: BridgeAppOptions): Promise<RunningApp> {
  const { bridge, logger } = opts;

  const watchdog = new ResponseWatchdog({
    timeoutMs: opts.replyTimeoutMs ?? 0,
    logger,
    notify: async ({ channel, threadTs }, minutes) => {
      const text = buildNoResponseText(minutes);
      await bridge.postCard(channel, noticeCard(text, opts.console !== undefined), threadTs);
    },
  });
  const screen = new ScreenRelay({ console: opts.console, bridge, logger });
  const ruleStore = opts.allowExtraFile ? new AllowRuleStore(opts.allowExtraFile) : undefined;
  const rules = ruleStore
    ? new RuleRelay({
        store: ruleStore,
        loadDeny: () => (opts.denyFiles ?? []).flatMap((f) => readDeny(f)),
        bridge,
        logger,
      })
    : undefined;

  // server と relay は互いを参照する。relay を使うのは接続後なので、宣言順はこれでよい
  const typing = new TypingIndicator(bridge, logger);
  // send_file の結果は確認が済んでから Claude に知らせる（server は下で作る。呼ばれるのは接続後）
  const files = opts.upload
    ? new FileSender({
        bridge,
        notify: (content, meta) => server.pushMessage(content, meta),
        uploadDirs: opts.upload.dirs,
        maxBytes: opts.upload.maxBytes,
        protectedDirs: opts.upload.protectedDirs,
        logger,
      })
    : undefined;
  const server: ChannelServer = new ChannelServer({
    logger,
    ...createToolHandlers(
      bridge,
      logger,
      () => {
        watchdog.activity();
        // hook の記録が無いと応答の終わりが分からないので、ツールが呼ばれた時点で入力中の表示を止める
        if (!opts.hookInboxFile) typing.stopAll();
      },
      opts.download,
      files
    ),
    onPermissionRequest: (req) => {
      watchdog.activity();
      // 利用者の答えを待つ間は「入力中」ではない
      typing.stopAll();
      return relay.request(req);
    },
  });
  const sessionAllow = opts.sessionAllowAll
    ? // deny に当たる操作は Claude Code が確認を出す前に止めるので、照合するのは ask だけ
      new SessionAllowAll(() => (opts.denyFiles ?? []).flatMap((f) => readAsk(f)))
    : undefined;
  const relay: PermissionRelay = new PermissionRelay(bridge, server, logger, undefined, sessionAllow);
  const startedAt = new Date();

  // --- キャッシュのつなぎ止め ------------------------------------------------------
  /** Claude がターンの途中（中継してから、または手元で入力してから Stop まで） */
  let turnActive = false;
  /** 使用量の上限に当たっている（StopFailure の rate_limit から、次に応答が終わるまで） */
  let limited = false;
  const keepalive =
    opts.keepalive && opts.hookInboxFile
      ? new Keepalive({
          ...opts.keepalive,
          send: () => server.pushMessage(KEEPALIVE_TEXT, { kind: 'keepalive' }),
          isBusy: () => turnActive || watchdog.isWaiting() || relay.pendingCount() > 0,
          isLimited: () => limited,
          logger,
        })
      : undefined;

  // --- ボットのステータス表示 -------------------------------------------------------
  const presence = bridge.setPresence
    ? new PresenceUpdater({
        inputs: () => ({ limited, pendingPermissions: relay.pendingCount(), working: turnActive }),
        apply: (state) => bridge.setPresence?.(state),
        logger,
      })
    : undefined;

  // --- hook の記録 → Discord への知らせ -----------------------------------------
  const notice = new NoticePoster(bridge, () => relay.lastThread, logger);
  /** 今の会話の session_id（自分のセッションの hook の記録で最後に見たもの）。!restart で同じ会話を開き直すのに使う */
  let sessionId: string | undefined;
  const inbox = opts.hookInboxFile
    ? new HookInbox({
        file: opts.hookInboxFile,
        logger,
        pollMs: opts.hookPollMs,
        sessionTag: opts.sessionTag,
        onEvent: async (event) => {
          if (event.session_id) sessionId = event.session_id;
          switch (event.hook_event_name) {
            case 'UserPromptSubmit':
              turnActive = true;
              break;
            case 'Stop':
              typing.stopAll();
              turnActive = false;
              limited = false;
              keepalive?.requestEnded(event.at);
              break;
            case 'StopFailure':
              typing.stopAll();
              turnActive = false;
              if (event.error === 'rate_limit') limited = true;
              keepalive?.requestEnded(event.at);
              break;
            case 'SessionStart':
              keepalive?.resetCount();
              break;
            case 'SessionEnd':
              typing.stopAll();
              break;
          }
          // !clear などで新しい会話になったら、「全部許可」を解除する（会話ごとに許可し直す）
          if (event.hook_event_name === 'SessionStart' && event.source === 'clear' && sessionAllow?.disable()) {
            logger.info('全部許可を解除（新しい会話）');
            await notice.post('🔒 新しい会話になったので「このセッション中は全部許可」を解除した');
          }
          const found = hookToNotice(event, { waiting: watchdog.isWaiting(), pending: relay.pendingCount() });
          if (!found) return;
          logger.info(`hook を知らせる event=${event.hook_event_name} type=${event.notification_type ?? '-'}`);
          await notice.post(found.text, noticeCard(found.text, found.screenButton && opts.console !== undefined, found.color));
        },
      })
    : undefined;

  // --- !status / !restart / !compact / !clear -------------------------------------
  const status = (): string => {
    const waiting = watchdog.waitingSince();
    return buildStatusText({
      startedAt,
      workDir: opts.workDir ?? '',
      discordConnected: bridge.isConnected,
      waitingSince: waiting === undefined ? undefined : new Date(waiting),
      pendingPermissions: relay.pendingCount(),
      lastHooks: inbox?.lastEvents(5) ?? [],
      sessionAllowSince: sessionAllow ? (sessionAllow.current?.since ?? null) : undefined,
      keepalive: keepalive?.status(),
      now: new Date(),
    });
  };
  const session = opts.restartFlagFile
    ? new SessionControl({ console: opts.console, restartFlagFile: opts.restartFlagFile, bridge, logger, killParent: opts.killParent, sessionId: () => sessionId })
    : undefined;
  const wiring: Wiring = {
    bridge,
    server,
    relay,
    logger,
    watchdog,
    screen,
    rules,
    status,
    session,
    sessionAllow,
    inline: opts.inline,
    files,
    keepalive,
    onDelivered: (at) => {
      turnActive = true;
      keepalive?.resetCount();
      typing.start(at.channel, at.threadTs);
    },
    stopTyping: () => typing.stopAll(),
  };

  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopped ??= (async () => {
      opts.lock?.release();
      inbox?.stop();
      session?.stop();
      files?.stop();
      keepalive?.stop();
      presence?.stop();
      typing.stopAll();
      watchdog.stop();
      try {
        // Discord の書き換えと Claude への通知が届くよう、切断より前に行う（denyAll は投げない）
        await relay.denyAll('ブリッジ終了');
        await bridge.stop();
      } finally {
        await server.close();
      }
    })());
  opts.onCleanupReady?.(stop);

  try {
    if (opts.transport) await server.connect(opts.transport);
    else await server.connectStdio();
    await bridge.start({
      onMessage: (result, raw) => handleMessage(wiring, result, raw),
      onAction: (parsed, ctx) => handleAction(wiring, parsed, ctx),
      onCommand: (command, ctx) => handleSlashCommand(wiring, command, ctx),
      isKnownRequest: (id) => relay.lookup(id) !== undefined,
    });
  } catch (e) {
    await stop().catch((err: unknown) => logger.error('起動失敗後の後片付けで例外', err));
    throw e;
  }
  logger.info('Discord ブリッジ稼働中');
  // 起動の途中で終了処理（stdin の終了など）が始まっていたら、それ以上は始めない（止めた後に投稿やタイマーを残さない）
  if (stopped === undefined) await inbox?.start();
  if (stopped === undefined) presence?.start();

  return { stop };
}

export interface DegradedAppOptions {
  logger: Logger;
  /** MCP のトランスポート。省略時は stdio */
  transport?: Transport | undefined;
}

/** 縮退モード: MCP サーバーだけ起動し、ツールはすべてエラーを返す */
export async function startDegradedApp(opts: DegradedAppOptions): Promise<RunningApp> {
  const server = new ChannelServer(createDegradedDeps(opts.logger));
  if (opts.transport) await server.connect(opts.transport);
  else await server.connectStdio();

  return { stop: () => server.close() };
}
