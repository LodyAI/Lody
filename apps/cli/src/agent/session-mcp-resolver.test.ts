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
  it('does not open or sync a document for an empty selection', async () => {
    const openFlockDoc = vi.fn();
    const syncFlockDoc = vi.fn();
    const select = await loadSessionMcpCatalog({
      repo: { openFlockDoc },
      syncFlockDoc,
      workspaceId,
      sessionId,
      selectedIds: [],
      logger: { debug: vi.fn() },
    });
    expect(select(undefined)).toEqual({ servers: [], problems: [] });
    expect(openFlockDoc).not.toHaveBeenCalled();
    expect(syncFlockDoc).not.toHaveBeenCalled();
  });

  it('does not delay an empty selection on production orphan cleanup', async () => {
    const openFlockDoc = vi.fn();
    const syncFlockDoc = vi.fn();
    let releaseBindingCheck!: (hasBindings: boolean) => void;
    const authService = {
      hasStoredBindings: vi.fn(
        async () =>
          await new Promise<boolean>((resolve) => {
            releaseBindingCheck = resolve;
          })
      ),
      removeOrphanedBindings: vi.fn(async () => undefined),
      resolveConnection: vi.fn(async () => null),
    };
    const select = await loadSessionMcpCatalog({
      repo: { openFlockDoc },
      syncFlockDoc,
      workspaceId,
      sessionId,
      authService,
      selectedIds: [],
      logger: { debug: vi.fn() },
    });

    expect(select(undefined)).toEqual({ servers: [], problems: [] });
    expect(openFlockDoc).not.toHaveBeenCalled();
    expect(syncFlockDoc).not.toHaveBeenCalled();
    releaseBindingCheck(false);
    await vi.waitFor(() => expect(authService.hasStoredBindings).toHaveBeenCalledTimes(1));
    expect(openFlockDoc).not.toHaveBeenCalled();
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
    expect((await select({ http: true })).servers).toHaveLength(1);
    expect((await select({ http: false })).servers).toHaveLength(1);
    expect(openFlockDoc).toHaveBeenCalledTimes(1);
  });

  it('resolves built-in credentials and removes orphaned bindings during load', async () => {
    const builtinId = 'linear-entry' as McpServerId;
    const builtinFlock = flockWithRows([
      {
        key: ['mcpServer', builtinId],
        value: {
          id: builtinId,
          name: 'Linear',
          transport: 'http',
          source: {
            kind: 'builtin',
            providerId: 'linear',
            presetVersion: 1,
            accessProfile: 'readonly',
          },
          createdAt: 1,
          updatedAt: 1,
        },
      },
    ]);
    const authService = {
      hasStoredBindings: vi.fn(async () => true),
      removeOrphanedBindings: vi.fn(async () => undefined),
      resolveConnection: vi.fn(async () => ({
        transport: 'http' as const,
        url: 'https://mcp.linear.app/mcp/readonly',
        headers: { Authorization: 'Bearer session-token' },
      })),
    };
    const select = await loadSessionMcpCatalog({
      repo: { openFlockDoc: vi.fn(async () => ({ flock: builtinFlock })) },
      workspaceId,
      sessionId,
      selectedIds: [builtinId],
      logger: { debug: vi.fn() },
      authService,
    });

    expect(authService.removeOrphanedBindings).toHaveBeenCalledWith(new Set([builtinId]));
    expect(authService.resolveConnection).toHaveBeenCalledTimes(1);
    expect(select({ http: true })).toEqual({
      servers: [
        {
          type: 'http',
          name: 'Linear',
          url: 'https://mcp.linear.app/mcp/readonly',
          headers: [{ name: 'Authorization', value: 'Bearer session-token' }],
        },
      ],
      problems: [],
    });
  });

  it('turns catalog read failures into catalog_unavailable', async () => {
    const select = await loadSessionMcpCatalog({
      repo: { openFlockDoc: vi.fn(async () => Promise.reject(new Error('database unavailable'))) },
      workspaceId,
      sessionId,
      selectedIds: [selectedId],
      logger: { debug: vi.fn() },
    });
    const result = await select(undefined);
    expect(result.servers).toEqual([]);
    expect(result.problems).toEqual([
      { kind: 'catalog_unavailable', reason: 'database unavailable' },
    ]);
  });

  it('refreshes first and falls back to local rows if refresh fails', async () => {
    const order: string[] = [];
    const syncFlockDoc = vi.fn(async () => {
      order.push('sync');
      throw new Error('offline');
    });
    const openFlockDoc = vi.fn(async () => {
      order.push('open');
      return { flock: catalogFlock };
    });
    const select = await loadSessionMcpCatalog({
      repo: { openFlockDoc },
      syncFlockDoc,
      workspaceId,
      sessionId,
      selectedIds: [selectedId],
      logger: { debug: vi.fn() },
      env: { NODE_BIN: 'node', ENTRYPOINT: 'server.js' },
    });
    expect(order).toEqual(['sync', 'open']);
    expect(syncFlockDoc).toHaveBeenCalledWith('workspace-1:wf:workspace', { timeoutMs: 5_000 });
    expect((await select(undefined)).servers).toHaveLength(1);
  });
});
