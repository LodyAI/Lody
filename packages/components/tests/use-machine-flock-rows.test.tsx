// @vitest-environment jsdom

import { createElement, Fragment, useEffect } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  getMachineRoomId,
  machineFlockKeys,
  serializeMachineFlockKey,
  type AgentConfigId,
  type AgentConfigMeta,
  type LocalProjectId,
  type MachineId,
  type MachineFlockEvent,
  type MachineFlockRowFamily,
  type MachineFlockRowMap,
  type MachineMeta,
  type MachineViewMeta,
  type WorkspaceId,
} from '@lody/shared';

import { machineMetaCacheAtom } from '../src/atoms/doc-meta';
import { setMachineFlockRowsForMachineAtom } from '../src/atoms/machine-flock';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms/workspace-context';
import {
  resyncMachineFlockRows,
  useMachineFlockRows,
  useMachineFlockRowsByMachineIdsState,
} from '../src/hooks/use-machine-flock-rows';
import { useResolvedMachineMeta } from '../src/hooks/use-resolved-machine-meta';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  unmountCurrentRoot();
});

function flushMicrotasks(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function liveRoom(firstSyncedWithRemote = Promise.resolve(), onJoin?: () => void) {
  const unsubscribe = vi.fn();
  const binding = {
    transportId: 'cloud',
    status: 'joined' as const,
    onStatusChange: vi.fn(() => vi.fn()),
    firstSyncedWithRemote,
    waitUntilSynced: async () => undefined,
    rejoin: async () => undefined,
  };
  return {
    unsubscribe,
    joinRoom: vi.fn(async () => {
      onJoin?.();
      return {
        unsubscribe,
        firstSyncedWithRemote,
        waitUntilSynced: async () => undefined,
        transportIds: () => ['cloud'],
        subscription: () => binding,
        subscriptions: () => [binding],
      };
    }),
  };
}

function unmountCurrentRoot(): void {
  if (root && container) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
}

function RowsProbe({
  machineId,
  onRows,
  syncRemote,
  remoteMachineIds,
  families,
}: {
  machineId: string;
  onRows: (rows: MachineFlockRowMap) => void;
  syncRemote?: boolean;
  remoteMachineIds?: readonly (MachineId | string)[];
  families?: readonly MachineFlockRowFamily[];
}) {
  const rows = useMachineFlockRows(machineId, { families, remoteMachineIds, syncRemote });
  useEffect(() => {
    onRows(rows);
  }, [onRows, rows]);
  return null;
}

function RowsStateProbe({
  machineId,
  onRemoteSynced,
  remoteMachineIds,
}: {
  machineId: string;
  onRemoteSynced: (remoteSynced: boolean) => void;
  remoteMachineIds?: readonly (MachineId | string)[];
}) {
  const state = useMachineFlockRowsByMachineIdsState([machineId], {
    families: ['localProject'],
    remoteMachineIds,
  });
  const remoteSynced = state.remoteSyncedMachineIds.has(machineId as MachineId);
  useEffect(() => {
    onRemoteSynced(remoteSynced);
  }, [onRemoteSynced, remoteSynced]);
  return null;
}

function RowsMultiStateProbe({
  machineIds,
  onRemoteSynced,
  remoteMachineIds,
}: {
  machineIds: readonly MachineId[];
  onRemoteSynced: (remoteSynced: ReadonlySet<MachineId>) => void;
  remoteMachineIds: readonly MachineId[];
}) {
  const state = useMachineFlockRowsByMachineIdsState(machineIds, {
    families: ['localProject'],
    remoteMachineIds,
  });
  useEffect(() => {
    onRemoteSynced(state.remoteSyncedMachineIds);
  }, [onRemoteSynced, state.remoteSyncedMachineIds]);
  return null;
}

function ResolvedMachineProbe({
  machineId,
  onMachine,
}: {
  machineId: MachineId;
  onMachine: (machine: MachineViewMeta | null) => void;
}) {
  const { machine } = useResolvedMachineMeta(machineId);
  useEffect(() => {
    onMachine(machine);
  }, [machine, onMachine]);
  return null;
}

function render(node: ReturnType<typeof createElement>): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
}

