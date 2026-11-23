import { afterEach, describe, expect, it, vi } from 'vitest';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  JSONRPCRequestSchema,
  JSONRPCNotificationSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpServerId, WorkspaceMcpServerMeta } from '@lody/shared';
import { listMcpTools } from './list-mcp-tools';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const entry: WorkspaceMcpServerMeta = {
  id: 'test' as McpServerId,
  name: 'Test',
  transport: 'stdio',
  connection: { transport: 'stdio', command: 'synthetic-mcp' },
  createdAt: 1,
  updatedAt: 1,
};

async function fixture(
  list: (cursor?: string) => {
    tools: { name: string; description?: string; inputSchema: { type: 'object' } }[];
    nextCursor?: string;
  },
  hasTools = true
) {
  const server = new Server(
    { name: 'synthetic', version: '1' },
    { capabilities: hasTools ? { tools: {} } : {} }
  );
  if (hasTools)
    server.setRequestHandler(ListToolsRequestSchema, (request) => list(request.params?.cursor));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let closed = false;
  server.onclose = () => {
    closed = true;
  };
  await server.connect(serverTransport);
  return { options: { createTransport: () => clientTransport }, isClosed: () => closed };
}

describe('settings MCP tool discovery', () => {
  it.each([true, false])(
    'collects the available tools and closes (tools capability=%s)',
    async (hasTools) => {
      const f = await fixture(
        (cursor) =>
          cursor === 'page-2'
            ? { tools: [{ name: 'search', inputSchema: { type: 'object' } }] }
            : {
                tools: [
                  { name: 'read', description: 'Read files', inputSchema: { type: 'object' } },
                ],
                nextCursor: 'page-2',
              },
        hasTools
      );
      expect(await listMcpTools(entry, f.options)).toEqual({
        type: 'mcp/tools',
        tools: hasTools ? [{ name: 'read', description: 'Read files' }, { name: 'search' }] : [],
      });
      expect(f.isClosed()).toBe(true);
    }
  );
  it.each(['pagination', 'server error'])(
    'sanitizes %s failures and closes without partial results',
    async (failure) => {
      const f = await fixture((cursor) => {
        if (failure === 'server error') throw new Error('secret token');
        return { tools: [], nextCursor: String(Number(cursor ?? 0) + 1) };
      });
      await expect(listMcpTools(entry, f.options)).rejects.toThrow(/^MCP tool discovery failed\.$/);
      expect(f.isClosed()).toBe(true);
    }
  );
  it('rejects unresolved environment references before connecting', async () => {
    await expect(
      listMcpTools(
        { ...entry, connection: { transport: 'stdio', command: '${MISSING}' } },
        { env: {} }
      )
    ).rejects.toThrow('configuration is incomplete');
  });
});

it.each(['2025-11-25', '2026-07-28'])(
  'discovers tools from a %s-only HTTP server',
  async (version) => {
    const modern = version === '2026-07-28';
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url, init) => {
        expect(String(url)).toBe('https://synthetic.example/mcp');
        expect(init?.redirect).toBe('error');
        if (init?.method !== 'POST') return new Response(null, { status: 405 });
        const request = JSONRPCRequestSchema.or(JSONRPCNotificationSchema).parse(
          JSON.parse(String(init.body))
        );
        if (!('id' in request)) return new Response(null, { status: 202 });
        const info = {
          capabilities: { tools: {} },
          serverInfo: { name: 'synthetic', version: '1' },
        };
        if (request.method === (modern ? 'initialize' : 'server/discover')) {
          return Response.json({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: 'Method not found' },
          });
        }
        const result =
          request.method === 'server/discover'
            ? { ...info, resultType: 'complete', supportedVersions: [version] }
            : request.method === 'initialize'
              ? { ...info, protocolVersion: version }
              : {
                  ...(modern ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private' } : {}),
                  tools: [{ name: 'read_file', inputSchema: { type: 'object' } }],
                };
        return Response.json({ jsonrpc: '2.0', id: request.id, result });
      })
    );
    expect(
      await listMcpTools({
        ...entry,
        transport: 'http',
        connection: { transport: 'http', url: 'https://synthetic.example/mcp' },
      })
    ).toEqual({ type: 'mcp/tools', tools: [{ name: 'read_file' }] });
  }
);

it.each([
  'file:///tmp/mcp',
  'ftp://synthetic.example/mcp',
  'https://user:secret@synthetic.example/mcp',
  'invalid',
])('rejects an invalid discovery URL: %s', async (url) => {
  await expect(
    listMcpTools({ ...entry, transport: 'http', connection: { transport: 'http', url } })
  ).rejects.toThrow('MCP HTTP URL must use HTTP(S) without embedded credentials.');
});

it('passes only explicit credentials to the stdio child', async () => {
  vi.stubEnv('LODY_TEST_UNRELATED_SECRET', 'synthetic-unrelated');
  vi.stubEnv('LODY_TEST_ALLOWED_SECRET', 'synthetic-allowed');
  const result = await listMcpTools({
    ...entry,
    connection: {
      transport: 'stdio',
      command: process.execPath,
      args: [
        '-e',
        String.raw`
        require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
          const request = JSON.parse(line);
          if (request.id === undefined) return;
          const result = request.method === 'initialize'
            ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } }
            : { tools: ['LODY_TEST_UNRELATED_SECRET', 'LODY_TEST_ALLOWED_SECRET', 'LODY_TEST_EXPLICIT'].filter(name => process.env[name]).map(name => ({ name, description: process.env[name], inputSchema: { type: 'object' } })) };
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(request.method === 'server/discover' ? { error: { code: -32601, message: 'Method not found' } } : { result }) }) + '\n');
        });
      `,
      ],
      env: { LODY_TEST_EXPLICIT: '${LODY_TEST_ALLOWED_SECRET}', ELECTRON_RUN_AS_NODE: '1' },
      envPassthrough: ['LODY_TEST_ALLOWED_SECRET'],
    },
  });
  expect(result.tools).toEqual([
    { name: 'LODY_TEST_ALLOWED_SECRET', description: 'synthetic-allowed' },
    { name: 'LODY_TEST_EXPLICIT', description: 'synthetic-allowed' },
  ]);
});
