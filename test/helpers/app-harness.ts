// app 系のテスト（app*.test.ts）で共用する、ブリッジを起動して往復を確かめるための道具。
// Discord は偽物の FakeDiscord（受信は本物の gate、ボタンは本物の parseInteraction を通す）、
// MCP は in-memory トランスポート + Client で、本物の ChannelServer / PermissionRelay などをつなぐ。
import { afterEach, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startBridgeApp } from '../../src/app.js';
import type { BridgeAppOptions } from '../../src/app.js';
import type { ParsedAccess } from '../../src/config.js';
import { Logger } from '../../src/log.js';
import { ACCESS, FakeDiscord, flush } from './fake-discord.js';

export interface Notification {
  method: string;
  params?: Record<string, unknown>;
}

export interface Harness {
  discord: FakeDiscord;
  logger: Logger;
  client: Client;
  notifications: Notification[];
  stop: () => Promise<void>;
}

type Extra = Omit<BridgeAppOptions, 'bridge' | 'logger' | 'transport' | 'replyTimeoutMs'>;

/** FakeDiscord を使って組み立てる設定。optionsFromDiscord からだけ渡す（渡し口を 1 つにするため） */
type DiscordBoundOptions = Pick<Extra, 'inline' | 'download'>;

export type HarnessOptions = Omit<Extra, keyof DiscordBoundOptions> & {
  /** 偽の Discord の許可設定（既定は ACCESS） */
  access?: ParsedAccess;
  replyTimeoutMs?: number;
  /**
   * 作った FakeDiscord を使って組み立てる設定（テキストの添付の差し込み・添付の保存）。
   * FakeDiscord は startHarness の中で作るため、ほかの設定と違って関数で渡す
   */
  optionsFromDiscord?: (discord: FakeDiscord) => DiscordBoundOptions;
};

/**
 * 偽の Discord と in-memory の MCP でブリッジを起動する。
 * lock を渡さなければ何もしない lock を渡す（本番と同じく lock がある経路を通すため）
 */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { access = ACCESS, replyTimeoutMs, optionsFromDiscord, lock = { release: () => undefined }, ...extra } = options;
  const discord = new FakeDiscord(access);
  const logger = new Logger({ stderr: false });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
  const notifications: Notification[] = [];
  client.fallbackNotificationHandler = async (n) => {
    notifications.push(n as Notification);
  };

  const app = await startBridgeApp({ bridge: discord, logger, transport: serverTransport, lock, replyTimeoutMs, ...extra, ...optionsFromDiscord?.(discord) });
  await client.connect(clientTransport);

  return { discord, logger, client, notifications, stop: app.stop };
}

/** MCP の client と、ブリッジ（startBridgeApp）を閉じる */
export async function closeHarness(h: Harness): Promise<void> {
  await h.client.close();
  await h.stop();
}

/**
 * describe の中で呼ぶ。テストごとに startHarness で起動し、テストの後に closeHarness で閉じる。
 * 返す Harness は、そのテストで起動したものへ読み替える（describe の直下で受け取って、各テストから使う）。
 * options を関数で渡すと、先に登録した beforeEach（一時フォルダーの作成など）の後で評価する。
 * 一時フォルダーを消す afterEach は、この呼び出しより前に登録する。vitest は後に登録した afterEach から動かすので、閉じてから消す順になる
 */
export function useHarness(options: HarnessOptions | (() => HarnessOptions) = {}): Harness {
  let current: Harness | undefined;

  beforeEach(async () => {
    current = await startHarness(typeof options === 'function' ? options() : options);
  });

  afterEach(async () => {
    if (current) await closeHarness(current);
    current = undefined;
  });

  const started = (): Harness => {
    if (!current) throw new Error('useHarness の Harness は、テストの中（beforeEach の後）でだけ使える');
    return current;
  };

  return {
    get discord() {
      return started().discord;
    },
    get logger() {
      return started().logger;
    },
    get client() {
      return started().client;
    },
    get notifications() {
      return started().notifications;
    },
    get stop() {
      return started().stop;
    },
  };
}

/** Bash の permission_request を Claude 側から送る。inputPreview は JSON でない値などもそのまま渡す */
export async function sendPermissionRequest(client: Client, requestId = 'abcde', inputPreview = '{"command":"ls"}'): Promise<void> {
  await client.notification({
    method: 'notifications/claude/channel/permission_request',
    params: { request_id: requestId, tool_name: 'Bash', description: 'Run shell command', input_preview: inputPreview },
  });
  await flush();
}

/** command を実行する Bash の permission_request を送る（input_preview は Claude Code と同じ JSON の形にする） */
export async function sendBash(client: Client, command: string, requestId = 'abcde'): Promise<void> {
  await sendPermissionRequest(client, requestId, JSON.stringify({ command }));
}

/** Claude に渡したメッセージ（notifications/claude/channel） */
export const channelMessages = (h: Harness) => h.notifications.filter((x) => x.method === 'notifications/claude/channel');

/** Claude に返した実行許可の回答（notifications/claude/channel/permission）の中身 */
export const verdicts = (h: Harness) => h.notifications.filter((x) => x.method === 'notifications/claude/channel/permission').map((x) => x.params);
