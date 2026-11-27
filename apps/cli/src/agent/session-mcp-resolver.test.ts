import { describe, expect, it, vi } from 'vitest';

import type {
  McpServerId,
  SessionId,
  WorkspaceFlockReadableFlock,
  WorkspaceId,
  WorkspaceMcpServerMeta,
} from '@lody/shared';
import {
  EMPTY_MCP_CONFIG_FINGERPRINT,
  loadSessionMcpCatalog,
  readSessionMcpAuthRevisions,
  readSessionMcpConfigFingerprint,
  sessionMcpAuthRevisionsChanged,
} from './session-mcp-resolver';
import { WorkspaceSyncUnavailableError } from '@/lib/command-runtime';

const workspaceId = 'workspace-1' as WorkspaceId;
const sessionId = 'session-1' as SessionId;
const selectedId = 'server-1' as McpServerId;

const flockWithRows = (rows: Array<{ key: readonly unknown[]; value: unknown }>) =>
  ({
    scan: ({ prefix }: { prefix?: readonly unknown[] } = {}) =>
      rows.filter(({ key }) => prefix?.every((part, index) => key[index] === part) ?? true),
  }) satisfies WorkspaceFlockReadableFlock;

const catalogFlock = flockWithRows([
  {
    key: ['mcpServer', selectedId],
    value: {
      id: selectedId,
      name: 'filesystem',
      transport: 'stdio',
      connection: {
        transport: 'stdio',
        command: '${NODE_BIN}',
        args: ['${ENTRYPOINT}'],
      },
      createdAt: 1,
      updatedAt: 1,
    },
  },
]);

describe('loadSessionMcpCatalog', () => {
  it('does not need a catalog for an empty selection', async () => {
    const unexpectedRead = async (): Promise<never> => {
      throw new Error('Empty selections must not access the catalog');
    };
    const select = await loadSessionMcpCatalog({
      repo: { openFlockDoc: unexpectedRead },
      waitForCatalogBaseline: unexpectedRead,
      workspaceId,
      sessionId,
      selectedIds: [],
      logger: { debug: vi.fn() },
    });
    expect(select(undefined)).toMatchObject({ servers: [], problems: [] });
  });

  it('waits for the shared baseline and then loads the selected server', async () => {
    const baseline = Promise.withResolvers<void>();
    let ready = false;
    const loading = loadSessionMcpCatalog({
      repo: {
        openFlockDoc: async () => {
          if (!ready) throw new Error('Read before the baseline');
          return { flock: catalogFlock };
        },
      },
      waitForCatalogBaseline: () => baseline.promise,
      workspaceId,
      sessionId,
      selectedIds: [selectedId],
      logger: { debug: vi.fn() },
      env: { NODE_BIN: 'node', ENTRYPOINT: 'server.js' },
    });
    ready = true;
    baseline.resolve();
    const select = await loading;
    expect(select(undefined).servers).toHaveLength(1);
  });

  it('preserves the original cold-baseline error instead of freezing an empty catalog', async () => {
    const cause = new Error('Synthetic initial-sync timeout');
    const error = new WorkspaceSyncUnavailableError({ message: 'Catalog is still syncing', cause });
    const loading = loadSessionMcpCatalog({
      repo: { openFlockDoc: async () => ({ flock: flockWithRows([]) }) },
      waitForCatalogBaseline: async () => {
        throw error;
      },
      workspaceId,
      sessionId,
      selectedIds: [selectedId],
      logger: { debug: () => {} },
    });
    await expect(loading).rejects.toBe(error);
    expect(error.cause).toBe(cause);
  });
});

