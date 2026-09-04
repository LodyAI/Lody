import { Mirror } from 'loro-mirror';
import type { LoroList, LoroMap } from 'loro-crdt';
import {
  ACPSessionId,
  AgentConfigCliType,
  AgentType,
  CliType,
  collectOnlineMachineIdsFromPresence,
  sessionDocSchema,
  SessionStatusFactory,
  SessionId,
  WorkspaceId,
  getSessionRoomId,
  getSessionIdFromRoomId,
  AgentConfigId,
  MachineId,
  ManagedBuiltinAgentType,
  SessionHistoryInput,
  isCodeCollabFileIndexFlockDocId,
  isCodeCollabFileIndexSignalFlockDocId,
  CODE_COLLAB_FILE_INDEX_FLOCK_TTL_MS,
  SessionMeta,
  SessionDocMeta,
  type SessionPreviewDocState,
  AgentConfigMeta,
  MachineMeta,
  getMachineRoomId,
  SessionStatus,
  SessionContextWindowUsage,
  type ProjectRef,
  SessionPullRequestMeta,
  SessionPlanEntry,
  type SessionExternalHistoryCursorDocState,
  ACP_CAPABILITY_CACHE_VERSION,
  SessionHistory,
  MessageQueueItem,
  FileDiff,
  SessionTitleSource,
  getAcpCapabilityCacheKey,
  getLegacyReadForSessionHistoryStatus,
  normalizeSessionPullRequestMeta,
  normalizeSessionTurnInputConfig,
  getServerNow,
  isLoroRepoDocDeleted,
  getMachineFlockAcpCapabilities,
  getMachineFlockProviderSetupCancellations,
  getMachineFlockProviderSetups,
  getMachineFlockDocId,
  machineFlockKeys,
  readMachineFlockRowsFromFlock,
  resolveSessionHistoryStatus,
  writeMachineFlockRowToFlock,
  type AcpConfigOptionSummary,
  type AcpCommandSummary,
  type AcpCapabilityCacheEntry,
  type SessionForkOperation,
  SessionForkOperationSchema,
  type LodyPresenceStateMap,
  type SessionAcpRuntimeConfigPatch,
  type SessionAcpRuntimeConfigSnapshot,
  isSensitiveAcpConfigOptionId,
  BuiltinRuntimeOverridesSchema,
  CustomAcpLaunchSpecSchema,
} from '@lody/shared';
import { LocalLoroDataPlaneServer } from '@lody/shared/local-loro-data-plane-server';
import { createLocalLoroDataPlaneScheduler } from '@lody/shared/local-loro-data-plane-scheduler';
import { v4 as uuidv4 } from 'uuid';
import { getLogger, type Logger } from '@/utils/logger';
import { captureException, captureMessage } from '@/instrument';
import { withSlowOperationWarning } from '@/utils/slow-operation-warning';
import { traceAsync } from '@/utils/trace-span';

import WebSocketOriginal from 'ws';
import {
  LoroRepo,
  RepoDocHandle,
  RepoWatchHandle,
  type TransportConnectionStatus,
  type RepoRoomSubscription,
  type RepoTransportRoomStatus,
} from 'loro-repo';
import { CliPresenceRuntime } from './presence';
import { CliMachineMonitorRuntime } from './machine-monitor';
import {
  attachAutoMarkLatestUserHistoryAsRead,
  type AutoMarkLatestUserHistoryAsReadHandle,
} from './history-auto-read';

import {
  LoroConnectionRecoveryController,
  type MetaRoomSyncedListener,
  type StreamsOnlineListener,
} from './connection-recovery';
import { MachineFlockSyncCoordinator } from './machine-flock-sync-coordinator';
import type { ModelInfo } from '@lody/shared';
import { redactProxyUrl, sanitizeUrlForLogging } from '@/utils/log-sanitize';
import { getProxyForUrl } from 'proxy-from-env';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { RateLimit } from 'acp-extension-core';
import { createCliSqliteRepoStore } from './sqlite-repo-store';
import { streamsRoomBinding, type StreamsRoomBinding } from './streams-room-binding';
import { formatErrorMessage } from '@/utils/format-error';
import {
  listMergedAgentConfigs,
  readMachineBuiltinAgentOptOuts,
  readMergedAgentConfigById,
  upsertMachineAgentConfig,
} from '@/lib/agent-config-machine-flock';
import { installCliHttpGlobalDispatcher } from '@/utils/http-transport';
import { createCliStreamsTransport } from './streams-transport';

const normalizeSessionHistoryEntry = (entry: SessionHistoryInput): SessionHistoryInput => ({
  ...entry,
  inputConfig: normalizeSessionTurnInputConfig(entry.inputConfig),
});

const isValidDaemonLaunchConfig = (
  config: AgentConfigMeta,
  expectedConfigId: AgentConfigId,
  expectedMachineId: MachineId
): boolean => {
  if (
    config.id !== expectedConfigId ||
    config.machineId !== expectedMachineId ||
    typeof config.agentType !== 'string' ||
    config.agentType.trim().length === 0 ||
    typeof config.env !== 'object' ||
    config.env === null ||
    Array.isArray(config.env) ||
    Object.values(config.env).some((value) => typeof value !== 'string')
  ) {
    return false;
  }

  if (config.cliType === 'custom') {
    return (
      CustomAcpLaunchSpecSchema.safeParse(config.customAcp).success &&
      config.runtimeOverrides === undefined
    );
  }
  if (config.cliType === 'registry') {
    return config.customAcp === undefined && config.runtimeOverrides === undefined;
  }
  if (config.cliType === 'builtin') {
    return (
      config.customAcp === undefined &&
      (config.runtimeOverrides === undefined ||
        BuiltinRuntimeOverridesSchema.safeParse(config.runtimeOverrides).success)
    );
  }
  return false;
};

type GlobalWithOptionalBun = typeof globalThis & { Bun?: unknown };
type GlobalWithWebSocket = { WebSocket: typeof ProxiedWebSocket };
type LoroMapSetValue = Parameters<LoroMap['set']>[1];

const localLoroDataPlaneScheduler = createLocalLoroDataPlaneScheduler((work) => {
  const handle = setImmediate(work);
  return () => clearImmediate(handle);
});

const createLocalLoroDataPlaneServer = (
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  presenceRuntime: CliPresenceRuntime,
  machineMonitorRuntime: CliMachineMonitorRuntime
): LocalLoroDataPlaneServer =>
  new LocalLoroDataPlaneServer({
    workspaceId,
    resolveDoc: async (docId) => (await repo.openPersistedDoc(docId)).doc,
    resolveFlockDoc: async (flockDocId) => (await repo.openFlockDoc(flockDocId)).flock,
    // The meta room is the repo's internal metaFlock (`repo.getMeta()`).
    // Renderer `upsertDocMeta` writes must land here so the CLI's doc-metadata
    // live monitor + dispatch watcher fire (a detached `openFlockDoc('meta')`
    // would silently swallow every dispatch).
    resolveMetaFlock: async () => repo.getMeta(),
    // Relay only the presence this CLI itself authors, so local-first renderers
    // retain an offline source; online renderers merge it with their independent
    // cloud snapshot, which is what carries every remote origin.
    presenceSource: {
      encodeLocalOrigin: () => presenceRuntime.encodeLocalOriginPresence(),
      subscribeLocalOrigin: (listener) => presenceRuntime.subscribeLocalOriginPresence(listener),
    },
    machineMonitorSource: {
      apply: (update) => machineMonitorRuntime.applyLocalState(update),
      encodeAll: () => machineMonitorRuntime.encodeLocalState(),
      subscribe: (listener) => machineMonitorRuntime.subscribeLocalState(listener),
    },
    // All workspace engines share one fair scheduler: bulk work runs after the
    // poll phase, one quantum at a time.
    scheduler: localLoroDataPlaneScheduler,
  });

/**
 * Install process-wide diagnostic interceptors for streams-crdt and Loro Streams
 * HTTP calls. Guarded to run at most once per process so that fleet-mode
 * (multiple workspaces) doesn't stack duplicate wrapper layers.
 */
let streamsDiagnosticsInstalled = false;
let streamsDiagLogger: Logger | null = null;

function installStreamsDiagnostics(logger: Logger): void {
  // Always update the logger so the most-recently-created workspace's logger
  // is used for diagnostic output.
  streamsDiagLogger = logger;

  if (streamsDiagnosticsInstalled) return;
  streamsDiagnosticsInstalled = true;

  // Intercept console.error to capture [streams-crdt] / [loro-repo] internal
  // error messages that would otherwise be lost (not routed to the app logger).
  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[streams-crdt]')) {
      const detail = args.length > 1 ? ` ${JSON.stringify(args[1])}` : '';
      streamsDiagLogger?.debug(`[loro-streams-diag] ${args[0]}${detail}`);
      return;
    }
    if (typeof args[0] === 'string' && args[0].startsWith('[loro-repo]')) {
      const detail = args.length > 1 ? ` ${args[1]}` : '';
      streamsDiagLogger?.debug(`[loro-streams-diag] ${args[0]}${detail}`);
      return;
    }
    origConsoleError.apply(console, args);
  };

  // Instrument fetch to log Loro Streams 404 responses for root cause diagnosis.
  // This helps identify which HTTP operation (bootstrap, create, append, catchup)
  // is returning stream_not_found.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const response = await origFetch(input, init);
    if (response.status === 404) {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (url.includes('/ds/')) {
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        streamsDiagLogger?.debug(
          `[loro-streams-diag] HTTP 404 from Streams API: ${method} ${sanitizeUrlForLogging(url)}`
        );
      }
    }
    return response;
  };
}

class ProxiedWebSocket extends WebSocketOriginal {
  constructor(url: string | URL, protocols?: string | string[]) {
    const urlString = typeof url === 'string' ? url : url.toString();

    const targetForProxyEnv = urlString.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');

    const proxyUrl = getProxyForUrl(targetForProxyEnv);
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

    const logger = getLogger('loro:websocket');
    logger.debug(
      `Creating WebSocket url=${sanitizeUrlForLogging(urlString)} proxy=${proxyUrl ? redactProxyUrl(proxyUrl) : 'none'} agentValid=${!!agent}`
    );

    if ((globalThis as GlobalWithOptionalBun).Bun && proxyUrl) {
      logger.debug(
        'Bun does not support WebSocket proxy yet: https://github.com/oven-sh/bun/issues/14522'
      );
    }

    super(urlString, protocols as ConstructorParameters<typeof WebSocketOriginal>[1], {
      agent,
      handshakeTimeout: 15000,
      perMessageDeflate: false,
    });
  }
}

(globalThis as unknown as GlobalWithWebSocket).WebSocket = ProxiedWebSocket;

import { PersistCoalescer } from './persist-coalescer';
import { readTimeoutEnv, withTimeout } from './timeout-utils';
import { ConcurrentQueue } from '../concurrent-queue';
import type { CliSqliteRepoStore } from './sqlite-repo-store';
import type { CloudBillingPort, CloudStreamsTokenPort } from '@lody/platform';

type AcpModeSummary = {
  id: string;
  name: string;
  description?: string;
};

type AcpModelSummary = {
  modelId: string;
  name?: string;
  description?: string;
};

export interface LoroDocumentManagerOptions {
  repo: LoroRepo;
  workspaceId: WorkspaceId;
  userId: string;
  metaSub: RepoRoomSubscription | null;
  logger: Logger;
  initialTransportStatus?: TransportConnectionStatus;
  initialMetaSyncPromise?: Promise<boolean>;
  initialMetaSyncCompleted?: boolean;
  presenceRuntime?: CliPresenceRuntime | null;
  machineMonitorRuntime?: CliMachineMonitorRuntime | null;
  localLoroDataPlaneServer?: LocalLoroDataPlaneServer | null;
  sqliteRepoStore?: CliSqliteRepoStore | null;
  remoteStreamsAttached?: boolean;
  streamsTokens?: CloudStreamsTokenPort | null;
  cloudBilling?: CloudBillingPort | null;
}

export type LoroRepoPersistReason =
  | 'remote-doc-sync'
  | 'remote-meta-sync'
  | 'remote-flock-sync'
  | 'session-local-base-ref'
  /** One flush standing in for several remote sync events; see `scheduleRemoteSyncPersist`. */
  | 'remote-sync-coalesced'
  | 'session-fork-prepare'
  | 'session-fork-commit'
  | 'session-fork-rollback'
  | 'session-edit-and-resend-commit'
  | 'session-edit-and-resend-rollback';

export class LoroDocumentManager {
  public readonly repo: LoroRepo;
  sessions: Map<SessionId, SessionDocument> = new Map();
  machine: MachineDocument | null = null;
  private readonly workspaceId: WorkspaceId;
  private readonly userId: string;
  private readonly logger: Logger;
  private readonly localLoroDataPlaneServer: LocalLoroDataPlaneServer | null;
  private readonly sqliteRepoStore: CliSqliteRepoStore | null;
  private remoteStreamsAttached: boolean;
  private remoteStreamsGeneration: number;
  private machineExistenceWatcher: RepoWatchHandle | null = null;
  private readonly connectionRecovery: LoroConnectionRecoveryController;
  private readonly machineFlockSync: MachineFlockSyncCoordinator;
  /** In-flight `syncFlockDocOrThrow` attempts, keyed by Flock document id. */
  private readonly activeFlockDocSyncs = new Map<string, Promise<unknown>>();
  private detachMachineFlockMetaRoomSyncedListener: (() => void) | null = null;
  private initialMetaSyncCompleted = false;
  private readonly initialMetaSyncPromise: Promise<boolean>;
  private presenceRuntime: CliPresenceRuntime | null;
  private machineMonitorRuntime: CliMachineMonitorRuntime | null;
  private remoteStreamsStatusUnsubscribe: (() => void) | null = null;
  private remoteTransportOpQueue: Promise<unknown> = Promise.resolve();
  private readonly streamsTokens: CloudStreamsTokenPort | null;
  public readonly cloudBilling: CloudBillingPort | null;

