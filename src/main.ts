// エントリポイント。stdout は MCP (JSON-RPC) 専用なので、必ず最初に guard を読み込む。
import './stdio-guard.js';

import path from 'node:path';
import { loadAccess, loadTokens, stateDir } from './config.js';
import type { ParsedAccess, Tokens } from './config.js';
import { errMessage } from './errors.js';
import { Logger } from './log.js';
import { InstanceLock, acquireWithRetry, isProcessAlive } from './lock.js';
import { DiscordBridge } from './discord.js';
import { DEFAULT_INLINE_LIMITS } from './inline-text.js';
import type { InlineDeps } from './inline-text.js';
import { startBridgeApp, startDegradedApp } from './app.js';
import { replyTimeoutMs } from './watchdog.js';
import { PowerShellConsole, findConsoleScript } from './console.js';
import { HOOK_LOG_FILE, SESSION_TAG_ENV } from './hook-event.js';
import { RESTART_FLAG_FILE } from './session-control.js';
import { isPlaceholder, runPlaceholder } from './placeholder.js';

/** リポジトリのルート（dist/src/main.js の 2 つ上） */
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/** 起動失敗時、process.exit の前に undici の後始末を待つ時間 */
const EXIT_SETTLE_MS = 250;
/** 終了処理が固まったときに強制終了するまでの猶予 */
const SHUTDOWN_GRACE_MS = 2000;
/** stdin の終了を取りこぼしていないか確認する間隔 */
const STDIN_POLL_MS = 5000;
/** ロックが取れないとき、縮退モードに入る前に取り直しを試す時間（旧ブリッジの終了処理は SHUTDOWN_GRACE_MS で終わる） */
const LOCK_RETRY_MS = 10000;
const LOCK_RETRY_INTERVAL_MS = 500;

function createLogger(dir: string): Logger {
  const logger = new Logger({ file: path.join(dir, 'logs', 'bridge.log') });
  logger.setName('bridge');
  return logger;
}

/**
 * 起動失敗時の終了。undici（HTTP クライアント）の後始末が終わる前に process.exit すると
 * libuv がアサートで落ちるので、少しだけ待ってから抜ける。
 */
async function exitWithError(code: number): Promise<never> {
  await new Promise((r) => setTimeout(r, EXIT_SETTLE_MS));
  process.exit(code);
}

/** 起動を諦める。stderr（Claude Code の /mcp で見える）とログの両方に理由を残す */
async function abort(logger: Logger, what: string, e: unknown, cleanup: () => Promise<void> | void): Promise<never> {
  process.stderr.write(`[discordbridge] ${what}: ${errMessage(e)}\n`);
  logger.error(what, errMessage(e));
  await cleanup();
  return exitWithError(1);
}

// --- 起動 ---------------------------------------------------------------------

async function main(dir: string, logger: Logger): Promise<void> {
  // 同時に動く Discord ブリッジは1つだけ。2つ目は Discord に繋がず縮退モードで動く。
  // 起動し直し（!restart）では旧ブリッジの終了処理と重なるので、少し待ってから諦める。
  // 強制終了（!restart force）で解放されずに残ったロックは、持ち主の pid が死んでいれば取る
  const lock = new InstanceLock(path.join(dir, 'instance.lock'), { isAlive: isProcessAlive });
  const lockResult = await acquireWithRetry(lock, { timeoutMs: LOCK_RETRY_MS, intervalMs: LOCK_RETRY_INTERVAL_MS });
  const degraded = !lockResult.acquired;
  if (!lockResult.acquired) {
    process.stderr.write(
      `[discordbridge] 別のインスタンスが動いている（pid=${lockResult.holder.pid}）。Discord には接続せず、MCP サーバーのみ起動する\n`
    );
    logger.warn(`ロック取得に失敗（保持者 pid=${lockResult.holder.pid}）。縮退モードで起動する`);
  }

  let tokens: Tokens;
  let access: ParsedAccess;
  try {
    tokens = loadTokens(dir);
    access = loadAccess(dir);
  } catch (e) {
    return abort(logger, '設定の読み込みに失敗', e, () => lock.release());
  }

  logger.info(
    `起動 pid=${process.pid} node=${process.version} stateDir=${dir} ` +
      `allowFrom=${access.allowFrom.length}人 channels=${access.channels?.length ?? 0}件 download=${tokens.downloadDir ? 'on' : 'off'} upload=${tokens.uploadDirs ? `${tokens.uploadDirs.length}件` : 'off'} allowAll=${tokens.sessionAllowAll ? 'on' : 'off'} degraded=${degraded}`
  );

  if (degraded) {
    const app = await startDegradedApp({ logger });
    installShutdown(logger, app.stop);
    return;
  }

  const bridge = new DiscordBridge({ token: tokens.botToken, access, logger, longReplyChars: tokens.longReplyChars });
  try {
    const init = await bridge.init();
    logger.info(`Discord 接続確認 OK bot=${init.botTag}(${init.botUserId}) guild=${init.guildName} dm=${init.dmChannelCount}件`);
  } catch (e) {
    return abort(logger, 'Discord への接続に失敗', e, async () => {
      lock.release();
      await bridge.stop();
    });
  }

  // 開始に失敗したら startBridgeApp が後片付けしてから投げる
  await startBridgeApp({
    bridge,
    logger,
    lock,
    onCleanupReady: (stop) => installShutdown(logger, stop),
    replyTimeoutMs: replyTimeoutMs(),
    console: consoleAccess(logger),
    workDir: process.cwd(),
    allowExtraFile: path.join(dir, 'allow-extra.json'),
    hookInboxFile: path.join(dir, HOOK_LOG_FILE),
    // start.ps1 から起動されたときだけ値がある。無ければ（手で起動したなど）今までどおり全部の行を扱う
    sessionTag: process.env[SESSION_TAG_ENV] || undefined,
    restartFlagFile: path.join(dir, RESTART_FLAG_FILE),
    download: tokens.downloadDir ? { bridge, dir: tokens.downloadDir } : undefined,
    sessionAllowAll: tokens.sessionAllowAll === true,
    todoProgress: tokens.todoProgress,
    inline: inlineDeps(bridge, logger, tokens.inlineTextMaxKb),
    keepalive: {
      enabled: tokens.keepalive.enabled && tokens.keepalive.max > 0,
      afterMs: tokens.keepalive.afterMin * 60_000,
      max: tokens.keepalive.max,
      quiet: tokens.keepalive.quiet,
    },
    upload: tokens.uploadDirs
      ? {
          dirs: tokens.uploadDirs,
          maxBytes: tokens.uploadMaxMb === undefined ? undefined : tokens.uploadMaxMb * 1024 * 1024,
          // ブリッジの設定（トークン・許可リスト）は、UPLOAD_DIRS の中にあっても送らない
          protectedDirs: [dir],
        }
      : undefined,
    // 起動スクリプトは作業フォルダーで claude.exe を起動し、MCP サーバーも同じ作業フォルダーで動く。
    // channel セッションの設定ファイルは -SettingsFile で替えられるので、起動スクリプトが渡した場所を優先する
    denyFiles: [
      process.env.DISCORD_CHANNEL_SETTINGS_FILE ?? path.join(repoRoot, 'config', 'channel-settings.json'),
      path.join(process.cwd(), '.claude', 'settings.json'),
      path.join(process.cwd(), '.claude', 'settings.local.json'),
    ],
  });
}

