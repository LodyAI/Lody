import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import type { MachineId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import type { LocalWorkspaceCatalogService } from '@/lib/local-workspace-catalog';
import { RemoteBridge, type RemoteBridgeRuntime } from './remote-bridge';

const createLogger = (): Logger =>
  ({
    debug: vi.fn(),
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger;

const createCatalog = (events: string[]): LocalWorkspaceCatalogService =>
  ({
    read: () =>
      Effect.succeed({ version: 1, identity: null, machine: null, workspaces: [], sessions: [] }),
    listActiveWorkspaces: () => Effect.succeed([]),
    cacheRemoteWorkspaces: () =>
      Effect.sync(() => {
        events.push('catalog');
      }),
    recordWorkspaceAccessSnapshot: () => Effect.void,
    upsertSession: () => Effect.void,
  }) as LocalWorkspaceCatalogService;

const createRuntime = (events: string[], id: string): RemoteBridgeRuntime => ({
  attachRemoteBridge: async () => {
    events.push(`${id}:attach`);
  },
  detachRemoteBridge: async () => {
    events.push(`${id}:detach`);
  },
  handleRemoteAccessRevoked: async () => {
    events.push(`${id}:revoked`);
  },
});

const createBridge = (events: string[], runtimes: Map<string, RemoteBridgeRuntime>) =>
  new RemoteBridge({
    logger: createLogger(),
    catalog: createCatalog(events),
    userId: 'user-1',
    machineId: 'machine-1' as MachineId,
    machineName: 'host',
    getRuntime: (workspaceId) => runtimes.get(workspaceId),
  });

describe('RemoteBridge', () => {
  it('reconciles catalog before isolating revoked runtimes and attaching allowed runtimes', async () => {
    const events: string[] = [];
    const runtimes = new Map<string, RemoteBridgeRuntime>([
      ['workspace-1', createRuntime(events, 'workspace-1')],
      ['workspace-2', createRuntime(events, 'workspace-2')],
    ]);
    const bridge = createBridge(events, runtimes);

    const result = await bridge.reconcileOnline({
      workspaces: [{ id: 'workspace-2', name: 'Beta', slug: null, role: 'owner' }],
      runningWorkspaceIds: runtimes.keys(),
    });
    await bridge.attachAllowedRuntimes(result.allowedWorkspaceIds);

    expect(result.revokedRunningWorkspaceIds).toEqual(new Set(['workspace-1']));
    expect(events).toEqual(['catalog', 'workspace-1:revoked', 'workspace-2:attach']);
  });

  it('detaches all remote runtimes when the bridge goes offline', async () => {
    const events: string[] = [];
    const runtimes = new Map<string, RemoteBridgeRuntime>();
    const bridge = createBridge(events, runtimes);
    const runtime = createRuntime(events, 'workspace-1');

    await bridge.reconcileOnline({
      workspaces: [{ id: 'workspace-1', name: 'Alpha', slug: 'alpha', role: 'owner' }],
      runningWorkspaceIds: [],
    });
    await bridge.markOffline([runtime]);

    expect(events).toEqual(['catalog', 'workspace-1:detach']);
  });

  describe('attach retry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries a failed attach with backoff until it succeeds', async () => {
      const events: string[] = [];
      let attachAttempts = 0;
      const runtime: RemoteBridgeRuntime = {
        attachRemoteBridge: async () => {
          attachAttempts += 1;
          if (attachAttempts < 3) {
            throw new Error('meta sync timeout');
          }
          events.push('attached');
        },
        detachRemoteBridge: async () => {},
        handleRemoteAccessRevoked: async () => {},
      };
      const runtimes = new Map<string, RemoteBridgeRuntime>([['workspace-1', runtime]]);
      const bridge = createBridge(events, runtimes);

      await bridge.reconcileOnline({
        workspaces: [{ id: 'workspace-1', name: 'Alpha', slug: null, role: 'owner' }],
        runningWorkspaceIds: [],
      });
      await bridge.attachRuntimeIfAllowed('workspace-1');
      expect(attachAttempts).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(attachAttempts).toBe(2);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(attachAttempts).toBe(3);
      expect(events).toContain('attached');

      // Success clears the retry state — no further attempts fire.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(attachAttempts).toBe(3);

      bridge.shutdown();
    });

    it('stops retrying when the bridge goes offline', async () => {
      const events: string[] = [];
      const runtime: RemoteBridgeRuntime = {
        attachRemoteBridge: async () => {
          throw new Error('always fails');
        },
        detachRemoteBridge: async () => {
          events.push('detach');
        },
        handleRemoteAccessRevoked: async () => {},
      };
      const runtimes = new Map<string, RemoteBridgeRuntime>([['workspace-1', runtime]]);
      const bridge = createBridge(events, runtimes);

      await bridge.reconcileOnline({
        workspaces: [{ id: 'workspace-1', name: 'Alpha', slug: null, role: 'owner' }],
        runningWorkspaceIds: [],
      });
      const attachSpy = vi.spyOn(runtime, 'attachRemoteBridge');
      await bridge.attachRuntimeIfAllowed('workspace-1');
      expect(attachSpy).toHaveBeenCalledTimes(1);

      await bridge.markOffline([runtime]);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      // Offline cleared both the allowed set and the pending retry timer.
      expect(attachSpy).toHaveBeenCalledTimes(1);
    });
  });
});