  static async create(
    workspaceId: WorkspaceId,
    userId: string,
    logger: Logger,
    options: {
      attachRemoteOnCreate?: boolean;
      streamsTokens?: CloudStreamsTokenPort | null;
      cloudBilling?: CloudBillingPort | null;
    } = {}
  ): Promise<LoroDocumentManager> {
    // Configure the CLI's global HTTP dispatcher once (proxy/H2/diagnostics). This
    // must run regardless of whether Streams attaches, since all CLI HTTP —
    // message-handler fetches, R2 uploads, and the deferred Streams token/attach
    // path — flows through it. Local-first create otherwise stays offline-capable:
    // the Streams token is fetched only when the remote bridge attaches later
    // (attachRemoteStreamsTransport), not eagerly here.
    installCliHttpGlobalDispatcher({ logger });
    const cliSqliteRepoStore = await traceAsync(
      logger,
      'startup.loro_sqlite_store',
      { workspaceId },
      async () => await createCliSqliteRepoStore(workspaceId)
    );
    const createRepoTimeoutMs = readTimeoutEnv('LODY_LORO_CREATE_REPO_TIMEOUT_MS', 30_000);
    const joinMetaTimeoutMs = readTimeoutEnv('LODY_LORO_JOIN_META_TIMEOUT_MS', 30_000);
    const getFlockDocRetentionMs = (flockDocId: string): number | undefined =>
      isCodeCollabFileIndexFlockDocId(flockDocId) ||
      isCodeCollabFileIndexSignalFlockDocId(flockDocId)
        ? CODE_COLLAB_FILE_INDEX_FLOCK_TTL_MS
        : undefined;
    logger.debug(
      `[${workspaceId}] Initializing local-first Loro repo: storageDb=${cliSqliteRepoStore.dbPath}`
    );

    let repo: LoroRepo | null = null;
    let manager: LoroDocumentManager | null = null;
    try {
      const createRepoStartMs = Date.now();
      repo = await traceAsync(
        logger,
        'startup.loro_repo_create',
        { workspaceId },
        async () =>
          await withTimeout(
            LoroRepo.create({
              storageAdapter: cliSqliteRepoStore.storageAdapter,
              metaDebounceCommitMs: 0,
              flockDocRetentionMs: getFlockDocRetentionMs,
            }),
            createRepoTimeoutMs,
            `Timeout waiting for LoroRepo.create (workspace=${workspaceId})`
          )
      );
      const createdRepo = repo;
      logger.debug(`[${workspaceId}] LoroRepo created in ${Date.now() - createRepoStartMs}ms`);
      // Presence is produced locally regardless of remote sync so local-first
      // renderers get machine/session liveness over the data plane; the cloud
      // Streams sink is attached later by the remote bridge.
      const presenceRuntime = new CliPresenceRuntime({ workspaceId, logger });
      const machineMonitorRuntime = new CliMachineMonitorRuntime({ workspaceId, logger });
      // No transport is registered at startup: rooms stay pending/detached
      // while offline, and renderer↔CLI document sync is served out-of-band by
      // the data-plane server engine. The cloud Streams transport is added
      // later by `attachRemoteStreamsTransport`.
      const localLoroDataPlaneServer = createLocalLoroDataPlaneServer(
        createdRepo,
        workspaceId,
        presenceRuntime,
        machineMonitorRuntime
      );
      const metaSub = await traceAsync(
        logger,
        'startup.loro_meta_join',
        { workspaceId },
        async () =>
          await withTimeout(
            createdRepo.joinMetaRoom(),
            joinMetaTimeoutMs,
            `Timeout waiting for repo.joinMetaRoom (workspace=${workspaceId})`
          )
      );
      manager = new LoroDocumentManager({
        repo: createdRepo,
        workspaceId,
        userId,
        metaSub,
        logger,
        // Local-only is a healthy state: with no transport registered, nothing
        // needs recovering. The Streams adapter's own status drives this once
        // the remote transport attaches.
        initialTransportStatus: 'connected',
        initialMetaSyncPromise: Promise.resolve(false),
        initialMetaSyncCompleted: false,
        presenceRuntime,
        machineMonitorRuntime,
        localLoroDataPlaneServer,
        sqliteRepoStore: cliSqliteRepoStore,
        remoteStreamsAttached: false,
        streamsTokens: options.streamsTokens ?? null,
        cloudBilling: options.cloudBilling ?? null,
      });
    } catch (error) {
      try {
        if (repo) {
          await repo.destroy();
        } else {
          cliSqliteRepoStore.sqliteStore.close();
        }
      } catch (closeError) {
        logger.debug(
          `[${workspaceId}] Failed to close SQLite repo store after init failure: ${formatErrorMessage(
            closeError
          )}`
        );
      }
      throw error;
    }

    if (options.attachRemoteOnCreate === true) {
      // One-shot command path: the caller needs durable cloud sync, so attach
      // failures must surface instead of silently staying local-only. The
      // long-lived daemon path attaches later via the remote bridge.
      try {
        await manager.attachRemoteStreamsTransport();
        const syncMetaTimeoutMs = readTimeoutEnv('LODY_LORO_SYNC_META_TIMEOUT_MS', 20_000);
        const synced = await manager.waitUntilMetaSynced({
          timeoutMs: syncMetaTimeoutMs,
          reason: 'create:attach-remote',
        });
        if (!synced) {
          logger.debug(
            `[${workspaceId}] Initial remote meta sync incomplete; continuing in degraded mode`
          );
        }
      } catch (error) {
        await manager
          .cleanUp({ fast: true, preserveSessionStatus: true })
          .catch((cleanupError: unknown) => {
            logger.debug(
              `[${workspaceId}] Failed to clean up manager after remote attach failure: ${formatErrorMessage(
                cleanupError
              )}`
            );
          });
        throw error;
      }
    }
    return manager;
  }

  constructor(options: LoroDocumentManagerOptions) {
    this.repo = options.repo;
    this.workspaceId = options.workspaceId;
    this.userId = options.userId;
    this.logger = options.logger;
    this.localLoroDataPlaneServer = options.localLoroDataPlaneServer ?? null;
    this.sqliteRepoStore = options.sqliteRepoStore ?? null;
    this.remoteStreamsAttached = options.remoteStreamsAttached ?? false;
    this.streamsTokens = options.streamsTokens ?? null;
    this.cloudBilling = options.cloudBilling ?? null;
    this.remoteStreamsGeneration = this.remoteStreamsAttached ? 1 : 0;
    this.presenceRuntime = options.presenceRuntime ?? null;
    this.machineMonitorRuntime = options.machineMonitorRuntime ?? null;
    const initialTransportStatus = options.initialTransportStatus ?? 'disconnected';
    const initialMetaSyncPromise = options.initialMetaSyncPromise ?? Promise.resolve(false);
    const initialMetaSyncCompleted = options.initialMetaSyncCompleted ?? false;
    this.localLoroDataPlaneServer?.setDocRoomJoinHandler((docId) =>
      this.handleLocalDocRoomJoin(docId)
    );
    this.localLoroDataPlaneServer?.setDocRoomLeaveHandler((docId) =>
      this.handleLocalDocRoomLeave(docId)
    );
    this.localLoroDataPlaneServer?.setFlockRoomJoinHandler((flockDocId) =>
      this.handleLocalFlockRoomJoin(flockDocId)
    );
    this.localLoroDataPlaneServer?.setFlockRoomLeaveHandler((flockDocId) =>
      this.handleLocalFlockRoomLeave(flockDocId)
    );
    this.initialMetaSyncPromise = initialMetaSyncPromise.then((completed) => {
      if (completed) {
        this.initialMetaSyncCompleted = true;
      }
      return completed;
    });
    this.initialMetaSyncCompleted = initialMetaSyncCompleted;
    this.connectionRecovery = new LoroConnectionRecoveryController({
      repo: this.repo,
      workspaceId: this.workspaceId,
      logger: this.logger,
      initialMetaSub: options.metaSub,
      initialTransportStatus,
      initialMetaSyncPromise: this.initialMetaSyncPromise,
      initialMetaSyncCompleted,
      onMetaRoomReady: () => {
        this.initialMetaSyncCompleted = true;
      },
    });
    this.machineFlockSync = new MachineFlockSyncCoordinator({
      repo: this.repo,
      workspaceId: this.workspaceId,
      logger: this.logger,
    });
    // Parked-work release, not a rescan: a dirty Machine Flock doc arms no
    // retry timer of its own when there is no transport, so this signal is its
    // ONLY wake-up. It must stay on the unthrottled online edge.
    this.detachMachineFlockMetaRoomSyncedListener = this.connectionRecovery.onStreamsOnline(
      (reason) => {
        this.machineFlockSync.retryDirtyNow(`streams-online:${reason}`);
      }
    );
  }

  private setTransportStatus(status: TransportConnectionStatus): void {
    this.connectionRecovery.setTransportStatus(status);
  }

  /**
   * Attach/detach can race (remote bridge reconcile vs offline handling), and
   * an attach spans slow network waits (token fetch, transport connect).
   * Serialize both so a detach can't interleave mid-attach and leave the
   * repo transports/presence in a mixed state.
   */
  private runRemoteTransportOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.remoteTransportOpQueue.then(fn, fn);
    this.remoteTransportOpQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async attachRemoteStreamsTransport(): Promise<void> {
    await this.runRemoteTransportOp(() => this.attachRemoteStreamsTransportInner());
  }

  private async attachRemoteStreamsTransportInner(): Promise<void> {
    if (this.remoteStreamsAttached) {
      return;
    }
    if (!this.sqliteRepoStore) {
      throw new Error('sqlite_repo_store_unavailable');
    }
    if (!this.streamsTokens) {
      throw new Error('cloud_streams_port_unavailable');
    }

    const streamsTransport = await createCliStreamsTransport({
      workspaceId: this.workspaceId,
      tokenProvider: this.streamsTokens.createTokenProvider({ workspaceId: this.workspaceId }),
      remoteCursorStore: this.sqliteRepoStore.remoteCursorStore,
      logger: this.logger,
      // These resolve as soon as the flush is SCHEDULED, not once it has run —
      // the transport must not block on local persistence. See
      // `scheduleRemoteSyncPersist`.
      onPersistDoc: async () => {
        this.scheduleRemoteSyncPersist('remote-doc-sync');
      },
      onPersistMeta: async () => {
        this.scheduleRemoteSyncPersist('remote-meta-sync');
      },
      onPersistFlockDoc: async () => {
        this.scheduleRemoteSyncPersist('remote-flock-sync');
      },
    });
    installStreamsDiagnostics(this.logger);
    const detachStreamsTransportStatusListener = streamsTransport.adapter.onStatusChange(
      (status) => {
        this.logger.debug(`[${this.workspaceId}] Loro streams transport status: ${status}`);
        // With Streams attached, the adapter's own status is the workspace's
        // transport status (there is no other transport on the CLI repo).
        this.setTransportStatus(status);
      }
    );

    try {
      await this.repo.addTransport('streams', streamsTransport.adapter, { ephemeral: true });
      this.remoteStreamsStatusUnsubscribe = detachStreamsTransportStatusListener;
      // The presence runtime already exists (created at repo init and producing
      // presence locally); attaching the cloud Streams sink additionally mirrors
      // it to the cloud presence stream.
      this.presenceRuntime?.attachStreams({
        streamsBaseUrl: streamsTransport.gatewayBaseUrl,
        auth: streamsTransport.tokenProvider.createAuthCallback(),
        shardHostSuffix: streamsTransport.tokenProvider.getShardHostSuffix(),
      });
      this.machineMonitorRuntime?.attachStreams({
        streamsBaseUrl: streamsTransport.gatewayBaseUrl,
        auth: streamsTransport.tokenProvider.createAuthCallback(),
        shardHostSuffix: streamsTransport.tokenProvider.getShardHostSuffix(),
      });
      this.remoteStreamsAttached = true;
      this.remoteStreamsGeneration += 1;
      this.logger.info(`[${this.workspaceId}] Remote Streams transport attached`);
      // addTransport resolves even when individual rooms failed to attach at
      // the repo level (their bindings sit in 'error', and repo.reconnect does
      // NOT retry those — only binding.rejoin() does). Surface them here; the
      // connection-recovery sweep owns the repair. Diagnostics only, and past
      // the `remoteStreamsAttached` commit point: its own try keeps a throw
      // here from running the rollback below, which would detach the transport
      // while the flag stays set and leave the workspace cloud-dead.
      try {
        const failedRooms = this.repo
          .transportRooms('streams')
          .filter((entry) => entry.subscription.status === 'error');
        if (failedRooms.length > 0) {
          this.logger.warn(
            `[${this.workspaceId}] Streams transport attached with ${failedRooms.length} failed room binding(s): ${failedRooms
              .map((entry) => `${entry.room.kind}:${entry.room.id}`)
              .join(', ')} (recovery sweep will rejoin)`
          );
        }
      } catch (error) {
        this.logger.debug(
          `[${this.workspaceId}] Failed to inspect Streams room bindings after attach: ${formatErrorMessage(error)}`
        );
      }
    } catch (error) {
      detachStreamsTransportStatusListener();
      await Promise.all([
        this.presenceRuntime?.detachStreams(),
        this.machineMonitorRuntime?.detachStreams(),
      ]).catch(() => undefined);
      // addTransport registers the transport before connecting, so a failure
      // anywhere in this block can leave a broken 'streams' transport behind —
      // remove it (close: true also closes the adapter) and close best-effort
      // as backup.
      await this.repo.removeTransport('streams', { close: true }).catch(() => undefined);
      await streamsTransport.adapter.close().catch((closeError: unknown) => {
        this.logger.debug(
          `[${this.workspaceId}] Failed to close remote Streams transport after attach failure: ${formatErrorMessage(
            closeError
          )}`
        );
      });
      // Back to local-only, which is a healthy state (see create()).
      this.setTransportStatus('connected');
      throw error;
    }
  }

  async detachRemoteStreamsTransport(): Promise<void> {
    await this.runRemoteTransportOp(() => this.detachRemoteStreamsTransportInner());
  }

  private async detachRemoteStreamsTransportInner(): Promise<void> {
    if (!this.remoteStreamsAttached) {
      return;
    }
    this.remoteStreamsAttached = false;
    this.remoteStreamsGeneration += 1;
    this.remoteStreamsStatusUnsubscribe?.();
    this.remoteStreamsStatusUnsubscribe = null;
    try {
      // Keep local presence production alive for the data plane, but revoke all
      // cloud ephemeral sinks together with the durable Streams transport.
      await Promise.all([
        this.presenceRuntime?.detachStreams(),
        this.machineMonitorRuntime?.detachStreams(),
      ]);
    } finally {
      await this.repo.removeTransport('streams', { close: true });
      // Deliberately offline (local-only) is a healthy state, matching the
      // pre-attach startup status; rooms sit 'detached' without recovery.
      this.setTransportStatus('connected');
      this.logger.info(`[${this.workspaceId}] Remote Streams transport detached`);
    }
  }