describe('session MCP configuration fingerprint', () => {
  const httpId = 'server-2' as McpServerId;
  const stdio: WorkspaceMcpServerMeta = {
    id: selectedId,
    name: 'filesystem',
    transport: 'stdio',
    connection: {
      transport: 'stdio',
      command: '${NODE_BIN}',
      args: ['server.js'],
      env: { TOKEN: '${TOKEN}' },
      envPassthrough: ['HOME'],
    },
    createdAt: 1,
    updatedAt: 1,
  };
  const http: WorkspaceMcpServerMeta = {
    id: httpId,
    name: 'remote',
    transport: 'http',
    connection: {
      transport: 'http',
      url: 'https://mcp.example/a',
      bearerToken: '${TOKEN}',
      headers: { 'x-a': '${HEADER_A}', 'x-b': '${HEADER_B}' },
    },
    createdAt: 1,
    updatedAt: 1,
  };
  const env = {
    NODE_BIN: 'node',
    TOKEN: 'synthetic-token',
    HOME: '/home/synthetic',
    HEADER_A: 'a',
    HEADER_B: 'b',
  };
  const repoFor = (...servers: WorkspaceMcpServerMeta[]) => ({
    openFlockDoc: async () => ({
      flock: flockWithRows(servers.map((value) => ({ key: ['mcpServer', value.id], value }))),
    }),
  });
  const read = (
    servers: WorkspaceMcpServerMeta[],
    options: { selectedIds?: McpServerId[]; env?: Record<string, string> } = {}
  ) =>
    readSessionMcpConfigFingerprint({
      repo: repoFor(...servers),
      workspaceId,
      selectedIds: options.selectedIds ?? [selectedId, httpId],
      env: options.env ?? env,
    });
  const mountOf = async (
    servers: WorkspaceMcpServerMeta[],
    selectedIds = [selectedId, httpId],
    getAuthRevision?: (id: string) => number
  ) => {
    const select = await loadSessionMcpCatalog({
      repo: repoFor(...servers),
      workspaceId,
      sessionId,
      selectedIds,
      logger: { debug: () => {} },
      env,
      getAuthRevision,
    });
    return select({ http: true }).mount;
  };

  it('matches the configuration a session start mounted, regardless of key or ID order', async () => {
    const baseline = await read([stdio, http]);
    expect((await mountOf([stdio, http]))?.fingerprint).toBe(baseline);
    const reordered: WorkspaceMcpServerMeta = {
      updatedAt: 2,
      connection: {
        headers: { 'x-b': '${HEADER_B}', 'x-a': '${HEADER_A}' },
        bearerToken: '${TOKEN}',
        url: 'https://mcp.example/a',
        transport: 'http',
      },
      transport: 'http',
      name: 'remote',
      id: httpId,
      createdAt: 1,
    };
    expect(await read([reordered, stdio], { selectedIds: [httpId, selectedId] })).toBe(baseline);
  });

  it.each([
    {
      field: 'transport',
      server: {
        ...stdio,
        transport: 'http',
        connection: { transport: 'http', url: 'https://mcp.example/stdio' },
      },
    },
    { field: 'url', server: { ...http, connection: { ...http.connection!, url: 'https://b' } } },
    {
      field: 'headers',
      server: { ...http, connection: { ...http.connection!, headers: { 'x-a': '${HEADER_B}' } } },
    },
    {
      field: 'bearerToken',
      server: { ...http, connection: { ...http.connection!, bearerToken: undefined } },
    },
    {
      field: 'authentication',
      server: { ...http, connection: { ...http.connection!, authentication: 'local' } },
    },
    { field: 'name', server: { ...http, name: 'renamed' } },
    {
      field: 'command',
      server: { ...stdio, connection: { ...stdio.connection!, command: 'bun' } },
    },
    { field: 'args', server: { ...stdio, connection: { ...stdio.connection!, args: ['b.js'] } } },
    {
      field: 'env',
      server: { ...stdio, connection: { ...stdio.connection!, env: { OTHER: '${TOKEN}' } } },
    },
    {
      field: 'envPassthrough',
      server: { ...stdio, connection: { ...stdio.connection!, envPassthrough: [] } },
    },
  ] as Array<{ field: string; server: WorkspaceMcpServerMeta }>)(
    'changes when a selected server edits $field under the same ID',
    async ({ server }) => {
      const baseline = await read([stdio, http]);
      const edited = await read(server.id === httpId ? [stdio, server] : [server, http]);
      expect(edited).toEqual(expect.any(String));
      expect(edited).not.toBe(baseline);
    }
  );

  it('changes with resolved daemon values', async () => {
    const baseline = await read([stdio, http]);
    expect(await read([stdio, http], { env: { ...env, TOKEN: 'rotated' } })).not.toBe(baseline);
  });

  it('records local credential revisions so a later change is visible without the catalog', async () => {
    const revisions = new Map([[httpId as string, 3]]);
    const getAuthRevision = (id: string) => revisions.get(id) ?? 0;
    const mount = await mountOf([stdio, http], [selectedId, httpId], getAuthRevision);
    expect(mount?.authRevisions).toEqual({ [selectedId]: 0, [httpId]: 3 });
    const current = () => readSessionMcpAuthRevisions([selectedId, httpId], getAuthRevision);
    expect(sessionMcpAuthRevisionsChanged(mount, current())).toBe(false);
    revisions.set(httpId, 4);
    expect(sessionMcpAuthRevisionsChanged(mount, current())).toBe(true);
  });

  it('reports an unknown mount when the catalog is unavailable, and empty selections as empty', async () => {
    const failing = { openFlockDoc: async (): Promise<never> => Promise.reject(new Error('down')) };
    const select = await loadSessionMcpCatalog({
      repo: failing,
      workspaceId,
      sessionId,
      selectedIds: [selectedId],
      logger: { debug: () => {} },
      getAuthRevision: () => 2,
    });
    expect(select(undefined)).toMatchObject({
      problems: [{ kind: 'catalog_unavailable', reason: expect.any(String) }],
      mount: { fingerprint: undefined, authRevisions: { [selectedId]: 2 } },
    });
    expect(
      await readSessionMcpConfigFingerprint({
        repo: failing,
        workspaceId,
        selectedIds: [selectedId],
        env,
      })
    ).toBeUndefined();
    expect(await read([stdio], { selectedIds: [selectedId] })).toEqual(expect.any(String));
    expect((await mountOf([stdio], []))?.fingerprint).toBe(EMPTY_MCP_CONFIG_FINGERPRINT);
  });
});
