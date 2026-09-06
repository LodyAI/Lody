import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId, SessionId, WorkspaceId } from '@lody/shared';

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
  const listDoc = vi.fn(async () => []);
  const watch = vi.fn(() => ({ unsubscribe: vi.fn() }));
  const joinMetaRoom = vi.fn();
  const remoteCursorDelete = vi.fn(async () => {});
  const tokenProviderInvalidate = vi.fn();
  const presenceStart = vi.fn();
  const presenceStop = vi.fn(async () => {});
  const streamsConnect = vi.fn(async () => undefined);
  const streamsTransportConstructors = vi.fn();
  const machineRpcConstructors = vi.fn();
  const machineRpcStart = vi.fn(async () => {});
  const machineRpcStop = vi.fn();
  const accountProfiles = vi.fn(async () => null);
  const accountSwitch = vi.fn(async () => null);
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

  return {
    setTransportAdapter,
    addTransport,
    removeTransport,
    refreshTransportRoutes,
    transportRooms,
    flush,
    destroy,
    reconnect,
    listDoc,
    watch,
    joinMetaRoom,
    remoteCursorDelete,
    tokenProviderInvalidate,
    presenceStart,
    presenceStop,
    streamsConnect,
    streamsTransportConstructors,
    machineRpcConstructors,
    machineRpcStart,
    machineRpcStop,
    accountProfiles,
    accountSwitch,
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

vi.mock('loro-repo', () => ({
  LoroRepo: {
    create: vi.fn(async () => ({
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
      watch: mocks.watch,
    })),
  },
}));

vi.mock('loro-repo/storage/indexeddb', () => ({
  IndexedDBStorageAdaptor: class IndexedDBStorageAdaptor {
    constructor(readonly options: unknown) {}
  },
}));

vi.mock('loro-repo/transport/streams', () => ({
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
  StreamsCrdt: class StreamsCrdt {},
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
    requestAccountProfiles = mocks.accountProfiles;
    requestSessionAccountSwitch = mocks.accountSwitch;
    requestCodeCollabOpenTurnDiff = mocks.machineRpcOpenTurnDiff;
  },
  LORO_STREAMS_RPC_RETENTION_SECONDS: 60,
}));

vi.mock('@lody/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lody/shared')>();
  return {
    ...actual,
    buildLoroStreamsTokenEndpoint: vi.fn(
      () => 'https://tokens.example.test/api/loro-streams/token'
    ),
    createLoroStreamsTokenProvider: vi.fn(() => ({
      getToken: vi.fn(async () => 'streams-token'),
      invalidate: mocks.tokenProviderInvalidate,
      getGatewayBaseUrl: vi.fn(() => actual.DEFAULT_LORO_STREAMS_BASE_URL),
      getShardHostSuffix: vi.fn(() => undefined),
      createAuthCallback: vi.fn(() => async () => 'streams-token'),
    })),
  };
});

import { createWorkspaceRuntime } from '../src/providers/create-workspace-runtime';