  /**
   * Persist all pending repo changes to the CLI's local SQLite store.
   *
   * This is a local durability barrier, not a cloud-synchronization barrier.
   * Domain workflows that must survive process exit should await it; cloud
   * convergence remains owned by the attached Streams transport.
   */
  async persistPendingChanges(reason: LoroRepoPersistReason): Promise<void> {
    const startedAt = Date.now();
    this.logger.debug(`[${this.workspaceId}] Loro repo flush started (reason=${reason})`);
    await withSlowOperationWarning(
      this.repo.flush(),
      this.logger,
      `loro-repo.flush(${reason})`,
      this.workspaceId
    );
    this.logger.debug(
      `[${this.workspaceId}] Loro repo flush completed (reason=${reason} duration=${
        Date.now() - startedAt
      }ms)`
    );
  }

  /**
   * Coalesces the Streams transport's per-sync-event persist requests; see
   * {@link PersistCoalescer}. Callers that need a real durability barrier
   * (session fork) keep calling `persistPendingChanges` directly.
   */
  private readonly remoteSyncPersist = new PersistCoalescer<LoroRepoPersistReason>({
    debounceMs: readTimeoutEnv('LODY_LORO_REMOTE_PERSIST_DEBOUNCE_MS', 200),
    flush: async (reasons) => {
      const single = reasons.length === 1 ? reasons[0] : undefined;
      if (!single) {
        this.logger.debug(
          `[${this.workspaceId}] Coalescing ${reasons.length} remote sync persists: ${reasons.join(', ')}`
        );
      }
      await this.persistPendingChanges(single ?? 'remote-sync-coalesced');
    },
    onError: (error) => {
      this.logger.debug(
        `[${this.workspaceId}] Coalesced remote-sync flush failed: ${formatErrorMessage(error)}`
      );
    },
  });

  /**
   * Ask for a local persist after a remote sync event.
   *
   * Deliberately not awaited by the transport callbacks: this is a local durability
   * barrier, not a correctness one — the data is already in the in-memory CRDT and,
   * being remote in origin, still in the cloud too.
   */
  private scheduleRemoteSyncPersist(reason: LoroRepoPersistReason): void {
    this.remoteSyncPersist.request(reason);
  }

  /**
   * The push-based data-plane engine that serves renderer↔CLI document sync for
   * this workspace. The CLI socket server routes client connections to it.
   */
  getLocalLoroDataPlaneServer(): LocalLoroDataPlaneServer | null {
    return this.localLoroDataPlaneServer;
  }

  /**
   * THE ONLY PLACE THE CLI MAY CALL `repo.unloadDoc`.
   *
   * `unloadDoc` evicts the doc from the repo's instance cache, so the next
   * `openPersistedDoc` returns a DIFFERENT `LoroDoc`. Anything still holding the
   * old instance keeps reading and writing an orphan. The local data plane is
   * exactly such a holder: a doc room resolves its `LoroDoc` once and keeps it
   * for as long as a renderer stays subscribed, so an unaccompanied unload
   * silently severs renderer↔CLI sync in both directions (observed: a
   * GC-evicted session whose next user turn never reached the CLI, so
   * `TurnHistoryGate` held the whole reply for its full 20s timeout).
   *
   * Invalidating AFTER the unload is deliberate: doing it before leaves a window
   * where a racing join re-opens the doc into the repo cache just in time for
   * the eviction to strand it again — and that failure is silent, whereas
   * updates lost in the window here are re-uploaded by the peer's next join
   * reconciliation.
   *
   * Route every new unload through here. `tests/loro-doc-unload-invalidates-data-plane.test.ts`
   * fails the build if another `repo.unloadDoc` call site appears.
   */
  async unloadDocRoom(docId: string): Promise<void> {
    await this.repo.unloadDoc(docId);
    this.localLoroDataPlaneServer?.invalidateDocRoom(docId);
    this.logger.debug(`[${this.workspaceId}] Unloaded doc ${docId} and invalidated its local room`);
  }

  isTransportConnected(): boolean {
    return this.connectionRecovery.isTransportConnected();
  }

  isTransportRecovering(): boolean {
    return this.connectionRecovery.isRecovering();
  }

  getConnectedRoomCount(): number {
    return this.sessions.size;
  }

  hasCompletedInitialMetaSync(): boolean {
    return this.initialMetaSyncCompleted;
  }

