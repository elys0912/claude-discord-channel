import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ChannelServer, INSTRUCTIONS, SERVER_NAME } from '../src/mcp.js';
import type { McpDeps } from '../src/mcp.js';
import { Logger } from '../src/log.js';
import type { PermissionRequest } from '../src/permission.js';

interface Captured {
  notifications: { method: string; params?: Record<string, unknown> }[];
  permissionRequests: PermissionRequest[];
  replies: unknown[];
  reacts: unknown[];
  edits: unknown[];
}

async function connect(
  overrides: Partial<Pick<McpDeps, 'onReply' | 'onDownload' | 'onSendFile'>> = {}
): Promise<{ client: Client; server: ChannelServer; captured: Captured }> {
  const captured: Captured = {
    notifications: [],
    permissionRequests: [],
    replies: [],
    reacts: [],
    edits: [],
  };

  const server = new ChannelServer({
    logger: new Logger({ stderr: false }),
    onReply:
      overrides.onReply ??
      (async (a) => {
        captured.replies.push(a);
        return 'sent (1 message(s))';
      }),
    onReact: async (a) => {
      captured.reacts.push(a);
      return 'reacted';
    },
    onEdit: async (a) => {
      captured.edits.push(a);
      return 'edited';
    },
    onPermissionRequest: (req) => {
      captured.permissionRequests.push(req);
    },
    onDownload: overrides.onDownload,
    onSendFile: overrides.onSendFile,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
  client.fallbackNotificationHandler = async (n) => {
    captured.notifications.push(n as { method: string; params?: Record<string, unknown> });
  };

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server, captured };
}

describe('ChannelServer の initialize', () => {
  it('channel / permission / tools の capabilities を出す', async () => {
    const { client, server } = await connect();
    const caps = client.getServerCapabilities();
    expect(caps?.experimental).toBeDefined();
    expect(caps?.experimental?.['claude/channel']).toEqual({});
    expect(caps?.experimental?.['claude/channel/permission']).toEqual({});
    expect(caps?.tools).toEqual({});
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect(SERVER_NAME).toBe('discordbridge');
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    await client.close();
    await server.close();
  });

  it('instructions に安全上の規則と Discord 向けの返し方が含まれる', () => {
    expect(INSTRUCTIONS).toContain('reply');
    expect(INSTRUCTIONS).toContain('access.json');
    expect(INSTRUCTIONS).toContain('トークン');
    expect(INSTRUCTIONS).toContain('データ');
    expect(INSTRUCTIONS).toContain('thread_id');
    expect(INSTRUCTIONS).toContain('Unicode の絵文字');
    expect(INSTRUCTIONS).toContain('keepalive');
  });
});

describe('ChannelServer の tools', () => {
  it('reply / react / edit_message を出し、thread_id は省略できる', async () => {
    const { client, server } = await connect();
    const res = await client.listTools();
    expect(res.tools.map((t) => t.name).sort()).toEqual(['edit_message', 'react', 'reply']);

    const reply = res.tools.find((t) => t.name === 'reply');
    expect(reply?.inputSchema.type).toBe('object');
    expect(Object.keys(reply?.inputSchema.properties ?? {}).sort()).toEqual(['chat_id', 'text', 'thread_id']);
    expect(reply?.inputSchema.required).toEqual(['chat_id', 'text']);

    const react = res.tools.find((t) => t.name === 'react');
    expect(Object.keys(react?.inputSchema.properties ?? {}).sort()).toEqual(['chat_id', 'emoji', 'message_id', 'thread_id']);
    expect(react?.inputSchema.required).toEqual(['chat_id', 'message_id', 'emoji']);
    await client.close();
    await server.close();
  });

  it('onDownload があれば download_file を出し、引数を渡して呼ぶ', async () => {
    const calls: unknown[] = [];
    const { client } = await connect({
      onDownload: async (a) => {
        calls.push(a);
        return 'saved: x';
      },
    });
    const res = await client.listTools();
    expect(res.tools.map((t) => t.name).sort()).toEqual(['download_file', 'edit_message', 'react', 'reply']);
    expect(res.tools.find((t) => t.name === 'download_file')?.inputSchema.required).toEqual(['chat_id', 'message_id', 'attachment_id']);

    const args = { chat_id: 'D1', message_id: '100', attachment_id: '200', extract: true };
    const out = await client.callTool({ name: 'download_file', arguments: args });
    expect(out.content).toEqual([{ type: 'text', text: 'saved: x' }]);
    expect(calls).toEqual([args]);
  });

  it('onDownload が無ければ download_file は出さず、呼ばれてもエラー', async () => {
    const { client } = await connect();
    const out = await client.callTool({ name: 'download_file', arguments: { chat_id: 'D1', message_id: '1', attachment_id: '2' } });
    expect(out.isError).toBe(true);
  });

  it('onSendFile があれば send_file を出す。paths は 1〜10 個', async () => {
    const calls: unknown[] = [];
    const { client } = await connect({
      onSendFile: async (a) => {
        calls.push(a);
        return 'sent';
      },
    });
    const res = await client.listTools();
    expect(res.tools.map((t) => t.name)).toContain('send_file');

    const ok = await client.callTool({ name: 'send_file', arguments: { chat_id: 'D1', paths: ['C:\\a.txt'], text: 'どうぞ' } });
    expect(ok.content).toEqual([{ type: 'text', text: 'sent' }]);
    expect(calls).toEqual([{ chat_id: 'D1', paths: ['C:\\a.txt'], text: 'どうぞ' }]);

    const empty = await client.callTool({ name: 'send_file', arguments: { chat_id: 'D1', paths: [] } });
    expect(empty.isError).toBe(true);
    const many = await client.callTool({ name: 'send_file', arguments: { chat_id: 'D1', paths: Array.from({ length: 11 }, (_, i) => `C:\\${i}`) } });
    expect(many.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('onSendFile が無ければ send_file は出さない', async () => {
    const { client } = await connect();
    const res = await client.listTools();
    expect(res.tools.map((t) => t.name)).not.toContain('send_file');
  });

  it('reply を呼ぶとハンドラに渡り、結果が返る', async () => {
    const { client, server, captured } = await connect();
    const res = await client.callTool({
      name: 'reply',
      arguments: { chat_id: 'D1', text: 'hi', thread_id: '100' },
    });
    expect(captured.replies[0]).toEqual({ chat_id: 'D1', text: 'hi', thread_id: '100' });
    expect(res.content).toEqual([{ type: 'text', text: 'sent (1 message(s))' }]);
    await client.close();
    await server.close();
  });

  it('react / edit_message も渡る', async () => {
    const { client, server, captured } = await connect();
    await client.callTool({ name: 'react', arguments: { chat_id: 'D1', message_id: '11', emoji: '👀' } });
    await client.callTool({ name: 'edit_message', arguments: { chat_id: 'D1', message_id: '11', text: 'new', thread_id: '10' } });
    expect(captured.reacts[0]).toEqual({ chat_id: 'D1', message_id: '11', emoji: '👀' });
    expect(captured.edits[0]).toEqual({ chat_id: 'D1', message_id: '11', text: 'new', thread_id: '10' });
    await client.close();
    await server.close();
  });

  it('引数が足りなければ isError を返して例外は投げない', async () => {
    const { client, server } = await connect();
    const res = await client.callTool({ name: 'reply', arguments: { chat_id: 'D1' } });
    expect(res.isError).toBe(true);
    await client.close();
    await server.close();
  });

  it('知らないツールは isError', async () => {
    const { client, server } = await connect();
    const res = await client.callTool({ name: 'nope', arguments: {} });
    expect(res.isError).toBe(true);
    await client.close();
    await server.close();
  });

  it('ハンドラが投げても isError になる', async () => {
    const { client, server } = await connect({
      onReply: async () => {
        throw new Error('discord down');
      },
    });
    const res = await client.callTool({ name: 'reply', arguments: { chat_id: 'D1', text: 'hi' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('discord down');
    await client.close();
    await server.close();
  });
});

describe('ChannelServer の通知', () => {
  it('pushMessage が notifications/claude/channel を送る（meta の不正なキーは落とす）', async () => {
    const { client, server, captured } = await connect();
    await server.pushMessage('hello', { chat_id: 'D1', 'bad-key': 'x', ok_key: 'y' });
    await new Promise((r) => setTimeout(r, 20));

    const n = captured.notifications.find((x) => x.method === 'notifications/claude/channel');
    expect(n).toBeDefined();
    expect(n?.params?.content).toBe('hello');
    expect(n?.params?.meta).toEqual({ chat_id: 'D1', ok_key: 'y' });
    await client.close();
    await server.close();
  });

  it('sendVerdict が notifications/claude/channel/permission を送る', async () => {
    const { client, server, captured } = await connect();
    await server.sendVerdict({ requestId: 'abcde', behavior: 'deny' });
    await new Promise((r) => setTimeout(r, 20));

    const n = captured.notifications.find((x) => x.method === 'notifications/claude/channel/permission');
    expect(n?.params).toEqual({ request_id: 'abcde', behavior: 'deny' });
    await client.close();
    await server.close();
  });

  it('permission_request の通知でハンドラが呼ばれる', async () => {
    const { client, server, captured } = await connect();
    await client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: {
        request_id: 'abcde',
        tool_name: 'Bash',
        description: 'Run shell command',
        input_preview: '{"command":"ls"}',
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(captured.permissionRequests[0]).toEqual({
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Run shell command',
      input_preview: '{"command":"ls"}',
    });
    await client.close();
    await server.close();
  });

  it.each(['ABCDE', 'abcdl', 'abcd', 'abcdef', '@everyone'])(
    'request_id が不正（%s）なら Discord 側に渡さず、warn して deny を返す',
    async (requestId) => {
      const { client, server, captured } = await connect();
      await client.notification({
        method: 'notifications/claude/channel/permission_request',
        params: { request_id: requestId, tool_name: 'Bash', description: 'd', input_preview: 'p' },
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(captured.permissionRequests).toHaveLength(0);
      const verdicts = captured.notifications.filter((x) => x.method === 'notifications/claude/channel/permission');
      expect(verdicts.map((v) => v.params)).toEqual([{ request_id: requestId, behavior: 'deny' }]);
      await client.close();
      await server.close();
    }
  );
});
