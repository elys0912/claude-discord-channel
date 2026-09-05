// app 系のテスト（app*.test.ts）で共用する、ブリッジを起動して往復を確かめるための道具。
// Discord は偽物の FakeDiscord（受信は本物の gate、ボタンは本物の parseInteraction を通す）、
// MCP は in-memory トランスポート + Client で、本物の ChannelServer / PermissionRelay などをつなぐ。
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

export type HarnessOptions = Extra & {
  /** 偽の Discord の許可設定（既定は ACCESS） */
  access?: ParsedAccess;
  replyTimeoutMs?: number;
  /** 偽の Discord を使う設定（添付の取得など）。作った FakeDiscord を受け取って返す */
  fromDiscord?: (discord: FakeDiscord) => Extra;
};

/**
 * 偽の Discord と in-memory の MCP でブリッジを起動する。
 * lock を渡さなければ何もしない lock を渡す（本番と同じく lock がある経路を通すため）
 */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { access = ACCESS, replyTimeoutMs, fromDiscord, lock = { release: () => undefined }, ...extra } = options;
  const discord = new FakeDiscord(access);
  const logger = new Logger({ stderr: false });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
  const notifications: Notification[] = [];
  client.fallbackNotificationHandler = async (n) => {
    notifications.push(n as Notification);
  };

  const app = await startBridgeApp({ bridge: discord, logger, transport: serverTransport, lock, replyTimeoutMs, ...extra, ...fromDiscord?.(discord) });
  await client.connect(clientTransport);

  return { discord, logger, client, notifications, stop: app.stop };
}

/** MCP の client と、ブリッジ（startBridgeApp）を閉じる */
export async function closeHarness(h: Harness): Promise<void> {
  await h.client.close();
  await h.stop();
}

/** permission_request（Bash の ls）を Claude 側から送る */
export async function sendPermissionRequest(client: Client, requestId = 'abcde', inputPreview = '{"command":"ls"}'): Promise<void> {
  await client.notification({
    method: 'notifications/claude/channel/permission_request',
    params: { request_id: requestId, tool_name: 'Bash', description: 'Run shell command', input_preview: inputPreview },
  });
  await flush();
}

/** Bash の permission_request を Claude 側から送る */
export async function sendBash(h: Harness, command: string, requestId = 'abcde'): Promise<void> {
  await h.client.notification({
    method: 'notifications/claude/channel/permission_request',
    params: { request_id: requestId, tool_name: 'Bash', description: 'run', input_preview: JSON.stringify({ command }) },
  });
  await flush();
}

/** Claude に渡したメッセージ（notifications/claude/channel） */
export const channelMessages = (h: Harness) => h.notifications.filter((x) => x.method === 'notifications/claude/channel');

/** Claude に返した実行許可の回答（notifications/claude/channel/permission）の中身 */
export const verdicts = (h: Harness) => h.notifications.filter((x) => x.method === 'notifications/claude/channel/permission').map((x) => x.params);