  async waitForInitialMetaSync(options: { timeoutMs?: number } = {}): Promise<boolean> {
    if (this.initialMetaSyncCompleted) {
      return true;
    }

    const timeoutMs = options.timeoutMs ?? 0;
    if (timeoutMs <= 0) {
      return await this.initialMetaSyncPromise;
    }

    const timeoutMessage = `Timeout waiting for initial meta sync (workspace=${this.workspaceId})`;
    try {
      return await withTimeout(this.initialMetaSyncPromise, timeoutMs, timeoutMessage);
    } catch (error) {
      if (error instanceof Error && error.message === timeoutMessage) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Trigger transport reconnect to recover rooms that may have entered "disconnected"
   * state (e.g. after network interruption or system sleep).
   */
  async reconnectTransport(): Promise<void> {
    await this.connectionRecovery.reconnect('manual');
  }

  /**
   * Expensive recovery signal ("rescan the workspace index"). Rate-limited by
   * the recovery controller. For "release work parked while offline", use
   * {@link onStreamsOnline} instead.
   */
  onMetaRoomSynced(listener: MetaRoomSyncedListener): () => void {
    return this.connectionRecovery.onMetaRoomSynced(listener);
  }

  /** Cheap, unthrottled "the Streams plane is usable again" signal. */
  onStreamsOnline(listener: StreamsOnlineListener): () => void {
    return this.connectionRecovery.onStreamsOnline(listener);
  }

  async waitUntilMetaSynced(
    options: { timeoutMs?: number; reason?: string } = {}
  ): Promise<boolean> {
    return await this.connectionRecovery.waitUntilMetaSynced(options);
  }

  // Sync-or-throw semantics under native multi-transport: with the single
  // routed 'streams' transport attached, `repo.sync()` rethrows the original
  // failure, preserving the throw-on-failure contract below. With ZERO
  // transports attached (offline, nothing registered) `repo.sync()` resolves
  // vacuously — same as the old local placeholder member, so parity holds.
  async syncMetaOrThrow(options: { timeoutMs?: number; reason?: string } = {}): Promise<void> {
    const reason = options.reason ?? 'explicit-sync';
    const timeoutMs = options.timeoutMs ?? readTimeoutEnv('LODY_LORO_SYNC_META_TIMEOUT_MS', 20_000);
    const timeoutMessage = `Timeout waiting for workspace metadata sync (workspace=${this.workspaceId})`;

    try {
      await withTimeout(this.repo.sync({ scope: 'meta' }), timeoutMs, timeoutMessage);
      this.initialMetaSyncCompleted = true;
    } catch (error) {
      throw new Error(`Workspace metadata sync failed (${reason}): ${formatErrorMessage(error)}`, {
        cause: error,
      });
    }
  }

  async syncDocOrThrow(
    docId: string,
    options: { timeoutMs?: number; reason?: string } = {}
  ): Promise<void> {
    const reason = options.reason ?? 'explicit-sync';
    const timeoutMs = options.timeoutMs ?? readTimeoutEnv('LODY_LORO_SYNC_DOC_TIMEOUT_MS', 8_000);
    const timeoutMessage = `Timeout waiting for document sync (doc=${docId})`;

    try {
      await withTimeout(
        this.repo.sync({ scope: 'doc', docIds: [docId] }),
        timeoutMs,
        timeoutMessage
      );
    } catch (error) {
      throw new Error(
        `Document sync failed for ${docId} (${reason}): ${formatErrorMessage(error)}`,
        {
          cause: error,
        }
      );
    }
  }

  async syncRemoteDocOrThrow(
    docId: string,
    options: { timeoutMs?: number; reason?: string } = {}
  ): Promise<void> {
    if (!this.remoteStreamsAttached) {
      throw new Error(`Remote Streams transport is not attached (doc=${docId})`);
    }
    const generation = this.remoteStreamsGeneration;
    await this.syncDocOrThrow(docId, options);
    if (!this.remoteStreamsAttached || this.remoteStreamsGeneration !== generation) {
      throw new Error(`Remote Streams transport changed during document sync (doc=${docId})`);
    }
  }

  /**
   * Concurrent callers for the SAME document share one round trip. A batch of
   * sessions starting together (dispatch drain, `session_create_many`) asks for
   * the identical workspace Flock doc at the same moment, and N syncs of one
   * document buy nothing but N timeout budgets. Each caller still applies its
   * OWN timeout to the shared attempt, and a stalled sync is not piled onto —
   * the same rule `machine-flock-sync-coordinator` already applies per machine.
   */
  async syncFlockDocOrThrow(
    flockDocId: string,
    options: { timeoutMs?: number; reason?: string } = {}
  ): Promise<void> {
    const reason = options.reason ?? 'explicit-sync';
    const timeoutMs =
      options.timeoutMs ?? readTimeoutEnv('LODY_LORO_SYNC_MACHINE_FLOCK_TIMEOUT_MS', 8_000);
    const timeoutMessage = `Timeout waiting for Flock document sync (doc=${flockDocId})`;

    let activeSync = this.activeFlockDocSyncs.get(flockDocId);
    if (!activeSync) {
      const started: Promise<unknown> = this.repo
        .sync({ scope: 'doc', flockDocIds: [flockDocId] })
        .finally(() => {
          if (this.activeFlockDocSyncs.get(flockDocId) === started) {
            this.activeFlockDocSyncs.delete(flockDocId);
          }
        });
      this.activeFlockDocSyncs.set(flockDocId, started);
      activeSync = started;
    }

    try {
      await withTimeout(activeSync, timeoutMs, timeoutMessage);
    } catch (error) {
      throw new Error(
        `Flock document sync failed for ${flockDocId} (${reason}): ${formatErrorMessage(error)}`,
        { cause: error }
      );
    }
  }

  async syncMachineFlockDoc(
    machineId: MachineId,
    options: { timeoutMs?: number; reason?: string; scheduleRetry?: boolean } = {}
  ): Promise<boolean> {
    return await this.machineFlockSync.syncNow(machineId, {
      ...options,
      reason: options.reason ?? 'explicit-sync',
      scheduleRetry: options.scheduleRetry ?? true,
    });
  }

  markMachineFlockDocDirty(
    machineId: MachineId,
    options: { reason?: string; timeoutMs?: number; resetBackoff?: boolean } = {}
  ): void {
    this.machineFlockSync.markDirty(machineId, options);
  }

  ensureMachineFlockDocJoined(machineId: MachineId, options: { reason?: string } = {}): void {
    void this.machineFlockSync.ensureJoined(machineId, options).catch((error: unknown) => {
      this.logger.debug(
        `[${this.workspaceId}] Failed to join Machine Flock room (machine=${machineId} reason=${
          options.reason ?? 'ensure-joined'
        }): ${formatErrorMessage(error)}`
      );
    });
  }

  private async destroyRepo(options: { fast?: boolean }): Promise<void> {
    const repoDestroyPromise = this.repo.destroy();
    if (!options.fast) {
      await repoDestroyPromise;
      return;
    }

    const destroyTimeoutMs = readTimeoutEnv('LODY_LORO_DESTROY_TIMEOUT_MS', 1_000);
    const timeoutMessage = `Timeout waiting for repo.destroy (workspace=${this.workspaceId})`;

    try {
      await withTimeout(repoDestroyPromise, destroyTimeoutMs, timeoutMessage);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== timeoutMessage) {
        throw error;
      }

      this.logger.debug(
        `[${this.workspaceId}] Repo destroy timed out after ${destroyTimeoutMs}ms during fast cleanup`
      );
    }
  }

  private pendingSessionDocs = new Map<SessionId, Promise<SessionDocument>>();
  private readonly localDocRoomHydrateQueue = new ConcurrentQueue<string>(4);
  private readonly localDocOwnershipChains = new Map<string, Promise<void>>();
  private localDocRoomBridgeGeneration = 0;
  private cleaningUp = false;
  private localDocRoomBridges = new Map<
    string,
    {
      sub: RepoRoomSubscription | null;
      cancel: () => void;
      canceled: Promise<void>;
    }
  >();
  private localFlockRoomBridges = new Map<
    string,
    {
      sub: RepoRoomSubscription | null;
    }
  >();

  private handleLocalDocRoomJoin(docId: string): void {
    const sessionId = getSessionIdFromRoomId(docId);
    if (
      !sessionId ||
      this.cleaningUp ||
      this.sessions.has(sessionId) ||
      this.pendingSessionDocs.has(sessionId) ||
      this.localDocRoomBridges.has(docId)
    ) {
      return;
    }

    let cancel!: () => void;
    const canceled = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    const bridge = { sub: null as RepoRoomSubscription | null, cancel, canceled };
    const generation = this.localDocRoomBridgeGeneration;
    this.localDocRoomBridges.set(docId, bridge);

    void this.localDocRoomHydrateQueue
      .enqueue(
        docId,
        async () =>
          await this.withLocalDocOwnership(docId, async () => {
            if (
              this.cleaningUp ||
              generation !== this.localDocRoomBridgeGeneration ||
              this.localDocRoomBridges.get(docId) !== bridge ||
              this.sessions.has(sessionId) ||
              this.pendingSessionDocs.has(sessionId)
            ) {
              return;
            }

            let sub: RepoRoomSubscription | null = null;
            try {
              sub = await this.repo.joinDocRoom(docId);
              if (
                this.cleaningUp ||
                generation !== this.localDocRoomBridgeGeneration ||
                this.localDocRoomBridges.get(docId) !== bridge ||
                this.sessions.has(sessionId) ||
                this.pendingSessionDocs.has(sessionId)
              ) {
                return;
              }
              bridge.sub = sub;
              // One cloud reconciliation is sufficient. A later active turn is
              // owned by SessionDispatchWatcher/SessionDocument; keeping this raw
              // subscription forever would recreate the historical-room leak.
              await Promise.race([streamsRoomBinding(sub).firstSyncedWithRemote, bridge.canceled]);
            } catch (error: unknown) {
              this.logger.debug(
                `[${sessionId}] Local data-plane session cloud reconcile failed: ${formatErrorMessage(error)}`
              );
            } finally {
              sub?.unsubscribe();
              if (this.localDocRoomBridges.get(docId) === bridge) {
                this.localDocRoomBridges.delete(docId);
              }
            }
          })
      )
      .catch((error: unknown) => {
        this.logger.debug(
          `[${sessionId}] Local data-plane session cloud reconcile queue failed: ${formatErrorMessage(error)}`
        );
      });
  }

  private handleLocalDocRoomLeave(docId: string): void {
    const sessionId = getSessionIdFromRoomId(docId);
    if (!sessionId || this.cleaningUp) {
      return;
    }
    this.cancelLocalDocRoomBridge(docId);
    const generation = this.localDocRoomBridgeGeneration;
    void this.localDocRoomHydrateQueue
      .enqueue(
        docId,
        async () =>
          await this.withLocalDocOwnership(docId, async () => {
            if (
              this.cleaningUp ||
              generation !== this.localDocRoomBridgeGeneration ||
              this.sessions.has(sessionId) ||
              this.pendingSessionDocs.has(sessionId) ||
              this.localDocRoomBridges.has(docId)
            ) {
              return;
            }
            await this.unloadDocRoom(docId);
          })
      )
      .catch((error: unknown) => {
        this.logger.debug(
          `[${sessionId}] Failed to release local data-plane session doc: ${formatErrorMessage(error)}`
        );
      });
  }

  private withLocalDocOwnership<T>(docId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.localDocOwnershipChains.get(docId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const chain = result.then(
      () => undefined,
      () => undefined
    );
    this.localDocOwnershipChains.set(docId, chain);
    void chain.finally(() => {
      if (this.localDocOwnershipChains.get(docId) === chain) {
        this.localDocOwnershipChains.delete(docId);
      }
    });
    return result;
  }

  private cancelLocalDocRoomBridge(docId: string): void {
    const bridge = this.localDocRoomBridges.get(docId);
    if (!bridge) {
      return;
    }
    this.localDocRoomBridges.delete(docId);
    bridge.cancel();
    bridge.sub?.unsubscribe();
  }

  private handleLocalFlockRoomJoin(flockDocId: string): void {
    this.ensureFlockDocHydratedForLocalJoin(flockDocId);
  }

  private handleLocalFlockRoomLeave(flockDocId: string): void {
    const bridge = this.localFlockRoomBridges.get(flockDocId);
    if (!bridge) {
      return;
    }
    bridge.sub?.unsubscribe();
    this.localFlockRoomBridges.delete(flockDocId);
  }

  // Cloud hydrate for a renderer-joined flock room. Background data relay only:
  // the CLI's cloud room status is NEVER pushed to the renderer as local room
  // health — offline, the local room stays healthy and this hydrate simply
  // fails/retries in the background (specs/local-first-two-plane.md).
  private ensureFlockDocHydratedForLocalJoin(flockDocId: string): void {
    const existing = this.localFlockRoomBridges.get(flockDocId);
    if (existing) {
      return;
    }

    const bridge = {
      sub: null as RepoRoomSubscription | null,
    };
    this.localFlockRoomBridges.set(flockDocId, bridge);

    void this.repo
      .joinFlockDocRoom(flockDocId)
      .then((sub) => {
        if (this.localFlockRoomBridges.get(flockDocId) !== bridge) {
          sub.unsubscribe();
          return;
        }
        bridge.sub = sub;
        // Binding, not classic: while no transport is attached this must stay
        // pending (and resolve after a later attach) instead of throwing.
        void streamsRoomBinding(sub).firstSyncedWithRemote.catch((error: unknown) => {
          this.logger.debug(
            `[${this.workspaceId}] Local data-plane Flock room cloud sync failed: flockDocId=${flockDocId} error=${formatErrorMessage(
              error
            )}`
          );
        });
      })
      .catch((error: unknown) => {
        if (this.localFlockRoomBridges.get(flockDocId) !== bridge) {
          return;
        }
        this.logger.debug(
          `[${this.workspaceId}] Local data-plane Flock room cloud join failed: flockDocId=${flockDocId} error=${formatErrorMessage(
            error
          )}`
        );
        this.localFlockRoomBridges.delete(flockDocId);
      });
  }

  async getOrCreateSessionDoc(sessionId: SessionId): Promise<SessionDocument> {
    const docId = getSessionRoomId(sessionId);
    // An activated SessionDocument owns the live cloud room from here on. Stop
    // any one-shot renderer reconciliation without unloading the shared doc.
    this.cancelLocalDocRoomBridge(docId);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    // Guard against concurrent init for the same session
    const pending = this.pendingSessionDocs.get(sessionId);
    if (pending) {
      return await pending;
    }

    // Serialize activation with renderer-only release for this exact doc. If a
    // local leave already started repo.unloadDoc(), wait for it to finish and
    // open a fresh handle; otherwise the unload could evict the document that
    // the newly activated SessionDocument is about to retain.
    const initPromise = this.withLocalDocOwnership(docId, async () => {
      const sessionDoc = new SessionDocument(
        this.repo,
        sessionId,
        (sessionDocId) => this.unloadDocRoom(sessionDocId),
        this.logger
      );
      await sessionDoc.init();
      // If cleanup ran while we were initializing, destroy the orphaned doc
      // instead of registering it (cleanUp/cleanSessionDoc only sees this.sessions).
      if (sessionDoc.isDestroyed) {
        throw new Error(`Session doc ${sessionId} was destroyed during init`);
      }
      this.sessions.set(sessionId, sessionDoc);
      return sessionDoc;
    });

    this.pendingSessionDocs.set(sessionId, initPromise);
    try {
      return await initPromise;
    } finally {
      this.pendingSessionDocs.delete(sessionId);
    }
  }

  async getSessionHistorySnapshot(sessionId: SessionId): Promise<SessionHistoryInput[]> {
    const active = this.sessions.get(sessionId);
    if (active) {
      return await active.getHistory();
    }

    const pending = this.pendingSessionDocs.get(sessionId);
    if (pending) {
      return await (await pending).getHistory();
    }

    const docId = getSessionRoomId(sessionId);
    // A temporary snapshot destroys (and therefore unloads) its SessionDocument.
    // Cancel any renderer-only cloud bridge first, then serialize the complete
    // open/read/destroy lifecycle with raw leave and live SessionDocument takeover.
    this.cancelLocalDocRoomBridge(docId);
    return await this.withLocalDocOwnership(docId, async () => {
      const sessionDoc = new SessionDocument(
        this.repo,
        sessionId,
        (snapshotDocId) => this.unloadDocRoom(snapshotDocId),
        this.logger
      );
      await sessionDoc.init({ skipAutoRead: true });
      try {
        return await sessionDoc.getHistory();
      } finally {
        await sessionDoc.destroy({ preserveStatus: true });
      }
    });
  }

  async createSession(
    machineId: string,
    cliType: AgentConfigCliType,
    agentType: AgentType,
    title?: string
  ): Promise<SessionId> {
    const sessionId = uuidv4() as SessionId;
    const sessionDoc = await this.getOrCreateSessionDoc(sessionId);

    const createdAt = new Date().toISOString();
    const sessionMeta: SessionMeta = {
      id: sessionId,
      machineId: machineId as MachineId,
      createdAt,
      userId: this.userId,
      status: SessionStatusFactory.initializing(),
      isArchived: false,
      cliType,
      agentType,
    };
    const sanitizedTitle = title?.trim();
    if (sanitizedTitle) {
      sessionMeta.title = sanitizedTitle;
    }

    await this.repo.upsertDocMeta(sessionDoc.roomId, sessionMeta);
    return sessionId;
  }

  /** Low-level session presence publish. Call only from SessionActivePresenceController. */
  publishSessionPresence(sessionId: SessionId, machineId: MachineId, status: SessionStatus): void {
    this.presenceRuntime?.setSessionPresence({
      sessionId,
      machineId,
      status,
    });
  }

  /** Clear this instance's session presence entry (e.g. after dispatch recovery fails). */
  clearSessionPresence(sessionId: SessionId): void {
    this.presenceRuntime?.clearSessionPresence(sessionId);
  }

  async hasAgentConfig(
    cliType: AgentConfigCliType,
    agentType: string,
    machineId: MachineId
  ): Promise<boolean> {
    const configs = await listMergedAgentConfigs(this.repo, this.workspaceId, [machineId]);
    for (const meta of configs) {
      if (
        meta.cliType === cliType &&
        meta.agentType === agentType &&
        meta.machineId === machineId
      ) {
        return true;
      }
    }
    return false;
  }

  /** Managed builtin provider types the user removed on this machine, so they must not be auto-registered at startup. */
  async getBuiltinAgentOptOuts(machineId: MachineId): Promise<Set<ManagedBuiltinAgentType>> {
    return await readMachineBuiltinAgentOptOuts(this.repo, this.workspaceId, machineId);
  }

  async getAgentConfigById(
    agentConfigId: AgentConfigId,
    machineId?: MachineId
  ): Promise<AgentConfigMeta | null> {
    if (machineId) {
      return (
        await readMergedAgentConfigById(this.repo, this.workspaceId, machineId, agentConfigId)
      ).config;
    }
    const configs = await listMergedAgentConfigs(this.repo, this.workspaceId);
    return configs.find((config) => config.id === agentConfigId) ?? null;
  }

  /**
   * Resolve the daemon-authoritative Provider config used by a process-launching
   * Machine RPC. Published configs and durable provider-setup rows are the only
   * accepted sources; caller-supplied launch fields never participate.
   */
  async getAgentConfigForMachineLaunch(
    agentConfigId: AgentConfigId,
    machineId: MachineId
  ): Promise<AgentConfigMeta | null> {
    const config = await this.getAgentConfigById(agentConfigId, machineId);
    if (config) {
      return isValidDaemonLaunchConfig(config, agentConfigId, machineId) ? config : null;
    }

    const handle = await this.repo.openFlockDoc(getMachineFlockDocId(this.workspaceId, machineId));
    const rows = readMachineFlockRowsFromFlock(handle.flock, {
      prefixes: [
        machineFlockKeys.providerSetup(agentConfigId),
        machineFlockKeys.providerSetupCancellation(agentConfigId),
      ],
    });
    if (getMachineFlockProviderSetupCancellations(rows)[agentConfigId]) {
      return null;
    }
    const setup = getMachineFlockProviderSetups(rows)[agentConfigId];
    return setup?.machineId === machineId &&
      isValidDaemonLaunchConfig(setup.config, agentConfigId, machineId)
      ? setup.config
      : null;
  }

  async createAgentConfig(
    cliType: AgentConfigCliType,
    agentType: AgentType,
    machineId: MachineId,
    name?: string
  ): Promise<AgentConfigId> {
    const agentConfigId = uuidv4() as AgentConfigId;
    await upsertMachineAgentConfig(
      this.repo,
      this.workspaceId,
      {
        id: agentConfigId,
        machineId,
        name: name ?? agentType,
        description: undefined,
        cliType,
        agentType,
        env: {},
      } satisfies AgentConfigMeta,
      { sync: this, reason: 'agent-config-upsert' }
    );
    return agentConfigId;
  }

  /**
   * Historical hook kept for startup flow compatibility. Title generation defaults are
   * now runtime-only and are not persisted into agent config meta.
   */
  async applyTitleGenerationDefaults(
    _cliType: AgentConfigCliType,
    _agentType: string,
    _configOptions: AcpConfigOptionSummary[]
  ): Promise<void> {
    // Intentionally no-op. New builtin agent configs no longer persist title defaults;
    // runtime generation computes least-privilege defaults from current ACP configOptions.
  }

  async registerMachine(machineId: MachineId, machine: MachineMetaPatch): Promise<void> {
    if (!this.machine) {
      this.machine = this.createMachineDocument(machineId);
      await this.machine.init();
    }
    // Machine online/offline state lives on the ephemeral presence channel
    // only; durable `lastSeen` is legacy and no longer written.
    await this.machine.setMetaState(machine);
    this.presenceRuntime?.setMachineOnline(machineId);
  }

  /**
   * Machine ids with a fresh presence heartbeat, read from the ephemeral
   * presence room. Returns null when the presence room could not be joined in
   * time — callers must treat that as "online status unknown", not "offline".
   */
  async getOnlineMachineIds(options: { timeoutMs?: number } = {}): Promise<Set<MachineId> | null> {
    if (!this.presenceRuntime) return null;
    const joined = await this.presenceRuntime.waitUntilJoined(options.timeoutMs ?? 10_000);
    if (!joined) return null;
    return collectOnlineMachineIdsFromPresence(
      this.presenceRuntime.getPresenceStates(),
      getServerNow()
    );
  }

  /**
   * Current parsed presence snapshot, or null when the presence room is
   * unavailable. Read-only access for the PR poller's viewed-session signal.
   */
  getPresenceStates(): LodyPresenceStateMap | null {
    return this.presenceRuntime?.getPresenceStates() ?? null;
  }

  /**
   * Subscribe to parsed presence snapshots (fires on any store change).
   * Returns the unsubscribe fn, or null when the presence room is unavailable.
   */
  subscribePresenceStates(listener: (states: LodyPresenceStateMap) => void): (() => void) | null {
    return this.presenceRuntime?.subscribe(listener) ?? null;
  }

  async updateRateLimits(machineId: MachineId, cliType: CliType, limits: RateLimit): Promise<void> {
    if (!this.machine) {
      this.machine = this.createMachineDocument(machineId);
      await this.machine.init();
    }
    await this.machine.updateRateLimits(cliType, limits);
  }

  async updateAcpCapabilities(
    machineId: MachineId,
    configId: AgentConfigId,
    cliType: AgentConfigCliType,
    agentType: string,
    modes: AcpModeSummary[],
    models: AcpModelSummary[],
    configOptions: AcpConfigOptionSummary[] | undefined,
    availableCommands: AcpCommandSummary[] | undefined,
    sessionFork: boolean,
    sourceVersion: string,
    modelReasoningEfforts?: Record<string, string[]>,
    acknowledgedSteer = false,
    options: { signal?: AbortSignal } = {}
  ): Promise<AcpCapabilityCacheEntry> {
    options.signal?.throwIfAborted();
    if (!this.machine) {
      this.machine = this.createMachineDocument(machineId);
      await this.machine.init();
    }
    options.signal?.throwIfAborted();
    return await this.machine.updateAcpCapabilities(
      configId,
      cliType,
      agentType,
      modes,
      models,
      configOptions,
      availableCommands,
      sessionFork,
      sourceVersion,
      modelReasoningEfforts,
      acknowledgedSteer,
      options
    );
  }

  async getAcpCapabilities(
    machineId: MachineId,
    configId: AgentConfigId
  ): Promise<AcpCapabilityCacheEntry | undefined> {
    if (!this.machine) {
      this.machine = this.createMachineDocument(machineId);
      await this.machine.init();
    }
    return this.machine.getAcpCapabilities(configId);
  }

  private createMachineDocument(machineId: MachineId): MachineDocument {
    return new MachineDocument(this.repo, this.workspaceId, machineId, (reason) => {
      this.markMachineFlockDocDirty(machineId, { reason });
    });
  }

  /**
   * Restores this machine document when the repo marks it as missing/deleted.
   * This should be called on reconnect to prevent stale offline status.
   */
  async restoreMachineDocument(machineId: MachineId): Promise<void> {
    const machineRoomId = getMachineRoomId(machineId);
    await this.repo.restoreDoc(machineRoomId);
    this.logger.debug(`Restored machine document for ${machineId}`);
  }

  /**
   * Watches for machine document existence changes and restores the document if needed.
   * This ensures the machine stays online even if the repo marks it missing unexpectedly.
   */
  watchMachineDocumentExistence(machineId: MachineId): void {
    // Clean up any existing watcher
    this.machineExistenceWatcher?.unsubscribe();

    const machineRoomId = getMachineRoomId(machineId);
    this.machineExistenceWatcher = this.repo.watch(
      (event) => {
        if (
          event.kind === 'doc-existence-changed' &&
          event.docId === machineRoomId &&
          (event.to === 'deleted' || event.to === 'missing')
        ) {
          this.logger.debug(`Detected missing machine document for ${machineId}, restoring it`);
          void this.restoreMachineDocument(machineId);
        }
      },
      { kinds: ['doc-existence-changed'], docIds: [machineRoomId] }
    );
    this.logger.debug(`Started watching document existence for machine ${machineId}`);
  }

  async cleanUp(options: { fast?: boolean; preserveSessionStatus?: boolean } = {}) {
    this.cleaningUp = true;
    this.localDocRoomBridgeGeneration += 1;
    for (const docId of [...this.localDocRoomBridges.keys()]) {
      this.cancelLocalDocRoomBridge(docId);
    }
    this.localLoroDataPlaneServer?.dispose();
    try {
      await this.machineMonitorRuntime?.stop();
    } catch (error) {
      this.logger.debug(
        `[${this.workspaceId}] Failed to stop machine monitor runtime: ${formatErrorMessage(error)}`
      );
    }
    try {
      await this.presenceRuntime?.stop();
    } catch (error) {
      this.logger.debug(
        `[${this.workspaceId}] Failed to stop Loro presence runtime: ${formatErrorMessage(error)}`
      );
    }
    this.detachMachineFlockMetaRoomSyncedListener?.();
    this.detachMachineFlockMetaRoomSyncedListener = null;
    await this.machineFlockSync.cleanUp();
    await this.connectionRecovery.cleanUp();
    // Await and destroy any in-flight session doc inits so they don't
    // re-register themselves after cleanup has run.
    for (const [sessionId, pending] of this.pendingSessionDocs) {
      try {
        const doc = await pending;
        await doc.destroy({ preserveStatus: options.preserveSessionStatus });
        this.sessions.delete(sessionId);
      } catch {
        // Init failed — nothing to clean up
      }
    }
    this.pendingSessionDocs.clear();
    this.localDocRoomBridges.clear();
    for (const bridge of this.localFlockRoomBridges.values()) {
      bridge.sub?.unsubscribe();
    }
    this.localFlockRoomBridges.clear();

    for (const sessionDoc of this.sessions.values()) {
      await sessionDoc.destroy({ preserveStatus: options.preserveSessionStatus });
    }
    await this.machine?.destroy();
    this.machine = null;
    this.sessions.clear();
    this.machineExistenceWatcher?.unsubscribe();
    this.machineExistenceWatcher = null;
    this.remoteStreamsStatusUnsubscribe?.();
    this.remoteStreamsStatusUnsubscribe = null;
    // A coalesced flush may still be waiting out its debounce window.
    await this.remoteSyncPersist.flushNow();
    await this.destroyRepo({ fast: options.fast });
  }

  configureMachineMonitor(
    machineId: MachineId,
    snapshotProvider: () => Promise<import('@lody/shared').MachineMonitorSnapshot>
  ): void {
    this.machineMonitorRuntime?.configure(machineId, snapshotProvider);
  }

  clearMachineMonitorProvider(): void {
    this.machineMonitorRuntime?.clearProvider();
  }

  async cleanSessionDoc(
    sessionId: SessionId,
    options: { preserveStatus?: boolean } = {}
  ): Promise<void> {
    // Also await any in-flight init for this session
    const pending = this.pendingSessionDocs.get(sessionId);
    if (pending) {
      try {
        const doc = await pending;
        await doc.destroy({ preserveStatus: options.preserveStatus });
        this.sessions.delete(sessionId);
      } catch {
        // Init failed — nothing to clean up
      }
      this.pendingSessionDocs.delete(sessionId);
    }

    const sessionDoc = this.sessions.get(sessionId);
    if (sessionDoc) {
      await sessionDoc.destroy({ preserveStatus: options.preserveStatus });
      this.sessions.delete(sessionId);
    }
  }
}

export interface LoroDocument<Doc, Meta> {
  roomId: string;
  init: () => Promise<void>;
  destroy: (options?: { preserveStatus?: boolean }) => Promise<void>;
  getMetaState: () => Promise<Meta | undefined>;
  getDocState: () => Promise<Doc | undefined>;
}

type SessionDocInitialState = {
  session?: {
    id?: SessionId;
  };
  history?: SessionHistoryInput[];
  forkOperation?: SessionForkOperation;
};

const configOptionValuesEqual = (
  left: SessionAcpRuntimeConfigSnapshot['configOptionValues'],
  right: SessionAcpRuntimeConfigSnapshot['configOptionValues']
): boolean => {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => left[key] === right[key])
  );
};

