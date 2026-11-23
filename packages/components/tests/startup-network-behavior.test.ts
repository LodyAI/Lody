// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACP_CAPABILITY_CACHE_VERSION,
  getMachineFlockDocId,
  machineFlockKeys,
  serializeMachineFlockKey,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineAcpBinaryProgressMessage,
  type MachineAcpCapabilitiesRefreshResponse,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';
import {
  resetStreamsHttpFallbackCounts,
  getStreamsHttpFallbackCounts,
} from '@lody/shared/streams-transport-diagnostics';

const mocks = vi.hoisted(() => {
  const opLog: Array<{ op: string; detail?: string }> = [];
  const presenceSyncListeners = new Set<(state: string) => void>();
  let onPresenceSnapshot: ((states: Record<string, unknown>) => void) | null = null;
  let cooldownRun: (() => void) | null = null;
  let openFlockDocImpl: (docId: string) => Promise<unknown> = async () => {
    throw new Error('openFlockDocImpl not configured');
  };
  let listDocImpl: () => Promise<
    Array<{ docId: string; meta?: unknown; exists: boolean }>
  > = async () => [];
  let rpcRefreshImpl: (options: {
    configId: AgentConfigId;
    force?: boolean;
    readModelOptions?: boolean;
    signal?: AbortSignal;
    onProgress?: (progress: MachineAcpBinaryProgressMessage) => void;
  }) => Promise<MachineAcpCapabilitiesRefreshResponse | null> = async () => null;

  return {
    opLog,
    presenceSyncListeners,
    presenceSyncState: 'idle' as string,
    setOnPresenceSnapshot(fn: ((states: Record<string, unknown>) => void) | null) {
      onPresenceSnapshot = fn;
    },
    emitPresenceSnapshot(states: Record<string, unknown>) {
      onPresenceSnapshot?.(states);
    },
    setCooldownRun(fn: (() => void) | null) {
      cooldownRun = fn;
    },
    runCooldown() {
      cooldownRun?.();
    },
    setOpenFlockDocImpl(fn: typeof openFlockDocImpl) {
      openFlockDocImpl = fn;
    },
    getOpenFlockDocImpl() {
      return openFlockDocImpl;
    },
    setListDocImpl(fn: typeof listDocImpl) {
      listDocImpl = fn;
    },
    getListDocImpl() {
      return listDocImpl;
    },
    setRpcRefreshImpl(fn: typeof rpcRefreshImpl) {
      rpcRefreshImpl = fn;
    },
    getRpcRefreshImpl() {
      return rpcRefreshImpl;
    },
    joinMetaRoom: vi.fn(),
  };
});

vi.mock('loro-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('loro-repo')>();
  return {
    ...actual,
    LoroRepo: {
      create: vi.fn(async () => ({
        setTransportAdapter: vi.fn(async () => {}),
        addTransport: vi.fn(async () => {}),
        removeTransport: vi.fn(async () => {}),
        refreshTransportRoutes: vi.fn(async () => {}),
        transportRooms: vi.fn(() => []),
        joinMetaRoom: mocks.joinMetaRoom,
        openFlockDoc: (docId: string) => mocks.getOpenFlockDocImpl()(docId),
        flush: vi.fn(async () => {}),
        destroy: vi.fn(async () => {}),
        reconnect: vi.fn(async () => {}),
        listDoc: () => mocks.getListDocImpl()(),
        getDocMeta: vi.fn(async () => undefined),
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        getMeta: () => ({}),
        getReplicaCheckpointStore: vi.fn(() => ({
          load: vi.fn(async () => null),
          save: vi.fn(async () => {}),
          delete: vi.fn(async () => {}),
        })),
      })),
    },
  };
});

vi.mock('loro-repo/storage/indexeddb', () => ({
  IndexedDBStorageAdaptor: class IndexedDBStorageAdaptor {},
}));

vi.mock('loro-repo/transport/streams', () => ({
  createRepoStreamsPersistence: (_repo: unknown, options: object) => ({
    mode: 'replica-bound',
    ...options,
  }),
  StreamsTransportAdapter: class StreamsTransportAdapter {
    joinFlockDocRoom = vi.fn();
    syncFlockDoc = vi.fn();
    connect = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    reconnect = vi.fn(async () => undefined);
    isConnected = vi.fn(() => true);
    getStatus = vi.fn(() => 'connected' as const);
    onStatusChange = vi.fn(() => vi.fn());
  },
}));

