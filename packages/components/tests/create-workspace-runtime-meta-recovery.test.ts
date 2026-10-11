import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  getMachineRoomId,
  getSessionRoomId,
  type MachineId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo, TransportAdapter, TransportSubscription } from 'loro-repo';

const mocks = vi.hoisted(() => {
  const setTransportAdapter = vi.fn(async () => {});
  // Mirrors loro-repo: addTransport connects the adapter before resolving, so
  // the in-flight-attach dispose test can gate on the adapter's connect().
  const addTransport = vi.fn(async (_id: string, adapter?: { connect?: () => Promise<void> }) => {
    await adapter?.connect?.();
  });
  const removeTransport = vi.fn(async () => {});
  const refreshTransportRoutes = vi.fn(async () => {});
  const transportRooms = vi.fn(() => []);
  const flush = vi.fn(async () => {});
  const destroy = vi.fn(async () => {});
  const reconnect = vi.fn(async () => {});
  const listDoc = vi.fn(async (): ReturnType<LoroRepo['listDoc']> => []);
  const getDocMeta = vi.fn(
    async (_docId: string): Promise<{ meta?: unknown } | undefined> => undefined
  );
  const watch = vi.fn(() => ({ unsubscribe: vi.fn() }));
  const joinMetaRoom = vi.fn();
  const remoteCursorDelete = vi.fn(async () => {});
  const metaFlock = {};
  const metaCheckpointDelete = vi.fn(async (_streamUrl: string) => {});
  const getReplicaCheckpointStore = vi.fn((_target: { kind: string; flock: unknown }) => ({
    load: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    delete: metaCheckpointDelete,
  }));
  const tokenProviderInvalidate = vi.fn();
  const presenceStart = vi.fn();
  const presenceStop = vi.fn(async () => {});
  const streamsConnect = vi.fn(async () => undefined);
  const streamsTransportConstructors = vi.fn();
  const machineRpcConstructors = vi.fn();
  const machineRpcStart = vi.fn(async () => {});
  const machineRpcStop = vi.fn();
  const machineRpcOpenTurnDiff = vi.fn(async () => ({ status: 'ok' }));
  const rpcResponseDispatcherStart = vi.fn(async () => {});
  const rpcResponseDispatcherStop = vi.fn();
  const presenceShouldRestartOnExternalWake = vi.fn(() => false);
  const presenceSyncListeners = new Set<(state: string) => void>();
  const startupAcpCapabilitiesRefresh = vi.fn(async () => {});
  const startupCapabilityCooldowns: Array<{
    cancelled: boolean;
    run: () => void;
  }> = [];
  const streamClient = {};
  // Identity for the Streams token provider and its auth callbacks, so tests can
  // prove the eager-sync bridge holds ONE callback per provider instead of
  // rebuilding one per invocation (a rebuilt callback forgets its last token).
  const providerIdentity = { providers: 0, callbacks: 0 };
  const authInvocations: Array<{
    providerId: number;
    callbackId: number;
    context?: { reason: string; previousToken?: string };
  }> = [];
  const eagerSyncDeps: Array<{
    auth(context?: { reason: string; previousToken?: string }): Promise<string | undefined>;
  }> = [];

  return {
    realTokenProvider: false,
    tokenReady: vi.fn(async () => 'streams-token'),
    repoOverride: null as LoroRepo | null,
    providerIdentity,
    authInvocations,
    eagerSyncDeps,
    setTransportAdapter,
    addTransport,
    removeTransport,
    refreshTransportRoutes,
    transportRooms,
    flush,
    destroy,
    reconnect,
    listDoc,
    getDocMeta,
    watch,
    joinMetaRoom,
    remoteCursorDelete,
    metaFlock,
    metaCheckpointDelete,
    getReplicaCheckpointStore,
    tokenProviderInvalidate,
    presenceStart,
    presenceStop,
    streamsConnect,
    streamsTransportConstructors,
    machineRpcConstructors,
    machineRpcStart,
    machineRpcStop,
    machineRpcOpenTurnDiff,
    rpcResponseDispatcherStart,
    rpcResponseDispatcherStop,
    presenceShouldRestartOnExternalWake,
    presenceSyncListeners,
    presenceSyncState: 'idle',
    startupAcpCapabilitiesRefresh,
    startupCapabilityCooldowns,
    streamClient,
  };
});

let documentListeners: Map<string, Set<EventListener>>;
let windowListeners: Map<string, Set<EventListener>>;

type FakeMetaSub = {
  status: 'joined';
  firstSyncedWithRemote: Promise<void>;
  onStatusChange: (listener: (status: 'joined') => void) => () => void;
  unsubscribe: ReturnType<typeof vi.fn>;
};

const createMetaSub = (firstSyncedWithRemote: Promise<void>): FakeMetaSub => {
  const bindings = new Map<string, unknown>();
  return {
    status: 'joined',
    firstSyncedWithRemote,
    onStatusChange: vi.fn(() => vi.fn()),
    unsubscribe: vi.fn(),
    // Per-transport stable bindings (loro-repo >=0.19); the runtime selects a
    // plane instead of reading the aggregate on dual-homed rooms.
    subscription: vi.fn((transportId: string) => {
      let binding = bindings.get(transportId);
      if (!binding) {
        binding = {
          transportId,
          status: 'joined',
          firstSyncedWithRemote,
          onStatusChange: vi.fn(() => vi.fn()),
          waitUntilSynced: vi.fn(async () => {}),
          rejoin: vi.fn(async () => {}),
        };
        bindings.set(transportId, binding);
      }
      return binding;
    }),
  };
};

const flushPromises = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};

const dispatchDocumentEvent = (event: string): void => {
  for (const listener of documentListeners.get(event) ?? []) {
    listener({ type: event } as Event);
  }
};

const dispatchWindowEvent = (event: string): void => {
  for (const listener of windowListeners.get(event) ?? []) {
    listener({ type: event } as Event);
  }
};

const publishPresenceSyncState = (state: string): void => {
  mocks.presenceSyncState = state;
  for (const listener of mocks.presenceSyncListeners) {
    listener(state);
  }
};

const expectNoPresenceStopAfterStart = () => {
  const firstPresenceStartOrder = mocks.presenceStart.mock.invocationCallOrder[0];
  expect(firstPresenceStartOrder).toBeDefined();
  expect(
    mocks.presenceStop.mock.invocationCallOrder.some((order) => order > firstPresenceStartOrder!)
  ).toBe(false);
};

const enableElectronLocalDataPlane = (): void => {
  Object.assign(window, {
    __LODY_ELECTRON__: true,
    ipc: {
      invoke: vi.fn(async (channel: string) => channel === 'loro.isConnected'),
      on: vi.fn(() => () => {}),
      send: vi.fn(),
    },
  });
};

vi.mock('loro-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('loro-repo')>();
  return {
    ...actual,
    LoroRepo: {
      create: vi.fn(
        async () =>
          mocks.repoOverride ?? {
            setTransportAdapter: mocks.setTransportAdapter,
            addTransport: mocks.addTransport,
            removeTransport: mocks.removeTransport,
            refreshTransportRoutes: mocks.refreshTransportRoutes,
            transportRooms: mocks.transportRooms,
            joinMetaRoom: mocks.joinMetaRoom,
            flush: mocks.flush,
            destroy: mocks.destroy,
            reconnect: mocks.reconnect,
            listDoc: mocks.listDoc,
            getDocMeta: mocks.getDocMeta,
            watch: mocks.watch,
            getMeta: () => mocks.metaFlock,
            getReplicaCheckpointStore: mocks.getReplicaCheckpointStore,
          }
      ),
    },
  };
});

vi.mock('loro-repo/storage/indexeddb', () => ({
  IndexedDBStorageAdaptor: class IndexedDBStorageAdaptor {
    constructor(readonly options: unknown) {}
  },
}));

vi.mock('loro-repo/transport/streams', () => ({
  createRepoStreamsPersistence: (_repo: unknown, options: object) => ({
    mode: 'replica-bound',
    ...options,
  }),
  StreamsTransportAdapter: class StreamsTransportAdapter {
    constructor(readonly options: unknown) {
      mocks.streamsTransportConstructors(options);
    }
    connect = mocks.streamsConnect;
    close = vi.fn(async () => undefined);
    reconnect = vi.fn(async () => undefined);
    isConnected = vi.fn(() => true);
    getStatus = vi.fn(() => 'connected' as const);
    onStatusChange = vi.fn((listener: (status: 'connected') => void) => {
      listener('connected');
      return vi.fn();
    });
  },
}));

