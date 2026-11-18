import { describe, expect, it, vi } from 'vitest';
import { createLegacyWorkspaceCatalogQuery } from '@lody/shared';

import type {
  McpServerId,
  SessionId,
  WorkspaceFlockReadableFlock,
  WorkspaceId,
} from '@lody/shared';
import { loadSessionMcpCatalog } from './session-mcp-resolver';
import { WorkspaceSyncUnavailableError } from '@/lib/command-runtime';

const workspaceId = 'workspace-1' as WorkspaceId;
const sessionId = 'session-1' as SessionId;
const selectedId = 'server-1' as McpServerId;
const catalogBinding = { workspaceId, accountId: 'owner' };
const catalogFrom = (open: () => Promise<{ flock: WorkspaceFlockReadableFlock }>) =>
  createLegacyWorkspaceCatalogQuery({ binding: catalogBinding, open });

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
      catalog: { read: unexpectedRead },
      catalogBinding,
      waitForCatalogBaseline: unexpectedRead,
      workspaceId,
      sessionId,
      selectedIds: [],
      logger: { debug: vi.fn() },
    });
    expect(select(undefined)).toEqual({ servers: [], problems: [] });
  });

  it('waits for the shared baseline and then loads the selected server', async () => {
    const baseline = Promise.withResolvers<void>();
    let ready = false;
    const loading = loadSessionMcpCatalog({
      catalog: catalogFrom(async () => {
        if (!ready) throw new Error('Read before the baseline');
        return { flock: catalogFlock };
      }),
      catalogBinding,
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
      catalog: catalogFrom(async () => ({ flock: flockWithRows([]) })),
      catalogBinding,
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
