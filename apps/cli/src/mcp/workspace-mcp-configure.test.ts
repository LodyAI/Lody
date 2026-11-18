import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServerId, WorkspaceId, WorkspaceMcpServerMeta } from '@lody/shared';
import { WorkspaceSyncUnavailableError } from '@/lib/command-runtime';
import { buildLodyMcpServer } from './lody-mcp-server';
import {
  configureWorkspaceMcpServer,
  WorkspaceMcpConfigureToolInputSchema,
} from './workspace-mcp-configure';

const workspaceId = 'workspace-1' as WorkspaceId;
const manager = { repo: {} };

const existingServer = (): WorkspaceMcpServerMeta => ({
  id: 'server-1' as McpServerId,
  name: 'Filesystem',
  description: 'Existing description',
  transport: 'stdio',
  connection: { transport: 'stdio', command: 'old-command' },
  enabledByDefault: true,
  createdAt: 10,
  updatedAt: 20,
  createdBy: 'user-1',
});

const makeDeps = (servers: WorkspaceMcpServerMeta[] = []) => ({
  syncCatalog: vi.fn(async () => undefined),
  listCatalog: vi.fn(async () => servers),
  upsertEntry: vi.fn(async () => ({ changed: true, synced: true })),
  now: vi.fn(() => 30),
  createId: vi.fn(() => 'new-server' as McpServerId),
});

