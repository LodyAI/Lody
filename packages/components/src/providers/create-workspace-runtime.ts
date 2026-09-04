import { LoroRepo, type RepoRoomSubscription, type RepoWatchHandle } from 'loro-repo';
import { IndexedDBStorageAdaptor } from 'loro-repo/storage/indexeddb';
import { StreamsTransportAdapter } from 'loro-repo/transport/streams';
import { StreamsCrdt, createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';
import type { PlatformSyncMode } from '@lody/platform';
import {
  createLoroStreamsJsonStreamClient,
  LoroStreamsLiveModePolicy,
  LoroStreamsMachineRpcClient,
  LoroStreamsRpcResponseDispatcher,
  LORO_STREAMS_RPC_RETENTION_SECONDS,
  type LoroStreamsLiveTransport,
} from '@lody/loro-streams-rpc';
import {
  buildLoroStreamsTokenEndpoint,
  createLoroStreamsTokenProvider,
  getPreviewCommentRoomId,
  getTaskRoomId,
  taskDocSchema,
  TASK_ORDER_MIN_KEY,
  createLoroStreamUrl,
  getLoroMetaStreamId,
  getLoroStreamIdForDocId,
  getLoroStreamsBaseUrl,
  getLoroStreamsPresenceBaseUrl,
  getLoroStreamsShardUrls,
  getSessionRoomId,
  getMachineFlockAgentConfigs,
  getMachineFlockDocId,
  isMachineDocRoomId,
  isSessionDocRoomId,
  isLoroRepoDocDeleted,
  MACHINE_DOC_PREFIX,
  readMachineFlockRowsFromFlock,
  SESSION_DOC_PREFIX,
  type SessionStatus,
  LORO_STREAMS_BUCKET_ID,
  sessionDocSchema,
  ClientToServerSchema,
  ServerToClientSchema,
  type ClientToServer,
  type SessionCreateResponse,
  type SessionCancelResponse,
  type SessionChatResponse,
  type SessionId,
  type MachineId,
  type MachineStatusResponse,
  type MachinePingResponse,
  type MachineRestartResponse,
  type MachineUpgradeResponse,
  type MachineAcpCapabilitiesRefreshResponse,
  type MachineAcpAuthenticateResponse,
  type MachineAcpAuthenticationProgressMessage,
  type MachineAcpBinaryStatusResponse,
  type MachineAcpBinaryInstallResponse,
  type MachineAcpBinaryProgressMessage,
  getServerNow,
  collectOnlineMachineIdsFromPresence,
  previewVisualCommentDocSchema,
  streamsSnapshotCodec,
  base64ToBytes,
  parseLodyPresenceStates,
  LODY_PRESENCE_TTL_MS,
  type LodyPresenceStateMap,
  type LoroStreamsTokenProviderEvent,
  type SyncReason,
} from '@lody/shared';
import { LocalLoroTransportAdapter } from '@lody/shared/local-loro-transport';
import type { TaskId, WorkspaceId } from '@lody/shared';
import { createDirectWorkspaceWriter } from './workspace-writer-impl';
import {
  WorkspaceTargetRouter,
  type WorkspaceTransportRoom,
  type WorkspaceTransportRoute,
} from './workspace-target-router';
import { mergePresenceSnapshots } from './presence-snapshot-merge';
import { Mirror } from 'loro-mirror';
import { LoroDoc, EphemeralStore } from 'loro-crdt';
import {
  WorkspaceRuntime,
  type PreviewVisualCommentDocStore,
  type SessionDocStore,
  type TaskDocStore,
} from '@/atoms/runtime';
import type { LodyControlConnectionState } from '@/atoms/control-connection';
import { createManagedStoreCache } from './store-ref-tracker';
import { waitForRoomToSync } from './room-sync';
import {
  createLocalReconnectLoop,
  type LocalReconnectLoop,
  type LocalReconnectTriggerReason,
} from './local-reconnect-loop';
import { resolveWorkspaceControlConnectionState } from './control-connection-state';
import { createRoomSyncTracker, type RoomSyncTracker } from './room-sync-tracker';
import type { RoomSyncState } from '@/lib/room-sync-state';
import { createRoomSyncRegistry } from './room-sync-registry';
import {
  createBackgroundSyncCoordinator,
  resolveEagerSyncPolicy,
  type BackgroundSyncCoordinator,
  type EagerSyncSurface,
  type SessionActivitySnapshot,
} from './background-sync-coordinator';
import { WorkspacePresenceTransport } from './workspace-presence-transport';
import { WorkspaceMachineMonitorTransport } from './workspace-machine-monitor-transport';
import { WorkspaceLocalMachineMonitorTransport } from './workspace-local-machine-monitor-transport';
import { TargetRoutedMachineMonitor } from './target-routed-machine-monitor';
import { createResilientRemoteCursorStore } from './resilient-remote-cursor-store';
import { scheduleAfterStartupNavigationCooldown } from './startup-network-idle';
import { logCodeCollabDebug } from '@/lib/code-collab-debug';
import { listDocMetaEntries } from '@/lib/doc-meta-batch';
import {
  createEagerSyncHighWaterStore,
  type EagerSyncHighWaterCache,
} from '@/lib/eager-sync-high-water-cache';
import { isRemoteCursorDebugEnabled } from '@/lib/remote-cursor-debug';
import { META_REMOTE_CURSOR_BYPASS_STORAGE_KEY_PREFIX } from '@/lib/clear-local-cache';
import { runStartupAcpCapabilitiesRefresh } from './startup-acp-capabilities-refresh';
import { createLocalLoroDataPlaneConnection } from './local-loro-data-plane-connection';
import { createWorkspaceMachineRpcFacade } from './workspace-machine-rpc-facade';
import { resyncMachineFlockRows } from '@/hooks/use-machine-flock-rows';
import { createCodeCollabFileIndexCache } from '@/lib/code-collab-file-index-cache';
import { getIpcServices, onIpcEvent, sendLocalSessionControl } from '@/lib/electron-ipc-client';

declare global {
  interface Window {
    repo?: LoroRepo;
  }
}

/**
 * Side-effect-only analytics intent emitted by the runtime. The runtime has no
 * PostHog client of its own (it is a non-React module), so it forwards
 * structured events to the React-side RuntimeProvider, which captures them via
 * the PostHog wrappers. Rejected: importing posthog-js here directly — the
 * runtime must stay framework-agnostic and unit-testable without a client.
 */
export type WorkspaceRuntimeAnalyticsEvent = {
  name: string;
  properties: Record<string, unknown>;
};

type RuntimeDeps = {
  /**
   * Used for caching the (slug, id) mapping in localStorage.
   */
  workspaceSlug: string;
  /**
   * Required for IndexedDB name and WebSocket connections.
   * Must be provided at initialization (either from cache or server).
   */
  workspaceId: WorkspaceId;
  apiBaseUrl: string;
  token?: string | null;
  /**
   * Per-room transport policy (specs/platform-providers.md). Defaults to the
   * Electron local-data-plane probe: `dual` when the preload bridge exists,
   * `cloud` otherwise (Web/Mobile). `local` mounts every room on the local
   * plane only and performs zero cloud I/O — open-source platform builds.
   */
  syncMode?: PlatformSyncMode;
  onControlConnectionStateChange?: (state: LodyControlConnectionState) => void;
  onDocMetaPatch?: (roomId: string, patch: unknown) => void;
  onPresenceSnapshot?: (states: LodyPresenceStateMap) => void;
  /**
   * Health of the presence transport (RoomSyncState). Lets the UI distinguish
   * "machine offline" from "presence not flowing to this client".
   */
  onPresenceSyncStateChange?: (state: RoomSyncState) => void;
  /**
   * Forward analytics intents (meta-sync outcome, connection-state changes,
   * durable-transport init failures) to the PostHog-aware caller. Optional so
   * the runtime works in tests and contexts without analytics wired.
   */
  onAnalyticsEvent?: (event: WorkspaceRuntimeAnalyticsEvent) => void;
  /**
   * Convex-authoritative machine visibility snapshot. A null snapshot means
   * authorization is not ready, so optional startup capability refresh is skipped.
   */
  getAuthorizedMachineIds?: () => ReadonlySet<MachineId> | null;
  eagerSyncSurface?: EagerSyncSurface;
};

type LoroStreamsTokenProvider = ReturnType<typeof createLoroStreamsTokenProvider>;
type LoroStreamsJsonStreamClient = ReturnType<typeof createLoroStreamsJsonStreamClient>;
const isDestroyedError = (error: unknown): boolean => {
  return error instanceof Error && error.message === 'Destroyed';
};

const formatTransportError = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) {
    return String(error);
  }

  if ('message' in error && typeof error.message === 'string') {
    return error.message;
  }

  if ('code' in error && typeof error.code === 'string') {
    return error.code;
  }

  return 'unknown_transport_error';
};

const RECONNECTING_STATUS_DISPLAY_DELAY_MS = 1_000;
const META_FIRST_SYNC_TIMEOUT_MS = 120_000;
const DOC_STREAM_CREATE_TIMEOUT_MS = 10_000;
const MACHINE_RPC_TRANSPORT_READY_TIMEOUT_MS = 30_000;
const LOCAL_MACHINE_ID_READY_TIMEOUT_MS = 2_000;
const MACHINE_RESTART_RPC_TIMEOUT_MS = 30_000;
const MACHINE_UPGRADE_RPC_TIMEOUT_MS = 120_000;
const ACP_CAPABILITIES_STARTUP_MACHINE_CONCURRENCY = 2;
const ACP_CAPABILITIES_STARTUP_NAVIGATION_COOLDOWN_MS = 30_000;

function waitForPromiseOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);

  return new Promise<T | null>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', handleAbort);
      callback();
    };
    const handleAbort = () => finish(() => resolve(null));
    signal.addEventListener('abort', handleAbort, { once: true });
    if (signal.aborted) {
      handleAbort();
      return;
    }
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}
export {
  computeLocalReconnectDelayMs,
  waitForLocalReconnectDelayEffect,
} from './local-reconnect-loop';

const createTimeoutError = (message: string): Error => {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
};

const isTimeoutError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'TimeoutError';

// Cloud errored-binding rejoin sweep bounds: per rejoin, batch width, and the
// whole sweep. It runs inside the reconnect loop's in-flight guard, so an
// unbounded pass would wedge cloud repair permanently.
const CLOUD_REJOIN_TIMEOUT_MS = 10_000;
const CLOUD_REJOIN_SWEEP_CONCURRENCY = 4;
const CLOUD_REJOIN_SWEEP_BUDGET_MS = 30_000;

const withTimeout = async <TResult>(
  promise: Promise<TResult>,
  timeoutMs: number,
  message: string
): Promise<TResult> => {
  if (timeoutMs <= 0) {
    return await promise;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<TResult>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(createTimeoutError(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const getMetaRemoteCursorBypassStorageKey = (workspaceId: WorkspaceId): string =>
  `${META_REMOTE_CURSOR_BYPASS_STORAGE_KEY_PREFIX}:${workspaceId}`;

const getBrowserLocalStorage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const isElectronLocalDataPlaneEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;
  if (!window.__LODY_ELECTRON__) return false;
  if (!getIpcServices()) return false;
  if (import.meta.env.VITE_LODY_ELECTRON_LOCAL_DATA_PLANE === '0') return false;
  try {
    return globalThis.localStorage?.getItem('lody:electronLocalDataPlane') !== '0';
  } catch {
    return true;
  }
};

// Escape hatch for the Machine RPC response live transport. Unset (the normal
// case) leaves the SSE-first policy in charge; setting it pins one transport and
// disables the fallback/probe logic.
const resolveMachineRpcLiveTransportPin = (): LoroStreamsLiveTransport | undefined => {
  const configured = import.meta.env.VITE_LORO_STREAMS_RPC_LIVE_MODE;
  return configured === 'sse' || configured === 'long-poll' ? configured : undefined;
};

// Generic registry for keyed control request/response round-trips: dedupes
// concurrent waiters on the same key, resolves null on timeout (the caller maps
// that to its own timeout message), and resolves the real response when handle()
// sees a match. Replaces the per-message-type copies of this machinery.
function createPendingResponseRegistry<T>(defaultTimeoutMs: number) {
  type Pending = {
    promise: Promise<T | null>;
    resolve: (value: T | null) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  };
  const pending = new Map<string, Pending>();

  const wait = (key: string, timeoutMs: number = defaultTimeoutMs): Promise<T | null> => {
    const existing = pending.get(key);
    if (existing) {
      return existing.promise;
    }
    let resolve: (value: T | null) => void = () => {};
    const promise = new Promise<T | null>((nextResolve) => {
      resolve = nextResolve;
    });
    const timeoutId = setTimeout(
      () => {
        pending.delete(key);
        resolve(null);
      },
      Math.max(0, timeoutMs)
    );
    pending.set(key, { promise, resolve, timeoutId });
    return promise;
  };

  const handle = (key: string, message: T): void => {
    const entry = pending.get(key);
    if (entry) {
      clearTimeout(entry.timeoutId);
      pending.delete(key);
      entry.resolve(message);
    }
  };

  const clearAll = (): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeoutId);
      entry.resolve(null);
    }
    pending.clear();
  };

  return { wait, handle, clearAll };
}

