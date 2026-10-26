import { workspaceSupports } from '@lody/shared/workspace-streams-content';
import type { CliE2eeWorkspaceLegacy } from './e2ee/workspace-legacy';
import { LoroDocumentManager } from '@/lib/loro/doc';
import { MachineRuntime } from '@/lib/machine-runtime';
import { Logger } from '@/utils/logger';
import {
  CliType,
  getManagedBuiltinRuntimeByAgentType,
  type LocalProjectId,
  MachineId,
  type SessionId,
  WorkspaceId,
  type LocalSessionControlRequest,
  type LocalSessionControlResponse,
  type LocalMachineRpcRequestValidated,
  type LocalMachineRpcResponse,
  type MachineLifecycleCapability,
} from '@lody/shared';
import { getLoginShellEnvLegacy } from '@/agent/login-shell-env';
import { SessionManager } from '@/session/session-manager';
import { installRoostNodeSessionBackend } from '@/session/roost-node-session';
import { routeRemoteOwnedSessionHistory } from '@/session/session-backend';
import { createCommandSessionHistoryFactory } from '@/lib/command-runtime';
import pkg from '@/pkg';
import { formatErrorMessage } from '@/utils/format-error';
import type { LocalWorkspaceCatalogService } from '@/lib/local-workspace-catalog';
import type { MachineProcessLifecycleAction } from './machine-lifecycle';
import { traceAsync } from '@/utils/trace-span';
import type { MemoryPressureSnapshotSource } from '@/monitor/memory-pressure-sampler';
import type { WorkspaceWatchCoordinatorApi } from '@/lib/code-collab/workspace-watch-coordinator';
import type { CloudPort } from '@lody/platform';

const BUILTIN_AGENT_CONFIG_INITIAL_RETRY_DELAY_MS = 10_000;
const BUILTIN_AGENT_CONFIG_MAX_RETRY_DELAY_MS = 5 * 60_000;

interface LodyOptions {
  logger: Logger;
  builtinAgentConfigCliTypes?: CliType[];
  supportRegistryAgentTypes?: string[];
  workspaceId: WorkspaceId;
  contentMode?: string;
  genesisHash?: string;
  workspaceSlug?: string;
  token: string;
  userId: string;
  machineId: MachineId;
  machineName: string;
  localWorkspaceCatalog?: LocalWorkspaceCatalogService;
  memoryPressure: MemoryPressureSnapshotSource;
  machineLifecycleCapability: MachineLifecycleCapability;
  closeSessionTerminals?: (sessionId: SessionId) => void;
  cleanupLocalProjectWorktreeSetupIfUnreferenced?: (
    localProjectId: LocalProjectId
  ) => Promise<void>;
  onFatalAuthFailure?: (error: Error) => void;
  onStorageWriteFailure?: (error: Error) => void;
  onProcessLifecycleAction?: (action: MachineProcessLifecycleAction) => void;
  workspaceWatchCoordinator?: WorkspaceWatchCoordinatorApi;
  cloudPort: CloudPort;
}
export class Lody {
  private logger: Logger;
  private userId: string;
  private workspaceId: WorkspaceId;
  private workspaceSlug?: string;
  private token: string;
  private machineId: MachineId;
  private machineName: string;
  private runtime: MachineRuntime;
  private supportRegistryAgentTypes: string[];
  private cleanedUp = false;
  private encryptedWorkspace?: CliE2eeWorkspaceLegacy;
  private builtinAgentConfigRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingBuiltinAgentConfigRetryCliTypes = new Set<CliType>();
  private builtinAgentConfigRetryAttempt = 0;
  private builtinAgentRegistrationStarted = false;