vi.mock('@loro-dev/streams-crdt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@loro-dev/streams-crdt')>();
  return {
    ...actual,
    StreamsCrdt: class StreamsCrdt {
      createStream = vi.fn(async () => ({ ok: true }));
      close = vi.fn(async () => {});
    },
  };
});

vi.mock('@loro-dev/streams-crdt/loro', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@loro-dev/streams-crdt/loro')>();
  return {
    ...actual,
    StreamsCrdt: class StreamsCrdt {
      createStream = vi.fn(async () => ({ ok: true }));
      close = vi.fn(async () => {});
    },
    EphemeralStreamCrdt: class EphemeralStreamCrdt {
      async join(options: Parameters<InstanceType<typeof actual.EphemeralStreamCrdt>['join']>[0]) {
        options?.onStatusChange?.('joined');
        return { ok: true, value: { unsubscribe() {} } };
      }
      async close() {}
    },
    createLoroDocAdapter: vi.fn(() => ({})),
  };
});

vi.mock('../src/providers/resilient-remote-cursor-store', () => ({
  createResilientRemoteCursorStore: vi.fn(() => ({
    delete: vi.fn(async () => {}),
  })),
}));

vi.mock('../src/providers/startup-network-idle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/startup-network-idle')>();
  return {
    ...actual,
    scheduleAfterStartupNavigationCooldown: vi.fn(
      (callback: () => void, options?: { cooldownMs?: number }) => {
        if (options?.cooldownMs !== 30_000) return () => {};
        mocks.setCooldownRun(callback);
        return () => {
          mocks.setCooldownRun(null);
        };
      }
    ),
  };
});

vi.mock('../src/providers/workspace-presence-transport', () => ({
  WorkspacePresenceTransport: class WorkspacePresenceTransport {
    constructor(options: { onSnapshot?: (states: Record<string, unknown>) => void }) {
      mocks.setOnPresenceSnapshot(options.onSnapshot ?? null);
    }
    start = vi.fn();
    stop = vi.fn(async () => {});
    getSyncState = vi.fn(() => mocks.presenceSyncState);
    subscribeSyncState = vi.fn((listener: (state: string) => void) => {
      mocks.presenceSyncListeners.add(listener);
      listener(mocks.presenceSyncState);
      return () => {
        mocks.presenceSyncListeners.delete(listener);
      };
    });
    needsReconnect = vi.fn(() => false);
    shouldRestartOnExternalWake = vi.fn(() => false);
  },
}));

vi.mock('../src/providers/workspace-machine-monitor-transport', () => ({
  WorkspaceMachineMonitorTransport: class WorkspaceMachineMonitorTransport {
    start = vi.fn();
    stop = vi.fn(async () => {});
    getSyncState = vi.fn(() => 'idle' as const);
    subscribeSyncState = vi.fn((listener: (state: 'idle') => void) => {
      listener('idle');
      return () => {};
    });
    needsReconnect = vi.fn(() => false);
    shouldRestartOnExternalWake = vi.fn(() => false);
    subscribeMachine = vi.fn(() => () => {});
    forceSample = vi.fn();
  },
}));

vi.mock('@lody/loro-streams-rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lody/loro-streams-rpc')>()),
  createLoroStreamsJsonStreamClient: vi.fn(() => ({})),
  LoroStreamsLiveModePolicy: class LoroStreamsLiveModePolicy {
    selectRequestMode = vi.fn(() => 'auto' as const);
    noteReadOutcome = vi.fn();
    noteResponseReceived = vi.fn();
    noteResponseTimeout = vi.fn();
    getDiagnostics = vi.fn(() => ({
      transport: 'sse' as const,
      reason: 'initial' as const,
      transportSwitches: 0,
      consecutiveSseReadFailures: 0,
      sseResponseTimeouts: 0,
    }));
  },
  LoroStreamsRpcResponseDispatcher: class LoroStreamsRpcResponseDispatcher {
    start = vi.fn(async () => {});
    stop = vi.fn();
  },
  LoroStreamsMachineRpcClient: class LoroStreamsMachineRpcClient {
    start = vi.fn(async () => {});
    stop = vi.fn();
    requestMachineAcpCapabilitiesRefresh = (
      options: Parameters<typeof mocks.getRpcRefreshImpl> extends never[]
        ? never
        : Parameters<ReturnType<typeof mocks.getRpcRefreshImpl>>[0]
    ) => mocks.getRpcRefreshImpl()(options);
  },
  LORO_STREAMS_RPC_RETENTION_SECONDS: 60,
}));