export async function createWorkspaceRuntime(deps: RuntimeDeps): Promise<WorkspaceRuntime> {
  const createDeferred = <T>() => {
    let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
    let reject: ((reason?: unknown) => void) | undefined;
    const promise = new Promise<T>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    if (!resolve || !reject) {
      throw new Error('Failed to create deferred promise');
    }
    return { promise, resolve, reject };
  };

  // Use workspaceId for database names - ensures consistent data access even if slug changes.
  // Open SQLite connection for metadata storage (flock-sqlite mode for better performance)
  // Using OPFS (Origin Private File System) for persistent storage with custom database names
  // Routing is resolved lazily through the router (constructed right below);
  // until then the default all-transports route is fine because no transport
  // is registered yet.
  let resolveRoomTransportsImpl:
    | ((room: WorkspaceTransportRoom) => WorkspaceTransportRoute)
    | null = null;
  const repo = await LoroRepo.create({
    storageAdapter: new IndexedDBStorageAdaptor({
      dbName: 'lody-loro-repo-db-' + deps.workspaceId,
    }),
    metaDebounceCommitMs: 0,
    resolveRoomTransports: (room) =>
      resolveRoomTransportsImpl?.(room) ?? { transportIds: ['cloud'] },
  });
  // Liveness invariant: opening a workspace must never wait forever on rebuildable
  // local cache. Loro Streams cursors are checkpoints, not source-of-truth data, so
  // a broken IndexedDB cursor store must fail open and let Streams bootstrap/catch up.
  const metaStreamIdForWorkspace = getLoroMetaStreamId(deps.workspaceId);
  const shouldBypassMetaRemoteCursorLoad = (streamUrl: string): boolean => {
    const storage = getBrowserLocalStorage();
    if (!storage) {
      return false;
    }
    // If a previous page lifetime timed out before deleting a suspect meta cursor,
    // persistently bypass that checkpoint on the next startup. The cursor is only
    // replay progress; successful meta sync below clears this marker.
    const bypassMarker = storage.getItem(getMetaRemoteCursorBypassStorageKey(deps.workspaceId));
    return (
      bypassMarker !== null &&
      streamUrl.endsWith(`/${encodeURIComponent(metaStreamIdForWorkspace)}`)
    );
  };
  const remoteCursorStore = createResilientRemoteCursorStore({
    dbName: 'lody-loro-stream-cursors-' + deps.workspaceId,
    shouldBypassPrimaryLoad: shouldBypassMetaRemoteCursorLoad,
    onWarning: (message, context) => {
      console.warn(message, {
        workspaceId: deps.workspaceId,
        ...context,
      });
    },
    onEvent: (message, context) => {
      if (!isRemoteCursorDebugEnabled()) return;
      console.debug(message, {
        workspaceId: deps.workspaceId,
        ...context,
      });
    },
  });

  const transportReady = createDeferred<void>();
  // Runtime dispose intentionally rejects this deferred; swallow that expected rejection.
  void transportReady.promise.catch(() => {});
  const syncMode: PlatformSyncMode =
    deps.syncMode ?? (isElectronLocalDataPlaneEnabled() ? 'dual' : 'cloud');
  // Historical name: true whenever a local plane exists (dual OR local).
  const electronLocalDataPlane = syncMode !== 'cloud';
  // False only on the local-only platform: no Streams member, no token
  // provider, no cloud presence/RPC — zero cloud I/O by construction.
  const cloudPlaneEnabled = syncMode !== 'local';
  let notifyTargetRouteChange = (): void => {};
  const targetRouter = new WorkspaceTargetRouter({
    repo,
    syncMode,
    onRouteChange: () => notifyTargetRouteChange(),
  });
  resolveRoomTransportsImpl = (room) => targetRouter.resolveTransportRoute(room);
  let localLoroTransport: LocalLoroTransportAdapter | null = null;
  let localMachineMonitorTransport: WorkspaceLocalMachineMonitorTransport | null = null;
  let localDataPlaneConnectionDispose: (() => void) | null = null;
  let localPresenceUnsubscribe: (() => void) | null = null;
  let transportAttached = false;
  let authToken: string | null = null;
  let cloudTransportAttached = false;
  let cloudTransportAttachPromise: Promise<void> | null = null;
  let metaSub: RepoRoomSubscription | null = null;
  let cloudMetaTracker: RoomSyncTracker | null = null;
  let streamsTokenProvider: LoroStreamsTokenProvider | null = null;
  let jsonStreamClient: LoroStreamsJsonStreamClient | null = null;
  let machineRpcStreamsClientReady: Promise<LoroStreamsJsonStreamClient> | null = null;
  let transportStreamsBaseUrl: string | null = null;
  let detachMetaRoomStatusListener: (() => void) | null = null;
  // Meta room health tracker, registered in roomSyncRegistry like every other
  // room (durable sessions, presence). Recreated fresh on each
  // ensureMetaRoomSynced cycle so stale first-sync/status state from a
  // previous transport attach can never leak into the next one.
  let metaTracker: RoomSyncTracker | null = null;
  let initialMetaSyncCompleted = false;
  let initialMetaSyncFailed = false;
  let metaFirstSyncRecovery: Promise<void> | null = null;
  let metaRemoteCursorInvalidated = false;
  const metaSyncState = (): RoomSyncState => metaTracker?.getSyncState() ?? 'idle';

  // workspaceId is required and provided at initialization
  const workspaceId: WorkspaceId = deps.workspaceId;

  // Analytics is side-effect-only: never let a capture path throw into the
  // runtime control flow. The caller wires `onAnalyticsEvent` to PostHog.
  const emitAnalytics = (name: string, properties: Record<string, unknown>): void => {
    if (!deps.onAnalyticsEvent) {
      return;
    }
    try {
      deps.onAnalyticsEvent({
        name,
        properties: { workspace_id: workspaceId, ...properties },
      });
    } catch (error) {
      console.warn('createWorkspaceRuntime: analytics emit failed', { name, error });
    }
  };

  const classifyMetaSyncReason = (error: unknown): SyncReason => {
    if (isTimeoutError(error)) {
      return 'timeout';
    }
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes('token')) {
      return 'token_fetch_failed';
    }
    if (message.includes('cursor')) {
      return 'cursor_degraded';
    }
    if (message.includes('auth')) {
      return 'fatal_auth';
    }
    if (message.includes('reject')) {
      return 'rejected_by_server';
    }
    if (
      message.includes('transport') ||
      message.includes('network') ||
      message.includes('connect')
    ) {
      return 'transport_error';
    }
    return 'unknown';
  };

  let latestLocalOriginPresenceStates: LodyPresenceStateMap = {};
  let latestCloudPresenceStates: LodyPresenceStateMap = {};
  let latestPresenceStates: LodyPresenceStateMap = {};
  const publishMergedPresence = (): void => {
    latestPresenceStates = mergePresenceSnapshots(
      latestLocalOriginPresenceStates,
      latestCloudPresenceStates
    );
    deps.onPresenceSnapshot?.(latestPresenceStates);
  };
  const presenceTransport = new WorkspacePresenceTransport({
    workspaceId,
    onSnapshot: (states) => {
      latestCloudPresenceStates = states;
      publishMergedPresence();
    },
    onWarning: (message, context) => {
      console.warn(message, context);
    },
  });
  const machineMonitorTransport = new WorkspaceMachineMonitorTransport({
    workspaceId,
    onWarning: (message, context) => console.warn(message, context),
  });
  const targetMachineMonitor = new TargetRoutedMachineMonitor(
    targetRouter,
    machineMonitorTransport
  );

  const watchHandles: RepoWatchHandle[] = [];
  // Grace period before disposing an idle session store (and leaving its room).
  // Long enough to survive session switching without reconnecting.
  const STORE_RELEASE_DELAY_MS = 600_000;
  // Short grace period before leaving an inactive session room. This avoids
  // reconnect churn during quick tab switches while keeping SSE fan-out bounded.
  const SESSION_ROOM_SYNC_RELEASE_DELAY_MS = 2_000;
  // Slow reconcile interval for the reconnect-loop backstop tick.
  const RECONNECT_BACKSTOP_INTERVAL_MS = 60_000;
  let disposePromise: Promise<void> | null = null;
  let reconnectingStatusTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectingStatusVisible = false;
  let localReconnectLoop: LocalReconnectLoop | null = null;
  let cloudReconnectLoop: LocalReconnectLoop | null = null;
  let reconnectBackstopTimer: ReturnType<typeof setInterval> | null = null;
  let releaseIdleDocumentStoresBeforeReconnect: () => Promise<void> = async () => {};
  // Background eager-sync coordinator. Assigned once all of its port
  // dependencies (session store cache, env handlers) are in scope; started from
  // the meta-room first-sync callback after the startup navigation cooldown, so
  // it never blocks or competes with meta sync. Placeholder mirrors the
  // releaseIdleDocumentStoresBeforeReconnect pattern above.
  let backgroundSyncCoordinator: BackgroundSyncCoordinator | null = null;
  let backgroundSyncCoordinatorStartPromise: Promise<void> | null = null;
  let backgroundSyncHighWaterStore: EagerSyncHighWaterCache | null = null;
  let cancelDelayedBackgroundSyncStart: (() => void) | null = null;
  let startBackgroundSyncCoordinator: () => void = () => {};

  const logTokenProviderEvent = (event: LoroStreamsTokenProviderEvent): void => {
    const logContext = {
      ...event,
      hasCachedToken: event.type === 'cache-hit',
    };
    if (event.type === 'fetch-failure') {
      console.warn('Loro Streams token provider event', logContext);
      return;
    }
    console.debug('Loro Streams token provider event', logContext);
  };

  const markMetaRemoteCursorBypass = (reason: string): void => {
    const storage = getBrowserLocalStorage();
    if (!storage) {
      return;
    }
    try {
      storage.setItem(
        getMetaRemoteCursorBypassStorageKey(workspaceId),
        JSON.stringify({
          workspaceId,
          reason,
          createdAtMs: Date.now(),
        })
      );
      console.warn('createWorkspaceRuntime: marked meta remote cursor for startup bypass', {
        workspaceId,
        reason,
      });
    } catch (error) {
      console.warn('createWorkspaceRuntime: failed to mark meta remote cursor bypass', {
        workspaceId,
        reason,
        error,
      });
    }
  };

  const isMetaRemoteCursorBypassActive = (): boolean => {
    const storage = getBrowserLocalStorage();
    if (!storage) {
      return false;
    }
    try {
      return storage.getItem(getMetaRemoteCursorBypassStorageKey(workspaceId)) !== null;
    } catch {
      return false;
    }
  };

  const clearMetaRemoteCursorBypass = (): void => {
    const storage = getBrowserLocalStorage();
    if (!storage) {
      return;
    }
    try {
      storage.removeItem(getMetaRemoteCursorBypassStorageKey(workspaceId));
      console.info('createWorkspaceRuntime: cleared meta remote cursor startup bypass', {
        workspaceId,
      });
    } catch (error) {
      console.warn('createWorkspaceRuntime: failed to clear meta remote cursor bypass', {
        workspaceId,
        error,
      });
    }
  };

  const getStreamsBaseUrlForProvider = (provider: LoroStreamsTokenProvider | null): string =>
    provider?.getGatewayBaseUrl() ??
    getLoroStreamsBaseUrl(import.meta.env.VITE_LORO_STREAMS_BASE_URL);

  const getStreamsShardHostSuffixForProvider = (
    provider: LoroStreamsTokenProvider | null
  ): string | undefined => provider?.getShardHostSuffix();

  const invalidateMetaRemoteCursor = async (reason: string, error: unknown): Promise<void> => {
    // Remote cursors only exist for the Streams plane; the local-only
    // platform has neither the cursor rows nor a provider to derive URLs from.
    if (!cloudPlaneEnabled) {
      return;
    }
    markMetaRemoteCursorBypass(reason);
    if (metaRemoteCursorInvalidated) {
      return;
    }

    metaRemoteCursorInvalidated = true;
    const metaStreamId = getLoroMetaStreamId(workspaceId);
    const metaStreamUrl = createLoroStreamUrl({
      bucketId: LORO_STREAMS_BUCKET_ID,
      streamId: metaStreamId,
      baseUrl: transportStreamsBaseUrl ?? getStreamsBaseUrlForProvider(streamsTokenProvider),
    });
    try {
      await remoteCursorStore.delete(metaStreamUrl);
      console.warn('Deleted Loro Streams meta remote cursor after sync failure', {
        workspaceId,
        metaStreamId,
        reason,
        error,
      });
    } catch (deleteError) {
      console.warn('Failed to delete Loro Streams meta remote cursor after sync failure', {
        workspaceId,
        metaStreamId,
        reason,
        error,
        deleteError,
      });
    }
  };

  const clearReconnectingStatusTimer = () => {
    if (!reconnectingStatusTimer) {
      return;
    }
    clearTimeout(reconnectingStatusTimer);
    reconnectingStatusTimer = null;
  };

  const isBrowserOnline = (): boolean => {
    if (typeof navigator === 'undefined') {
      return true;
    }
    return navigator.onLine;
  };

  // Keyed registry of per-room sync trackers. Replaces the previous anonymous
  // Set<RoomSyncTracker>: serves hasReconnectableProblem() and additionally
  // exposes the joined / recently-synced room sets the background eager-sync
  // coordinator consumes. `onTrackerStateChange` is a lazy arrow so it can refer
  // to notifyConnectionStateInputsChanged (defined below) — it is only invoked
  // later, when a tracker's state actually changes.
  const roomSyncRegistry = createRoomSyncRegistry({
    clock: { now: () => Date.now() },
    onTrackerStateChange: () => notifyConnectionStateInputsChanged(),
  });

  const canRunLocalReconnect = (): boolean =>
    transportAttached &&
    !disposePromise &&
    (electronLocalDataPlane || (!!authToken && isBrowserOnline()));

  const cloudMetaSyncRoomId = `cloud-meta:${getLoroMetaStreamId(workspaceId)}`;
  const isCloudHealthRoom = (roomId: string): boolean => {
    if (roomId.startsWith('presence:') || roomId.startsWith('machine-monitor:')) {
      return true;
    }
    if (roomId === cloudMetaSyncRoomId) {
      return true;
    }
    return targetRouter.getPlaneForDocRoom(roomId) === 'cloud';
  };

  const isLocalHealthRoom = (roomId: string): boolean =>
    roomId === getLoroMetaStreamId(workspaceId) ||
    targetRouter.getPlaneForDocRoom(roomId) === 'local';

  // Every connection (meta room, durable session rooms, presence) reports
  // health into roomSyncRegistry, so "anything broken?" is a single scan.
  const hasReconnectableProblem = (): boolean =>
    canRunLocalReconnect() &&
    roomSyncRegistry.anyNeedsReconnect(electronLocalDataPlane ? isLocalHealthRoom : undefined);

  const canRunCloudReconnect = (): boolean =>
    cloudPlaneEnabled &&
    electronLocalDataPlane &&
    !disposePromise &&
    !!authToken &&
    isBrowserOnline();

  // Selection, not merging: every room's cloud subscription is first-class in
  // loro-repo, so the repair loop enumerates that plane directly instead of
  // relying on any per-room status projection. Cloud-READINESS rooms are
  // excluded: their cloud binding is the room's own tracked status (registry
  // covers them), so counting them here would double-trigger the loop.
  const listCloudTransportProblemEntries = () =>
    repo
      .transportRooms('cloud')
      .filter(
        (entry) =>
          (entry.subscription.status === 'error' || entry.subscription.status === 'disconnected') &&
          targetRouter.getReadinessTransportForRoom(entry.room) === 'local'
      );

  const listCloudTransportProblemRooms = (): string[] =>
    listCloudTransportProblemEntries().map((entry) => `${entry.room.kind}:${entry.room.id}`);

  const hasCloudReconnectableProblem = (): boolean =>
    canRunCloudReconnect() &&
    (!cloudTransportAttached ||
      roomSyncRegistry.anyNeedsReconnect(isCloudHealthRoom) ||
      listCloudTransportProblemRooms().length > 0);

  const notifyConnectionStateInputsChanged = () => {
    localReconnectLoop?.update();
    cloudReconnectLoop?.update();
    emitControlConnectionState();
  };

  notifyTargetRouteChange = () => {
    void repo.refreshTransportRoutes().catch(() => undefined);
    targetMachineMonitor.refreshRoutes();
    notifyConnectionStateInputsChanged();
  };

  const createTrackedRoomSyncTracker = (roomId: string): RoomSyncTracker => {
    const tracker = createRoomSyncTracker(roomId);
    // The registry owns the state subscription (it forwards to
    // notifyConnectionStateInputsChanged via onTrackerStateChange) and the
    // joined / lastSyncedAt bookkeeping.
    const untrack = roomSyncRegistry.track(tracker);
    const disposeTracker = tracker.dispose;

    return {
      ...tracker,
      dispose: () => {
        untrack();
        disposeTracker();
      },
    };
  };

  // Selection, not merging: readiness/health per room reads exactly one
  // plane's stable binding (local for dual-homed local rooms, cloud
  // otherwise). If ownership resolves to local only AFTER a room joined
  // (prepareSessionTarget failed), the tracker keeps the cloud binding until
  // the next lease cycle re-selects — data flow is unaffected, both planes
  // sync regardless of which one the tracker watches.
  const readinessBindingForDocRoom = (sub: RepoRoomSubscription, roomId: string) =>
    sub.subscription(targetRouter.getReadinessTransportForRoom({ kind: 'doc', id: roomId }));

  /**
   * Sync wait for a doc store. A binding whose transport is not attached
   * ('detached': signed out, offline, or a route migration that has not
   * finished re-attaching) has nothing to wait ON — loro-repo REJECTS there,
   * which would surface as a user-visible send/edit failure while the data is
   * simply pending. Treat it as a no-op, matching how every other consumer
   * reads 'detached' as idle.
   */
  const waitUntilRoomSynced = async (sub: RepoRoomSubscription, roomId: string): Promise<void> => {
    const binding = readinessBindingForDocRoom(sub, roomId);
    if (binding.status === 'detached') {
      return;
    }
    await binding.waitUntilSynced();
  };

  // Event-driven repair nudge: a dual-homed room's cloud binding turning
  // unhealthy must wake the cloud reconnect loop without waiting for the
  // 60s backstop. The binding is stable across cloud detach/attach cycles.
  const watchCloudBindingForRepair = (sub: RepoRoomSubscription): (() => void) =>
    sub.subscription('cloud').onStatusChange(() => notifyConnectionStateInputsChanged());

  const resolveControlConnectionState = (): LodyControlConnectionState => {
    return resolveWorkspaceControlConnectionState({
      hasAuthToken: electronLocalDataPlane || !!authToken,
      browserOnline: electronLocalDataPlane || isBrowserOnline(),
      transportAttached,
      metaSyncState: metaSyncState(),
      initialMetaSyncCompleted,
      initialMetaSyncFailed,
    });
  };

  type PendingSessionCreateResponse = {
    promise: Promise<SessionCreateResponse | null>;
    resolve: (value: SessionCreateResponse | null) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  };

  type PendingSessionCancelResponse = {
    promise: Promise<SessionCancelResponse | null>;
    resolve: (value: SessionCancelResponse | null) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  };

  type PendingSessionChatResponse = {
    promise: Promise<SessionChatResponse | null>;
    resolve: (value: SessionChatResponse | null) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  };

  type PendingMachineStatusResponse = {
    promise: Promise<MachineStatusResponse | null>;
    resolve: (value: MachineStatusResponse | null) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  };

  type PendingMachinePingResponse = {
    promise: Promise<MachinePingResponse | null>;
    resolve: (value: MachinePingResponse | null) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  };

  const pendingSessionCreateResponses = new Map<SessionId, PendingSessionCreateResponse>();
  const sessionCreateResponseCache = new Map<SessionId, SessionCreateResponse>();

  const pendingSessionCancelResponses = new Map<SessionId, PendingSessionCancelResponse>();

  const pendingMachineStatusResponses = new Map<MachineId, PendingMachineStatusResponse>();
  const pendingMachinePingResponses = new Map<string, PendingMachinePingResponse>();
  const machineAcpBinaryStatusRegistry =
    createPendingResponseRegistry<MachineAcpBinaryStatusResponse>(30000);
  const machineAcpBinaryInstallRegistry =
    createPendingResponseRegistry<MachineAcpBinaryInstallResponse>(300000);
  const machineAcpAuthenticateRegistry =
    createPendingResponseRegistry<MachineAcpAuthenticateResponse>(300000);
  const machineRestartRegistry = createPendingResponseRegistry<MachineRestartResponse>(
    MACHINE_RESTART_RPC_TIMEOUT_MS
  );
  const machineUpgradeRegistry = createPendingResponseRegistry<MachineUpgradeResponse>(
    MACHINE_UPGRADE_RPC_TIMEOUT_MS
  );
  const machineAcpBinaryProgressListeners = new Map<
    string,
    Set<(message: MachineAcpBinaryProgressMessage) => void>
  >();
  const machineAcpBinaryProgressSnapshots = new Map<string, MachineAcpBinaryProgressMessage>();
  const machineAcpAuthenticationProgressListeners = new Map<
    string,
    Set<(message: MachineAcpAuthenticationProgressMessage) => void>
  >();
  const machineRpcClients = new Map<MachineId, LoroStreamsMachineRpcClient>();
  let machineRpcResponseDispatcher: LoroStreamsRpcResponseDispatcher | null = null;
  const emitControlConnectionState = () => {
    if (disposePromise) {
      return;
    }

    const nextState = resolveControlConnectionState();

    if (!deps.onControlConnectionStateChange) {
      return;
    }

    if (nextState !== 'reconnecting') {
      clearReconnectingStatusTimer();
      reconnectingStatusVisible = false;
      deps.onControlConnectionStateChange(nextState);
      return;
    }

    if (reconnectingStatusVisible || reconnectingStatusTimer) {
      return;
    }

    reconnectingStatusTimer = setTimeout(() => {
      reconnectingStatusTimer = null;
      if (disposePromise || resolveControlConnectionState() !== 'reconnecting') {
        return;
      }
      reconnectingStatusVisible = true;
      deps.onControlConnectionStateChange?.('reconnecting');
    }, RECONNECTING_STATUS_DISPLAY_DELAY_MS);
  };

  // Chat responses use composite keys: `${sessionId}:${userTurnId}`
  const pendingSessionChatResponses = new Map<string, PendingSessionChatResponse>();

  const handleSessionCreateResponse = (message: SessionCreateResponse) => {
    const pending = pendingSessionCreateResponses.get(message.sessionId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingSessionCreateResponses.delete(message.sessionId);
      pending.resolve(message);
      return;
    }
    sessionCreateResponseCache.set(message.sessionId, message);
  };

  const handleSessionCancelResponse = (message: SessionCancelResponse) => {
    const pending = pendingSessionCancelResponses.get(message.sessionId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingSessionCancelResponses.delete(message.sessionId);
      pending.resolve(message);
    }
  };

  const handleSessionChatResponse = (message: SessionChatResponse) => {
    const key = `${message.sessionId}:${message.userTurnId}`;
    const pending = pendingSessionChatResponses.get(key);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingSessionChatResponses.delete(key);
      pending.resolve(message);
    }
  };

  const handleMachineStatusResponse = (message: MachineStatusResponse) => {
    const pending = pendingMachineStatusResponses.get(message.machineId as MachineId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingMachineStatusResponses.delete(message.machineId as MachineId);
      pending.resolve(message);
    }
  };

  const getMachinePingPendingKey = (machineId: MachineId, requestId: string): string =>
    `${machineId}:${requestId}`;

  const handleMachinePingResponse = (message: MachinePingResponse) => {
    const key = getMachinePingPendingKey(message.machineId as MachineId, message.requestId);
    const pending = pendingMachinePingResponses.get(key);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingMachinePingResponses.delete(key);
      pending.resolve(message);
    }
  };

  const getMachineLifecyclePendingKey = (machineId: MachineId, requestId: string): string =>
    `${machineId}:${requestId}`;

  const handleMachineRestartResponse = (message: MachineRestartResponse) =>
    machineRestartRegistry.handle(
      getMachineLifecyclePendingKey(message.machineId as MachineId, message.requestId),
      message
    );

  const handleMachineUpgradeResponse = (message: MachineUpgradeResponse) =>
    machineUpgradeRegistry.handle(
      getMachineLifecyclePendingKey(message.machineId as MachineId, message.requestId),
      message
    );

  const getMachineAcpBinaryPendingKey = (machineId: MachineId, agentType: string): string =>
    `${machineId}:${agentType}`;

  const getMachineAcpAuthenticationPendingKey = (machineId: MachineId, requestId: string): string =>
    `${machineId}:${requestId}`;

  const handleMachineAcpAuthenticateResponse = (message: MachineAcpAuthenticateResponse) =>
    machineAcpAuthenticateRegistry.handle(
      getMachineAcpAuthenticationPendingKey(message.machineId as MachineId, message.requestId),
      message
    );

  const handleMachineAcpAuthenticationProgress = (
    message: MachineAcpAuthenticationProgressMessage
  ) => {
    const listeners = machineAcpAuthenticationProgressListeners.get(
      getMachineAcpAuthenticationPendingKey(message.machineId as MachineId, message.requestId)
    );
    if (!listeners) return;
    for (const listener of Array.from(listeners)) {
      listener(message);
    }
  };

  const subscribeMachineAcpAuthenticationProgress = (
    machineId: MachineId,
    requestId: string,
    listener: (message: MachineAcpAuthenticationProgressMessage) => void
  ): (() => void) => {
    const key = getMachineAcpAuthenticationPendingKey(machineId, requestId);
    const listeners = machineAcpAuthenticationProgressListeners.get(key) ?? new Set();
    listeners.add(listener);
    machineAcpAuthenticationProgressListeners.set(key, listeners);
    return () => {
      const current = machineAcpAuthenticationProgressListeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        machineAcpAuthenticationProgressListeners.delete(key);
      }
    };
  };

  const handleMachineAcpBinaryStatusResponse = (message: MachineAcpBinaryStatusResponse) => {
    handleMachineAcpBinaryProgress({
      type: 'machine/acp-binary-progress',
      machineId: message.machineId,
      agentType: message.agentType,
      status:
        !message.success || message.status === 'error'
          ? 'error'
          : message.status === 'not-applicable'
            ? 'installed'
            : message.status,
      command: message.command,
      platformArch: message.platformArch,
      version: message.version,
      current: message.current,
      required: message.required,
      error: message.error,
    });
    machineAcpBinaryStatusRegistry.handle(
      getMachineAcpBinaryPendingKey(message.machineId as MachineId, message.agentType),
      message
    );
  };

  const handleMachineAcpBinaryInstallResponse = (message: MachineAcpBinaryInstallResponse) => {
    handleMachineAcpBinaryProgress({
      type: 'machine/acp-binary-progress',
      machineId: message.machineId,
      agentType: message.agentType,
      status: message.success ? 'installed' : 'error',
      command: message.command,
      version: message.version,
      error: message.error,
    });
    machineAcpBinaryInstallRegistry.handle(
      getMachineAcpBinaryPendingKey(message.machineId as MachineId, message.agentType),
      message
    );
  };

  function handleMachineAcpBinaryProgress(message: MachineAcpBinaryProgressMessage): void {
    const key = getMachineAcpBinaryPendingKey(message.machineId as MachineId, message.agentType);
    machineAcpBinaryProgressSnapshots.set(key, message);
    const listeners = machineAcpBinaryProgressListeners.get(key);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) {
      listener(message);
    }
  }

  const subscribeMachineAcpBinaryProgress = (
    machineId: MachineId,
    agentType: string,
    listener: (message: MachineAcpBinaryProgressMessage) => void
  ): (() => void) => {
    const key = getMachineAcpBinaryPendingKey(machineId, agentType);
    const listeners = machineAcpBinaryProgressListeners.get(key) ?? new Set();
    listeners.add(listener);
    machineAcpBinaryProgressListeners.set(key, listeners);
    return () => {
      const current = machineAcpBinaryProgressListeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        machineAcpBinaryProgressListeners.delete(key);
      }
    };
  };

  const getMachineAcpBinaryProgress = (
    machineId: MachineId,
    agentType: string
  ): MachineAcpBinaryProgressMessage | null =>
    machineAcpBinaryProgressSnapshots.get(getMachineAcpBinaryPendingKey(machineId, agentType)) ??
    null;

  const waitForSessionCreateResponse = (
    sessionId: SessionId,
    options: { timeoutMs?: number } = {}
  ): Promise<SessionCreateResponse | null> => {
    const cached = sessionCreateResponseCache.get(sessionId);
    if (cached) {
      sessionCreateResponseCache.delete(sessionId);
      return Promise.resolve(cached);
    }

    const existing = pendingSessionCreateResponses.get(sessionId);
    if (existing) {
      return existing.promise;
    }

    const timeoutMs = Math.max(0, options.timeoutMs ?? 10000);
    let resolve: (value: SessionCreateResponse | null) => void = () => {};
    const promise = new Promise<SessionCreateResponse | null>((nextResolve) => {
      resolve = nextResolve;
    });

    const timeoutId = setTimeout(() => {
      pendingSessionCreateResponses.delete(sessionId);
      resolve(null);
    }, timeoutMs);

    pendingSessionCreateResponses.set(sessionId, { promise, resolve, timeoutId });
    return promise;
  };

  const waitForSessionCancelResponse = (
    sessionId: SessionId,
    options: { timeoutMs?: number } = {}
  ): Promise<SessionCancelResponse | null> => {
    const existing = pendingSessionCancelResponses.get(sessionId);
    if (existing) {
      return existing.promise;
    }

    const timeoutMs = Math.max(0, options.timeoutMs ?? 10000);
    let resolve: (value: SessionCancelResponse | null) => void = () => {};
    const promise = new Promise<SessionCancelResponse | null>((nextResolve) => {
      resolve = nextResolve;
    });

    const timeoutId = setTimeout(() => {
      pendingSessionCancelResponses.delete(sessionId);
      resolve(null);
    }, timeoutMs);

    pendingSessionCancelResponses.set(sessionId, { promise, resolve, timeoutId });
    return promise;
  };

  /**
   * Wait for a session chat response.
   * @param sessionId - The session ID
   * @param userTurnId - The user message turn ID to correlate the response
   * @param options - Optional timeout configuration (default 3s)
   */
  const waitForSessionChatResponse = (
    sessionId: SessionId,
    userTurnId: string,
    options: { timeoutMs?: number } = {}
  ): Promise<SessionChatResponse | null> => {
    const key = `${sessionId}:${userTurnId}`;
    const existing = pendingSessionChatResponses.get(key);
    if (existing) {
      return existing.promise;
    }

    const timeoutMs = Math.max(0, options.timeoutMs ?? 3000);
    let resolve: (value: SessionChatResponse | null) => void = () => {};
    const promise = new Promise<SessionChatResponse | null>((nextResolve) => {
      resolve = nextResolve;
    });

    const timeoutId = setTimeout(() => {
      pendingSessionChatResponses.delete(key);
      resolve(null);
    }, timeoutMs);

    pendingSessionChatResponses.set(key, { promise, resolve, timeoutId });
    return promise;
  };

  /**
   * Wait for a machine status response.
   * @param machineId - The machine ID
   * @param options - Optional timeout configuration (default 30s)
   */
  const waitForMachineStatusResponse = (
    machineId: MachineId,
    options: { timeoutMs?: number } = {}
  ): Promise<MachineStatusResponse | null> => {
    const existing = pendingMachineStatusResponses.get(machineId);
    if (existing) {
      return existing.promise;
    }

    const timeoutMs = Math.max(0, options.timeoutMs ?? 30000);
    let resolve: (value: MachineStatusResponse | null) => void = () => {};
    const promise = new Promise<MachineStatusResponse | null>((nextResolve) => {
      resolve = nextResolve;
    });

    const timeoutId = setTimeout(() => {
      pendingMachineStatusResponses.delete(machineId);
      resolve(null);
    }, timeoutMs);

    pendingMachineStatusResponses.set(machineId, { promise, resolve, timeoutId });
    return promise;
  };

  const waitForMachinePingResponse = (
    machineId: MachineId,
    requestId: string,
    options: { timeoutMs?: number } = {}
  ): Promise<MachinePingResponse | null> => {
    const key = getMachinePingPendingKey(machineId, requestId);
    const existing = pendingMachinePingResponses.get(key);
    if (existing) {
      return existing.promise;
    }

    const timeoutMs = Math.max(0, options.timeoutMs ?? 30000);
    let resolve: (value: MachinePingResponse | null) => void = () => {};
    const promise = new Promise<MachinePingResponse | null>((nextResolve) => {
      resolve = nextResolve;
    });

    const timeoutId = setTimeout(() => {
      pendingMachinePingResponses.delete(key);
      resolve(null);
    }, timeoutMs);

    pendingMachinePingResponses.set(key, { promise, resolve, timeoutId });
    return promise;
  };

  const waitForMachineAcpBinaryStatusResponse = (
    machineId: MachineId,
    agentType: string,
    options: { timeoutMs?: number } = {}
  ): Promise<MachineAcpBinaryStatusResponse | null> =>
    machineAcpBinaryStatusRegistry.wait(
      getMachineAcpBinaryPendingKey(machineId, agentType),
      options.timeoutMs
    );

  const waitForMachineAcpAuthenticateResponse = (
    machineId: MachineId,
    requestId: string,
    options: { timeoutMs?: number } = {}
  ): Promise<MachineAcpAuthenticateResponse | null> =>
    machineAcpAuthenticateRegistry.wait(
      getMachineAcpAuthenticationPendingKey(machineId, requestId),
      options.timeoutMs
    );

  const waitForMachineAcpBinaryInstallResponse = (
    machineId: MachineId,
    agentType: string,
    options: { timeoutMs?: number } = {}
  ): Promise<MachineAcpBinaryInstallResponse | null> =>
    machineAcpBinaryInstallRegistry.wait(
      getMachineAcpBinaryPendingKey(machineId, agentType),
      options.timeoutMs
    );

  const waitForMachineRestartResponse = (
    machineId: MachineId,
    requestId: string,
    options: { timeoutMs?: number } = {}
  ): Promise<MachineRestartResponse | null> =>
    machineRestartRegistry.wait(
      getMachineLifecyclePendingKey(machineId, requestId),
      options.timeoutMs
    );

  const waitForMachineUpgradeResponse = (
    machineId: MachineId,
    requestId: string,
    options: { timeoutMs?: number } = {}
  ): Promise<MachineUpgradeResponse | null> =>
    machineUpgradeRegistry.wait(
      getMachineLifecyclePendingKey(machineId, requestId),
      options.timeoutMs
    );

  const docMetaRouteHandle = repo.watch(
    (event) => {
      if (event.kind !== 'doc-metadata') {
        return;
      }
      targetRouter.observeDocMeta(event.docId, event.patch);
      deps.onDocMetaPatch?.(event.docId, event.patch);
    },
    { kinds: ['doc-metadata'] }
  );
  watchHandles.push(docMetaRouteHandle);

  const validateControlMessage = (message: ClientToServer): boolean => {
    const validated = ClientToServerSchema.safeParse(message);
    if (validated.success) {
      return true;
    }

    console.error('createWorkspaceRuntime: invalid control message', {
      type: message.type,
      error: validated.error.flatten(),
    });

    if (import.meta.env.DEV) {
      throw validated.error;
    }
    return false;
  };

  type ControlResponseMessage =
    | SessionCreateResponse
    | SessionCancelResponse
    | SessionChatResponse
    | MachineStatusResponse
    | MachinePingResponse
    | MachineRestartResponse
    | MachineUpgradeResponse
    | MachineAcpCapabilitiesRefreshResponse
    | MachineAcpAuthenticateResponse
    | MachineAcpAuthenticationProgressMessage
    | MachineAcpBinaryStatusResponse
    | MachineAcpBinaryInstallResponse
    | MachineAcpBinaryProgressMessage;

  const handleControlMessage = (message: ControlResponseMessage) => {
    if (message.type === 'session/create_response') {
      handleSessionCreateResponse(message);
      return;
    }
    if (message.type === 'session/cancel_response') {
      handleSessionCancelResponse(message);
      return;
    }
    if (message.type === 'session/chat_response') {
      handleSessionChatResponse(message);
      return;
    }
    if (message.type === 'machine/status_response') {
      handleMachineStatusResponse(message);
      return;
    }
    if (message.type === 'machine/ping_response') {
      handleMachinePingResponse(message);
      return;
    }
    if (message.type === 'machine/restart_response') {
      handleMachineRestartResponse(message);
      return;
    }
    if (message.type === 'machine/upgrade_response') {
      handleMachineUpgradeResponse(message);
      return;
    }
    if (message.type === 'machine/acp-authenticate_response') {
      handleMachineAcpAuthenticateResponse(message);
      return;
    }
    if (message.type === 'machine/acp-authentication-progress') {
      handleMachineAcpAuthenticationProgress(message);
      return;
    }
    if (message.type === 'machine/acp-binary-status_response') {
      handleMachineAcpBinaryStatusResponse(message);
      return;
    }
    if (message.type === 'machine/acp-binary-install_response') {
      handleMachineAcpBinaryInstallResponse(message);
      return;
    }
    if (message.type === 'machine/acp-binary-progress') {
      handleMachineAcpBinaryProgress(message);
      return;
    }
  };

  type ClientLocalSessionControlRequest = Extract<
    ClientToServer,
    {
      type:
        | 'session/create'
        | 'session/chat'
        | 'session/cancel'
        | 'machine/status'
        | 'machine/ping'
        | 'machine/restart'
        | 'machine/upgrade'
        | 'machine/acp-capabilities-refresh'
        | 'machine/acp-authenticate'
        | 'machine/acp-binary-status'
        | 'machine/acp-binary-install';
    }
  >;

  type MachineControlRequest = Extract<
    ClientLocalSessionControlRequest,
    {
      type:
        | 'machine/status'
        | 'machine/ping'
        | 'machine/restart'
        | 'machine/upgrade'
        | 'machine/acp-authenticate'
        | 'machine/acp-binary-status'
        | 'machine/acp-binary-install';
    }
  >;

  type LocalSessionControlDispatchResult =
    | { readonly handled: true }
    | { readonly handled: false; readonly error: string };

  type LocalSessionControlRequestResult =
    | { readonly ok: true; readonly responses: ControlResponseMessage[] }
    | { readonly ok: false; readonly error: string };

  const isMachineControlRequest = (message: ClientToServer): message is MachineControlRequest =>
    message.type === 'machine/status' ||
    message.type === 'machine/ping' ||
    message.type === 'machine/restart' ||
    message.type === 'machine/upgrade' ||
    message.type === 'machine/acp-authenticate' ||
    message.type === 'machine/acp-binary-status' ||
    message.type === 'machine/acp-binary-install';

  const isLocalSessionControlRequest = (
    message: ClientToServer
  ): message is ClientLocalSessionControlRequest =>
    message.type === 'session/create' ||
    message.type === 'session/chat' ||
    message.type === 'session/cancel' ||
    message.type === 'machine/status' ||
    message.type === 'machine/ping' ||
    message.type === 'machine/restart' ||
    message.type === 'machine/upgrade' ||
    message.type === 'machine/acp-capabilities-refresh' ||
    message.type === 'machine/acp-authenticate' ||
    message.type === 'machine/acp-binary-status' ||
    message.type === 'machine/acp-binary-install';

  const getMachineRpcResponseDispatcher = (
    streamClient: LoroStreamsJsonStreamClient
  ): LoroStreamsRpcResponseDispatcher => {
    if (!machineRpcResponseDispatcher) {
      machineRpcResponseDispatcher = new LoroStreamsRpcResponseDispatcher({
        workspaceId,
        streamClient,
        retentionSeconds: LORO_STREAMS_RPC_RETENTION_SECONDS,
        logLabel: workspaceId,
        // SSE-first: long-poll pays a GET plus an uncacheable CORS preflight per
        // cycle on this always-on stream. The policy falls back to long-poll for
        // unsupported/persistently-broken SSE, which is what makes SSE safe here
        // (cf80d2c12 pinned long-poll because `auto` only downgrades on an
        // explicit "SSE unsupported" 400). `VITE_LORO_STREAMS_RPC_LIVE_MODE`
        // pins a transport and disables the policy.
        // Switches are traced through the dispatcher below as
        // `machine rpc live transport changed`.
        liveModePolicy: new LoroStreamsLiveModePolicy({
          pin: resolveMachineRpcLiveTransportPin(),
        }),
        trace: logCodeCollabDebug,
      });
    }
    return machineRpcResponseDispatcher;
  };

  const ensureStreamsTokenProvider = (): LoroStreamsTokenProvider => {
    if (!streamsTokenProvider) {
      streamsTokenProvider = createLoroStreamsTokenProvider({
        endpoint: buildLoroStreamsTokenEndpoint(import.meta.env.VITE_CONVEX_SITE_URL),
        workspaceId,
        authToken: () => authToken,
        onEvent: logTokenProviderEvent,
      });
    }
    return streamsTokenProvider;
  };

  const prepareStreamsAccess = async (): Promise<{
    provider: LoroStreamsTokenProvider;
    streamsBaseUrl: string;
  }> => {
    if (!cloudPlaneEnabled) {
      throw new Error('Streams RPC is disabled in local-only sync mode');
    }
    if (!authToken) {
      throw new Error('Streams RPC client not ready: missing auth token');
    }
    const provider = ensureStreamsTokenProvider();
    await provider.getToken();
    const streamsBaseUrl = getStreamsBaseUrlForProvider(provider);
    transportStreamsBaseUrl = streamsBaseUrl;
    return { provider, streamsBaseUrl };
  };

  const createMachineRpcJsonStreamClient = (
    provider: LoroStreamsTokenProvider,
    streamsBaseUrl: string
  ): LoroStreamsJsonStreamClient => {
    if (!jsonStreamClient) {
      jsonStreamClient = createLoroStreamsJsonStreamClient({
        bucketId: LORO_STREAMS_BUCKET_ID,
        getToken: async () => await provider.getToken(),
        getBaseUrl: () => getStreamsBaseUrlForProvider(provider),
        // The live transport for the RPC response stream is chosen per read by
        // the dispatcher's `LoroStreamsLiveModePolicy`, not by this static
        // default. The client's idle watchdog (see `liveIdleTimeoutMs`) still
        // makes an SSE stall self-heal instead of hanging.
        shardUrls: getLoroStreamsShardUrls(
          streamsBaseUrl,
          getStreamsShardHostSuffixForProvider(provider)
        ),
      });
      // Pre-warm the shared RPC response dispatcher (create/join of the
      // response stream) so the first machine RPC of the session doesn't pay
      // those round-trips on its critical path. This is RPC-only: it never
      // attaches a durable StreamsTransportAdapter to the renderer repo.
      const warmClient = jsonStreamClient;
      void (async () => {
        try {
          await getMachineRpcResponseDispatcher(warmClient).start();
        } catch (error) {
          console.warn('Failed to pre-warm machine RPC response dispatcher', {
            workspaceId,
            error,
          });
        }
      })();
    }
    return jsonStreamClient;
  };

  const ensureMachineRpcStreamsClient = async (): Promise<LoroStreamsJsonStreamClient> => {
    if (jsonStreamClient) {
      return jsonStreamClient;
    }
    if (machineRpcStreamsClientReady) {
      return await machineRpcStreamsClientReady;
    }

    const ready = (async () => {
      const { provider, streamsBaseUrl } = await prepareStreamsAccess();
      return createMachineRpcJsonStreamClient(provider, streamsBaseUrl);
    })();
    machineRpcStreamsClientReady = ready;
    try {
      return await ready;
    } catch (error) {
      if (machineRpcStreamsClientReady === ready) {
        machineRpcStreamsClientReady = null;
      }
      throw error;
    }
  };

  const waitForMachineRpcTransportReady = async (): Promise<LoroStreamsJsonStreamClient> =>
    await withTimeout(
      ensureMachineRpcStreamsClient(),
      MACHINE_RPC_TRANSPORT_READY_TIMEOUT_MS,
      `Streams RPC client not ready after ${MACHINE_RPC_TRANSPORT_READY_TIMEOUT_MS}ms`
    );

  const getMachineRpcClient = async (
    machineId: MachineId
  ): Promise<LoroStreamsMachineRpcClient> => {
    const streamClient = await waitForMachineRpcTransportReady();
    const responseDispatcher = getMachineRpcResponseDispatcher(streamClient);

    const existing = machineRpcClients.get(machineId);
    if (existing) {
      try {
        await existing.start();
        return existing;
      } catch (error) {
        machineRpcClients.delete(machineId);
        existing.stop();
        throw error;
      }
    }

    const next = new LoroStreamsMachineRpcClient({
      workspaceId,
      machineId,
      streamClient,
      responseDispatcher,
      retentionSeconds: LORO_STREAMS_RPC_RETENTION_SECONDS,
      now: getServerNow,
      trace: logCodeCollabDebug,
    });
    machineRpcClients.set(machineId, next);
    try {
      await next.start();
      return next;
    } catch (error) {
      machineRpcClients.delete(machineId);
      next.stop();
      throw error;
    }
  };

  const waitForMachineRouteIfNeeded = async (machineId: MachineId): Promise<void> => {
    if (!electronLocalDataPlane || targetRouter.getPlaneForMachine(machineId) !== null) {
      return;
    }
    try {
      await targetRouter.resolvePlaneForMachine(machineId, {
        timeoutMs: LOCAL_MACHINE_ID_READY_TIMEOUT_MS,
      });
    } catch {
      // Preserve the existing bounded fallback to cloud RPC when the Electron
      // host has not published its identity yet.
    }
  };

  const {
    requestSessionCancel,
    requestSessionSteer,
    requestSessionTerminate,
    requestSessionFork,
    requestSessionEditAndResend,
    requestSessionDispatchTurn,
    requestSessionPrepare,
    requestSessionPrepareCancel,
    requestFilePreview,
    requestLocalCodeCollabFileIndex,
    requestCodeCollabOpenText,
    requestCodeCollabRefreshText,
    requestCodeCollabSaveText,
    requestCodeCollabOpenCurrentDiff,
    requestCodeCollabOpenAllChangesDiff,
    requestCodeCollabOpenTurnDiff,
    requestCodeCollabInitDirectory,
    requestCodeCollabLspDefinition,
    requestCodeCollabLspReferences,
    requestSessionPreviewCreate,
    requestSessionPreviewEndpointAcquire,
    requestSessionPreviewEndpointRelease,
    requestSessionPreviewRevoke,
    requestLocalProjectGitState,
    requestLocalProjectControl,
    requestMachineBugReport,
  } = createWorkspaceMachineRpcFacade({
    workspaceId,
    targetRouter,
    getMachineRpcClient,
  });

  const dispatchMachineStatusViaRpc = async (
    message: Extract<ClientToServer, { type: 'machine/status' }>
  ): Promise<void> => {
    try {
      const client = await getMachineRpcClient(message.machineId);
      const response = await client.requestMachineStatus({ timeoutMs: 30000 });
      handleMachineStatusResponse(
        response ?? {
          type: 'machine/status_response',
          machineId: message.machineId,
          success: false,
          error: 'timeout: Machine status request timed out',
        }
      );
    } catch (error) {
      handleMachineStatusResponse({
        type: 'machine/status_response',
        machineId: message.machineId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const dispatchMachinePingViaRpc = async (
    message: Extract<ClientToServer, { type: 'machine/ping' }>
  ): Promise<void> => {
    try {
      const client = await getMachineRpcClient(message.machineId);
      const response = await client.requestMachinePing({
        requestId: message.requestId,
        timeoutMs: 30000,
      });
      handleMachinePingResponse(
        response ?? {
          type: 'machine/ping_response',
          machineId: message.machineId,
          requestId: message.requestId,
          success: false,
          error: 'timeout: Machine ping request timed out',
        }
      );
    } catch (error) {
      handleMachinePingResponse({
        type: 'machine/ping_response',
        machineId: message.machineId,
        requestId: message.requestId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const dispatchMachineRestartViaRpc = async (
    message: Extract<ClientToServer, { type: 'machine/restart' }>
  ): Promise<void> => {
    try {
      const client = await getMachineRpcClient(message.machineId);
      const response = await client.requestMachineRestart({
        requesterUserId: message.requesterUserId,
        requestToken: message.requestToken,
        requestId: message.requestId,
        timeoutMs: MACHINE_RESTART_RPC_TIMEOUT_MS,
      });
      handleMachineRestartResponse(
        response ?? {
          type: 'machine/restart_response',
          machineId: message.machineId,
          requestId: message.requestId,
          success: false,
          accepted: false,
          disposition: 'error',
          error: 'timeout: Machine restart request timed out',
        }
      );
    } catch (error) {
      handleMachineRestartResponse({
        type: 'machine/restart_response',
        machineId: message.machineId,
        requestId: message.requestId,
        success: false,
        accepted: false,
        disposition: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const dispatchMachineUpgradeViaRpc = async (
    message: Extract<ClientToServer, { type: 'machine/upgrade' }>
  ): Promise<void> => {
    try {
      const client = await getMachineRpcClient(message.machineId);
      const response = await client.requestMachineUpgrade({
        requesterUserId: message.requesterUserId,
        requestToken: message.requestToken,
        requestId: message.requestId,
        targetVersion: message.targetVersion,
        timeoutMs: MACHINE_UPGRADE_RPC_TIMEOUT_MS,
      });
      handleMachineUpgradeResponse(
        response ?? {
          type: 'machine/upgrade_response',
          machineId: message.machineId,
          requestId: message.requestId,
          success: false,
          accepted: false,
          disposition: 'error',
          targetVersion: message.targetVersion,
          error: 'timeout: Machine upgrade request timed out',
        }
      );
    } catch (error) {
      handleMachineUpgradeResponse({
        type: 'machine/upgrade_response',
        machineId: message.machineId,
        requestId: message.requestId,
        success: false,
        accepted: false,
        disposition: 'error',
        targetVersion: message.targetVersion,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const performMachineAcpCapabilitiesRefreshViaRpc = async (
    message: Extract<ClientToServer, { type: 'machine/acp-capabilities-refresh' }>,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: MachineAcpBinaryProgressMessage) => void;
    } = {}
  ): Promise<MachineAcpCapabilitiesRefreshResponse> => {
    try {
      const client = await getMachineRpcClient(message.machineId);
      const response = await client.requestMachineAcpCapabilitiesRefresh({
        configId: message.configId,
        onProgress: (progress) => {
          if (!options.signal?.aborted) {
            handleMachineAcpBinaryProgress(progress);
            options.onProgress?.(progress);
          }
        },
        signal: options.signal,
        timeoutMs: 120000,
      });
      return (
        response ?? {
          type: 'machine/acp-capabilities-refresh_response',
          machineId: message.machineId,
          configId: message.configId,
          cliType: 'builtin',
          agentType: 'unknown',
          success: false,
          error: 'timeout: ACP capability refresh timed out',
        }
      );
    } catch (error) {
      return {
        type: 'machine/acp-capabilities-refresh_response',
        machineId: message.machineId,
        configId: message.configId,
        cliType: 'builtin',
        agentType: 'unknown',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const requestMachineAcpCapabilitiesRefresh = async (
    message: Extract<ClientToServer, { type: 'machine/acp-capabilities-refresh' }>,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: MachineAcpBinaryProgressMessage) => void;
    } = {}
  ): Promise<MachineAcpCapabilitiesRefreshResponse | null> => {
    const { signal } = options;
    if (signal?.aborted) return null;
    const routeReady = waitForMachineRouteIfNeeded(message.machineId);
    if (signal) {
      await waitForPromiseOrAbort(routeReady, signal);
    } else {
      await routeReady;
    }
    if (signal?.aborted) return null;

    if (targetRouter.getPlaneForMachine(message.machineId) === 'local') {
      if (!canUseLocalSessionControl(message)) {
        return {
          type: 'machine/acp-capabilities-refresh_response',
          machineId: message.machineId,
          configId: message.configId,
          cliType: 'builtin',
          agentType: 'unknown',
          success: false,
          error: `Local session control cannot route ${message.type} to machine ${message.machineId}`,
        };
      }
      const localRequest = requestLocalSessionControl(message, {
        onProgress: (progress) => {
          if (!signal?.aborted) options.onProgress?.(progress);
        },
      });
      const localResult = signal
        ? await waitForPromiseOrAbort(localRequest, signal)
        : await localRequest;
      if (!localResult || signal?.aborted) return null;
      if (!localResult.ok) {
        return {
          type: 'machine/acp-capabilities-refresh_response',
          machineId: message.machineId,
          configId: message.configId,
          cliType: 'builtin',
          agentType: 'unknown',
          success: false,
          error: localResult.error,
        };
      }
      for (const response of localResult.responses) {
        if (response.type === 'machine/acp-binary-progress') {
          handleMachineAcpBinaryProgress(response);
          options.onProgress?.(response);
        }
      }
      return (
        localResult.responses.find(
          (response): response is MachineAcpCapabilitiesRefreshResponse =>
            response.type === 'machine/acp-capabilities-refresh_response' &&
            response.machineId === message.machineId &&
            response.configId === message.configId
        ) ?? {
          type: 'machine/acp-capabilities-refresh_response',
          machineId: message.machineId,
          configId: message.configId,
          cliType: 'builtin',
          agentType: 'unknown',
          success: false,
          error: 'Local session control did not return an ACP capability refresh response',
        }
      );
    }

    if (!cloudPlaneEnabled) {
      return {
        type: 'machine/acp-capabilities-refresh_response',
        machineId: message.machineId,
        configId: message.configId,
        cliType: 'builtin',
        agentType: 'unknown',
        success: false,
        error: 'Cloud Machine RPC is disabled in local-only sync mode',
      };
    }
    const request = performMachineAcpCapabilitiesRefreshViaRpc(message, options);
    return signal ? waitForPromiseOrAbort(request, signal) : request;
  };

  const dispatchMachineAcpAuthenticateViaRpc = async (
    message: Extract<ClientToServer, { type: 'machine/acp-authenticate' }>
  ): Promise<void> => {
    try {
      const client = await getMachineRpcClient(message.machineId);
      const common = {
        requestId: message.requestId,
        onProgress: handleMachineAcpAuthenticationProgress,
        timeoutMs: 300000,
      };
      const response = await (() => {
        switch (message.action) {
          case 'start':
            return client.requestMachineAcpAuthenticate({
              ...common,
              action: message.action,
              configId: message.configId,
            });
          case 'cancel':
            return client.requestMachineAcpAuthenticate({
              ...common,
              action: message.action,
              authenticationRequestId: message.authenticationRequestId,
            });
          case 'submit-code':
            return client.requestMachineAcpAuthenticate({
              ...common,
              action: message.action,
              authenticationRequestId: message.authenticationRequestId,
              authorizationCode: message.authorizationCode,
            });
          case 'submit-input':
            return client.requestMachineAcpAuthenticate({
              ...common,
              action: message.action,
              authenticationRequestId: message.authenticationRequestId,
              interactionId: message.interactionId,
              authenticationInput: message.authenticationInput,
            });
          default:
            throw new Error('Unsupported ACP authentication action');
        }
      })();
      handleMachineAcpAuthenticateResponse(
        response ?? {
          type: 'machine/acp-authenticate_response',
          machineId: message.machineId,
          requestId: message.requestId,
          agentType: 'unknown',
          success: false,
          disposition: 'error',
          error: 'timeout: ACP authentication timed out',
        }
      );
    } catch (error) {
      handleMachineAcpAuthenticateResponse({
        type: 'machine/acp-authenticate_response',
        machineId: message.machineId,
        requestId: message.requestId,
        agentType: 'unknown',
        success: false,
        disposition: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const dispatchMachineAcpBinaryStatusViaRpc = async (
    message: Extract<ClientToServer, { type: 'machine/acp-binary-status' }>
  ): Promise<void> => {
    try {
      const client = await getMachineRpcClient(message.machineId);
      const response = await client.requestMachineAcpBinaryStatus({
        agentType: message.agentType,
        timeoutMs: 30000,
      });
      handleMachineAcpBinaryStatusResponse(
        response ?? {
          type: 'machine/acp-binary-status_response',
          machineId: message.machineId,
          agentType: message.agentType,
          success: false,
          status: 'not-installed',
          error: 'timeout: ACP binary status request timed out',
        }
      );
    } catch (error) {
      handleMachineAcpBinaryStatusResponse({
        type: 'machine/acp-binary-status_response',
        machineId: message.machineId,
        agentType: message.agentType,
        success: false,
        status: 'not-installed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const dispatchMachineAcpBinaryInstallViaRpc = async (
    message: Extract<ClientToServer, { type: 'machine/acp-binary-install' }>
  ): Promise<void> => {
    try {
      const client = await getMachineRpcClient(message.machineId);
      const response = await client.requestMachineAcpBinaryInstall({
        agentType: message.agentType,
        onProgress: handleMachineAcpBinaryProgress,
        timeoutMs: 300000,
      });
      handleMachineAcpBinaryInstallResponse(
        response ?? {
          type: 'machine/acp-binary-install_response',
          machineId: message.machineId,
          agentType: message.agentType,
          success: false,
          error: 'timeout: ACP binary install timed out',
        }
      );
    } catch (error) {
      handleMachineAcpBinaryInstallResponse({
        type: 'machine/acp-binary-install_response',
        machineId: message.machineId,
        agentType: message.agentType,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const canUseLocalSessionControl = (message: ClientToServer): boolean => {
    if (typeof window === 'undefined') {
      return false;
    }
    if (!window.__LODY_ELECTRON__) {
      return false;
    }
    if (!getIpcServices()) {
      return false;
    }
    if (!isLocalSessionControlRequest(message)) {
      return false;
    }
    if (targetRouter.getPlaneForMachine(message.machineId) !== 'local') {
      return false;
    }
    if (
      (message.type === 'session/create' || message.type === 'session/chat') &&
      message.project?.kind !== 'local'
    ) {
      return false;
    }
    return true;
  };

  const requestLocalSessionControl = async (
    message: ClientLocalSessionControlRequest,
    options: { onProgress?: (progress: MachineAcpBinaryProgressMessage) => void } = {}
  ): Promise<LocalSessionControlRequestResult> => {
    if (typeof window === 'undefined') {
      return { ok: false, error: 'Local session control requires the Electron renderer' };
    }
    if (!getIpcServices()) {
      return { ok: false, error: 'Local session control bridge is not available' };
    }

    try {
      const streamedProgressCounts = new Map<string, number>();
      const result = await sendLocalSessionControl(message, (payload) => {
        const validated = ServerToClientSchema.safeParse(payload);
        if (!validated.success) {
          console.warn('createWorkspaceRuntime: invalid streamed local control response', {
            message: payload,
            error: validated.error,
          });
          return;
        }
        const controlMessage = validated.data;
        if (
          controlMessage.type !== 'machine/acp-binary-progress' &&
          controlMessage.type !== 'machine/acp-authentication-progress'
        ) {
          return;
        }
        const key = JSON.stringify(controlMessage);
        streamedProgressCounts.set(key, (streamedProgressCounts.get(key) ?? 0) + 1);
        handleControlMessage(controlMessage as ControlResponseMessage);
        if (controlMessage.type === 'machine/acp-binary-progress') {
          options.onProgress?.(controlMessage as MachineAcpBinaryProgressMessage);
        }
      });
      if (!result.ok) {
        console.warn('createWorkspaceRuntime: local session control rejected message', {
          type: message.type,
          error: result.error,
        });
        return {
          ok: false,
          error: `Local session control rejected ${message.type}: ${result.error}`,
        };
      }

      const responses: ControlResponseMessage[] = [];
      for (const payload of result.responses) {
        const validated = ServerToClientSchema.safeParse(payload);
        if (!validated.success) {
          console.warn('createWorkspaceRuntime: invalid local session control response', {
            message: payload,
            error: validated.error,
          });
          return {
            ok: false,
            error: `Local session control returned an invalid response for ${message.type}`,
          };
        }
        const controlMessage = validated.data;
        const streamedKey = JSON.stringify(controlMessage);
        const streamedCount = streamedProgressCounts.get(streamedKey) ?? 0;
        if (streamedCount > 0) {
          if (streamedCount === 1) {
            streamedProgressCounts.delete(streamedKey);
          } else {
            streamedProgressCounts.set(streamedKey, streamedCount - 1);
          }
          continue;
        }
        if (
          controlMessage.type === 'session/create_response' ||
          controlMessage.type === 'session/cancel_response' ||
          controlMessage.type === 'session/chat_response' ||
          controlMessage.type === 'machine/status_response' ||
          controlMessage.type === 'machine/ping_response' ||
          controlMessage.type === 'machine/restart_response' ||
          controlMessage.type === 'machine/upgrade_response' ||
          controlMessage.type === 'machine/acp-capabilities-refresh_response' ||
          controlMessage.type === 'machine/acp-authenticate_response' ||
          controlMessage.type === 'machine/acp-authentication-progress' ||
          controlMessage.type === 'machine/acp-binary-status_response' ||
          controlMessage.type === 'machine/acp-binary-install_response' ||
          controlMessage.type === 'machine/acp-binary-progress'
        ) {
          responses.push(controlMessage as ControlResponseMessage);
        }
      }
      return { ok: true, responses };
    } catch (error) {
      console.warn('createWorkspaceRuntime: local session control request failed', {
        error,
        type: message.type,
      });
      return {
        ok: false,
        error: `Local session control failed for ${message.type}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  };

  const sendControlViaLocalSessionControl = async (
    message: ClientLocalSessionControlRequest
  ): Promise<LocalSessionControlDispatchResult> => {
    const result = await requestLocalSessionControl(message);
    if (!result.ok) {
      return { handled: false, error: result.error };
    }
    for (const response of result.responses) {
      handleControlMessage(response);
    }
    return { handled: true };
  };

  const handleMachineControlTransportFailure = (
    message: MachineControlRequest,
    error: string
  ): void => {
    if (message.type === 'machine/status') {
      handleMachineStatusResponse({
        type: 'machine/status_response',
        machineId: message.machineId,
        success: false,
        error,
      });
      return;
    }
    if (message.type === 'machine/ping') {
      handleMachinePingResponse({
        type: 'machine/ping_response',
        machineId: message.machineId,
        requestId: message.requestId,
        success: false,
        error,
      });
      return;
    }
    if (message.type === 'machine/restart') {
      handleMachineRestartResponse({
        type: 'machine/restart_response',
        machineId: message.machineId,
        requestId: message.requestId,
        success: false,
        accepted: false,
        disposition: 'error',
        error,
      });
      return;
    }
    if (message.type === 'machine/upgrade') {
      handleMachineUpgradeResponse({
        type: 'machine/upgrade_response',
        machineId: message.machineId,
        requestId: message.requestId,
        success: false,
        accepted: false,
        disposition: 'error',
        targetVersion: message.targetVersion,
        error,
      });
      return;
    }
    if (message.type === 'machine/acp-authenticate') {
      handleMachineAcpAuthenticateResponse({
        type: 'machine/acp-authenticate_response',
        machineId: message.machineId,
        requestId: message.requestId,
        agentType: 'unknown',
        success: false,
        disposition: 'error',
        error,
      });
      return;
    }
    if (message.type === 'machine/acp-binary-status') {
      handleMachineAcpBinaryStatusResponse({
        type: 'machine/acp-binary-status_response',
        machineId: message.machineId,
        agentType: message.agentType,
        success: false,
        status: 'error',
        error,
      });
      return;
    }
    handleMachineAcpBinaryInstallResponse({
      type: 'machine/acp-binary-install_response',
      machineId: message.machineId,
      agentType: message.agentType,
      success: false,
      error,
    });
  };

  const rejectLegacyControlMessage = (message: ClientToServer): void => {
    if (message.type === 'session/create') {
      handleSessionCreateResponse({
        type: 'session/create_response',
        sessionId: message.sessionId,
        success: false,
        error: 'legacy_control_removed',
      });
      return;
    }

    if (message.type === 'session/chat') {
      handleSessionChatResponse({
        type: 'session/chat_response',
        sessionId: message.sessionId,
        userTurnId: message.userTurnId,
        success: false,
        error: 'legacy_control_removed',
      });
      return;
    }

    if (message.type === 'session/cancel') {
      handleSessionCancelResponse({
        type: 'session/cancel_response',
        sessionId: message.sessionId,
        success: false,
        error: 'legacy_control_removed',
      });
    }
  };

  const sendControl = (message: ClientToServer) => {
    if (!validateControlMessage(message)) {
      return;
    }

    if (message.type === 'machine/acp-capabilities-refresh') {
      console.warn(
        'createWorkspaceRuntime: sendControl does not support capability refresh; use requestMachineAcpCapabilitiesRefresh so the response and cancellation stay scoped to the caller'
      );
      return;
    }

    if (isMachineControlRequest(message)) {
      void (async () => {
        await waitForMachineRouteIfNeeded(message.machineId);
        if (targetRouter.getPlaneForMachine(message.machineId) === 'local') {
          if (!canUseLocalSessionControl(message)) {
            handleMachineControlTransportFailure(
              message,
              `Local session control cannot route ${message.type} to machine ${message.machineId}`
            );
            return;
          }
          const result = await sendControlViaLocalSessionControl(message);
          if (result.handled) {
            return;
          }
          handleMachineControlTransportFailure(message, result.error);
          return;
        }

        if (!cloudPlaneEnabled) {
          handleMachineControlTransportFailure(
            message,
            `Cloud Machine RPC is disabled for ${message.type} in local-only sync mode`
          );
          return;
        }

        if (message.type === 'machine/status') {
          await dispatchMachineStatusViaRpc(message);
          return;
        }
        if (message.type === 'machine/ping') {
          await dispatchMachinePingViaRpc(message);
          return;
        }
        if (message.type === 'machine/restart') {
          await dispatchMachineRestartViaRpc(message);
          return;
        }
        if (message.type === 'machine/upgrade') {
          await dispatchMachineUpgradeViaRpc(message);
          return;
        }
        if (message.type === 'machine/acp-authenticate') {
          await dispatchMachineAcpAuthenticateViaRpc(message);
          return;
        }
        if (message.type === 'machine/acp-binary-status') {
          await dispatchMachineAcpBinaryStatusViaRpc(message);
          return;
        }
        if (message.type === 'machine/acp-binary-install') {
          await dispatchMachineAcpBinaryInstallViaRpc(message);
          return;
        }
      })();
      return;
    }

    if (isLocalSessionControlRequest(message)) {
      void (async () => {
        await waitForMachineRouteIfNeeded(message.machineId);
        if (canUseLocalSessionControl(message)) {
          const result = await sendControlViaLocalSessionControl(message);
          if (result.handled) {
            return;
          }
        }
        rejectLegacyControlMessage(message);
      })();
      return;
    }

    rejectLegacyControlMessage(message);
  };

  let workspaceMetaFirstSynced = false;
  let startupAcpCapabilitiesRefreshCompleted = false;
  let startupAcpCapabilitiesRefreshAbortController: AbortController | null = null;
  let cancelDelayedStartupAcpCapabilitiesRefresh: (() => void) | null = null;
  const startStartupAcpCapabilitiesRefresh = (): void => {
    if (
      startupAcpCapabilitiesRefreshCompleted ||
      startupAcpCapabilitiesRefreshAbortController ||
      disposePromise ||
      !workspaceMetaFirstSynced ||
      presenceTransport.getSyncState() !== 'synced'
    ) {
      return;
    }
    const abortController = new AbortController();
    startupAcpCapabilitiesRefreshAbortController = abortController;

    void runStartupAcpCapabilitiesRefresh(
      {
        listMachineIds: async () => {
          const authorizedMachineIds = deps.getAuthorizedMachineIds?.() ?? null;
          if (!authorizedMachineIds) return [];
          const entries = await listDocMetaEntries(repo);
          return entries
            .filter((entry) => isMachineDocRoomId(entry.docId) && !isLoroRepoDocDeleted(entry))
            .map((entry) => entry.docId.slice(MACHINE_DOC_PREFIX.length).trim() as MachineId)
            .filter((machineId) => machineId.length > 0 && authorizedMachineIds.has(machineId));
        },
        isMachineOnline: (machineId) =>
          !abortController.signal.aborted &&
          presenceTransport.getSyncState() === 'synced' &&
          collectOnlineMachineIdsFromPresence(latestPresenceStates, getServerNow()).has(machineId),
        listAgentConfigs: async (machineId) => {
          const handle = await repo.openFlockDoc(getMachineFlockDocId(workspaceId, machineId));
          await handle.syncOnce().catch((error: unknown) => {
            console.warn(
              'createWorkspaceRuntime: startup ACP config sync failed; using local rows',
              {
                workspaceId,
                machineId,
                error,
              }
            );
          });
          return Object.values(
            getMachineFlockAgentConfigs(
              readMachineFlockRowsFromFlock(handle.flock, { families: ['agentConfig'] })
            )
          );
        },
        refreshAgentConfig: async (machineId, config, signal = abortController.signal) => {
          if (disposePromise || signal.aborted) {
            return;
          }
          const response = await requestMachineAcpCapabilitiesRefresh(
            {
              type: 'machine/acp-capabilities-refresh',
              machineId,
              workspaceId,
              configId: config.id,
            },
            { signal }
          );
          if (signal.aborted) return;
          if (!response?.success) {
            throw new Error(response?.error ?? 'ACP capability refresh did not return a response');
          }
          if (signal.aborted) return;
          await resyncMachineFlockRows({ repo, workspaceId }, machineId, {
            requireRemoteSync: true,
            refreshedCapability: response.capability
              ? { configId: response.configId, value: response.capability }
              : undefined,
          });
        },
        onError: (error, context) => {
          console.warn('createWorkspaceRuntime: startup ACP capability refresh failed', {
            workspaceId,
            ...context,
            error,
          });
        },
      },
      {
        machineConcurrency: ACP_CAPABILITIES_STARTUP_MACHINE_CONCURRENCY,
        signal: abortController.signal,
      }
    )
      .then(() => {
        if (!abortController.signal.aborted) {
          startupAcpCapabilitiesRefreshCompleted = true;
        }
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) {
          startupAcpCapabilitiesRefreshCompleted = true;
        }
        console.warn('createWorkspaceRuntime: startup ACP capability refresh aborted', {
          workspaceId,
          error,
        });
      })
      .finally(() => {
        if (startupAcpCapabilitiesRefreshAbortController === abortController) {
          startupAcpCapabilitiesRefreshAbortController = null;
        }
        if (
          abortController.signal.aborted &&
          !disposePromise &&
          presenceTransport.getSyncState() === 'synced'
        ) {
          scheduleStartupAcpCapabilitiesRefresh();
        }
      });
  };
  const scheduleStartupAcpCapabilitiesRefresh = (): void => {
    if (
      startupAcpCapabilitiesRefreshCompleted ||
      startupAcpCapabilitiesRefreshAbortController ||
      cancelDelayedStartupAcpCapabilitiesRefresh ||
      disposePromise ||
      !workspaceMetaFirstSynced ||
      presenceTransport.getSyncState() !== 'synced'
    ) {
      return;
    }

    cancelDelayedStartupAcpCapabilitiesRefresh = scheduleAfterStartupNavigationCooldown(
      () => {
        cancelDelayedStartupAcpCapabilitiesRefresh = null;
        startStartupAcpCapabilitiesRefresh();
      },
      { cooldownMs: ACP_CAPABILITIES_STARTUP_NAVIGATION_COOLDOWN_MS }
    );
  };
  const unsubscribeStartupAcpCapabilitiesPresence = presenceTransport.subscribeSyncState(
    (state) => {
      if (state === 'synced') {
        scheduleStartupAcpCapabilitiesRefresh();
      } else {
        startupAcpCapabilitiesRefreshAbortController?.abort();
        cancelDelayedStartupAcpCapabilitiesRefresh?.();
        cancelDelayedStartupAcpCapabilitiesRefresh = null;
      }
    }
  );

  const teardownTransport = async (
    options: {
      stopPresence?: boolean;
      stopRpcClients?: boolean;
      resetStreamsClient?: boolean;
      invalidateTokenProvider?: boolean;
    } = {}
  ) => {
    const stopPresence = options.stopPresence ?? true;
    const stopRpcClients = options.stopRpcClients ?? true;
    const resetStreamsClient = options.resetStreamsClient ?? true;
    const invalidateTokenProvider = options.invalidateTokenProvider ?? true;

    // A runtime-wide teardown owns the mux lifecycle. Let an in-flight cloud
    // member attachment observe dispose/auth state and roll itself back before
    // clearing the repo adapter; otherwise addMember() and mux.close() can race.
    const pendingCloudAttach = cloudTransportAttachPromise;
    if (pendingCloudAttach) {
      await pendingCloudAttach.catch(() => undefined);
    }

    if (stopPresence) {
      await presenceTransport.stop();
      await machineMonitorTransport.stop();
    }
    if (stopRpcClients) {
      for (const client of machineRpcClients.values()) {
        client.stop();
      }
      machineRpcClients.clear();
      machineRpcResponseDispatcher?.stop();
      machineRpcResponseDispatcher = null;
    }
    if (resetStreamsClient) {
      jsonStreamClient = null;
      machineRpcStreamsClientReady = null;
      transportStreamsBaseUrl = null;
    }
    if (invalidateTokenProvider) {
      streamsTokenProvider?.invalidate();
      streamsTokenProvider = null;
    }
    detachMetaRoomStatusListener?.();
    detachMetaRoomStatusListener = null;
    metaTracker?.dispose();
    metaTracker = null;
    cloudMetaTracker?.dispose();
    cloudMetaTracker = null;
    initialMetaSyncCompleted = false;
    initialMetaSyncFailed = false;
    metaFirstSyncRecovery = null;
    metaRemoteCursorInvalidated = false;
    clearReconnectingStatusTimer();
    reconnectingStatusVisible = false;
    localReconnectLoop?.stop();
    cloudReconnectLoop?.stop();

    // Unsubscribe from meta room
    if (metaSub) {
      try {
        metaSub.unsubscribe();
      } catch {
        // ignore
      }
      metaSub = null;
    }

    // Remove both planes' transports (loro-repo keeps room leases; their
    // bindings report 'detached' until a later attach).
    if (transportAttached) {
      await repo.removeTransport('local', { close: true }).catch(() => undefined);
      await repo.removeTransport('cloud', { close: true }).catch(() => undefined);
      transportAttached = false;
    }
    localLoroTransport = null;
    localMachineMonitorTransport?.stop();
    localMachineMonitorTransport = null;
    cloudTransportAttached = false;
    if (localDataPlaneConnectionDispose) {
      localDataPlaneConnectionDispose();
      localDataPlaneConnectionDispose = null;
    }
    if (localPresenceUnsubscribe) {
      localPresenceUnsubscribe();
      localPresenceUnsubscribe = null;
    }

    emitControlConnectionState();
  };

  const startPresenceTransport = () => {
    if (!streamsTokenProvider) {
      console.warn(
        'createWorkspaceRuntime: cannot start presence transport without token provider',
        {
          workspaceId,
        }
      );
      return;
    }
    const durableBaseUrl = getStreamsBaseUrlForProvider(streamsTokenProvider);
    const shardHostSuffix = getStreamsShardHostSuffixForProvider(streamsTokenProvider);
    const presenceBaseUrl = getLoroStreamsPresenceBaseUrl(
      durableBaseUrl,
      undefined,
      shardHostSuffix
    );
    console.info('createWorkspaceRuntime: starting workspace presence transport', {
      workspaceId,
      baseUrl: presenceBaseUrl,
      durableBaseUrl,
      shardHostSuffix,
    });
    presenceTransport.start({
      baseUrl: durableBaseUrl,
      auth: streamsTokenProvider.createAuthCallback(),
      shardHostSuffix,
    });
    machineMonitorTransport.start({
      baseUrl: durableBaseUrl,
      auth: streamsTokenProvider.createAuthCallback(),
      shardHostSuffix,
    });
  };

  const attachLocalLoroDataPlaneTransport = async () => {
    if (transportAttached) {
      return;
    }

    const rawPeerId =
      globalThis.crypto?.randomUUID?.() ?? `renderer:${Date.now()}:${Math.random().toString(36)}`;
    const peerId = `renderer:${rawPeerId}`;

    const localConnection = createLocalLoroDataPlaneConnection();
    if (!localConnection) {
      // Fail fast: local-first mode without the data-plane bridge would be a
      // runtime with NO transport at all (the Streams path is not a fallback
      // here) and a direct-mode writer authoring into an unsyncable mirror — a
      // silent data black hole. Surface it as a runtime initialization error
      // instead (RuntimeProvider maps this to the error connection state).
      throw new Error(
        `local_loro_data_plane_bridge_unavailable: workspace ${workspaceId} is in ` +
          'Electron local-first mode but the preload loroDataPlane API is missing'
      );
    }
    localDataPlaneConnectionDispose = localConnection.dispose;

    localLoroTransport = new LocalLoroTransportAdapter({
      workspaceId,
      peerId,
      connection: localConnection.connection,
    });
    localMachineMonitorTransport = new WorkspaceLocalMachineMonitorTransport({
      workspaceId,
      peerId,
      connection: localConnection.connection,
    });
    targetMachineMonitor.setLocalTransport(localMachineMonitorTransport);
    // Routing comes from resolveRoomTransports (wired to the router at repo
    // construction); per-room cloud bindings notify their own subscribers, so
    // the mux-era member-status side channel is gone by design.
    await repo.addTransport('local', localLoroTransport);

    // Keep local and cloud snapshots independently: the local plane carries
    // only what the local CLI itself authors and is authoritative for that
    // instance, while every remote origin reaches us through the cloud replica
    // alone — see `mergePresenceSnapshots`.
    if (getIpcServices() && deps.onPresenceSnapshot) {
      const presenceStore = new EphemeralStore(LODY_PRESENCE_TTL_MS);
      localPresenceUnsubscribe = onIpcEvent('loro.event', (message) => {
        if (message.type !== 'presence') return;
        if (message.workspaceId !== workspaceId) return;
        presenceStore.apply(base64ToBytes(message.dataBase64));
        latestLocalOriginPresenceStates = parseLodyPresenceStates(
          presenceStore.getAllStates() as Record<string, unknown>
        );
        publishMergedPresence();
      });
    }

    transportAttached = true;
    transportReady.resolve();
    console.info('createWorkspaceRuntime: local Loro data-plane transport attached', {
      workspaceId,
    });
    emitControlConnectionState();
  };

  const createStreamsDurableTransport = (
    activeStreamsTokenProvider: LoroStreamsTokenProvider,
    streamsBaseUrl: string
  ): StreamsTransportAdapter =>
    new StreamsTransportAdapter({
      bucketId: LORO_STREAMS_BUCKET_ID,
      metaStreamId: getLoroMetaStreamId(workspaceId),
      docStreamId: (docId) => getLoroStreamIdForDocId(workspaceId, docId),
      flockDocStreamId: (flockDocId) => flockDocId,
      auth: activeStreamsTokenProvider.createAuthCallback(),
      remoteCursorStore,
      snapshotCodec: streamsSnapshotCodec,
      baseUrl: streamsBaseUrl,
      shardUrls: getLoroStreamsShardUrls(
        streamsBaseUrl,
        getStreamsShardHostSuffixForProvider(activeStreamsTokenProvider)
      ),
      snapshotUpload: {
        canUpload: async () => true,
      },
      onPersistDoc: async () => {
        await repo.flush();
      },
      onPersistMeta: async () => {
        await repo.flush();
      },
      onPersistFlockDoc: async () => {
        await repo.flush();
      },
    });

  const attachCloudMetaHealthTracker = (): void => {
    // The per-transport binding is stable across cloud detach/attach cycles
    // ('detached' while absent), so this tracker survives token rotations.
    const cloudMetaSub = metaSub?.subscription('cloud');
    if (!cloudMetaSub) {
      return;
    }
    cloudMetaTracker?.dispose();
    const currentCloudMetaTracker = createTrackedRoomSyncTracker(cloudMetaSyncRoomId);
    cloudMetaTracker = currentCloudMetaTracker;
    currentCloudMetaTracker.attach(cloudMetaSub);
    void cloudMetaSub.firstSyncedWithRemote
      .then(() => {
        if (cloudMetaTracker === currentCloudMetaTracker) {
          currentCloudMetaTracker.markFirstSynced();
        }
      })
      .catch(() => {
        if (cloudMetaTracker === currentCloudMetaTracker) {
          currentCloudMetaTracker.markFirstSyncFailed();
        }
      });
  };

  const attachTransportAdapter = async (options: { startPresence?: boolean } = {}) => {
    const shouldStartPresence = options.startPresence ?? true;
    const startedAt = Date.now();
    console.info('createWorkspaceRuntime: attaching Loro Streams transport', {
      workspaceId,
      hasAuthToken: !!authToken,
    });
    try {
      console.debug('createWorkspaceRuntime: prefetching Loro Streams token', { workspaceId });
      const { provider: activeStreamsTokenProvider, streamsBaseUrl } = await prepareStreamsAccess();
      console.info('createWorkspaceRuntime: Loro Streams token ready', {
        workspaceId,
        streamsBaseUrl,
        elapsedMs: Date.now() - startedAt,
      });
      if (shouldStartPresence) {
        startPresenceTransport();
      }

      createMachineRpcJsonStreamClient(activeStreamsTokenProvider, streamsBaseUrl);

      const transportAdapter = createStreamsDurableTransport(
        activeStreamsTokenProvider,
        streamsBaseUrl
      );

      // Web routes every room to ['cloud'] (router non-localFirst path), so
      // the single transport must be registered under that id.
      await repo.addTransport('cloud', transportAdapter, { ephemeral: true });
    } catch (error) {
      // runtime_init_failed (spec §5.2, P0): durable transport attach is the
      // gate for all remote sync; surfacing its failure with a reason_code is a
      // churn-attribution signal. Re-thrown so existing error flow is unchanged;
      // dispose-time "Destroyed" teardown is not a product failure.
      if (!isDestroyedError(error)) {
        emitAnalytics('workspace/runtime_init_failed', {
          reason_code: classifyMetaSyncReason(error),
          error_name: error instanceof Error ? error.name : 'unknown',
          transport_attached: transportAttached,
          duration_ms: Date.now() - startedAt,
        });
      }
      if (shouldStartPresence) {
        await presenceTransport.stop();
        await machineMonitorTransport.stop();
      }
      throw error;
    }

    transportAttached = true;
    transportReady.resolve();
    console.info('createWorkspaceRuntime: Loro Streams transport attached', {
      workspaceId,
      streamsBaseUrl: transportStreamsBaseUrl,
      elapsedMs: Date.now() - startedAt,
    });
    emitControlConnectionState();
  };

  const attachCloudPlaneTransport = async (): Promise<void> => {
    // Single choke point for the local-only zero-cloud-I/O invariant: every
    // caller (token change, reconnect loop, ensureDocStream) funnels here.
    if (!cloudPlaneEnabled) {
      return;
    }
    if (cloudTransportAttached || !authToken || !isBrowserOnline()) {
      return;
    }
    if (cloudTransportAttachPromise) {
      await cloudTransportAttachPromise;
      return;
    }
    if (!transportAttached) {
      return;
    }
    const pendingAttach = (async () => {
      const startedAt = Date.now();
      const { provider, streamsBaseUrl } = await prepareStreamsAccess();
      if (disposePromise || !authToken) {
        return;
      }
      startPresenceTransport();
      createMachineRpcJsonStreamClient(provider, streamsBaseUrl);
      try {
        // addTransport joins routed rooms but does not await their catch-up
        // (per-room first sync stays observable on each cloud binding).
        await repo.addTransport('cloud', createStreamsDurableTransport(provider, streamsBaseUrl), {
          ephemeral: true,
        });
        if (disposePromise || !authToken || !transportAttached) {
          await repo.removeTransport('cloud', { close: true }).catch(() => undefined);
          return;
        }
        attachCloudMetaHealthTracker();
        cloudTransportAttached = true;
        notifyConnectionStateInputsChanged();
        console.info('createWorkspaceRuntime: cloud data plane attached', {
          workspaceId,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (error) {
        cloudMetaTracker?.dispose();
        cloudMetaTracker = null;
        await Promise.all([presenceTransport.stop(), machineMonitorTransport.stop()]);
        await repo.removeTransport('cloud', { close: true }).catch(() => undefined);
        throw error;
      }
    })();
    cloudTransportAttachPromise = pendingAttach;
    try {
      await pendingAttach;
    } finally {
      if (cloudTransportAttachPromise === pendingAttach) {
        cloudTransportAttachPromise = null;
      }
    }
  };

  const detachCloudPlaneTransport = async (): Promise<void> => {
    const pendingAttach = cloudTransportAttachPromise;
    if (pendingAttach) {
      await pendingAttach.catch(() => undefined);
    }
    cloudReconnectLoop?.stop();
    cloudMetaTracker?.dispose();
    cloudMetaTracker = null;
    await Promise.all([presenceTransport.stop(), machineMonitorTransport.stop()]);
    latestCloudPresenceStates = {};
    publishMergedPresence();
    if (transportAttached) {
      await repo.removeTransport('cloud', { close: true }).catch(() => undefined);
    }
    cloudTransportAttached = false;
    notifyConnectionStateInputsChanged();
    for (const client of machineRpcClients.values()) {
      client.stop();
    }
    machineRpcClients.clear();
    machineRpcResponseDispatcher?.stop();
    machineRpcResponseDispatcher = null;
    jsonStreamClient = null;
    machineRpcStreamsClientReady = null;
    transportStreamsBaseUrl = null;
    streamsTokenProvider?.invalidate();
    streamsTokenProvider = null;
  };

  const ensureMetaRoomSynced = async (syncPhase: 'initial' | 'recovery' = 'initial') => {
    if (metaSub) {
      return;
    }
    initialMetaSyncCompleted = false;
    initialMetaSyncFailed = false;
    metaFirstSyncRecovery = null;
    // Fresh tracker per join cycle: stale status/first-sync state from a
    // previous transport attach must never leak into this one. Registered in
    // roomSyncRegistry so meta health feeds the reconnect loop like any room.
    metaTracker?.dispose();
    const currentMetaTracker = createTrackedRoomSyncTracker(getLoroMetaStreamId(workspaceId));
    metaTracker = currentMetaTracker;
    emitControlConnectionState();
    console.debug('Joining repo meta room', { workspaceId });
    const joinStartedAt = Date.now();
    const joinCursorBypassed = isMetaRemoteCursorBypassActive();
    try {
      metaSub = await repo.joinMetaRoom();
      if (cloudTransportAttached) {
        attachCloudMetaHealthTracker();
      }
    } catch (error) {
      initialMetaSyncCompleted = false;
      initialMetaSyncFailed = true;
      currentMetaTracker.markFirstSyncFailed();
      emitAnalytics('workspace/meta_sync_failed', {
        reason_code: classifyMetaSyncReason(error),
        error_name: error instanceof Error ? error.name : 'unknown',
        meta_room_status: 'error',
        cursor_bypassed: joinCursorBypassed,
        duration_ms: Date.now() - joinStartedAt,
        phase: syncPhase,
      });
      console.error('Failed to join repo meta room', {
        workspaceId,
        elapsedMs: Date.now() - joinStartedAt,
        status: 'error',
        error,
      });
      void invalidateMetaRemoteCursor('Failed to join repo meta room', error);
      notifyConnectionStateInputsChanged();
      return;
    }
    // Meta readiness is a per-plane selection: the offline-capable local
    // binding on Electron, the cloud binding on Web. The aggregate members
    // would throw on the dual-homed Electron meta room by design; staleness
    // checks below keep comparing the aggregate join handle.
    const currentMetaAggregate = metaSub;
    const currentMetaSub = metaSub.subscription(electronLocalDataPlane ? 'local' : 'cloud');
    currentMetaTracker.attach(currentMetaSub);
    console.debug('Repo meta room join returned', { workspaceId, status: currentMetaSub.status });
    detachMetaRoomStatusListener?.();
    const watchMetaFirstSync = (
      failureMessage: string,
      timeoutMessage: string,
      watchPhase: 'initial' | 'recovery'
    ): Promise<void> => {
      const startedAt = Date.now();
      const watchCursorBypassed = isMetaRemoteCursorBypassActive();
      const firstSyncPromise = currentMetaSub.firstSyncedWithRemote;
      // Each watch invocation reports exactly one terminal meta-sync outcome.
      // The success/failure handlers and the timeout race can otherwise both
      // fire (e.g. slow reject after a timeout), so guard double-emit here.
      let metaSyncOutcomeReported = false;
      console.info('createWorkspaceRuntime: waiting for repo meta room first remote sync', {
        workspaceId,
        status: currentMetaSub.status,
        timeoutMs: META_FIRST_SYNC_TIMEOUT_MS,
      });
      void firstSyncPromise
        .then(() => {
          if (disposePromise || metaSub !== currentMetaAggregate) {
            return;
          }
          initialMetaSyncCompleted = true;
          initialMetaSyncFailed = false;
          currentMetaTracker.markFirstSynced();
          clearMetaRemoteCursorBypass();
          // Claim the single-outcome slot on success so a later transient
          // failure can't emit a false meta_sync_failed/timed_out. The success
          // event itself was removed as low-value (high volume, no churn signal).
          metaSyncOutcomeReported = true;
          console.info('createWorkspaceRuntime: repo meta room first remote sync completed', {
            workspaceId,
            elapsedMs: Date.now() - startedAt,
            status: currentMetaSub.status,
          });
          notifyConnectionStateInputsChanged();
          workspaceMetaFirstSynced = true;
          scheduleStartupAcpCapabilitiesRefresh();
          // Start background eager-sync only after the meta room has synced, so
          // session prefetches never compete with the meta room's first join
          // (liveness invariant). Idempotent across recovery re-syncs.
          startBackgroundSyncCoordinator();
        })
        .catch((error: unknown) => {
          if (disposePromise || metaSub !== currentMetaAggregate || initialMetaSyncCompleted) {
            return;
          }
          initialMetaSyncCompleted = false;
          initialMetaSyncFailed = true;
          currentMetaTracker.markFirstSyncFailed();
          if (!metaSyncOutcomeReported) {
            metaSyncOutcomeReported = true;
            emitAnalytics('workspace/meta_sync_failed', {
              reason_code: classifyMetaSyncReason(error),
              error_name: error instanceof Error ? error.name : 'unknown',
              meta_room_status: currentMetaSub.status,
              cursor_bypassed: watchCursorBypassed,
              duration_ms: Date.now() - startedAt,
              phase: watchPhase,
            });
          }
          console.error(failureMessage, {
            workspaceId,
            elapsedMs: Date.now() - startedAt,
            status: currentMetaSub.status,
            error,
          });
          void invalidateMetaRemoteCursor(failureMessage, error);
          notifyConnectionStateInputsChanged();
        });

      // Liveness invariant: meta room remote sync must either complete or enter
      // a reconnectable state within a bounded time. The local task list may be
      // readable from IndexedDB, but durable Loro Streams sync cannot stay stuck
      // behind that local state forever.
      return withTimeout(
        firstSyncPromise,
        META_FIRST_SYNC_TIMEOUT_MS,
        `${timeoutMessage} after ${META_FIRST_SYNC_TIMEOUT_MS}ms`
      ).catch((error: unknown) => {
        if (
          !isTimeoutError(error) ||
          disposePromise ||
          metaSub !== currentMetaAggregate ||
          initialMetaSyncCompleted
        ) {
          return;
        }
        initialMetaSyncCompleted = false;
        initialMetaSyncFailed = true;
        currentMetaTracker.markFirstSyncFailed();
        if (!metaSyncOutcomeReported) {
          metaSyncOutcomeReported = true;
          emitAnalytics('workspace/meta_sync_timed_out', {
            timeout_ms: META_FIRST_SYNC_TIMEOUT_MS,
            meta_room_status: currentMetaSub.status,
            cursor_bypassed: watchCursorBypassed,
            duration_ms: Date.now() - startedAt,
            phase: watchPhase,
          });
        }
        void invalidateMetaRemoteCursor(timeoutMessage, error);
        console.warn(timeoutMessage, {
          workspaceId,
          timeoutMs: META_FIRST_SYNC_TIMEOUT_MS,
          elapsedMs: Date.now() - startedAt,
          status: currentMetaSub.status,
          error,
        });
        notifyConnectionStateInputsChanged();
      });
    };
    const retryMetaFirstSyncAfterReconnect = () => {
      if (initialMetaSyncCompleted || metaFirstSyncRecovery) {
        return;
      }

      initialMetaSyncFailed = false;
      const recovery = watchMetaFirstSync(
        'Failed to recover repo meta room sync',
        'Timed out waiting for repo meta room sync recovery',
        'recovery'
      ).finally(() => {
        if (metaFirstSyncRecovery === recovery) {
          metaFirstSyncRecovery = null;
        }
      });
      metaFirstSyncRecovery = recovery;
    };
    // Meta-specific first-sync recovery policy (timeout + analytics + cursor
    // invalidation). Plain health mirroring lives in currentMetaTracker.
    detachMetaRoomStatusListener = currentMetaSub.onStatusChange((status) => {
      if (disposePromise || metaSub !== currentMetaAggregate) {
        return;
      }
      console.info('createWorkspaceRuntime: repo meta room status changed', {
        workspaceId,
        status,
        initialMetaSyncCompleted,
        initialMetaSyncFailed,
      });
      if (status === 'joined') {
        if (initialMetaSyncCompleted) {
          initialMetaSyncFailed = false;
        } else if (initialMetaSyncFailed) {
          retryMetaFirstSyncAfterReconnect();
        }
      }
      notifyConnectionStateInputsChanged();
    });
    void watchMetaFirstSync(
      'Failed to sync repo meta room',
      'Timed out waiting for repo meta room initial sync',
      'initial'
    );
  };

  const restartDurableTransportForMetaSyncRecovery = async (reason: string): Promise<void> => {
    const startedAt = Date.now();
    console.warn('createWorkspaceRuntime: restarting durable transport for meta room recovery', {
      workspaceId,
      reason,
      metaSyncState: metaSyncState(),
      initialMetaSyncCompleted,
      initialMetaSyncFailed,
    });

    await invalidateMetaRemoteCursor(reason, new Error(reason));
    await teardownTransport({
      stopPresence: false,
      stopRpcClients: false,
      resetStreamsClient: false,
      invalidateTokenProvider: false,
    });
    if (disposePromise || !authToken) {
      console.info('createWorkspaceRuntime: skipped meta room recovery after teardown', {
        workspaceId,
        reason,
        disposed: !!disposePromise,
        hasAuthToken: !!authToken,
      });
      return;
    }

    await attachTransportAdapter({ startPresence: false });
    if (disposePromise) {
      return;
    }
    await ensureMetaRoomSynced('recovery');
    if (disposePromise) {
      return;
    }
    console.warn('createWorkspaceRuntime: durable transport restarted for meta room recovery', {
      workspaceId,
      reason,
      elapsedMs: Date.now() - startedAt,
    });
  };

  const setAuthToken = async (token: string | null) => {
    if (disposePromise) {
      return;
    }
    const nextAuthToken = token && token !== '' ? token : null;
    const previousAuthToken = authToken;
    if (previousAuthToken === nextAuthToken) {
      console.debug('createWorkspaceRuntime: auth token unchanged', {
        workspaceId,
        hasAuthToken: !!nextAuthToken,
      });
      if (electronLocalDataPlane && nextAuthToken && !cloudTransportAttached) {
        try {
          await attachCloudPlaneTransport();
        } finally {
          cloudReconnectLoop?.update();
        }
      }
      return;
    }
    console.info('createWorkspaceRuntime: auth token changed', {
      workspaceId,
      hadAuthToken: !!previousAuthToken,
      hasAuthToken: !!nextAuthToken,
    });
    authToken = nextAuthToken;
    emitControlConnectionState();

    if (electronLocalDataPlane) {
      if (authToken === null) {
        await detachCloudPlaneTransport();
        console.info('createWorkspaceRuntime: auth token cleared; cloud data plane stopped', {
          workspaceId,
        });
        return;
      }
      if (previousAuthToken && cloudTransportAttached) {
        cloudReconnectLoop?.trigger('token-refresh');
        return;
      }
      try {
        await attachCloudPlaneTransport();
      } finally {
        cloudReconnectLoop?.update();
      }
      return;
    }
    if (previousAuthToken && nextAuthToken && transportAttached) {
      console.info(
        'createWorkspaceRuntime: auth token refreshed; keeping durable transport attached',
        {
          workspaceId,
          hasMetaRoom: !!metaSub,
          initialMetaSyncCompleted,
          initialMetaSyncFailed,
        }
      );
      if (!metaSub) {
        await ensureMetaRoomSynced();
      }
      notifyConnectionStateInputsChanged();
      // A fresh token is a hard reconnect signal: connections that died on 401
      // while the old token was stale (e.g. wake after a long sleep) can only
      // recover now. trigger() resets the retry backoff and reconciles.
      localReconnectLoop?.trigger('token-refresh');
      return;
    }

    try {
      await teardownTransport();
    } catch (error) {
      if (isDestroyedError(error)) {
        return;
      }
      throw error;
    }
    if (disposePromise) {
      return;
    }

    if (authToken === null) {
      console.info('createWorkspaceRuntime: auth token cleared; durable transport stopped', {
        workspaceId,
      });
      return;
    }

    deps.onControlConnectionStateChange?.('connecting');
    await attachTransportAdapter();
    if (disposePromise) {
      return;
    }

    await ensureMetaRoomSynced();
    if (disposePromise) {
      return;
    }
  };

  const setLocalMachineId = (machineId: MachineId | null) => {
    targetRouter.setLocalMachineId(machineId);
  };

  // Presence (Ephemeral Stream) health lives in the same registry as durable
  // rooms so hasReconnectableProblem() and the reconnect loop cover it — the
  // ephemeral read loop terminates on non-retriable errors (e.g. 401 after a
  // long sleep) and can only be revived by restarting the transport. The
  // `presence:` key namespace never collides with durable room ids. The
  // control connection indicator stays meta-room-only: it never reads this
  // registry (see resolveControlConnectionState). Registered here (not next to
  // the registry) because subscribeSyncState fires synchronously on track and
  // must not run before notifyConnectionStateInputsChanged's dependencies
  // initialize.
  const presenceSyncRoomId = `presence:${workspaceId}`;
  const untrackPresenceSync = roomSyncRegistry.track({
    roomId: presenceSyncRoomId,
    getSyncState: () => presenceTransport.getSyncState(),
    subscribeSyncState: (listener) => presenceTransport.subscribeSyncState(listener),
    needsReconnect: () => presenceTransport.needsReconnect(),
  });
  const unsubscribePresenceSyncState = deps.onPresenceSyncStateChange
    ? presenceTransport.subscribeSyncState(deps.onPresenceSyncStateChange)
    : null;
  const machineMonitorSyncRoomId = `machine-monitor:${workspaceId}`;
  const untrackMachineMonitorSync = roomSyncRegistry.track({
    roomId: machineMonitorSyncRoomId,
    getSyncState: () => machineMonitorTransport.getSyncState(),
    subscribeSyncState: (listener) => machineMonitorTransport.subscribeSyncState(listener),
    needsReconnect: () => machineMonitorTransport.needsReconnect(),
  });

  localReconnectLoop = createLocalReconnectLoop({
    canRun: canRunLocalReconnect,
    hasProblem: hasReconnectableProblem,
    reconnect: async ({ force, triggerReason }) => {
      const startedAt = Date.now();
      // Reconcile is diff-driven: healthy connections are never torn down.
      // Durable rooms go through repo.reconnect(), which internally revives
      // only dead room sessions, so it also runs on force triggers where a
      // room may be dead without the registry knowing (adapter-level status
      // can stay "connected" while individual room sessions are gone).
      // Presence restart is a real teardown. Do it for known terminal states,
      // and for browser wake/online edges when the ephemeral stream looks stale
      // or stuck in a non-synced state.
      const presenceProblem = !electronLocalDataPlane && presenceTransport.needsReconnect();
      const machineMonitorProblem =
        !electronLocalDataPlane && machineMonitorTransport.needsReconnect();
      const restartPresenceForWake =
        !electronLocalDataPlane &&
        force &&
        (triggerReason === 'visibility-wake' || triggerReason === 'network-online') &&
        presenceTransport.shouldRestartOnExternalWake();
      const restartMachineMonitorForWake =
        !electronLocalDataPlane &&
        force &&
        (triggerReason === 'visibility-wake' || triggerReason === 'network-online') &&
        machineMonitorTransport.shouldRestartOnExternalWake();
      const durableProblemRooms = roomSyncRegistry.listNeedsReconnect(
        (roomId) =>
          roomId !== presenceSyncRoomId &&
          roomId !== machineMonitorSyncRoomId &&
          (!electronLocalDataPlane || isLocalHealthRoom(roomId))
      );
      const durableProblem = durableProblemRooms.length > 0;
      const reason =
        initialMetaSyncFailed && !initialMetaSyncCompleted
          ? 'initial-meta-sync-failed'
          : 'room-reconnect-signal';
      console.info('createWorkspaceRuntime: reconnect attempt started', {
        workspaceId,
        reason,
        triggerReason,
        force,
        durableProblem,
        // Name the broken rooms (bounded) so a reconnect storm is attributable
        // to a specific room instead of a bare boolean.
        durableProblemRooms: durableProblemRooms.slice(0, 8),
        durableProblemRoomCount: durableProblemRooms.length,
        presenceProblem,
        machineMonitorProblem,
        restartPresenceForWake,
        restartMachineMonitorForWake,
        metaSyncState: metaSyncState(),
        initialMetaSyncCompleted,
        initialMetaSyncFailed,
      });
      if (force || durableProblem) {
        try {
          await releaseIdleDocumentStoresBeforeReconnect();
        } catch (error) {
          console.warn('createWorkspaceRuntime: failed to release idle stores before reconnect', {
            workspaceId,
            error,
          });
        }
        if (initialMetaSyncFailed && !initialMetaSyncCompleted && !electronLocalDataPlane) {
          await restartDurableTransportForMetaSyncRecovery(reason);
        } else {
          await repo.reconnect(
            electronLocalDataPlane
              ? { transportIds: ['local'], resetBackoff: true }
              : { resetBackoff: true }
          );
        }
      }
      if (
        (presenceProblem ||
          restartPresenceForWake ||
          machineMonitorProblem ||
          restartMachineMonitorForWake) &&
        !disposePromise &&
        transportAttached &&
        streamsTokenProvider
      ) {
        console.info(
          'createWorkspaceRuntime: restarting ephemeral transports after reconnect signal',
          {
            workspaceId,
            triggerReason,
            presenceProblem,
            restartPresenceForWake,
            presenceSyncState: presenceTransport.getSyncState(),
            machineMonitorSyncState: machineMonitorTransport.getSyncState(),
          }
        );
        await Promise.all([presenceTransport.stop(), machineMonitorTransport.stop()]);
        // Re-check: teardownTransport() may have run while stop() awaited.
        if (!disposePromise && transportAttached && streamsTokenProvider) {
          startPresenceTransport();
        }
      }
      console.info('createWorkspaceRuntime: reconnect attempt completed', {
        workspaceId,
        reason,
        triggerReason,
        force,
        elapsedMs: Date.now() - startedAt,
        metaSyncState: metaSyncState(),
        initialMetaSyncCompleted,
        initialMetaSyncFailed,
        presenceSyncState: presenceTransport.getSyncState(),
      });
    },
    onStateChange: emitControlConnectionState,
    onError: (error) => {
      console.warn('createWorkspaceRuntime: reconnect attempt failed', {
        workspaceId,
        metaSyncState: metaSyncState(),
        initialMetaSyncCompleted,
        initialMetaSyncFailed,
        error,
      });
    },
  });

  if (electronLocalDataPlane && cloudPlaneEnabled) {
    cloudReconnectLoop = createLocalReconnectLoop({
      canRun: canRunCloudReconnect,
      hasProblem: hasCloudReconnectableProblem,
      reconnect: async ({ force, triggerReason }) => {
        if (!cloudTransportAttached) {
          await attachCloudPlaneTransport();
          return;
        }
        const durableProblemRooms = roomSyncRegistry.listNeedsReconnect(
          (roomId) =>
            roomId !== presenceSyncRoomId &&
            roomId !== machineMonitorSyncRoomId &&
            isCloudHealthRoom(roomId)
        );
        // Registry-invisible failures on dual-homed rooms; the member rejoin
        // below re-exports the delta from the server-known version, so pending
        // local ops flush with it.
        const cloudMemberProblemRooms = listCloudTransportProblemRooms();
        const restartPresence =
          presenceTransport.needsReconnect() ||
          (force &&
            (triggerReason === 'visibility-wake' || triggerReason === 'network-online') &&
            presenceTransport.shouldRestartOnExternalWake());
        const restartMachineMonitor =
          machineMonitorTransport.needsReconnect() ||
          (force &&
            (triggerReason === 'visibility-wake' || triggerReason === 'network-online') &&
            machineMonitorTransport.shouldRestartOnExternalWake());

        if (force || durableProblemRooms.length > 0 || cloudMemberProblemRooms.length > 0) {
          await repo.reconnect({ transportIds: ['cloud'], resetBackoff: true });
          // Adapter reconnect revives adapter-level sessions but does not retry
          // loro-repo-level FAILED ATTACHES (binding 'error'); only the per-room
          // rejoin re-runs the attach. Bounded per rejoin, in width, and in
          // total: rejoin awaits doc setup inside loro-repo with no deadline of
          // its own, and this runs inside the reconnect loop's `inFlight` guard
          // — one that never settles would kill cloud repair for the runtime's
          // lifetime. Leftovers are picked up by the next pass.
          const errored = listCloudTransportProblemEntries().filter(
            (entry) => entry.subscription.status === 'error'
          );
          const sweepDeadline = Date.now() + CLOUD_REJOIN_SWEEP_BUDGET_MS;
          for (let i = 0; i < errored.length; i += CLOUD_REJOIN_SWEEP_CONCURRENCY) {
            if (Date.now() >= sweepDeadline) {
              break;
            }
            await Promise.all(
              errored
                .slice(i, i + CLOUD_REJOIN_SWEEP_CONCURRENCY)
                .map((entry) =>
                  withTimeout(
                    entry.subscription.rejoin(),
                    CLOUD_REJOIN_TIMEOUT_MS,
                    `Timeout rejoining cloud binding (room=${entry.room.kind}:${entry.room.id})`
                  ).catch(() => undefined)
                )
            );
          }
        }
        if (
          (restartPresence || restartMachineMonitor) &&
          !disposePromise &&
          cloudTransportAttached &&
          streamsTokenProvider
        ) {
          await Promise.all([presenceTransport.stop(), machineMonitorTransport.stop()]);
          if (!disposePromise && cloudTransportAttached && streamsTokenProvider) {
            startPresenceTransport();
          }
        }
      },
      onStateChange: () => {},
      onError: (error) => {
        console.warn('createWorkspaceRuntime: cloud data-plane reconnect failed', {
          workspaceId,
          error,
        });
      },
    });
  }

  if (electronLocalDataPlane) {
    await attachLocalLoroDataPlaneTransport();
    await ensureMetaRoomSynced();
  } else if (deps.token != null && deps.token !== '') {
    await setAuthToken(deps.token);
  }

  const ensureDocStream = async (roomId: string): Promise<void> => {
    if (electronLocalDataPlane) {
      const plane = await targetRouter.prepareDocTarget(roomId);
      if (plane === 'local' || !cloudPlaneEnabled) {
        return;
      }
      await attachCloudPlaneTransport();
    }
    await transportReady.promise;
    const provider = streamsTokenProvider;
    if (!provider) {
      throw new Error('Loro Streams token provider not ready');
    }

    const streamId = getLoroStreamIdForDocId(workspaceId, roomId);
    const streamsBaseUrl = transportStreamsBaseUrl ?? getStreamsBaseUrlForProvider(provider);

    const attemptCreate = async (): Promise<void> => {
      const transport = new StreamsCrdt({
        streamUrl: createLoroStreamUrl({
          bucketId: LORO_STREAMS_BUCKET_ID,
          streamId,
          baseUrl: streamsBaseUrl,
        }),
        auth: provider.createAuthCallback(),
        adapter: createLoroDocAdapter(new LoroDoc()),
        shardUrls: getLoroStreamsShardUrls(
          streamsBaseUrl,
          getStreamsShardHostSuffixForProvider(provider)
        ),
        snapshotCodec: streamsSnapshotCodec,
      });
      try {
        // New session docs create the remote stream before any room join.
        // This avoids paying the stream_not_found fallback/retry path on first open.
        const created = await withTimeout(
          transport.createStream(),
          DOC_STREAM_CREATE_TIMEOUT_MS,
          `Timeout creating Loro doc stream (room=${roomId})`
        );
        if (!created.ok) {
          throw new Error(
            `Failed to create Loro doc stream: ${formatTransportError(created.error)}`
          );
        }
      } finally {
        await transport.close().catch(() => {});
      }
    };

    // Machines joining the session doc room depend on this stream existing; a
    // transient create failure used to be dropped silently, leaving the CLI's
    // join retries to hit stream_not_found until the pending-turn wait expired.
    const maxAttempts = 3;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await attemptCreate();
        return;
      } catch (error) {
        if (attempt >= maxAttempts) {
          throw error;
        }
        console.warn('Retrying Loro doc stream creation', { roomId, attempt, error });
        await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
      }
    }
  };

  /**
   * Create a session store that can read local data immediately (offline-first).
   * Remote sync is deferred until transport is ready (workspaceId is set).
   */
  const createSessionStore = async (sessionId: SessionId): Promise<SessionDocStore> => {
    const roomId = getSessionRoomId(sessionId);

    // Open persisted doc immediately - this reads from local IndexedDB
    // and does NOT require transport/workspaceId
    const persistedDoc = await repo.openPersistedDoc(roomId);

    const mirror = new Mirror({
      doc: persistedDoc.doc as LoroDoc,
      schema: sessionDocSchema,
      // Tolerate root keys written by peers running a newer schema version.
      ignoreUnknownProperties: true,
      // Plan is now stored per-turn on history entries, not at root level
      initialState: { session: { id: sessionId }, history: [] },
      debug: false,
    });

    const syncTracker = createTrackedRoomSyncTracker(roomId);
    // Track subscription for cleanup
    let roomSub: Awaited<ReturnType<typeof persistedDoc.joinRoom>> | null = null;
    let cloudRepairUnsubscribe: (() => void) | null = null;
    let disposed = false;
    let syncLeaseCount = 0;
    let syncReleaseTimer: ReturnType<typeof setTimeout> | null = null;
    let syncJoinPromise: Promise<void> | null = null;
    let resolveFirstSynced: (() => void) | null = null;
    const firstSynced = new Promise<void>((resolve) => {
      resolveFirstSynced = resolve;
    });

    const clearSyncReleaseTimer = () => {
      if (syncReleaseTimer !== null) {
        clearTimeout(syncReleaseTimer);
        syncReleaseTimer = null;
      }
    };

    const stopSyncNow = () => {
      clearSyncReleaseTimer();
      cloudRepairUnsubscribe?.();
      cloudRepairUnsubscribe = null;
      if (roomSub) {
        const sub = roomSub;
        roomSub = null;
        sub.unsubscribe();
        // unsubscribe() does not emit a status change, so the tracker would keep
        // reporting its last 'synced' state. Reset it to idle so the room-sync
        // registry no longer treats this warmed room as joined (which would
        // suppress eager sync and block warm-doc LRU eviction).
        syncTracker.markStopped();
      }
    };

    const startSync = () => {
      clearSyncReleaseTimer();
      if (disposed || roomSub || syncJoinPromise) {
        return;
      }

      // Join only while a UI surface has an active sync lease. The persisted
      // doc and Mirror stay in memory for fast tab switches; the SSE connection
      // is the part we debounce and release.
      syncJoinPromise = transportReady.promise.then(async () => {
        if (disposed || syncLeaseCount <= 0) {
          return;
        }
        try {
          // Best-effort ownership resolution: an unknown room mounts pure cloud
          // and gains its local member when meta resolves (refreshRoutes).
          await targetRouter.prepareSessionTarget(sessionId).catch(() => undefined);
          const joined = await waitForRoomToSync(() => persistedDoc.joinRoom(), {
            roomId,
            // Give the caller one task to populate the new doc before bootstrapping
            // the remote room. This avoids racing brand-new session creation.
            initialDelayMs: 0,
            isCancelled: () => disposed || syncLeaseCount <= 0,
            firstSynced: (sub) => readinessBindingForDocRoom(sub, roomId).firstSyncedWithRemote,
            onSubscription: (joinedSub) => {
              roomSub = joinedSub;
              syncTracker.attach(readinessBindingForDocRoom(joinedSub, roomId));
              cloudRepairUnsubscribe?.();
              cloudRepairUnsubscribe = watchCloudBindingForRepair(joinedSub);
            },
          });
          if (!joined) {
            return;
          }
          if (disposed || syncLeaseCount <= 0) {
            joined.unsubscribe();
            if (roomSub === joined) {
              roomSub = null;
            }
            return;
          }
          roomSub = joined;
          syncTracker.markFirstSynced();
          resolveFirstSynced?.();
          resolveFirstSynced = null;
        } catch (error) {
          syncTracker.markFirstSyncFailed();
          throw error;
        }
      });
      void syncJoinPromise
        .catch(() => {})
        .finally(() => {
          syncJoinPromise = null;
        });
    };

    const acquireSync = () => {
      if (disposed) {
        return () => {};
      }
      syncLeaseCount += 1;
      startSync();
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        syncLeaseCount = Math.max(0, syncLeaseCount - 1);
        if (syncLeaseCount > 0 || disposed) {
          return;
        }
        clearSyncReleaseTimer();
        syncReleaseTimer = setTimeout(stopSyncNow, SESSION_ROOM_SYNC_RELEASE_DELAY_MS);
      };
    };

    void firstSynced.catch(() => {});

    return {
      sessionId,
      roomId,
      doc: persistedDoc.doc as LoroDoc,
      firstSynced,
      acquireSync,
      getSyncState: () =>
        syncLeaseCount > 0 || roomSub || syncJoinPromise ? syncTracker.getSyncState() : 'idle',
      subscribeSyncState: (listener) =>
        syncTracker.subscribeSyncState((state) => {
          listener(syncLeaseCount > 0 || roomSub || syncJoinPromise ? state : 'idle');
        }),
      getState: () => mirror.getState(),
      setState: (updater) => {
        mirror.setState(updater as never);
      },
      subscribe: (listener) => mirror.subscribe(listener),
      dispose: () => {
        disposed = true;
        stopSyncNow();
        syncTracker.dispose();
        mirror.dispose();
      },
      waitUntilSynced: async (signal?: AbortSignal) => {
        await transportReady.promise;
        if (signal?.aborted) {
          return;
        }
        const releaseSync = acquireSync();
        try {
          // Resolves when the caller aborts so we can stop awaiting the room join
          // and release our sync lease promptly. Without this, an aborted prefetch
          // would keep the lease (and the SSE join) alive until the room naturally
          // settled, defeating the offline/hidden/timeout pause.
          const aborted = signal
            ? new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true });
              })
            : null;
          if (syncJoinPromise) {
            const join = syncJoinPromise.catch(() => {});
            await (aborted ? Promise.race([join, aborted]) : join);
          }
          if (signal?.aborted) {
            return;
          }
          const synced = roomSub ? waitUntilRoomSynced(roomSub, roomId) : undefined;
          if (synced) {
            await (aborted ? Promise.race([synced, aborted]) : synced);
          }
        } finally {
          releaseSync();
        }
      },
    };
  };

  const sessionStoreCache = createManagedStoreCache<SessionId, SessionDocStore>({
    create: createSessionStore,
    releaseDelayMs: STORE_RELEASE_DELAY_MS,
    // The cache is the doc's sole application-layer owner: hard release = stop
    // sync + Mirror.dispose (store.dispose) + repo.unloadDoc, serialized per key
    // by the cache so a concurrent acquire waits for the unload, then recreates.
    unload: (sessionId) => repo.unloadDoc(getSessionRoomId(sessionId)),
  });

  const createPreviewVisualCommentStore = async (
    sessionId: SessionId
  ): Promise<PreviewVisualCommentDocStore> => {
    const roomId = getPreviewCommentRoomId(sessionId);
    const persistedDoc = await repo.openPersistedDoc(roomId);

    const mirror = new Mirror({
      doc: persistedDoc.doc as LoroDoc,
      schema: previewVisualCommentDocSchema,
      // Tolerate root keys written by peers running a newer schema version.
      ignoreUnknownProperties: true,
      initialState: { meta: { sessionId }, turns: {} },
      debug: false,
    });

    const syncTracker = createTrackedRoomSyncTracker(roomId);
    let roomSub: Awaited<ReturnType<typeof persistedDoc.joinRoom>> | null = null;
    let cloudRepairUnsubscribe: (() => void) | null = null;
    let disposed = false;

    const firstSynced = transportReady.promise.then(async () => {
      try {
        await targetRouter.prepareSessionTarget(sessionId).catch(() => undefined);
        const joined = await waitForRoomToSync(() => persistedDoc.joinRoom(), {
          roomId,
          initialDelayMs: 0,
          isCancelled: () => disposed,
          firstSynced: (sub) => readinessBindingForDocRoom(sub, roomId).firstSyncedWithRemote,
          onSubscription: (joinedSub) => {
            roomSub = joinedSub;
            syncTracker.attach(readinessBindingForDocRoom(joinedSub, roomId));
            cloudRepairUnsubscribe?.();
            cloudRepairUnsubscribe = watchCloudBindingForRepair(joinedSub);
          },
        });
        if (!joined) {
          return;
        }
        if (disposed) {
          joined.unsubscribe();
          return;
        }
        roomSub = joined;
        syncTracker.markFirstSynced();
      } catch (error) {
        syncTracker.markFirstSyncFailed();
        throw error;
      }
    });
    void firstSynced.catch(() => {});

    return {
      sessionId,
      roomId,
      doc: persistedDoc.doc as LoroDoc,
      firstSynced,
      getSyncState: syncTracker.getSyncState,
      subscribeSyncState: syncTracker.subscribeSyncState,
      getState: () => mirror.getState(),
      setState: (updater) => {
        mirror.setState(updater as never);
      },
      subscribe: (listener) => mirror.subscribe(listener),
      dispose: () => {
        disposed = true;
        cloudRepairUnsubscribe?.();
        cloudRepairUnsubscribe = null;
        syncTracker.dispose();
        mirror.dispose();
        roomSub?.unsubscribe();
      },
      waitUntilSynced: async () => {
        await transportReady.promise;
        await firstSynced.catch(() => {});
        if (roomSub) {
          await waitUntilRoomSynced(roomSub, roomId);
        }
      },
    };
  };

  const previewVisualCommentStoreCache = createManagedStoreCache<
    SessionId,
    PreviewVisualCommentDocStore
  >({
    create: createPreviewVisualCommentStore,
    releaseDelayMs: STORE_RELEASE_DELAY_MS,
    // Same ownership contract as sessionStoreCache: the cache alone unloads the
    // doc from the repo on hard release, serialized per key.
    unload: (sessionId) => repo.unloadDoc(getPreviewCommentRoomId(sessionId)),
  });

  const createTaskStore = async (taskId: TaskId): Promise<TaskDocStore> => {
    const roomId = getTaskRoomId(taskId);
    const persistedDoc = await repo.openPersistedDoc(roomId);

    const mirror = new Mirror({
      doc: persistedDoc.doc as LoroDoc,
      schema: taskDocSchema,
      // Tolerate root keys written by peers running a newer schema version.
      ignoreUnknownProperties: true,
      initialState: {
        meta: {
          taskId,
          title: '',
          status: 'backlog',
          ownerId: '',
          order: TASK_ORDER_MIN_KEY,
          priority: undefined,
          labels: undefined,
          agent: undefined,
          projects: undefined,
          lastRunConfig: undefined,
          createdAt: 0,
          updatedAt: 0,
          createdBy: undefined,
        },
        body: '',
        links: [],
        timeline: [],
      },
      debug: false,
    });

    const syncTracker = createTrackedRoomSyncTracker(roomId);
    let roomSub: Awaited<ReturnType<typeof persistedDoc.joinRoom>> | null = null;
    let disposed = false;

    const firstSynced = transportReady.promise.then(async () => {
      try {
        // Tasks are workspace-scoped, so unlike session rooms there is no owning
        // machine to resolve first: the room routes to the cloud plane (and the
        // readiness binding below is therefore always the cloud one).
        const joined = await waitForRoomToSync(() => persistedDoc.joinRoom(), {
          roomId,
          initialDelayMs: 0,
          isCancelled: () => disposed,
          firstSynced: (sub) => readinessBindingForDocRoom(sub, roomId).firstSyncedWithRemote,
          onSubscription: (joinedSub) => {
            roomSub = joinedSub;
            syncTracker.attach(readinessBindingForDocRoom(joinedSub, roomId));
          },
        });
        if (!joined) {
          return;
        }
        if (disposed) {
          joined.unsubscribe();
          return;
        }
        roomSub = joined;
        syncTracker.markFirstSynced();
      } catch (error) {
        syncTracker.markFirstSyncFailed();
        throw error;
      }
    });
    void firstSynced.catch(() => {});

    return {
      taskId,
      roomId,
      doc: persistedDoc.doc as LoroDoc,
      firstSynced,
      getSyncState: syncTracker.getSyncState,
      subscribeSyncState: syncTracker.subscribeSyncState,
      getState: () => mirror.getState(),
      setState: (updater) => {
        mirror.setState(updater as never);
      },
      subscribe: (listener) => mirror.subscribe(listener),
      dispose: () => {
        disposed = true;
        syncTracker.dispose();
        mirror.dispose();
        roomSub?.unsubscribe();
      },
      waitUntilSynced: async () => {
        await transportReady.promise;
        await firstSynced.catch(() => {});
        if (roomSub) {
          await waitUntilRoomSynced(roomSub, roomId);
        }
      },
    };
  };

  const taskStoreCache = createManagedStoreCache<TaskId, TaskDocStore>({
    create: createTaskStore,
    releaseDelayMs: STORE_RELEASE_DELAY_MS,
    unload: (taskId) => repo.unloadDoc(getTaskRoomId(taskId)),
  });

  // Dual-author: every client direct-authors its own durable writes and uploads
  // them over its own cloud connection; local targets additionally converge with
  // the CLI over the local plane (specs/local-first-two-plane.md 作者规则).
  const workspaceWriter = createDirectWorkspaceWriter({
    repo,
    acquireSessionStore: sessionStoreCache.acquire,
    releaseSessionStoreRef: sessionStoreCache.releaseRef,
    acquirePreviewVisualCommentStore: previewVisualCommentStoreCache.acquire,
    releasePreviewVisualCommentStoreRef: previewVisualCommentStoreCache.releaseRef,
  });

  releaseIdleDocumentStoresBeforeReconnect = async () => {
    // Keep the warm-cache delay during normal navigation, but trim idle joined
    // rooms before reconnect. Rejected: letting repo.reconnect() revive every
    // recently viewed room, which creates a remote sync burst on mobile wake.
    await Promise.all([
      sessionStoreCache.releaseIdle(),
      previewVisualCommentStoreCache.releaseIdle(),
      taskStoreCache.releaseIdle(),
    ]);
  };

  // --- Background eager-sync coordinator ports -----------------------------
  // These adapters wire the pure BackgroundSyncCoordinator to runtime internals:
  // session metadata (activity), the session store cache (one-shot prefetch),
  // and browser online/visibility (env). The coordinator itself imports none of
  // these — see background-sync-coordinator.ts.
  const sessionIdFromRoomId = (roomId: string): SessionId =>
    roomId.slice(SESSION_DOC_PREFIX.length) as SessionId;

  const toSessionActivitySnapshot = (
    sessionId: SessionId,
    meta: Record<string, unknown>
  ): SessionActivitySnapshot => {
    const status =
      meta.status &&
      typeof meta.status === 'object' &&
      typeof (meta.status as { type?: unknown }).type === 'string'
        ? (meta.status as SessionStatus)
        : undefined;
    return {
      sessionId,
      lastMessageAt: typeof meta.lastMessageAt === 'number' ? meta.lastMessageAt : undefined,
      lastReadAt: typeof meta.lastReadAt === 'number' ? meta.lastReadAt : undefined,
      status,
      isArchived: meta.isArchived === true,
      isPinned: meta.isPinned === true,
      parentSessionId:
        typeof meta.parentSessionId === 'string' ? (meta.parentSessionId as SessionId) : undefined,
    };
  };

  const sessionIdSetsEqual = (
    left: ReadonlySet<SessionId> | null,
    right: ReadonlySet<SessionId> | null
  ): boolean => {
    if (left === right) {
      return true;
    }
    if (!left || !right) {
      return false;
    }
    if (left.size !== right.size) {
      return false;
    }
    for (const id of left) {
      if (!right.has(id)) {
        return false;
      }
    }
    return true;
  };

  const backgroundSyncSnapshots = new Map<SessionId, SessionActivitySnapshot>();
  let backgroundSyncActivityListener: ((snap: SessionActivitySnapshot) => void) | null = null;
  const backgroundSyncEnvListeners = new Set<() => void>();
  const backgroundSyncVisibilityListeners = new Set<() => void>();
  const eagerSyncVisibleSessionIdsBySource = new Map<string, Set<SessionId>>();
  let eagerSyncVisibleSessionIds: Set<SessionId> | null = null;
  const notifyBackgroundSyncEnvChange = () => {
    for (const listener of Array.from(backgroundSyncEnvListeners)) {
      listener();
    }
  };
  const notifyBackgroundSyncVisibilityChange = () => {
    for (const listener of Array.from(backgroundSyncVisibilityListeners)) {
      listener();
    }
  };
  const setEagerSyncVisibleSessionIds = (
    sourceId: string,
    sessionIds: readonly SessionId[] | null
  ) => {
    const normalizedSourceId = sourceId.trim();
    if (!normalizedSourceId) {
      return;
    }
    const previous = eagerSyncVisibleSessionIds;
    if (sessionIds) {
      eagerSyncVisibleSessionIdsBySource.set(normalizedSourceId, new Set(sessionIds));
    } else {
      eagerSyncVisibleSessionIdsBySource.delete(normalizedSourceId);
    }
    if (eagerSyncVisibleSessionIdsBySource.size === 0) {
      eagerSyncVisibleSessionIds = null;
    } else {
      const merged = new Set<SessionId>();
      for (const ids of eagerSyncVisibleSessionIdsBySource.values()) {
        for (const id of ids) {
          merged.add(id);
        }
      }
      eagerSyncVisibleSessionIds = merged;
    }
    if (!sessionIdSetsEqual(previous, eagerSyncVisibleSessionIds)) {
      notifyBackgroundSyncVisibilityChange();
    }
  };
  const isEagerSyncSessionVisible = (sessionId: SessionId): boolean =>
    eagerSyncVisibleSessionIds?.has(sessionId) ?? false;

  const seedBackgroundSyncSnapshots = async (): Promise<void> => {
    const entries = await listDocMetaEntries(repo);
    for (const entry of entries) {
      if (!isSessionDocRoomId(entry.docId) || isLoroRepoDocDeleted(entry)) {
        continue;
      }
      const sessionId = sessionIdFromRoomId(entry.docId);
      backgroundSyncSnapshots.set(
        sessionId,
        toSessionActivitySnapshot(sessionId, entry.meta as Record<string, unknown>)
      );
    }
  };

  const beginBackgroundSyncCoordinator = () => {
    if (backgroundSyncCoordinator || backgroundSyncCoordinatorStartPromise || disposePromise) {
      return;
    }

    const watchHandle = repo.watch(
      (event) => {
        if (event.kind !== 'doc-metadata' || !isSessionDocRoomId(event.docId)) {
          return;
        }
        const sessionId = sessionIdFromRoomId(event.docId);
        void repo.getDocMeta(event.docId).then((entry) => {
          if (!entry || isLoroRepoDocDeleted(entry)) {
            backgroundSyncSnapshots.delete(sessionId);
            return;
          }
          const snapshot = toSessionActivitySnapshot(
            sessionId,
            entry.meta as Record<string, unknown>
          );
          backgroundSyncSnapshots.set(sessionId, snapshot);
          backgroundSyncActivityListener?.(snapshot);
        });
      },
      { kinds: ['doc-metadata'] }
    );
    watchHandles.push(watchHandle);

    backgroundSyncCoordinatorStartPromise = (async () => {
      const highWaterStore = await createEagerSyncHighWaterStore(workspaceId);
      if (disposePromise) {
        highWaterStore.close();
        return;
      }
      backgroundSyncHighWaterStore = highWaterStore;

      backgroundSyncCoordinator = createBackgroundSyncCoordinator({
        activitySource: {
          list: () => Array.from(backgroundSyncSnapshots.values()),
          subscribe: (onChange) => {
            backgroundSyncActivityListener = onChange;
            return () => {
              if (backgroundSyncActivityListener === onChange) {
                backgroundSyncActivityListener = null;
              }
            };
          },
        },
        registry: roomSyncRegistry,
        prefetcher: {
          prefetch: async (sessionId, signal) => {
            if (signal.aborted) {
              return 'skipped';
            }
            let store: SessionDocStore;
            try {
              store = await sessionStoreCache.acquire(sessionId);
            } catch {
              return 'failed';
            }
            // Hold our own sync lease across the wait so the store reports the live
            // tracker state (not 'idle') when we inspect the outcome below.
            const releaseSync = store.acquireSync();
            try {
              const synced = store
                // Pass the abort signal so offline/hidden/timeout cancellation
                // actually releases the inner sync lease and lets the room join/SSE
                // tear down, instead of leaving it alive until it settles on its own.
                .waitUntilSynced(signal)
                // waitUntilSynced() resolves even when the room join failed (no
                // subscription → it awaits `undefined`). Only treat it as a real
                // catch-up if the room actually reached 'synced'; otherwise it is a
                // failure and must NOT advance the coordinator's synced high-water
                // mark (which would suppress retries).
                .then((): 'synced' | 'failed' =>
                  store.getSyncState() === 'synced' ? 'synced' : 'failed'
                )
                .catch((): 'failed' => 'failed');
              const aborted = new Promise<'skipped'>((resolve) => {
                if (signal.aborted) {
                  resolve('skipped');
                  return;
                }
                signal.addEventListener('abort', () => resolve('skipped'), { once: true });
              });
              return await Promise.race([synced, aborted]);
            } finally {
              releaseSync();
              sessionStoreCache.releaseRef(sessionId);
            }
          },
          evict: (sessionId) => {
            void sessionStoreCache.releaseIfIdle(sessionId);
          },
        },
        env: {
          isOnline: () => isBrowserOnline(),
          isAppVisible: () =>
            typeof document === 'undefined' || document.visibilityState === 'visible',
          subscribe: (onChange) => {
            backgroundSyncEnvListeners.add(onChange);
            return () => {
              backgroundSyncEnvListeners.delete(onChange);
            };
          },
        },
        visibility: {
          isVisible: isEagerSyncSessionVisible,
          subscribe: (onChange) => {
            backgroundSyncVisibilityListeners.add(onChange);
            return () => {
              backgroundSyncVisibilityListeners.delete(onChange);
            };
          },
        },
        clock: { now: () => Date.now() },
        scheduler: {
          setTimeout: (handler, ms) => setTimeout(handler, ms),
          clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
        },
        policy: resolveEagerSyncPolicy(deps.eagerSyncSurface ?? 'web'),
        highWaterStore,
      });

      const coordinator = backgroundSyncCoordinator;
      await seedBackgroundSyncSnapshots().catch(() => {});
      if (disposePromise || backgroundSyncCoordinator !== coordinator) {
        highWaterStore.close();
        if (backgroundSyncHighWaterStore === highWaterStore) {
          backgroundSyncHighWaterStore = null;
        }
        return;
      }
      coordinator.start();
    })()
      .catch((error) => {
        console.warn('createWorkspaceRuntime: failed to start background eager-sync', {
          workspaceId,
          error,
        });
        backgroundSyncCoordinator?.stop();
        backgroundSyncCoordinator = null;
        backgroundSyncHighWaterStore?.close();
        backgroundSyncHighWaterStore = null;
      })
      .finally(() => {
        backgroundSyncCoordinatorStartPromise = null;
      });
  };

  startBackgroundSyncCoordinator = () => {
    if (
      backgroundSyncCoordinator ||
      backgroundSyncCoordinatorStartPromise ||
      cancelDelayedBackgroundSyncStart ||
      disposePromise
    ) {
      return;
    }

    cancelDelayedBackgroundSyncStart = scheduleAfterStartupNavigationCooldown(() => {
      cancelDelayedBackgroundSyncStart = null;
      if (disposePromise) {
        return;
      }
      console.info(
        'createWorkspaceRuntime: startup navigation cooldown elapsed; starting background eager-sync',
        {
          workspaceId,
        }
      );
      beginBackgroundSyncCoordinator();
    });
  };

  const dispose = async () => {
    if (disposePromise) {
      return disposePromise;
    }

    disposePromise = (async () => {
      cancelDelayedBackgroundSyncStart?.();
      cancelDelayedBackgroundSyncStart = null;
      cancelDelayedStartupAcpCapabilitiesRefresh?.();
      cancelDelayedStartupAcpCapabilitiesRefresh = null;
      startupAcpCapabilitiesRefreshAbortController?.abort();
      startupAcpCapabilitiesRefreshAbortController = null;
      backgroundSyncCoordinator?.stop();
      backgroundSyncCoordinator = null;
      backgroundSyncHighWaterStore?.close();
      backgroundSyncHighWaterStore = null;
      localReconnectLoop?.stop();
      cloudReconnectLoop?.stop();
      if (reconnectBackstopTimer) {
        clearInterval(reconnectBackstopTimer);
        reconnectBackstopTimer = null;
      }
      untrackPresenceSync();
      unsubscribeStartupAcpCapabilitiesPresence();
      unsubscribePresenceSyncState?.();
      untrackMachineMonitorSync();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      transportReady.reject(new Error('Runtime disposed'));

      for (const pending of pendingSessionCreateResponses.values()) {
        clearTimeout(pending.timeoutId);
        pending.resolve(null);
      }
      pendingSessionCreateResponses.clear();
      sessionCreateResponseCache.clear();

      for (const pending of pendingSessionCancelResponses.values()) {
        clearTimeout(pending.timeoutId);
        pending.resolve(null);
      }
      pendingSessionCancelResponses.clear();

      for (const pending of pendingSessionChatResponses.values()) {
        clearTimeout(pending.timeoutId);
        pending.resolve(null);
      }
      pendingSessionChatResponses.clear();

      for (const pending of pendingMachineStatusResponses.values()) {
        clearTimeout(pending.timeoutId);
        pending.resolve(null);
      }
      pendingMachineStatusResponses.clear();

      for (const pending of pendingMachinePingResponses.values()) {
        clearTimeout(pending.timeoutId);
        pending.resolve(null);
      }
      pendingMachinePingResponses.clear();

      machineAcpBinaryStatusRegistry.clearAll();
      machineAcpBinaryInstallRegistry.clearAll();
      machineAcpAuthenticateRegistry.clearAll();
      machineAcpBinaryProgressListeners.clear();
      machineAcpBinaryProgressSnapshots.clear();
      machineAcpAuthenticationProgressListeners.clear();

      for (const handle of watchHandles) {
        try {
          handle.unsubscribe();
        } catch {
          // ignore
        }
      }
      watchHandles.length = 0;

      await sessionStoreCache.disposeAll();
      await previewVisualCommentStoreCache.disposeAll();
      await taskStoreCache.disposeAll();
      let codeCollabFileIndexCacheDisposeError: unknown = null;
      try {
        await codeCollabFileIndexCache.dispose();
      } catch (error) {
        codeCollabFileIndexCacheDisposeError = error;
      }

      let teardownTransportError: unknown = null;
      try {
        await teardownTransport();
      } catch (error) {
        if (!isDestroyedError(error)) {
          teardownTransportError = error;
        }
      }

      let destroyError: unknown = null;
      try {
        await repo.destroy();
      } catch (error) {
        if (!isDestroyedError(error)) {
          destroyError = error;
        }
      }

      if (destroyError) {
        throw destroyError;
      }
      if (teardownTransportError) {
        throw teardownTransportError;
      }
      if (codeCollabFileIndexCacheDisposeError) {
        throw codeCollabFileIndexCacheDisposeError;
      }
    })();

    return disposePromise;
  };

  // When the page becomes visible again (e.g. after mobile sleep/wake, tab switch),
  // trigger transport reconnect to recover rooms that may have entered "disconnected"
  // state due to retry exhaustion while JS was suspended.
  // The adapter-level status may still be "connected" even when individual room sessions
  // are disconnected, so we call reconnect() unconditionally. loro-repo handles rooms
  // that were previously live as well as rooms whose initial Streams join did not complete.
  const triggerReconnect = (reason: LocalReconnectTriggerReason) => {
    if (transportAttached && !disposePromise) {
      console.info('createWorkspaceRuntime: external reconnect trigger', {
        workspaceId,
        reason,
        metaSyncState: metaSyncState(),
        initialMetaSyncCompleted,
        initialMetaSyncFailed,
      });
      if (!electronLocalDataPlane || reason === 'visibility-wake') {
        localReconnectLoop?.trigger(reason);
      }
      if (electronLocalDataPlane && authToken) {
        cloudReconnectLoop?.trigger(reason);
      }
    }
  };
  const handleVisibilityChange = () => {
    notifyBackgroundSyncEnvChange();
    if (document.visibilityState === 'visible') {
      triggerReconnect('visibility-wake');
    }
  };
  // When the browser regains network connectivity, trigger reconnect immediately
  // so disconnected rooms recover without waiting for a visibility change.
  const handleOnline = () => {
    notifyBackgroundSyncEnvChange();
    triggerReconnect('network-online');
  };
  const handleOffline = () => {
    console.info('createWorkspaceRuntime: browser offline; stopping reconnect loop', {
      workspaceId,
      metaSyncState: metaSyncState(),
      initialMetaSyncCompleted,
      initialMetaSyncFailed,
    });
    notifyBackgroundSyncEnvChange();
    if (electronLocalDataPlane) {
      cloudReconnectLoop?.stop();
    } else {
      localReconnectLoop?.stop();
    }
    emitControlConnectionState();
  };
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  // Level-triggered backstop: even if every event edge above is missed (a
  // status change that landed while the tab was frozen, a lost timer), the
  // reconnect loop re-evaluates registry health on a slow interval. update()
  // is a cheap no-op when nothing needs reconnecting and does NOT reset the
  // retry backoff.
  reconnectBackstopTimer = setInterval(() => {
    localReconnectLoop?.update();
    cloudReconnectLoop?.update();
  }, RECONNECT_BACKSTOP_INTERVAL_MS);

  window.repo = repo;
  const codeCollabFileIndexCache = createCodeCollabFileIndexCache(repo);
  return {
    workspaceSlug: deps.workspaceSlug,
    workspaceId,
    repo,
    codeCollabFileIndexCache,
    writer: workspaceWriter,
    prepareSessionTarget: (sessionId, machineId) =>
      targetRouter.prepareSessionTarget(sessionId, machineId),
    resolveMachineTargetPlane: (machineId, options) =>
      targetRouter.resolvePlaneForMachine(machineId, {
        timeoutMs: options?.timeoutMs ?? LOCAL_MACHINE_ID_READY_TIMEOUT_MS,
      }),
    setLocalMachineId,
    setEagerSyncVisibleSessionIds,
    setAuthToken,
    subscribeMachineMonitor: (machineId, listener) =>
      targetMachineMonitor.subscribeMachine(machineId, listener),
    forceMachineMonitorSample: (machineId) => targetMachineMonitor.forceSample(machineId),
    publishSessionViewing: (args: { sessionId: SessionId; userId: string } | null) =>
      presenceTransport.publishSessionViewing(args),
    ensureDocStream,
    // Every store access must be ref-counted so eviction cannot dispose+unload
    // a doc mid-use. releaseRef only starts the warm-release timer, so this
    // wrapper is cheap for short-lived reads.
    withSessionStore: async <T>(
      sessionId: SessionId,
      fn: (store: SessionDocStore) => Promise<T> | T
    ): Promise<T> => {
      const store = await sessionStoreCache.acquire(sessionId);
      try {
        return await fn(store);
      } finally {
        sessionStoreCache.releaseRef(sessionId);
      }
    },
    releaseSessionStore: sessionStoreCache.release,
    acquireSessionStore: sessionStoreCache.acquire,
    releaseSessionStoreRef: sessionStoreCache.releaseRef,
    withPreviewVisualCommentStore: async <T>(
      sessionId: SessionId,
      fn: (store: PreviewVisualCommentDocStore) => Promise<T> | T
    ): Promise<T> => {
      const store = await previewVisualCommentStoreCache.acquire(sessionId);
      try {
        return await fn(store);
      } finally {
        previewVisualCommentStoreCache.releaseRef(sessionId);
      }
    },
    releasePreviewVisualCommentStore: previewVisualCommentStoreCache.release,
    acquirePreviewVisualCommentStore: previewVisualCommentStoreCache.acquire,
    releasePreviewVisualCommentStoreRef: previewVisualCommentStoreCache.releaseRef,
    withTaskStore: async <T>(
      taskId: TaskId,
      fn: (store: TaskDocStore) => Promise<T> | T
    ): Promise<T> => {
      const store = await taskStoreCache.acquire(taskId);
      try {
        return await fn(store);
      } finally {
        taskStoreCache.releaseRef(taskId);
      }
    },
    releaseTaskStore: taskStoreCache.release,
    acquireTaskStore: taskStoreCache.acquire,
    releaseTaskStoreRef: taskStoreCache.releaseRef,
    sendControl,
    waitForSessionCreateResponse,
    waitForSessionCancelResponse,
    waitForSessionChatResponse,
    waitForMachineStatusResponse,
    waitForMachinePingResponse,
    waitForMachineRestartResponse,
    waitForMachineUpgradeResponse,
    requestMachineAcpCapabilitiesRefresh,
    waitForMachineAcpAuthenticateResponse,
    subscribeMachineAcpAuthenticationProgress,
    waitForMachineAcpBinaryStatusResponse,
    waitForMachineAcpBinaryInstallResponse,
    subscribeMachineAcpBinaryProgress,
    getMachineAcpBinaryProgress,
    requestSessionCancel,
    requestSessionSteer,
    requestSessionTerminate,
    requestSessionFork,
    requestSessionEditAndResend,
    requestSessionDispatchTurn,
    requestSessionPrepare,
    requestSessionPrepareCancel,
    requestFilePreview,
    requestLocalCodeCollabFileIndex,
    requestCodeCollabOpenText,
    requestCodeCollabRefreshText,
    requestCodeCollabSaveText,
    requestCodeCollabOpenCurrentDiff,
    requestCodeCollabOpenAllChangesDiff,
    requestCodeCollabOpenTurnDiff,
    requestCodeCollabInitDirectory,
    requestCodeCollabLspDefinition,
    requestCodeCollabLspReferences,
    requestSessionPreviewCreate,
    requestSessionPreviewEndpointAcquire,
    requestSessionPreviewEndpointRelease,
    requestSessionPreviewRevoke,
    requestLocalProjectGitState,
    requestLocalProjectControl,
    requestMachineBugReport,
    dispose,
  };
}