const acpRuntimeConfigEqual = (
  left: SessionAcpRuntimeConfigSnapshot,
  right: Omit<SessionAcpRuntimeConfigSnapshot, 'revision'>
): boolean =>
  left.acpSessionId === right.acpSessionId &&
  left.basedOnUserTurnId === right.basedOnUserTurnId &&
  left.modeId === right.modeId &&
  left.modelId === right.modelId &&
  configOptionValuesEqual(left.configOptionValues, right.configOptionValues);

/**
 * Hard cap on how long a queued message can hold the head-of-queue dispatch lock
 * via `isEditing`. If the editing client never releases (hard close, crash, killed
 * tab), the CLI dispatches the message anyway after this window. See
 * `popMessageQueue`.
 */
const EDITING_LEASE_MS = 5 * 60 * 1000;

export class SessionDocument implements LoroDocument<SessionDocMeta, SessionMeta> {
  mirror: Mirror<typeof sessionDocSchema> | null = null;
  handle: RepoDocHandle | null = null;
  docSub: RepoRoomSubscription | null = null;
  // Detached-aware 'streams' binding view of `docSub` (see streamsRoomBinding);
  // all status reads and sync waits go through it, never the classic surface.
  private docBinding: StreamsRoomBinding | null = null;
  private detachDocRoomStatusListener: (() => void) | null = null;
  private readonly docRoomStatusListeners = new Set<(status: RepoTransportRoomStatus) => void>();
  private historyAutoReadHandle: AutoMarkLatestUserHistoryAsReadHandle | null = null;
  private destroyed = false;

  get isDestroyed(): boolean {
    return this.destroyed;
  }
  private remoteSyncReady: Promise<void> = Promise.resolve();
  roomId: string = '';
  constructor(
    private repo: LoroRepo,
    public sessionId: SessionId,
    /**
     * Evicts the doc from the repo cache AND invalidates the local data-plane
     * room bound to the old instance. Injected rather than calling
     * `repo.unloadDoc` directly so the two can never be separated — see
     * `LoroDocumentManager.unloadDocRoom`.
     */
    private unloadDocRoom: (docId: string) => Promise<void>,
    private logger: Logger = getLogger('loro')
  ) {
    this.roomId = getSessionRoomId(this.sessionId);
  }

  private createMirror(handle: RepoDocHandle, initialState?: SessionDocInitialState) {
    this.historyAutoReadHandle?.dispose();
    this.historyAutoReadHandle = null;
    this.mirror?.dispose();
    const base: SessionDocInitialState = {
      session: { id: this.sessionId },
      history: [],
      forkOperation: undefined,
    };
    const initialHistory = initialState?.history ?? base.history ?? [];
    const normalizedHistory = initialHistory.map((entry) => ({
      ...entry,
      endedAt: entry.endedAt,
      modelInfo: entry.modelInfo,
    }));
    const mergedSession = initialState?.session
      ? { ...initialState.session, id: this.sessionId }
      : { ...base.session, id: this.sessionId };
    const merged = {
      ...base,
      ...initialState,
      session: {
        ...mergedSession,
      },
      history: normalizedHistory,
    };
    this.mirror = new Mirror({
      doc: handle.doc,
      schema: sessionDocSchema,
      // Tolerate root keys written by peers running a newer schema version.
      ignoreUnknownProperties: true,
      // Type assertion needed because InferInputType makes plan required even though
      // schema defines it as required: false. At runtime, plan is optional on history entries.
      initialState: merged as unknown as ConstructorParameters<typeof Mirror>[0]['initialState'],
    });
    this.historyAutoReadHandle = attachAutoMarkLatestUserHistoryAsRead(this.mirror);
    this.sanitizeSystemNoticeMetaInHistory();
  }

  private sanitizeSystemNoticeMetaInHistory(): void {
    if (!this.mirror) return;

    const history = (this.mirror.getState().history as SessionHistoryInput[]) || [];
    type SessionHistoryItemInput = NonNullable<SessionHistoryInput['items']>[number];
    let changed = false;
    let sanitizedItems = 0;
    let droppedMeta = 0;
    let droppedKeys = 0;

    const nextHistory = history.map((entry) => {
      const items = entry.items;
      if (!items || items.length === 0) return entry;

      let entryChanged = false;
      const nextItems = items.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const obj = item as SessionHistoryItemInput;
        if (obj.type !== 'system_notice') return item;
        if (!Object.prototype.hasOwnProperty.call(obj, 'meta')) return item;

        const meta = obj.meta;
        if (meta === undefined) {
          entryChanged = true;
          changed = true;
          sanitizedItems += 1;
          droppedMeta += 1;
          const { meta: _meta, ...rest } = obj;
          return rest;
        }

        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
          entryChanged = true;
          changed = true;
          sanitizedItems += 1;
          droppedMeta += 1;
          const { meta: _meta, ...rest } = obj;
          return rest;
        }

        const metaObj = meta as Record<string, unknown>;
        const cleaned: Record<string, unknown> = {};
        const removed: string[] = [];
        for (const [key, value] of Object.entries(metaObj)) {
          if (value === undefined) {
            removed.push(key);
            continue;
          }
          cleaned[key] = value;
        }

        if (removed.length === 0) return item;

        entryChanged = true;
        changed = true;
        sanitizedItems += 1;
        droppedKeys += removed.length;

        if (Object.keys(cleaned).length === 0) {
          droppedMeta += 1;
          const { meta: _meta, ...rest } = obj;
          return rest;
        }

        return { ...obj, meta: cleaned };
      });