  static async create(options: LodyOptions): Promise<Lody> {
    // Register the optional local Roost adapter before any session document can
    // resolve its backend. The selector remains metadata-driven, so legacy and
    // new Loro sessions continue to use the built-in backend by default.
    installRoostNodeSessionBackend();
    if (
      options.contentMode !== undefined &&
      options.contentMode !== 'plaintext' &&
      options.contentMode !== 'e2ee'
    )
      throw new Error('workspace_mode_unsupported');
    const encrypted = options.contentMode === 'e2ee';
    let e2ee: CliE2eeWorkspaceLegacy | undefined;
    if (!workspaceSupports({ mode: encrypted ? 'protected' : 'plaintext' }, 'rpc')) {
      if (!options.genesisHash || !options.cloudPort.e2ee)
        throw new Error('e2ee_workspace_unavailable');
      const { openCliE2eeWorkspaceLegacy } = await import('./e2ee/workspace-legacy');
      e2ee = await openCliE2eeWorkspaceLegacy({
        accountId: options.userId,
        workspaceId: options.workspaceId,
        genesisHash: options.genesisHash,
        cloud: options.cloudPort.e2ee,
        onUnavailable: () => options.logger.debug('e2ee_background_unavailable'),
      });
      // Unimplemented channels cannot inherit their ordinary plaintext sinks.
      options = {
        ...options,
        cloudPort: {
          ...options.cloudPort,
          streamsTokens: null,
          notifications: null,
          attachmentUpload: null,
          remotePreview: null,
          sessionSharing: null,
          prAssociation: null,
          githubTokens: null,
        },
      };
    }
    let manager: LoroDocumentManager | undefined;
    // Commands the daemon executes may touch Sessions owned by other machines; their
    // Roost history lives with that owner, never in this machine's database.
    const ownerHistoryRouter =
      options.cloudPort.kind === 'local'
        ? undefined
        : routeRemoteOwnedSessionHistory(
            options.machineId,
            createCommandSessionHistoryFactory(
              () => {
                if (!manager) throw new Error('Workspace document manager is unavailable');
                return manager;
              },
              {
                token: options.token,
                userId: options.userId,
                userName: options.userId,
                userEmail: '',
                machineId: options.machineId,
                machineName: options.machineName,
              },
              options.workspaceId
            )
          );
    manager = await traceAsync(
      options.logger,
      'startup.loro_document_manager',
      { workspaceId: options.workspaceId },
      async () =>
        await LoroDocumentManager.create(options.workspaceId, options.userId, options.logger, {
          // The daemon is the only process that resumes LoroDoc rooms from the
          // shared SQLite cursors; one-shot commands keep theirs in memory.
          documentCursorScope: 'shared-durable',
          keepWorkspaceCatalogJoined: true,
          streamsTokens: e2ee?.tokens ?? options.cloudPort.streamsTokens,
          encryptedWorkspace: e2ee,
          cloudBilling: options.cloudPort.billing,
          ownerHistoryRouter,
          onStorageWriteFailure: options.onStorageWriteFailure,
        })
    ).catch(async (error) => {
      await e2ee?.close();
      throw error;
    });
    const lody = new Lody(options, manager);
    lody.encryptedWorkspace = e2ee;
    return lody;
  }

  constructor(
    public readonly options: LodyOptions,
    public readonly documentManager: LoroDocumentManager
  ) {
    this.logger = options.logger;

    this.userId = options.userId;
    this.workspaceId = options.workspaceId;
    this.workspaceSlug = options.workspaceSlug ?? undefined;
    this.token = options.token;
    this.machineId = options.machineId;
    this.machineName = options.machineName;
    this.supportRegistryAgentTypes = options.supportRegistryAgentTypes ?? [];
    this.runtime = new MachineRuntime({
      sessionManagerFactory: () =>
        new SessionManager(
          this.logger,
          this.token,
          this.machineId,
          this.workspaceId,
          documentManager,
          { cloudPort: options.cloudPort }
        ),
      workspaceDocument: documentManager,
      memoryPressure: options.memoryPressure,
      handlerConfig: {
        token: this.token,
        encryptedWorkspace: options.contentMode === 'e2ee',
        workspaceId: this.workspaceId,
        workspaceSlug: this.workspaceSlug,
        userId: this.userId,
        machineId: this.machineId,
        machineName: this.machineName,
        cliVersion: pkg.version,
        machineLifecycleCapability: options.machineLifecycleCapability,
        supportRegistryAgentTypes: this.supportRegistryAgentTypes,
        ...(options.localWorkspaceCatalog
          ? { localWorkspaceCatalog: options.localWorkspaceCatalog }
          : {}),
        closeSessionTerminals: options.closeSessionTerminals,
        cleanupLocalProjectWorktreeSetupIfUnreferenced:
          options.cleanupLocalProjectWorktreeSetupIfUnreferenced,
        onFatalAuthFailure: options.onFatalAuthFailure,
        onProcessLifecycleAction: options.onProcessLifecycleAction,
        workspaceWatchCoordinator: options.workspaceWatchCoordinator,
        cloudPort: options.cloudPort,
      },
      logger: this.logger,
    });
  }

  async start(): Promise<void> {
    // Warm the login-shell env probe (~100-300ms) concurrently with startup so
    // synchronous terminal environment callbacks usually read a populated PATH.
    // ACP startup awaits the same cached probe before spawning. The Legacy cache
    // retains and reports failures; launchers receive them on later reads.
    void getLoginShellEnvLegacy().catch(() => undefined);
    await traceAsync(
      this.logger,
      'startup.machine_runtime',
      { workspaceId: this.workspaceId },
      async () => await this.runtime.initialize()
    );
    this.documentManager.ensureMachineFlockDocJoined(this.machineId, { reason: 'lody-start' });
  }