describe('lody_mcp_configure input', () => {
  it('accepts strict stdio and HTTP configurations', () => {
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'filesystem',
        connection: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          envPassthrough: ['HOME'],
        },
      }).success
    ).toBe(true);
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'search',
        connection: {
          transport: 'http',
          url: 'https://mcp.example.test',
          bearerToken: '${SEARCH_TOKEN}',
        },
      }).success
    ).toBe(true);
  });

  it('rejects unsafe names, literal credentials, invalid connections, and extra fields', () => {
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'bad',
        connection: { transport: 'stdio', command: '   ' },
      }).success
    ).toBe(false);
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'bad',
        connection: {
          transport: 'http',
          url: 'https://example.test',
          headers: { 'X-Token': '${A}', ' X-Token ': '${B}' },
        },
      }).success
    ).toBe(false);
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'bad',
        connection: {
          transport: 'stdio',
          command: 'node',
          env: { TOKEN: '${A}', ' TOKEN ': '${B}' },
        },
      }).success
    ).toBe(false);
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'bad',
        connection: {
          transport: 'http',
          url: 'https://example.test',
          headers: { 'X-Token': '${A}', 'x-token': '${B}' },
        },
      }).success
    ).toBe(false);
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'bad',
        connection: {
          transport: 'http',
          url: 'https://example.test',
          bearerToken: '${A}',
          headers: { Authorization: '${B}' },
        },
      }).success
    ).toBe(false);
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'LODY',
        connection: { transport: 'stdio', command: 'node' },
      }).success
    ).toBe(false);
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'bad',
        connection: {
          transport: 'http',
          url: 'https://user:password@example.test/mcp',
        },
      }).success
    ).toBe(false);
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'bad',
        connection: {
          transport: 'http',
          url: 'https://example.test/mcp?api_key=literal-secret',
        },
      }).success
    ).toBe(false);
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'bad',
        connection: {
          transport: 'http',
          url: 'https://example.test',
          bearerToken: 'literal-secret',
        },
      }).success
    ).toBe(false);
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'bad',
        connection: {
          transport: 'http',
          url: 'https://example.test',
          headers: { Authorization: 'literal-secret' },
        },
      }).success
    ).toBe(false);
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'bad',
        connection: { transport: 'http', url: 'https://example.test', headers: { '': 'x' } },
      }).success
    ).toBe(false);
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'x'.repeat(129),
        connection: { transport: 'stdio', command: 'node' },
      }).success
    ).toBe(false);
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'bad',
        connection: { transport: 'stdio', command: 'node', envPassthrough: ['BAD-NAME'] },
      }).success
    ).toBe(false);
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'bad',
        connection: { transport: 'http', url: 'https://example.test', command: 'node' },
      }).success
    ).toBe(false);
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'bad',
        connection: { transport: 'http', url: 'https://example.test' },
        workspaceId: 'other-workspace',
      }).success
    ).toBe(false);
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'bad',
        connection: { transport: 'http', url: 'https://example.test' },
        enabledByDefault: true,
      }).success
    ).toBe(false);
    expect(
      WorkspaceMcpConfigureToolInputSchema.safeParse({
        name: 'too-large',
        connection: {
          transport: 'stdio',
          command: 'node',
          args: Array.from({ length: 64 }, () => 'x'.repeat(4_096)),
        },
      }).success
    ).toBe(false);
  });

  it('is published by the Lody MCP server with both connection transports', async () => {
    const server = buildLodyMcpServer();
    const client = new Client({ name: 'schema-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.listTools();
      const tool = result.tools.find(({ name }) => name === 'lody_mcp_configure');
      expect(tool?.inputSchema).toMatchObject({
        type: 'object',
        required: expect.arrayContaining(['name', 'connection']),
        properties: {
          name: expect.objectContaining({ type: 'string' }),
          connection: expect.objectContaining({
            oneOf: expect.arrayContaining([
              expect.objectContaining({
                properties: expect.objectContaining({
                  transport: { const: 'stdio', type: 'string' },
                  command: expect.objectContaining({ type: 'string' }),
                }),
              }),
              expect.objectContaining({
                properties: expect.objectContaining({
                  transport: { const: 'http', type: 'string' },
                  url: expect.objectContaining({ type: 'string' }),
                }),
              }),
            ]),
          }),
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('configureWorkspaceMcpServer', () => {
  it('creates a new catalog entry without returning credentials', async () => {
    const deps = makeDeps();
    const result = await configureWorkspaceMcpServer(
      manager as never,
      workspaceId,
      'user-1',
      {
        name: 'Search',
        connection: {
          transport: 'http',
          url: 'https://mcp.example.test',
          bearerToken: '${SEARCH_TOKEN}',
          headers: { 'X-Secret': '${SEARCH_HEADER}' },
        },
      },
      deps
    );

    expect(deps.upsertEntry).toHaveBeenCalledWith(
      manager,
      workspaceId,
      expect.objectContaining({
        id: 'new-server',
        name: 'Search',
        createdAt: 30,
        updatedAt: 30,
        createdBy: 'user-1',
        connection: expect.objectContaining({ bearerToken: '${SEARCH_TOKEN}' }),
      })
    );
    expect(result).toEqual({
      action: 'created',
      changed: true,
      synced: true,
      server: {
        id: 'new-server',
        name: 'Search',
        transport: 'http',
        enabledByDefault: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain('SEARCH_TOKEN');
  });

  it('refuses to overwrite an existing case-insensitive name match', async () => {
    const current = existingServer();
    const deps = makeDeps([current]);
    await expect(
      configureWorkspaceMcpServer(
        manager as never,
        workspaceId,
        'another-user',
        {
          name: 'filesystem',
          connection: { transport: 'stdio', command: 'npx' },
        },
        deps
      )
    ).rejects.toThrow('already exists');
    expect(deps.upsertEntry).not.toHaveBeenCalled();
  });

  it('serializes concurrent creates so a canonical name is written once', async () => {
    const servers: WorkspaceMcpServerMeta[] = [];
    let id = 0;
    const deps = {
      syncCatalog: vi.fn(async () => undefined),
      listCatalog: vi.fn(async () => [...servers]),
      upsertEntry: vi.fn(async (_repo, _workspaceId, entry: WorkspaceMcpServerMeta) => {
        servers.push(entry);
        return { changed: true, synced: true };
      }),
      now: vi.fn(() => 30),
      createId: vi.fn(() => `new-server-${id++}` as McpServerId),
    };

    const results = await Promise.allSettled([
      configureWorkspaceMcpServer(
        manager as never,
        workspaceId,
        'user-1',
        { name: 'Search', connection: { transport: 'stdio', command: 'node' } },
        deps
      ),
      configureWorkspaceMcpServer(
        manager as never,
        workspaceId,
        'user-2',
        { name: 'search', connection: { transport: 'stdio', command: 'node' } },
        deps
      ),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(servers).toHaveLength(1);
  });

  it('serializes concurrent creates at the Agent catalog limit', async () => {
    const servers = Array.from({ length: 99 }, (_, index) => ({
      ...existingServer(),
      id: `server-${index}` as McpServerId,
      name: `Server ${index}`,
    }));
    let id = 0;
    const deps = {
      syncCatalog: vi.fn(async () => undefined),
      listCatalog: vi.fn(async () => [...servers]),
      upsertEntry: vi.fn(async (_repo, _workspaceId, entry: WorkspaceMcpServerMeta) => {
        servers.push(entry);
        return { changed: true, synced: true };
      }),
      now: vi.fn(() => 30),
      createId: vi.fn(() => `new-server-${id++}` as McpServerId),
    };

    const results = await Promise.allSettled([
      configureWorkspaceMcpServer(
        manager as never,
        workspaceId,
        'user-1',
        { name: 'Search', connection: { transport: 'stdio', command: 'node' } },
        deps
      ),
      configureWorkspaceMcpServer(
        manager as never,
        workspaceId,
        'user-2',
        { name: 'Filesystem', connection: { transport: 'stdio', command: 'node' } },
        deps
      ),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(servers).toHaveLength(100);
  });

  it('rejects a new entry when the bounded Agent-authored catalog is full', async () => {
    const servers = Array.from({ length: 100 }, (_, index) => ({
      ...existingServer(),
      id: `server-${index}` as McpServerId,
      name: `Server ${index}`,
    }));
    const deps = makeDeps(servers);

    await expect(
      configureWorkspaceMcpServer(
        manager as never,
        workspaceId,
        'user-1',
        { name: 'One more', connection: { transport: 'stdio', command: 'node' } },
        deps
      )
    ).rejects.toThrow('already contains 100 entries');
    expect(deps.upsertEntry).not.toHaveBeenCalled();
  });

  it('maps a pre-read synchronization failure to a retryable MCP error', async () => {
    const deps = makeDeps();
    deps.syncCatalog.mockRejectedValueOnce(new Error('offline'));

    const error = await configureWorkspaceMcpServer(
      manager as never,
      workspaceId,
      'user-1',
      { name: 'Search', connection: { transport: 'http', url: 'https://example.test' } },
      deps
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(WorkspaceSyncUnavailableError);
    expect(deps.listCatalog).not.toHaveBeenCalled();
    expect(deps.upsertEntry).not.toHaveBeenCalled();
  });

  it('surfaces locally durable upload failures instead of claiming synchronization', async () => {
    const deps = makeDeps();
    deps.upsertEntry.mockResolvedValueOnce({
      changed: true,
      synced: false,
      syncError: 'network unavailable',
    });

    const result = await configureWorkspaceMcpServer(
      manager as never,
      workspaceId,
      'user-1',
      { name: 'Search', connection: { transport: 'http', url: 'https://example.test' } },
      deps
    );

    expect(result).toMatchObject({
      action: 'created',
      changed: true,
      synced: false,
      syncError: 'network unavailable',
    });
  });
});