      if (!entryChanged) return entry;
      return {
        ...entry,
        items: nextItems,
      };
    });

    if (!changed) return;

    const payload = {
      sanitizedItems,
      droppedMeta,
      droppedKeys,
    };
    this.logger.debug(
      `[${this.sessionId}] Sanitized system_notice meta in persisted history: ${JSON.stringify(payload)}`
    );
    void captureMessage('Sanitized system_notice meta in persisted history', {
      component: 'loro-doc',
      level: 'warning',
      extra: {
        sessionId: this.sessionId,
        ...payload,
      },
    });

    this.mirror.setState((prev) => {
      // @ts-ignore
      prev.history = nextHistory;
      return prev;
    });
  }

  async init(options: { skipAutoRead?: boolean } = {}) {
    this.destroyed = false;
    this.handle = await this.repo.openPersistedDoc(this.roomId);
    // Create the mirror before remote sync completes so dispatch watchers can subscribe
    // immediately; the room join continues in the background and remote changes merge later.
    this.createMirror(this.handle);
    if (!options.skipAutoRead) {
      await this.markLatestUserHistoryAsSeenIfNeeded();
    }
    this.remoteSyncReady = this.startDocRoomSync();
  }

  /**
   * Returns a promise that resolves when the initial remote sync completes
   * (or when the sync timeout expires). Resolves immediately if sync already finished.
   */
  async waitForRemoteSync(): Promise<void> {
    await this.remoteSyncReady;
  }

  async ensureDocRoomJoined(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    if (!this.docSub) {
      this.remoteSyncReady = this.startDocRoomSync();
    }

    await this.remoteSyncReady;
  }

  getDocRoomStatus(): RepoTransportRoomStatus | undefined {
    return this.docBinding?.status;
  }

  onDocRoomStatusChange(listener: (status: RepoTransportRoomStatus) => void): () => void {
    this.docRoomStatusListeners.add(listener);
    const status = this.getDocRoomStatus();
    if (status) {
      listener(status);
    }
    return () => {
      this.docRoomStatusListeners.delete(listener);
    };
  }

  private attachDocRoomStatusSource(binding: StreamsRoomBinding): void {
    this.detachDocRoomStatusListener?.();
    this.detachDocRoomStatusListener = binding.onStatusChange((status) => {
      this.emitDocRoomStatus(status);
    });
    if (binding.status) {
      this.emitDocRoomStatus(binding.status);
    }
  }

  private emitDocRoomStatus(status: RepoTransportRoomStatus): void {
    for (const listener of Array.from(this.docRoomStatusListeners)) {
      listener(status);
    }
  }

  async rejoinDocRoom(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    if (!this.docSub) {
      await this.ensureDocRoomJoined();
      return;
    }

    if (this.docSub.rejoin) {
      await this.docSub.rejoin();
    }
  }

  /**
   * Initialize without joining any transport rooms.
   * This is intended for tests or fully-offline usage.
   */
  async initOffline(initialState?: SessionDocInitialState) {
    this.destroyed = false;
    this.handle = await this.repo.openPersistedDoc(this.roomId);
    this.docSub?.unsubscribe();
    this.docSub = null;
    this.docBinding = null;
    this.detachDocRoomStatusListener?.();
    this.detachDocRoomStatusListener = null;
    this.createMirror(this.handle, initialState);
  }

  private async startDocRoomSync(): Promise<void> {
    // Join failures (typically stream_not_found while the web client is still
    // pre-creating the session doc stream in the background) retry with capped
    // exponential backoff instead of giving up after ~3s. Web-side stream
    // creation can lag by up to its 10s timeout, and a dropped join here used
    // to leave the pending-turn history wait with no live subscription.
    const MAX_JOIN_RETRIES = 8;
    const RETRY_BASE_DELAY_MS = 1_000;
    const RETRY_MAX_DELAY_MS = 30_000;

    for (let attempt = 0; attempt < MAX_JOIN_RETRIES; attempt++) {
      if (this.destroyed) {
        return;
      }

      let joinedSub: RepoRoomSubscription | null = null;
      try {
        joinedSub = await this.repo.joinDocRoom(this.roomId);
        if (this.destroyed) {
          joinedSub.unsubscribe();
          return;
        }

        // All detached-sensitive reads go through the 'streams' binding: the
        // classic surface hides 'detached' (reports it as 'disconnected') and
        // throws on a room with no routed transports at all.
        const binding = streamsRoomBinding(joinedSub);
        this.docSub = joinedSub;
        this.docBinding = binding;
        this.attachDocRoomStatusSource(binding);
        // No transport attached (deliberately offline): the room stays pending
        // and `firstSyncedWithRemote` cannot settle. Skip the bounded wait
        // instead of burning the timeout; loro-repo resumes the sync when a
        // transport attaches later.
        if (binding.status === 'detached') {
          return;
        }
        const syncDocTimeoutMs = readTimeoutEnv('LODY_LORO_SYNC_DOC_TIMEOUT_MS', 8_000);
        const timeoutMessage = `Timeout waiting for session doc initial sync (room=${this.roomId})`;
        await withTimeout(binding.firstSyncedWithRemote, syncDocTimeoutMs, timeoutMessage);
        return; // Success
      } catch (error) {
        const errMsg = formatErrorMessage(error);
        const timedOut =
          error instanceof Error &&
          error.message === `Timeout waiting for session doc initial sync (room=${this.roomId})`;

        if (timedOut) {
          this.logger.debug(
            `[${this.sessionId}] Session doc initial sync timed out, continuing offline-first; room recovery is managed by loro-repo: ${errMsg}`
          );
          return;
        }

        // Only retry when joinDocRoom itself failed before returning a room subscription.
        // Initial sync recovery for returned subscriptions is handled by loro-repo.
        if (!joinedSub && attempt < MAX_JOIN_RETRIES - 1) {
          const delayMs = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), RETRY_MAX_DELAY_MS);
          this.logger.debug(
            `[${this.sessionId}] joinDocRoom failed (attempt ${attempt + 1}/${MAX_JOIN_RETRIES}), retrying in ${delayMs}ms: ${errMsg}`
          );
          // Use unref() so the timer doesn't keep the process alive during fast cleanup
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delayMs);
            if (typeof timer === 'object' && 'unref' in timer) {
              timer.unref();
            }
          });
          if (this.destroyed) {
            return;
          }
          continue;
        }

        this.logger.debug(
          `[${this.sessionId}] Session doc initial sync unavailable, continuing offline-first; room recovery is managed by loro-repo: ${errMsg}`
        );
        // Report stream_not_found errors to error tracking for root cause analysis.
        if (errMsg.includes('stream_not_found')) {
          void captureException(error, {
            component: 'loro-doc-sync',
            extra: {
              sessionId: this.sessionId,
              roomId: this.roomId,
              errorMessage: errMsg,
            },
          });
        }
        return;
      }
    }
  }

  async getDocState(): Promise<SessionDocMeta | undefined> {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    const state = this.mirror.getState();
    const history: SessionHistory[] = (state.history ?? []).map((entry) => ({
      ...normalizeSessionHistoryEntry(entry as SessionHistoryInput),
      modelInfo: entry.modelInfo as ModelInfo | undefined,
      fileDiff: entry.fileDiff as SessionHistory['fileDiff'],
    }));

    return {
      session: state.session,
      history,
      mq: state.mq as SessionDocMeta['mq'],
      forkOperation: state.forkOperation as SessionDocMeta['forkOperation'],
      preview: state.preview as SessionDocMeta['preview'],
      externalHistoryCursor: state.externalHistoryCursor as SessionDocMeta['externalHistoryCursor'],
      acpRuntimeConfig: state.acpRuntimeConfig as SessionDocMeta['acpRuntimeConfig'],
    };
  }

  async waitUntilSynced(options: { timeoutMs?: number } = {}): Promise<boolean> {
    const binding = this.docBinding;
    if (!binding) {
      return false;
    }

    // A room that is reconnecting/disconnected/errored cannot confirm pending
    // writes within any bounded wait — recovery is loro-repo's job on its own
    // schedule. 'detached' means the 'streams' transport is not attached at
    // all (deliberately offline), which cannot confirm either. Answer "not
    // confirmed" immediately instead of burning the timeout on every call
    // while offline. 'connecting' is excluded: a healthy first join can still
    // complete within the wait.
    const status = binding.status;
    if (
      status === 'reconnecting' ||
      status === 'disconnected' ||
      status === 'error' ||
      status === 'detached'
    ) {
      this.logger.debug(
        `[${this.sessionId}] Skipping session doc sync wait: doc room is ${status} (room=${this.roomId})`
      );
      return false;
    }

    const timeoutMs =
      options.timeoutMs ?? readTimeoutEnv('LODY_LORO_WAIT_DOC_SYNC_TIMEOUT_MS', 4_000);
    const timeoutMessage = `Timeout waiting for session doc pending writes (room=${this.roomId})`;

    try {
      await withTimeout(binding.waitUntilSynced(), timeoutMs, timeoutMessage);
      return true;
    } catch (error) {
      this.logger.debug(
        `[${this.sessionId}] Session doc pending writes were not confirmed before continuing: ${formatErrorMessage(
          error
        )}`
      );
      return false;
    }
  }

  async getMetaState(): Promise<SessionMeta | undefined> {
    return await getAliveDocMeta<SessionMeta>(this.repo, this.roomId);
  }

  getForkOperation(): SessionForkOperation | undefined {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    const parsed = SessionForkOperationSchema.safeParse(this.mirror.getState().forkOperation);
    return parsed.success ? parsed.data : undefined;
  }

  setForkOperation(operation: SessionForkOperation | undefined): void {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    this.mirror.setState((prev) => {
      if (operation) {
        // Mirror exposes readonly state to callers, but setState supplies its mutable draft.
        // @ts-expect-error mutable Mirror draft
        prev.forkOperation = operation;
      } else {
        // @ts-expect-error mutable Mirror draft
        delete prev.forkOperation;
      }
      return prev;
    });
  }

  applyAcpRuntimeConfigPatch(
    basedOnUserTurnId: string,
    patch: SessionAcpRuntimeConfigPatch
  ): boolean {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }

    const durablePatch: SessionAcpRuntimeConfigPatch =
      patch.configOptionValues === undefined
        ? patch
        : {
            ...patch,
            configOptionValues: Object.fromEntries(
              Object.entries(patch.configOptionValues).filter(
                ([configId]) => !isSensitiveAcpConfigOptionId(configId)
              )
            ),
          };

    const state = this.mirror.getState();
    const incomingTurnIndex = state.history.findIndex(
      (entry) => entry.role === 'user' && entry.id === basedOnUserTurnId
    );
    let latestUserTurnIndex = -1;
    for (let index = state.history.length - 1; index >= 0; index -= 1) {
      if (state.history[index]?.role === 'user') {
        latestUserTurnIndex = index;
        break;
      }
    }
    if (incomingTurnIndex < 0 || incomingTurnIndex !== latestUserTurnIndex) {
      return false;
    }

    const current = state.acpRuntimeConfig as SessionAcpRuntimeConfigSnapshot | undefined;
    const currentTurnIndex = current
      ? state.history.findIndex(
          (entry) => entry.role === 'user' && entry.id === current.basedOnUserTurnId
        )
      : -1;
    if (currentTurnIndex > incomingTurnIndex) {
      return false;
    }

    const continuesCurrentSnapshot =
      current?.acpSessionId === durablePatch.acpSessionId &&
      current.basedOnUserTurnId === basedOnUserTurnId;
    const nextWithoutRevision: Omit<SessionAcpRuntimeConfigSnapshot, 'revision'> = {
      ...(continuesCurrentSnapshot
        ? {
            ...(current.modeId !== undefined ? { modeId: current.modeId } : {}),
            ...(current.modelId !== undefined ? { modelId: current.modelId } : {}),
            ...(current.configOptionValues !== undefined
              ? { configOptionValues: current.configOptionValues }
              : {}),
          }
        : {}),
      ...durablePatch,
      basedOnUserTurnId,
    };
    if (current && acpRuntimeConfigEqual(current, nextWithoutRevision)) {
      return false;
    }

    const next: SessionAcpRuntimeConfigSnapshot = {
      ...nextWithoutRevision,
      revision: (current?.revision ?? 0) + 1,
    };
    this.mirror.setState((prev) => {
      // Mirror exposes readonly state to callers, but setState supplies its mutable draft.
      // @ts-expect-error mutable Mirror draft
      prev.acpRuntimeConfig = next;
      return prev;
    });
    return true;
  }

  async markHistoryAsSeen(turnId: string): Promise<void> {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    this.logger.debug(`Marking session ${this.sessionId} history as seen`);
    this.mirror.setState((prev) => {
      const histories = prev.history ?? [];
      for (const item of histories) {
        if (item.id === turnId) {
          item.status = 'seen';
          item.read = getLegacyReadForSessionHistoryStatus('seen');
          break;
        }
      }
      return prev;
    });
  }

  async markLatestUserHistoryAsSeenIfNeeded(): Promise<void> {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }

    const history = this.mirror.getState().history ?? [];
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (!entry) continue;
      if (entry.role !== 'user') continue;
      if (resolveSessionHistoryStatus(entry) !== 'pending') return;
      await this.markHistoryAsSeen(entry.id);
      return;
    }
  }

  async setACPSessionId(acpSessionId: ACPSessionId) {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    this.logger.debug(`[${this.sessionId}] setACPSessionId: getting current doc meta`);
    const current = await withSlowOperationWarning(
      this.repo.getDocMeta(this.roomId),
      this.logger,
      'repo.getDocMeta',
      this.sessionId
    );
    if (isLoroRepoDocDeleted(current)) {
      this.logger.debug(`[${this.sessionId}] setACPSessionId: doc deleted, skipping`);
      return;
    }
    this.logger.debug(
      `[${this.sessionId}] setACPSessionId: calling upsertDocMeta (acpSessionId=${acpSessionId})`
    );
    await withSlowOperationWarning(
      this.repo.upsertDocMeta(this.roomId, {
        acpSessionId,
      }),
      this.logger,
      'repo.upsertDocMeta(acpSessionId)',
      this.sessionId
    );
    this.logger.debug(`[${this.sessionId}] setACPSessionId: upsertDocMeta complete`);
  }

  async setTitle(title: string, source?: SessionTitleSource) {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    const sanitized = title?.trim();
    if (!sanitized) {
      return;
    }
    const current = await this.repo.getDocMeta(this.roomId);
    if (isLoroRepoDocDeleted(current)) return;
    const update: Partial<SessionMeta> = {
      title: sanitized,
    };
    if (source) {
      update.titleSource = source;
    }
    await this.repo.upsertDocMeta(this.roomId, update);
  }

  /**
   * Sets the title only when the current title may still be replaced, checked at
   * write time against the latest doc meta: an existing titled meta whose
   * titleSource is set and not in `allowedSources` blocks the write. This guards
   * against user renames (source 'user') racing with asynchronous title updates.
   * Returns true when the title was applied.
   */
  async setTitleIfSourceIn(
    title: string,
    source: SessionTitleSource,
    allowedSources: readonly SessionTitleSource[]
  ): Promise<boolean> {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    const sanitized = title?.trim();
    if (!sanitized) {
      return false;
    }
    const current = await this.repo.getDocMeta(this.roomId);
    if (isLoroRepoDocDeleted(current)) return false;
    const currentMeta = await this.getMetaState();
    const currentTitle = currentMeta?.title?.trim();
    const currentSource = currentMeta?.titleSource;
    if (currentTitle && currentSource && !allowedSources.includes(currentSource)) {
      return false;
    }
    await this.repo.upsertDocMeta(this.roomId, { title: sanitized, titleSource: source });
    return true;
  }

  async setRepoFullName(repoFullName: string) {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    const sanitized = repoFullName?.trim();
    if (!sanitized) {
      return;
    }
    const current = await this.repo.getDocMeta(this.roomId);
    if (isLoroRepoDocDeleted(current)) return;
    await this.repo.upsertDocMeta(this.roomId, {
      repoFullName: sanitized,
    });
  }

  async setProject(project: ProjectRef) {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    const current = await this.repo.getDocMeta(this.roomId);
    if (isLoroRepoDocDeleted(current)) return;
    await this.repo.upsertDocMeta(this.roomId, { project });
  }

  async setBranchName(branchName: string) {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    const sanitized = branchName?.trim();
    if (!sanitized) {
      return;
    }
    const current = await this.repo.getDocMeta(this.roomId);
    if (isLoroRepoDocDeleted(current)) return;
    await this.repo.upsertDocMeta(this.roomId, {
      branchName: sanitized,
    });
  }

  async setIsWorktree(isWorktree: boolean) {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    const current = await this.repo.getDocMeta(this.roomId);
    if (isLoroRepoDocDeleted(current)) return;
    await this.repo.upsertDocMeta(this.roomId, {
      isWorktree,
    });
  }

  async setBaseBranch(baseBranch: string) {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    const sanitized = baseBranch?.trim();
    if (!sanitized) {
      return;
    }
    const current = await this.repo.getDocMeta(this.roomId);
    if (isLoroRepoDocDeleted(current)) return;
    await this.repo.upsertDocMeta(this.roomId, {
      baseBranch: sanitized,
    });
  }

  async setLastMessageAt(timestamp?: number) {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    const next =
      typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : getServerNow();
    const current = await this.repo.getDocMeta(this.roomId);
    if (isLoroRepoDocDeleted(current)) return;
    const currentMeta = current?.meta as SessionMeta | undefined;
    await this.repo.upsertDocMeta(this.roomId, {
      lastMessageAt: next,
    });
    const parentSessionId = currentMeta?.parentSessionId;
    if (!parentSessionId || parentSessionId === this.sessionId) {
      return;
    }
    await this.setParentLastMessageAt(parentSessionId, next);
  }

  /**
   * Clears the "waiting on a human" marker.
   *
   * Separate from `setStatus` because the status after a permission resolves is
   * conditional (running is only restored while active presence is still owned
   * locally), while the marker must be cleared on every resolution path.
   */
  async clearAwaitingUser() {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    const current = await this.repo.getDocMeta(this.roomId);
    if (isLoroRepoDocDeleted(current)) return;
    const currentMeta = current?.meta as SessionMeta | undefined;
    if (currentMeta?.awaitingUserSince === undefined) {
      return;
    }
    await this.repo.upsertDocMeta(this.roomId, { awaitingUserSince: undefined });
  }

  private async setParentLastMessageAt(parentSessionId: SessionId, timestamp: number) {
    const parentRoomId = getSessionRoomId(parentSessionId);
    const parent = await this.repo.getDocMeta(parentRoomId);
    if (isLoroRepoDocDeleted(parent)) return;
    const parentMeta = parent?.meta as SessionMeta | undefined;
    const parentLastMessageAt =
      typeof parentMeta?.lastMessageAt === 'number' && Number.isFinite(parentMeta.lastMessageAt)
        ? parentMeta.lastMessageAt
        : null;
    if (parentLastMessageAt !== null && parentLastMessageAt >= timestamp) {
      return;
    }
    await this.repo.upsertDocMeta(parentRoomId, {
      lastMessageAt: timestamp,
    });
  }

  async setContextWindowUsage(usage: SessionContextWindowUsage): Promise<void> {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    const size = usage.size;
    const used = usage.used;
    if (!Number.isFinite(size) || !Number.isFinite(used) || size < 0 || used < 0) {
      return;
    }
    const current = await this.repo.getDocMeta(this.roomId);
    if (isLoroRepoDocDeleted(current)) return;
    const currentUsage = (current?.meta as SessionMeta | undefined)?.contextWindowUsage;
    if (currentUsage && currentUsage.size === size && currentUsage.used === used) {
      return;
    }
    await this.repo.upsertDocMeta(this.roomId, {
      contextWindowUsage: {
        size,
        used,
      },
    });
  }

  async getStatus(): Promise<SessionStatus | undefined> {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    const meta = await getAliveDocMeta<SessionMeta>(this.repo, this.roomId);
    return meta?.status;
  }

  async isChat(): Promise<boolean> {
    if (!this.mirror) {
      return false;
    }
    const meta = await getAliveDocMeta<SessionMeta>(this.repo, this.roomId);
    return !!meta?.acpSessionId;
  }

  /**
   * `extraPatch` lets callers fold additional meta fields into the same
   * upsert as the status transition (e.g. dispatch pointers at turn start),
   * avoiding a chain of sequential doc-meta writes on the latency-critical path.
   */
  async setStatus(status: SessionStatus, extraPatch?: Partial<SessionMeta>) {
    if (!this.mirror) {
      throw new Error('Mirror not initialized');
    }
    this.logger.debug(
      `[${this.sessionId}] setStatus: getting current doc meta (status.type=${status.type})`
    );
    const current = await withSlowOperationWarning(
      this.repo.getDocMeta(this.roomId),
      this.logger,
      'repo.getDocMeta',
      this.sessionId
    );
    if (isLoroRepoDocDeleted(current)) {
      this.logger.debug(`[${this.sessionId}] setStatus: doc deleted, skipping`);
      return;
    }
    this.logger.debug(
      `[${this.sessionId}] setStatus: calling upsertDocMeta (status.type=${status.type})`
    );
    const patch: Partial<SessionMeta> = { ...extraPatch, status };
    if (status.type !== 'idle') {
      patch.lastRunningSeen = getServerNow();
    }
    await withSlowOperationWarning(
      this.repo.upsertDocMeta(this.roomId, patch),
      this.logger,
      `repo.upsertDocMeta(status=${status.type})`,
      this.sessionId
    );
    this.logger.debug(`[${this.sessionId}] setStatus: upsertDocMeta complete`);
  }

  async getHistory(): Promise<SessionHistoryInput[]> {
    if (!this.mirror) {
      return [];
    }
    return ((this.mirror.getState().history as SessionHistoryInput[]) || []).map(
      normalizeSessionHistoryEntry
    );
  }

  async getPreviewState(): Promise<SessionPreviewDocState | undefined> {
    if (!this.mirror) {
      return undefined;
    }
    return this.mirror.getState().preview as SessionPreviewDocState | undefined;
  }

  async setPreviewState(preview: SessionPreviewDocState): Promise<void> {
    if (!this.mirror) {
      throw new Error('Mirror not initialized');
    }
    this.mirror.setState((prev) => ({
      ...prev,
      preview,
    }));
  }

  async getExternalHistoryCursor(): Promise<SessionExternalHistoryCursorDocState | undefined> {
    if (!this.mirror) {
      return undefined;
    }
    return this.mirror.getState().externalHistoryCursor as
      | SessionExternalHistoryCursorDocState
      | undefined;
  }

  async setExternalHistoryCursor(cursor: SessionExternalHistoryCursorDocState): Promise<void> {
    if (!this.mirror) {
      throw new Error('Mirror not initialized');
    }
    this.mirror.setState((prev) => ({
      ...prev,
      externalHistoryCursor: cursor,
    }));
  }

  /**
   * Get the plan from the latest assistant entry in history.
   * Plan is now stored per-turn on each history entry, not at the root level.
   */
  async getPlan(): Promise<SessionPlanEntry[]> {
    const entry = this.getLatestAssistantHistory();
    if (!entry) {
      return [];
    }
    return (entry.plan ?? []) as SessionPlanEntry[];
  }

  async addPullRequest(prMeta: SessionPullRequestMeta): Promise<void> {
    const summary = normalizeSessionPullRequestMeta(prMeta);
    if (!summary) return;
    const current = await this.repo.getDocMeta(this.roomId);
    if (isLoroRepoDocDeleted(current)) return;
    const existingMeta = current?.meta as SessionMeta | undefined;
    const existing = (existingMeta?.pullRequests ?? []).flatMap((item) => {
      const parsed = normalizeSessionPullRequestMeta(item);
      return parsed ? [parsed] : [];
    });
    const filtered = existing.filter((item) => item.url !== summary.url);
    const updated = [...filtered, summary];

    await this.repo.upsertDocMeta(this.roomId, {
      pullRequests: updated,
    });
  }

  async updateHistory(updateFn: (history: SessionHistoryInput[]) => SessionHistoryInput[]) {
    if (!this.mirror) {
      throw new Error('Mirror not initialized');
    }
    let attemptedTail: Record<string, unknown> | null = null;
    try {
      this.mirror.setState((prev) => {
        const nextHistory = updateFn((prev.history as SessionHistoryInput[]) || []);
        attemptedTail = this.summarizeHistoryTailForDiagnostics(nextHistory);
        // @ts-ignore
        prev.history = nextHistory;
        return prev;
      });
    } catch (error) {
      const detail =
        error instanceof Error
          ? (error.stack ?? error.message)
          : error
            ? String(error)
            : 'Unknown error';
      this.logger.error(`[${this.sessionId}] Failed to update history: ${detail}`);
      if (attemptedTail) {
        this.logger.error(
          `[${this.sessionId}] Attempted history tail diagnostics: ${JSON.stringify(attemptedTail)}`
        );
      }
      void captureMessage('Failed to update session history', {
        component: 'loro-doc',
        level: 'error',
        extra: {
          sessionId: this.sessionId,
          ...(attemptedTail ?? {}),
        },
      });
      throw error;
    }
  }

  /**
   * Append a user turn and publish its dispatch pointer as ONE operation.
   *
   * Both writes are a single fact — "this turn is waiting to run" — split across
   * two documents, because the pointer lives in workspace meta (the activation
   * index startup scans) and so cannot be derived from history. Pairing them by
   * convention leaves every producer one forgotten line from a turn that runs
   * without advancing `latestUserMsgId`; see `../../session/AGENTS.md` for what
   * that costs. History is written first so the content lands before the pointer
   * that advertises it, and `lastMissingHistoryUserMsgId` is left alone: clearing
   * it belongs to producers that first supersede the acknowledged entry.
   */
  async appendUserTurn(entry: SessionHistoryInput): Promise<void> {
    if (entry.role !== 'user') {
      throw new Error(
        `appendUserTurn requires a user entry, received role "${entry.role}" for ${entry.id}`
      );
    }
    await this.updateHistory((history) => [...history, entry]);
    await this.repo.upsertDocMeta(this.roomId, {
      latestUserMsgId: entry.id,
    } satisfies Partial<SessionMeta>);
  }

  private summarizeHistoryTailForDiagnostics(
    history: SessionHistoryInput[]
  ): Record<string, unknown> {
    const last = history.length > 0 ? history[history.length - 1] : undefined;
    const lastItems = last && Array.isArray(last.items) ? (last.items as unknown[]) : [];

    const summarizeValue = (value: unknown): Record<string, unknown> => {
      if (value === null) return { type: 'null' };
      if (Array.isArray(value)) return { type: 'array', length: value.length };
      if (typeof value === 'string') return { type: 'string', length: value.length };
      if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).slice(0, 20);
        const keyTypes: Record<string, string> = {};
        for (const k of keys) {
          const v = record[k];
          keyTypes[k] = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
        }
        return { type: 'object', keys: keys.length, keyTypes };
      }
      return { type: typeof value };
    };

    const tailItems = lastItems.slice(-3).map((item) => {
      if (!item || typeof item !== 'object') {
        return { itemType: 'non_object' };
      }
      const record = item as Record<string, unknown>;
      const keys = Object.keys(record).slice(0, 20);
      const fieldSummaries: Record<string, Record<string, unknown>> = {};
      for (const key of keys) {
        fieldSummaries[key] = summarizeValue(record[key]);
      }
      return {
        type: typeof record.type === 'string' ? record.type : 'unknown',
        keys: keys.length,
        fields: fieldSummaries,
      };
    });

    return {
      historyEntries: history.length,
      lastEntry: last
        ? {
            id: last.id,
            role: last.role,
            timestamp: last.timestamp,
            items: lastItems.length,
            tailItems,
          }
        : null,
    };
  }

  getLatestAssistantHistory(): SessionHistoryInput | null {
    if (!this.mirror) {
      throw new Error('Mirror not initialized');
    }
    const history = (this.mirror.getState().history as SessionHistoryInput[]) || [];
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i]!;
      if (entry.role === 'assistant') {
        return entry;
      }
    }
    return null;
  }

  /**
   * Directly set a field on a history entry using loro-crdt API.
   * This is more efficient than using `updateHistory` for simple field updates
   * because it avoids the overhead of loro-mirror's setState.
   *
   * @param historyId - The id of the history entry to update
   * @param field - The field name to set
   * @param value - The value to set
   * @returns true if the entry was found and updated, false otherwise
   */
  setHistoryEntryField(
    historyId: string,
    field: 'fileDiff',
    value: FileDiff[] | undefined
  ): boolean;
  setHistoryEntryField(
    historyId: string,
    field: 'modelInfo',
    value: ModelInfo | undefined
  ): boolean;
  setHistoryEntryField(
    historyId: string,
    field: 'fileDiff' | 'modelInfo',
    value: FileDiff[] | ModelInfo | undefined
  ): boolean {
    if (!this.handle) {
      throw new Error('SessionDocument not initialized');
    }

    const doc = this.handle.doc;
    const historyList = doc.getList('history') as LoroList<LoroMap>;
    const length = historyList.length;

    for (let i = length - 1; i >= 0; i--) {
      const entry = historyList.get(i) as LoroMap | undefined;
      if (!entry) continue;

      const entryId = entry.get('id') as string | undefined;
      if (entryId === historyId) {
        // Raw LoroMap writes bypass loro-mirror's undefined-stripping:
        // `set(field, undefined)` persists null, which breaks strict readers.
        // Deleting the key is the correct "unset" for these optional fields.
        if (value === undefined) {
          entry.delete(field);
        } else {
          entry.set(field, value as LoroMapSetValue);
        }
        doc.commit();
        return true;
      }
    }

    return false;
  }

  /**
   * Set the fileDiff field on the latest assistant history entry, optionally filtered by turn ID.
   * This is more efficient than using `updateHistory` for simple field updates.
   *
   * @param fileDiff - The file diff data to set
   * @param turnId - Optional: the turn ID (history entry ID) of the assistant entry to update.
   *                 A turn is a single message in a conversation, regardless of role.
   *                 See specs/data-model.md for the definition of "turn".
   * @returns true if an entry was found and updated, false otherwise
   */
  setLatestAssistantHistoryFileDiff(fileDiff: FileDiff[] | undefined, turnId?: string): boolean {
    if (!this.handle) {
      throw new Error('SessionDocument not initialized');
    }

    const doc = this.handle.doc;
    const historyList = doc.getList('history') as LoroList<LoroMap>;
    const length = historyList.length;

    // Search from the end for the matching assistant entry
    for (let i = length - 1; i >= 0; i--) {
      const entry = historyList.get(i) as LoroMap | undefined;
      if (!entry) continue;

      const role = entry.get('role') as string | undefined;
      if (role !== 'assistant') continue;

      // If turnId is specified, only update the entry with matching ID
      if (turnId) {
        const entryId = entry.get('id') as string | undefined;
        if (entryId !== turnId) continue;
      }

      // See setHistoryEntryField: undefined must delete, not persist null.
      if (fileDiff === undefined) {
        entry.delete('fileDiff');
      } else {
        entry.set('fileDiff', fileDiff as LoroMapSetValue);
      }
      doc.commit();
      return true;
    }

    return false;
  }

  /** Return stable persisted ordering metadata for one assistant turn. */
  getAssistantHistoryEntryTurnStorageMetadata(
    turnId: string
  ): { readonly capturedAtMs: number; readonly orderKey: string } | undefined {
    if (!this.handle) {
      throw new Error('SessionDocument not initialized');
    }

    const historyList = this.handle.doc.getList('history') as LoroList<LoroMap>;
    for (let index = historyList.length - 1; index >= 0; index -= 1) {
      const entry = historyList.get(index) as LoroMap | undefined;
      if (!entry || entry.get('role') !== 'assistant' || entry.get('id') !== turnId) continue;
      const userTurnId = entry.get('userTurnId');
      let timestamp = entry.get('timestamp');
      if (typeof userTurnId === 'string') {
        for (let userIndex = index - 1; userIndex >= 0; userIndex -= 1) {
          const userEntry = historyList.get(userIndex) as LoroMap | undefined;
          if (userEntry?.get('role') !== 'user' || userEntry.get('id') !== userTurnId) continue;
          timestamp = userEntry.get('timestamp');
          break;
        }
      }
      if (typeof timestamp !== 'string') return undefined;
      const capturedAtMs = Date.parse(timestamp);
      if (!Number.isSafeInteger(capturedAtMs) || capturedAtMs < 0) return undefined;
      return {
        capturedAtMs,
        orderKey: `${capturedAtMs.toString().padStart(16, '0')}:${this.sessionId}:${index
          .toString()
          .padStart(10, '0')}:${turnId}`,
      };
    }
    return undefined;
  }

  /**
   * Set the plan on the latest assistant entry in history.
   * Plan is now stored per-turn on each history entry, not at the root level.
   */
  async setPlan(entries: SessionPlanEntry[]) {
    if (!this.mirror) {
      throw new Error('Mirror not initialized');
    }
    this.mirror.setState((prev) => {
      const history = (prev.history as SessionHistoryInput[]) || [];
      // Find the latest assistant entry
      for (let i = history.length - 1; i >= 0; i--) {
        const entry = history[i];
        if (entry && entry.role === 'assistant') {
          entry.plan = entries;
          break;
        }
      }
      return prev;
    });
  }

  async getMessageQueue(): Promise<MessageQueueItem[]> {
    if (!this.mirror) {
      return [];
    }
    return (this.mirror.getState().mq ?? []) as MessageQueueItem[];
  }

  async popMessageQueue(): Promise<MessageQueueItem | null> {
    if (!this.mirror) {
      return null;
    }

    const queue = (this.mirror.getState().mq ?? []) as MessageQueueItem[];
    if (queue.length === 0) {
      return null;
    }

    const first = queue[0];
    if (first?.isEditing) {
      // The editing client may never get a chance to clear `isEditing` (hard close,
      // crash, killed tab). Treat `editingStartedAt` as a lease; once it expires we
      // dispatch the message anyway so the queue can't get stuck forever. A missing
      // `editingStartedAt` (e.g. items written by older clients) is treated as expired.
      const startedAt = first.editingStartedAt ?? 0;
      const editingAge = getServerNow() - startedAt;
      if (editingAge < EDITING_LEASE_MS) {
        return null;
      }
    }

    this.mirror.setState((prev) => {
      const mq = (prev.mq ?? []) as MessageQueueItem[];
      // @ts-ignore
      prev.mq = mq.slice(1);
      return prev;
    });

    return first ?? null;
  }

  async pushMessageQueue(item: Omit<MessageQueueItem, '$cid'>): Promise<void> {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }

    this.mirror.setState((prev) => {
      const mq = (prev.mq ?? []) as MessageQueueItem[];
      // @ts-ignore - mq is read-only in type but writable at runtime
      prev.mq = [...mq, item];
      return prev;
    });
  }

  async removeMessageQueueItem(cid: string): Promise<void> {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }

    this.mirror.setState((prev) => {
      const mq = (prev.mq ?? []) as MessageQueueItem[];
      // @ts-ignore - mq is read-only in type but writable at runtime
      prev.mq = mq.filter((item: MessageQueueItem) => item.$cid !== cid);
      return prev;
    });
  }

  /**
   * Replace the fields of the message-queue item identified by `$cid`. The
   * caller supplies the fully-resolved next field set (the renderer resolves its
   * updater function to a concrete value before sending the intent), so this is a
   * full replacement of the item's non-`$cid` fields — matching the single-author
   * write-intent contract (`session-mq-update`).
   */
  async updateMessageQueueItem(cid: string, patch: Partial<MessageQueueItem>): Promise<void> {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    this.mirror.setState((prev) => {
      const mq = (prev.mq ?? []) as MessageQueueItem[];
      // @ts-ignore - mq is read-only in type but writable at runtime
      prev.mq = mq.map((item: MessageQueueItem) =>
        item.$cid === cid ? ({ ...item, ...patch, $cid: item.$cid } as MessageQueueItem) : item
      );
      return prev;
    });
  }

  /**
   * Reorder the message queue to the given `$cid` order. `orderedCids` is the full
   * resulting order from the renderer (`session-mq-reorder`); items whose `$cid`
   * is absent from the list are dropped to the end in their existing relative
   * order (defensive — the renderer always sends the complete set).
   */
  async reorderMessageQueue(orderedCids: readonly string[]): Promise<void> {
    if (!this.mirror) {
      throw new Error('SessionDocument not initialized');
    }
    this.mirror.setState((prev) => {
      const mq = (prev.mq ?? []) as MessageQueueItem[];
      const byCid = new Map(mq.map((item) => [item.$cid, item] as const));
      const ordered: MessageQueueItem[] = [];
      for (const cid of orderedCids) {
        const item = byCid.get(cid);
        if (item) {
          ordered.push(item);
          byCid.delete(cid);
        }
      }
      for (const item of mq) {
        if (item.$cid !== undefined && byCid.has(item.$cid)) {
          ordered.push(item);
        }
      }
      // @ts-ignore - mq is read-only in type but writable at runtime
      prev.mq = ordered;
      return prev;
    });
  }

  async destroy(options: { preserveStatus?: boolean } = {}) {
    if (!this.mirror) {
      return;
    }

    this.destroyed = true;

    this.historyAutoReadHandle?.dispose();
    this.historyAutoReadHandle = null;

    const status = await this.getStatus();
    if (
      !options.preserveStatus &&
      (status?.type === 'running' ||
        status?.type === 'requestPermission' ||
        status?.type === 'initializing')
    ) {
      await this.setStatus(SessionStatusFactory.idle());
    }
    // Release the repo room BEFORE evicting the doc. loro-repo binds the
    // `LoroDoc` instance into a room's transport attachment once, at attach
    // time, and `unloadDoc` does not detach rooms — so unloading first leaves
    // every still-attached transport (the cloud one included) syncing the
    // orphan. Rooms are ref-counted, so if any other holder keeps this room
    // open that binding never re-attaches and is stranded permanently.
    // Nothing is lost by releasing first: `setStatus` above writes through
    // `repo.upsertDocMeta`, i.e. the meta room, not this doc's room.
    this.docSub?.unsubscribe();
    this.docSub = null;
    this.docBinding = null;
    await this.unloadDocRoom(this.roomId);
    this.detachDocRoomStatusListener?.();
    this.detachDocRoomStatusListener = null;
    this.docRoomStatusListeners.clear();
    this.mirror?.dispose();
    this.mirror = null;
    this.handle = null;
  }
}

