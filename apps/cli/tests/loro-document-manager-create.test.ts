import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
  type LocalLoroDataPlaneServerMessage,
} from '@lody/shared/local-loro-data-plane';
import { LocalLoroDataPlaneServerLegacy } from '@lody/shared/local-loro-data-plane-server';
import type { WorkspaceId } from '@lody/shared';
import { InMemoryRemoteCursorStore } from '@loro-dev/streams-crdt';
import { RepoSyncError, RepoTransportError, type RepoSyncReport } from 'loro-repo';

import { Effect, Layer } from 'effect';
import {
  makeLoroStreamsTokenProvider,
  makeLoroStreamsTokenWebPorts,
  LoroStreamsTokenPorts,
  type LodyPresenceInstanceId,
} from '@lody/shared';
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime';
import {
  PresenceHost,
  PresenceTransport,
  WorkspacePresenceOwnersLive,
} from '../src/lib/loro/workspace-presence';
import {
  bindWorkspacePresenceApplicationLegacy,
  recoverCliPresenceApplicationShutdown,
  WorkspacePresenceLegacyFailure,
  createCliPresenceRuntimeLegacy,
} from '../src/lib/loro/presence-legacy';
const testPresenceLayer = WorkspacePresenceOwnersLive.pipe(
  Layer.provide(
    Layer.merge(
      Layer.succeed(PresenceHost, {
        instanceId: () => 'synthetic-document-manager' as LodyPresenceInstanceId,
        serverOffsetMs: () => 0,
        report: () => {},
      }),
      Layer.succeed(PresenceTransport, {
        isReleaseFailure: () => false,
        create: () =>
          Effect.succeed({
            stats: {
              status: 'joined',
              pendingLocalCount: 0,
              physicalEntries: 0,
              queuedBytes: 0,
              releasePending: 0,
            },
            join: ({ onStatusChange }) =>
              Effect.sync(() => {
                onStatusChange('joined');
                return { syncBarrier: () => Effect.void };
              }),
            close: Effect.void,
            rejoin: Effect.void,
            retryRelease: Effect.void,
          }),
      })
    )
  )
);
let presenceApplication: ReturnType<typeof makeApplicationRuntime>;
beforeEach(() => {
  const app = makeApplicationRuntime(testPresenceLayer, {
    recover: recoverCliPresenceApplicationShutdown,
    project: (cause) => new WorkspacePresenceLegacyFailure(cause),
  });
  presenceApplication = app;
  bindWorkspacePresenceApplicationLegacy(app);
});
afterEach(() => presenceApplication.closeLegacy());

import type { Logger } from '../src/utils/logger';
import * as logging from '../src/utils/logger';
import { CliMachineMonitorRuntime } from '../src/lib/loro/machine-monitor';

// The production interceptors install once for the whole module lifetime. Keep
// these underlying delegates stable across tests, regardless of which test first
// attaches Streams, and restore the real globals only when the suite finishes.
const originalConsoleError = console.error;
const originalFetch = globalThis.fetch;
let diagnosticConsoleSink: typeof console.error | undefined;
let diagnosticFetch: typeof fetch | undefined;
beforeAll(() => {
  console.error = (...args: unknown[]) =>
    (diagnosticConsoleSink ?? originalConsoleError).apply(console, args);
  globalThis.fetch = (input, init) => (diagnosticFetch ?? originalFetch)(input, init);
});
afterAll(() => {
  console.error = originalConsoleError;
  globalThis.fetch = originalFetch;
});

const mocks = vi.hoisted(() => ({
  repoCreate: vi.fn(),
  repoAddTransport: vi.fn(async () => {}),
  repoRemoveTransport: vi.fn(async () => {}),
  repoTransportRooms: vi.fn(() => []),
  transportClose: vi.fn(async () => {}),
  streamsGetToken: vi.fn(async () => 'streams-jwt'),
  sqliteClose: vi.fn(),
  transportStatus: 'connected',
  transportOptions: [] as unknown[],
  cliHttpFetch: vi.fn(),
  installCliHttpGlobalDispatcher: vi.fn(),
  streamsGatewayBaseUrl: 'https://streams.example.test',
}));

vi.mock('loro-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('loro-repo')>();
  return {
    ...actual,
    LoroRepo: {
      create: mocks.repoCreate,
    },
    RepoDocHandle: class RepoDocHandle {},
    RepoWatchHandle: class RepoWatchHandle {},
    TransportSubscription: class TransportSubscription {},
  };
});

vi.mock('loro-repo/transport/streams', () => {
  class MockStreamsTransportAdapter {
    constructor(options: unknown) {
      mocks.transportOptions.push(options);
    }

    connect = vi.fn(async () => {});
    close = mocks.transportClose;
    isConnected = vi.fn(() => mocks.transportStatus === 'connected');
    getStatus = vi.fn(() => mocks.transportStatus);
    onStatusChange = vi.fn(() => () => {});
  }

  return {
    StreamsTransportAdapter: MockStreamsTransportAdapter,
    // Real replica-bound persistence is covered with a real SqliteRepoStore in
    // tests/cli-streams-replica-checkpoints.test.ts.
    createRepoStreamsPersistence: (_repo: unknown, options: object) => ({
      mode: 'replica-bound',
      ...options,
    }),
  };
});

vi.mock('loro-repo/storage/sqlite', () => ({
  SqliteRepoStore: class SqliteRepoStore {
    storage = {};
    cursorStore = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    close = mocks.sqliteClose;
  },
}));

vi.mock('../src/utils/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/const')>();
  return {
    ...actual,
    LODY_AUTH_URL: 'https://convex.example.test',
    LODY_AUTH_SITE_URL: undefined,
  };
});

vi.mock('@/utils/http-transport', () => ({
  getCliHttpFetch: vi.fn(() => mocks.cliHttpFetch),
  installCliHttpGlobalDispatcher: mocks.installCliHttpGlobalDispatcher,
}));

import { LoroDocumentManager } from '../src/lib/loro/doc';
import { createCliSqliteRepoStore } from '../src/lib/loro/sqlite-repo-store';