vi.mock('@loro-dev/streams-crdt/loro', () => ({
  StreamsCrdt: class StreamsCrdt {
    createStream = vi.fn(async () => ({ ok: true }));
    close = vi.fn(async () => {});
  },
  createLoroDocAdapter: vi.fn(() => ({})),
}));

vi.mock('../src/providers/resilient-remote-cursor-store', () => ({
  createResilientRemoteCursorStore: vi.fn(() => ({
    delete: mocks.remoteCursorDelete,
  })),
}));

// Keep the background eager-sync coordinator out of these lifecycle tests: the
// fake repo has no watch()/doc-meta surface, and the reconnect-loop backstop
// interval advances virtual time far enough for the real cooldown to elapse.
vi.mock('../src/providers/startup-network-idle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/startup-network-idle')>();
  return {
    ...actual,
    scheduleAfterStartupNavigationCooldown: vi.fn(
      (callback: () => void, options?: { cooldownMs?: number }) => {
        if (options?.cooldownMs !== 30_000) return () => {};
        const cooldown = {
          cancelled: false,
          run: () => {
            if (!cooldown.cancelled) callback();
          },
        };
        mocks.startupCapabilityCooldowns.push(cooldown);
        return () => {
          cooldown.cancelled = true;
        };
      }
    ),
  };
});

vi.mock('../src/providers/workspace-presence-transport', () => ({
  WorkspacePresenceTransport: class WorkspacePresenceTransport {
    start = mocks.presenceStart;
    stop = mocks.presenceStop;
    getSyncState = vi.fn(() => mocks.presenceSyncState);
    subscribeSyncState = vi.fn((listener: (state: string) => void) => {
      mocks.presenceSyncListeners.add(listener);
      listener(mocks.presenceSyncState);
      return () => {
        mocks.presenceSyncListeners.delete(listener);
      };
    });
    needsReconnect = vi.fn(() => false);
    shouldRestartOnExternalWake = mocks.presenceShouldRestartOnExternalWake;
  },
}));