  async registerAgent(cliTypes: CliType[]): Promise<void> {
    if (this.cleanedUp) {
      return;
    }
    await this.runtime.initialize();
    if (this.cleanedUp) {
      return;
    }
    if (this.documentManager.hasCompletedInitialMetaSync()) {
      await this.ensureBuiltinAgentConfigsOrRetry(cliTypes);
    } else {
      this.logger.debug(
        `[agent-config] Initial meta sync is not complete for workspace ${this.workspaceId}; deferring builtin agent registration`
      );
      let detachMetaSyncedListener: (() => void) | null = null;
      // Both the meta-synced listener and the initial-sync promise below can
      // fire for the same sync; run the registration exactly once.
      let registered = false;
      const registerAfterMetaSync = async () => {
        detachMetaSyncedListener?.();
        detachMetaSyncedListener = null;
        if (registered || this.cleanedUp) {
          return;
        }
        registered = true;
        await this.ensureBuiltinAgentConfigsOrRetry(cliTypes);
      };
      detachMetaSyncedListener = this.documentManager.onMetaRoomSynced(() => {
        void registerAfterMetaSync().catch((error: unknown) => {
          this.logger.debug(
            `[agent-config] Deferred builtin agent registration failed: ${formatErrorMessage(error)}`
          );
        });
      });
      void this.documentManager
        .waitForInitialMetaSync()
        .then(async (completed) => {
          if (!completed || this.cleanedUp) {
            return;
          }
          await registerAfterMetaSync();
        })
        .catch((error: unknown) => {
          this.logger.debug(
            `[agent-config] Deferred builtin agent registration failed: ${formatErrorMessage(error)}`
          );
        });
    }
  }

  private async ensureBuiltinAgentConfigsOrRetry(cliTypes: CliType[]): Promise<void> {
    if (this.cleanedUp) {
      return;
    }
    const completed = await this.ensureBuiltinAgentConfigs(cliTypes);
    if (!completed) {
      this.scheduleBuiltinAgentConfigRetry(cliTypes);
      return;
    }
    this.builtinAgentConfigRetryAttempt = 0;
  }

  private async ensureBuiltinAgentConfigs(cliTypes: CliType[]): Promise<boolean> {
    if (cliTypes.length === 0) {
      return true;
    }
    const syncedMachineFlock = await this.documentManager.syncMachineFlockDoc(this.machineId, {
      reason: 'builtin-agent-registration',
    });
    if (!syncedMachineFlock) {
      this.logger.debug(
        `[agent-config] Machine Flock sync is not complete for workspace ${this.workspaceId} machine ${this.machineId}; skipping builtin agent registration for this attempt`
      );
      return false;
    }

    // "Not in the list" cannot tell "never created" from "just removed by the user".
    // Removal intent lives in this set; skipping it adds a removed provider back on
    // every startup.
    const optedOut = await this.documentManager.getBuiltinAgentOptOuts(this.machineId);

    for (const cliType of cliTypes) {
      const builtinRuntime = getManagedBuiltinRuntimeByAgentType(cliType);
      if (!builtinRuntime) {
        continue;
      }
      if (optedOut.has(cliType)) {
        this.logger.debug(
          `[agent-config] Skipping builtin agent registration for ${cliType} on machine ${this.machineId}; the user removed it on this machine`
        );
        continue;
      }
      // Keep the legacy row as the sole Pi provider until its owner confirms
      // migration. Check legacy first so a completed migration is then caught
      // by the builtin lookup below, rather than creating a second provider.
      if (
        cliType === 'pi' &&
        (await this.documentManager.hasAgentConfig('registry', 'pi-acp', this.machineId))
      ) {
        continue;
      }
      const has = await this.documentManager.hasAgentConfig('builtin', cliType, this.machineId);
      if (!has) {
        await this.documentManager.createAgentConfig(
          'builtin',
          cliType,
          this.machineId,
          builtinRuntime.displayName
        );
      }
    }
    return true;
  }

  private scheduleBuiltinAgentConfigRetry(cliTypes: CliType[]): void {
    if (cliTypes.length === 0 || this.cleanedUp) {
      return;
    }

    for (const cliType of cliTypes) {
      this.pendingBuiltinAgentConfigRetryCliTypes.add(cliType);
    }

    if (this.builtinAgentConfigRetryTimer) {
      return;
    }

    const delayMs = this.nextBuiltinAgentConfigRetryDelayMs();
    this.logger.debug(
      `[agent-config] Scheduling builtin agent registration retry in ${delayMs}ms for workspace ${this.workspaceId} machine ${this.machineId}`
    );
    this.builtinAgentConfigRetryTimer = setTimeout(() => {
      this.builtinAgentConfigRetryTimer = undefined;
      if (this.cleanedUp) {
        this.pendingBuiltinAgentConfigRetryCliTypes.clear();
        return;
      }

      const retryCliTypes = [...this.pendingBuiltinAgentConfigRetryCliTypes];
      this.pendingBuiltinAgentConfigRetryCliTypes.clear();
      void this.ensureBuiltinAgentConfigsOrRetry(retryCliTypes).catch((error: unknown) => {
        this.logger.debug(
          `[agent-config] Retried builtin agent registration failed: ${formatErrorMessage(error)}`
        );
      });
    }, delayMs);
    this.builtinAgentConfigRetryTimer.unref?.();
  }