vi.mock('../src/providers/eager-sync-worker-client', () => ({
  createEagerSyncWorkerClient: vi.fn(() => ({
    prefetch: vi.fn(async () => 'skipped' as const),
    cancel: vi.fn(),
    cancelAll: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('@lody/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lody/shared')>();
  return {
    ...actual,
    buildLoroStreamsTokenEndpoint: vi.fn(
      () => 'https://tokens.example.test/api/loro-streams/token'
    ),
    createLoroStreamsTokenProviderLegacy: vi.fn(() => ({
      getToken: vi.fn(async () => 'streams-token'),
      invalidate: vi.fn(),
      close: async () => {},
      retryCleanup: async () => {},
      getGatewayBaseUrl: vi.fn(() => actual.DEFAULT_LORO_STREAMS_BASE_URL),
      getShardHostSuffix: vi.fn(() => undefined),
      createAuthCallback: vi.fn(() => async () => 'streams-token'),
    })),
  };
});

import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { machineFlockRowsByWorkspaceAtom } from '../src/atoms/machine-flock';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms/workspace-context';
import { useMachineFlockRows } from '../src/hooks/use-machine-flock-rows';
import { createWorkspaceRuntime } from '../src/providers/create-workspace-runtime';
import {
  createMetaSub,
  flushPromises,
} from './create-workspace-runtime-meta-recovery-test-helpers';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function publishPresenceState(state: string): void {
  mocks.presenceSyncState = state;
  for (const listener of mocks.presenceSyncListeners) {
    listener(state);
  }
}

function unmountRoot(): void {
  if (root && container) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
}

describe('startup network behavior', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetStreamsHttpFallbackCounts();
    mocks.opLog.length = 0;
    mocks.presenceSyncListeners.clear();
    mocks.presenceSyncState = 'idle';
    mocks.setOnPresenceSnapshot(null);
    mocks.setCooldownRun(null);
    mocks.joinMetaRoom.mockReset().mockResolvedValue(createMetaSub(Promise.resolve()));
    delete window.__LODY_ELECTRON__;
    vi.stubGlobal('navigator', { onLine: true });
  });

  afterEach(() => {
    unmountRoot();
    delete window.__LODY_ELECTRON__;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('reuses active live room on startup capability refresh without syncOnce() and merges capability zero-I/O', async () => {
    const workspaceId = 'ws-startup-live' as WorkspaceId;
    const machineId = 'machine-live-1' as MachineId;
    const configId = 'cfg-live-1' as AgentConfigId;
    const expectedDocId = getMachineFlockDocId(workspaceId, machineId);
    const agentConfig: AgentConfigMeta = {
      id: configId,
      machineId,
      name: 'Claude',
      cliType: 'builtin',
      agentType: 'claude',
      env: {},
      prompt: '',
    };
    const refreshedCapability = {
      cliType: 'builtin' as const,
      agentType: 'claude',
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
      provenance: 'runtime' as const,
      sourceVersion: 'builtin:claude:1.0.0',
      modes: [{ id: 'code', name: 'Code' }],
      models: [{ modelId: 'claude-sonnet', name: 'Claude Sonnet' }],
      configOptions: [],
      fetchedAt: Date.now(),
    };

    const syncOnce = vi.fn(async () => {
      mocks.opLog.push({ op: 'flock.syncOnce', detail: expectedDocId });
      return { ok: true, transports: [{ transportId: 'cloud', ok: true, failures: [] }] };
    });
    const joinRoom = vi.fn(async () => {
      mocks.opLog.push({ op: 'flock.joinRoom', detail: expectedDocId });
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
        waitUntilSynced: async () => undefined,
        transportIds: () => ['cloud'],
        subscription: () => binding,
        subscriptions: () => [binding],
      };
    });
    const openFlockDoc = vi.fn(async (docId: string) => {
      mocks.opLog.push({ op: 'flock.open', detail: docId });
      return {
        flock: {
          scan: vi.fn(() => [{ key: machineFlockKeys.agentConfig(configId), value: agentConfig }]),
          subscribe: vi.fn(() => vi.fn()),
        },
        syncOnce,
        joinRoom,
      };
    });
    mocks.setOpenFlockDocImpl(openFlockDoc);
    mocks.setListDocImpl(async () => [
      { docId: `machine-${machineId}`, meta: { id: machineId }, exists: true },
    ]);
    mocks.setRpcRefreshImpl(async (options) => {
      mocks.opLog.push({
        op: 'rpc.acpRefresh',
        detail: `${options.configId}:${Boolean(options.force)}`,
      });
      return {
        type: 'machine/acp-capabilities-refresh_response',
        machineId,
        configId: options.configId,
        cliType: 'builtin',
        agentType: 'claude',
        success: true,
        capability: refreshedCapability,
      };
    });

    const runtime = await createWorkspaceRuntime({
      content: { mode: 'plaintext' },
      workspaceSlug: 'workspace',
      workspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
      getAuthorizedMachineIds: () => new Set([machineId]),
    });

    const store = createStore();
    store.set(runtimeAtom, runtime as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, 'workspace');
    function RoomHolder() {
      useMachineFlockRows(machineId);
      return null;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(createElement(Provider, { store }, createElement(RoomHolder)));
    });
    await flushPromises();

    mocks.emitPresenceSnapshot({
      [`machine:${machineId}`]: {
        kind: 'machine',
        machineId,
        updatedAt: Date.now() + 60_000,
      },
    });
    publishPresenceState('synced');
    mocks.runCooldown();
    await flushPromises();
    await vi.waitFor(() =>
      expect(mocks.opLog.some((entry) => entry.op === 'rpc.acpRefresh')).toBe(true)
    );
    await flushPromises();

    expect(syncOnce).not.toHaveBeenCalled();
    expect(getStreamsHttpFallbackCounts()['forced-sync']).toBe(0);
    expect(mocks.opLog.filter((entry) => entry.op === 'rpc.acpRefresh')).toEqual([
      { op: 'rpc.acpRefresh', detail: `${configId}:false` },
    ]);
    const capRowKey = serializeMachineFlockKey(machineFlockKeys.acpCapability(configId));
    expect(
      store.get(machineFlockRowsByWorkspaceAtom)[workspaceId]?.[machineId]?.[capRowKey]?.value
    ).toEqual(refreshedCapability);

    await runtime.dispose();
  });

  it('falls back to handle.syncOnce() and records forced-sync when no active live room exists on startup refresh', async () => {
    const workspaceId = 'ws-startup-fallback' as WorkspaceId;
    const machineId = 'machine-fallback-1' as MachineId;
    const configId = 'cfg-fallback-1' as AgentConfigId;
    const expectedDocId = getMachineFlockDocId(workspaceId, machineId);
    const agentConfig: AgentConfigMeta = {
      id: configId,
      machineId,
      name: 'Claude',
      cliType: 'builtin',
      agentType: 'claude',
      env: {},
      prompt: '',
    };

    const syncOnce = vi.fn(async () => {
      mocks.opLog.push({ op: 'flock.syncOnce', detail: expectedDocId });
      return { ok: true, transports: [{ transportId: 'cloud', ok: true, failures: [] }] };
    });
    const openFlockDoc = vi.fn(async (docId: string) => {
      mocks.opLog.push({ op: 'flock.open', detail: docId });
      return {
        flock: {
          scan: vi.fn(() => [{ key: machineFlockKeys.agentConfig(configId), value: agentConfig }]),
          subscribe: vi.fn(() => vi.fn()),
        },
        syncOnce,
        joinRoom: vi.fn(),
      };
    });
    mocks.setOpenFlockDocImpl(openFlockDoc);
    mocks.setListDocImpl(async () => [
      { docId: `machine-${machineId}`, meta: { id: machineId }, exists: true },
    ]);
    mocks.setRpcRefreshImpl(async (options) => {
      mocks.opLog.push({ op: 'rpc.acpRefresh', detail: options.configId });
      return null;
    });

    const runtime = await createWorkspaceRuntime({
      content: { mode: 'plaintext' },
      workspaceSlug: 'workspace',
      workspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
      getAuthorizedMachineIds: () => new Set([machineId]),
    });

    mocks.emitPresenceSnapshot({
      [`machine:${machineId}`]: {
        kind: 'machine',
        machineId,
        updatedAt: Date.now() + 60_000,
      },
    });
    publishPresenceState('synced');
    mocks.runCooldown();
    await flushPromises();
    await vi.waitFor(() =>
      expect(mocks.opLog.some((entry) => entry.op === 'rpc.acpRefresh')).toBe(true)
    );
    await flushPromises();

    expect(syncOnce).toHaveBeenCalledTimes(1);
    expect(getStreamsHttpFallbackCounts()['forced-sync']).toBe(1);

    await runtime.dispose();
  });

  it('deduplicates concurrent requestMachineAcpCapabilitiesRefresh across consumers, isolates abort, and has no success TTL cache', async () => {
    const workspaceId = 'ws-dedupe' as WorkspaceId;
    const machineId = 'machine-dedupe' as MachineId;
    const configId = 'cfg-dedupe' as AgentConfigId;

    const firstDeferred = Promise.withResolvers<MachineAcpCapabilitiesRefreshResponse | null>();
    const secondDeferred = Promise.withResolvers<MachineAcpCapabilitiesRefreshResponse | null>();
    const rpcCalls: Array<{
      force: boolean;
      readModelOptions: boolean;
      signal?: AbortSignal;
      emitProgress: (step: string) => void;
    }> = [];

    mocks.setRpcRefreshImpl(async (options) => {
      const callIndex = rpcCalls.length;
      rpcCalls.push({
        force: Boolean(options.force),
        readModelOptions: Boolean(options.readModelOptions),
        signal: options.signal,
        emitProgress: (step: string) =>
          options.onProgress?.({
            type: 'machine/acp-binary-progress',
            machineId,
            agentType: 'claude',
            stage: 'downloading',
            message: step,
          }),
      });
      return callIndex === 0 ? await firstDeferred.promise : await secondDeferred.promise;
    });

    const runtime = await createWorkspaceRuntime({
      content: { mode: 'plaintext' },
      workspaceSlug: 'workspace',
      workspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
    });

    const controller1 = new AbortController();
    const controller2 = new AbortController();
    const progress1: string[] = [];
    const progress2: string[] = [];

    const p1 = runtime.requestMachineAcpCapabilitiesRefresh(
      {
        type: 'machine/acp-capabilities-refresh',
        workspaceId,
        machineId,
        configId,
      },
      {
        signal: controller1.signal,
        onProgress: (p) => progress1.push(p.message ?? ''),
      }
    );
    const p2 = runtime.requestMachineAcpCapabilitiesRefresh(
      {
        type: 'machine/acp-capabilities-refresh',
        workspaceId,
        machineId,
        configId,
      },
      {
        signal: controller2.signal,
        onProgress: (p) => progress2.push(p.message ?? ''),
      }
    );

    await vi.waitFor(() => expect(rpcCalls).toHaveLength(1));

    rpcCalls[0]!.emitProgress('step-1');
    expect(progress1).toEqual(['step-1']);
    expect(progress2).toEqual(['step-1']);

    controller1.abort();
    await expect(p1).resolves.toBeNull();
    expect(rpcCalls[0]!.signal?.aborted).toBe(false);

    const response1: MachineAcpCapabilitiesRefreshResponse = {
      type: 'machine/acp-capabilities-refresh_response',
      machineId,
      configId,
      cliType: 'builtin',
      agentType: 'claude',
      success: true,
    };
    firstDeferred.resolve(response1);
    await expect(p2).resolves.toEqual(response1);

    const p3 = runtime.requestMachineAcpCapabilitiesRefresh({
      type: 'machine/acp-capabilities-refresh',
      workspaceId,
      machineId,
      configId,
    });
    await vi.waitFor(() => expect(rpcCalls).toHaveLength(2));

    const controllerAll = new AbortController();
    const p4 = runtime.requestMachineAcpCapabilitiesRefresh(
      {
        type: 'machine/acp-capabilities-refresh',
        workspaceId,
        machineId,
        configId,
        force: true,
      },
      { signal: controllerAll.signal }
    );
    await vi.waitFor(() => expect(rpcCalls).toHaveLength(3));
    expect(rpcCalls[2]!.signal?.aborted).toBe(false);
    controllerAll.abort();
    await expect(p4).resolves.toBeNull();
    expect(rpcCalls[2]!.signal?.aborted).toBe(true);

    secondDeferred.resolve(response1);
    await expect(p3).resolves.toEqual(response1);

    await runtime.dispose();
  });

  it('starts a fresh non-aborted request when consumer 2 enters right after sole consumer 1 aborts', async () => {
    const workspaceId = 'ws-abort-reenter' as WorkspaceId;
    const machineId = 'machine-abort-reenter' as MachineId;
    const configId = 'cfg-abort-reenter' as AgentConfigId;

    const firstDeferred = Promise.withResolvers<MachineAcpCapabilitiesRefreshResponse | null>();
    const secondDeferred = Promise.withResolvers<MachineAcpCapabilitiesRefreshResponse | null>();
    const rpcCalls: Array<{ signal?: AbortSignal }> = [];

    mocks.setRpcRefreshImpl(async (options) => {
      const idx = rpcCalls.length;
      rpcCalls.push({ signal: options.signal });
      return idx === 0 ? await firstDeferred.promise : await secondDeferred.promise;
    });

    const runtime = await createWorkspaceRuntime({
      content: { mode: 'plaintext' },
      workspaceSlug: 'workspace',
      workspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
    });

    const c1 = new AbortController();
    const p1 = runtime.requestMachineAcpCapabilitiesRefresh(
      {
        type: 'machine/acp-capabilities-refresh',
        workspaceId,
        machineId,
        configId,
      },
      { signal: c1.signal }
    );
    await vi.waitFor(() => expect(rpcCalls).toHaveLength(1));

    c1.abort();
    const p2 = runtime.requestMachineAcpCapabilitiesRefresh({
      type: 'machine/acp-capabilities-refresh',
      workspaceId,
      machineId,
      configId,
    });

    await expect(p1).resolves.toBeNull();
    expect(rpcCalls[0]!.signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(rpcCalls).toHaveLength(2));
    expect(rpcCalls[1]!.signal?.aborted).toBe(false);

    const response2: MachineAcpCapabilitiesRefreshResponse = {
      type: 'machine/acp-capabilities-refresh_response',
      machineId,
      configId,
      cliType: 'builtin',
      agentType: 'claude',
      success: true,
    };
    secondDeferred.resolve(response2);
    await expect(p2).resolves.toEqual(response2);
    firstDeferred.resolve(null);

    await runtime.dispose();
  });

  it('skips startup ACP refresh in a second Electron window when another window holds the Web Lock', async () => {
    const workspaceId = 'ws-lock' as WorkspaceId;
    const machineId = 'machine-lock' as MachineId;
    const configId = 'cfg-lock' as AgentConfigId;

    window.__LODY_ELECTRON__ = true;
    const lockRequests: string[] = [];
    vi.stubGlobal('navigator', {
      onLine: true,
      locks: {
        request: vi.fn(
          async (
            name: string,
            _opts: unknown,
            callback: (lock: object | null) => Promise<void>
          ) => {
            lockRequests.push(name);
            await callback(null);
          }
        ),
      },
    });

    mocks.setListDocImpl(async () => [
      { docId: `machine-${machineId}`, meta: { id: machineId }, exists: true },
    ]);
    mocks.setOpenFlockDocImpl(async () => ({
      flock: {
        scan: vi.fn(() => [
          {
            key: machineFlockKeys.agentConfig(configId),
            value: {
              id: configId,
              machineId,
              name: 'Claude',
              cliType: 'builtin',
              agentType: 'claude',
              env: {},
              prompt: '',
            },
          },
        ]),
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce: vi.fn(async () => ({ ok: true, transports: [] })),
      joinRoom: vi.fn(),
    }));
    const rpcSpy = vi.fn(async () => null);
    mocks.setRpcRefreshImpl(rpcSpy);

    const runtime = await createWorkspaceRuntime({
      content: { mode: 'plaintext' },
      workspaceSlug: 'workspace',
      workspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
      getAuthorizedMachineIds: () => new Set([machineId]),
    });

    mocks.emitPresenceSnapshot({
      [`machine:${machineId}`]: {
        kind: 'machine',
        machineId,
        updatedAt: Date.now() + 60_000,
      },
    });
    publishPresenceState('synced');
    mocks.runCooldown();
    await flushPromises();

    expect(lockRequests).toEqual([`lody:workspace-startup-acp:${workspaceId}`]);
    expect(rpcSpy).not.toHaveBeenCalled();

    await runtime.dispose();
  });

  it('resyncs via resyncMachineFlockRows when no active joined live room exists and keeps fresher capability across later family mounts', async () => {
    const workspaceId = 'ws-startup-fallback-cap' as WorkspaceId;
    const machineId = 'machine-fallback-cap-1' as MachineId;
    const configId = 'cfg-fallback-cap-1' as AgentConfigId;
    const staleCap = {
      cliType: 'builtin' as const,
      agentType: 'claude',
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
      provenance: 'runtime' as const,
      sourceVersion: 'builtin:claude:0.9',
      modes: [{ id: 'stale', name: 'Stale' }],
      models: [{ modelId: 'claude-stale', name: 'Stale' }],
      configOptions: [],
      fetchedAt: 5,
    };
    const refreshedCap = {
      cliType: 'builtin' as const,
      agentType: 'claude',
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
      provenance: 'runtime' as const,
      sourceVersion: 'builtin:claude:1.0',
      modes: [{ id: 'code', name: 'Code' }],
      models: [{ modelId: 'claude-sonnet', name: 'Claude Sonnet' }],
      configOptions: [],
      fetchedAt: 500,
    };
    const agentConfig: AgentConfigMeta = {
      id: configId,
      machineId,
      name: 'Claude',
      cliType: 'builtin',
      agentType: 'claude',
      env: {},
      prompt: '',
    };

    const syncOnce = vi.fn(async () => ({
      ok: true,
      transports: [],
    }));
    const openFlockDoc = vi.fn(async () => ({
      flock: {
        scan: vi.fn(() => [
          { key: machineFlockKeys.agentConfig(configId), value: agentConfig },
          { key: machineFlockKeys.acpCapability(configId), value: staleCap },
        ]),
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce,
      joinRoom: vi.fn(),
    }));
    mocks.setOpenFlockDocImpl(openFlockDoc);
    mocks.setListDocImpl(async () => [
      { docId: `machine-${machineId}`, meta: { id: machineId }, exists: true },
    ]);
    mocks.setRpcRefreshImpl(async (options) => ({
      type: 'machine/acp-capabilities-refresh_response',
      machineId,
      configId: options.configId,
      cliType: 'builtin',
      agentType: 'claude',
      success: true,
      capability: refreshedCap,
    }));

    const runtime = await createWorkspaceRuntime({
      content: { mode: 'plaintext' },
      workspaceSlug: 'workspace',
      workspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
      getAuthorizedMachineIds: () => new Set([machineId]),
    });

    mocks.emitPresenceSnapshot({
      [`machine:${machineId}`]: {
        kind: 'machine',
        machineId,
        updatedAt: Date.now() + 60_000,
      },
    });
    publishPresenceState('synced');
    mocks.runCooldown();
    await flushPromises();
    await vi.waitFor(() => expect(syncOnce).toHaveBeenCalledTimes(2));
    await flushPromises();
    await flushPromises();

    const store = createStore();
    store.set(runtimeAtom, runtime as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, 'workspace');
    let observedRows: Record<string, { value: unknown }> = {};
    function FamilyReader() {
      observedRows = useMachineFlockRows(machineId, {
        families: ['agentConfig', 'acpCapability'],
        syncRemote: false,
      });
      return null;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Provider, { store }, createElement(FamilyReader)));
      await flushPromises();
    });

    const capRowKey = serializeMachineFlockKey(machineFlockKeys.acpCapability(configId));
    await vi.waitFor(() => expect(observedRows[capRowKey]?.value).toEqual(refreshedCap));

    await runtime.dispose();
  });

  it('releases Electron Web Lock once startup pass completes and retries in a second window when an earlier pass fails', async () => {
    const workspaceId = 'ws-lock-lifecycle' as WorkspaceId;
    const machineId = 'machine-lock-lifecycle' as MachineId;
    const configId = 'cfg-lock-lifecycle' as AgentConfigId;
    const agentConfig: AgentConfigMeta = {
      id: configId,
      machineId,
      name: 'Claude',
      cliType: 'builtin',
      agentType: 'claude',
      env: {},
      prompt: '',
    };

    window.__LODY_ELECTRON__ = true;
    let lockHeld = false;
    vi.stubGlobal('navigator', {
      onLine: true,
      locks: {
        request: vi.fn(
          async (
            _name: string,
            _opts: unknown,
            callback: (lock: object | null) => Promise<void>
          ) => {
            if (lockHeld) {
              await callback(null);
              return;
            }
            lockHeld = true;
            try {
              await callback({ name: _name });
            } finally {
              lockHeld = false;
            }
          }
        ),
      },
    });

    mocks.setListDocImpl(async () => [
      { docId: `machine-${machineId}`, meta: { id: machineId }, exists: true },
    ]);
    mocks.setOpenFlockDocImpl(async () => ({
      flock: {
        scan: vi.fn(() => [{ key: machineFlockKeys.agentConfig(configId), value: agentConfig }]),
        subscribe: vi.fn(() => vi.fn()),
      },
      syncOnce: vi.fn(async () => ({
        ok: true,
        transports: [{ transportId: 'cloud', ok: true, failures: [] }],
      })),
      joinRoom: vi.fn(),
    }));
    let attempt = 0;
    mocks.setRpcRefreshImpl(async (options) => {
      attempt += 1;
      if (attempt === 1) {
        return {
          type: 'machine/acp-capabilities-refresh_response',
          machineId,
          configId: options.configId,
          cliType: 'builtin',
          agentType: 'claude',
          success: false,
          error: 'transient error',
        };
      }
      return {
        type: 'machine/acp-capabilities-refresh_response',
        machineId,
        configId: options.configId,
        cliType: 'builtin',
        agentType: 'claude',
        success: true,
      };
    });

    const runtime1 = await createWorkspaceRuntime({
      content: { mode: 'plaintext' },
      workspaceSlug: 'workspace',
      workspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
      getAuthorizedMachineIds: () => new Set([machineId]),
    });

    mocks.emitPresenceSnapshot({
      [`machine:${machineId}`]: {
        kind: 'machine',
        machineId,
        updatedAt: Date.now() + 60_000,
      },
    });
    publishPresenceState('synced');
    mocks.runCooldown();
    await flushPromises();
    await vi.waitFor(() => expect(attempt).toBe(1));
    await vi.waitFor(() => expect(lockHeld).toBe(false));

    const runtime2 = await createWorkspaceRuntime({
      content: { mode: 'plaintext' },
      workspaceSlug: 'workspace',
      workspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
      getAuthorizedMachineIds: () => new Set([machineId]),
    });

    mocks.emitPresenceSnapshot({
      [`machine:${machineId}`]: {
        kind: 'machine',
        machineId,
        updatedAt: Date.now() + 60_000,
      },
    });
    publishPresenceState('synced');
    mocks.runCooldown();
    await flushPromises();
    await vi.waitFor(() => expect(attempt).toBe(2));
    await vi.waitFor(() => expect(lockHeld).toBe(false));

    let thirdAcquired = false;
    await navigator.locks.request(
      `lody:workspace-startup-acp:${workspaceId}`,
      { ifAvailable: true },
      async (lock) => {
        thirdAcquired = Boolean(lock);
      }
    );
    expect(thirdAcquired).toBe(true);

    await runtime1.dispose();
    await runtime2.dispose();
  });
});