describe('useMachineFlockRows', () => {
  it('does not let a failed best-effort cloud leg deny a local-plane sync', async () => {
    // report.ok ANDs every attempted transport, so on a dual-homed doc a cloud
    // failure would deny an otherwise-good sync. Selection, not merging: ask
    // the cloud leg specifically.
    const machineId = 'machine-flock-dual-homed-test' as MachineId;
    const runtime = {
      workspaceId: 'workspace-flock-dual-homed-test' as WorkspaceId,
      repo: {
        openFlockDoc: vi.fn(async () => ({
          flock: { scan: vi.fn(() => []) },
          syncOnce: vi.fn(async () => ({
            ok: false,
            transports: [
              { transportId: 'local', ok: true, failures: [] },
              { transportId: 'cloud', ok: true, failures: [] },
            ],
          })),
        })),
      },
    } as unknown as WorkspaceRuntime;

    await expect(
      resyncMachineFlockRows(runtime, machineId, { requireRemoteSync: true })
    ).resolves.toBeUndefined();
  });

  it('does not count a zero-transport (offline) sync report as remote sync', async () => {
    // syncOnce resolving with no transports means nothing reached a remote:
    // requireRemoteSync must fail instead of claiming confirmation.
    const machineId = 'machine-flock-offline-report-test' as MachineId;
    const runtime = {
      workspaceId: 'workspace-flock-offline-report-test' as WorkspaceId,
      repo: {
        openFlockDoc: vi.fn(async () => ({
          flock: {
            scan: vi.fn(() => []),
          },
          syncOnce: vi.fn(async () => ({ ok: true, transports: [] })),
        })),
      },
    } as unknown as WorkspaceRuntime;

    await expect(
      resyncMachineFlockRows(runtime, machineId, { requireRemoteSync: true })
    ).rejects.toThrow(`Failed to sync Machine Flock rows for ${machineId}`);
  });

  it('reports an explicit error when a forced remote resync fails', async () => {
    const machineId = 'machine-flock-resync-failure-test' as MachineId;
    const runtime = {
      workspaceId: 'workspace-flock-resync-failure-test' as WorkspaceId,
      repo: {
        openFlockDoc: vi.fn(async () => ({
          flock: {
            scan: vi.fn(() => []),
          },
          syncOnce: vi.fn(async () => {
            throw new Error('remote unavailable');
          }),
        })),
      },
    } as unknown as WorkspaceRuntime;

    await expect(
      resyncMachineFlockRows(runtime, machineId, { requireRemoteSync: true })
    ).rejects.toThrow(`Failed to sync Machine Flock rows for ${machineId}`);
    // Callers that already have an acknowledged mutation keep the local refresh
    // without inheriting the remote failure.
    await expect(resyncMachineFlockRows(runtime, machineId)).resolves.toBeUndefined();
  });

  it('keeps a freshly returned ACP capability when remote resync reads the previous snapshot', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-machine-flock-refresh-overlay-test' as WorkspaceId;
    const workspaceSlug = 'workspace-machine-flock-refresh-overlay-test';
    const machineId = 'machine-machine-flock-refresh-overlay-test' as MachineId;
    const configId = 'config-machine-flock-refresh-overlay-test' as AgentConfigId;
    const capability = {
      cliType: 'registry' as const,
      agentType: 'deepseek',
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
      provenance: 'runtime' as const,
      sourceVersion: 'registry:deepseek:test',
      modes: [],
      models: [{ modelId: 'kimi-k3', name: 'Kimi K3' }],
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select' as const,
          currentValue: 'kimi-k3',
          options: [{ value: 'kimi-k3', name: 'Kimi K3' }],
        },
        {
          id: 'reasoning_effort',
          name: 'Thinking',
          category: 'thought_level',
          type: 'select' as const,
          currentValue: 'max',
          options: ['low', 'high', 'max'].map((value) => ({ value, name: value })),
        },
      ],
      modelReasoningEfforts: { 'kimi-k3': ['low', 'high', 'max'] },
      sessionFork: false,
      fetchedAt: 1,
    };
    const handle = {
      flock: {
        // The just-written daemon row has not reached this replica yet.
        scan: vi.fn(() => []),
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce: vi.fn(async () => ({
        ok: true,
        transports: [{ transportId: 'cloud', ok: true, failures: [] }],
      })),
      joinRoom: vi.fn(),
    };
    const runtime = {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc: vi.fn(async () => handle) },
    } as unknown as WorkspaceRuntime;
    store.set(runtimeAtom, runtime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const updates: MachineFlockRowMap[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(RowsProbe, {
          machineId,
          remoteMachineIds: [],
          families: ['acpCapability'],
          onRows: (rows) => updates.push(rows),
        })
      )
    );
    await flushMicrotasks();

    await resyncMachineFlockRows(runtime, machineId, {
      requireRemoteSync: true,
      refreshedCapability: { configId, value: capability },
    });
    await flushMicrotasks();

    const capabilityRowId = serializeMachineFlockKey(machineFlockKeys.acpCapability(configId));
    expect(updates.at(-1)?.[capabilityRowId]?.value).toEqual(capability);
  });

  it('resolves ACP capabilities from Machine Flock over legacy machine meta', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-resolved-machine-test' as WorkspaceId;
    const workspaceSlug = 'workspace-resolved-machine-test';
    const machineId = 'machine-resolved-machine-test' as MachineId;
    const configId = 'config-resolved-machine-test' as AgentConfigId;
    const capabilityRow = {
      key: machineFlockKeys.acpCapability(configId),
      value: {
        cliType: 'builtin',
        agentType: 'codex',
        cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
        provenance: 'runtime',
        sourceVersion: 'builtin-codex-acp:1.3.0+codex:test',
        modes: [],
        models: [],
        sessionFork: true,
        fetchedAt: 2,
      },
    } as const;
    const scan = vi.fn(({ prefix }: { prefix?: readonly unknown[] } = {}) =>
      !prefix || prefix.every((part, index) => capabilityRow.key[index] === part)
        ? [capabilityRow]
        : []
    );
    const openFlockDoc = vi.fn(async () => ({
      flock: {
        scan,
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce: vi.fn(async () => ({
        ok: true,
        transports: [{ transportId: 'cloud', ok: true, failures: [] }],
      })),
      joinRoom: vi.fn(async () => {
        const binding = {
          transportId: 'cloud',
          status: 'joined' as const,
          onStatusChange: vi.fn(() => vi.fn()),
          firstSyncedWithRemote: Promise.resolve(),
          waitUntilSynced: async () => undefined,
          rejoin: async () => undefined,
        };
        return {
          unsubscribe: vi.fn(),
          firstSyncedWithRemote: Promise.resolve(),
          transportIds: () => ['cloud'],
          subscription: () => binding,
          subscriptions: () => [binding],
        };
      }),
    }));

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc },
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);
    store.set(machineMetaCacheAtom, {
      [getMachineRoomId(machineId)]: {
        id: machineId,
        name: 'Machine',
        cliVersion: '',
        os: '',
        sessions: [],
        acpCapabilities: {
          [configId]: {
            cliType: 'builtin',
            agentType: 'codex',
            cacheVersion: 3,
            modes: [],
            models: [],
            fetchedAt: 1,
          },
        },
      },
    } as unknown as Record<string, MachineMeta>);

    const updates: Array<MachineViewMeta | null> = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(ResolvedMachineProbe, {
          machineId,
          onMachine: (machine) => updates.push(machine),
        })
      )
    );

    await flushMicrotasks();

    expect(updates.at(-1)?.acpCapabilities?.[configId]).toEqual(capabilityRow.value);
  });

  it('keeps a live machine flock room while consumers are mounted', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-machine-flock-rows-test' as WorkspaceId;
    const workspaceSlug = 'workspace-machine-flock-rows-test';
    const machineId = 'machine-machine-flock-rows-test';
    const dotlodyPath = '/Users/test/.lody';
    const dotlodyPathRowId = serializeMachineFlockKey(machineFlockKeys.dotlodyPath());
    let remoteVisible = false;
    const scan = vi.fn(() =>
      remoteVisible ? [{ key: machineFlockKeys.dotlodyPath(), value: dotlodyPath }] : []
    );
    const unsubscribeFlock = vi.fn();
    let emitFlockBatch: ((batch: { events: MachineFlockEvent[] }) => void) | null = null;
    const fakeFlock = {
      scan,
      subscribe: vi.fn((listener: (batch: { events: MachineFlockEvent[] }) => void) => {
        emitFlockBatch = listener;
        return unsubscribeFlock;
      }),
    };
    const syncOnce = vi.fn(async () => {
      remoteVisible = true;
      return { ok: true, transports: [{ transportId: 'cloud', ok: true, failures: [] }] };
    });
    const { joinRoom, unsubscribe: unsubscribeRoom } = liveRoom(Promise.resolve(), () => {
      remoteVisible = true;
    });
    const openFlockDoc = vi.fn(async () => ({
      flock: fakeFlock,
      syncOnce,
      joinRoom,
    }));

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc },
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const firstUpdates: MachineFlockRowMap[] = [];
    const secondUpdates: MachineFlockRowMap[] = [];

    render(
      createElement(
        Provider,
        { store },
        createElement(
          Fragment,
          null,
          createElement(RowsProbe, {
            key: 'first',
            machineId,
            onRows: (rows) => firstUpdates.push(rows),
          }),
          createElement(RowsProbe, {
            key: 'second',
            machineId,
            onRows: (rows) => secondUpdates.push(rows),
          })
        )
      )
    );

    await flushMicrotasks();

    expect(openFlockDoc).toHaveBeenCalledTimes(1);
    expect(openFlockDoc).toHaveBeenCalledWith(`${workspaceId}:mf:${machineId}`);
    expect(syncOnce).not.toHaveBeenCalled();
    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(fakeFlock.subscribe).toHaveBeenCalledTimes(1);
    expect(firstUpdates.at(-1)?.[dotlodyPathRowId]?.value).toBe(dotlodyPath);
    expect(secondUpdates.at(-1)?.[dotlodyPathRowId]?.value).toBe(dotlodyPath);

    act(() => {
      emitFlockBatch?.({
        events: [{ key: machineFlockKeys.dotlodyPath(), value: '/Users/test/.lody-next' }],
      });
    });
    expect(firstUpdates.at(-1)?.[dotlodyPathRowId]?.value).toBe('/Users/test/.lody-next');
    expect(secondUpdates.at(-1)?.[dotlodyPathRowId]?.value).toBe('/Users/test/.lody-next');

    act(() => {
      root?.render(
        createElement(
          Provider,
          { store },
          createElement(
            Fragment,
            null,
            createElement(RowsProbe, {
              key: 'second',
              machineId,
              onRows: (rows) => secondUpdates.push(rows),
            })
          )
        )
      );
    });
    await flushMicrotasks();

    expect(unsubscribeRoom).not.toHaveBeenCalled();
    expect(unsubscribeFlock).not.toHaveBeenCalled();
    unmountCurrentRoot();
    expect(unsubscribeRoom).toHaveBeenCalledTimes(1);
    expect(unsubscribeFlock).toHaveBeenCalledTimes(1);
  });

  it('reads cached rows without joining rooms for machines outside the remote allowlist', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-machine-flock-offline-test' as WorkspaceId;
    const workspaceSlug = 'workspace-machine-flock-offline-test';
    const machineId = 'machine-machine-flock-offline-test';
    const dotlodyPath = '/Users/offline/.lody';
    const dotlodyPathRowId = serializeMachineFlockKey(machineFlockKeys.dotlodyPath());
    const joinRoom = vi.fn();
    const openFlockDoc = vi.fn(async () => ({
      flock: {
        scan: vi.fn(() => [{ key: machineFlockKeys.dotlodyPath(), value: dotlodyPath }]),
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce: vi.fn(),
      joinRoom,
    }));

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc },
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const updates: MachineFlockRowMap[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(RowsProbe, {
          machineId,
          remoteMachineIds: [],
          onRows: (rows) => updates.push(rows),
        })
      )
    );

    await flushMicrotasks();

    expect(joinRoom).not.toHaveBeenCalled();
    expect(updates.at(-1)?.[dotlodyPathRowId]?.value).toBe(dotlodyPath);
  });

  it('can read local rows without remote catchup', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-machine-flock-local-only-test' as WorkspaceId;
    const workspaceSlug = 'workspace-machine-flock-local-only-test';
    const machineId = 'machine-machine-flock-local-only-test';
    const dotlodyPath = '/Users/local-only/.lody';
    const dotlodyPathRowId = serializeMachineFlockKey(machineFlockKeys.dotlodyPath());
    const scan = vi.fn(() => [{ key: machineFlockKeys.dotlodyPath(), value: dotlodyPath }]);
    const fakeFlock = {
      scan,
      subscribe: vi.fn(() => vi.fn()),
    };
    const syncOnce = vi.fn(async () => undefined);
    const joinRoomBinding = {
      transportId: 'cloud',
      status: 'joined' as const,
      onStatusChange: vi.fn(() => vi.fn()),
      firstSyncedWithRemote: Promise.resolve(),
      waitUntilSynced: async () => undefined,
      rejoin: async () => undefined,
    };
    const joinRoom = vi.fn(async () => ({
      unsubscribe: vi.fn(),
      firstSyncedWithRemote: Promise.resolve(),
      waitUntilSynced: async () => undefined,
      transportIds: () => ['cloud'],
      subscription: () => joinRoomBinding,
      subscriptions: () => [joinRoomBinding],
    }));
    const openFlockDoc = vi.fn(async () => ({
      flock: fakeFlock,
      syncOnce,
      joinRoom,
    }));

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc },
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const updates: MachineFlockRowMap[] = [];

    render(
      createElement(
        Provider,
        { store },
        createElement(RowsProbe, {
          machineId,
          syncRemote: false,
          onRows: (rows) => updates.push(rows),
        })
      )
    );

    await flushMicrotasks();

    expect(openFlockDoc).toHaveBeenCalledWith(`${workspaceId}:mf:${machineId}`);
    expect(syncOnce).not.toHaveBeenCalled();
    expect(joinRoom).not.toHaveBeenCalled();
    expect(updates.at(-1)?.[dotlodyPathRowId]?.value).toBe(dotlodyPath);
  });

  it('marks a machine ready only after its remote catchup succeeds', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-machine-flock-readiness-test' as WorkspaceId;
    const workspaceSlug = 'workspace-machine-flock-readiness-test';
    const machineId = 'machine-machine-flock-readiness-test';
    const syncDeferred = deferred();
    const syncOnce = vi.fn(async () => undefined);
    const { joinRoom } = liveRoom(syncDeferred.promise);
    const openFlockDoc = vi.fn(async () => ({
      flock: {
        scan: vi.fn(() => []),
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce,
      joinRoom,
    }));

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc },
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const readinessUpdates: boolean[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(RowsStateProbe, {
          machineId,
          onRemoteSynced: (remoteSynced) => readinessUpdates.push(remoteSynced),
        })
      )
    );

    await flushMicrotasks();

    expect(syncOnce).not.toHaveBeenCalled();
    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(readinessUpdates.at(-1)).toBe(false);

    syncDeferred.resolve();
    await flushMicrotasks();

    expect(readinessUpdates.at(-1)).toBe(true);
  });

  it('does not let resync mark a task ready after its initial setup failed', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-machine-flock-failed-task-test' as WorkspaceId;
    const workspaceSlug = 'workspace-machine-flock-failed-task-test';
    const machineId = 'machine-machine-flock-failed-task-test' as MachineId;
    const { joinRoom } = liveRoom(Promise.resolve());
    const handle = {
      flock: {
        scan: vi.fn(() => []),
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce: vi.fn(async () => ({
        ok: true,
        transports: [{ transportId: 'cloud', ok: true, failures: [] }],
      })),
      joinRoom,
    };
    const openFlockDoc = vi
      .fn()
      .mockRejectedValueOnce(new Error('initial open failed'))
      .mockResolvedValue(handle);
    const runtime = {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc },
    } as unknown as WorkspaceRuntime;

    store.set(runtimeAtom, runtime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const readinessUpdates: boolean[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(RowsStateProbe, {
          machineId,
          onRemoteSynced: (remoteSynced) => readinessUpdates.push(remoteSynced),
        })
      )
    );
    await flushMicrotasks();
    expect(readinessUpdates.at(-1)).toBe(false);

    await resyncMachineFlockRows(runtime, machineId, { requireRemoteSync: true });
    await flushMicrotasks();

    expect(handle.syncOnce).toHaveBeenCalledTimes(1);
    expect(readinessUpdates.at(-1)).toBe(false);
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it('requires a new catchup when an online scope returns after going offline', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-machine-flock-scope-generation-test' as WorkspaceId;
    const workspaceSlug = 'workspace-machine-flock-scope-generation-test';
    const machineId = 'machine-machine-flock-scope-generation-test' as MachineId;
    const firstSync = deferred();
    const secondSync = deferred();
    const firstRoom = liveRoom(firstSync.promise);
    const secondRoom = liveRoom(secondSync.promise);
    const joinRoom = vi
      .fn()
      .mockImplementationOnce(() => firstRoom.joinRoom())
      .mockImplementationOnce(() => secondRoom.joinRoom());
    const openFlockDoc = vi.fn(async () => ({
      flock: {
        scan: vi.fn(() => []),
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce: vi.fn(async () => undefined),
      joinRoom,
    }));

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc },
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const readinessUpdates: boolean[] = [];
    const probe = (remoteMachineIds: readonly MachineId[]) =>
      createElement(
        Provider,
        { store },
        createElement(RowsStateProbe, {
          machineId,
          remoteMachineIds,
          onRemoteSynced: (remoteSynced) => readinessUpdates.push(remoteSynced),
        })
      );

    render(probe([machineId]));
    await flushMicrotasks();
    expect(joinRoom).toHaveBeenCalledTimes(1);

    firstSync.resolve();
    await flushMicrotasks();
    expect(readinessUpdates.at(-1)).toBe(true);

    act(() => root?.render(probe([])));
    await flushMicrotasks();
    expect(readinessUpdates.at(-1)).toBe(false);

    act(() => root?.render(probe([machineId])));
    await flushMicrotasks();
    expect(joinRoom).toHaveBeenCalledTimes(2);
    expect(readinessUpdates.at(-1)).toBe(false);

    secondSync.resolve();
    await flushMicrotasks();
    expect(readinessUpdates.at(-1)).toBe(true);
  });

  it('requires a fresh catchup after re-entry while another consumer holds the room', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-machine-flock-shared-scope-test' as WorkspaceId;
    const workspaceSlug = 'workspace-machine-flock-shared-scope-test';
    const machineId = 'machine-machine-flock-shared-scope-test' as MachineId;
    const refreshSync = deferred();
    const { joinRoom } = liveRoom(Promise.resolve());
    const syncOnce = vi.fn(async () => {
      await refreshSync.promise;
      return { ok: true, transports: [{ transportId: 'cloud', ok: true, failures: [] }] };
    });
    const openFlockDoc = vi.fn(async () => ({
      flock: {
        scan: vi.fn(() => []),
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce,
      joinRoom,
    }));

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc },
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const readinessUpdates: boolean[] = [];
    const probe = (remoteMachineIds: readonly MachineId[]) =>
      createElement(
        Provider,
        { store },
        createElement(
          Fragment,
          null,
          createElement(RowsProbe, {
            key: 'room-holder',
            machineId,
            onRows: () => undefined,
          }),
          createElement(RowsStateProbe, {
            key: 'presence-aware',
            machineId,
            remoteMachineIds,
            onRemoteSynced: (remoteSynced) => readinessUpdates.push(remoteSynced),
          })
        )
      );

    render(probe([machineId]));
    await flushMicrotasks();
    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(readinessUpdates.at(-1)).toBe(true);

    act(() => root?.render(probe([])));
    await flushMicrotasks();
    expect(readinessUpdates.at(-1)).toBe(false);

    act(() => root?.render(probe([machineId])));
    await flushMicrotasks();
    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(syncOnce).toHaveBeenCalledTimes(1);
    expect(readinessUpdates.at(-1)).toBe(false);

    refreshSync.resolve();
    await flushMicrotasks();
    expect(readinessUpdates.at(-1)).toBe(true);
  });

  it('requires a fresh catchup for a new presence-aware consumer of a held room', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-machine-flock-new-consumer-test' as WorkspaceId;
    const workspaceSlug = 'workspace-machine-flock-new-consumer-test';
    const machineId = 'machine-machine-flock-new-consumer-test' as MachineId;
    const refreshSync = deferred();
    const { joinRoom } = liveRoom(Promise.resolve());
    const syncOnce = vi.fn(async () => {
      await refreshSync.promise;
      return { ok: true, transports: [{ transportId: 'cloud', ok: true, failures: [] }] };
    });
    const openFlockDoc = vi.fn(async () => ({
      flock: {
        scan: vi.fn(() => []),
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce,
      joinRoom,
    }));

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc },
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const readinessUpdates: boolean[] = [];
    const holder = createElement(RowsProbe, {
      key: 'room-holder',
      machineId,
      onRows: () => undefined,
    });
    const probe = (consumerKey?: string) =>
      createElement(
        Provider,
        { store },
        createElement(
          Fragment,
          null,
          holder,
          consumerKey
            ? createElement(RowsStateProbe, {
                key: consumerKey,
                machineId,
                remoteMachineIds: [machineId],
                onRemoteSynced: (remoteSynced) => readinessUpdates.push(remoteSynced),
              })
            : null
        )
      );

    render(probe('consumer-a'));
    await flushMicrotasks();
    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(readinessUpdates.at(-1)).toBe(true);

    act(() => root?.render(probe()));
    await flushMicrotasks();

    act(() => root?.render(probe('consumer-b')));
    await flushMicrotasks();
    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(syncOnce).toHaveBeenCalledTimes(1);
    expect(readinessUpdates.at(-1)).toBe(false);

    refreshSync.resolve();
    await flushMicrotasks();
    expect(readinessUpdates.at(-1)).toBe(true);
  });

  it('makes concurrent presence-aware consumers wait for the same fresh catchup', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-machine-flock-concurrent-consumer-test' as WorkspaceId;
    const workspaceSlug = 'workspace-machine-flock-concurrent-consumer-test';
    const machineId = 'machine-machine-flock-concurrent-consumer-test' as MachineId;
    const refreshSync = deferred();
    const { joinRoom } = liveRoom(Promise.resolve());
    const syncOnce = vi.fn(async () => {
      await refreshSync.promise;
      return { ok: true, transports: [{ transportId: 'cloud', ok: true, failures: [] }] };
    });
    const openFlockDoc = vi.fn(async () => ({
      flock: {
        scan: vi.fn(() => []),
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce,
      joinRoom,
    }));

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc },
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const firstUpdates: boolean[] = [];
    const secondUpdates: boolean[] = [];
    const holder = createElement(RowsProbe, {
      key: 'room-holder',
      machineId,
      onRows: () => undefined,
    });
    const probe = (consumerKeys: readonly string[]) =>
      createElement(
        Provider,
        { store },
        createElement(
          Fragment,
          null,
          holder,
          ...consumerKeys.map((key, index) =>
            createElement(RowsStateProbe, {
              key,
              machineId,
              remoteMachineIds: [machineId],
              onRemoteSynced: (remoteSynced) =>
                (index === 0 ? firstUpdates : secondUpdates).push(remoteSynced),
            })
          )
        )
      );

    render(probe(['initial-consumer']));
    await flushMicrotasks();
    expect(firstUpdates.at(-1)).toBe(true);

    act(() => root?.render(probe([])));
    await flushMicrotasks();
    firstUpdates.length = 0;

    act(() => root?.render(probe(['consumer-a'])));
    await flushMicrotasks();
    expect(syncOnce).toHaveBeenCalledTimes(1);
    expect(firstUpdates.at(-1)).toBe(false);

    act(() => root?.render(probe(['consumer-a', 'consumer-b'])));
    await flushMicrotasks();
    expect(syncOnce).toHaveBeenCalledTimes(1);
    expect(firstUpdates.at(-1)).toBe(false);
    expect(secondUpdates.at(-1)).toBe(false);

    refreshSync.resolve();
    await flushMicrotasks();
    expect(firstUpdates.at(-1)).toBe(true);
    expect(secondUpdates.at(-1)).toBe(true);
  });

  it('keeps unchanged machine subscriptions when another machine leaves the allowlist', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-machine-flock-incremental-allowlist-test' as WorkspaceId;
    const workspaceSlug = 'workspace-machine-flock-incremental-allowlist-test';
    const firstMachineId = 'machine-machine-flock-incremental-first' as MachineId;
    const secondMachineId = 'machine-machine-flock-incremental-second' as MachineId;
    const firstRoom = liveRoom(Promise.resolve());
    const secondRoom = liveRoom(Promise.resolve());
    const firstSyncOnce = vi.fn();
    const secondSyncOnce = vi.fn();
    const openFlockDoc = vi.fn(async (docId: string) => {
      const first = docId.endsWith(firstMachineId);
      return {
        flock: {
          scan: vi.fn(() => []),
          subscribe: vi.fn(() => vi.fn()),
        },
        syncOnce: first ? firstSyncOnce : secondSyncOnce,
        joinRoom: first ? firstRoom.joinRoom : secondRoom.joinRoom,
      };
    });

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc },
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const machineIds = [firstMachineId, secondMachineId];
    const probe = (remoteMachineIds: readonly MachineId[]) =>
      createElement(
        Provider,
        { store },
        createElement(RowsMultiStateProbe, {
          machineIds,
          remoteMachineIds,
          onRemoteSynced: () => undefined,
        })
      );

    render(probe(machineIds));
    await flushMicrotasks();
    expect(firstRoom.joinRoom).toHaveBeenCalledTimes(1);
    expect(secondRoom.joinRoom).toHaveBeenCalledTimes(1);

    act(() => root?.render(probe([firstMachineId])));
    await flushMicrotasks();

    expect(firstRoom.joinRoom).toHaveBeenCalledTimes(1);
    expect(firstRoom.unsubscribe).not.toHaveBeenCalled();
    expect(firstSyncOnce).not.toHaveBeenCalled();
    expect(secondRoom.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not carry remote readiness across a Jotai store switch', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const firstStore = createStore();
    const secondStore = createStore();
    const workspaceId = 'workspace-machine-flock-store-switch-test' as WorkspaceId;
    const workspaceSlug = 'workspace-machine-flock-store-switch-test';
    const machineId = 'machine-machine-flock-store-switch-test' as MachineId;
    const secondSync = deferred();
    const firstRoom = liveRoom(Promise.resolve());
    const secondRoom = liveRoom(secondSync.promise);
    const joinRoom = vi
      .fn()
      .mockImplementationOnce(() => firstRoom.joinRoom())
      .mockImplementationOnce(() => secondRoom.joinRoom());
    const runtime = {
      workspaceId,
      workspaceSlug,
      repo: {
        openFlockDoc: vi.fn(async () => ({
          flock: {
            scan: vi.fn(() => []),
            subscribe: vi.fn(() => vi.fn()),
          },
          syncOnce: vi.fn(async () => ({
            ok: true,
            transports: [{ transportId: 'cloud', ok: true, failures: [] }],
          })),
          joinRoom,
        })),
      },
    } as unknown as WorkspaceRuntime;
    for (const store of [firstStore, secondStore]) {
      store.set(runtimeAtom, runtime);
      store.set(currentWorkspaceIdAtom, workspaceId);
      store.set(currentWorkspaceSlugAtom, workspaceSlug);
    }

    const firstUpdates: boolean[] = [];
    const secondUpdates: boolean[] = [];
    const probe = (store: ReturnType<typeof createStore>, updates: boolean[]) =>
      createElement(
        Provider,
        { store },
        createElement(RowsStateProbe, {
          machineId,
          onRemoteSynced: (remoteSynced) => updates.push(remoteSynced),
        })
      );

    render(probe(firstStore, firstUpdates));
    await flushMicrotasks();
    expect(firstUpdates.at(-1)).toBe(true);

    act(() => root?.render(probe(secondStore, secondUpdates)));
    await flushMicrotasks();

    expect(secondUpdates[0]).toBe(false);
    expect(secondUpdates).not.toContain(true);
  });

  it('passes requested row families as Flock scan prefixes', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-machine-flock-family-test' as WorkspaceId;
    const workspaceSlug = 'workspace-machine-flock-family-test';
    const machineId = 'machine-machine-flock-family-test';
    const localProjectId = 'project-machine-flock-family-test' as LocalProjectId;
    const agentId = 'agent-machine-flock-family-test' as AgentConfigId;
    const localProjectRowId = serializeMachineFlockKey(
      machineFlockKeys.localProject(localProjectId)
    );
    const agentRowId = serializeMachineFlockKey(machineFlockKeys.agentConfig(agentId));
    const rows = [
      {
        key: machineFlockKeys.localProject(localProjectId),
        value: {
          id: localProjectId,
          name: 'lody',
          rootPath: '/repo/lody',
          createdAtMs: 1,
        },
      },
      {
        key: machineFlockKeys.agentConfig(agentId),
        value: {
          id: agentId,
          machineId,
          name: 'Agent',
          cliType: 'custom',
          agentType: 'custom-agent',
          env: {},
          prompt: '',
        },
      },
    ];
    const scan = vi.fn(({ prefix }: { prefix?: readonly unknown[] } = {}) =>
      rows.filter((row) => !prefix || prefix.every((part, index) => row.key[index] === part))
    );
    const openFlockDoc = vi.fn(async () => ({
      flock: {
        scan,
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce: vi.fn(async () => ({
        ok: true,
        transports: [{ transportId: 'cloud', ok: true, failures: [] }],
      })),
      joinRoom: vi.fn(),
    }));

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc },
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const updates: MachineFlockRowMap[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(RowsProbe, {
          machineId,
          syncRemote: false,
          families: ['localProject'],
          onRows: (nextRows) => updates.push(nextRows),
        })
      )
    );

    await flushMicrotasks();

    expect(scan).toHaveBeenCalledWith({ prefix: ['localProject'] });
    expect(updates.at(-1)?.[localProjectRowId]).toBeDefined();
    expect(updates.at(-1)?.[agentRowId]).toBeUndefined();
  });

  it('syncs again when a fresh runtime opens the same machine flock doc', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const workspaceId = 'workspace-machine-flock-fresh-runtime-test' as WorkspaceId;
    const workspaceSlug = 'workspace-machine-flock-fresh-runtime-test';
    const machineId = 'machine-machine-flock-fresh-runtime-test';
    const dotlodyPathRowId = serializeMachineFlockKey(machineFlockKeys.dotlodyPath());

    const firstStore = createStore();
    let firstRemoteVisible = false;
    const firstSyncOnce = vi.fn(async () => {
      firstRemoteVisible = true;
    });
    const { joinRoom: firstJoinRoom } = liveRoom(Promise.resolve(), () => {
      firstRemoteVisible = true;
    });
    const firstOpenFlockDoc = vi.fn(async () => ({
      flock: {
        scan: vi.fn(() =>
          firstRemoteVisible
            ? [{ key: machineFlockKeys.dotlodyPath(), value: '/Users/first/.lody' }]
            : []
        ),
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce: firstSyncOnce,
      joinRoom: firstJoinRoom,
    }));

    firstStore.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc: firstOpenFlockDoc },
    } as unknown as WorkspaceRuntime);
    firstStore.set(currentWorkspaceIdAtom, workspaceId);
    firstStore.set(currentWorkspaceSlugAtom, workspaceSlug);

    const firstUpdates: MachineFlockRowMap[] = [];
    render(
      createElement(
        Provider,
        { store: firstStore },
        createElement(RowsProbe, {
          machineId,
          onRows: (rows) => firstUpdates.push(rows),
        })
      )
    );

    await flushMicrotasks();

    expect(firstSyncOnce).not.toHaveBeenCalled();
    expect(firstJoinRoom).toHaveBeenCalledTimes(1);
    expect(firstUpdates.at(-1)?.[dotlodyPathRowId]?.value).toBe('/Users/first/.lody');

    unmountCurrentRoot();

    const secondStore = createStore();
    let secondRemoteVisible = false;
    const secondSyncOnce = vi.fn(async () => {
      secondRemoteVisible = true;
    });
    const { joinRoom: secondJoinRoom } = liveRoom(Promise.resolve(), () => {
      secondRemoteVisible = true;
    });
    const secondOpenFlockDoc = vi.fn(async () => ({
      flock: {
        scan: vi.fn(() =>
          secondRemoteVisible
            ? [{ key: machineFlockKeys.dotlodyPath(), value: '/Users/second/.lody' }]
            : []
        ),
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce: secondSyncOnce,
      joinRoom: secondJoinRoom,
    }));

    secondStore.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc: secondOpenFlockDoc },
    } as unknown as WorkspaceRuntime);
    secondStore.set(currentWorkspaceIdAtom, workspaceId);
    secondStore.set(currentWorkspaceSlugAtom, workspaceSlug);

    const secondUpdates: MachineFlockRowMap[] = [];
    render(
      createElement(
        Provider,
        { store: secondStore },
        createElement(RowsProbe, {
          machineId,
          onRows: (rows) => secondUpdates.push(rows),
        })
      )
    );

    await flushMicrotasks();

    expect(secondSyncOnce).not.toHaveBeenCalled();
    expect(secondJoinRoom).toHaveBeenCalledTimes(1);
    expect(secondUpdates.at(-1)?.[dotlodyPathRowId]?.value).toBe('/Users/second/.lody');
  });

  it('keeps last shared rows when reopening the machine flock doc fails', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-machine-flock-open-failure-test' as WorkspaceId;
    const workspaceSlug = 'workspace-machine-flock-open-failure-test';
    const machineId = 'machine-machine-flock-open-failure-test';
    const dotlodyPath = '/Users/open-failure/.lody';
    const dotlodyPathRowId = serializeMachineFlockKey(machineFlockKeys.dotlodyPath());
    let remoteVisible = false;
    const syncOnce = vi.fn(async () => {
      remoteVisible = true;
      return { ok: true, transports: [{ transportId: 'cloud', ok: true, failures: [] }] };
    });
    const { joinRoom } = liveRoom(Promise.resolve(), () => {
      remoteVisible = true;
    });
    const openFlockDoc = vi.fn(async () => ({
      flock: {
        scan: vi.fn(() =>
          remoteVisible ? [{ key: machineFlockKeys.dotlodyPath(), value: dotlodyPath }] : []
        ),
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce,
      joinRoom,
    }));

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc },
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const updates: MachineFlockRowMap[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(RowsProbe, {
          machineId,
          onRows: (rows) => updates.push(rows),
        })
      )
    );

    await flushMicrotasks();

    expect(updates.at(-1)?.[dotlodyPathRowId]?.value).toBe(dotlodyPath);

    const failingOpenFlockDoc = vi.fn(async () => {
      throw new Error('open failed');
    });
    act(() => {
      store.set(runtimeAtom, {
        workspaceId,
        workspaceSlug,
        repo: { openFlockDoc: failingOpenFlockDoc },
      } as unknown as WorkspaceRuntime);
    });
    await flushMicrotasks();

    expect(failingOpenFlockDoc).toHaveBeenCalledWith(`${workspaceId}:mf:${machineId}`);
    expect(updates.at(-1)?.[dotlodyPathRowId]?.value).toBe(dotlodyPath);
  });

  it('merges remote catchup rows without removing local agent configs', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-machine-flock-merge-sync-test' as WorkspaceId;
    const workspaceSlug = 'workspace-machine-flock-merge-sync-test';
    const machineId = 'machine-machine-flock-merge-sync-test' as MachineId;
    const agentId = 'agent-machine-flock-merge-sync-test' as AgentConfigId;
    const agentRowId = serializeMachineFlockKey(machineFlockKeys.agentConfig(agentId));
    const dotlodyPath = '/Users/merge-sync/.lody';
    const dotlodyPathRowId = serializeMachineFlockKey(machineFlockKeys.dotlodyPath());
    const syncDeferred = deferred();
    let remoteVisible = false;
    const localAgentConfig: AgentConfigMeta = {
      id: agentId,
      machineId,
      name: 'Local ACP Provider',
      description: undefined,
      cliType: 'custom',
      agentType: 'custom-local-acp',
      customAcp: { command: 'node', args: ['server.js'] },
      env: {},
      prompt: '',
    };
    const scan = vi.fn(() =>
      remoteVisible ? [{ key: machineFlockKeys.dotlodyPath(), value: dotlodyPath }] : []
    );
    const syncOnce = vi.fn(async () => undefined);
    const { joinRoom } = liveRoom(
      syncDeferred.promise.then(() => {
        remoteVisible = true;
      })
    );
    const openFlockDoc = vi.fn(async () => ({
      flock: {
        scan,
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce,
      joinRoom,
    }));

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc },
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const updates: MachineFlockRowMap[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(RowsProbe, {
          machineId,
          onRows: (rows) => updates.push(rows),
        })
      )
    );

    await flushMicrotasks();

    expect(syncOnce).not.toHaveBeenCalled();
    expect(joinRoom).toHaveBeenCalledTimes(1);

    act(() => {
      store.set(setMachineFlockRowsForMachineAtom, {
        workspaceId,
        machineId,
        rows: {
          [agentRowId]: {
            key: machineFlockKeys.agentConfig(agentId),
            value: localAgentConfig,
          },
        },
        mode: 'merge',
      });
    });

    expect(updates.at(-1)?.[agentRowId]?.value).toEqual(localAgentConfig);

    await act(async () => {
      syncDeferred.resolve();
      await syncDeferred.promise;
    });
    await flushMicrotasks();

    expect(updates.at(-1)?.[agentRowId]?.value).toEqual(localAgentConfig);
    expect(updates.at(-1)?.[dotlodyPathRowId]?.value).toBe(dotlodyPath);
  });

  it('does not republish an explicit resync at the already materialized version', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-machine-flock-resync-version-test' as WorkspaceId;
    const machineId = 'machine-machine-flock-resync-version-test' as MachineId;
    const dotlodyPath = '/Users/resync-version/.lody';
    const scan = vi.fn(() => [{ key: machineFlockKeys.dotlodyPath(), value: dotlodyPath }]);
    const handle = {
      flock: {
        scan,
        version: vi.fn(() => ({
          'test-peer': { physicalTime: 1, logicalCounter: 0 },
        })),
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce: vi.fn(async () => ({
        ok: true,
        transports: [{ transportId: 'cloud', ok: true, failures: [] }],
      })),
      joinRoom: vi.fn(),
    };
    const runtime = {
      workspaceId,
      workspaceSlug: 'workspace-machine-flock-resync-version-test',
      repo: { openFlockDoc: vi.fn(async () => handle) },
    } as unknown as WorkspaceRuntime;
    store.set(runtimeAtom, runtime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, 'workspace-machine-flock-resync-version-test');

    const updates: MachineFlockRowMap[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(RowsProbe, {
          machineId,
          remoteMachineIds: [],
          onRows: (rows) => updates.push(rows),
        })
      )
    );
    await flushMicrotasks();
    const updateCountBeforeResync = updates.length;

    await resyncMachineFlockRows(runtime, machineId, { requireRemoteSync: true });
    await flushMicrotasks();

    expect(scan).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(updateCountBeforeResync);
  });

  it('materializes different row-family projections at the same Flock version', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-machine-flock-family-version-test' as WorkspaceId;
    const machineId = 'machine-machine-flock-family-version-test';
    const scan = vi.fn(() => []);
    const openFlockDoc = vi.fn(async () => ({
      flock: {
        scan,
        version: vi.fn(() => ({
          'test-peer': { physicalTime: 1, logicalCounter: 0 },
        })),
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce: vi.fn(),
      joinRoom: vi.fn(),
    }));

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug: 'workspace-machine-flock-family-version-test',
      repo: { openFlockDoc },
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, 'workspace-machine-flock-family-version-test');

    render(
      createElement(
        Provider,
        { store },
        createElement(
          Fragment,
          null,
          createElement(RowsProbe, {
            machineId,
            families: ['dotlodyPath'],
            remoteMachineIds: [],
            onRows: vi.fn(),
          }),
          createElement(RowsProbe, {
            machineId,
            families: ['localProject'],
            remoteMachineIds: [],
            onRows: vi.fn(),
          })
        )
      )
    );
    await flushMicrotasks();

    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan).toHaveBeenCalledWith({ prefix: ['dotlodyPath'] });
    expect(scan).toHaveBeenCalledWith({ prefix: ['localProject'] });
  });

  it('reuses the published rows instead of re-scanning the flock for every new consumer', async () => {
    // The local read is an O(whole-flock) scan. While a shared subscription is
    // alive it keeps the atom current incrementally, so extra consumers — and
    // remounts, which is what a session switch does to the chat surface — must
    // not repeat it. Once the last consumer goes away the subscription drops,
    // but a fresh mount can still compare the persisted projection version
    // before deciding whether another scan is necessary.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const store = createStore();
    const workspaceId = 'workspace-machine-flock-read-dedupe-test' as WorkspaceId;
    const workspaceSlug = 'workspace-machine-flock-read-dedupe-test';
    const machineId = 'machine-machine-flock-read-dedupe-test';
    const dotlodyPath = '/Users/dedupe/.lody';
    const dotlodyPathRowId = serializeMachineFlockKey(machineFlockKeys.dotlodyPath());
    const scan = vi.fn(() => [{ key: machineFlockKeys.dotlodyPath(), value: dotlodyPath }]);
    const unsubscribeFlock = vi.fn();
    let versionClock = 1;
    let emitFlockBatch: ((batch: { events: MachineFlockEvent[] }) => void) | null = null;
    const openFlockDoc = vi.fn(async () => ({
      flock: {
        scan,
        version: vi.fn(() => ({
          'test-peer': { physicalTime: versionClock, logicalCounter: 0 },
        })),
        subscribe: vi.fn((listener: (batch: { events: MachineFlockEvent[] }) => void) => {
          emitFlockBatch = listener;
          return unsubscribeFlock;
        }),
      },
      syncOnce: vi.fn(),
      joinRoom: vi.fn(),
    }));

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc },
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const firstUpdates: MachineFlockRowMap[] = [];
    const secondUpdates: MachineFlockRowMap[] = [];
    // An empty remote allowlist keeps this purely local, so `scan` can only be
    // reached through the local read under test.
    const probe = (key: string, sink: MachineFlockRowMap[]) =>
      createElement(RowsProbe, {
        key,
        machineId,
        remoteMachineIds: [],
        onRows: (rows: MachineFlockRowMap) => sink.push(rows),
      });

    render(
      createElement(
        Provider,
        { store },
        createElement(Fragment, null, probe('first', firstUpdates), probe('second', secondUpdates))
      )
    );
    await flushMicrotasks();

    expect(scan).toHaveBeenCalledTimes(1);
    expect(firstUpdates.at(-1)?.[dotlodyPathRowId]?.value).toBe(dotlodyPath);
    expect(secondUpdates.at(-1)?.[dotlodyPathRowId]?.value).toBe(dotlodyPath);

    // Remount the second consumer while the first keeps the subscription alive.
    act(() => {
      root?.render(
        createElement(
          Provider,
          { store },
          createElement(Fragment, null, probe('first', firstUpdates))
        )
      );
    });
    await flushMicrotasks();
    act(() => {
      root?.render(
        createElement(
          Provider,
          { store },
          createElement(Fragment, null, probe('first', firstUpdates), probe('third', secondUpdates))
        )
      );
    });
    await flushMicrotasks();

    expect(scan).toHaveBeenCalledTimes(1);
    expect(unsubscribeFlock).not.toHaveBeenCalled();
    expect(secondUpdates.at(-1)?.[dotlodyPathRowId]?.value).toBe(dotlodyPath);

    // The skipped read must not cost liveness: events still reach every consumer.
    versionClock = 2;
    act(() => {
      emitFlockBatch?.({
        events: [{ key: machineFlockKeys.dotlodyPath(), value: '/Users/dedupe/.lody-next' }],
      });
    });
    expect(firstUpdates.at(-1)?.[dotlodyPathRowId]?.value).toBe('/Users/dedupe/.lody-next');
    expect(secondUpdates.at(-1)?.[dotlodyPathRowId]?.value).toBe('/Users/dedupe/.lody-next');

    // Last consumer gone -> subscription released. The unchanged Flock version
    // still proves that the materialized rows are current on the next mount.
    act(() => {
      root?.render(createElement(Provider, { store }, createElement(Fragment, null)));
    });
    await flushMicrotasks();
    expect(unsubscribeFlock).toHaveBeenCalledTimes(1);

    const revisitUpdates: MachineFlockRowMap[] = [];
    act(() => {
      root?.render(
        createElement(
          Provider,
          { store },
          createElement(Fragment, null, probe('revisit', revisitUpdates))
        )
      );
    });
    await flushMicrotasks();

    expect(scan).toHaveBeenCalledTimes(1);
    expect(revisitUpdates.at(-1)?.[dotlodyPathRowId]?.value).toBe('/Users/dedupe/.lody-next');

    // If the local Flock changed while no subscription was alive, the version
    // mismatch forces a fresh scan instead of trusting the warm atom snapshot.
    act(() => {
      root?.render(createElement(Provider, { store }, createElement(Fragment, null)));
    });
    await flushMicrotasks();
    versionClock = 3;
    act(() => {
      root?.render(
        createElement(
          Provider,
          { store },
          createElement(Fragment, null, probe('drifted-revisit', revisitUpdates))
        )
      );
    });
    await flushMicrotasks();

    expect(scan).toHaveBeenCalledTimes(2);
  });
});