describe('createWorkspaceRuntime meta recovery lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.setTransportAdapter.mockClear();
    mocks.addTransport.mockClear();
    mocks.removeTransport.mockClear();
    mocks.refreshTransportRoutes.mockClear();
    mocks.transportRooms.mockClear();
    mocks.flush.mockClear();
    mocks.destroy.mockClear();
    mocks.reconnect.mockClear();
    mocks.listDoc.mockClear();
    mocks.watch.mockClear();
    mocks.joinMetaRoom.mockReset();
    mocks.remoteCursorDelete.mockClear();
    mocks.tokenProviderInvalidate.mockClear();
    mocks.presenceStart.mockClear();
    mocks.presenceStop.mockClear();
    mocks.streamsConnect.mockReset();
    mocks.streamsConnect.mockResolvedValue(undefined);
    mocks.streamsTransportConstructors.mockClear();
    mocks.machineRpcConstructors.mockClear();
    mocks.machineRpcStart.mockClear();
    mocks.machineRpcStop.mockClear();
    mocks.accountProfiles.mockClear();
    mocks.accountSwitch.mockClear();
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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

    await runtime.dispose();
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

  it('rejects remote account operations before opening a machine RPC request', async () => {
    mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));
    enableElectronLocalDataPlane();
    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
    });
    runtime.setLocalMachineId('local-machine' as MachineId);
    await runtime.setAuthToken('auth-token');
    const envelope = {
      machineId: 'remote-machine' as MachineId,
      workspaceId: 'workspace-1' as WorkspaceId,
      requestId: 'request-1',
    };
    await expect(
      runtime.requestAccountProfiles({
        ...envelope,
        type: 'machine/account-profiles',
        cliType: 'builtin',
        agentType: 'codex',
        action: 'list',
      })
    ).rejects.toThrow('Account profiles require a local connection to this machine.');
    await expect(
      runtime.requestSessionAccountSwitch({
        ...envelope,
        type: 'session/account-switch',
        sessionId: 'session-1' as SessionId,
        accountProfileId: 'system-default',
      })
    ).rejects.toThrow('Account switching requires a local connection to this machine.');
    expect(mocks.accountProfiles).not.toHaveBeenCalled();
    expect(mocks.accountSwitch).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('keeps account operations on local IPC and returns the matching response', async () => {
    mocks.joinMetaRoom.mockResolvedValueOnce(createMetaSub(Promise.resolve()));
    enableElectronLocalDataPlane();
    let rejectControl = false;
    const invoke = vi.fn(
      async (channel: string, payload?: { message: { type: string; requestId: string } }) => {
        if (channel !== 'sessionControl.send') return channel === 'loro.isConnected';
        if (rejectControl) return { ok: false, error: 'local authorization denied' };
        const request = payload!.message;
        const response = {
          type:
            request.type === 'machine/account-profiles'
              ? 'machine/account-profiles_response'
              : 'session/account-switch_response',
          machineId: 'local-machine',
          requestId: request.requestId,
          ...(request.type === 'session/account-switch'
            ? { sessionId: 'session-1', accountProfileId: 'system-default' }
            : { profiles: [] }),
          success: true,
        };
        return { ok: true, responses: [{ ...response, requestId: 'unrelated-request' }, response] };
      }
    );
    Object.assign(window.ipc!, { invoke });
    const runtime = await createWorkspaceRuntime({
      workspaceSlug: 'workspace',
      workspaceId: 'workspace-1' as WorkspaceId,
      apiBaseUrl: 'https://api.example.test',
      token: 'auth-token',
    });
    runtime.setLocalMachineId('local-machine' as MachineId);
    const envelope = {
      machineId: 'local-machine' as MachineId,
      workspaceId: 'workspace-1' as WorkspaceId,
      requestId: 'request-1',
    };
    await expect(
      runtime.requestAccountProfiles({
        ...envelope,
        type: 'machine/account-profiles',
        cliType: 'builtin',
        agentType: 'codex',
        action: 'list',
      })
    ).resolves.toMatchObject({ success: true, requestId: 'request-1', profiles: [] });
    await expect(
      runtime.requestSessionAccountSwitch({
        ...envelope,
        type: 'session/account-switch',
        sessionId: 'session-1' as SessionId,
        accountProfileId: 'system-default',
      })
    ).resolves.toMatchObject({
      success: true,
      requestId: 'request-1',
      accountProfileId: 'system-default',
    });
    expect(invoke.mock.calls.filter(([channel]) => channel === 'sessionControl.send')).toHaveLength(
      2
    );
    rejectControl = true;
    await expect(
      runtime.requestSessionAccountSwitch({
        ...envelope,
        type: 'session/account-switch',
        sessionId: 'session-1' as SessionId,
        accountProfileId: 'system-default',
      })
    ).rejects.toThrow('local authorization denied');
    expect(mocks.accountProfiles).not.toHaveBeenCalled();
    expect(mocks.accountSwitch).not.toHaveBeenCalled();
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
});
