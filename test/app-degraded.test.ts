// 縮退モード（別のインスタンスがロックを持っているとき）と、ロックを取り直して通常のブリッジに戻る流れのテスト。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Logger } from '../src/log.js';
import { createDegradedDeps, startBridgeApp, startDegradedApp } from '../src/app.js';
import { ChannelServer } from '../src/mcp.js';
import { DM1, FakeDiscord } from './helpers/fake-discord.js';
import { sendPermissionRequest } from './helpers/app-harness.js';
import type { Notification } from './helpers/app-harness.js';

describe('縮退モード', () => {
  /** 縮退モードのツールが返す定型文（src/app.ts の createDegradedDeps と同じ文面） */
  const busy = 'error: 別のインスタンスが動いているため、この Discord ブリッジは送信できない';

  // 途中の expect で落ちても、relock の setInterval と MCP の接続を次のテストへ持ち越さないため、後始末は afterEach でまとめて行う。
  // app.stop は 2 回目以降は何もしないので、テストの中で stop を確かめた後に呼んでもよい
  const opened: { app: { stop: () => Promise<void> }; client: Client }[] = [];

  afterEach(async () => {
    for (const { app, client } of opened.splice(0)) {
      await client.close();
      await app.stop();
    }
  });

  it('ツールはすべて error 文を返し、permission_request は warn で無視する', async () => {
    const logger = new Logger({ stderr: false });
    const warnSpy = vi.spyOn(logger, 'warn');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
    const app = await startDegradedApp({ logger, transport: serverTransport });
    opened.push({ app, client });
    await client.connect(clientTransport);

    const reply = await client.callTool({ name: 'reply', arguments: { chat_id: DM1, text: 'hi' } });
    expect(reply.content).toEqual([{ type: 'text', text: busy }]);
    const react = await client.callTool({ name: 'react', arguments: { chat_id: DM1, message_id: '1', emoji: '👀' } });
    expect(react.content).toEqual([{ type: 'text', text: busy }]);
    const edit = await client.callTool({ name: 'edit_message', arguments: { chat_id: DM1, message_id: '1', text: 'x' } });
    expect(edit.content).toEqual([{ type: 'text', text: busy }]);

    await sendPermissionRequest(client);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('縮退モード');
  });

  describe('ロックの取り直し（relock）', () => {
    /** ツールの結果の 1 つ目の文 */
    const toolText = (res: Awaited<ReturnType<Client['callTool']>>): string =>
      (res.content as { type: string; text?: string }[])[0]?.text ?? '';

    /** tryAcquire が results の順に答える偽のロック（尽きたら最後の値）。calls.free を true にすると、それ以降は取れる */
    function fakeLock(results: boolean[]) {
      const calls = { acquire: 0, release: 0, free: false };
      const lock = {
        tryAcquire: () => {
          const acquired = calls.free || (results[Math.min(calls.acquire, results.length - 1)] ?? false);
          calls.acquire += 1;
          return acquired ? ({ acquired: true } as const) : ({ acquired: false, holder: { pid: 1, heartbeat: 0, startedAt: 0 } } as const);
        },
        release: () => void (calls.release += 1),
      };
      return { lock, calls };
    }

    /** failFirst なら、1 回目に戻るときの受信の開始を失敗させる */
    async function startDegraded(results: boolean[], failFirst = false) {
      const logger = new Logger({ stderr: false });
      const { lock, calls } = fakeLock(results);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
      const notifications: Notification[] = [];
      client.fallbackNotificationHandler = async (n) => {
        notifications.push(n as Notification);
      };
      const bridges: FakeDiscord[] = [];
      let promoted = 0;
      const app = await startDegradedApp({
        logger,
        transport: serverTransport,
        relock: {
          lock,
          intervalMs: 10,
          promote: async (server) => {
            const discord = new FakeDiscord();
            if (failFirst && bridges.length === 0) discord.failStart = new Error('Used disallowed intents');
            bridges.push(discord);
            const running = await startBridgeApp({ bridge: discord, logger, server, lock });
            promoted += 1;
            return running;
          },
        },
      });
      opened.push({ app, client });
      await client.connect(clientTransport);
      return { app, client, calls, notifications, bridges, promoted: () => promoted };
    }

    /** cond が真になるまで待つ（起きるのを待つ側。起きないことの確認は、下の各テストで固定時間を待つ） */
    async function waitFor(cond: () => boolean): Promise<void> {
      await vi.waitFor(() => expect(cond()).toBe(true), { timeout: 3000, interval: 5 });
    }

    /** 2 回取り損ねて縮退のまま待つ状態で起動する */
    async function startBusy() {
      const d = await startDegraded([false]);
      await waitFor(() => d.calls.acquire >= 2);
      return d;
    }

    /** ロックを空けて、通常のブリッジに戻り終わるまで待つ */
    async function freeAndWaitPromoted(d: Awaited<ReturnType<typeof startDegraded>>): Promise<void> {
      d.calls.free = true;
      await waitFor(() => d.promoted() === 1);
    }

    it('取れるまでは縮退のまま。取れたら同じ MCP の接続のまま通常のブリッジに戻り、Discord には投稿しない', async () => {
      const d = await startBusy();
      const before = await d.client.callTool({ name: 'reply', arguments: { chat_id: DM1, text: 'hi' } });
      expect(toolText(before)).toBe(busy);

      await freeAndWaitPromoted(d);
      expect(d.notifications.map((n) => n.method)).toContain('notifications/tools/list_changed');
      expect(d.bridges[0]?.texts()).toEqual([]);

      const after = await d.client.callTool({ name: 'reply', arguments: { chat_id: DM1, text: 'hi' } });
      expect(toolText(after)).toMatch(/^sent /);
    });

    it('通常のブリッジに戻った後は、ロックを取り直さない', async () => {
      const d = await startBusy();
      await freeAndWaitPromoted(d);
      const acquired = d.calls.acquire;

      await new Promise((r) => setTimeout(r, 30));
      expect(d.calls.acquire).toBe(acquired);
    });

    it('通常のブリッジに戻った後の stop は、通常のブリッジごと止めてロックを 1 回だけ手放す', async () => {
      const d = await startBusy();
      await freeAndWaitPromoted(d);

      await d.app.stop();
      expect(d.bridges[0]?.stopped).toBe(1);
      expect(d.calls.release).toBe(1);
    });

    it('戻るのに失敗したら、ロックを手放して縮退モードに戻り、次の間隔で取り直す', async () => {
      const d = await startDegraded([true], true);
      await waitFor(() => d.promoted() === 1);
      expect(d.bridges).toHaveLength(2);
      expect(d.bridges[0]?.stopped).toBe(1);
      // 1 回目の失敗の後片付けで、startBridgeApp の stop と縮退モードの両方が release する（2 回目は持ち主でないので何もしない）
      expect(d.calls.release).toBe(2);
      const reply = await d.client.callTool({ name: 'reply', arguments: { chat_id: DM1, text: 'hi' } });
      expect(toolText(reply)).toMatch(/^sent /);
    });

    it('失敗して縮退モードに戻った間は、ツールが error 文を返す', async () => {
      const d = await startDegraded([true, false], true);
      await waitFor(() => d.calls.acquire >= 2);
      const reply = await d.client.callTool({ name: 'reply', arguments: { chat_id: DM1, text: 'hi' } });
      expect(toolText(reply)).toBe(busy);
      expect(d.promoted()).toBe(0);
    });

    it('戻る途中に stop したら、戻り終わるのを待ってから通常のブリッジを止める', async () => {
      const logger = new Logger({ stderr: false });
      const { lock } = fakeLock([true]);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
      let entered = false;
      let finish: () => void = () => undefined;
      const promotedStop = vi.fn(async () => undefined);
      const app = await startDegradedApp({
        logger,
        transport: serverTransport,
        relock: {
          lock,
          intervalMs: 10,
          promote: async () => {
            entered = true;
            await new Promise<void>((r) => (finish = r));
            return { stop: promotedStop };
          },
        },
      });
      opened.push({ app, client });
      await client.connect(clientTransport);
      await waitFor(() => entered);

      let stopped = false;
      const stopping = app.stop().then(() => (stopped = true));
      await new Promise((r) => setTimeout(r, 20));
      expect(stopped).toBe(false);
      finish();
      await stopping;
      expect(promotedStop).toHaveBeenCalledTimes(1);
    });

    it('stop の後は取り直さない', async () => {
      const d = await startDegraded([false]);
      await d.app.stop();
      const count = d.calls.acquire;
      await new Promise((r) => setTimeout(r, 40));
      expect(d.calls.acquire).toBe(count);
    });
  });

  it('createDegradedDeps は logger をそのまま含む', async () => {
    const logger = new Logger({ stderr: false });
    const deps = createDegradedDeps(logger);
    expect(deps.logger).toBe(logger);
    expect(await deps.onReply({ chat_id: DM1, text: 'x' })).toMatch(/^error: /);
    // ChannelServer にそのまま渡せる
    expect(() => new ChannelServer(deps)).not.toThrow();
  });
});