const testStreamsTokens = {
  createTokenProvider: () =>
    makeLoroStreamsTokenProvider({
      endpoint: 'https://synthetic.invalid/token',
      workspaceId: 'workspace-test',
    }).pipe(
      Effect.provideService(
        LoroStreamsTokenPorts,
        makeLoroStreamsTokenWebPorts({
          credential: Effect.succeed('synthetic-credential'),
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                token: await mocks.streamsGetToken(),
                expiresIn: 900,
                gatewayBaseUrl: mocks.streamsGatewayBaseUrl,
              })
            ),
        })
      )
    ),
  createTokenProviderLegacy: () => ({
    getToken: mocks.streamsGetToken,
    getGatewayBaseUrl: () => mocks.streamsGatewayBaseUrl,
    getShardHostSuffix: () => undefined,
    invalidate: () => {},
    close: async () => {},
    retryCleanup: async () => {},
    createAuthCallback: () => async () => 'streams-jwt',
  }),
};

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

const createLoggerWithDebug = (debug: ReturnType<typeof vi.fn>): Logger => ({
  ...createSilentLogger(),
  debug,
  child: () => createLoggerWithDebug(debug),
});

const createMetaSubscription = (
  overrides: Partial<{
    unsubscribe: ReturnType<typeof vi.fn>;
    firstSyncedWithRemote: Promise<void>;
    waitUntilSynced: ReturnType<typeof vi.fn>;
    status: string;
    onStatusChange: ReturnType<typeof vi.fn>;
  }> = {}
) => {
  const status = overrides.status ?? 'joined';
  const sub = {
    unsubscribe: overrides.unsubscribe ?? vi.fn(),
    firstSyncedWithRemote: overrides.firstSyncedWithRemote ?? Promise.resolve(),
    waitUntilSynced: overrides.waitUntilSynced ?? vi.fn(async () => {}),
    status,
    onStatusChange:
      overrides.onStatusChange ??
      vi.fn((listener: (status: string) => void) => {
        listener(status);
        return vi.fn();
      }),
    // Production reads room state through the per-transport 'streams' binding,
    // never the classic surface — a fake without this would exercise a path
    // the code no longer takes.
    subscription: (transportId: string) => ({
      transportId,
      get status() {
        return sub.status;
      },
      firstSyncedWithRemote: sub.firstSyncedWithRemote,
      waitUntilSynced: sub.waitUntilSynced,
      rejoin: vi.fn(async () => {}),
      onStatusChange: sub.onStatusChange,
    }),
    subscriptions: () => [],
    transportIds: () => ['streams'],
  };
  return sub;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const originalSyncTimeoutEnv = process.env.LODY_LORO_SYNC_META_TIMEOUT_MS;
const originalReconnectDelayEnv = process.env.LODY_LORO_AUTO_RECONNECT_DELAY_MS;
const originalReconnectMaxDelayEnv = process.env.LODY_LORO_AUTO_RECONNECT_MAX_DELAY_MS;
const originalReconnectIntervalEnv = process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS;
const originalHomeEnv = process.env.HOME;
let tempHomeDir: string | undefined;

describe('LoroDocumentManager.create degraded startup behavior', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.transportOptions.length = 0;
    mocks.transportStatus = 'connected';
    tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-loro-doc-manager-home-'));
    process.env.HOME = tempHomeDir;
    delete process.env.LODY_LORO_SYNC_META_TIMEOUT_MS;
    delete process.env.LODY_LORO_AUTO_RECONNECT_DELAY_MS;
    delete process.env.LODY_LORO_AUTO_RECONNECT_MAX_DELAY_MS;
    delete process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS;
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (originalHomeEnv === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHomeEnv;
    }
    if (tempHomeDir) {
      await fs.rm(tempHomeDir, { recursive: true, force: true });
      tempHomeDir = undefined;
    }
  });

  afterAll(() => {
    if (originalSyncTimeoutEnv === undefined) {
      delete process.env.LODY_LORO_SYNC_META_TIMEOUT_MS;
    } else {
      process.env.LODY_LORO_SYNC_META_TIMEOUT_MS = originalSyncTimeoutEnv;
    }

    if (originalReconnectDelayEnv === undefined) {
      delete process.env.LODY_LORO_AUTO_RECONNECT_DELAY_MS;
    } else {
      process.env.LODY_LORO_AUTO_RECONNECT_DELAY_MS = originalReconnectDelayEnv;
    }

    if (originalReconnectMaxDelayEnv === undefined) {
      delete process.env.LODY_LORO_AUTO_RECONNECT_MAX_DELAY_MS;
    } else {
      process.env.LODY_LORO_AUTO_RECONNECT_MAX_DELAY_MS = originalReconnectMaxDelayEnv;
    }

    if (originalReconnectIntervalEnv === undefined) {
      delete process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS;
    } else {
      process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS = originalReconnectIntervalEnv;
    }
  });

  it('does not build a remote transport when repo creation fails', async () => {
    mocks.repoCreate.mockRejectedValueOnce(new Error('repo create failed'));

    await expect(
      LoroDocumentManager.create('workspace-1' as WorkspaceId, 'user-1', createSilentLogger(), {
        attachRemoteOnCreate: true,
        streamsTokens: testStreamsTokens,
      })
    ).rejects.toThrow('repo create failed');

    // The remote transport is attached only after the local repo exists.
    expect(mocks.transportOptions).toHaveLength(0);
    expect(mocks.transportClose).toHaveBeenCalledTimes(0);
    expect(mocks.sqliteClose).toHaveBeenCalledTimes(1);
  });

  it('fails create and destroys the repo when joining the meta room fails', async () => {
    const repoDestroy = vi.fn(async () => {});
    const joinMetaRoom = vi.fn(async () => {
      throw new Error('join meta failed');
    });

    mocks.repoCreate.mockResolvedValueOnce({
      joinMetaRoom,
      destroy: repoDestroy,
      addTransport: mocks.repoAddTransport,
      removeTransport: mocks.repoRemoveTransport,
      transportRooms: mocks.repoTransportRooms,
    });

    await expect(
      LoroDocumentManager.create('workspace-2' as WorkspaceId, 'user-1', createSilentLogger(), {
        attachRemoteOnCreate: true,
        streamsTokens: testStreamsTokens,
      })
    ).rejects.toThrow('join meta failed');

    expect(joinMetaRoom).toHaveBeenCalledTimes(1);
    expect(repoDestroy).toHaveBeenCalledTimes(1);
    expect(mocks.transportOptions).toHaveLength(0);
  });

  it('fails create when the streams token cannot be fetched with attachRemoteOnCreate', async () => {
    const repoDestroy = vi.fn(async () => {});
    const repo = {
      destroy: repoDestroy,
      joinMetaRoom: vi.fn(async () => createMetaSubscription()),
      addTransport: mocks.repoAddTransport,
      removeTransport: mocks.repoRemoveTransport,
      transportRooms: mocks.repoTransportRooms,
    };
    mocks.streamsGetToken.mockRejectedValueOnce(new Error('network down'));
    mocks.repoCreate.mockResolvedValueOnce(repo);

    // One-shot callers need durable cloud sync; a silent local-only fallback
    // would strand their writes, so create must surface the failure.
    await expect(
      LoroDocumentManager.create(
        'workspace-local-only' as WorkspaceId,
        'user-1',
        createSilentLogger(),
        { attachRemoteOnCreate: true, streamsTokens: testStreamsTokens }
      )
    ).rejects.toThrow('network down');

    expect(mocks.transportOptions).toHaveLength(0);
    expect(repoDestroy).toHaveBeenCalledTimes(1);
  });

  it('continues in degraded mode when meta room sync times out', async () => {
    process.env.LODY_LORO_SYNC_META_TIMEOUT_MS = '1';

    const unsubscribe = vi.fn();
    const repoDestroy = vi.fn(async () => {});
    let resolveMetaSync: (() => void) | undefined;
    const firstSyncedWithRemote = new Promise<void>((resolve) => {
      resolveMetaSync = resolve;
    });

    mocks.repoCreate.mockResolvedValueOnce({
      joinMetaRoom: vi.fn(async () =>
        createMetaSubscription({
          unsubscribe,
          firstSyncedWithRemote,
        })
      ),
      destroy: repoDestroy,
      addTransport: mocks.repoAddTransport,
      removeTransport: mocks.repoRemoveTransport,
      transportRooms: mocks.repoTransportRooms,
    });

    const manager = await LoroDocumentManager.create(
      'workspace-3' as WorkspaceId,
      'user-1',
      createSilentLogger(),
      { attachRemoteOnCreate: true, streamsTokens: testStreamsTokens }
    );

    // Initial sync timed out — create returns a usable manager in degraded mode.
    expect(manager.hasCompletedInitialMetaSync()).toBe(false);
    expect(repoDestroy).toHaveBeenCalledTimes(0);
    expect(mocks.repoAddTransport).toHaveBeenCalledTimes(1);
    expect(mocks.repoAddTransport).toHaveBeenCalledWith('streams', expect.anything(), {
      ephemeral: true,
    });
    expect(mocks.transportOptions).toHaveLength(1);

    // Once the meta room syncs, an explicit wait succeeds and flips the flag.
    resolveMetaSync?.();
    await expect(
      manager.waitUntilMetaSynced({ timeoutMs: 100, reason: 'test-recovery' })
    ).resolves.toBe(true);
    expect(manager.hasCompletedInitialMetaSync()).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(0);

    await manager.cleanUp({ fast: true });
  });

  it('configures zstd snapshot codec on the streams transport adapter', async () => {
    mocks.repoCreate.mockResolvedValueOnce({
      joinMetaRoom: vi.fn(async () => createMetaSubscription()),
      destroy: vi.fn(async () => {}),
      addTransport: mocks.repoAddTransport,
      removeTransport: mocks.repoRemoveTransport,
      transportRooms: mocks.repoTransportRooms,
    });

    const manager = await LoroDocumentManager.create(
      'workspace-4' as WorkspaceId,
      'user-1',
      createSilentLogger(),
      { attachRemoteOnCreate: true, streamsTokens: testStreamsTokens }
    );

    expect(mocks.transportOptions).toHaveLength(1);
    expect(mocks.transportOptions[0]).toMatchObject({
      baseUrl: mocks.streamsGatewayBaseUrl,
      snapshotCodec: {
        compress: expect.any(Function),
        decompress: expect.any(Function),
      },
    });
    // One-shot commands do not pass a cursor scope: their LoroDoc progress must
    // stay in this process's memory, never the daemon's shared SQLite cursors.
    expect(mocks.transportOptions[0]).toMatchObject({
      persistence: { documentRemoteCursorStore: expect.any(InMemoryRemoteCursorStore) },
    });

    await manager.cleanUp({ fast: true });
  });

  it('keeps process-wide Streams diagnostics out of workspace loggers and follows the root sink', async () => {
    const records: Array<{ sink: string; level: string; message: unknown }> = [];
    const captureLogger = (sink: string): Logger => ({
      ...createSilentLogger(),
      debug: (message) => records.push({ sink, level: 'debug', message }),
      child: () => captureLogger(sink),
    });
    let root = captureLogger('process-before');
    const rootGetter = vi.spyOn(logging, 'getLogger').mockImplementation(() => root);
    // This case exercises diagnostics, not the independent live monitor room.
    const monitorAttach = vi
      .spyOn(CliMachineMonitorRuntime.prototype, 'attachStreams')
      .mockResolvedValue(undefined);
    const managers: LoroDocumentManager[] = [];
    const consoleOutput: unknown[][] = [];
    diagnosticConsoleSink = (...args) => consoleOutput.push(args);
    const response = new Response('missing', { status: 404 });
    const fetchInputs: Array<[Parameters<typeof fetch>[0], RequestInit | undefined]> = [];
    diagnosticFetch = async (input, init) => {
      fetchInputs.push([input, init]);
      return response;
    };
    let installedConsole: typeof console.error | undefined;
    let installedFetch: typeof fetch | undefined;

    try {
      for (const workspaceId of ['workspace-a', 'workspace-b']) {
        mocks.repoCreate.mockResolvedValueOnce({
          joinMetaRoom: vi.fn(async () => createMetaSubscription()),
          destroy: vi.fn(async () => {}),
          addTransport: mocks.repoAddTransport,
          removeTransport: mocks.repoRemoveTransport,
          transportRooms: mocks.repoTransportRooms,
        });
        managers.push(
          await LoroDocumentManager.create(
            workspaceId as WorkspaceId,
            'user-1',
            captureLogger(workspaceId),
            { attachRemoteOnCreate: true, streamsTokens: testStreamsTokens }
          )
        );
        installedConsole ??= console.error;
        installedFetch ??= globalThis.fetch;
        expect(console.error).toBe(installedConsole);
        expect(globalThis.fetch).toBe(installedFetch);
        // Both records concern A, including the one emitted after B attaches.
        console.error('[streams-crdt] local append failed', {
          streamUrl: 'https://streams.example.test/ds/workspace-a%3As%3Asession-1',
        });
      }

      root = captureLogger('process-after');
      console.error('[loro-repo] synthetic failure', 'detail');
      const url = new URL(
        'https://synthetic-user:synthetic-password@streams.example.test/ds/workspace-a?token=synthetic-secret'
      );
      const init = { method: 'POST' };
      expect(await fetch(url, init)).toBe(response);
      expect(fetchInputs).toEqual([[url, init]]);
      expect(await response.text()).toBe('missing');

      expect(
        records.filter(
          ({ message }) => typeof message === 'string' && message.startsWith('[loro-streams-diag]')
        )
      ).toEqual([
        ...['process-before', 'process-before'].map((sink) => ({
          sink,
          level: 'debug',
          message:
            '[loro-streams-diag] [streams-crdt] local append failed {"streamUrl":"https://streams.example.test/ds/workspace-a%3As%3Asession-1"}',
        })),
        {
          sink: 'process-after',
          level: 'debug',
          message: '[loro-streams-diag] [loro-repo] synthetic failure detail',
        },
        {
          sink: 'process-after',
          level: 'debug',
          message:
            '[loro-streams-diag] HTTP 404 from Streams API: POST https://streams.example.test/ds/workspace-a?token=REDACTED',
        },
      ]);

      const count = records.length;
      expect(await fetch('https://other.example.test/missing')).toBe(response);
      const success = new Response('ok');
      diagnosticFetch = async () => success;
      expect(await fetch(url)).toBe(success);
      const failure = new Error('synthetic fetch failure');
      diagnosticFetch = async () => {
        throw failure;
      };
      await expect(fetch(url)).rejects.toBe(failure);
      expect(records).toHaveLength(count);
      const unrelated = { message: 'ordinary error' };
      console.error('other library', unrelated);
      expect(consoleOutput).toEqual([['other library', unrelated]]);
    } finally {
      for (const manager of managers) await manager.cleanUp({ fast: true });
      diagnosticConsoleSink = undefined;
      diagnosticFetch = undefined;
      monitorAttach.mockRestore();
      rootGetter.mockRestore();
    }
  });

  it('installs the CLI HTTP global dispatcher at create without attaching Streams', async () => {
    const logger = createSilentLogger();
    mocks.repoCreate.mockResolvedValueOnce({
      joinMetaRoom: vi.fn(async () => createMetaSubscription()),
      destroy: vi.fn(async () => {}),
      addTransport: mocks.repoAddTransport,
      removeTransport: mocks.repoRemoveTransport,
      transportRooms: mocks.repoTransportRooms,
    });

    const manager = await LoroDocumentManager.create(
      'workspace-http' as WorkspaceId,
      'user-1',
      logger
    );

    // The global HTTP dispatcher is configured unconditionally at create so all
    // CLI HTTP is routed through it, but local-first create defers the Streams
    // transport until the remote bridge attaches (no attachRemoteOnCreate here).
    expect(mocks.installCliHttpGlobalDispatcher).toHaveBeenCalledWith({ logger });
    expect(mocks.transportOptions).toHaveLength(0);

    await manager.cleanUp({ fast: true });
  });

  it('marks initial meta sync as ready when startup sync succeeds', async () => {
    const waitUntilSynced = vi.fn(async () => {});
    const syncedListener = vi.fn();

    mocks.repoCreate.mockResolvedValueOnce({
      joinMetaRoom: vi.fn(async () => createMetaSubscription({ waitUntilSynced })),
      destroy: vi.fn(async () => {}),
      addTransport: mocks.repoAddTransport,
      removeTransport: mocks.repoRemoveTransport,
      transportRooms: mocks.repoTransportRooms,
    });

    const manager = await LoroDocumentManager.create(
      'workspace-5' as WorkspaceId,
      'user-1',
      createSilentLogger(),
      { attachRemoteOnCreate: true, streamsTokens: testStreamsTokens }
    );

    expect(manager.hasCompletedInitialMetaSync()).toBe(true);
    await expect(manager.waitForInitialMetaSync({ timeoutMs: 1 })).resolves.toBe(true);

    manager.onMetaRoomSynced(syncedListener);
    await Promise.resolve();
    await Promise.resolve();

    // Create's attach path confirmed pending writes exactly once; the listener
    // attached afterwards must not fire retroactively.
    expect(waitUntilSynced).toHaveBeenCalledTimes(1);
    expect(syncedListener).not.toHaveBeenCalled();

    await manager.cleanUp({ fast: true });
  });

  it('starts local-first without attaching Streams by default', async () => {
    const repoDestroy = vi.fn(async () => {});
    mocks.repoCreate.mockResolvedValueOnce({
      joinMetaRoom: vi.fn(async () => createMetaSubscription()),
      destroy: repoDestroy,
      addTransport: mocks.repoAddTransport,
      removeTransport: mocks.repoRemoveTransport,
      transportRooms: mocks.repoTransportRooms,
    });

    const manager = await LoroDocumentManager.create(
      'workspace-local-first' as WorkspaceId,
      'user-1',
      createSilentLogger()
    );

    expect(mocks.streamsGetToken).not.toHaveBeenCalled();
    expect(mocks.transportOptions).toHaveLength(0);
    // Local-first create registers no transport: rooms stay pending/detached
    // until the remote bridge attaches Streams.
    expect(mocks.repoAddTransport).not.toHaveBeenCalled();

    await manager.cleanUp({ fast: true });
    expect(repoDestroy).toHaveBeenCalledTimes(1);
  });

  it('logs meta room status changes', async () => {
    const debug = vi.fn();
    const statusListeners: Array<(status: string) => void> = [];
    const repoDestroy = vi.fn(async () => {});

    mocks.repoCreate.mockResolvedValueOnce({
      joinMetaRoom: vi.fn(async () =>
        createMetaSubscription({
          status: 'connecting',
          onStatusChange: vi.fn((listener: (status: string) => void) => {
            statusListeners.push(listener);
            listener('connecting');
            return vi.fn();
          }),
        })
      ),
      destroy: repoDestroy,
      addTransport: mocks.repoAddTransport,
      removeTransport: mocks.repoRemoveTransport,
      transportRooms: mocks.repoTransportRooms,
    });

    const manager = await LoroDocumentManager.create(
      'workspace-6' as WorkspaceId,
      'user-1',
      createLoggerWithDebug(debug)
    );

    statusListeners[0]?.('joined');

    expect(debug).toHaveBeenCalledWith('[workspace-6] Loro meta room status: connecting');
    expect(debug).toHaveBeenCalledWith(
      '[workspace-6] Loro meta room status: joined (was connecting)'
    );

    await manager.cleanUp({ fast: true });
  });

  it('sweeps rooms via repo.reconnect on the healthy watchdog tick', async () => {
    // The healthy-path watchdog now runs a pure room sweep (repo.reconnect with
    // resetBackoff:false) instead of early-returning, so a doc/flock room stuck
    // in 'error' behind a healthy transport+meta is rejoined without a daemon
    // restart. See connection-recovery.ts sweepRooms + connection-recovery.test.ts.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS = '10';
    const joinMetaRoom = vi.fn(async () => createMetaSubscription());
    const repoReconnect = vi.fn(async () => {});

    mocks.repoCreate.mockResolvedValueOnce({
      joinMetaRoom,
      reconnect: repoReconnect,
      destroy: vi.fn(async () => {}),
      addTransport: mocks.repoAddTransport,
      removeTransport: mocks.repoRemoveTransport,
      transportRooms: mocks.repoTransportRooms,
    });

    const manager = await LoroDocumentManager.create(
      'workspace-7' as WorkspaceId,
      'user-1',
      createSilentLogger()
    );

    await Promise.resolve();
    repoReconnect.mockClear();
    joinMetaRoom.mockClear();

    await vi.advanceTimersByTimeAsync(35);

    expect(repoReconnect).toHaveBeenCalled();
    expect(repoReconnect).toHaveBeenCalledWith({ resetBackoff: false, timeout: 10_000 });
    // A healthy sweep must skip the meta-ready ceremony so it never re-fires
    // meta-synced listeners (provider registration / Code Collab reconcile).
    expect(joinMetaRoom).not.toHaveBeenCalled();

    await manager.cleanUp({ fast: true });
  });

  it('settles a queued manual reconnect when cleanup runs first', async () => {
    process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS = '0';

    let resolveMetaSync: (() => void) | undefined;
    const firstSyncedWithRemote = new Promise<void>((resolve) => {
      resolveMetaSync = resolve;
    });
    const metaSub = createMetaSubscription({
      firstSyncedWithRemote,
      status: 'joined',
      onStatusChange: vi.fn(() => vi.fn()),
    });
    const repo = {
      destroy: vi.fn(async () => {}),
      joinMetaRoom: vi.fn(async () => metaSub),
      reconnect: vi.fn(async () => {}),
    } as unknown as LoroDocumentManager['repo'];
    const manager = new LoroDocumentManager({
      repo,
      workspaceId: 'workspace-8' as WorkspaceId,
      userId: 'user-1',
      metaSub,
      logger: createSilentLogger(),
      initialTransportStatus: 'connected',
      initialMetaSyncPromise: Promise.resolve(false),
      initialMetaSyncCompleted: false,
    });

    await Promise.resolve();
    const reconnectPromise = manager.reconnectTransport();
    const cleanupPromise = manager.cleanUp({ fast: true });
    const reconnectResult = await Promise.race([
      reconnectPromise.then(() => 'settled'),
      new Promise<'timed-out'>((resolve) => {
        setTimeout(() => resolve('timed-out'), 100);
      }),
    ]);

    resolveMetaSync?.();
    await cleanupPromise;
    await reconnectPromise;
    expect(reconnectResult).toBe('settled');
  });

  it('does not confirm a remote document sync when Streams is not attached', async () => {
    process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS = '0';
    const metaSub = createMetaSubscription();
    const sync = vi.fn(async () => {});
    const repo = {
      destroy: vi.fn(async () => {}),
      joinMetaRoom: vi.fn(async () => metaSub),
      reconnect: vi.fn(async () => {}),
      sync,
    } as unknown as LoroDocumentManager['repo'];
    const manager = new LoroDocumentManager({
      repo,
      workspaceId: 'workspace-remote-doc-sync' as WorkspaceId,
      userId: 'user-1',
      metaSub,
      logger: createSilentLogger(),
      initialTransportStatus: 'connected',
      initialMetaSyncPromise: Promise.resolve(true),
      initialMetaSyncCompleted: true,
    });

    await expect(manager.syncRemoteDocOrThrow('session-session-1')).rejects.toThrow(
      'Remote Streams transport is not attached'
    );
    expect(sync).not.toHaveBeenCalled();
    await manager.cleanUp({ fast: true });
  });

  it('rejects a remote document confirmation when Streams detaches during sync', async () => {
    process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS = '0';
    const metaSub = createMetaSubscription();
    let releaseSync!: () => void;
    let markSyncStarted!: () => void;
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });
    const syncRelease = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const repo = {
      destroy: vi.fn(async () => {}),
      joinMetaRoom: vi.fn(async () => metaSub),
      reconnect: vi.fn(async () => {}),
      addTransport: mocks.repoAddTransport,
      removeTransport: mocks.repoRemoveTransport,
      transportRooms: vi.fn(() => []),
      sync: vi.fn(async () => {
        markSyncStarted();
        await syncRelease;
      }),
    } as unknown as LoroDocumentManager['repo'];
    const manager = new LoroDocumentManager({
      repo,
      workspaceId: 'workspace-remote-doc-sync-race' as WorkspaceId,
      userId: 'user-1',
      metaSub,
      logger: createSilentLogger(),
      initialTransportStatus: 'connected',
      initialMetaSyncPromise: Promise.resolve(true),
      initialMetaSyncCompleted: true,
      remoteStreamsAttached: true,
    });

    const confirmation = manager.syncRemoteDocOrThrow('session-session-1');
    await syncStarted;
    await manager.detachRemoteStreamsTransport();
    releaseSync();

    await expect(confirmation).rejects.toThrow(
      'Remote Streams transport changed during document sync'
    );
    await manager.cleanUp({ fast: true });
  });

  it('shares one Flock document sync between concurrent callers and starts a fresh one after', async () => {
    process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS = '0';
    const metaSub = createMetaSubscription();
    let releaseSync!: () => void;
    let markSyncStarted!: () => void;
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });
    const syncRelease = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const sync = vi.fn(async () => {
      markSyncStarted();
      await syncRelease;
      return { ok: true, outcome: 'no-route', transports: [] } satisfies RepoSyncReport;
    });
    const repo = {
      destroy: vi.fn(async () => {}),
      joinMetaRoom: vi.fn(async () => metaSub),
      reconnect: vi.fn(async () => {}),
      sync,
    } as unknown as LoroDocumentManager['repo'];
    const manager = new LoroDocumentManager({
      repo,
      workspaceId: 'workspace-flock-sync-coalesce' as WorkspaceId,
      userId: 'user-1',
      metaSub,
      logger: createSilentLogger(),
      initialTransportStatus: 'connected',
      initialMetaSyncPromise: Promise.resolve(true),
      initialMetaSyncCompleted: true,
    });

    const docId = 'workspace-flock-sync-coalesce:wf:workspace';
    const first = manager.syncFlockDocOrThrow(docId, { reason: 'a' });
    await syncStarted;
    const joined = manager.syncFlockDocOrThrow(docId, { reason: 'b' });
    // A different document is never folded into the in-flight attempt.
    const other = manager.syncFlockDocOrThrow(`${docId}-other`, { reason: 'c' });
    expect(sync).toHaveBeenCalledTimes(2);

    releaseSync();
    await Promise.all([first, joined, other]);

    // The entry is dropped once it settles, so a later caller syncs for real.
    await manager.syncFlockDocOrThrow(docId, { reason: 'd' });
    expect(sync).toHaveBeenCalledTimes(3);
    await manager.cleanUp({ fast: true });
  });

  it.each([false, true])(
    'allows ordinary no-route reads but confirms strict reads only without cloud sync (cloud=%s)',
    async (cloudEnabled) => {
      process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS = '0';
      const { LoroRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
      const repo = await LoroRepo.create({});
      const manager = new LoroDocumentManager({
        repo,
        workspaceId: 'workspace-flock-no-route' as WorkspaceId,
        userId: 'user-1',
        metaSub: null,
        logger: createSilentLogger(),
        initialTransportStatus: 'connected',
        streamsTokens: cloudEnabled ? testStreamsTokens : null,
      });

      try {
        const docId = 'workspace-flock-no-route:wf:machine';
        expect(await repo.sync({ scope: 'doc', flockDocIds: [docId] })).toEqual({
          ok: true,
          outcome: 'no-route',
          transports: [],
        });
        await expect(manager.syncFlockDocOrThrow(docId)).resolves.toBeUndefined();
        const confirmation = manager.syncFlockDocOrThrow(docId, {
          requireRemoteConfirmation: true,
        });
        if (cloudEnabled) {
          await expect(confirmation).rejects.toMatchObject({
            cause: expect.objectContaining({
              _tag: 'FlockSyncUnavailableError',
              reason: 'no-route',
            }),
          });
        } else {
          await expect(confirmation).resolves.toBeUndefined();
        }
      } finally {
        await manager.cleanUp({ fast: true });
      }
    }
  );

  it('allows ordinary partial reports but preserves permanent failure for strict reads', async () => {
    process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS = '0';
    const { LoroRepo } = await vi.importActual<typeof import('loro-repo')>('loro-repo');
    const { StreamsTransportAdapter } = await vi.importActual<
      typeof import('loro-repo/transport/streams')
    >('loro-repo/transport/streams');
    const repo = await LoroRepo.create({});
    const failure = new RepoTransportError('Synthetic rejected credentials', {
      code: 'unauthorized',
      phase: 'sync',
      retryable: false,
    });
    for (const transportId of ['streams', 'secondary']) {
      const adapter = new StreamsTransportAdapter({
        bucketId: 'test-bucket',
        auth: async () => 'test-token',
        persistence: { mode: 'ephemeral' },
      });
      vi.spyOn(adapter, 'syncFlockDoc').mockResolvedValue(
        transportId === 'streams' ? { ok: false, error: failure } : { ok: true }
      );
      await repo.addTransport(transportId, adapter);
    }
    const manager = new LoroDocumentManager({
      repo,
      workspaceId: 'workspace-flock-partial' as WorkspaceId,
      userId: 'user-1',
      metaSub: null,
      logger: createSilentLogger(),
      initialTransportStatus: 'connected',
      remoteStreamsAttached: true,
    });

    try {
      await expect(
        manager.syncFlockDocOrThrow('workspace-flock-partial:wf:machine')
      ).resolves.toBeUndefined();
      const error = await manager
        .syncFlockDocOrThrow('workspace-flock-partial:wf:machine', {
          requireRemoteConfirmation: true,
        })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      const cause = error instanceof Error ? error.cause : undefined;
      expect(cause).toBeInstanceOf(RepoSyncError);
      if (!(cause instanceof RepoSyncError)) throw new Error('Missing typed sync report');
      expect(cause.report.outcome).toBe('partial');
      expect(
        cause.report.transports.find((transport) => transport.transportId === 'streams')
      ).toMatchObject({ ok: false, failures: [{ error: failure }] });
    } finally {
      await manager.cleanUp({ fast: true });
    }
  });

  it('rejects strict coalesced waiters but preserves ordinary reads when Streams is replaced', async () => {
    process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS = '0';
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const report = {
      ok: true,
      outcome: 'synced',
      transports: [{ transportId: 'streams', ok: true, failures: [] }],
    } satisfies RepoSyncReport;
    const repo = {
      destroy: vi.fn(async () => {}),
      reconnect: vi.fn(async () => {}),
      addTransport: mocks.repoAddTransport,
      removeTransport: mocks.repoRemoveTransport,
      transportRooms: mocks.repoTransportRooms,
      sync: vi.fn(async () => {
        started.resolve();
        await release.promise;
        return report;
      }),
    } as unknown as LoroDocumentManager['repo'];
    const manager = new LoroDocumentManager({
      repo,
      workspaceId: 'workspace-flock-replaced' as WorkspaceId,
      presenceRuntime: await createCliPresenceRuntimeLegacy(
        'workspace-flock-replaced' as WorkspaceId
      ),
      userId: 'user-1',
      metaSub: null,
      logger: createSilentLogger(),
      initialTransportStatus: 'connected',
      remoteStreamsAttached: true,
      streamsTokens: testStreamsTokens,
      sqliteRepoStore: await createCliSqliteRepoStore('workspace-flock-replaced' as WorkspaceId),
      documentRemoteCursorStore: new InMemoryRemoteCursorStore(),
    });

    try {
      const docId = 'workspace-flock-replaced:wf:machine';
      const first = expect(
        manager.syncFlockDocOrThrow(docId, { requireRemoteConfirmation: true })
      ).rejects.toMatchObject({
        cause: { _tag: 'FlockSyncUnavailableError', reason: 'transport-changed' },
      });
      await started.promise;
      await manager.detachRemoteStreamsTransport();
      await manager.attachRemoteStreamsTransport();
      const lateWaiter = expect(
        manager.syncFlockDocOrThrow(docId, { requireRemoteConfirmation: true })
      ).rejects.toMatchObject({
        cause: { _tag: 'FlockSyncUnavailableError', reason: 'transport-changed' },
      });
      const ordinary = expect(manager.syncFlockDocOrThrow(docId)).resolves.toBeUndefined();
      release.resolve();
      await Promise.all([first, lateWaiter, ordinary]);
      await expect(
        manager.syncFlockDocOrThrow(docId, { requireRemoteConfirmation: true })
      ).resolves.toBeUndefined();
    } finally {
      release.resolve();
      await manager.cleanUp({ fast: true });
    }
  });

  it.each([
    { strictFirst: true, outcome: 'no-route' },
    { strictFirst: false, outcome: 'no-route' },
    { strictFirst: true, outcome: 'partial' },
    { strictFirst: false, outcome: 'partial' },
  ] as const)(
    'keeps coalesced confirmation policy per caller ($outcome, strictFirst=$strictFirst)',
    async ({ strictFirst, outcome }) => {
      process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS = '0';
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<RepoSyncReport>();
      const sync = vi.fn(() => {
        started.resolve();
        return release.promise;
      });
      const repo = {
        destroy: vi.fn(async () => {}),
        reconnect: vi.fn(async () => {}),
        sync,
      } as unknown as LoroDocumentManager['repo'];
      const manager = new LoroDocumentManager({
        repo,
        workspaceId: 'workspace-flock-mixed' as WorkspaceId,
        userId: 'user-1',
        metaSub: null,
        logger: createSilentLogger(),
        initialTransportStatus: 'connected',
        streamsTokens: testStreamsTokens,
      });
      const report: RepoSyncReport =
        outcome === 'no-route'
          ? { ok: true, outcome, transports: [] }
          : {
              ok: false,
              outcome,
              transports: [
                { transportId: 'secondary', ok: true, failures: [] },
                {
                  transportId: 'streams',
                  ok: false,
                  failures: [{ kind: 'flock-doc', error: new Error('Synthetic unknown failure') }],
                },
              ],
            };
      const read = (strict: boolean) => {
        const result = manager.syncFlockDocOrThrow('workspace-flock-mixed:wf:machine', {
          requireRemoteConfirmation: strict,
        });
        return strict
          ? expect(result).rejects.toMatchObject({
              cause:
                outcome === 'no-route'
                  ? { _tag: 'FlockSyncUnavailableError', reason: 'no-route' }
                  : { name: 'RepoSyncError', report },
            })
          : expect(result).resolves.toBeUndefined();
      };
      try {
        const first = read(strictFirst);
        await started.promise;
        const second = read(!strictFirst);
        release.resolve(report);
        await Promise.all([first, second]);
        expect(sync).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve(report);
        await manager.cleanUp({ fast: true });
      }
    }
  );

  it('bridges local data-plane Flock room joins to repo Flock room joins', async () => {
    const workspaceId = 'workspace-flock-bridge' as WorkspaceId;
    const flockDocId = `${workspaceId}:fis:session-1`;
    const metaSub = createMetaSubscription();
    const remoteFlockUnsubscribe = vi.fn();
    const remoteFlockSub = {
      unsubscribe: remoteFlockUnsubscribe,
      firstSyncedWithRemote: Promise.resolve(),
      waitUntilSynced: vi.fn(async () => {}),
      status: 'joined',
      onStatusChange: vi.fn((listener: (status: string) => void) => {
        listener('joined');
        return vi.fn();
      }),
      subscription: (transportId: string) => ({
        transportId,
        status: 'joined',
        firstSyncedWithRemote: Promise.resolve(),
        waitUntilSynced: vi.fn(async () => {}),
        rejoin: vi.fn(async () => {}),
        onStatusChange: vi.fn((listener: (status: string) => void) => {
          listener('joined');
          return vi.fn();
        }),
      }),
      subscriptions: () => [],
      transportIds: () => ['streams'],
    };
    const repo = {
      destroy: vi.fn(async () => {}),
      reconnect: vi.fn(async () => {}),
      joinMetaRoom: vi.fn(async () => metaSub),
      joinFlockDocRoom: vi.fn(async () => remoteFlockSub),
    } as unknown as LoroDocumentManager['repo'];
    const localFlock = {
      exportJson: vi.fn(async () => ({ version: 0, entries: {} })),
      importJson: vi.fn(async () => {}),
      version: vi.fn(() => ({})),
      commit: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const localServer = new LocalLoroDataPlaneServerLegacy({
      workspaceId,
      resolveDoc: async () => {
        throw new Error('unused');
      },
      resolveFlockDoc: async () => localFlock,
    });
    const manager = new LoroDocumentManager({
      repo,
      workspaceId,
      userId: 'user-1',
      metaSub,
      logger: createSilentLogger(),
      initialTransportStatus: 'connected',
      initialMetaSyncPromise: Promise.resolve(true),
      initialMetaSyncCompleted: true,
      localLoroDataPlaneServer: localServer,
    });
    const received: LocalLoroDataPlaneServerMessage[] = [];
    const connection = {
      id: 'conn-flock-bridge',
      send: (message: LocalLoroDataPlaneServerMessage) => {
        received.push(message);
      },
    };
    const room = { scope: 'flock-doc' as const, flockDocId };

    await localServer.handleMessage(connection, {
      type: 'join',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      requestId: 'join-flock',
      workspaceId,
      peerId: 'peer-1',
      room,
    });
    await settle();
    await settle();

    expect(repo.joinFlockDocRoom).toHaveBeenCalledWith(flockDocId);
    // Cloud hydrate is a background data relay only: the CLI's cloud room
    // status must NOT be pushed to the renderer as local room health
    // (specs/local-first-two-plane.md — offline cloud failures must not poison
    // the renderer's local reconnect loop).
    expect(received.filter((message) => message.type === 'room-status')).toEqual([]);

    await localServer.handleMessage(connection, {
      type: 'leave',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      workspaceId,
      peerId: 'peer-1',
      room,
    });
    await settle();

    expect(remoteFlockUnsubscribe).toHaveBeenCalledTimes(1);
    await manager.cleanUp({ fast: true });
  });

  it('reconnects and notifies listeners after meta room disconnects', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    process.env.LODY_LORO_AUTO_RECONNECT_DELAY_MS = '1';
    process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS = '0';

    type TestMetaStatus = 'connecting' | 'joined' | 'disconnected' | 'error';
    let metaStatus: TestMetaStatus = 'joined';
    const statusListeners: Array<(status: TestMetaStatus) => void> = [];
    const waitUntilSynced = vi.fn(async () => {});
    const repoReconnect = vi.fn(async () => {
      metaStatus = 'joined';
      for (const listener of statusListeners) {
        listener(metaStatus);
      }
    });

    const metaSub = {
      unsubscribe: vi.fn(),
      firstSyncedWithRemote: Promise.resolve(),
      waitUntilSynced,
      get status() {
        return metaStatus;
      },
      onStatusChange: vi.fn((listener: (status: TestMetaStatus) => void) => {
        statusListeners.push(listener);
        listener(metaStatus);
        return vi.fn();
      }),
      // Recovery reads the per-transport binding, so the fake must expose the
      // same live status through it (these tests drive `metaStatus` directly).
      subscription: (transportId: string) => ({
        transportId,
        get status() {
          return metaStatus;
        },
        firstSyncedWithRemote: Promise.resolve(),
        waitUntilSynced,
        rejoin: vi.fn(async () => {}),
        onStatusChange: vi.fn((listener: (status: TestMetaStatus) => void) => {
          statusListeners.push(listener);
          listener(metaStatus);
          return vi.fn();
        }),
      }),
      subscriptions: () => [],
      transportIds: () => ['streams'],
    };

    mocks.repoCreate.mockResolvedValueOnce({
      joinMetaRoom: vi.fn(async () => metaSub),
      reconnect: repoReconnect,
      destroy: vi.fn(async () => {}),
      addTransport: mocks.repoAddTransport,
      removeTransport: mocks.repoRemoveTransport,
      transportRooms: mocks.repoTransportRooms,
    });

    const manager = await LoroDocumentManager.create(
      'workspace-8' as WorkspaceId,
      'user-1',
      createSilentLogger()
    );

    let resolveInitialSync: (reason: string) => void = () => {};
    const initialSyncObserved = new Promise<string>((resolve) => {
      resolveInitialSync = resolve;
    });
    const detachInitialSyncListener = manager.onMetaRoomSynced(resolveInitialSync);
    await vi.advanceTimersByTimeAsync(1);
    await expect(initialSyncObserved).resolves.toBe('meta-room-joined');
    detachInitialSyncListener();
    waitUntilSynced.mockClear();

    let resolveSyncedListener: (reason: string) => void = () => {};
    const syncedListenerCalled = new Promise<string>((resolve) => {
      resolveSyncedListener = resolve;
    });
    const syncedListener = vi.fn((reason: string) => {
      resolveSyncedListener(reason);
    });
    manager.onMetaRoomSynced(syncedListener);

    metaStatus = 'disconnected';
    for (const listener of statusListeners) {
      listener(metaStatus);
    }

    await vi.waitFor(() => expect(syncedListener).toHaveBeenCalledWith('meta-room-joined'));
    await expect(syncedListenerCalled).resolves.toBe('meta-room-joined');

    expect(repoReconnect).toHaveBeenCalledTimes(1);
    expect(repoReconnect).toHaveBeenCalledWith({ resetBackoff: false, timeout: 10_000 });
    expect(waitUntilSynced).toHaveBeenCalledTimes(1);
    expect(syncedListener).toHaveBeenCalledWith('meta-room-joined');

    await manager.cleanUp({ fast: true });
  });

  it('backs off automatic reconnects while the meta room remains disconnected', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    process.env.LODY_LORO_AUTO_RECONNECT_DELAY_MS = '100';
    process.env.LODY_LORO_AUTO_RECONNECT_MAX_DELAY_MS = '1000';
    process.env.LODY_LORO_AUTO_RECONNECT_INTERVAL_MS = '0';
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    try {
      type TestMetaStatus = 'joined' | 'disconnected';
      let metaStatus: TestMetaStatus = 'joined';
      const statusListeners: Array<(status: TestMetaStatus) => void> = [];
      const repoReconnect = vi.fn(async () => {});
      const metaSub = {
        unsubscribe: vi.fn(),
        firstSyncedWithRemote: Promise.resolve(),
        waitUntilSynced: vi.fn(async () => {}),
        get status() {
          return metaStatus;
        },
        onStatusChange: vi.fn((listener: (status: TestMetaStatus) => void) => {
          statusListeners.push(listener);
          listener(metaStatus);
          return vi.fn();
        }),
        subscription: (transportId: string) => ({
          transportId,
          get status() {
            return metaStatus;
          },
          firstSyncedWithRemote: Promise.resolve(),
          waitUntilSynced: vi.fn(async () => {}),
          rejoin: vi.fn(async () => {}),
          onStatusChange: vi.fn((listener: (status: TestMetaStatus) => void) => {
            statusListeners.push(listener);
            listener(metaStatus);
            return vi.fn();
          }),
        }),
        subscriptions: () => [],
        transportIds: () => ['streams'],
      };

      mocks.repoCreate.mockResolvedValueOnce({
        joinMetaRoom: vi.fn(async () => metaSub),
        reconnect: repoReconnect,
        destroy: vi.fn(async () => {}),
        addTransport: mocks.repoAddTransport,
        removeTransport: mocks.repoRemoveTransport,
      });

      const manager = await LoroDocumentManager.create(
        'workspace-9' as WorkspaceId,
        'user-1',
        createSilentLogger()
      );

      await Promise.resolve();
      await Promise.resolve();
      repoReconnect.mockClear();

      metaStatus = 'disconnected';
      for (const listener of statusListeners) {
        listener(metaStatus);
      }

      await vi.advanceTimersByTimeAsync(99);
      expect(repoReconnect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(repoReconnect).toHaveBeenCalledTimes(1);
      expect(repoReconnect).toHaveBeenLastCalledWith({ resetBackoff: false, timeout: 10_000 });

      await vi.advanceTimersByTimeAsync(199);
      expect(repoReconnect).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(repoReconnect).toHaveBeenCalledTimes(2);
      expect(repoReconnect).toHaveBeenLastCalledWith({ resetBackoff: false, timeout: 10_000 });

      await manager.cleanUp({ fast: true });
    } finally {
      randomSpy.mockRestore();
    }
  });
});