const getAliveDocMeta = async <Meta>(repo: LoroRepo, roomId: string): Promise<Meta | undefined> => {
  const meta = await repo.getDocMeta(roomId);
  if (!meta || isLoroRepoDocDeleted(meta)) return undefined;
  return meta.meta as Meta | undefined;
};

type MachineMetaPatch = Partial<MachineMeta> & Pick<MachineMeta, 'id'>;

const serializeAcpCapabilityWithoutFetchTime = (entry: AcpCapabilityCacheEntry): string =>
  JSON.stringify({
    cliType: entry.cliType,
    agentType: entry.agentType,
    cacheVersion: entry.cacheVersion,
    provenance: entry.provenance,
    sourceVersion: entry.sourceVersion,
    modes: entry.modes,
    models: entry.models,
    configOptions: entry.configOptions,
    modelReasoningEfforts: entry.modelReasoningEfforts,
    availableCommands: entry.availableCommands,
    sessionFork: entry.sessionFork,
    acknowledgedSteer: entry.acknowledgedSteer,
    sessionForkWorktree: entry.sessionForkWorktree,
  });

export class MachineDocument implements LoroDocument<{}, MachineMeta> {
  roomId: string;
  handle: RepoDocHandle | null = null;
  private rateLimitsUpdateQueue: Promise<void> = Promise.resolve();

