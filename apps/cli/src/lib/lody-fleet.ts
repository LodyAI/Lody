import { worktreeGitLegacy } from '@/session/worktree/git-execution-legacy';
import type {
  LocalE2eePairingRequest,
  LocalE2eePrepareResponse,
  LocalE2eeActivateResponse,
} from '@lody/shared/e2ee-local-pairing';
import { workspaceSupports } from '@lody/shared/workspace-streams-content';
import { initCliAnalytics } from '@/lib/analytics/posthog';
import { ensureImplicitLocalWorkspace } from '@/lib/cli-platform';
import { CliRuntimeStateReporter } from '@/lib/cli-runtime-state';
import { WorkspaceWatchCoordinator } from '@/lib/code-collab/workspace-watch-coordinator';
import { listAliveSessionMetas } from '@/lib/command-runtime';
import {
  startLocalIpcSocketServers,
  stopLocalIpcSocketServers,
} from '@/lib/local-ipc-socket-server';
import {
  startLocalLoroDataPlaneServer,
  stopLocalLoroDataPlaneServer,
} from '@/lib/local-loro-data-plane-server';
import type { LocalProbeConfig } from '@/lib/local-probe';
import {
  LocalProjectControlService,
  LocalProjectCreateDirectoryError,
} from '@/lib/local-project-control-service';
import { LocalProjectHistorySyncService } from '@/lib/local-project-history-sync-service';
import {
  readMachineLocalProjects,
  reconcileMachineLocalProjectRootPaths,
  removeMachineLocalProject,
  resolveWorkspaceLocalProject,
  resolveWorkspaceLocalProjectRootPath,
  resolveWorkspaceLocalProjectRootPathWithRetry,
  resolveWorkspaceLocalProjectWithSyncOnMiss,
  upsertMachineLocalProject,
  readLocalProjectRootResolveSyncTimeoutMs,
} from '@/lib/local-project-meta';
import { preflightLocalProjectWorktreeRemoval } from '@/lib/local-project-removal';
import type { LocalSessionControlConfig } from '@/lib/local-session-control';
import { startLocalTerminalServer, stopLocalTerminalServer } from '@/lib/local-terminal-server';
import {
  localCatalogWorkspaceToWorkspaceListItem,
  makeLocalWorkspaceCatalog,
  type LocalWorkspaceCatalogService,
  type LocalWorkspaceCatalogSnapshot,
} from '@/lib/local-workspace-catalog';
import { Lody } from '@/lib/lody';
import { readTimeoutEnv } from '@/lib/loro/timeout-utils';
import type { MachineProcessLifecycleAction } from '@/lib/machine-lifecycle';
import { loadPrPollerConfig } from '@/lib/pr-poller/pr-poller-config';
import { PrPollerStateStore } from '@/lib/pr-poller/pr-poller-state';
import {
  createLodyPrPollerWorkspace,
  type PrPollerWorkspaceHandle,
} from '@/lib/pr-poller/pr-poller-workspace';
import { makePrStatusPoller, type PrStatusPollerShape } from '@/lib/pr-poller/pr-status-poller';
import { RemoteBridge } from '@/lib/remote-bridge';
import { makeTerminalPtyService, type TerminalPtyServiceApi } from '@/lib/terminal-pty-service';
import {
  resolveTerminalWorkdirFromMetadata,
  type TerminalSessionMetaLookup,
} from '@/lib/terminal-workdir-resolver';
import { findWorkspacesBySelector, formatWorkspaceCandidate } from '@/lib/workspace-selector';
import { startLodyMcpHttpServer, stopLodyMcpHttpServer } from '@/mcp/lody-mcp-http-server';
import { MemoryPressureSampler } from '@/monitor/memory-pressure-sampler';
import pkg from '@/pkg';
import {
  deleteLocalProjectWorktreeSetup,
  handleLocalProjectWorktreeConfigRequest,
  isLocalProjectWorktreeConfigRequest,
} from '@/session/worktree/worktree-setup-config-store';
import { formatErrorMessage } from '@/utils/format-error';
import { Logger } from '@/utils/logger';
import { traceAsync } from '@/utils/trace-span';
import type { CloudAccessSnapshot, CloudPort } from '@lody/platform';
import {
  CliType,
  MachineId,
  WorkspaceId,
  getServerNow,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  startTimeSyncLegacy,
  type CliRuntimeConnectivity,
  type CliRuntimeWorkspace,
  type LocalProjectControlErrorCode,
  type LocalProjectControlRequest,
  type LocalProjectControlResponse,
  type LocalProjectId,
  type LocalSessionControlRequest,
  type LocalSessionControlResponse,
  type MachineLifecycleCapability,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import type { LocalLoroDataPlaneServerLegacy } from '@lody/shared/local-loro-data-plane-server';
import { Effect } from 'effect';
import { AgentExecutionSlots } from './agent-execution-slots';
import {
  createScheduleWorkspace,
  type ScheduleWorkspaceHandle,
} from './schedules/schedule-workspace';
import { workspaceCleanupOwnerLegacy } from './workspace-cleanup-legacy';

const FLEET_RUNTIME_STATE_INTERVAL_MS = 2_000;
const FLEET_REMOTE_BRIDGE_OFFLINE_GRACE_MS = 15_000;
const FLEET_RECONCILE_RETRY_INITIAL_DELAY_MS = 5_000;
const FLEET_RECONCILE_RETRY_MAX_DELAY_MS = 5 * 60_000;
const FLEET_WORKSPACE_START_CONCURRENCY = 4;

export function syncCliServerTime(logger: Logger, serverUrl: string) {
  return startTimeSyncLegacy(`${serverUrl}/api/time`, () => {
    logger.debug('Time synchronization unavailable; retaining the previous calibration.');
  });
}

type WorkspaceListItem = {
  id: string;
  name: string;
  slug: string | null;
  role: string;
  contentMode?: string;
  genesisHash?: string;
};

type AuthorizedWorkspaceList = Extract<CloudAccessSnapshot, { status: 'authorized' }>;

type WorkspaceRuntimeState = {
  workspace: WorkspaceListItem;
  lody: Lody;
  unsubscribeTerminalCleanup: () => void;
  prPollerWorkspace: PrPollerWorkspaceHandle | null;
  schedules: ScheduleWorkspaceHandle;
  localProjectReconciliation?: { stop: AbortController; done: Promise<void> };
  cleanupOwner?: ReturnType<typeof workspaceCleanupOwnerLegacy>;
  cleanupReceipt?: Promise<void>;
  cleanupFailure?: unknown;
  cleanupCauses?: unknown[];
};

export class LodyFleet {
  private readonly logger: Logger;
  private readonly builtinAgentConfigCliTypes: CliType[];
  private readonly supportRegistryAgentTypes: string[];
  private readonly cliToken: string;
  private readonly userId: string;
  private readonly machineId: MachineId;
  private readonly machineName: string;
  private readonly localProjectControlService: LocalProjectControlService;
  private readonly localWorkspaceCatalog: LocalWorkspaceCatalogService;
  private readonly remoteBridge: RemoteBridge | null;
  private readonly cloudPort: CloudPort;
  private readonly runtimeStateReporter: CliRuntimeStateReporter;
  private readonly terminalPtyService: TerminalPtyServiceApi;
  private readonly memoryPressure: MemoryPressureSampler;
  private readonly onFatalAuthFailure?: (error: Error) => void;
  private readonly localPlatform: boolean;
  private readonly localFirstBootstrap: boolean;
  private readonly onProcessLifecycleAction?: (action: MachineProcessLifecycleAction) => void;
  private readonly startupTimeSync?: Promise<void>;
  private readonly machineLifecycleCapability: MachineLifecycleCapability;
  private readonly prStatusPoller: PrStatusPollerShape;
  private readonly workspaceWatchCoordinator: WorkspaceWatchCoordinator;

  private readonly runtimes = new Map<string, WorkspaceRuntimeState>();
  private readonly startInFlight = new Map<string, Promise<void>>();
  private readonly e2eeActivationInFlight = new Map<string, Promise<void>>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly desiredWorkspaces = new Map<string, WorkspaceListItem>();
  private readonly waitingForPairing = new Set<string>();
  private readonly remoteRevokedWorkspaceIds = new Set<string>();

  private unsubscribeWorkspaces: (() => void) | null = null;
  private stopped = false;
  private shutdownReceipt: Promise<void> | undefined;
  private shutdownRecovery: Promise<void> | undefined;
  private localServiceReleaseFailure: unknown;
  private globalShutdownReceipt: Promise<void> | undefined;
  private readonly cleanupOwners = new Map<string, WorkspaceRuntimeState>();
  private readonly startupCleanupOwners = new Map<
    string,
    { run(): Promise<void>; retry(): Promise<void> }
  >();
  private runtimeStateTimer: NodeJS.Timeout | null = null;
  private hasWorkspaceRetryIssue = false;
  private hasControlOfflineIssue = false;
  private hasControlReconnectingIssue = false;
  private lastConnectivity: CliRuntimeConnectivity | null = null;
  private invalidTokenReported = false;
  private lastCachedWorkspaceSignature: string | null = null;
  private remoteBridgeOfflineTimer: NodeJS.Timeout | null = null;
  // Last valid workspace list, retried after an apply/reconcile failure. The
  // Convex subscription only re-fires on actual list changes, so without this a
  // one-off reconcile failure (e.g. a catalog write error) could leave the fleet
  // permanently un-reconciled / un-attached.
  private lastValidWorkspaceListResult: AuthorizedWorkspaceList | null = null;
  private reconcileRetryTimer: NodeJS.Timeout | null = null;
  private reconcileRetryDelayMs = 0;

  constructor(options: {
    logger: Logger;
    builtinAgentConfigCliTypes: CliType[];
    supportRegistryAgentTypes?: string[];
    cliToken: string;
    userId: string;
    machineId: MachineId;
    machineName: string;
    runtimeStateReporter: CliRuntimeStateReporter;
    localWorkspaceCatalog?: LocalWorkspaceCatalogService;
    cloudPort: CloudPort;
    localFirstBootstrap?: boolean;
    startupTimeSync?: Promise<void>;
    machineLifecycleCapability: MachineLifecycleCapability;
    onFatalAuthFailure?: (error: Error) => void;
    onProcessLifecycleAction?: (action: MachineProcessLifecycleAction) => void;
  }) {
    this.logger = options.logger;
    this.builtinAgentConfigCliTypes = options.builtinAgentConfigCliTypes;
    this.supportRegistryAgentTypes = options.supportRegistryAgentTypes ?? [];
    this.cliToken = options.cliToken;
    this.userId = options.userId;
    this.machineId = options.machineId;
    this.machineName = options.machineName;
    this.cloudPort = options.cloudPort;
    if (this.cloudPort.identity.userId !== this.userId) {
      throw new Error(
        `CloudPort identity ${this.cloudPort.identity.userId} does not match Fleet identity ${this.userId}`
      );
    }
    this.runtimeStateReporter = options.runtimeStateReporter;
    this.machineLifecycleCapability = options.machineLifecycleCapability;
    this.onFatalAuthFailure = options.onFatalAuthFailure;
    this.localWorkspaceCatalog = options.localWorkspaceCatalog ?? makeLocalWorkspaceCatalog();
    this.memoryPressure = new MemoryPressureSampler(this.logger);
    this.remoteBridge = this.cloudPort.streamsTokens
      ? new RemoteBridge({
          logger: this.logger,
          catalog: this.localWorkspaceCatalog,
          userId: this.userId,
          machineId: this.machineId,
          machineName: this.machineName,
          getRuntime: (workspaceId) => this.runtimes.get(workspaceId)?.lody,
        })
      : null;
    this.localPlatform = this.cloudPort.kind === 'local';
    // The local platform has no cloud reconcile: the catalog bootstrap is the
    // only workspace source, so it is unconditionally on.
    this.localFirstBootstrap =
      this.localPlatform ||
      (options.localFirstBootstrap ?? process.env.LODY_LOCAL_FIRST_BOOTSTRAP !== '0');
    this.startupTimeSync = options.startupTimeSync;
    this.onProcessLifecycleAction = options.onProcessLifecycleAction;
    this.localProjectControlService = new LocalProjectControlService(this.logger);
    this.terminalPtyService = makeTerminalPtyService({
      logger: this.logger,
      resolveSessionWorkdir: async (sessionId) =>
        await this.resolveTerminalSessionWorkdir(sessionId),
    });
    this.prStatusPoller = makePrStatusPoller({
      config: loadPrPollerConfig(),
      stateStore: new PrPollerStateStore({ logger: this.logger }),
      logger: this.logger,
    });
    this.workspaceWatchCoordinator = new WorkspaceWatchCoordinator(this.logger);
  }

  async start(): Promise<void> {
    if (this.cloudPort.usage) {
      // Start the analytics poster before any events fire (idempotent; no-op
      // without a key). Local platform: telemetry is off by contract (D-O12).
      initCliAnalytics();
    }
    this.memoryPressure.start();
    // Await the first calibration attempt before time-sensitive operations (heartbeats, unread
    // detection). Local platform: no time server; getServerNow() falls back to
    // the local clock.
    if (this.startupTimeSync) {
      this.runtimeStateReporter.setStartupStage('sync-time');
      await this.startupTimeSync;
    }

    const localProbeConfig: LocalProbeConfig = {
      machineId: this.machineId,
      cliVersion: pkg.version,
      logger: this.logger,
      getRuntimeState: () => this.runtimeStateReporter.snapshot(),
    };

    this.runtimeStateReporter.setStartupStage('fleet-start');
    const localControlConfig: LocalSessionControlConfig = {
      machineId: this.machineId,
      logger: this.logger,
      dispatchSession: async (message, options) =>
        await this.dispatchLocalSessionControl(message, options),
      dispatchProject: async (message) => await this.dispatchLocalProjectControl(message),
      dispatchE2eePairing: (message) => this.dispatchLocalE2eePairing(message),
      dispatchSchedule: async (message) => {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId as WorkspaceId);
        const { executeScheduleCommand } = await import('./schedules/schedule-command-service');
        try {
          const result = await executeScheduleCommand(
            {
              manager: runtime.lody.documentManager,
              workspace: runtime.workspace,
              auth: {
                token: this.cliToken,
                userId: this.userId,
                userName: '',
                userEmail: '',
                machineId: this.machineId,
                machineName: this.machineName,
              },
              localOnly: this.localPlatform,
              requesterSessionId: message.requesterSessionId as SessionId | undefined,
            },
            message.command
          );
          return { ok: true, result };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Schedule command failed',
          };
        }
      },
      dispatchMachineRpc: async (message) => await this.dispatchLocalMachineRpc(message),
    };
    await traceAsync(this.logger, 'startup.local_ipc', undefined, async () => {
      await startLocalIpcSocketServers({
        probe: localProbeConfig,
        control: localControlConfig,
        version: pkg.version,
      });
    });
    await Promise.all([
      traceAsync(this.logger, 'startup.local_terminal', undefined, async () => {
        await startLocalTerminalServer({
          logger: this.logger,
          terminalPtyService: this.terminalPtyService,
        });
      }),
      traceAsync(this.logger, 'startup.local_data_plane', undefined, async () => {
        await startLocalLoroDataPlaneServer({
          logger: this.logger,
          getWorkspaceServer: (workspaceId) => this.getWorkspaceLoroDataPlaneServer(workspaceId),
        });
      }),
      traceAsync(this.logger, 'startup.mcp_http', undefined, async () => {
        // Never fatal: on failure agents keep the per-session stdio MCP entry.
        await startLodyMcpHttpServer({ logger: this.logger });
      }),
    ]);

    // Start the PR poller BEFORE any workspace runtime can connect: the
    // local-first catalog bootstrap below registers each workspace with the
    // poller as it connects, and registration on a not-yet-started poller is
    // dropped (regression: a freshly restarted daemon polled nothing because
    // all local-catalog workspaces registered before the poller started).
    // Repository reads use local credentials even without hosted integration.
    Effect.runSync(this.prStatusPoller.start);

    if (this.localPlatform) {
      // D-O14: the single implicit workspace is provisioned before bootstrap
      // so a first run and a restart take the same path.
      await traceAsync(this.logger, 'startup.local_workspace_provision', undefined, async () => {
        await ensureImplicitLocalWorkspace({
          catalog: this.localWorkspaceCatalog,
          identity: { userId: this.userId, createdAt: new Date(getServerNow()).toISOString() },
          machineId: this.machineId,
          machineName: this.machineName,
          logger: this.logger,
        });
      });
    }

    if (this.localFirstBootstrap) {
      await traceAsync(this.logger, 'startup.local_catalog_bootstrap', undefined, async () => {
        await this.bootstrapFromLocalCatalog();
      });
      this.runtimeStateReporter.setStartupStage('ready');
      this.refreshRuntimeState();
      this.startRuntimeStateLoop();
    }

    if (this.localPlatform) {
      // Zero cloud I/O: no Convex client, no workspace subscription, no remote
      // bridge attach. The catalog bootstrap above is the entire workspace
      // lifecycle.
      return;
    }

    await traceAsync(
      this.logger,
      'startup.workspace_subscription',
      { waitForInitial: !this.localFirstBootstrap },
      async () =>
        await this.startWorkspaceSubscription({ waitForInitial: !this.localFirstBootstrap })
    );
  }

  private async bootstrapFromLocalCatalog(): Promise<void> {
    let snapshot: LocalWorkspaceCatalogSnapshot;
    try {
      snapshot = await Effect.runPromise(this.localWorkspaceCatalog.read());
    } catch (error) {
      if (this.localPlatform) {
        throw new Error(
          `[fleet] Local workspace catalog is unavailable: ${formatErrorMessage(error)}`,
          { cause: error }
        );
      }
      // Missing/corrupt catalogs already self-recover inside read(); anything
      // that still fails here (e.g. a permission error in the installation data root) must not
      // take the daemon down — skip the local-first bootstrap and let the
      // Convex subscription drive the workspace list instead.
      this.logger.warn(
        `[fleet] Skipping local catalog bootstrap (catalog unreadable): ${formatErrorMessage(error)}`
      );
      return;
    }

    // The catalog was written under the identity of the last reconciled login.
    // After an account switch none of it may be booted for the current user:
    // starting another account's cached workspaces would serve their local data
    // plane and leave ghost runtimes running (the remote reconcile only marks
    // them remote_missing; it does not stop retained runtimes).
    if (snapshot.identity?.userId !== this.userId) {
      this.logger.debug(
        '[fleet] Local workspace catalog identity does not match the current user; skipping local-first bootstrap'
      );
      return;
    }

    if (snapshot.encryptedCatalogError || snapshot.encryptedCatalogUnavailable) {
      this.logger.warn(
        '[fleet] Encrypted workspace catalog unavailable; ordinary cached workspaces remain usable.'
      );
      this.runtimeStateReporter.upsertIssue({
        code: 'encrypted_workspace_catalog_unavailable',
        severity: 'warning',
        recoverable: true,
        message:
          'Encrypted workspace cache is unavailable. Its files have been preserved; retry after local storage recovers.',
      });
    } else {
      this.runtimeStateReporter.clearIssue('encrypted_workspace_catalog_unavailable');
    }

    const workspaces = snapshot.workspaces.filter((workspace) => workspace.state === 'active');
    if (workspaces.length === 0) {
      this.logger.debug('[fleet] Local workspace catalog is empty');
      return;
    }

    this.logger.debug(`[fleet] Bootstrapping ${workspaces.length} workspace(s) from local catalog`);
    await this.applyWorkspaceList(workspaces.map(localCatalogWorkspaceToWorkspaceListItem));
  }

  private async startWorkspaceSubscription(options: { waitForInitial: boolean }): Promise<void> {
    // Subscribe to the user's workspace list. Remote is the reconcile source once reachable;
    // local catalog remains the bootstrap source so startup does not wait on Convex.
    const confirmationStartedAt = Date.now();
    const initial = new Promise<void>((resolve, reject) => {
      let initialResolved = false;

      const rejectRemoteAuthentication = (message: string) => {
        if (this.invalidTokenReported) return;
        this.invalidTokenReported = true;
        this.logger.error(message);
        this.runtimeStateReporter.setBackendAuthorization('rejected');
        this.runtimeStateReporter.setBackendConnection('disconnected');
        this.runtimeStateReporter.upsertIssue({
          code: 'auth_token_invalid',
          severity: 'fatal',
          recoverable: false,
          message,
        });
        void this.handleRemoteBridgeOffline();
        const error = new Error(message);
        if (!initialResolved) {
          initialResolved = true;
          if (options.waitForInitial) {
            reject(error);
          } else {
            this.onFatalAuthFailure?.(error);
            resolve();
          }
        } else {
          this.onFatalAuthFailure?.(error);
        }
      };

      const unsubscribe = this.cloudPort.access.watchWorkspaceAccess(
        (result) => {
          if (result.status === 'unauthorized') {
            rejectRemoteAuthentication(result.reason);
            return;
          }
          if (result.userId !== this.userId) {
            rejectRemoteAuthentication(
              `Remote CLI identity ${result.userId} does not match cached identity ${this.userId}.`
            );
            return;
          }

          this.runtimeStateReporter.setBackendAuthorization('authorized');
          this.runtimeStateReporter.setBackendConnection('connected');

          if (!initialResolved) {
            this.logger.debug(
              `[startup] Remote authentication confirmed durationMs=${
                Date.now() - confirmationStartedAt
              }`
            );
          }
          this.runtimeStateReporter.clearIssue('workspace_subscription_error');
          this.lastValidWorkspaceListResult = result;
          const applyPromise = this.applyRemoteWorkspaceList(result);

          if (!initialResolved) {
            initialResolved = true;
            void applyPromise
              .then(() => {
                this.runtimeStateReporter.setStartupStage('ready');
                this.refreshRuntimeState();
                this.startRuntimeStateLoop();
                resolve();
              })
              .catch(reject);
          } else {
            void applyPromise.catch((error: unknown) => {
              const message = `[fleet] Failed to apply workspace list: ${formatErrorMessage(
                error
              )}`;
              this.logger.warn(message);
              this.runtimeStateReporter.upsertIssue({
                code: 'workspace_list_apply_failed',
                severity: 'warning',
                recoverable: true,
                message,
              });
              this.scheduleReconcileRetry();
            });
          }
        },
        (error) => {
          const message = `[fleet] Workspace subscription error: ${formatErrorMessage(error)}`;
          this.logger.warn(message);
          this.runtimeStateReporter.setBackendConnection('disconnected');
          this.runtimeStateReporter.upsertIssue({
            code: 'workspace_subscription_error',
            severity: 'error',
            recoverable: true,
            message,
          });
          this.refreshRuntimeState();
          // Transient subscription errors get a grace window before the data
          // plane detaches; a recovered workspace list cancels the timer.
          this.scheduleRemoteBridgeOffline();

          if (!initialResolved) {
            initialResolved = true;
            if (options.waitForInitial) {
              if (typeof unsubscribe === 'function') {
                unsubscribe();
              }
              this.unsubscribeWorkspaces = null;
              reject(new Error(message));
            } else {
              resolve();
            }
          }
        }
      );

      this.unsubscribeWorkspaces = unsubscribe;
    });

    if (options.waitForInitial) {
      await initial;
      return;
    }

    void initial.catch((error: unknown) => {
      this.logger.warn(`[fleet] Workspace subscription failed: ${formatErrorMessage(error)}`);
    });
  }

  shutdown(): Promise<void> {
    return (this.shutdownReceipt ??= this.shutdownOnce());
  }

  recoverShutdown(): Promise<void> {
    if (!this.shutdownReceipt) return this.shutdown();
    if (this.shutdownRecovery) return this.shutdownRecovery;
    const original = this.shutdownReceipt;
    const attempt = (async () => {
      try {
        await original;
        return;
      } catch {
        /* retained workspace owners below */
      }
      for (const id of [...this.cleanupOwners.keys(), ...this.startupCleanupOwners.keys()])
        await this.retryWorkspaceCleanup(id);
      // Workspace recovery cannot prove release of a failed global service owner.
      if (this.localServiceReleaseFailure) throw this.localServiceReleaseFailure;
      await this.finishGlobalShutdown();
    })();
    this.shutdownRecovery = attempt;
    void attempt.catch(() => {
      if (this.shutdownRecovery === attempt) this.shutdownRecovery = undefined;
    });
    return attempt;
  }

  private async shutdownOnce(): Promise<void> {
    this.stopped = true;
    this.stopRuntimeStateLoop();
    this.memoryPressure.stop();
    Effect.runSync(this.prStatusPoller.stop);

    // Stop accepting local work before draining workspace runtimes. Endpoint
    // teardown must not sit behind slow agent/session cleanup, and the owning
    // Host lease remains held until this shutdown barrier completes.
    const localServicesStopped = Promise.allSettled([
      stopLocalIpcSocketServers(),
      stopLocalTerminalServer(),
      stopLocalLoroDataPlaneServer(),
      stopLodyMcpHttpServer(),
    ]);

    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.cancelScheduledRemoteBridgeOffline();
    this.clearReconcileRetry();
    this.remoteBridge?.shutdown();

    this.unsubscribeWorkspaces?.();
    this.unsubscribeWorkspaces = null;

    const failures: unknown[] = [];
    for (const runtime of this.runtimes.values()) {
      try {
        await this.cleanupWorkspaceRuntime(runtime);
      } catch (cause) {
        failures.push(cause);
      }
    }
    for (const owner of this.startupCleanupOwners.values()) {
      try {
        await owner.run();
      } catch (cause) {
        failures.push(cause);
      }
    }
    const localFailures = (await localServicesStopped).flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (localFailures.length) {
      this.localServiceReleaseFailure = new AggregateError(
        localFailures,
        'Local service release remains unproven'
      );
      failures.push(this.localServiceReleaseFailure);
    }
    if (failures.length)
      throw new AggregateError(failures, 'Fleet shutdown retains unresolved workspace resources');
    await this.finishGlobalShutdown();
  }

  private finishGlobalShutdown(): Promise<void> {
    return (this.globalShutdownReceipt ??= this.finishGlobalShutdownOnce());
  }

  private async finishGlobalShutdownOnce(): Promise<void> {
    // Pairing uses native stores outside a started workspace. Join those owners
    // before retiring the account's cloud port; cancelled socket waiters do not
    // mean their ledger/key operations have settled.
    await Promise.allSettled([...this.e2eeActivationInFlight.values()]);
    await this.workspaceWatchCoordinator.dispose();
    await this.cloudPort.dispose();

    this.terminalPtyService.closeAll();
  }

  private async applyWorkspaceList(
    next: WorkspaceListItem[],
    options: { retainRunningWorkspaceIds?: Set<string> } = {}
  ): Promise<void> {
    if (this.stopped) return;

    this.desiredWorkspaces.clear();
    for (const workspace of next) {
      this.desiredWorkspaces.set(workspace.id, workspace);
      const runtime = this.runtimes.get(workspace.id);
      if (runtime) {
        runtime.workspace = workspace;
      }
    }

    const nextIds = new Set(this.desiredWorkspaces.keys());
    const prevIds = new Set([
      ...this.runtimes.keys(),
      ...this.retryTimers.keys(),
      ...this.startInFlight.keys(),
      ...this.waitingForPairing,
    ]);

    // Remove workspaces no longer present.
    for (const workspaceId of prevIds) {
      if (nextIds.has(workspaceId)) continue;
      this.waitingForPairing.delete(workspaceId);
      if (options.retainRunningWorkspaceIds?.has(workspaceId) && this.runtimes.has(workspaceId)) {
        continue;
      }
      if (this.cleanupOwners.has(workspaceId) || this.startupCleanupOwners.has(workspaceId))
        await this.retryWorkspaceCleanup(workspaceId);
      else await this.stopWorkspace(workspaceId);
    }

    // Workspace repos are independent SQLite databases. Start a small bounded
    // batch concurrently so one slow workspace does not serialize fleet readiness.
    const workspacesToStart = next.filter(
      (workspace) => !this.runtimes.has(workspace.id) && !this.waitingForPairing.has(workspace.id)
    );
    for (
      let index = 0;
      index < workspacesToStart.length;
      index += FLEET_WORKSPACE_START_CONCURRENCY
    ) {
      await Promise.all(
        workspacesToStart
          .slice(index, index + FLEET_WORKSPACE_START_CONCURRENCY)
          .map(async (workspace) => await this.startWorkspace(workspace))
      );
    }

    this.runtimeStateReporter.clearIssue('workspace_list_apply_failed');
    this.refreshRuntimeState();
  }

  private async applyRemoteWorkspaceList(result: AuthorizedWorkspaceList): Promise<void> {
    const remoteBridge = this.remoteBridge;
    if (!remoteBridge) {
      throw new Error('Cloud workspace access is configured without a Streams bridge');
    }
    // The subscription re-fires on every reactive change; only repeat the remote
    // bridge reconcile when the meaningful workspace set actually changed.
    const signature = JSON.stringify({
      userId: result.userId,
      machineId: this.machineId,
      machineName: this.machineName,
      workspaces: result.workspaces.map((workspace) => [
        workspace.id,
        workspace.name,
        workspace.slug,
        workspace.role,
        workspace.contentMode,
        workspace.genesisHash,
      ]),
    });
    // A valid workspace list means the control plane is reachable again; cancel
    // any pending offline grace timer before it detaches the data plane.
    this.cancelScheduledRemoteBridgeOffline();
    let revokedRunningWorkspaceIds = new Set<string>();
    let encryptedCacheUnavailable = false;
    if (signature !== this.lastCachedWorkspaceSignature) {
      const reconcile = await remoteBridge.reconcileOnline({
        workspaces: [...result.workspaces],
        runningWorkspaceIds: this.runtimes.keys(),
      });
      revokedRunningWorkspaceIds = reconcile.revokedRunningWorkspaceIds;
      for (const workspace of result.workspaces) {
        this.remoteRevokedWorkspaceIds.delete(workspace.id);
      }
      for (const workspaceId of revokedRunningWorkspaceIds) {
        this.remoteRevokedWorkspaceIds.add(workspaceId);
      }
      encryptedCacheUnavailable = !!reconcile.encryptedCatalogError;
      if (encryptedCacheUnavailable) {
        // Authorization/revocation already used the current remote result.
        // Only the failed encrypted cache remains pending, without preventing
        // healthy workspaces from starting or attaching.
        this.runtimeStateReporter.upsertIssue({
          code: 'encrypted_workspace_catalog_unavailable',
          severity: 'warning',
          recoverable: true,
          message:
            'Encrypted workspace cache is unavailable. Its files have been preserved; retry after local storage recovers.',
        });
      } else {
        this.lastCachedWorkspaceSignature = signature;
        this.runtimeStateReporter.clearIssue('encrypted_workspace_catalog_unavailable');
      }
    }
    await this.applyWorkspaceList([...result.workspaces], {
      retainRunningWorkspaceIds: this.remoteRevokedWorkspaceIds,
    });
    await remoteBridge.attachAllowedRuntimes(result.workspaces.map((workspace) => workspace.id));
    this.refreshRuntimeState();
    // A full apply succeeded; drop any pending reconcile retry + reset backoff.
    if (encryptedCacheUnavailable) this.scheduleReconcileRetry();
    else this.clearReconcileRetry();
    this.runtimeStateReporter.clearIssue('workspace_list_apply_failed');
  }

  private scheduleReconcileRetry(): void {
    if (this.stopped || this.reconcileRetryTimer || !this.lastValidWorkspaceListResult) {
      return;
    }
    const delayMs = this.reconcileRetryDelayMs || FLEET_RECONCILE_RETRY_INITIAL_DELAY_MS;
    this.reconcileRetryDelayMs = Math.min(delayMs * 2, FLEET_RECONCILE_RETRY_MAX_DELAY_MS);
    const timer = setTimeout(() => {
      this.reconcileRetryTimer = null;
      const result = this.lastValidWorkspaceListResult;
      if (this.stopped || !result) {
        return;
      }
      void this.applyRemoteWorkspaceList(result).catch((error: unknown) => {
        this.logger.warn(`[fleet] Reconcile retry failed: ${formatErrorMessage(error)}`);
        this.scheduleReconcileRetry();
      });
    }, delayMs);
    timer.unref?.();
    this.reconcileRetryTimer = timer;
  }

  private clearReconcileRetry(): void {
    if (this.reconcileRetryTimer) {
      clearTimeout(this.reconcileRetryTimer);
      this.reconcileRetryTimer = null;
    }
    this.reconcileRetryDelayMs = 0;
  }

  private async startWorkspace(workspace: WorkspaceListItem): Promise<void> {
    if (this.stopped) return;
    if (!this.desiredWorkspaces.has(workspace.id)) return;
    if (this.startupCleanupOwners.has(workspace.id) || this.cleanupOwners.has(workspace.id)) {
      try {
        await this.retryWorkspaceCleanup(workspace.id);
      } catch (cause) {
        this.logger.warn(`[fleet] Startup recovery failed: ${formatErrorMessage(cause)}`);
        this.scheduleRetry(workspace);
        return;
      }
      if (this.stopped || !this.desiredWorkspaces.has(workspace.id)) return;
    }
    if (this.runtimes.has(workspace.id)) return;

    const retryTimer = this.retryTimers.get(workspace.id);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.retryTimers.delete(workspace.id);
      this.refreshRuntimeState();
    }

    const inFlight = this.startInFlight.get(workspace.id);
    if (inFlight) {
      await inFlight;
      if (this.stopped) return;
      if (this.runtimes.has(workspace.id)) return;
      if (!this.desiredWorkspaces.has(workspace.id)) return;
    }

    const task = (async () => {
      const workspaceLabel = workspace.slug?.trim() || workspace.name || workspace.id;
      const workspaceLogger = this.logger.child({
        workspaceId: workspace.id,
        workspaceName: workspaceLabel,
      });

      let lody: Lody | null = null;
      let stopSchedules: (() => Promise<void>) | undefined;
      let partialPoller: PrPollerWorkspaceHandle | undefined;
      let detachTerminals: (() => void) | undefined;
      const workspaceStartAt = Date.now();
      try {
        lody = await Lody.create({
          logger: workspaceLogger,
          onStorageWriteFailure: () => this.runtimeStateReporter.reportStorageWriteFailure(),
          builtinAgentConfigCliTypes: this.builtinAgentConfigCliTypes,
          supportRegistryAgentTypes: this.supportRegistryAgentTypes,
          workspaceId: workspace.id as WorkspaceId,
          contentMode: workspace.contentMode,
          genesisHash: workspace.genesisHash,
          workspaceSlug: workspace.slug ?? undefined,
          token: this.cliToken,
          userId: this.userId,
          machineId: this.machineId,
          machineName: this.machineName,
          cloudPort: this.cloudPort,
          localWorkspaceCatalog: this.localWorkspaceCatalog,
          memoryPressure: this.memoryPressure,
          machineLifecycleCapability: this.machineLifecycleCapability,
          closeSessionTerminals: (sessionId) => this.terminalPtyService.closeSession(sessionId),
          cleanupLocalProjectWorktreeSetupIfUnreferenced: (localProjectId) =>
            this.cleanupLocalProjectWorktreeSetupIfUnreferenced(localProjectId),
          onFatalAuthFailure: this.onFatalAuthFailure,
          onProcessLifecycleAction: this.onProcessLifecycleAction,
          workspaceWatchCoordinator: this.workspaceWatchCoordinator,
        });

        if (!this.desiredWorkspaces.has(workspace.id) || this.stopped) {
          await lody.cleanup();
          return;
        }

        await lody.start();

        if (!this.desiredWorkspaces.has(workspace.id) || this.stopped) {
          await lody.cleanup();
          return;
        }

        const startedLody = lody;
        const unsubscribeTerminalCleanup = startedLody.onSessionTerminated((sessionId) => {
          this.terminalPtyService.closeSession(sessionId);
        });
        detachTerminals = unsubscribeTerminalCleanup;
        // The poller reads decrypted repo/branch metadata and has independent
        // hosted credential/association ports. Do not construct it for E2EE:
        // sanitizing Lody's own cloud port does not fence this Fleet owner.
        const prPollerWorkspace =
          workspace.contentMode === 'e2ee'
            ? null
            : (partialPoller = createLodyPrPollerWorkspace({
                documentManager: startedLody.documentManager,
                workspaceId: workspace.id,
                userId: this.userId,
                machineId: this.machineId,
                githubTokens: this.cloudPort.githubTokens,
                prAssociation: this.cloudPort.prAssociation,
                logger: workspaceLogger,
              }));
        // Scheduled automation: this machine runs the schedules it owns, so
        // entrusted work continues while nobody is looking.
        const executionSlots = new AgentExecutionSlots();
        const schedules: ScheduleWorkspaceHandle = !workspaceSupports(
          { mode: workspace.contentMode === 'e2ee' ? 'protected' : 'plaintext' },
          'schedules'
        )
          ? { evaluate: async () => {}, dispose: async () => {} }
          : await createScheduleWorkspace({
              manager: startedLody.documentManager,
              workspace,
              auth: {
                token: this.cliToken,
                userId: this.userId,
                userName: '',
                userEmail: '',
                machineId: this.machineId,
                machineName: this.machineName,
              },
              localOnly: this.localPlatform,
              slots: executionSlots,
              logger: workspaceLogger,
              hasSessionWork: (sessionId) => startedLody.hasAutomationSessionWork(sessionId),
            });
        stopSchedules = schedules.dispose;
        const runtime: WorkspaceRuntimeState = {
          workspace,
          lody: startedLody,
          unsubscribeTerminalCleanup,
          prPollerWorkspace,
          schedules,
        };
        this.runtimes.set(workspace.id, runtime);
        if (prPollerWorkspace) this.prStatusPoller.registerWorkspace(prPollerWorkspace);
        void this.remoteBridge?.attachRuntimeIfAllowed(workspace.id);
        this.logger.debug(`[fleet] Connected workspace: ${workspaceLabel} (${workspace.id})`);
        this.logger.debug(
          `[startup] Workspace runtime ready workspaceId=${workspace.id} durationMs=${
            Date.now() - workspaceStartAt
          }`
        );
        this.runtimeStateReporter.clearIssue(`workspace_start_failed:${workspace.id}`);
        this.refreshRuntimeState();
        // Observation is not a prerequisite for pollers, schedules or runtime readiness.
        // Keep its lifetime with this runtime so shutdown never closes its document mid-write.
        const stop = new AbortController();
        const done = reconcileMachineLocalProjectRootPaths(
          startedLody.documentManager.repo,
          workspace.id as WorkspaceId,
          this.machineId,
          startedLody.documentManager,
          stop.signal
        ).catch((error: unknown) => {
          workspaceLogger.warn(`Failed to reconcile local projects: ${formatErrorMessage(error)}`);
        });
        runtime.localProjectReconciliation = { stop, done };
      } catch (error) {
        if (lody) {
          const retained = lody;
          const owner = workspaceCleanupOwnerLegacy([
            async () => {
              await stopSchedules?.();
            },
            () => retained.cleanup(),
            async () => {
              await partialPoller?.dispose();
              detachTerminals?.();
            },
            async () => {
              this.startupCleanupOwners.delete(workspace.id);
            },
          ]);
          this.startupCleanupOwners.set(workspace.id, owner);
          try {
            await owner.run();
          } catch (cleanupCause) {
            const releaseFailure = new AggregateError(
              [error, cleanupCause],
              'Failed startup retains workspace resources',
              { cause: cleanupCause }
            );
            throw releaseFailure;
          }
        }
        throw error;
      }
    })()
      .catch((error: unknown) => {
        if (
          workspace.contentMode === 'e2ee' &&
          error instanceof Error &&
          error.message === 'e2ee_pairing_required'
        ) {
          this.waitingForPairing.add(workspace.id);
          this.runtimeStateReporter.clearIssue(`workspace_start_failed:${workspace.id}`);
          return;
        }
        const message = `[fleet] Failed to start workspace runtime ${workspace.id}: ${formatErrorMessage(
          error,
          { includeStack: true }
        )}`;
        this.logger.warn(message);
        this.runtimeStateReporter.upsertIssue({
          code: `workspace_start_failed:${workspace.id}`,
          severity: 'warning',
          recoverable: true,
          message,
        });
        this.scheduleRetry(workspace);
      })
      .finally(() => {
        this.startInFlight.delete(workspace.id);
        this.refreshRuntimeState();
      });

    this.startInFlight.set(workspace.id, task);
    this.refreshRuntimeState();
    return await task;
  }

  private scheduleRetry(workspace: WorkspaceListItem): void {
    if (this.stopped) return;
    if (!this.desiredWorkspaces.has(workspace.id)) return;
    if (this.retryTimers.has(workspace.id)) return;

    const delayMs = 10_000;
    const timer = setTimeout(() => {
      this.retryTimers.delete(workspace.id);
      this.refreshRuntimeState();
      const desiredWorkspace = this.desiredWorkspaces.get(workspace.id);
      if (!desiredWorkspace || this.stopped) return;
      void this.startWorkspace(desiredWorkspace);
    }, delayMs);
    timer.unref?.();
    this.retryTimers.set(workspace.id, timer);
    this.refreshRuntimeState();
  }

  private async stopWorkspace(workspaceId: string): Promise<void> {
    const retryTimer = this.retryTimers.get(workspaceId);
    if (retryTimer) {
      clearTimeout(retryTimer);
    }
    this.retryTimers.delete(workspaceId);

    const state = this.runtimes.get(workspaceId);
    if (!state) return;
    await this.cleanupWorkspaceRuntime(state);
    this.refreshRuntimeState();
  }

  private cleanupWorkspaceRuntime(state: WorkspaceRuntimeState, recover = false): Promise<void> {
    if (state.cleanupReceipt && !recover) return state.cleanupReceipt;
    this.cleanupOwners.set(state.workspace.id, state);
    state.cleanupOwner ??= workspaceCleanupOwnerLegacy([
      async () => {
        state.localProjectReconciliation?.stop.abort();
        await state.localProjectReconciliation?.done;
      },
      () => state.schedules.dispose(),
      async () => {
        await state.lody.cleanup();
        state.unsubscribeTerminalCleanup();
      },
      async () => {
        await state.prPollerWorkspace?.dispose();
      },
      async () => {
        if (this.runtimes.get(state.workspace.id) === state)
          this.runtimes.delete(state.workspace.id);
        this.cleanupOwners.delete(state.workspace.id);
        this.prStatusPoller.unregisterWorkspace(state.workspace.id);
        state.cleanupFailure = undefined;
      },
    ]);
    const receipt = recover ? state.cleanupOwner.retry() : state.cleanupOwner.run();
    state.cleanupReceipt ??= receipt;
    void receipt.catch((cause) => {
      state.cleanupFailure = cause;
      (state.cleanupCauses ??= []).push(cause);
    });
    return receipt;
  }

  /** Independent retry retains the original failure and starts at the unresolved owner. */
  async retryWorkspaceCleanup(workspaceId: string): Promise<void> {
    const startup = this.startupCleanupOwners.get(workspaceId);
    if (startup) {
      await startup.retry();
      return;
    }
    const state = this.cleanupOwners.get(workspaceId);
    if (!state) return;
    if (!state.cleanupFailure) return state.cleanupReceipt;
    await this.cleanupWorkspaceRuntime(state, true);
  }

  private startRuntimeStateLoop(): void {
    if (this.runtimeStateTimer) {
      return;
    }
    this.refreshRuntimeState();
    const timer = setInterval(() => {
      this.refreshRuntimeState();
    }, FLEET_RUNTIME_STATE_INTERVAL_MS);
    timer.unref?.();
    this.runtimeStateTimer = timer;
  }

  private stopRuntimeStateLoop(): void {
    if (!this.runtimeStateTimer) {
      return;
    }
    clearInterval(this.runtimeStateTimer);
    this.runtimeStateTimer = null;
  }

  /**
   * A transient Convex subscription error must not immediately tear down the
   * Streams data plane (detach + re-attach churn on every control-plane blip).
   * Schedule the detach after a grace window; a successful workspace-list
   * update cancels it.
   */
  private scheduleRemoteBridgeOffline(): void {
    if (this.stopped || this.remoteBridgeOfflineTimer) {
      return;
    }
    const timer = setTimeout(() => {
      this.remoteBridgeOfflineTimer = null;
      void this.handleRemoteBridgeOffline();
    }, FLEET_REMOTE_BRIDGE_OFFLINE_GRACE_MS);
    timer.unref?.();
    this.remoteBridgeOfflineTimer = timer;
  }

  private cancelScheduledRemoteBridgeOffline(): void {
    if (this.remoteBridgeOfflineTimer) {
      clearTimeout(this.remoteBridgeOfflineTimer);
      this.remoteBridgeOfflineTimer = null;
    }
  }

  private async handleRemoteBridgeOffline(): Promise<void> {
    this.cancelScheduledRemoteBridgeOffline();
    this.lastCachedWorkspaceSignature = null;
    await this.remoteBridge?.markOffline(
      Array.from(this.runtimes.values(), (runtime) => runtime.lody)
    );
    this.refreshRuntimeState();
  }

  private refreshRuntimeState(): void {
    const desiredCount = [...this.desiredWorkspaces.keys()].filter(
      (id) => !this.waitingForPairing.has(id)
    ).length;
    let connectedCount = 0;
    let reconnectingCount = 0;
    let totalActiveSessions = 0;
    let totalConnectedRooms = 0;
    const connectedWorkspaces: CliRuntimeWorkspace[] = [];
    for (const runtime of this.runtimes.values()) {
      if (runtime.lody.isControlPlaneReady()) {
        connectedCount += 1;
      } else if (runtime.lody.isControlPlaneRecovering()) {
        reconnectingCount += 1;
      }
      totalActiveSessions += runtime.lody.getActiveSessionCount();
      totalConnectedRooms += runtime.lody.getConnectedRoomCount();
      connectedWorkspaces.push({
        id: runtime.workspace.id,
        name: runtime.workspace.name,
        slug: runtime.workspace.slug,
        role: runtime.workspace.role,
        backendConnection: runtime.lody.isRemoteBridgeAttached()
          ? runtime.lody.isControlPlaneRecovering()
            ? 'reconnecting'
            : 'connected'
          : 'disconnected',
      });
    }
    connectedWorkspaces.sort(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    );
    this.runtimeStateReporter.setActiveSessionCount(totalActiveSessions);
    this.runtimeStateReporter.setConnectedRoomCount(totalConnectedRooms);
    this.runtimeStateReporter.setConnectedWorkspaces(connectedWorkspaces);

    const hasWorkspaceRetry = this.retryTimers.size > 0 || this.startInFlight.size > 0;
    const nextConnectivity: CliRuntimeConnectivity =
      desiredCount === 0
        ? 'online'
        : connectedCount === desiredCount
          ? 'online'
          : reconnectingCount > 0 || hasWorkspaceRetry
            ? 'reconnecting'
            : 'offline';

    if (this.lastConnectivity !== nextConnectivity) {
      this.lastConnectivity = nextConnectivity;
      this.runtimeStateReporter.setConnectivity(nextConnectivity);
    }

    if (hasWorkspaceRetry && !this.hasWorkspaceRetryIssue) {
      this.hasWorkspaceRetryIssue = true;
      this.runtimeStateReporter.upsertIssue({
        code: 'workspace_runtime_retrying',
        severity: 'warning',
        recoverable: true,
        message: 'Workspace runtime is retrying in background.',
      });
    } else if (!hasWorkspaceRetry && this.hasWorkspaceRetryIssue) {
      this.hasWorkspaceRetryIssue = false;
      this.runtimeStateReporter.clearIssue('workspace_runtime_retrying');
    }

    if (nextConnectivity === 'offline') {
      if (!this.hasControlOfflineIssue) {
        this.hasControlOfflineIssue = true;
        this.runtimeStateReporter.upsertIssue({
          code: 'control_offline',
          severity: 'error',
          recoverable: true,
          message: 'Control connection is offline.',
        });
      }
    } else if (this.hasControlOfflineIssue) {
      this.hasControlOfflineIssue = false;
      this.runtimeStateReporter.clearIssue('control_offline');
    }

    if (nextConnectivity === 'reconnecting') {
      if (!this.hasControlReconnectingIssue) {
        this.hasControlReconnectingIssue = true;
        this.runtimeStateReporter.upsertIssue({
          code: 'control_reconnecting',
          severity: 'warning',
          recoverable: true,
          message: 'Control connection is reconnecting.',
        });
      }
    } else if (this.hasControlReconnectingIssue) {
      this.hasControlReconnectingIssue = false;
      this.runtimeStateReporter.clearIssue('control_reconnecting');
    }
  }

  private async dispatchLocalSessionControl(
    message: LocalSessionControlRequest,
    options: { onResponse?: (response: LocalSessionControlResponse) => void } = {}
  ): Promise<LocalSessionControlResponse[]> {
    // Image and file uploads (from the in-session MCP server) may omit the
    // workspaceId; resolve it by finding the single active runtime that holds
    // the session doc. Both share the same resolution + ambiguity handling.
    if (
      (message.type === 'session/image-upload' ||
        message.type === 'session/file-upload' ||
        message.type === 'session/file-send-local') &&
      !message.workspaceId
    ) {
      const responseType =
        message.type === 'session/image-upload'
          ? 'session/image-upload_response'
          : message.type === 'session/file-upload'
            ? 'session/file-upload_response'
            : 'session/file-send-local_response';
      const roomId = getSessionRoomId(message.sessionId);
      const matches: WorkspaceRuntimeState[] = [];

      for (const runtime of this.runtimes.values()) {
        const meta = await runtime.lody.documentManager.repo.getDocMeta(roomId);
        if (meta?.meta && !isLoroRepoDocDeleted(meta)) {
          matches.push(runtime);
        }
      }

      if (matches.length === 0) {
        const response = {
          type: responseType,
          sessionId: message.sessionId,
          success: false,
          error: 'session_not_found',
          message: `Session not found: ${message.sessionId}`,
        } as LocalSessionControlResponse;
        options.onResponse?.(response);
        return [response];
      }

      if (matches.length > 1) {
        const response = {
          type: responseType,
          sessionId: message.sessionId,
          success: false,
          error: 'session_ambiguous',
          message: `Session ${message.sessionId} exists in multiple active workspace runtimes`,
        } as LocalSessionControlResponse;
        options.onResponse?.(response);
        return [response];
      }

      return await matches[0]!.lody.dispatchLocalControl(
        {
          ...message,
          workspaceId: matches[0]!.workspace.id as WorkspaceId,
        },
        options
      );
    }

    const workspaceId = message.workspaceId;
    if (!workspaceId) {
      throw new Error('workspace_runtime_unavailable:missing_workspace_id');
    }

    const pendingStart = this.startInFlight.get(workspaceId);
    if (pendingStart) {
      await pendingStart;
    }

    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) {
      throw new Error(`workspace_runtime_unavailable:${workspaceId}`);
    }

    return await runtime.lody.dispatchLocalControl(message, options);
  }

  private async dispatchLocalMachineRpc(
    message: import('@lody/shared').LocalMachineRpcRequestValidated
  ): Promise<import('@lody/shared').LocalMachineRpcResponse> {
    const pendingStart = this.startInFlight.get(message.workspaceId);
    if (pendingStart) {
      await pendingStart;
    }

    const runtime = this.runtimes.get(message.workspaceId);
    if (!runtime) {
      return { ok: false, error: `workspace_runtime_unavailable:${message.workspaceId}` };
    }

    return await runtime.lody.dispatchLocalMachineRpc(message);
  }

  // Resolves the push-based data-plane engine for a workspace the CLI socket
  // server can route a client connection to. Returns null when no runtime is
  // running yet (the client receives a retryable error).
  private getWorkspaceLoroDataPlaneServer(
    workspaceId: string
  ): LocalLoroDataPlaneServerLegacy | null {
    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) {
      return null;
    }
    return runtime.lody.documentManager.getLocalLoroDataPlaneServer();
  }

  private async lookupTerminalSessionMeta(
    runtime: WorkspaceRuntimeState,
    sessionId: SessionId
  ): Promise<TerminalSessionMetaLookup> {
    const record = await runtime.lody.documentManager.repo.getDocMeta(getSessionRoomId(sessionId));
    if (!record?.meta) {
      return { type: 'missing' };
    }
    if (isLoroRepoDocDeleted(record)) {
      return { type: 'deleted' };
    }
    return { type: 'found', meta: record.meta as SessionMeta };
  }

  private async assertTerminalSessionAllowed(sessionId: SessionId): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      const lookup = await this.lookupTerminalSessionMeta(runtime, sessionId);
      if (lookup.type === 'missing') {
        continue;
      }
      if (lookup.type === 'deleted') {
        throw new Error(`session_deleted:${sessionId}`);
      }
      if (lookup.meta.isArchived) {
        throw new Error(`session_archived:${sessionId}`);
      }
      if (lookup.meta.machineId !== this.machineId) {
        throw new Error(`session_machine_mismatch:${sessionId}:${lookup.meta.machineId}`);
      }
      return;
    }
  }

  private async resolveActiveTerminalSessionWorkdir(sessionId: SessionId): Promise<string | null> {
    const matches: string[] = [];
    for (const runtime of this.runtimes.values()) {
      const workdir = await runtime.lody.resolveSessionWorkdir(sessionId);
      if (workdir) {
        matches.push(workdir);
      }
    }

    if (matches.length > 1) {
      throw new Error(`session_ambiguous:${sessionId}`);
    }
    return matches[0] ?? null;
  }

  private async resolveTerminalSessionWorkdirFromMetadata(sessionId: SessionId): Promise<string> {
    const matches: string[] = [];
    const errors: Error[] = [];

    for (const runtime of this.runtimes.values()) {
      try {
        const workdir = await resolveTerminalWorkdirFromMetadata({
          sessionId,
          machineId: this.machineId,
          lookupSessionMeta: async (targetSessionId) =>
            await this.lookupTerminalSessionMeta(runtime, targetSessionId),
          resolveLocalProjectRootPath: async (localProjectId) =>
            await resolveWorkspaceLocalProjectRootPath(
              runtime.lody.documentManager.repo,
              runtime.workspace.id as WorkspaceId,
              this.machineId,
              localProjectId
            ),
        });
        matches.push(workdir);
      } catch (error) {
        const message = formatErrorMessage(error);
        if (message.startsWith('session_not_found:')) {
          continue;
        }
        errors.push(error instanceof Error ? error : new Error(message));
      }
    }

    if (matches.length > 1) {
      throw new Error(`session_ambiguous:${sessionId}`);
    }
    if (matches.length === 1) {
      return matches[0]!;
    }
    if (errors[0]) {
      throw errors[0];
    }
    throw new Error(`session_not_found:${sessionId}`);
  }

  private async resolveTerminalSessionWorkdir(sessionId: SessionId): Promise<string> {
    await this.assertTerminalSessionAllowed(sessionId);
    const activeWorkdir = await this.resolveActiveTerminalSessionWorkdir(sessionId);
    if (activeWorkdir) {
      return activeWorkdir;
    }
    return await this.resolveTerminalSessionWorkdirFromMetadata(sessionId);
  }

  private toProjectControlError(
    type: LocalProjectControlRequest['type'],
    error: LocalProjectControlErrorCode,
    message: string,
    data?: unknown
  ): LocalProjectControlResponse {
    return {
      ok: false,
      type,
      error,
      message,
      ...(typeof data === 'undefined' ? {} : { data }),
    };
  }

  private mapProjectExecutionError(
    type: LocalProjectControlRequest['type'],
    error: unknown
  ): LocalProjectControlResponse {
    const message = formatErrorMessage(error);
    const normalized = message.toLowerCase();

    if (
      normalized.includes('local project path not found') ||
      normalized.includes('local project not found')
    ) {
      return this.toProjectControlError(type, 'local_project_not_found', message);
    }
    if (normalized.includes('project path') || normalized.includes('directory')) {
      return this.toProjectControlError(type, 'path_invalid', message);
    }
    if (normalized.includes('workspace_runtime_unavailable')) {
      return this.toProjectControlError(
        type,
        'workspace_not_found',
        'Local workspace runtime is unavailable. Wait for the local CLI to finish starting, or restart it.'
      );
    }
    return this.toProjectControlError(type, 'execution_failed', message);
  }

  private listWorkspaceCandidates(): Array<{ id: string; slug: string | null; name: string }> {
    return Array.from(this.runtimes.values()).map((runtime) => ({
      id: runtime.workspace.id,
      slug: runtime.workspace.slug,
      name: runtime.workspace.name,
    }));
  }

  private async resolveTargetWorkspaceRuntimes(
    selector: string | undefined,
    allWorkspaces: boolean | undefined
  ): Promise<
    | { ok: true; runtimes: WorkspaceRuntimeState[] }
    | {
        ok: false;
        error: LocalProjectControlResponse;
      }
  > {
    if (allWorkspaces) {
      const runtimes = Array.from(this.runtimes.values());
      if (runtimes.length === 0) {
        return {
          ok: false,
          error: this.toProjectControlError(
            'local-project/add',
            'workspace_not_found',
            'No active workspace runtime is available'
          ),
        };
      }
      return { ok: true, runtimes };
    }

    const trimmedSelector = selector?.trim();
    if (trimmedSelector) {
      const matches = findWorkspacesBySelector(
        Array.from(this.desiredWorkspaces.values()),
        trimmedSelector
      );
      if (matches.length === 0) {
        return {
          ok: false,
          error: this.toProjectControlError(
            'local-project/add',
            'workspace_not_found',
            `Workspace not found: ${trimmedSelector}`
          ),
        };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          error: this.toProjectControlError(
            'local-project/add',
            'workspace_not_found',
            `Workspace selector is ambiguous: ${trimmedSelector}. Matches: ${matches.map(formatWorkspaceCandidate).join(', ')}. Use a workspace id or slug instead.`
          ),
        };
      }

      const targetWorkspace = matches[0]!;

      const pending = this.startInFlight.get(targetWorkspace.id);
      if (pending) {
        await pending;
      }

      const runtime = this.runtimes.get(targetWorkspace.id);
      if (!runtime) {
        return {
          ok: false,
          error: this.toProjectControlError(
            'local-project/add',
            'workspace_not_found',
            `Workspace runtime is unavailable: ${targetWorkspace.id}`
          ),
        };
      }
      return { ok: true, runtimes: [runtime] };
    }

    const runtimes = Array.from(this.runtimes.values());
    if (runtimes.length === 1) {
      return { ok: true, runtimes };
    }
    if (runtimes.length === 0) {
      return {
        ok: false,
        error: this.toProjectControlError(
          'local-project/add',
          'workspace_not_found',
          'No active workspace runtime is available'
        ),
      };
    }

    return {
      ok: false,
      error: this.toProjectControlError(
        'local-project/add',
        'workspace_required',
        'Multiple workspaces are active; specify --workspace or --all-workspaces',
        { candidates: this.listWorkspaceCandidates() }
      ),
    };
  }

  private async upsertProjectMetaInWorkspace(
    runtime: WorkspaceRuntimeState,
    entry: { localProjectId: LocalProjectId; name: string; rootPath: string }
  ): Promise<void> {
    const repo = runtime.lody.documentManager.repo;
    const workspaceId = runtime.workspace.id as WorkspaceId;
    const existing = await readMachineLocalProjects(repo, workspaceId, this.machineId);
    const previous = existing[entry.localProjectId];
    const nowMs = getServerNow();

    await upsertMachineLocalProject(
      repo,
      workspaceId,
      this.machineId,
      {
        ...(previous ?? {}),
        id: entry.localProjectId,
        name: entry.name,
        rootPath: entry.rootPath,
        createdAtMs: previous?.createdAtMs ?? nowMs,
        lastOpenedAtMs: nowMs,
      },
      nowMs,
      {
        sync: runtime.lody.documentManager,
        reason: 'local-project-add',
        refreshGitHubRemote: true,
        standaloneVisible: true,
      }
    );
  }

  private async removeProjectMetaInWorkspace(
    runtime: WorkspaceRuntimeState,
    localProjectId: LocalProjectId
  ): Promise<void> {
    await removeMachineLocalProject(
      runtime.lody.documentManager.repo,
      runtime.workspace.id as WorkspaceId,
      this.machineId,
      localProjectId,
      undefined,
      { sync: runtime.lody.documentManager, reason: 'local-project-delete' }
    );
  }

  private async listProjectsByWorkspace(): Promise<
    Array<{
      workspaceId: WorkspaceId;
      workspaceName: string;
      projects: Array<{ localProjectId: LocalProjectId; name: string; rootPath: string }>;
    }>
  > {
    const groups: Array<{
      workspaceId: WorkspaceId;
      workspaceName: string;
      projects: Array<{ localProjectId: LocalProjectId; name: string; rootPath: string }>;
    }> = [];

    for (const runtime of this.runtimes.values()) {
      const existing = await readMachineLocalProjects(
        runtime.lody.documentManager.repo,
        runtime.workspace.id as WorkspaceId,
        this.machineId
      );

      const projects: Array<{ localProjectId: LocalProjectId; name: string; rootPath: string }> =
        [];
      for (const localProjectMeta of Object.values(existing)) {
        if (!localProjectMeta) {
          continue;
        }
        const rootPath = localProjectMeta.rootPath?.trim();
        if (!rootPath) continue;

        projects.push({
          localProjectId: localProjectMeta.id,
          name: localProjectMeta.name,
          rootPath,
        });
      }

      projects.sort((a, b) => {
        const nameCompare = a.name.localeCompare(b.name);
        if (nameCompare !== 0) {
          return nameCompare;
        }
        return a.rootPath.localeCompare(b.rootPath);
      });

      if (projects.length === 0) {
        continue;
      }

      groups.push({
        workspaceId: runtime.workspace.id as WorkspaceId,
        workspaceName: runtime.workspace.name,
        projects,
      });
    }

    groups.sort((a, b) => a.workspaceName.localeCompare(b.workspaceName));
    return groups;
  }

  private async isLocalProjectReferencedByAnyWorkspace(
    localProjectId: LocalProjectId
  ): Promise<boolean> {
    const workspaces = await this.listProjectsByWorkspace();
    return workspaces.some((workspace) =>
      workspace.projects.some((project) => project.localProjectId === localProjectId)
    );
  }

  private async cleanupLocalProjectWorktreeSetupIfUnreferenced(
    localProjectId: LocalProjectId
  ): Promise<void> {
    if (await this.isLocalProjectReferencedByAnyWorkspace(localProjectId)) {
      return;
    }
    await deleteLocalProjectWorktreeSetup(localProjectId);
  }

  private async listRegisteredLocalProjectRootPaths(
    workspaceId?: WorkspaceId
  ): Promise<Record<LocalProjectId, string>> {
    const rootPaths: Record<LocalProjectId, string> = {};
    const workspaces = await this.listProjectsByWorkspace();
    for (const workspace of workspaces) {
      if (workspaceId && workspace.workspaceId !== workspaceId) {
        continue;
      }
      for (const project of workspace.projects) {
        rootPaths[project.localProjectId] = project.rootPath;
      }
    }
    return rootPaths;
  }

  private async dispatchLocalE2eePairing(
    message: LocalE2eePairingRequest
  ): Promise<LocalE2eePrepareResponse | LocalE2eeActivateResponse> {
    if (
      this.stopped ||
      this.localPlatform ||
      message.accountId !== this.userId ||
      !this.cloudPort.e2ee
    )
      throw new Error('e2ee_account_unavailable');
    const workspace = this.desiredWorkspaces.get(message.workspaceId);
    if (
      !workspace ||
      workspace.contentMode !== 'e2ee' ||
      workspace.genesisHash !== message.genesisHash
    )
      throw new Error('e2ee_binding_conflict');
    const { activateCliE2eeWorkspaceLegacy, prepareCliE2eeMachineLegacy } =
      await import('./e2ee/workspace-legacy');
    if (message.type === 'prepare') {
      const material = await prepareCliE2eeMachineLegacy({ ...message });
      return { ok: true, type: 'prepare', machineId: this.machineId, ...material };
    }
    await this.startInFlight.get(workspace.id);
    if (this.cleanupOwners.has(workspace.id) || this.startupCleanupOwners.has(workspace.id))
      await this.retryWorkspaceCleanup(workspace.id);
    const running = this.runtimes.get(workspace.id);
    if (running && (await running.lody.refreshEncryptedWorkspace(message.signingPublicKey))) {
      return { ok: true, type: 'activate' };
    } else {
      // A newly approved identity must not reuse an old live in-memory device.
      if (running) await this.stopWorkspace(workspace.id);
      let activation = this.e2eeActivationInFlight.get(workspace.id);
      if (!activation) {
        activation = activateCliE2eeWorkspaceLegacy({
          accountId: this.userId,
          workspaceId: workspace.id,
          genesisHash: message.genesisHash,
          expectedSigningPublicKey: message.signingPublicKey,
          cloud: this.cloudPort.e2ee,
          onUnavailable: () => this.logger.debug('e2ee_background_unavailable'),
        }).finally(() => {
          this.e2eeActivationInFlight.delete(workspace.id);
        });
        this.e2eeActivationInFlight.set(workspace.id, activation);
      }
      await activation;
      this.waitingForPairing.delete(workspace.id);
      await this.startWorkspace(workspace);
      await this.resolveWorkspaceRuntime(workspace.id as WorkspaceId);
    }
    return { ok: true, type: 'activate' };
  }

  private async resolveWorkspaceRuntime(workspaceId: WorkspaceId): Promise<WorkspaceRuntimeState> {
    const pendingStart = this.startInFlight.get(workspaceId);
    if (pendingStart) {
      await pendingStart;
    }

    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) {
      throw new Error(`workspace_runtime_unavailable:${workspaceId}`);
    }
    return runtime;
  }

  private async resolveWorkspaceProjectRootPath(
    runtime: WorkspaceRuntimeState,
    localProjectId: LocalProjectId
  ): Promise<string> {
    const rootPath = await resolveWorkspaceLocalProjectRootPathWithRetry(
      runtime.lody.documentManager.repo,
      runtime.workspace.id as WorkspaceId,
      this.machineId,
      localProjectId,
      {
        requestSync: () =>
          runtime.lody.documentManager.syncMachineFlockDoc(this.machineId, {
            reason: 'local-project-control-resolve',
            timeoutMs: readLocalProjectRootResolveSyncTimeoutMs(),
          }),
      }
    );
    if (!rootPath) {
      throw new Error(`Local project not found in workspace: ${localProjectId}`);
    }
    return rootPath;
  }

  private async dispatchLocalProjectControl(
    message: LocalProjectControlRequest
  ): Promise<LocalProjectControlResponse> {
    const requestType = message.type;
    if (message.machineId !== this.machineId) {
      return this.toProjectControlError(
        requestType,
        'machine_mismatch',
        `Machine mismatch: expected ${this.machineId}`
      );
    }

    try {
      if (message.type === 'local-project/list-roots') {
        return {
          ok: true,
          type: 'local-project/list-roots',
          result: await this.localProjectControlService.listBrowseRoots(),
        };
      }

      if (message.type === 'local-project/browse-dir') {
        return {
          ok: true,
          type: 'local-project/browse-dir',
          result: await this.localProjectControlService.browseDirectory({
            absolutePath: message.absolutePath,
            showHidden: message.showHidden,
            limit: message.limit,
            cursor: message.cursor,
            registeredProjects: await this.listRegisteredLocalProjectRootPaths(message.workspaceId),
          }),
        };
      }

      if (message.type === 'local-project/create-directory') {
        try {
          await this.resolveWorkspaceRuntime(message.workspaceId);
        } catch {
          return this.toProjectControlError(
            requestType,
            'workspace_not_found',
            'Workspace runtime is unavailable.'
          );
        }
        try {
          return {
            ok: true,
            type: message.type,
            result: await this.localProjectControlService.createDirectory(
              message.parentPath,
              message.name
            ),
          };
        } catch (error) {
          if (error instanceof LocalProjectCreateDirectoryError) {
            return this.toProjectControlError(requestType, error.code, error.message);
          }
          throw error;
        }
      }

      if (message.type === 'local-project/prepare-add') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const preparedProject = this.localProjectControlService.prepareProject(message.rootPath);
        const existingProject = await resolveWorkspaceLocalProjectWithSyncOnMiss(
          runtime.lody.documentManager.repo,
          message.workspaceId,
          this.machineId,
          preparedProject.localProjectId,
          {
            requestSync: () =>
              runtime.lody.documentManager.syncMachineFlockDoc(this.machineId, {
                reason: 'local-project-prepare-add-resolve',
                timeoutMs: readTimeoutEnv('LODY_LOCAL_PROJECT_RESOLVE_SYNC_TIMEOUT_MS', 1_500),
              }),
          }
        );
        return {
          ok: true,
          type: 'local-project/prepare-add',
          result: {
            localProjectId: preparedProject.localProjectId,
            name: existingProject?.name ?? preparedProject.name,
            rootPath: existingProject?.rootPath ?? preparedProject.rootPath,
            alreadyRegistered: existingProject !== null,
            ...(message.inspect
              ? {
                  inspection: await worktreeGitLegacy.probeLocalProjectMember(
                    preparedProject.rootPath
                  ),
                }
              : {}),
          },
        };
      }

      if (message.type === 'local-project/add') {
        const workspaceResolution = await this.resolveTargetWorkspaceRuntimes(
          message.workspace,
          message.allWorkspaces
        );
        if (!workspaceResolution.ok) {
          return workspaceResolution.error;
        }

        const addedProject = this.localProjectControlService.prepareProject(message.rootPath);
        for (const runtime of workspaceResolution.runtimes) {
          await this.upsertProjectMetaInWorkspace(runtime, {
            localProjectId: addedProject.localProjectId,
            name: addedProject.name,
            rootPath: addedProject.rootPath,
          });
        }

        return {
          ok: true,
          type: 'local-project/add',
          result: {
            localProjectId: addedProject.localProjectId,
            name: addedProject.name,
            rootPath: addedProject.rootPath,
            workspaceIds: workspaceResolution.runtimes.map(
              (runtime) => runtime.workspace.id as WorkspaceId
            ),
          },
        };
      }

      if (message.type === 'local-project/delete') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const existingProject = await resolveWorkspaceLocalProject(
          runtime.lody.documentManager.repo,
          runtime.workspace.id as WorkspaceId,
          this.machineId,
          message.localProjectId
        );
        if (!existingProject) {
          throw new Error(`Local project not found in workspace: ${message.localProjectId}`);
        }
        await this.removeProjectMetaInWorkspace(runtime, message.localProjectId);
        await this.cleanupLocalProjectWorktreeSetupIfUnreferenced(message.localProjectId);

        return {
          ok: true,
          type: 'local-project/delete',
          result: {
            localProjectId: message.localProjectId,
            name: existingProject.name,
            rootPath: existingProject.rootPath,
            workspaceIds: [message.workspaceId],
          },
        };
      }

      if (message.type === 'local-project/removal-preflight') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        const sessions = (await listAliveSessionMetas(runtime.lody.documentManager)).map(
          ({ meta }) => meta
        );
        return {
          ok: true,
          type: 'local-project/removal-preflight',
          result: await preflightLocalProjectWorktreeRemoval({
            machineId: this.machineId,
            localProjectId: message.localProjectId,
            originalRootPath: rootPath,
            sessions,
            logger: this.logger,
          }),
        };
      }

      if (message.type === 'local-project/list') {
        return {
          ok: true,
          type: 'local-project/list',
          result: {
            workspaces: await this.listProjectsByWorkspace(),
          },
        };
      }

      if (message.type === 'local-project/git-state') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        return {
          ok: true,
          type: 'local-project/git-state',
          result: await this.localProjectControlService.getProjectGitState(rootPath),
        };
      }

      if (message.type === 'local-project/list-files') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        return {
          ok: true,
          type: 'local-project/list-files',
          result: await this.localProjectControlService.listProjectFiles(rootPath, {
            maxFiles: message.maxFiles,
          }),
        };
      }

      if (message.type === 'local-project/list-dir') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        return {
          ok: true,
          type: 'local-project/list-dir',
          result: await this.localProjectControlService.listProjectDirectory(
            rootPath,
            message.relativePath,
            { limit: message.limit }
          ),
        };
      }

      if (message.type === 'local-project/list-skills') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        return {
          ok: true,
          type: 'local-project/list-skills',
          result: await this.localProjectControlService.listProjectSkills(
            rootPath,
            message.skillDirs
          ),
        };
      }

      if (message.type === 'local-project/list-global-skills') {
        await this.resolveWorkspaceRuntime(message.workspaceId);
        return {
          ok: true,
          type: 'local-project/list-global-skills',
          result: await this.localProjectControlService.listGlobalSkills(),
        };
      }

      if (message.type === 'local-project/read-file') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        return {
          ok: true,
          type: 'local-project/read-file',
          result: this.localProjectControlService.readProjectFile(rootPath, message.relativePath, {
            maxBytes: message.maxBytes,
          }),
        };
      }

      if (message.type === 'local-project/checkout-branch') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        return {
          ok: true,
          type: 'local-project/checkout-branch',
          result: await this.localProjectControlService.checkoutProjectBranch(
            rootPath,
            message.branchName
          ),
        };
      }

      if (isLocalProjectWorktreeConfigRequest(message)) {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        await this.resolveWorkspaceProjectRootPath(runtime, message.localProjectId);
        return await handleLocalProjectWorktreeConfigRequest(message);
      }

      if (message.type === 'local-project/sync-history') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        const service = new LocalProjectHistorySyncService(
          runtime.lody.documentManager,
          this.logger,
          {
            workspaceId: message.workspaceId,
            machineId: this.machineId,
            userId: this.userId,
          },
          message.provider
        );
        const result = await service.syncLocalProject({
          localProjectId: message.localProjectId,
          rootPath,
        });
        return {
          ok: true,
          type: 'local-project/sync-history',
          result,
        };
      }

      if (message.type === 'local-project/import-history') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        const service = new LocalProjectHistorySyncService(
          runtime.lody.documentManager,
          this.logger,
          {
            workspaceId: message.workspaceId,
            machineId: this.machineId,
            userId: this.userId,
          },
          message.provider
        );
        const result = await service.importLocalProjectSessions({
          localProjectId: message.localProjectId,
          rootPath,
          acpSessionIds: message.acpSessionIds,
        });
        return {
          ok: true,
          type: 'local-project/import-history',
          result,
        };
      }

      if (message.type === 'local-project/resolve-history-conflict') {
        const runtime = await this.resolveWorkspaceRuntime(message.workspaceId);
        const rootPath = await this.resolveWorkspaceProjectRootPath(
          runtime,
          message.localProjectId
        );
        const service = new LocalProjectHistorySyncService(
          runtime.lody.documentManager,
          this.logger,
          {
            workspaceId: message.workspaceId,
            machineId: this.machineId,
            userId: this.userId,
          },
          message.provider
        );
        const result = await service.resolveHistoryConflict({
          localProjectId: message.localProjectId,
          rootPath,
          sessionId: message.sessionId,
          acpSessionId: message.acpSessionId,
        });
        return {
          ok: true,
          type: 'local-project/resolve-history-conflict',
          result,
        };
      }

      if (message.type === 'worktree/list-files') {
        return {
          ok: true,
          type: 'worktree/list-files',
          result: await this.localProjectControlService.listWorktreeFiles(
            message.repoFullName,
            message.sessionId,
            { maxFiles: message.maxFiles }
          ),
        };
      }

      if (message.type === 'worktree/read-file') {
        return {
          ok: true,
          type: 'worktree/read-file',
          result: this.localProjectControlService.readWorktreeFile(
            message.repoFullName,
            message.sessionId,
            message.relativePath,
            { maxBytes: message.maxBytes }
          ),
        };
      }

      return this.toProjectControlError(requestType, 'invalid_request', 'Unsupported request type');
    } catch (error) {
      return this.mapProjectExecutionError(requestType, error);
    }
  }
}
