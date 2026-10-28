import { describe, expect, it, vi } from 'vitest';

import type {
  McpServerId,
  SessionId,
  WorkspaceFlockReadableFlock,
  WorkspaceId,
} from '@lody/shared';
import { loadSessionMcpCatalog } from './session-mcp-resolver';

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
    expect(select(undefined)).toEqual({ servers: [], problems: [] });
  });

  it('reads the catalog and expands target-daemon environment variables', async () => {
    const select = await loadSessionMcpCatalog({
      repo: { openFlockDoc: vi.fn(async () => ({ flock: catalogFlock })) },
      workspaceId,
      sessionId,
      selectedIds: [selectedId],
      logger: { debug: vi.fn() },
      env: { NODE_BIN: 'node', ENTRYPOINT: 'server.js' },
    });
    expect(select(undefined)).toEqual({
      servers: [{ name: 'filesystem', command: 'node', args: ['server.js'], env: [] }],
      problems: [],
    });
  });

  it('finishes every read before the agent capabilities are known', async () => {
    const openFlockDoc = vi.fn(async () => ({ flock: catalogFlock }));
    const select = await loadSessionMcpCatalog({
      repo: { openFlockDoc },
      workspaceId,
      sessionId,
      selectedIds: [selectedId],
      logger: { debug: vi.fn() },
      env: { NODE_BIN: 'node', ENTRYPOINT: 'server.js' },
    });
    expect(openFlockDoc).toHaveBeenCalledTimes(1);

    // Selecting twice with different capabilities must not touch the document
    // again: the load phase is what ACP startup overlaps with its handshake.
    expect(select({ http: true }).servers).toHaveLength(1);
    expect(select({ http: false }).servers).toHaveLength(1);
    expect(openFlockDoc).toHaveBeenCalledTimes(1);
  });

  it('turns catalog read failures into catalog_unavailable', async () => {
    const select = await loadSessionMcpCatalog({
      repo: { openFlockDoc: vi.fn(async () => Promise.reject(new Error('database unavailable'))) },
      workspaceId,
      sessionId,
      selectedIds: [selectedId],
      logger: { debug: vi.fn() },
    });
    const result = select(undefined);
    expect(result.servers).toEqual([]);
    expect(result.problems).toEqual([
      { kind: 'catalog_unavailable', reason: 'database unavailable' },
    ]);
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

  it('reports an unconfirmed baseline as unavailable instead of missing selected ids', async () => {
    const select = await loadSessionMcpCatalog({
      repo: { openFlockDoc: async () => ({ flock: flockWithRows([]) }) },
      waitForCatalogBaseline: async () => {
        throw new Error('Catalog is still syncing');
      },
      workspaceId,
      sessionId,
      selectedIds: [selectedId],
      logger: { debug: () => {} },
    });
    expect(select(undefined)).toEqual({
      servers: [],
      problems: [{ kind: 'catalog_unavailable', reason: 'Catalog is still syncing' }],
    });
  });
});