/** テキストの添付を本文に差し込む設定。.env の INLINE_TEXT_MAX_KB が 0 なら差し込まない（省略時は既定の上限） */
function inlineDeps(bridge: DiscordBridge, logger: Logger, maxKb: number | undefined): InlineDeps | undefined {
  if (maxKb === 0) return undefined;
  if (maxKb === undefined) return { bridge, logger };
  const maxFileBytes = maxKb * 1024;
  return { bridge, logger, limits: { ...DEFAULT_INLINE_LIMITS, maxFileBytes, maxTotalBytes: Math.max(maxFileBytes, DEFAULT_INLINE_LIMITS.maxTotalBytes) } };
}

/** 画面の読み取りに使う console.ps1 が見つかれば、その実装を返す。Windows 以外・見つからなければ undefined */
function consoleAccess(logger: Logger): PowerShellConsole | undefined {
  if (process.platform !== 'win32') return undefined;
  const script = findConsoleScript();
  if (!script) {
    logger.warn('scripts/console.ps1 が見つからないので、!screen と画面のボタンは使えない');
    return undefined;
  }
  // ブリッジの親は claude.exe（MCP サーバーとして起動される）。そのコンソールの画面を操作する
  return new PowerShellConsole(script, process.ppid);
}

// --- 終了処理 -------------------------------------------------------------------

/** Claude Code が終了したら（stdin が閉じたら）後片付けして抜ける */
function installShutdown(logger: Logger, cleanup: () => Promise<void>): void {
  let shuttingDown = false;

  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`終了処理開始 理由=${reason}`);
    void cleanup()
      .then(() => {
        logger.info(`終了処理完了 理由=${reason}`);
      })
      .catch((e: unknown) => {
        logger.error(`終了処理で例外 理由=${reason}`, e);
      });
    // 後片付けが固まった場合の保険
    setTimeout(() => {
      logger.info(`終了（強制） 理由=${reason}`);
      process.exit(0);
    }, SHUTDOWN_GRACE_MS).unref();
  };

  process.stdin.on('end', () => shutdown('stdin end'));
  process.stdin.on('close', () => shutdown('stdin close'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));

  // stdin のイベントを取りこぼした場合に備えて、定期的にも確認する
  setInterval(() => {
    if (process.stdin.destroyed || process.stdin.readableEnded) {
      shutdown('stdin destroyed/ended（監視ループ検知）');
    }
  }, STDIN_POLL_MS).unref();
}

// --- 予期しない例外でもプロセスを落とさない ---------------------------------------

function startBridge(): void {
  // Logger はプロセスで 1 つ。起動前の例外も main() 内も同じものに書く
  const stateDirectory = stateDir();
  const logger = createLogger(stateDirectory);

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandledRejection', reason);
  });
  process.on('uncaughtException', (e: unknown) => {
    logger.error('uncaughtException', e);
  });

  main(stateDirectory, logger).catch((e: unknown) => {
    process.stderr.write(`[discordbridge] 起動に失敗: ${errMessage(e)}\n`);
    logger.error('起動に失敗', e);
    void exitWithError(1);
  });
}

// start.ps1 が local スコープに登録した discordbridge（普段のセッションで読み込まれる）は、
// 状態ディレクトリにもロックにも触らずに待つだけ（src/placeholder.ts）
if (isPlaceholder()) {
  runPlaceholder().catch((e: unknown) => {
    process.stderr.write(`[discordbridge] 起動に失敗: ${errMessage(e)}\n`);
    process.exit(1);
  });
} else {
  startBridge();
}