  constructor(
    private repo: LoroRepo,
    private workspaceId: WorkspaceId,
    private machineId: MachineId,
    private markMachineFlockDirty?: (reason: string) => void
  ) {
    this.roomId = getMachineRoomId(this.machineId);
  }

  async setMetaState(meta: MachineMetaPatch) {
    await this.upsertMeta(meta);
  }

  private async upsertMeta(meta: MachineMetaPatch): Promise<void> {
    await this.repo.upsertDocMeta(this.roomId, meta as Parameters<LoroRepo['upsertDocMeta']>[1]);
  }

  async init() {
    // Machine online/offline state is tracked through heartbeat timestamps.
  }

  async destroy() {
    // No cleanup needed
  }

  async getMetaState(): Promise<MachineMeta | undefined> {
    return await getAliveDocMeta<MachineMeta>(this.repo, this.roomId);
  }

  async getDocState() {
    return undefined;
  }

  private openMachineFlockDoc() {
    return this.repo.openFlockDoc(getMachineFlockDocId(this.workspaceId, this.machineId));
  }

  private enqueueRateLimitsUpdate<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.rateLimitsUpdateQueue.then(() => operation());
    this.rateLimitsUpdateQueue = current.then(
      () => undefined,
      () => undefined
    );
    return current;
  }

  async updateRateLimits(cliType: CliType, limits: RateLimit): Promise<void> {
    return this.enqueueRateLimitsUpdate(async () => {
      const limitId = ((limits as { limitId?: string }).limitId ?? cliType).trim() || cliType;
      const handle = await this.openMachineFlockDoc();
      const changed = writeMachineFlockRowToFlock(handle.flock, {
        key: machineFlockKeys.rateLimit(cliType, limitId),
        value: limits,
      });
      if (changed) {
        await this.repo.flush();
        if (this.markMachineFlockDirty) {
          this.markMachineFlockDirty('rate-limit-update');
        } else {
          await handle.syncOnce().catch(() => undefined);
        }
      }
    });
  }

  async updateAcpCapabilities(
    configId: AgentConfigId,
    cliType: AgentConfigCliType,
    agentType: string,
    modes: AcpModeSummary[],
    models: AcpModelSummary[],
    configOptions: AcpConfigOptionSummary[] | undefined,
    availableCommands: AcpCommandSummary[] | undefined,
    sessionFork: boolean,
    sourceVersion: string,
    modelReasoningEfforts?: Record<string, string[]>,
    acknowledgedSteer = false,
    options: { signal?: AbortSignal } = {}
  ): Promise<AcpCapabilityCacheEntry> {
    options.signal?.throwIfAborted();
    const normalizedModes = modes.map((mode) => ({
      id: mode.id,
      name: mode.name,
      description: mode.description ?? undefined,
    }));
    const normalizedModels = models.map((model) => ({
      modelId: model.modelId,
      name: model.name ?? model.modelId,
      description: model.description ?? undefined,
    }));
    const entry: AcpCapabilityCacheEntry = {
      cliType,
      agentType,
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
      provenance: 'runtime',
      sourceVersion,
      modes: normalizedModes,
      models: normalizedModels,
      configOptions: configOptions?.length ? configOptions : undefined,
      availableCommands: availableCommands?.length ? availableCommands : undefined,
      sessionFork,
      acknowledgedSteer,
      sessionForkWorktree: sessionFork,
      modelReasoningEfforts:
        modelReasoningEfforts && Object.keys(modelReasoningEfforts).length > 0
          ? modelReasoningEfforts
          : undefined,
      fetchedAt: getServerNow(),
    };
    const handle = await this.openMachineFlockDoc();
    options.signal?.throwIfAborted();
    const capabilityKey = getAcpCapabilityCacheKey(configId);
    const existing = getMachineFlockAcpCapabilities(
      readMachineFlockRowsFromFlock(handle.flock, { families: ['acpCapability'] })
    )[capabilityKey];
    if (
      existing &&
      serializeAcpCapabilityWithoutFetchTime(existing) ===
        serializeAcpCapabilityWithoutFetchTime(entry)
    ) {
      return existing;
    }
    options.signal?.throwIfAborted();
    const changed = writeMachineFlockRowToFlock(handle.flock, {
      key: machineFlockKeys.acpCapability(configId),
      value: entry,
    });
    if (changed) {
      await this.repo.flush();
      if (this.markMachineFlockDirty) {
        this.markMachineFlockDirty('acp-capability-update');
      } else {
        await handle.syncOnce().catch(() => undefined);
      }
    }
    return entry;
  }

  async getAcpCapabilities(configId: AgentConfigId): Promise<AcpCapabilityCacheEntry | undefined> {
    const key = getAcpCapabilityCacheKey(configId);
    const handle = await this.openMachineFlockDoc();
    const flockCapabilities = getMachineFlockAcpCapabilities(
      readMachineFlockRowsFromFlock(handle.flock, { families: ['acpCapability'] })
    );
    return flockCapabilities[key];
  }
}
