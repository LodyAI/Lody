import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLoroStreamsTokenProviderLegacy,
  ScheduleRepository,
  getSessionRoomId,
  type MachineId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo, TransportAdapter, TransportSubscription } from 'loro-repo';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { createE2eeContent } from '../src/providers/desktop-e2ee-content';

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
  const encryptedAcpTransport = {
    handler: null as null | ((request: any, options: any) => Promise<any>),
  };
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
    encryptedAcpTransport,
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

vi.mock('@loro-dev/streams-crdt/loro', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@loro-dev/streams-crdt/loro')>();
  return {
    ...actual,
    StreamsCrdt: class StreamsCrdt {
      createStream = vi.fn(async () => ({ ok: true }));
      close = vi.fn(async () => {});
    },
    // Keep the suggestion owner's real lifecycle and store, but never open a
    // network stream in this Meta recovery fixture.
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

vi.mock('@lody/loro-streams-rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lody/loro-streams-rpc')>()),
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
    createLoroStreamsTokenProviderLegacy: vi.fn((options) => {
      if (mocks.realTokenProvider) return actual.createLoroStreamsTokenProviderLegacy(options);
      const providerId = ++mocks.providerIdentity.providers;
      return {
        getToken: mocks.tokenReady,
        invalidate: mocks.tokenProviderInvalidate,
        close: async () => {},
        retryCleanup: async () => {},
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

vi.mock('../src/providers/encrypted-dispatch-legacy', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/providers/encrypted-dispatch-legacy')>();
  return {
    ...actual,
    createEncryptedDispatchLegacy: (
      options: Parameters<typeof actual.createEncryptedDispatchLegacy>[0]
    ) => {
      if (!mocks.encryptedAcpTransport.handler)
        return actual.createEncryptedDispatchLegacy(options);
      return {
        requestFeature: (request: unknown, requestOptions: unknown) =>
          mocks.encryptedAcpTransport.handler!(request, requestOptions),
        close: async () => {},
      } as ReturnType<typeof actual.createEncryptedDispatchLegacy>;
    },
  };
});

import { createWorkspaceRuntime } from '../src/providers/create-workspace-runtime';
import { META_REMOTE_CURSOR_BYPASS_STORAGE_KEY_PREFIX } from '../src/lib/clear-local-cache';
import { waitForWorkspaceContentAdmission } from '../src/providers/workspace-mode-admission';

describe('createWorkspaceRuntime meta recovery lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    mocks.encryptedAcpTransport.handler = null;
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
      content: { mode: 'plaintext' },
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
      content: { mode: 'plaintext' },
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
      content: { mode: 'plaintext' },
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
      content: { mode: 'plaintext' },
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

  it('keeps local drafts available while unknown mode blocks every cloud request', async () => {
    const admitted = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const requests: string[] = [];
    mocks.realTokenProvider = true;
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(String(url));
      return new Response('denied', { status: 403 });
    });
    const { LoroRepo: RealRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
    const repo = await RealRepo.create({ metaDebounceCommitMs: 0 });
    mocks.repoOverride = repo;
    const runtime = await createWorkspaceRuntime({
      content: { mode: 'plaintext' },
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      waitForContentAdmission: () => {
        waiting.resolve();
        return admitted.promise;
      },
    });
    const draft = await repo.openPersistedDoc('draft');
    draft.doc.getText('text').insert(0, 'C1 private draft sentinel');
    draft.doc.commit();
    const attaching = runtime.setAuthToken('auth-token').catch(() => {});
    try {
      await Promise.race([waiting.promise, attaching]);
      expect(draft.doc.getText('text').toString()).toBe('C1 private draft sentinel');
      expect(requests).toEqual([]);
      admitted.resolve();
      await attaching;
      expect(requests.some((url) => url.includes('loro'))).toBe(true);
    } finally {
      admitted.resolve();
      await attaching;
      await runtime.dispose();
    }
  });

  it.each(['plaintext', 'encrypted', 'dispose'] as const)(
    'keeps a scheduled-message draft unaccepted until mode admission: %s',
    async (outcome) => {
      const admitted = Promise.withResolvers<void>();
      const phase = Promise.withResolvers<'waiting' | 'writing'>();
      const { LoroRepo: RealRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
      const repo = await RealRepo.create({});
      mocks.repoOverride = repo;
      const runtime = await createWorkspaceRuntime({
        content: { mode: 'plaintext' },
        workspaceSlug: 'workspace',
        workspaceId: 'workspace-1',
        accountId: 'owner',
        apiBaseUrl: 'https://synthetic.invalid',
        waitForContentAdmission: (signal) => {
          phase.resolve('waiting');
          return waitForWorkspaceContentAdmission(admitted.promise, signal);
        },
      });
      const repository = new ScheduleRepository(repo, 'workspace-1' as WorkspaceId);
      let draft = 'unclassified scheduled body sentinel';
      const saving = runtime
        .withScheduleStore(
          'mode-reservation',
          async () => {
            phase.resolve('writing');
            return repository.save({
              scheduleId: 'mode-reservation',
              actorId: 'owner',
              now: 0,
              create: true,
              activationId: 'activation',
              activityId: 'created',
              draft: {
                title: 'Reserved',
                prompt: draft,
                machineId: 'remote-owned-machine',
                agent: { agentConfigId: 'agent' },
                destination: { kind: 'existing_session', sessionId: 'chat' },
                trigger: { kind: 'once', at: '2030-01-01T00:00:00Z' },
                misfirePolicy: { kind: 'run_once' },
                overlapPolicy: 'queue_one',
                retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86400000 },
                message: { inputBlocks: [{ type: 'text', text: draft }] },
              },
            });
          },
          { create: true }
        )
        .then((saved) => {
          draft = '';
          return saved;
        });
      void saving.catch(() => {});
      try {
        expect(await phase.promise).toBe('waiting');
        expect(draft).toBe('unclassified scheduled body sentinel');
        expect(await repository.read('mode-reservation')).toBeNull();
        expect(await repository.list()).toEqual([]);
        if (outcome === 'plaintext') {
          admitted.resolve();
          await saving;
          expect(draft).toBe('');
          expect((await repository.read('mode-reservation'))?.message?.inputBlocks).toEqual([
            { type: 'text', text: 'unclassified scheduled body sentinel' },
          ]);
        } else {
          if (outcome === 'encrypted') admitted.reject(new Error('workspace became encrypted'));
          else {
            await runtime.dispose();
            admitted.resolve();
          }
          await expect(saving).rejects.toThrow();
          expect(draft).toBe('unclassified scheduled body sentinel');
        }
        expect(mocks.authInvocations).toEqual([]);
      } finally {
        admitted.resolve();
        await saving.catch(() => {});
        await runtime.dispose();
      }
    }
  );

  it('returns the local Repo before admission even when cloud startup already has a token', async () => {
    const admitted = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const requests: string[] = [];
    mocks.realTokenProvider = true;
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(String(url));
      return new Response('denied', { status: 403 });
    });
    let published: Awaited<ReturnType<typeof createWorkspaceRuntime>> | undefined;
    const opening = createWorkspaceRuntime({
      content: { mode: 'plaintext' },
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'initial-token',
      waitForContentAdmission: (signal) => {
        waiting.resolve();
        return waitForWorkspaceContentAdmission(admitted.promise, signal);
      },
    }).then((runtime) => {
      published = runtime;
      return runtime;
    });
    // Observe both success and failure immediately; cleanup owns the result.
    void opening.catch(() => {});
    await waiting.promise;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(published?.repo).toBe(window.repo);
      expect(published).toBeDefined();
      expect(requests).toEqual([]);
      await published!.dispose();
      admitted.resolve();
      await opening;
      expect(requests).toEqual([]);
    } finally {
      admitted.resolve();
      await opening.then(
        (runtime) => runtime.dispose(),
        () => {}
      );
    }
  });

  it.each(['cloud', 'dual'] as const)(
    'holds refreshed tokens and reconnect wakes behind unknown-mode admission (%s)',
    async (syncMode) => {
      if (syncMode === 'dual') enableElectronLocalDataPlane();
      const admitted = Promise.withResolvers<void>();
      const requests: string[] = [];
      mocks.realTokenProvider = true;
      vi.stubGlobal('fetch', async (url: string) => {
        requests.push(String(url));
        return new Response('denied', { status: 403 });
      });
      const runtime = await createWorkspaceRuntime({
        content: { mode: 'plaintext' },
        workspaceSlug: 'workspace',
        workspaceId: 'workspace-1' as WorkspaceId,
        apiBaseUrl: 'https://api.example.test',
        syncMode,
        waitForContentAdmission: (signal) =>
          waitForWorkspaceContentAdmission(admitted.promise, signal),
      });
      const first = runtime.setAuthToken('old-token').then(
        () => 'admitted',
        (error) => error.name
      );
      const refreshed = runtime.setAuthToken('refreshed-token').catch(() => {});
      try {
        expect(await first).toBe('AbortError');
        dispatchWindowEvent('online');
        dispatchDocumentEvent('visibilitychange');
        await vi.advanceTimersByTimeAsync(0);
        expect(requests).toEqual([]);
        await runtime.dispose();
        admitted.resolve();
        await refreshed;
        expect(requests).toEqual([]);
      } finally {
        await runtime.dispose();
      }
    }
  );

  it.each(['cloud', 'dual'] as const)(
    'resumes ordinary synchronization on the same Repo after a failed mode read recovers (%s)',
    async (syncMode) => {
      if (syncMode === 'dual') enableElectronLocalDataPlane();
      let available = false;
      const failure = new Error('workspace_access_denied');
      const requests: string[] = [];
      const attached = new Set<string>();
      mocks.realTokenProvider = true;
      mocks.joinMetaRoom.mockResolvedValue(createMetaSub(Promise.resolve()));
      const addTransport = mocks.addTransport.getMockImplementation();
      mocks.addTransport.mockImplementation(async (id) => {
        attached.add(id);
      });
      vi.stubGlobal('fetch', async (url: string) => {
        requests.push(String(url));
        return new Response('denied', { status: 403 });
      });
      const runtime = await createWorkspaceRuntime({
        content: { mode: 'plaintext' },
        workspaceSlug: 'workspace',
        workspaceId: 'workspace-1' as WorkspaceId,
        apiBaseUrl: 'https://api.example.test',
        syncMode,
        waitForContentAdmission: async () => {
          if (!available) throw failure;
        },
      });
      const repo = runtime.repo;
      try {
        await expect(runtime.setAuthToken('auth-token')).rejects.toBe(failure);
        expect(requests).toEqual([]);
        expect(attached.size).toBe(0);
        available = true;
        await runtime.setAuthToken('auth-token').catch(() => {});
        expect(runtime.repo).toBe(repo);
        if (syncMode === 'dual') expect(attached.has('local')).toBe(true);
        expect(requests.some((url) => url.includes('loro-streams/token'))).toBe(true);
      } finally {
        await runtime.dispose();
        mocks.addTransport.mockImplementation(addTransport!);
      }
    }
  );

  it('holds desktop cloud document bytes locally until classification admits the local bridge', async () => {
    vi.useRealTimers();
    enableElectronLocalDataPlane();
    const { indexedDB, IDBKeyRange } = await import('fake-indexeddb');
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    const { LoroRepo: RealRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
    const repo = await RealRepo.create({
      metaDebounceCommitMs: 0,
      resolveRoomTransports: () => ({ transportIds: ['local'] }),
    });
    const admitted = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const connected = Promise.withResolvers<void>();
    const sent: Uint8Array[] = [];
    const adapter: TransportAdapter = {
      connect: async () => {},
      close: async () => {},
      isConnected: () => true,
      getStatus: () => 'connected',
      onStatusChange: () => () => {},
      syncMeta: async () => ({ ok: true }),
      joinMetaRoom: () => createMetaSub(Promise.resolve()),
      syncDoc: async (_id, doc) => {
        sent.push(doc.export({ mode: 'snapshot' }));
        return { ok: true };
      },
      joinDocRoom: () => createMetaSub(Promise.resolve()),
    };
    const add = repo.addTransport.bind(repo);
    vi.spyOn(repo, 'addTransport').mockImplementation(async (id, _adapter, options) => {
      await add(id, adapter, options);
      connected.resolve();
    });
    mocks.repoOverride = repo;
    const runtime = await createWorkspaceRuntime({
      content: { mode: 'plaintext' },
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      syncMode: 'dual',
      waitForContentAdmission: (signal) => {
        waiting.resolve();
        return waitForWorkspaceContentAdmission(admitted.promise, signal);
      },
    });
    try {
      await Promise.race([waiting.promise, connected.promise]);
      const draft = await repo.openPersistedDoc('private-draft');
      draft.doc.getText('text').insert(0, 'C1 desktop cloud draft sentinel');
      draft.doc.commit();
      await repo.sync({ scope: 'doc', docIds: ['private-draft'] });
      expect(sent).toEqual([]);
      expect(draft.doc.getText('text').toString()).toBe('C1 desktop cloud draft sentinel');
      admitted.resolve();
      await connected.promise;
      await repo.sync({ scope: 'doc', docIds: ['private-draft'] });
      const { LoroDoc } = await import('loro-crdt');
      const received = sent.map((bytes) => {
        const doc = new LoroDoc();
        doc.import(bytes);
        return doc.getText('text').toString();
      });
      expect(received).toContain('C1 desktop cloud draft sentinel');
    } finally {
      await runtime.dispose();
    }
  });

  it.each(['logout', 'dispose', 'rejected mode'] as const)(
    'does not revive a held ordinary token after %s and a late classification',
    async (reason) => {
      const admission = Promise.withResolvers<void>();
      const waiting = Promise.withResolvers<void>();
      const requests: string[] = [];
      mocks.realTokenProvider = true;
      vi.stubGlobal('fetch', async (url: string) => {
        requests.push(String(url));
        return new Response('denied', { status: 403 });
      });
      const runtime = await createWorkspaceRuntime({
        content: { mode: 'plaintext' },
        workspaceSlug: 'workspace',
        workspaceId: 'workspace-1' as WorkspaceId,
        apiBaseUrl: 'https://api.example.test',
        waitForContentAdmission: (signal) => {
          waiting.resolve();
          return waitForWorkspaceContentAdmission(admission.promise, signal);
        },
      });
      const attaching = runtime.setAuthToken('old-account-token');
      const rejected = expect(attaching).rejects.toThrow();
      await waiting.promise;
      try {
        if (reason === 'logout') await runtime.setAuthToken(null);
        else if (reason === 'dispose') await runtime.dispose();
        else admission.reject(new Error('e2ee_workspace_mode_unavailable'));
        await rejected;
        admission.resolve();
        expect(requests).toEqual([]);
      } finally {
        await runtime.dispose();
      }
    }
  );

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
      content: { mode: 'plaintext' },
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

  it('retries a web attach blocked by a suspect Meta checkpoint on its own backoff', async () => {
    const runtime = await createWebRuntimeWithSuspectMetaCheckpoint();

    // No further setAuthToken call at all: only the retry loop's backoff runs.
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expectDeleteThenAttach();
    expect(window.localStorage.getItem(markerKey)).toBeNull();

    await runtime.dispose();
  });

  it('attaches the new token, not the superseded one, when the token rotates during a blocked delete', async () => {
    mocks.joinMetaRoom.mockResolvedValue(createMetaSub(Promise.resolve()));
    markSuspectMetaCheckpoint();
    const blockedDelete = Promise.withResolvers<void>();
    mocks.metaCheckpointDelete.mockImplementationOnce(async () => await blockedDelete.promise);
    const runtime = await createWorkspaceRuntime({
      content: { mode: 'plaintext' },
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
        content: { mode: 'plaintext' },
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
        content: { mode: 'plaintext' },
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
      content: { mode: 'plaintext' },
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
        content: { mode: 'plaintext' },
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

  it('does not attach the cloud plane in dual mode until a suspect Meta checkpoint is really deleted', async () => {
    mocks.joinMetaRoom.mockResolvedValue(createMetaSub(Promise.resolve()));
    enableElectronLocalDataPlane();
    markSuspectMetaCheckpoint();
    mocks.metaCheckpointDelete.mockRejectedValueOnce(
      new Error('The database connection is closing.')
    );
    const runtime = await createWorkspaceRuntime({
      content: { mode: 'plaintext' },
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
      content: { mode: 'plaintext' },
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
      content: { mode: 'plaintext' },
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
        content: { mode: 'plaintext' },
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
      content: { mode: 'plaintext' },
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
      content: { mode: 'plaintext' },
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

  it('uses the Electron local data plane without attaching Loro Streams', async () => {
    mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));
    enableElectronLocalDataPlane();

    const runtime = await createWorkspaceRuntime({
      content: { mode: 'plaintext' },
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

  it('attaches the cloud plane after an offline Electron startup comes online', async () => {
    mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));
    enableElectronLocalDataPlane();
    Object.assign(navigator, { onLine: false });

    const runtime = await createWorkspaceRuntime({
      content: { mode: 'plaintext' },
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

  it.each(['roost-arrives', 'owner-arrives', 'legacy', 'close', 'deleted'] as const)(
    'retains a cold reader until its own metadata source is ready (%s)',
    async (scenario) => {
      const { LoroRepo: RealRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
      const { LoroDoc } = await import('loro-crdt');
      const { createLoroSessionData } = await import('@lody/shared/session-data');
      const repo = await RealRepo.create({
        metaDebounceCommitMs: 0,
        resolveRoomTransports: () => ({ transportIds: ['local', 'cloud'] }),
      });
      const remoteSync = Promise.withResolvers<void>();
      const localMetaJoined = Promise.withResolvers<void>();
      const cloudMetaJoined = Promise.withResolvers<void>();
      const adapter = (cloud: boolean): TransportAdapter => ({
        connect: async () => {},
        close: async () => {},
        isConnected: () => true,
        getStatus: () => 'connected',
        onStatusChange: () => () => {},
        reconnect: async () => {},
        syncMeta: async () => ({ ok: true }),
        syncDoc: async () => ({ ok: true }),
        joinMetaRoom: () => {
          (cloud ? cloudMetaJoined : localMetaJoined).resolve();
          return {
            status: 'joined',
            firstSyncedWithRemote: cloud ? remoteSync.promise : Promise.resolve(),
            onStatusChange: () => () => {},
            unsubscribe: () => {},
            waitUntilSynced: async () => {},
            rejoin: async () => {},
          };
        },
      });
      const add = repo.addTransport.bind(repo);
      vi.spyOn(repo, 'addTransport').mockImplementation((id, _adapter, options) =>
        add(id, adapter(id === 'cloud'), options)
      );
      mocks.repoOverride = repo;
      enableElectronLocalDataPlane();
      const sessionId = 'synthetic-cold-peer' as SessionId;
      const roomId = getSessionRoomId(sessionId);
      await repo.upsertDocMeta(roomId, {
        id: sessionId,
        ...(scenario === 'owner-arrives' ? {} : { machineId: 'foreign-machine' }),
      });
      // The previous premature Loro reader can leave an empty list in an
      // otherwise Roost control document. It must not become legacy evidence.
      const provisional = await repo.openPersistedDoc(roomId);
      const misplaced = provisional.doc.getList('history');
      if (scenario === 'roost-arrives' || scenario === 'owner-arrives') {
        // A cached old reader may even have authored a misplaced Loro entry.
        // A known Roost cursor must keep this provisional backend unresolved.
        misplaced.push({
          id: 'misplaced-old-input',
          role: 'user',
          timestamp: 'synthetic',
          items: [{ type: 'text', text: 'Old mistaken Loro reader' }],
        });
        provisional.doc.getMap('roostHistoryCursor').set('cursor', '1');
      }
      provisional.doc.commit();
      const armed = Promise.withResolvers<void>();
      const live = new Set<unknown>();
      const observe = repo.observeDocs.bind(repo);
      vi.spyOn(repo, 'observeDocs').mockImplementation((listener, options) => {
        const observation = observe(listener, options);
        if (!options?.filter?.docIds?.includes(roomId)) return observation;
        live.add(observation);
        armed.resolve();
        return {
          ...observation,
          unsubscribe: () => {
            live.delete(observation);
            observation.unsubscribe();
          },
        };
      });
      const body = new LoroDoc();
      body.getList('history').push({
        id: 'synthetic-visible-body',
        role: 'assistant',
        timestamp: 'synthetic',
        items: [{ type: 'text', text: 'Visible after backend readiness' }],
      });
      body.commit();
      const runtime = await createWorkspaceRuntime({
        content: { mode: 'plaintext' },
        workspaceSlug: 'workspace',
        workspaceId: 'workspace-1' as WorkspaceId,
        apiBaseUrl: 'https://api.example.test',
        syncMode: 'dual',
        createSessionData: ({ sessionId: targetSessionId }) =>
          createLoroSessionData({ sessionId: targetSessionId, doc: body }),
      });
      runtime.setLocalMachineId('local-machine' as MachineId);
      await localMetaJoined.promise;
      await runtime.setAuthToken('synthetic-token');
      await cloudMetaJoined.promise;
      const opening = runtime.acquireSessionStore(sessionId);
      const outcome = opening.catch((error) => error);
      await armed.promise;
      expect(runtime.peekSessionStore?.(sessionId)).toBeUndefined();
      expect(live.size).toBe(1);
      if (scenario === 'close') {
        remoteSync.resolve();
        await runtime.dispose();
        expect(await outcome).toBeInstanceOf(Error);
        expect(live.size).toBe(0);
        return;
      }
      if (scenario === 'deleted') {
        try {
          await repo.deleteDoc(roomId);
          expect(await outcome).toBeInstanceOf(Error);
          expect(runtime.peekSessionStore?.(sessionId)).toBeUndefined();
          expect(live.size).toBe(0);
        } finally {
          remoteSync.resolve();
          await runtime.dispose();
        }
        return;
      }
      if (scenario === 'roost-arrives' || scenario === 'owner-arrives') {
        // Local Meta restored already. The same acquire must bind Roost when
        // the foreign session's identity arrives, without a view reopen.
        const metaLease = await repo.joinMetaRoom();
        try {
          remoteSync.resolve();
          expect(
            await metaLease.subscription('cloud').waitFor({ phase: 'restored' })
          ).toMatchObject({ status: 'complete' });
        } finally {
          metaLease.unsubscribe();
        }
        await repo.upsertDocMeta(roomId, { historyBackend: 'roost', machineId: 'foreign-machine' });
      } else remoteSync.resolve();
      try {
        const store = await opening;
        expect(store.historyBackend).toBe(scenario === 'legacy' ? 'loro' : 'roost');
        expect(await store.sessionData.history.readTurn('synthetic-visible-body')).toMatchObject({
          state: 'ready',
        });
        expect(live.size).toBe(0);
      } finally {
        remoteSync.resolve();
        await runtime.dispose();
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
      content: { mode: 'plaintext' },
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

  it('re-joins a held session room after every initial join attempt failed', async () => {
    // A join that never attaches leaves loro-repo no room record, so neither
    // repo.reconnect() nor the reconnect loop can revive it. The open view
    // used to sit on its cached copy until a reload.
    const { LoroRepo: RealRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
    const repo = await RealRepo.create({
      metaDebounceCommitMs: 0,
      resolveRoomTransports: () => ({ transportIds: ['local'] }),
    });
    const subscription = (): TransportSubscription => ({
      status: 'joined',
      firstSyncedWithRemote: Promise.resolve(),
      onStatusChange: () => () => {},
      unsubscribe: () => {},
      waitUntilSynced: async () => {},
      rejoin: async () => {},
    });
    const sessionId = 'synthetic-join-retry' as SessionId;
    const roomId = getSessionRoomId(sessionId);
    // Three attempts inside one join pass, then one more after the backoff.
    let failingJoins = 4;
    const adapter: TransportAdapter = {
      connect: async () => {},
      close: async () => {},
      isConnected: () => true,
      getStatus: () => 'connected',
      onStatusChange: () => () => {},
      reconnect: async () => {},
      syncMeta: async () => ({ ok: true }),
      syncDoc: async () => ({ ok: true }),
      joinMetaRoom: () => subscription(),
      joinDocRoom: (docId) => {
        if (docId === roomId && failingJoins > 0) {
          failingJoins -= 1;
          throw new Error('synthetic attach failure');
        }
        return subscription();
      },
    };
    const add = repo.addTransport.bind(repo);
    vi.spyOn(repo, 'addTransport').mockImplementation((id, _adapter, options) =>
      add(id, adapter, options)
    );
    mocks.repoOverride = repo;
    enableElectronLocalDataPlane();
    await repo.upsertDocMeta(roomId, { id: sessionId, machineId: 'local-machine' });

    const runtime = await createWorkspaceRuntime({
      content: { mode: 'plaintext' },
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
    });
    runtime.setLocalMachineId('local-machine' as MachineId);
    const store = await runtime.acquireSessionStore(sessionId);
    const releaseSync = store.acquireSync();
    try {
      // The join pass's own retries (1 s, 2 s) all fail.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(failingJoins).toBe(1);
      expect(store.getSyncState()).toBe('error');

      await vi.advanceTimersByTimeAsync(30_000);
      expect(failingJoins).toBe(0);
      expect(store.getSyncState()).toBe('synced');
      await expect(store.firstSynced).resolves.toBeUndefined();
    } finally {
      releaseSync();
      runtime.releaseSessionStoreRef(sessionId);
      await runtime.dispose();
    }
  });

  it('rebinds the eager-sync auth callback when the token provider is replaced', async () => {
    mocks.joinMetaRoom.mockResolvedValue(createMetaSub(Promise.resolve()));
    const runtime = await createWorkspaceRuntime({
      content: { mode: 'plaintext' },
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
  it('opens the encrypted file index and preview comments through the production runtime repo', async () => {
    vi.useRealTimers();
    const { indexedDB, IDBKeyRange } = await import('fake-indexeddb');
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    const { LoroRepo: RealRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
    const { IndexedDBStorageAdaptor } = await vi.importActual<
      typeof import('loro-repo/storage/indexeddb')
    >('loro-repo/storage/indexeddb');
    const repo = await RealRepo.create({
      storageAdapter: new IndexedDBStorageAdaptor({ dbName: 'encrypted-file-surfaces' }),
      metaDebounceCommitMs: 0,
    });
    mocks.repoOverride = repo;
    const { writeCodeCollabFileIndexToFlock } = await import('@lody/shared');
    const flockId = 'workspace-1:fi:synthetic';
    const handle = await repo.openFlockDoc(flockId);
    writeCodeCollabFileIndexToFlock(handle.flock, { 'private.ts': { kind: 'text' } }, 1000);
    const runtime = await createWorkspaceRuntime({
      content: {
        mode: 'protected',
        namespace: 'synthetic',
        resolve: () => {
          throw new Error('offline');
        },
        snapshotUpload: { canUpload: () => false },
      },
      e2ee: {
        bucketId: () => 'encrypted',
        createTokenProvider: () => {
          throw new Error('offline');
        },
      },
      accountId: 'synthetic-account',
      e2eeLocalIdentity: {
        accountId: 'synthetic-account',
        workspaceId: 'workspace-1',
        genesisHash: '11'.repeat(32),
        signingPublicKey: '22'.repeat(32),
      },
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceSlug: 'workspace',
      apiBaseUrl: 'https://api.example.test',
    });
    try {
      const lease = await runtime.codeCollabFileIndexCache.acquire(flockId);
      expect(lease.resource.getSnapshot()).toMatchObject({
        status: 'ready',
        snapshot: { fileIndex: { 'private.ts': { kind: 'text' } } },
      });
      await lease.release();
      const comments = await runtime.acquirePreviewVisualCommentStore('synthetic' as SessionId);
      comments.setState((draft) => {
        draft.meta.sessionId = 'synthetic';
      });
      expect(comments.getState().meta.sessionId).toBe('synthetic');
      runtime.releasePreviewVisualCommentStoreRef('synthetic' as SessionId);
    } finally {
      await runtime.dispose();
    }
  });

  it('routes remote authentication and probing through protected interaction with translated IDs', async () => {
    vi.useRealTimers();
    const { LoroRepo: RealRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
    const repo = await RealRepo.create({});
    mocks.repoOverride = repo;
    await repo.upsertDocMeta('machine-remote-machine', {
      protocolCapabilities: { e2eeAcpInteraction: 1 },
    });
    const { createRpcSecretRecipient, encryptRpcSecret } = await import('@lody/loro-streams-rpc');
    const { e2eeAcpInteractionResponseContext, e2eeAcpInteractionInputContext } =
      await import('@lody/shared/e2ee-rpc');
    const inputRecipient = await createRpcSecretRecipient();
    const device = '22'.repeat(32);
    const calls: any[] = [];
    const inputs: unknown[] = [];
    let responseKey: any;
    let interactionId = '';
    let kind = '';
    let submitted = false;
    mocks.encryptedAcpTransport.handler = async (request, options) => {
      expect(request.method).toBe('machine/acp-interaction');
      calls.push({ request, options });
      const params = request.params;
      options.onPrepared?.(device);
      if (params.action === 'start') {
        responseKey = params.responseKey;
        interactionId = options.requestId;
        kind = params.kind;
      } else expect(options.expectedDevice).toBe(device);
      if (params.action === 'submit') {
        inputs.push(
          JSON.parse(
            await inputRecipient.decrypt(
              params.inputEnvelope,
              e2eeAcpInteractionInputContext({
                workspaceId: 'workspace-1',
                machineId: 'remote-machine',
                requesterDevice: device,
                interactionRequestId: interactionId,
                interactionId: params.interactionId,
              })
            )
          )
        );
        submitted = true;
      }
      const completed = params.action === 'poll' && (kind === 'probe' || submitted);
      const payload = completed
        ? {
            result: {
              kind,
              response:
                kind === 'authenticate'
                  ? {
                      type: 'machine/acp-authenticate_response',
                      machineId: 'remote-machine',
                      requestId: interactionId,
                      agentType: 'sorbet',
                      success: true,
                      disposition: 'authenticated',
                    }
                  : {
                      type: 'machine/acp-capabilities-refresh_response',
                      machineId: 'remote-machine',
                      configId: 'config',
                      cliType: 'builtin',
                      agentType: 'sorbet',
                      success: true,
                    },
            },
          }
        : params.action === 'activate' && kind === 'authenticate'
          ? {
              progress: {
                type: 'machine/acp-authentication-progress',
                machineId: 'remote-machine',
                requestId: interactionId,
                agentType: 'sorbet',
                status: 'starting',
              },
              progressCursor: 1,
            }
          : null;
      const envelope = payload
        ? await encryptRpcSecret(
            responseKey,
            JSON.stringify(payload),
            e2eeAcpInteractionResponseContext({
              workspaceId: 'workspace-1',
              machineId: 'remote-machine',
              requesterDevice: device,
              interactionRequestId: interactionId,
              requestId: options.requestId,
            })
          )
        : undefined;
      return {
        ok: true,
        result: {
          type: 'machine/acp-interaction',
          interactionRequestId: interactionId,
          state: completed ? 'completed' : 'running',
          ...(params.action === 'start' && kind === 'authenticate'
            ? { inputPublicKey: inputRecipient.publicKey }
            : {}),
          ...(envelope ? { responseEnvelope: envelope } : {}),
        },
      };
    };
    const host = {
      prepareDispatch: vi.fn(),
      acceptDispatchResponse: vi.fn(),
      prepareFeatureRpc: vi.fn(),
      acceptFeatureRpcResponse: vi.fn(),
    } as unknown as E2eeWorkspaceRuntime;
    const access = createE2eeContent({
      runtime: host,
      workspaceId: 'workspace-1',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => null,
    });
    const runtime = await createWorkspaceRuntime({
      content: access.content,
      e2ee: access.e2ee,
      accountId: 'account',
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1',
      apiBaseUrl: 'https://synthetic.invalid',
      syncMode: 'cloud',
      e2eeLocalIdentity: {
        accountId: 'account',
        workspaceId: 'workspace-1',
        genesisHash: '11'.repeat(32),
        signingPublicKey: device,
      },
    });
    const machine = 'remote-machine' as MachineId;
    const requestId = '01234567-89ab-4cde-8fab-0123456789ab';
    const progress = Promise.withResolvers<any>();
    const unsubscribe = runtime.subscribeMachineAcpAuthenticationProgress(
      machine,
      requestId,
      progress.resolve
    );
    try {
      const result = runtime.waitForMachineAcpAuthenticateResponse(machine, requestId);
      runtime.sendControl({
        type: 'machine/acp-authenticate',
        action: 'start',
        workspaceId: 'workspace-1',
        machineId: machine,
        configId: 'config',
        requestId,
      } as never);
      const first = await Promise.race([progress.promise, result]);
      if ('error' in first) throw new Error(String(first.error));
      expect(first).toMatchObject({ requestId, status: 'starting' });
      const submitId = '11234567-89ab-4cde-8fab-0123456789ab';
      const receipt = runtime.waitForMachineAcpAuthenticateResponse(machine, submitId);
      runtime.sendControl({
        type: 'machine/acp-authenticate',
        action: 'submit-input',
        workspaceId: 'workspace-1',
        machineId: machine,
        requestId: submitId,
        authenticationRequestId: requestId,
        interactionId: 'form',
        authenticationInput: 'synthetic-input',
      } as never);
      expect(await receipt).toMatchObject({ success: true, disposition: 'input-accepted' });
      expect(await result).toMatchObject({
        success: true,
        requestId,
        disposition: 'authenticated',
      });
      expect(inputs).toEqual([{ action: 'submit-input', authenticationInput: 'synthetic-input' }]);
      expect(calls[0].options.requestId).toBe(requestId.replaceAll('-', ''));
      expect(calls.slice(0, 2).map((call) => call.request.params.action)).toEqual([
        'start',
        'activate',
      ]);
      expect(calls.map((call) => call.request.params.action)).toContain('submit');
      expect(calls.map((call) => call.request.params.action)).toContain('poll');
      calls.length = 0;
      const probe = await runtime.requestMachineAcpCapabilitiesRefresh({
        type: 'machine/acp-capabilities-refresh',
        workspaceId: 'workspace-1',
        machineId: machine,
        configId: 'config',
      } as never);
      expect(probe).toMatchObject({ success: true, machineId: machine, configId: 'config' });
      expect(calls.map((call) => call.request.params.action)).toEqual([
        'start',
        'activate',
        'poll',
      ]);
      expect(calls[0].options.requestId).toMatch(/^[0-9a-f]{32}$/);
      expect(mocks.machineRpcConstructors).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      await runtime.dispose();
      await access.close();
    }
  });

  it('rejects protected remote ACP operations when the machine has not advertised the encrypted capability', async () => {
    const { LoroRepo: RealRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
    mocks.repoOverride = await RealRepo.create({});
    const host = {
      prepareDispatch: vi.fn(),
      acceptDispatchResponse: vi.fn(),
      prepareFeatureRpc: vi.fn(),
      acceptFeatureRpcResponse: vi.fn(),
    } as unknown as E2eeWorkspaceRuntime;
    const access = createE2eeContent({
      runtime: host,
      workspaceId: 'workspace-1',
      genesisHash: '11'.repeat(32),
      epoch: 0,
      authToken: () => null,
    });
    const runtime = await createWorkspaceRuntime({
      content: access.content,
      e2ee: access.e2ee,
      accountId: 'account',
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1',
      apiBaseUrl: 'https://synthetic.invalid',
      syncMode: 'cloud',
      e2eeLocalIdentity: {
        accountId: 'account',
        workspaceId: 'workspace-1',
        genesisHash: '11'.repeat(32),
        signingPublicKey: '22'.repeat(32),
      },
    });
    try {
      const probe = await runtime.requestMachineAcpCapabilitiesRefresh({
        type: 'machine/acp-capabilities-refresh',
        workspaceId: 'workspace-1',
        machineId: 'remote-machine',
        configId: 'config',
      } as never);
      expect(probe).toMatchObject({
        success: false,
        error: 'Encrypted ACP interaction is not supported by this machine',
      });
      const requestId = '01234567-89ab-4cde-8fab-0123456789ab';
      const response = runtime.waitForMachineAcpAuthenticateResponse(
        'remote-machine' as MachineId,
        requestId
      );
      runtime.sendControl({
        type: 'machine/acp-authenticate',
        action: 'start',
        workspaceId: 'workspace-1',
        machineId: 'remote-machine',
        configId: 'config',
        requestId,
      } as never);
      await expect(response).resolves.toMatchObject({
        success: false,
        error: 'Encrypted ACP interaction is not supported by this machine',
      });
      const earlyId = '11234567-89ab-4cde-8fab-0123456789ab';
      runtime.sendControl({
        type: 'machine/acp-authenticate',
        action: 'cancel',
        workspaceId: 'workspace-1',
        machineId: 'remote-machine',
        requestId: 'cancel',
        authenticationRequestId: earlyId,
      } as never);
      const earlyResponse = runtime.waitForMachineAcpAuthenticateResponse(
        'remote-machine' as MachineId,
        earlyId
      );
      runtime.sendControl({
        type: 'machine/acp-authenticate',
        action: 'start',
        workspaceId: 'workspace-1',
        machineId: 'remote-machine',
        configId: 'config',
        requestId: earlyId,
      } as never);
      await expect(earlyResponse).resolves.toMatchObject({
        success: false,
        error: 'ACP authentication cancelled',
      });
      expect(mocks.machineRpcConstructors).not.toHaveBeenCalled();
      expect(host.prepareFeatureRpc).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it.each(['none', 'dispatch-only', 'complete'])(
    'binds protected remote execution capability to the actual host port (%s)',
    async (support) => {
      const supported = support !== 'none';
      const { LoroRepo: RealRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
      const repo = await RealRepo.create({});
      mocks.repoOverride = repo;
      const intents: unknown[][] = [];
      const featurePreparations: unknown[][] = [];
      const original = {
        requestId: '11'.repeat(16),
        targetMachineId: 'remote-machine',
        requesterDevice: '22'.repeat(32),
        expiresAt: 123456,
        frameHex: 'synthetic-original-ciphertext',
      };
      const host = (supported
        ? {
            prepareDispatch: async (...args: unknown[]) => {
              intents.push(args);
              return original;
            },
            acceptDispatchResponse: async () => ({}),
            ...(support === 'complete'
              ? {
                  prepareFeatureRpc: async (...args: unknown[]) => {
                    featurePreparations.push(args);
                    return original;
                  },
                  acceptFeatureRpcResponse: async () => null,
                }
              : {}),
          }
        : {}) as unknown as E2eeWorkspaceRuntime;
      const access = createE2eeContent({
        runtime: host,
        workspaceId: 'workspace-1',
        genesisHash: '11'.repeat(32),
        epoch: 0,
        authToken: () => null,
      });
      const runtime = await createWorkspaceRuntime({
        content: access.content,
        e2ee: access.e2ee,
        accountId: 'synthetic-account',
        workspaceSlug: 'workspace',
        workspaceId: 'workspace-1',
        apiBaseUrl: 'https://synthetic.invalid',
        syncMode: 'cloud',
        e2eeLocalIdentity: {
          accountId: 'synthetic-account',
          workspaceId: 'workspace-1',
          genesisHash: '11'.repeat(32),
          signingPublicKey: '22'.repeat(32),
        },
      });
      try {
        expect(runtime.protectedRpcAvailable).toBe(support === 'complete');
        expect(Boolean(runtime.prepareEncryptedDispatch)).toBe(supported);
        if (supported) {
          const input = {
            sessionId: 'session',
            userTurnId: 'turn',
            userId: 'member',
            timestamp: '2026-10-30T00:00:00Z',
            inputConfig: {},
          };
          const first = await runtime.prepareEncryptedDispatch!('remote-machine', input);
          const retry = await runtime.prepareEncryptedDispatch!('remote-machine', input);
          expect(first.original).toEqual(original);
          expect(retry.original).toEqual(first.original);
          expect(intents).toEqual([
            ['workspace-1', 'remote-machine', input],
            ['workspace-1', 'remote-machine', input],
          ]);
        } else {
          await expect(
            runtime.requestFilePreview('remote-machine' as MachineId, {} as never)
          ).resolves.toMatchObject({
            status: 'error',
            code: 'permission_denied',
            retryable: false,
            message: 'Encrypted workspaces do not yet support remote machine operations.',
          });
        }
        // Writes follow the verified ledger role; a Guest is refused before any signing.
        access.updateStatus({
          epoch: 0,
          rotationRequired: false,
          hasCurrentKey: true,
          memberRole: 'guest',
        });
        expect(runtime.protectedCodeCollabRole?.get()).toBe('read');
        await expect(
          runtime.requestCodeCollabSaveText('remote-machine' as MachineId, {
            sessionId: 'session',
            requestedByUserId: 'guest',
            path: 'a.ts',
            baseDigest: `sha256:${'0'.repeat(64)}`,
            text: { encoding: 'plain', text: 'x', rawBytes: 1 },
          })
        ).resolves.toMatchObject({ status: 'error', code: 'permission_denied', retryable: false });
        expect(featurePreparations).toEqual([]);
        // Preparation needs no local agent or ordinary transport/token.
        expect(cloudAttachCalls()).toEqual([]);
        expect(mocks.authInvocations).toEqual([]);
        expect(mocks.machineRpcConstructors.mock.calls).toEqual([]);
      } finally {
        await runtime.dispose();
        await access.close();
      }
    }
  );

  it('opens protected schedules offline through the production store cache and retains encrypted transport assembly', async () => {
    const { LoroRepo: RealRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
    const repo = await RealRepo.create({});
    mocks.repoOverride = repo;
    vi.spyOn(repo, 'addTransport').mockImplementation(mocks.addTransport as never);
    vi.spyOn(repo, 'joinMetaRoom').mockImplementation(mocks.joinMetaRoom as never);
    const provider = () =>
      createLoroStreamsTokenProviderLegacy({
        endpoint: 'https://encrypted.example.test/token',
        workspaceId: 'workspace-1',
        authToken: () => 'synthetic',
      });
    const content = {
      mode: 'protected' as const,
      namespace: 'synthetic-genesis',
      resolve: () => {
        throw new Error('unused until protected transport attaches');
      },
      snapshotUpload: { canUpload: () => false },
    };
    const runtime = await createWorkspaceRuntime({
      content,
      e2ee: { bucketId: () => 'synthetic-encrypted-content', createTokenProvider: provider },
      accountId: 'synthetic-account',
      e2eeLocalIdentity: {
        accountId: 'synthetic-account',
        workspaceId: 'workspace-1',
        genesisHash: '11'.repeat(32),
        signingPublicKey: '22'.repeat(32),
      },
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      syncMode: 'dual',
    });
    try {
      expect(runtime.contentMode).toBe('e2ee');
      await expect(runtime.ensureDocStream('encrypted-session')).resolves.toBeUndefined();
      await expect(
        runtime.requestFilePreview('machine-1' as MachineId, {} as never)
      ).resolves.toMatchObject({
        status: 'error',
        code: 'permission_denied',
        retryable: false,
      });
      const schedule = await runtime.acquireScheduleStore('schedule-1');
      expect(schedule.roomId).toBe('schedule-schedule-1');
      expect(await repo.openPersistedDoc(schedule.roomId)).toBeDefined();
      runtime.releaseScheduleStoreRef('schedule-1');
      expect(cloudAttachCalls()).toEqual([]);
      expect(mocks.authInvocations).toEqual([]);
      mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));
      await runtime.setAuthToken('synthetic');
      const adapter = mocks.streamsTransportConstructors.mock.calls.at(-1)?.[0] as {
        bucketId: string;
        payloadProtection: unknown;
      };
      expect(adapter.bucketId).toBe('synthetic-encrypted-content');
      expect(adapter.payloadProtection).toBeDefined();
      expect(mocks.presenceStart.mock.calls.at(-1)?.[0]).toMatchObject({
        bucketId: 'synthetic-encrypted-content',
      });
      expect(mocks.machineRpcConstructors.mock.calls).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });
});