vi.mock('../src/providers/startup-acp-capabilities-refresh', () => ({
  runStartupAcpCapabilitiesRefresh: mocks.startupAcpCapabilitiesRefresh,
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

vi.mock('@lody/loro-streams-rpc', () => ({
  createLoroStreamsJsonStreamClient: vi.fn(() => mocks.streamClient),
  LoroStreamsLiveModePolicy: class LoroStreamsLiveModePolicy {
    constructor(readonly options: unknown) {}
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
    constructor(readonly options: unknown) {}
    start = mocks.rpcResponseDispatcherStart;
    stop = mocks.rpcResponseDispatcherStop;
  },
  LoroStreamsMachineRpcClient: class LoroStreamsMachineRpcClient {
    constructor(readonly options: unknown) {
      mocks.machineRpcConstructors(options);
    }
    start = mocks.machineRpcStart;
    stop = mocks.machineRpcStop;
    requestCodeCollabOpenTurnDiff = mocks.machineRpcOpenTurnDiff;
  },
  LORO_STREAMS_RPC_RETENTION_SECONDS: 60,
}));

vi.mock('../src/providers/eager-sync-worker-client', () => ({
  createEagerSyncWorkerClient: vi.fn((deps: (typeof mocks.eagerSyncDeps)[number]) => {
    mocks.eagerSyncDeps.push(deps);
    return {
      prefetch: vi.fn(async () => 'skipped' as const),
      cancel: vi.fn(),
      cancelAll: vi.fn(),
      dispose: vi.fn(),
    };
  }),
}));

vi.mock('@lody/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lody/shared')>();
  return {
    ...actual,
    buildLoroStreamsTokenEndpoint: vi.fn(
      () => 'https://tokens.example.test/api/loro-streams/token'
    ),
    createLoroStreamsTokenProvider: vi.fn((options) => {
      if (mocks.realTokenProvider) return actual.createLoroStreamsTokenProvider(options);
      const providerId = ++mocks.providerIdentity.providers;
      return {
        getToken: mocks.tokenReady,
        invalidate: mocks.tokenProviderInvalidate,
        getGatewayBaseUrl: vi.fn(() => actual.DEFAULT_LORO_STREAMS_BASE_URL),
        getShardHostSuffix: vi.fn(() => undefined),
        createAuthCallback: vi.fn(() => {
          const callbackId = ++mocks.providerIdentity.callbacks;
          return async (context?: { reason: string; previousToken?: string }) => {
            mocks.authInvocations.push({ providerId, callbackId, context });
            return 'streams-token';
          };
        }),
      };
    }),
  };
});

import {
  createWorkspaceRuntime,
  resolveWorkspaceRuntimeCacheIdentity,
} from '../src/providers/create-workspace-runtime';
import { META_REMOTE_CURSOR_BYPASS_STORAGE_KEY_PREFIX } from '../src/lib/clear-local-cache';

describe('createWorkspaceRuntime meta recovery lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.repoOverride = null;
    mocks.realTokenProvider = false;
    mocks.tokenReady.mockReset().mockResolvedValue('streams-token');
    mocks.providerIdentity.providers = 0;
    mocks.providerIdentity.callbacks = 0;
    mocks.authInvocations.length = 0;
    mocks.eagerSyncDeps.length = 0;
    mocks.setTransportAdapter.mockClear();
    mocks.addTransport.mockClear();
    mocks.removeTransport.mockClear();
    mocks.refreshTransportRoutes.mockClear();
    mocks.transportRooms.mockClear();
    mocks.flush.mockClear();
    mocks.destroy.mockClear();
    mocks.reconnect.mockClear();
    mocks.listDoc.mockReset();
    mocks.listDoc.mockResolvedValue([]);
    mocks.getDocMeta.mockReset();
    mocks.getDocMeta.mockResolvedValue(undefined);
    mocks.watch.mockClear();
    mocks.joinMetaRoom.mockReset();
    mocks.remoteCursorDelete.mockClear();
    mocks.metaCheckpointDelete.mockClear();
    mocks.getReplicaCheckpointStore.mockClear();
    mocks.tokenProviderInvalidate.mockClear();
    mocks.presenceStart.mockClear();
    mocks.presenceStop.mockClear();
    mocks.streamsConnect.mockReset();
    mocks.streamsConnect.mockResolvedValue(undefined);
    mocks.streamsTransportConstructors.mockClear();
    mocks.machineRpcConstructors.mockClear();
    mocks.machineRpcStart.mockClear();
    mocks.machineRpcStop.mockClear();
    mocks.machineRpcOpenTurnDiff.mockClear();
    mocks.rpcResponseDispatcherStart.mockClear();
    mocks.rpcResponseDispatcherStop.mockClear();
    mocks.presenceShouldRestartOnExternalWake.mockReset();
    mocks.presenceShouldRestartOnExternalWake.mockReturnValue(false);
    mocks.presenceSyncListeners.clear();
    mocks.presenceSyncState = 'idle';
    mocks.startupAcpCapabilitiesRefresh.mockClear();
    mocks.startupCapabilityCooldowns.length = 0;

    const storage = new Map<string, string>();
    const localStorage = {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        storage.delete(key);
      }),
    };
    documentListeners = new Map<string, Set<EventListener>>();
    windowListeners = new Map<string, Set<EventListener>>();

    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn((event: string, listener: EventListener) => {
        const listeners = documentListeners.get(event) ?? new Set<EventListener>();
        listeners.add(listener);
        documentListeners.set(event, listeners);
      }),
      removeEventListener: vi.fn((event: string, listener: EventListener) => {
        documentListeners.get(event)?.delete(listener);
      }),
    });
    vi.stubGlobal('window', {
      localStorage,
      addEventListener: vi.fn((event: string, listener: EventListener) => {
        const listeners = windowListeners.get(event) ?? new Set<EventListener>();
        listeners.add(listener);
        windowListeners.set(event, listeners);
      }),
      removeEventListener: vi.fn((event: string, listener: EventListener) => {
        windowListeners.get(event)?.delete(listener);
      }),
    });
    vi.stubGlobal('navigator', { onLine: true });
    // The runtime reads `globalThis.localStorage`; without this, a Meta cursor
    // bypass marker written by one test leaks into every later one.
    vi.stubGlobal('localStorage', localStorage);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('cleans up a failed local attach before rejecting startup', async () => {
    enableElectronLocalDataPlane();
    const registered = new Set<string>();
    mocks.addTransport.mockImplementationOnce(async (id) => {
      registered.add(id);
      throw new Error('local attach failed');
    });
    mocks.removeTransport.mockImplementation(async (id) => {
      registered.delete(id);
    });
    await expect(
      createWorkspaceRuntime({
        workspaceSlug: 'workspace',
        workspaceId: 'workspace-1' as WorkspaceId,
        apiBaseUrl: 'https://api.example.test',
        syncMode: 'local',
      })
    ).rejects.toThrow('local attach failed');
    expect(registered.size).toBe(0);
    expect(
      [...windowListeners.values(), ...documentListeners.values()].every((set) => set.size === 0)
    ).toBe(true);
    expect(window.repo).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts the real token provider fetch when startup is cancelled', async () => {
    mocks.realTokenProvider = true;
    const entered = Promise.withResolvers<AbortSignal>();
    let activeRequests = 0;
    vi.stubGlobal(
      'fetch',
      (_input: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          activeRequests++;
          const signal = init.signal!;
          signal.addEventListener(
            'abort',
            () => {
              activeRequests--;
              reject(signal.reason);
            },
            { once: true }
          );
          entered.resolve(signal);
        })
    );
    const controller = new AbortController();
    const creating = createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
      signal: controller.signal,
    });
    const result = expect(creating).rejects.toThrow();
    const requestSignal = await entered.promise;
    controller.abort();
    await result;
    expect(requestSignal.aborted).toBe(true);
    expect(activeRequests).toBe(0);
    expect(window.repo).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('joins a late token result and never publishes its Streams client after close', async () => {
    const entered = Promise.withResolvers<void>();
    const token = Promise.withResolvers<string>();
    mocks.tokenReady.mockImplementationOnce(() => {
      entered.resolve();
      return token.promise;
    });
    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
    });
    const attaching = runtime.setAuthToken('auth-token');
    await entered.promise;
    let closed = false;
    const closing = runtime.dispose();
    expect(runtime.dispose()).toBe(closing);
    void closing.then(() => {
      closed = true;
    });
    await flushPromises();
    expect(closed).toBe(false);
    token.resolve('late-streams-token');
    await Promise.all([attaching, closing]);
    expect(closed).toBe(true);
    expect(cloudAttachCalls()).toEqual([]);
    expect(window.repo).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('acquires fresh Meta after sign-out retires an in-flight join', async () => {
    const entered = Promise.withResolvers<void>();
    const joining = Promise.withResolvers<ReturnType<typeof createMetaSub>>();
    let retired = false;
    const oldSub = createMetaSub(Promise.resolve());
    oldSub.unsubscribe.mockImplementation(() => {
      retired = true;
    });
    let fresh = false;
    mocks.joinMetaRoom
      .mockImplementationOnce(() => {
        entered.resolve();
        return joining.promise;
      })
      .mockImplementationOnce(async () => {
        fresh = true;
        return createMetaSub(Promise.resolve());
      });
    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
    });
    const first = runtime.setAuthToken('auth-one');
    await entered.promise;
    await runtime.setAuthToken(null);
    const second = runtime.setAuthToken('auth-two');
    joining.resolve(oldSub);
    await Promise.all([first, second]);
    expect(retired).toBe(true);
    expect(fresh).toBe(true);
    await runtime.dispose();
  });

  it('retires a late Meta join before the repo is destroyed', async () => {
    const entered = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<ReturnType<typeof createMetaSub>>();
    mocks.joinMetaRoom.mockImplementationOnce(() => {
      entered.resolve();
      return joined.promise;
    });
    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
    });
    const attaching = runtime.setAuthToken('auth-token');
    await entered.promise;
    let subscribed = true;
    const sub = createMetaSub(Promise.resolve());
    sub.unsubscribe.mockImplementation(() => {
      subscribed = false;
    });
    const closing = runtime.dispose();
    await flushPromises();
    expect(subscribed).toBe(true);
    joined.resolve(sub);
    await Promise.all([attaching, closing]);
    expect(subscribed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels startup and joins an uninterruptible local attach before cleanup finishes', async () => {
    enableElectronLocalDataPlane();
    const entered = Promise.withResolvers<void>();
    const attached = Promise.withResolvers<void>();
    const registered = new Set<string>();
    mocks.addTransport.mockImplementationOnce(async (id) => {
      registered.add(id);
      entered.resolve();
      await attached.promise;
    });
    mocks.removeTransport.mockImplementation(async (id) => {
      registered.delete(id);
    });
    const controller = new AbortController();
    const creating = createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      syncMode: 'local',
      signal: controller.signal,
    });
    const result = expect(creating).rejects.toThrow();
    await entered.promise;
    controller.abort();
    await flushPromises();
    attached.resolve();
    await result;
    expect(registered.size).toBe(0);
    expect(window.repo).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reopens unsent local edits after closing an offline runtime with a real repo', async () => {
    vi.useRealTimers();
    const { indexedDB, IDBKeyRange } = await import('fake-indexeddb');
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    const { LoroRepo: RealRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
    const { IndexedDBStorageAdaptor } = await vi.importActual<
      typeof import('loro-repo/storage/indexeddb')
    >('loro-repo/storage/indexeddb');
    const dbName = 'p04-offline-close';
    const open = () =>
      RealRepo.create({
        storageAdapter: new IndexedDBStorageAdaptor({ dbName }),
        metaDebounceCommitMs: 0,
      });
    const repo = await open();
    mocks.repoOverride = repo;
    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
    });
    const handle = await repo.openPersistedDoc('offline-doc');
    handle.doc.getText('text').insert(0, 'unsent local draft');
    handle.doc.commit();
    // No explicit flush, transport, or remote acknowledgement before close.
    await runtime.dispose();
    const reopened = await open();
    try {
      const restored = await reopened.openPersistedDoc('offline-doc');
      expect(restored.doc.getText('text').toString()).toBe('unsent local draft');
    } finally {
      await reopened.destroy();
    }
  });

  it('binds every persistent runtime cache to the same window identity', () => {
    const workspaceId = 'workspace-1' as WorkspaceId;

    expect(resolveWorkspaceRuntimeCacheIdentity(workspaceId, '')).toEqual({
      namespace: 'workspace-1',
      repoDbName: 'lody-loro-repo-db-workspace-1',
      remoteCursorDbName: 'lody-loro-stream-cursors-workspace-1',
    });
    expect(resolveWorkspaceRuntimeCacheIdentity(workspaceId, 'window-2')).toEqual({
      namespace: 'workspace-1:window-2',
      repoDbName: 'lody-loro-repo-db-workspace-1:window-2',
      remoteCursorDbName: 'lody-loro-stream-cursors-workspace-1:window-2',
    });
  });

  it('keeps the runtime and presence alive when joining the meta room fails', async () => {
    mocks.joinMetaRoom.mockRejectedValueOnce(new Error('bootstrap meta timed out'));

    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
    });

    expect(runtime.workspaceId).toBe('workspace-1');
    expect(mocks.presenceStart).toHaveBeenCalledTimes(1);
    expectNoPresenceStopAfterStart();
    // The suspect Meta progress is the replica-bound checkpoint of this window's
    // own meta Flock; the LoroDoc cursor store never holds Meta progress.
    await vi.waitFor(() => expect(mocks.metaCheckpointDelete).toHaveBeenCalledTimes(1));
    expect(mocks.getReplicaCheckpointStore).toHaveBeenCalledWith({
      kind: 'meta',
      flock: mocks.metaFlock,
    });
    expect(mocks.metaCheckpointDelete.mock.calls[0]?.[0]).toMatch(/\/workspace-1%3Ameta$/);
    expect(mocks.remoteCursorDelete).not.toHaveBeenCalled();

    await runtime.dispose();
  });

  const markerKey = `${META_REMOTE_CURSOR_BYPASS_STORAGE_KEY_PREFIX}:workspace-1`;
  const markSuspectMetaCheckpoint = () =>
    window.localStorage.setItem(markerKey, JSON.stringify({ reason: 'previous timeout' }));
  const cloudAttachCalls = () =>
    mocks.addTransport.mock.calls.filter(([transportId]) => transportId === 'cloud');

  const createWebRuntimeWithSuspectMetaCheckpoint = async () => {
    mocks.joinMetaRoom.mockResolvedValue(createMetaSub(Promise.resolve()));
    markSuspectMetaCheckpoint();
    mocks.metaCheckpointDelete.mockRejectedValueOnce(
      new Error('The database connection is closing.')
    );
    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
    });
    // Resuming from the undeleted checkpoint could skip Meta history for good.
    await expect(runtime.setAuthToken('auth-token-1')).rejects.toThrow('connection is closing');
    expect(cloudAttachCalls()).toEqual([]);
    expect(window.localStorage.getItem(markerKey)).not.toBeNull();
    return runtime;
  };

  const expectDeleteThenAttach = () => {
    expect(mocks.metaCheckpointDelete).toHaveBeenCalledTimes(2);
    expect(mocks.metaCheckpointDelete.mock.calls[1]?.[0]).toMatch(/\/workspace-1%3Ameta$/);
    expect(cloudAttachCalls()).toHaveLength(1);
    expect(mocks.metaCheckpointDelete.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.addTransport.mock.invocationCallOrder.at(-1) ?? 0
    );
  };

  it('retries a web attach blocked by a suspect Meta checkpoint when the same token is announced again', async () => {
    const runtime = await createWebRuntimeWithSuspectMetaCheckpoint();

    // No token rotation: the unchanged token alone must retry delete-then-attach.
    await runtime.setAuthToken('auth-token-1');
    await flushPromises();
    await flushPromises();
    expectDeleteThenAttach();
    await flushPromises();
    expect(window.localStorage.getItem(markerKey)).toBeNull();

    await runtime.dispose();
  });

  it('retries a web attach blocked by a suspect Meta checkpoint on its own backoff', async () => {
    const runtime = await createWebRuntimeWithSuspectMetaCheckpoint();

    // No further setAuthToken call at all: only the retry loop's backoff runs.
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expectDeleteThenAttach();
    expect(window.localStorage.getItem(markerKey)).toBeNull();

    await runtime.dispose();
  });

  it('retries a web attach blocked by a suspect Meta checkpoint when the network comes back', async () => {
    const runtime = await createWebRuntimeWithSuspectMetaCheckpoint();

    // No token replay and no backoff wait: the ordinary online edge alone.
    dispatchWindowEvent('online');
    await flushPromises();
    await flushPromises();
    expectDeleteThenAttach();

    await runtime.dispose();
  });

  it('attaches the new token, not the superseded one, when the token rotates during a blocked delete', async () => {
    mocks.joinMetaRoom.mockResolvedValue(createMetaSub(Promise.resolve()));
    markSuspectMetaCheckpoint();
    const blockedDelete = Promise.withResolvers<void>();
    mocks.metaCheckpointDelete.mockImplementationOnce(async () => await blockedDelete.promise);
    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
    });

    const firstToken = runtime.setAuthToken('auth-token-1');
    await vi.waitFor(() => expect(mocks.metaCheckpointDelete).toHaveBeenCalledTimes(1));
    // The rotation tears down token-1's provider and does not wait for its
    // still-blocked delete: token-2 attaches on its own right away.
    await runtime.setAuthToken('auth-token-2');
    expect(mocks.tokenProviderInvalidate).toHaveBeenCalled();
    expect(cloudAttachCalls()).toHaveLength(1);
    expect(mocks.metaCheckpointDelete).toHaveBeenCalledTimes(2);

    blockedDelete.resolve();
    await firstToken;
    await flushPromises();
    // The superseded attach publishes nothing when it finally unblocks.
    expect(cloudAttachCalls()).toHaveLength(1);
    await expect(runtime.ensureDocStream('session-after-rotation')).resolves.toBeUndefined();

    await runtime.dispose();
  });

  it.each(['dispose', 'sign-out'] as const)(
    'does not attach once the runtime is torn down (%s) during a blocked delete',
    async (teardown) => {
      mocks.joinMetaRoom.mockResolvedValue(createMetaSub(Promise.resolve()));
      markSuspectMetaCheckpoint();
      const blockedDelete = Promise.withResolvers<void>();
      mocks.metaCheckpointDelete.mockImplementationOnce(async () => await blockedDelete.promise);
      const runtime = await createWorkspaceRuntime({
        workspaceSlug: 'workspace',
        workspaceId: 'workspace-1' as WorkspaceId,
        apiBaseUrl: 'https://api.example.test',
      });

      const attach = runtime.setAuthToken('auth-token-1');
      await vi.waitFor(() => expect(mocks.metaCheckpointDelete).toHaveBeenCalledTimes(1));
      const closing = teardown === 'dispose' ? runtime.dispose() : runtime.setAuthToken(null);
      await flushPromises();
      blockedDelete.resolve();
      await closing;
      await attach;
      await flushPromises();
      // Nothing built from the old credentials may reach the repo afterwards:
      // no cloud transport, no Meta join, and no retry wakes up later.
      await vi.advanceTimersByTimeAsync(120_000);

      expect(cloudAttachCalls()).toEqual([]);
      expect(mocks.joinMetaRoom).not.toHaveBeenCalled();
      expect(mocks.metaCheckpointDelete).toHaveBeenCalledTimes(1);
      if (teardown === 'sign-out') {
        await runtime.dispose();
      }
    }
  );

  const cloudRemovals = () =>
    mocks.removeTransport.mock.calls.filter(([transportId]) => transportId === 'cloud');

  it.each(['dispose', 'sign-out'] as const)(
    'removes an in-flight web transport before %s returns',
    async (teardown) => {
      mocks.joinMetaRoom.mockResolvedValue(createMetaSub(Promise.resolve()));
      markSuspectMetaCheckpoint();
      // loro-repo registers the transport when addTransport starts; the promise
      // resolves only after routing live rooms, which is held here.
      const blockedAdd = Promise.withResolvers<void>();
      mocks.addTransport.mockImplementationOnce(async () => await blockedAdd.promise);
      const runtime = await createWorkspaceRuntime({
        workspaceSlug: 'workspace',
        workspaceId: 'workspace-1' as WorkspaceId,
        apiBaseUrl: 'https://api.example.test',
      });

      const attach = runtime.setAuthToken('auth-token-1');
      await vi.waitFor(() => expect(cloudAttachCalls()).toHaveLength(1));
      const closing = teardown === 'dispose' ? runtime.dispose() : runtime.setAuthToken(null);
      await vi.waitFor(() => expect(cloudRemovals()).toHaveLength(1));
      // Unregistered before the raw SDK add ends; disposal also joins that add.
      blockedAdd.resolve();
      await closing;
      await attach;
      await flushPromises();
      await vi.advanceTimersByTimeAsync(120_000);
      // The late add neither re-removes nor joins, retries or clears the marker.
      expect(cloudRemovals()).toHaveLength(1);
      expect(mocks.joinMetaRoom).not.toHaveBeenCalled();
      expect(cloudAttachCalls()).toHaveLength(1);
      expect(window.localStorage.getItem(markerKey)).not.toBeNull();
      if (teardown === 'sign-out') {
        await runtime.dispose();
      }
    }
  );

  it("does not remove the next token's transport when a superseded add finishes late", async () => {
    mocks.joinMetaRoom.mockResolvedValue(createMetaSub(Promise.resolve()));
    const blockedAdd = Promise.withResolvers<void>();
    mocks.addTransport.mockImplementationOnce(async () => await blockedAdd.promise);
    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
    });

    const firstToken = runtime.setAuthToken('auth-token-1');
    await vi.waitFor(() => expect(cloudAttachCalls()).toHaveLength(1));
    await runtime.setAuthToken('auth-token-2');
    // Token-1's transport was removed before token-2's was added.
    expect(cloudRemovals()).toHaveLength(1);
    expect(cloudAttachCalls()).toHaveLength(2);
    expect(mocks.removeTransport.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mocks.addTransport.mock.invocationCallOrder.at(-1) ?? 0
    );

    blockedAdd.resolve();
    await firstToken;
    await flushPromises();
    expect(cloudRemovals()).toHaveLength(1);
    await expect(runtime.ensureDocStream('session-after-rotation')).resolves.toBeUndefined();

    await runtime.dispose();
  });

  it('still removes a later in-flight add after an older superseded add finishes first', async () => {
    mocks.joinMetaRoom.mockResolvedValue(createMetaSub(Promise.resolve()));
    markSuspectMetaCheckpoint();
    const firstAdd = Promise.withResolvers<void>();
    const secondAdd = Promise.withResolvers<void>();
    mocks.addTransport
      .mockImplementationOnce(async () => await firstAdd.promise)
      .mockImplementationOnce(async () => await secondAdd.promise);
    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
    });

    const firstToken = runtime.setAuthToken('auth-token-1');
    await vi.waitFor(() => expect(cloudAttachCalls()).toHaveLength(1));
    const secondToken = runtime.setAuthToken('auth-token-2');
    await vi.waitFor(() => expect(cloudAttachCalls()).toHaveLength(2));
    expect(cloudRemovals()).toHaveLength(1);

    // The older add finishing must not hide that token-2's add is still live.
    firstAdd.resolve();
    await firstToken;
    await runtime.setAuthToken(null);
    expect(cloudRemovals()).toHaveLength(2);

    secondAdd.resolve();
    await secondToken;
    await flushPromises();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(cloudRemovals()).toHaveLength(2);
    expect(cloudAttachCalls()).toHaveLength(2);
    expect(mocks.joinMetaRoom).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(markerKey)).not.toBeNull();

    await runtime.dispose();
  });

  it.each(['delete', 'add'] as const)(
    'ignores a superseded attach whose %s fails after the next token attached',
    async (stage) => {
      mocks.joinMetaRoom.mockResolvedValue(createMetaSub(Promise.resolve()));
      markSuspectMetaCheckpoint();
      const blocked = Promise.withResolvers<void>();
      if (stage === 'delete') {
        mocks.metaCheckpointDelete.mockImplementationOnce(async () => await blocked.promise);
      } else {
        mocks.addTransport.mockImplementationOnce(async () => await blocked.promise);
      }
      const runtime = await createWorkspaceRuntime({
        workspaceSlug: 'workspace',
        workspaceId: 'workspace-1' as WorkspaceId,
        apiBaseUrl: 'https://api.example.test',
      });

      const firstToken = runtime.setAuthToken('auth-token-1');
      await vi.waitFor(() =>
        expect(
          stage === 'delete' ? mocks.metaCheckpointDelete.mock.calls : cloudAttachCalls()
        ).toHaveLength(1)
      );
      await runtime.setAuthToken('auth-token-2');
      const attachedCloudCalls = cloudAttachCalls().length;
      const presenceStops = mocks.presenceStop.mock.calls.length;
      const deletes = mocks.metaCheckpointDelete.mock.calls.length;

      // Token-1's stuck step now fails with an ordinary error.
      blocked.reject(new Error('The database connection is closing.'));
      await firstToken;
      await flushPromises();
      await vi.advanceTimersByTimeAsync(120_000);

      // It must not stop token-2's presence, nor schedule a retry for itself.
      expect(mocks.presenceStop.mock.calls.length).toBe(presenceStops);
      expect(mocks.metaCheckpointDelete.mock.calls.length).toBe(deletes);
      expect(cloudAttachCalls()).toHaveLength(attachedCloudCalls);
      await expect(runtime.ensureDocStream('session-after-rotation')).resolves.toBeUndefined();

      await runtime.dispose();
    }
  );

  it('does not start a retry attach while a token-change teardown is still running', async () => {
    mocks.joinMetaRoom.mockResolvedValue(createMetaSub(Promise.resolve()));
    markSuspectMetaCheckpoint();
    mocks.metaCheckpointDelete.mockRejectedValueOnce(
      new Error('The database connection is closing.')
    );
    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
    });
    // Token-1's attach fails and leaves a pending retry; stay offline so it
    // does not run on its own.
    (navigator as { onLine: boolean }).onLine = false;
    await expect(runtime.setAuthToken('auth-token-1')).rejects.toThrow('connection is closing');

    // Token-2's teardown is held inside its first await (presence stop).
    const heldStop = Promise.withResolvers<void>();
    mocks.presenceStop.mockImplementationOnce(async () => await heldStop.promise);
    const heldAdd = Promise.withResolvers<void>();
    mocks.addTransport.mockImplementationOnce(async () => await heldAdd.promise);
    const secondToken = runtime.setAuthToken('auth-token-2');
    await flushPromises();

    // A wake edge during that window must not start an attach on the provider
    // the teardown is about to invalidate.
    (navigator as { onLine: boolean }).onLine = true;
    dispatchWindowEvent('online');
    await flushPromises();
    expect(cloudAttachCalls()).toEqual([]);

    heldStop.resolve();
    await vi.waitFor(() => expect(cloudAttachCalls()).toHaveLength(1));
    heldAdd.resolve();
    await secondToken;
    await flushPromises();

    expect(cloudAttachCalls()).toHaveLength(1);
    await expect(runtime.ensureDocStream('session-after-rotation')).resolves.toBeUndefined();

    await runtime.dispose();
  });

  it('stops a pending web attach retry when the runtime is disposed', async () => {
    const runtime = await createWebRuntimeWithSuspectMetaCheckpoint();

    // The failed attach armed a retry wait; dispose must cancel it, not leave a
    // timer that later wakes a torn-down runtime.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await runtime.dispose();
    // Drain v4 completion notifications before counting remaining retry timers.
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.metaCheckpointDelete).toHaveBeenCalledTimes(1);
    expect(cloudAttachCalls()).toEqual([]);
  });

  it('does not attach the cloud plane in dual mode until a suspect Meta checkpoint is really deleted', async () => {
    mocks.joinMetaRoom.mockResolvedValue(createMetaSub(Promise.resolve()));
    enableElectronLocalDataPlane();
    markSuspectMetaCheckpoint();
    mocks.metaCheckpointDelete.mockRejectedValueOnce(
      new Error('The database connection is closing.')
    );
    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
    });

    await expect(runtime.setAuthToken('auth-token')).rejects.toThrow('connection is closing');
    expect(cloudAttachCalls()).toEqual([]);
    expect(window.localStorage.getItem(markerKey)).not.toBeNull();

    // Same path as the cloud reconnect loop: attach while not attached.
    await runtime.setAuthToken('auth-token');
    expect(mocks.metaCheckpointDelete).toHaveBeenCalledTimes(2);
    expect(cloudAttachCalls()).toHaveLength(1);
    expect(mocks.metaCheckpointDelete.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.addTransport.mock.invocationCallOrder.at(-1) ?? 0
    );
    // The local Meta binding synced long before; only the cloud binding's first
    // sync after the delete ends the episode. A kept marker would delete the
    // then-valid cloud checkpoint again on every later attach.
    await flushPromises();
    expect(window.localStorage.getItem(markerKey)).toBeNull();

    await runtime.dispose();
  });

  it('does not let a replaced cloud Meta session clear the marker in dual mode', async () => {
    const cloudFirstSync = Promise.withResolvers<void>();
    const metaSub = createMetaSub(Promise.resolve());
    const bindingFor = metaSub.subscription;
    metaSub.subscription = vi.fn((transportId: string) => {
      const binding = bindingFor(transportId) as object;
      return transportId === 'cloud'
        ? { ...binding, firstSyncedWithRemote: cloudFirstSync.promise }
        : binding;
    });
    mocks.joinMetaRoom.mockResolvedValue(metaSub);
    enableElectronLocalDataPlane();
    markSuspectMetaCheckpoint();
    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
    });

    await runtime.setAuthToken('auth-token');
    expect(mocks.metaCheckpointDelete).toHaveBeenCalledTimes(1);
    expect(cloudAttachCalls()).toHaveLength(1);

    // That cloud session goes away before its first sync, and the next attach
    // cannot delete the checkpoint yet.
    await runtime.setAuthToken(null);
    mocks.metaCheckpointDelete.mockRejectedValueOnce(
      new Error('The database connection is closing.')
    );
    await expect(runtime.setAuthToken('auth-token')).rejects.toThrow('connection is closing');

    cloudFirstSync.resolve();
    await flushPromises();
    expect(window.localStorage.getItem(markerKey)).not.toBeNull();

    await runtime.dispose();
  });

  it('keeps repeated token rotations inside one backoff-controlled meta recovery episode', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const analyticsEvents: Array<{
      name: string;
      properties?: Record<string, unknown>;
    }> = [];
    mocks.joinMetaRoom.mockRejectedValue(new Error('transport connection failed'));

    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      onAnalyticsEvent: (event) => analyticsEvents.push(event),
    });

    // Reproduce the field incident without manufacturing an 800ms token loop:
    // seven genuinely different auth tokens arrive over roughly two minutes
    // while every meta-room join fails immediately with a transport error.
    // A token may prompt one immediate recovery, but it must not turn the same
    // outage back into a fresh initial-sync episode or forgive accumulated
    // retry history.
    for (let index = 0; index < 7; index += 1) {
      await runtime.setAuthToken(`auth-token-${index}`);
      await flushPromises();
      if (index < 6) {
        await vi.advanceTimersByTimeAsync(17_000);
      }
    }
    await vi.advanceTimersByTimeAsync(18_000);
    await flushPromises();

    await runtime.dispose();
    random.mockRestore();

    const metaSyncFailures = analyticsEvents.filter(
      (event) => event.name === 'workspace/meta_sync_failed'
    );
    const initialFailures = metaSyncFailures.filter(
      (event) => event.properties?.phase === 'initial'
    );

    // One outage has one initial attempt. Everything after it is recovery,
    // including retries prompted by a newly issued credential.
    expect.soft(initialFailures).toHaveLength(1);
    // With a 30s capped exponential backoff, seven external credential edges
    // plus scheduled recovery cannot legitimately produce hundreds of joins
    // in this two-minute window. Keep this assertion generous enough for
    // jitter and boundary-aligned timers while still catching a reset storm.
    expect(metaSyncFailures.length).toBeLessThanOrEqual(20);
  });

  it('shares an in-flight meta join across overlapping token rotations', async () => {
    let resolveMetaJoin!: (sub: FakeMetaSub) => void;
    const pendingMetaJoin = new Promise<FakeMetaSub>((resolve) => {
      resolveMetaJoin = resolve;
    });
    mocks.joinMetaRoom.mockReturnValue(pendingMetaJoin);

    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
    });

    const initialAttach = runtime.setAuthToken('auth-token-1');
    await vi.waitFor(() => expect(mocks.joinMetaRoom).toHaveBeenCalledTimes(1));

    const overlappingRotation = runtime.setAuthToken('auth-token-2');
    await flushPromises();
    expect(mocks.joinMetaRoom).toHaveBeenCalledTimes(1);

    resolveMetaJoin(createMetaSub(Promise.resolve()));
    await Promise.all([initialAttach, overlappingRotation]);
    await flushPromises();

    expect(mocks.joinMetaRoom).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it('reports first-sync failures after a rejoin as recovery', async () => {
    let rejectInitialSync!: (error: Error) => void;
    let rejectRecoverySync!: (error: Error) => void;
    const initialSync = new Promise<void>((_resolve, reject) => {
      rejectInitialSync = reject;
    });
    const recoverySync = new Promise<void>((_resolve, reject) => {
      rejectRecoverySync = reject;
    });
    const analyticsEvents: Array<{
      name: string;
      properties?: Record<string, unknown>;
    }> = [];
    mocks.joinMetaRoom
      .mockResolvedValueOnce(createMetaSub(initialSync))
      .mockResolvedValueOnce(createMetaSub(recoverySync));

    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
      onAnalyticsEvent: (event) => analyticsEvents.push(event),
    });

    rejectInitialSync(new Error('initial transport failure'));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    expect(mocks.joinMetaRoom).toHaveBeenCalledTimes(2);

    rejectRecoverySync(new Error('recovery transport failure'));
    await flushPromises();

    const failurePhases = analyticsEvents
      .filter((event) => event.name === 'workspace/meta_sync_failed')
      .map((event) => event.properties?.phase);
    expect(failurePhases).toEqual(['initial', 'recovery']);

    await runtime.dispose();
  });

  it.each([false, true])(
    'gates operation snapshots on the selected metadata source (local: %s)',
    async (local) => {
      const synced = Promise.withResolvers<void>();
      mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(synced.promise));
      if (local) {
        enableElectronLocalDataPlane();
        vi.stubGlobal('navigator', { onLine: false });
      }
      const id = 'source-root' as SessionId;
      mocks.listDoc.mockResolvedValue([
        { docId: getSessionRoomId(id), meta: { id }, exists: true },
      ]);
      const runtime = await createWorkspaceRuntime({
        workspaceSlug: 'workspace',
        workspaceId: 'workspace-1' as WorkspaceId,
        apiBaseUrl: 'https://api.example.test',
        token: 'auth-token',
      });
      try {
        for (const operation of ['archive', 'restore', 'delete'] as const) {
          await expect(runtime.readSessionOperationTargets(id, operation)).rejects.toThrow(
            'Session metadata is still loading'
          );
        }
        synced.resolve();
        await flushPromises();
        for (const operation of ['archive', 'restore', 'delete'] as const) {
          await expect(runtime.readSessionOperationTargets(id, operation)).resolves.toEqual([
            { id },
          ]);
        }
        if (local) expect(mocks.streamsTransportConstructors).not.toHaveBeenCalled();
      } finally {
        await runtime.dispose();
      }
      await expect(runtime.readSessionOperationTargets(id, 'archive')).rejects.toThrow(
        'Runtime disposed'
      );
    }
  );

  it('rejects a snapshot if its runtime is disposed while the query is pending', async () => {
    mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));
    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
    });
    await flushPromises();
    const query = Promise.withResolvers<Awaited<ReturnType<LoroRepo['listDoc']>>>();
    mocks.listDoc.mockReturnValueOnce(query.promise);
    const id = 'disposed-root' as SessionId;
    const result = runtime.readSessionOperationTargets(id, 'archive');
    const rejected = expect(result).rejects.toThrow('Runtime disposed');
    await runtime.dispose();
    query.resolve([{ docId: getSessionRoomId(id), meta: { id }, exists: true }]);
    await rejected;
  });

  it('delays ACP capability refresh until meta and presence stay synced', async () => {
    mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));

    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
    });

    await flushPromises();
    expect(mocks.startupAcpCapabilitiesRefresh).not.toHaveBeenCalled();

    publishPresenceSyncState('synced');
    await flushPromises();
    expect(mocks.startupCapabilityCooldowns).toHaveLength(1);
    expect(mocks.startupAcpCapabilitiesRefresh).not.toHaveBeenCalled();

    publishPresenceSyncState('disconnected');
    mocks.startupCapabilityCooldowns[0]?.run();
    await flushPromises();
    expect(mocks.startupAcpCapabilitiesRefresh).not.toHaveBeenCalled();

    publishPresenceSyncState('synced');
    expect(mocks.startupCapabilityCooldowns).toHaveLength(2);
    mocks.startupCapabilityCooldowns[1]?.run();
    await flushPromises();
    expect(mocks.startupAcpCapabilitiesRefresh).toHaveBeenCalledTimes(1);

    await runtime.dispose();
  });

  it('retries the startup capability pass after an in-flight presence disconnect', async () => {
    mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    mocks.startupAcpCapabilitiesRefresh.mockImplementationOnce(async (_ports, options) => {
      markFirstStarted();
      await new Promise<void>((resolve) => {
        const signal = options?.signal;
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
    });

    await flushPromises();
    publishPresenceSyncState('synced');
    mocks.startupCapabilityCooldowns[0]?.run();
    await firstStarted;
    expect(mocks.startupAcpCapabilitiesRefresh).toHaveBeenCalledTimes(1);

    publishPresenceSyncState('disconnected');
    // Re-sync before the aborted pass's finally runs. The synced callback is
    // initially blocked by the old in-flight controller; its finalizer must
    // schedule the replacement pass.
    publishPresenceSyncState('synced');
    await flushPromises();

    expect(mocks.startupCapabilityCooldowns).toHaveLength(2);
    mocks.startupCapabilityCooldowns[1]?.run();
    await flushPromises();
    expect(mocks.startupAcpCapabilitiesRefresh).toHaveBeenCalledTimes(2);

    await runtime.dispose();
  });

  it('intersects startup capability candidates with the visible-machine snapshot', async () => {
    mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));
    mocks.listDoc.mockResolvedValueOnce([
      { docId: 'machine-visible', meta: {}, exists: true },
      { docId: 'machine-hidden', meta: {}, exists: true },
    ]);
    let candidates: MachineId[] = [];
    mocks.startupAcpCapabilitiesRefresh.mockImplementationOnce(async (ports) => {
      candidates = await ports.listMachineIds();
    });

    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
      getAuthorizedMachineIds: () => new Set(['visible' as MachineId]),
    });

    await flushPromises();
    publishPresenceSyncState('synced');
    mocks.startupCapabilityCooldowns.at(-1)?.run();
    await flushPromises();

    expect(candidates).toEqual(['visible']);
    await runtime.dispose();
  });

  it('takes startup capability candidates from the ready doc-meta projection', async () => {
    mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));
    mocks.listDoc.mockResolvedValue([{ docId: 'machine-scanned', meta: {}, exists: true }]);
    let candidates: MachineId[] = [];
    mocks.startupAcpCapabilitiesRefresh.mockImplementationOnce(async (ports) => {
      candidates = await ports.listMachineIds();
    });

    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
      getAuthorizedMachineIds: () => new Set(['cached', 'scanned'] as MachineId[]),
      readDocMetaCache: (repo) =>
        repo === runtime.repo
          ? { sessions: {}, machines: { 'machine-cached': { name: 'cached' } } }
          : null,
    });

    await flushPromises();
    publishPresenceSyncState('synced');
    mocks.startupCapabilityCooldowns.at(-1)?.run();
    await flushPromises();

    expect(candidates).toEqual(['cached']);
    await runtime.dispose();
  });

  it('uses the Electron local data plane without attaching Loro Streams', async () => {
    mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));
    enableElectronLocalDataPlane();

    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
    });

    expect(mocks.streamsTransportConstructors).not.toHaveBeenCalled();
    expect(mocks.presenceStart).not.toHaveBeenCalled();
    expect(mocks.addTransport).toHaveBeenCalledTimes(1);
    expect(mocks.addTransport).toHaveBeenCalledWith('local', expect.anything());
    expect(mocks.joinMetaRoom).toHaveBeenCalledTimes(1);

    await runtime.dispose();
  });

  it('reuses a machine capability read across local file previews', async () => {
    mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));
    const machineId = 'local-machine' as MachineId;
    const preview = {
      status: 'error' as const,
      code: 'file_not_found' as const,
      message: 'synthetic missing file',
      path: 'notes.md',
      retryable: false,
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'loro.isConnected') return true;
      if (channel === 'machineRpc.previewFile') return preview;
      return undefined;
    });
    Object.assign(window, {
      __LODY_ELECTRON__: true,
      ipc: {
        invoke,
        on: vi.fn(() => () => {}),
        send: vi.fn(),
      },
    });
    mocks.getDocMeta.mockImplementation(async (docId) =>
      docId === getMachineRoomId(machineId)
        ? { meta: { protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES } }
        : undefined
    );

    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      syncMode: 'local',
    });

    await expect(
      runtime.requestFilePreview(machineId, {
        sessionId: 'session-1' as SessionId,
        path: 'notes.md',
      })
    ).resolves.toMatchObject({ status: 'error', code: 'file_not_found' });
    await expect(
      runtime.requestFilePreview(machineId, {
        sessionId: 'session-1' as SessionId,
        path: 'other.md',
      })
    ).resolves.toMatchObject({ status: 'error', code: 'file_not_found' });

    expect(mocks.getDocMeta).toHaveBeenCalledTimes(1);
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'machineRpc.previewFile')
    ).toHaveLength(2);
    await runtime.dispose();
  });

  it('hot-attaches one cloud plane on auth without touching the local plane', async () => {
    mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));
    enableElectronLocalDataPlane();

    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
    });
    runtime.setLocalMachineId('local-machine' as MachineId);

    expect(mocks.streamsTransportConstructors).not.toHaveBeenCalled();

    await Promise.all([runtime.setAuthToken('auth-token'), runtime.setAuthToken('auth-token')]);
    const response = await runtime.requestCodeCollabOpenTurnDiff('remote-machine' as MachineId, {
      sessionId: 'session-1' as SessionId,
      turnId: 'turn-1',
      path: 'src/index.ts',
    });

    expect(response).toEqual({ status: 'ok' });
    expect(mocks.streamsTransportConstructors).toHaveBeenCalledTimes(1);
    expect(mocks.machineRpcConstructors).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        machineId: 'remote-machine',
      })
    );
    expect(mocks.machineRpcOpenTurnDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        turnId: 'turn-1',
        path: 'src/index.ts',
      })
    );

    await runtime.dispose();
  });

  it('waits for an in-flight cloud member attach before destroying the runtime', async () => {
    mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));
    enableElectronLocalDataPlane();
    let resolveConnect: (() => void) | null = null;
    mocks.streamsConnect.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          resolveConnect = resolve;
        })
    );

    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
    });
    const attachPromise = runtime.setAuthToken('auth-token');
    await flushPromises();
    expect(resolveConnect).not.toBeNull();

    const disposePromise = runtime.dispose();
    await flushPromises();
    expect(mocks.destroy).not.toHaveBeenCalled();

    resolveConnect?.();
    await Promise.all([attachPromise, disposePromise]);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it('attaches the cloud plane after an offline Electron startup comes online', async () => {
    mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));
    enableElectronLocalDataPlane();
    Object.assign(navigator, { onLine: false });

    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
    });
    await runtime.setAuthToken('auth-token');
    expect(mocks.streamsTransportConstructors).not.toHaveBeenCalled();

    Object.assign(navigator, { onLine: true });
    dispatchWindowEvent('online');
    await flushPromises();

    expect(mocks.streamsTransportConstructors).toHaveBeenCalledTimes(1);
    expect(mocks.reconnect).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it.each([
    { retry: false, outcome: 'resolve' },
    { retry: false, outcome: 'reject' },
    { retry: true, outcome: 'resolve' },
    { retry: true, outcome: 'reject' },
  ] as const)(
    'joins original cloud rejoin tasks before real Repo destruction (retry=$retry, $outcome)',
    async ({ retry, outcome }) => {
      const { LoroRepo: RealRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
      const repo = await RealRepo.create({
        metaDebounceCommitMs: 0,
        resolveRoomTransports: () => ({
          transportIds: ['local', 'cloud'],
          readinessTransportId: 'local',
        }),
      });
      const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      const active = new Set<number>();
      let attempts = 0;
      let cloudStatus: TransportSubscription['status'] = 'joined';
      let destroyed = false;
      const activeAtDestroy: number[] = [];
      const subscription = (cloudDoc: boolean): TransportSubscription => ({
        get status() {
          return cloudDoc ? cloudStatus : 'joined';
        },
        firstSyncedWithRemote: Promise.resolve(),
        onStatusChange: () => () => {},
        unsubscribe: () => {},
        waitUntilSynced: async () => {},
        rejoin: async () => {
          if (!cloudDoc) return;
          const attempt = attempts++;
          active.add(attempt);
          entered[attempt]!.resolve();
          try {
            await gates[attempt]!.promise;
          } finally {
            active.delete(attempt);
          }
        },
      });
      const adapter = (cloud: boolean): TransportAdapter => ({
        connect: async () => {},
        close: async () => {},
        isConnected: () => true,
        getStatus: () => 'connected',
        onStatusChange: () => () => {},
        reconnect: async () => {},
        syncMeta: async () => ({ ok: true }),
        syncDoc: async () => ({ ok: true }),
        joinMetaRoom: () => subscription(false),
        joinDocRoom: () => subscription(cloud),
      });
      const add = repo.addTransport.bind(repo);
      vi.spyOn(repo, 'addTransport').mockImplementation((id, _adapter, options) =>
        add(id, adapter(id === 'cloud'), options)
      );
      const destroy = repo.destroy.bind(repo);
      vi.spyOn(repo, 'destroy').mockImplementation(async () => {
        activeAtDestroy.push(...active);
        await destroy();
        destroyed = true;
      });
      mocks.repoOverride = repo;
      enableElectronLocalDataPlane();
      const runtime = await createWorkspaceRuntime({
        workspaceSlug: 'workspace',
        workspaceId: 'workspace-1' as WorkspaceId,
        apiBaseUrl: 'https://api.example.test',
        syncMode: 'dual',
      });
      runtime.setLocalMachineId('local-machine' as MachineId);
      await runtime.setAuthToken('token');
      const lease = await repo.joinDocRoom('machine-local-machine');
      let closing: Promise<void> | undefined;
      let closed = false;
      try {
        cloudStatus = 'error';
        dispatchWindowEvent('online');
        await entered[0].promise;
        if (retry) {
          // The existing timeout must still release the running retry loop.
          // A new pass can start while the previous raw SDK task is pending.
          await vi.advanceTimersByTimeAsync(10_000);
          dispatchWindowEvent('online');
          await entered[1].promise;
          expect([...active]).toEqual([0, 1]);
        }
        closing = runtime.dispose();
        expect(runtime.dispose()).toBe(closing);
        void closing.then(() => {
          closed = true;
        });
        await vi.advanceTimersByTimeAsync(10_000);
        expect({ closed, destroyed }).toEqual({ closed: false, destroyed: false });

        // Resolve the newest attempt first: closing must still retain older
        // timed-out work. A rejection must neither escape nor end close early.
        const last = retry ? 1 : 0;
        if (outcome === 'reject') gates[last]!.reject(new Error('late rejoin failed'));
        else gates[last]!.resolve();
        await vi.advanceTimersByTimeAsync(0);
        if (retry) {
          expect([...active]).toEqual([0]);
          expect({ closed, destroyed }).toEqual({ closed: false, destroyed: false });
          gates[0].resolve();
        }
        await closing;
        expect({ closed, destroyed, activeAtDestroy }).toEqual({
          closed: true,
          destroyed: true,
          activeAtDestroy: [],
        });
        expect(runtime.dispose()).toBe(closing);
        dispatchWindowEvent('online');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(active.size).toBe(0);
        expect(attempts).toBe(retry ? 2 : 1);
      } finally {
        for (const gate of gates) gate.resolve();
        lease.unsubscribe();
        await (closing ?? runtime.dispose());
      }
    }
  );

  it('repairs a dual-homed room whose cloud binding failed (invisible to trackers)', async () => {
    // The regression this pins: a dual-homed room's cloud subscription failing
    // while the local plane stays healthy produced no signal anywhere and the
    // pending renderer-authored ops sat local-only. The repair loop must
    // discover it via repo.transportRooms('cloud') and reconnect that plane.
    mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));
    enableElectronLocalDataPlane();
    Object.assign(navigator, { onLine: true });

    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
    });
    // A dual-homed room needs resolved LOCAL ownership: the scan deliberately
    // skips cloud-readiness rooms (their binding is already registry-tracked).
    runtime.setLocalMachineId('local-machine' as MachineId);
    await runtime.setAuthToken('auth-token');
    await flushPromises();
    expect(mocks.streamsTransportConstructors).toHaveBeenCalledTimes(1);
    mocks.reconnect.mockClear();

    // A detached binding is deliberate absence — never a repair trigger.
    mocks.transportRooms.mockReturnValue([
      {
        room: { kind: 'doc', id: 'machine-local-machine' },
        subscription: { status: 'detached', rejoin: vi.fn(async () => {}) },
      },
    ]);
    await vi.advanceTimersByTimeAsync(120_000);
    await flushPromises();
    expect(mocks.reconnect).not.toHaveBeenCalled();

    const brokenRejoin = vi.fn(async () => {});
    mocks.transportRooms.mockReturnValue([
      {
        room: { kind: 'doc', id: 'machine-local-machine' },
        subscription: { status: 'error', rejoin: brokenRejoin },
      },
    ]);
    await vi.advanceTimersByTimeAsync(120_000);
    await flushPromises();
    expect(mocks.reconnect).toHaveBeenCalledWith({ transportIds: ['cloud'], resetBackoff: true });
    // A failed loro-repo-level attach is only repaired by the per-room rejoin.
    expect(brokenRejoin).toHaveBeenCalled();

    mocks.transportRooms.mockReturnValue([]);
    await runtime.dispose();
  });

  it('does not restart presence during durable meta sync recovery', async () => {
    const neverSynced = new Promise<void>(() => {});
    mocks.joinMetaRoom
      .mockResolvedValueOnce(createMetaSub(neverSynced))
      .mockResolvedValueOnce(createMetaSub(Promise.resolve()));

    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
    });

    expect(mocks.presenceStart).toHaveBeenCalledTimes(1);
    const presenceStopCallsAfterInitialAttach = mocks.presenceStop.mock.calls.length;

    await vi.advanceTimersByTimeAsync(120_000);
    await flushPromises();
    await vi.runOnlyPendingTimersAsync();
    await flushPromises();

    expect(mocks.joinMetaRoom).toHaveBeenCalledTimes(2);
    expect(mocks.addTransport).toHaveBeenCalledTimes(2);
    expect(mocks.addTransport.mock.calls.every((call) => call[0] === 'cloud')).toBe(true);
    expect(mocks.removeTransport).toHaveBeenCalledWith('cloud', { close: true });
    expect(mocks.presenceStart).toHaveBeenCalledTimes(1);
    expect(mocks.presenceStop).toHaveBeenCalledTimes(presenceStopCallsAfterInitialAttach);
    expectNoPresenceStopAfterStart();

    await runtime.dispose();
  });

  it('keeps the durable transport attached when the auth token rotates', async () => {
    mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));

    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
    });
    await flushPromises();
    publishPresenceSyncState('synced');
    await flushPromises();

    expect(mocks.addTransport).toHaveBeenCalledTimes(1);
    expect(mocks.joinMetaRoom).toHaveBeenCalledTimes(1);
    expect(mocks.presenceStart).toHaveBeenCalledTimes(1);
    const presenceStopCallsAfterInitialAttach = mocks.presenceStop.mock.calls.length;

    await runtime.setAuthToken('rotated-auth-token');
    await flushPromises();

    expect(mocks.addTransport).toHaveBeenCalledTimes(1);
    expect(mocks.joinMetaRoom).toHaveBeenCalledTimes(1);
    expect(mocks.presenceStart).toHaveBeenCalledTimes(1);
    expect(mocks.presenceStop).toHaveBeenCalledTimes(presenceStopCallsAfterInitialAttach);
    expectNoPresenceStopAfterStart();

    await runtime.dispose();
  });

  it('restarts presence on visible wake when the ephemeral stream looks stale', async () => {
    mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));
    mocks.presenceShouldRestartOnExternalWake.mockReturnValue(true);

    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
    });
    await flushPromises();

    expect(mocks.presenceStart).toHaveBeenCalledTimes(1);
    const presenceStopCallsAfterInitialAttach = mocks.presenceStop.mock.calls.length;

    (document as unknown as { visibilityState: DocumentVisibilityState }).visibilityState =
      'hidden';
    dispatchDocumentEvent('visibilitychange');
    await flushPromises();

    expect(mocks.presenceStart).toHaveBeenCalledTimes(1);
    expect(mocks.presenceStop).toHaveBeenCalledTimes(presenceStopCallsAfterInitialAttach);

    (document as unknown as { visibilityState: DocumentVisibilityState }).visibilityState =
      'visible';
    dispatchDocumentEvent('visibilitychange');
    await flushPromises();

    expect(mocks.reconnect).toHaveBeenCalledWith({ resetBackoff: true });
    expect(mocks.presenceShouldRestartOnExternalWake).toHaveBeenCalledTimes(1);
    expect(mocks.presenceStop).toHaveBeenCalledTimes(presenceStopCallsAfterInitialAttach + 1);
    expect(mocks.presenceStart).toHaveBeenCalledTimes(2);

    await runtime.dispose();
  });
  it('gives eager-sync one held auth callback per provider and forwards its context', async () => {
    mocks.joinMetaRoom.mockResolvedValue(createMetaSub(Promise.resolve()));
    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
    });
    const bridge = mocks.eagerSyncDeps.at(-1);
    expect(bridge).toBeDefined();

    // A callback rebuilt per invocation starts with an empty last-token memory
    // and makes the provider return a rejected JWT unchanged, so the bridge has
    // to reuse one callback for the provider's lifetime.
    expect(await bridge?.auth({ reason: 'request' })).toBe('streams-token');
    expect(await bridge?.auth({ reason: 'unauthorized', previousToken: 'jwt-1' })).toBe(
      'streams-token'
    );
    expect(await bridge?.auth({ reason: 'unauthorized' })).toBe('streams-token');
    const callbackIds = new Set(mocks.authInvocations.map((entry) => entry.callbackId));
    expect(callbackIds.size).toBe(1);
    // The context reaches the provider unreduced, `previousToken` included.
    expect(mocks.authInvocations.map((entry) => entry.context)).toEqual([
      { reason: 'request' },
      { reason: 'unauthorized', previousToken: 'jwt-1' },
      { reason: 'unauthorized' },
    ]);

    await runtime.dispose();
  });

  it('rebinds the eager-sync auth callback when the token provider is replaced', async () => {
    mocks.joinMetaRoom.mockResolvedValue(createMetaSub(Promise.resolve()));
    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
    });
    const bridge = mocks.eagerSyncDeps.at(-1);
    await bridge?.auth({ reason: 'request' });
    const firstProvider = mocks.authInvocations.at(-1)?.providerId;

    // Signing out drops the provider; a stale callback must never be served.
    await runtime.setAuthToken(null);
    expect(await bridge?.auth({ reason: 'request' })).toBeUndefined();

    // Signing back in builds a new provider, and the bridge follows it.
    await runtime.setAuthToken('auth-token-2');
    expect(await bridge?.auth({ reason: 'request' })).toBe('streams-token');
    const rebound = mocks.authInvocations.at(-1);
    expect(rebound?.providerId).not.toBe(firstProvider);
    expect(rebound?.callbackId).not.toBe(mocks.authInvocations[0]?.callbackId);

    await runtime.dispose();
  });
});
