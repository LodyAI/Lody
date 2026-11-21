import { ScheduleRepository } from '@lody/shared/schedule-repository';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLoroStreamsTokenProviderLegacy,
  getSessionRoomId,
  type MachineId,
  type SessionId,
  type WorkspaceId} from '@lody/shared';
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
    closeHandler: null as null | (() => Promise<void>),
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
    joinFlockDocRoom = vi.fn();
    syncFlockDoc = vi.fn();
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
        close: async () => {
          await mocks.encryptedAcpTransport.closeHandler?.();
        },
      } as ReturnType<typeof actual.createEncryptedDispatchLegacy>;
    },
  };
});

import { createWorkspaceRuntime } from '../src/providers/create-workspace-runtime';
import { META_REMOTE_CURSOR_BYPASS_STORAGE_KEY_PREFIX } from '../src/lib/clear-local-cache';
import { waitForWorkspaceContentAdmission } from '../src/providers/workspace-mode-admission';
import {
  type FakeMetaSub,
  createMetaSub,
  flushPromises,
} from './create-workspace-runtime-meta-recovery-test-helpers';

describe('createWorkspaceRuntime meta recovery lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    mocks.encryptedAcpTransport.handler = null;
    mocks.encryptedAcpTransport.closeHandler = null;
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

  const cloudRemovals = () =>
    mocks.removeTransport.mock.calls.filter(([transportId]) => transportId === 'cloud');

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
    // discover it via repo.transportRooms('cloud') and repair the cloud member.
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
    // Keep the document dual-homed with resolved local ownership.
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

    const fullStreamReads: number[] = [];
    const failedAt = Date.now();
    const brokenRejoin = async () => {
      fullStreamReads.push(Date.now() - failedAt);
    };
    mocks.transportRooms.mockReturnValue([
      {
        room: { kind: 'doc', id: 'machine-local-machine' },
        subscription: { status: 'error', rejoin: brokenRejoin },
      },
    ]);
    await vi.advanceTimersByTimeAsync(120_000);
    await flushPromises();
    // The 60s backstop discovers the room; only its own rejoin repairs failed
    // attaches. Persistent error then waits 30s, followed by a full 60s.
    expect(fullStreamReads).toEqual([60_000, 90_000]);
    expect(mocks.reconnect).not.toHaveBeenCalled();

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

  it('re-joins and syncs a session room after a pending initial sync outlives the release delay', async () => {
    const { LoroRepo: RealRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
    const sessionId = 'wedge-variant-a' as SessionId;
    const roomId = getSessionRoomId(sessionId);
    const joinAttempts: Array<{
      resolveFirstSync: () => void;
      unsubscribed: boolean;
    }> = [];
    const repo = await RealRepo.create({
      metaDebounceCommitMs: 0,
      resolveRoomTransports: () => ({ transportIds: ['local'] }),
    });
    const adapter: TransportAdapter = {
      connect: async () => {},
      close: async () => {},
      isConnected: () => true,
      getStatus: () => 'connected',
      onStatusChange: () => () => {},
      reconnect: async () => {},
      syncMeta: async () => ({ ok: true }),
      syncDoc: async () => ({ ok: true }),
      joinMetaRoom: () => ({
        status: 'joined',
        firstSyncedWithRemote: Promise.resolve(),
        onStatusChange: () => () => {},
        unsubscribe: () => {},
        waitUntilSynced: async () => {},
        rejoin: async () => {},
      }),
      joinDocRoom: (docId) => {
        let resolveFirstSync!: () => void;
        const firstSyncedWithRemote = new Promise<void>((resolve) => {
          resolveFirstSync = resolve;
        });
        const record = { resolveFirstSync, unsubscribed: false };
        if (docId === roomId) {
          joinAttempts.push(record);
        } else {
          resolveFirstSync();
        }
        let status: 'connecting' | 'joined' | 'disconnected' =
          docId === roomId ? 'connecting' : 'joined';
        const listeners = new Set<(next: typeof status) => void>();
        return {
          get status() {
            return status;
          },
          firstSyncedWithRemote: firstSyncedWithRemote.then(() => {
            if (!record.unsubscribed) {
              status = 'joined';
              for (const listener of listeners) listener(status);
            }
          }),
          onStatusChange: (listener) => {
            listeners.add(listener);
            listener(status);
            return () => listeners.delete(listener);
          },
          unsubscribe: () => {
            // Mirrors LocalLoroTransportAdapter.closeRoom: tearing down a room
            // marks status disconnected without resolving firstSyncedWithRemote.
            record.unsubscribed = true;
            status = 'disconnected';
            for (const listener of listeners) listener(status);
          },
          waitUntilSynced: async () => {},
          rejoin: async () => {},
        };
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
    let releaseSecondLease: (() => void) | null = null;
    try {
      const releaseFirstLease = store.acquireSync();
      await vi.advanceTimersByTimeAsync(10);
      expect(joinAttempts).toHaveLength(1);
      expect(store.getSyncState()).toBe('connecting');

      // User navigates away for >2s while the first join is still waiting on
      // firstSyncedWithRemote; stopSyncNow tears the first subscription down.
      releaseFirstLease();
      await vi.advanceTimersByTimeAsync(2_500);
      expect(joinAttempts[0]?.unsubscribed).toBe(true);
      expect(store.getSyncState()).toBe('idle');

      // User switches back: the store must start a fresh join instead of
      // hanging forever on the first attempt's unsettled firstSyncedWithRemote.
      releaseSecondLease = store.acquireSync();
      await vi.advanceTimersByTimeAsync(10);
      expect(joinAttempts).toHaveLength(2);

      joinAttempts[1]!.resolveFirstSync();
      await flushPromises();
      expect(store.getSyncState()).toBe('synced');
      await expect(store.firstSynced).resolves.toBeUndefined();
      const inspection = await store.inspectSync({ uploadProbeTimeoutMs: 50 });
      expect(inspection).toMatchObject({
        transportId: 'local',
        bindingStatus: 'joined',
        syncState: 'synced',
        leaseCount: 1,
        joinInFlight: false,
        roomSubPresent: true,
      });
    } finally {
      releaseSecondLease?.();
      runtime.releaseSessionStoreRef(sessionId);
      await runtime.dispose();
    }
  });

  it('retains a live synced session room when first sync finishes during the 2s release grace period and a lease returns', async () => {
    const { LoroRepo: RealRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
    const sessionId = 'wedge-variant-b' as SessionId;
    const roomId = getSessionRoomId(sessionId);
    let resolveFirstSync!: () => void;
    let unsubscribedCount = 0;
    const repo = await RealRepo.create({
      metaDebounceCommitMs: 0,
      resolveRoomTransports: () => ({ transportIds: ['local'] }),
    });
    const adapter: TransportAdapter = {
      connect: async () => {},
      close: async () => {},
      isConnected: () => true,
      getStatus: () => 'connected',
      onStatusChange: () => () => {},
      reconnect: async () => {},
      syncMeta: async () => ({ ok: true }),
      syncDoc: async () => ({ ok: true }),
      joinMetaRoom: () => ({
        status: 'joined',
        firstSyncedWithRemote: Promise.resolve(),
        onStatusChange: () => () => {},
        unsubscribe: () => {},
        waitUntilSynced: async () => {},
        rejoin: async () => {},
      }),
      joinDocRoom: (docId) => {
        const firstSyncedWithRemote =
          docId === roomId
            ? new Promise<void>((resolve) => {
                resolveFirstSync = resolve;
              })
            : Promise.resolve();
        let status: 'joined' | 'disconnected' = 'joined';
        const listeners = new Set<(next: typeof status) => void>();
        return {
          get status() {
            return status;
          },
          firstSyncedWithRemote,
          onStatusChange: (listener) => {
            listeners.add(listener);
            listener(status);
            return () => listeners.delete(listener);
          },
          unsubscribe: () => {
            if (docId === roomId) unsubscribedCount += 1;
            status = 'disconnected';
            for (const listener of listeners) listener(status);
          },
          waitUntilSynced: async () => {},
          rejoin: async () => {},
        };
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
    let releaseReturnedLease: (() => void) | null = null;
    try {
      const releaseFirstLease = store.acquireSync();
      await vi.advanceTimersByTimeAsync(10);

      // User briefly switches tabs (<2s): lease count drops to 0 and the 2s
      // debounce timer starts, then firstSyncedWithRemote lands inside that
      // window before the user switches back.
      releaseFirstLease();
      await vi.advanceTimersByTimeAsync(100);
      resolveFirstSync();
      await flushPromises();

      releaseReturnedLease = store.acquireSync();
      await vi.advanceTimersByTimeAsync(2_500);

      expect(unsubscribedCount).toBe(0);
      expect(store.getSyncState()).toBe('synced');
      const inspection = await store.inspectSync({ uploadProbeTimeoutMs: 50 });
      expect(inspection).toMatchObject({
        bindingStatus: 'joined',
        syncState: 'synced',
        leaseCount: 1,
        roomSubPresent: true,
      });
    } finally {
      releaseReturnedLease?.();
      runtime.releaseSessionStoreRef(sessionId);
      await runtime.dispose();
    }
  });

  it('fences a superseded join attempt when another lease keeps the Repo room alive across stopSyncNow', async () => {
    const { LoroRepo: RealRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
    const sessionId = 'wedge-variant-c' as SessionId;
    const roomId = getSessionRoomId(sessionId);
    let resolveSharedSync!: () => void;
    const repo = await RealRepo.create({
      metaDebounceCommitMs: 0,
      resolveRoomTransports: () => ({ transportIds: ['local'] }),
    });
    const adapter: TransportAdapter = {
      connect: async () => {},
      close: async () => {},
      isConnected: () => true,
      getStatus: () => 'connected',
      onStatusChange: () => () => {},
      reconnect: async () => {},
      syncMeta: async () => ({ ok: true }),
      syncDoc: async () => ({ ok: true }),
      joinMetaRoom: () => ({
        status: 'joined',
        firstSyncedWithRemote: Promise.resolve(),
        onStatusChange: () => () => {},
        unsubscribe: () => {},
        waitUntilSynced: async () => {},
        rejoin: async () => {},
      }),
      joinDocRoom: (docId) => ({
        status: 'joined',
        firstSyncedWithRemote:
          docId === roomId
            ? new Promise<void>((resolve) => {
                resolveSharedSync = resolve;
              })
            : Promise.resolve(),
        onStatusChange: (listener) => {
          listener('joined');
          return () => {};
        },
        unsubscribe: () => {},
        waitUntilSynced: async () => {},
        rejoin: async () => {},
      }),
    };
    const add = repo.addTransport.bind(repo);
    vi.spyOn(repo, 'addTransport').mockImplementation((id, _adapter, options) =>
      add(id, adapter, options)
    );
    mocks.repoOverride = repo;
    enableElectronLocalDataPlane();
    await repo.upsertDocMeta(roomId, { id: sessionId, machineId: 'local-machine' });

    // External caller holds a lease on the same Repo room so stopSyncNow's
    // unsubscribe only decrements refCount without tearing down the room.
    const externalSub = await repo.joinDocRoom(roomId);
    const runtime = await createWorkspaceRuntime({
      content: { mode: 'plaintext' },
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
    });
    runtime.setLocalMachineId('local-machine' as MachineId);
    const store = await runtime.acquireSessionStore(sessionId);
    let releaseSecondLease: (() => void) | null = null;
    try {
      const releaseFirstLease = store.acquireSync();
      await vi.advanceTimersByTimeAsync(10);

      releaseFirstLease();
      await vi.advanceTimersByTimeAsync(2_500);

      // Re-acquire BEFORE the shared firstSyncedWithRemote resolves, then drop
      // the external lease after sync completes: if the store's first attempt
      // resurrected its already-unsubscribed handle into roomSub, releasing
      // externalSub would drop refCount to 0 and detach the room!
      releaseSecondLease = store.acquireSync();
      await vi.advanceTimersByTimeAsync(10);
      resolveSharedSync();
      await flushPromises();
      externalSub.unsubscribe();
      await flushPromises();

      expect(store.getSyncState()).toBe('synced');
      const inspection = await store.inspectSync({ uploadProbeTimeoutMs: 50 });
      expect(inspection.bindingStatus).toBe('joined');
    } finally {
      externalSub.unsubscribe();
      releaseSecondLease?.();
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

  it.each(['acknowledged', 'stalled'] as const)(
    'cancels activated encrypted ACP before dispatch close and preserves cleanup on retry (%s)',
    async (mode) => {
      vi.useRealTimers();
      const { LoroRepo: RealRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
      const repo = await RealRepo.create({});
      mocks.repoOverride = repo;
      await repo.upsertDocMeta('machine-remote-machine', {
        protocolCapabilities: { e2eeAcpInteraction: 1 },
      });
      const device = '22'.repeat(32);
      const activated = Promise.withResolvers<void>();
      const events: string[] = [];
      let cancelSignal: AbortSignal | undefined;
      let interactionId = '';
      let closeAttempts = 0;
      mocks.encryptedAcpTransport.handler = async (request, options) => {
        const action = request.params.action;
        events.push(action);
        options.onPrepared?.(device);
        if (action === 'start') interactionId = options.requestId;
        if (action === 'activate') activated.resolve();
        if (action === 'cancel' && mode === 'stalled') {
          cancelSignal = options.signal;
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('cancel aborted')), {
              once: true,
            });
          });
        }
        return {
          ok: true,
          result: {
            type: 'machine/acp-interaction',
            interactionRequestId: interactionId,
            state: action === 'cancel' ? 'cancelled' : 'running',
          },
        };
      };
      mocks.encryptedAcpTransport.closeHandler = async () => {
        events.push('close');
        if (++closeAttempts === 1) throw new Error('synthetic close failure');
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
        waitForContentAdmission: async (signal) => {
          signal.throwIfAborted();
        },
        e2eeLocalIdentity: {
          accountId: 'account',
          workspaceId: 'workspace-1',
          genesisHash: '11'.repeat(32),
          signingPublicKey: device,
        },
      });
      const machine = 'remote-machine' as MachineId;
      const requestId = '01234567-89ab-4cde-8fab-0123456789ab';
      try {
        runtime.sendControl({
          type: 'machine/acp-authenticate',
          action: 'start',
          workspaceId: 'workspace-1',
          machineId: machine,
          configId: 'config',
          requestId,
        } as never);
        await activated.promise;
        if (mode === 'stalled') vi.useFakeTimers();
        const first = runtime.dispose();
        const firstFailed = expect(first).rejects.toThrow('synthetic close failure');
        if (mode === 'stalled') {
          await vi.advanceTimersByTimeAsync(2000);
          expect(cancelSignal?.aborted).toBe(true);
        }
        await firstFailed;
        expect(events.slice(0, 4)).toEqual(['start', 'activate', 'cancel', 'close']);
        await expect(runtime.dispose()).resolves.toBeUndefined();
        expect(events.filter((value) => value === 'cancel')).toEqual(['cancel']);
        expect(events.filter((value) => value === 'close')).toEqual(['close', 'close']);
      } finally {
        await runtime.dispose().catch(() => {});
        await access.close();
        vi.useRealTimers();
      }
    }
  );

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