  private nextBuiltinAgentConfigRetryDelayMs(): number {
    const multiplier = 2 ** Math.min(this.builtinAgentConfigRetryAttempt, 5);
    this.builtinAgentConfigRetryAttempt += 1;
    return Math.min(
      BUILTIN_AGENT_CONFIG_INITIAL_RETRY_DELAY_MS * multiplier,
      BUILTIN_AGENT_CONFIG_MAX_RETRY_DELAY_MS
    );
  }

  cleanup = async () => {
    this.cleanedUp = true;
    if (this.builtinAgentConfigRetryTimer) {
      clearTimeout(this.builtinAgentConfigRetryTimer);
      this.builtinAgentConfigRetryTimer = undefined;
    }
    this.pendingBuiltinAgentConfigRetryCliTypes.clear();
    this.builtinAgentConfigRetryAttempt = 0;
    await this.runtime.cleanup();
  };

  async dispatchLocalControl(
    message: LocalSessionControlRequest,
    options: { onResponse?: (response: LocalSessionControlResponse) => void } = {}
  ): Promise<LocalSessionControlResponse[]> {
    const responses = await this.runtime.dispatchLocalMessageForResponse(message, options);
    return responses as LocalSessionControlResponse[];
  }

  async dispatchLocalMachineRpc(
    message: LocalMachineRpcRequestValidated
  ): Promise<LocalMachineRpcResponse> {
    return await this.runtime.dispatchLocalMachineRpc(message);
  }

  isControlPlaneReady(): boolean {
    // Ready == nothing needs recovering. Deliberately NOT gated on
    // `isTransportConnected()`: that is the raw aggregate status, which reads
    // `connecting` whenever any room is lazily joining — ordinary churn in a
    // workspace with thousands of rooms, not a degraded control plane. See
    // `LoroStreamsHealth` in `loro/connection-recovery.ts`.
    return !this.documentManager.isTransportRecovering();
  }

  isControlPlaneRecovering(): boolean {
    return this.documentManager.isTransportRecovering();
  }

  isRemoteBridgeAttached(): boolean {
    return this.runtime.isRemoteBridgeAttached();
  }

  getActiveSessionCount(): number {
    return this.runtime.getActiveSessionCount();
  }

  hasAutomationSessionWork(sessionId: SessionId): boolean {
    return this.runtime.getMessageHandler()?.hasAutomationSessionWork(sessionId) ?? true;
  }

  /** Local pairing completion wakes ledger verification and key installation, never trusts a remote admission hint. */
  async refreshEncryptedWorkspace(expectedSigningPublicKey: string): Promise<boolean> {
    if (!this.encryptedWorkspace) throw new Error('e2ee_workspace_unavailable');
    if ((await this.encryptedWorkspace.status()).devicePublicKey !== expectedSigningPublicKey)
      return false;
    await this.encryptedWorkspace.refresh();
    if (!(await this.encryptedWorkspace.status()).hasCurrentKey)
      throw new Error('e2ee_waiting_for_key');
    return true;
  }

  async attachRemoteBridge(): Promise<void> {
    void this.encryptedWorkspace?.refresh();
    await this.runtime.attachRemoteBridge();
    this.startBuiltinAgentRegistration();
  }

  private startBuiltinAgentRegistration(): void {
    if (this.builtinAgentRegistrationStarted || this.cleanedUp) {
      return;
    }
    this.builtinAgentRegistrationStarted = true;
    void traceAsync(
      this.logger,
      'startup.agent_registration',
      { workspaceId: this.workspaceId },
      async () => await this.registerAgent(this.options.builtinAgentConfigCliTypes ?? [])
    ).catch((error: unknown) => {
      this.logger.debug(
        `[agent-config] Background builtin agent registration failed for workspace ${this.workspaceId}: ${formatErrorMessage(
          error
        )}`
      );
    });
  }

  async detachRemoteBridge(): Promise<void> {
    await this.runtime.detachRemoteBridge();
  }

  async handleRemoteAccessRevoked(): Promise<void> {
    await this.runtime.handleRemoteAccessRevoked();
  }

  async resolveSessionWorkdir(sessionId: SessionId): Promise<string | null> {
    return await this.runtime.resolveSessionWorkdir(sessionId);
  }

  onSessionTerminated(handler: (sessionId: SessionId) => void): () => void {
    return this.runtime.onSessionTerminated(handler);
  }

  getConnectedRoomCount(): number {
    return this.documentManager.getConnectedRoomCount();
  }
}
