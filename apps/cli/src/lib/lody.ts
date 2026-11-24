import {
  resolveDeclaredWorkflow,
  bindDeclaredGrantActor,
} from '../plugins/workflow/declared-workflow';
import { encryptedPluginDispatch } from '../plugins/machine-host-port';
import {
  composeMachineHostDispatch,
  type ResolveStandalonePluginOperation,
} from '../plugins/workflow/daemon-command-executor';
import type { LodyPresenceStateMap, ManagedDaemonUpgradeOptions } from '@lody/shared';
import { daemonLossObserver } from './e2ee/client-loss-observer';
import type { AuthorizeEncryptedExecution, EncryptedAgentExecution } from './e2ee/agent-execution';
import { workspaceSupports } from '@lody/shared/workspace-streams-content';
import type { CliE2eeWorkspaceLegacy } from './e2ee/workspace-legacy';
import type { AuthorityStamp } from './e2ee/authority-clock';
import { LoroDocumentManager } from '@/lib/loro/doc';
import { MachineRuntime } from '@/lib/machine-runtime';
import { createSorbetCredentialsHandler } from '@/lib/sorbet-credentials';
import { Logger } from '@/utils/logger';
import {
  CliType,
  getScheduleRoomId,
  getSessionRoomId,
  type SessionMeta,
  type ScheduleAuthorizationRequest,
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
import { assertRetainedE2eeModeAllowsOpen } from '@/lib/e2ee/retained-binding';
import { encryptedRuntimeCloudPort } from '@/lib/e2ee/runtime-cloud-port';
import type { DaemonWorkspaceAccess } from '@/lib/session-command-environment';

const BUILTIN_AGENT_CONFIG_INITIAL_RETRY_DELAY_MS = 10_000;
const BUILTIN_AGENT_CONFIG_MAX_RETRY_DELAY_MS = 5 * 60_000;

type PluginDaemon = import('../plugins/plugin-host-legacy').PluginDaemon;
interface LodyOptions {
  resolveStandalonePluginOperation?: ResolveStandalonePluginOperation;
  localPlugin?: () => PluginDaemon | undefined;
  /** A successful authenticated ledger read of this encrypted workspace; see Fleet. */
  onEncryptedAuthorityConfirmed?: (startedAt: AuthorityStamp) => void;
  /** True while execution relies on an outage window, with that window's ends. */
  onEncryptedWindowNotice?: (
    active: boolean,
    window?: import('./e2ee/execution-authorization').E2eeAccessWindow
  ) => void;
  remoteAutomation?: {
    handshake: () => Promise<import('@lody/shared/automations').RemoteAutomationHandshake>;
    control: (input: {
      sessionId: string;
      requesterUserId: string;
      operation: import('@lody/shared/automations').RemoteAutomationOperation;
      proof: import('@lody/shared/automations').RemoteAutomationProof;
      responseKey: import('@lody/shared').RpcSecretPublicKey;
    }) => Promise<import('@lody/shared/automations').RemoteAutomationRpcResult>;
  };
  logger: Logger;
  builtinAgentConfigCliTypes?: CliType[];
  supportRegistryAgentTypes?: string[];
  workspaceId: WorkspaceId;
  contentMode?: string;
  authorizeEncryptedExecution?: AuthorizeEncryptedExecution;
  genesisHash?: string;
  workspaceSlug?: string;
  token: string;
  userId: string;
  machineId: MachineId;
  machineName: string;
  localWorkspaceCatalog?: LocalWorkspaceCatalogService;
  memoryPressure: MemoryPressureSnapshotSource;
  machineLifecycleCapability: MachineLifecycleCapability;
  hostsEncryptedWorkspace?: () => boolean;
  prepareManagedUpgrade?: (
    requestId: string,
    target: string,
    upgrade?: ManagedDaemonUpgradeOptions
  ) => Promise<string>;
  closeSessionTerminals?: (sessionId: SessionId) => void;
  /** See `MessageHandlerConfig.readHostedPresenceStates`. */
  readHostedPresenceStates?: () => LodyPresenceStateMap[];
  cleanupLocalProjectWorktreeSetupIfUnreferenced?: (
    localProjectId: LocalProjectId
  ) => Promise<void>;
  onFatalAuthFailure?: (error: Error) => void;
  onStorageWriteFailure?: (error: Error) => void;
  onInboxAvailabilityChange?: (message: string | undefined) => void;
  /** Drain this owner on confirmed member removal or device revocation.
   * `member-removed` ends the account's membership; `device-revoked` retires only
   * this machine identity, so the workspace may re-enrol with a fresh one.
   * The workspace host alone owns receipt-verified member-data erasure. */
  onEncryptedAccessLost?: (
    owner: Lody,
    reason: 'member-removed' | 'device-revoked'
  ) => Promise<void>;
  onProcessLifecycleAction?: (action: MachineProcessLifecycleAction) => void;
  isMachineIdentityRestoreIdle?: () => boolean;
  sealMachineIdentityRestore?: () => boolean;
  workspaceWatchCoordinator?: WorkspaceWatchCoordinatorApi;
  readWorkspaceAccess?: () => DaemonWorkspaceAccess;
  cloudPort: CloudPort;
  /** A verified encrypted owner promoted in place by local pairing activation. `create`
   * takes ownership: it closes this handle itself if it fails before returning. */
  encryptedWorkspace?: CliE2eeWorkspaceLegacy;
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
  private startingEncryptedHost?: PluginDaemon;
  private encryptedPlugin?: Promise<PluginDaemon>;
  private encryptedWorkspace?: CliE2eeWorkspaceLegacy;
  private encryptedRevocation: 'e2ee_member_removed' | 'e2ee_device_revoked' | undefined;
  private startReceipt?: Promise<void>;
  private clientLossReceipt?: ReturnType<typeof daemonLossObserver.register>;
  private clientLossRpcStopped = false;
  private builtinAgentConfigRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingBuiltinAgentConfigRetryCliTypes = new Set<CliType>();
  private builtinAgentConfigRetryAttempt = 0;
  private builtinAgentRegistrationStarted = false;

  static async create(options: LodyOptions): Promise<Lody> {
    const handed = options.encryptedWorkspace;
    if (!handed) return Lody.createOwned(options);
    try {
      if (options.contentMode !== 'e2ee') throw new Error('e2ee_workspace_unavailable');
      return await Lody.createOwned(options);
    } catch (error) {
      // Close is idempotent: an owner that already closed it returns the same receipt.
      await handed.close().catch(() => undefined);
      throw error;
    }
  }

  private static async createOwned(options: LodyOptions): Promise<Lody> {
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
    // Every runtime start re-checks the retained pairing binding, so neither a
    // listing nor a stale cached row can open an encrypted workspace as plaintext.
    assertRetainedE2eeModeAllowsOpen(options.userId, {
      id: options.workspaceId,
      contentMode: options.contentMode,
      genesisHash: options.genesisHash,
    });
    const encrypted = options.contentMode === 'e2ee';
    let e2ee: CliE2eeWorkspaceLegacy | undefined;
    let resolveRemovalOwner: (value: Lody | null) => void = () => {};
    const removalOwner = new Promise<Lody | null>((resolve) => {
      resolveRemovalOwner = resolve;
    });
    if (!workspaceSupports({ mode: encrypted ? 'protected' : 'plaintext' }, 'rpc')) {
      if (!options.genesisHash || !options.cloudPort.e2ee)
        throw new Error('e2ee_workspace_unavailable');
      const callbacks = {
        onUnavailable: () => options.logger.debug('e2ee_background_unavailable'),
        onAuthorityConfirmed: options.onEncryptedAuthorityConfirmed,
        onRemoved: async (
          reason: 'member-removed' | 'device-revoked',
          recorded: boolean
        ): Promise<void> => {
          const owner = await removalOwner;
          if (!owner) return;
          owner.encryptedRevocation =
            reason === 'device-revoked' ? 'e2ee_device_revoked' : 'e2ee_member_removed';
          // The probe may fence only a durable exact receipt. Cleanup still stops
          // the owner when that write failed, but it is not a drain proof.
          if (recorded) owner.clientLossReceipt?.loss(owner.encryptedRevocation);
          try {
            await owner.startReceipt?.catch(() => undefined);
            if (options.onEncryptedAccessLost) await options.onEncryptedAccessLost(owner, reason);
            else await owner.cleanup();
            if (!owner.startReceipt) await owner.documentManager.cleanUp();
            owner.clientLossReceipt?.retired();
          } catch (cause) {
            owner.clientLossReceipt?.failed();
            throw cause;
          }
        },
      };
      if (options.encryptedWorkspace) {
        // Activation already verified admission and the current key on this owner.
        e2ee = options.encryptedWorkspace;
        e2ee.adopt(callbacks);
      } else {
        const { openCliE2eeWorkspaceLegacy } = await import('./e2ee/workspace-legacy');
        e2ee = await openCliE2eeWorkspaceLegacy({
          machineId: options.machineId,
          accountId: options.userId,
          workspaceId: options.workspaceId,
          genesisHash: options.genesisHash,
          cloud: options.cloudPort.e2ee,
          onWindowNotice: options.onEncryptedWindowNotice,
          ...callbacks,
        });
      }
      options = { ...options, cloudPort: encryptedRuntimeCloudPort(options.cloudPort) };
    }
    let manager: LoroDocumentManager | undefined;
    let encryptedExecution: EncryptedAgentExecution | undefined;
    if (e2ee) {
      if (!options.genesisHash) throw new Error('e2ee_workspace_unavailable');
      const { join } = await import('node:path');
      const { Effect } = await import('effect');
      const { makeEncryptedAgentExecution, lazyExecutionJournal } =
        await import('./e2ee/agent-execution');
      encryptedExecution = makeEncryptedAgentExecution({
        genesis: options.genesisHash,
        workspaceId: options.workspaceId,
        targetMachineId: options.machineId,
        machineUserId: options.cloudPort.identity.userId,
        ledgerIdentity: e2ee.ledgerIdentity,
        authorizeMachineTarget: e2ee.authorizeMachineTarget,
        ...(typeof e2ee.subscribeExecutionEvidence === 'function'
          ? { subscribeEvidence: e2ee.subscribeExecutionEvidence }
          : {}),
        journal: lazyExecutionJournal(join(e2ee.repositoryDirectory, 'execution.sqlite'), Date.now),
        authorizeExecution: options.authorizeEncryptedExecution ?? e2ee.authorizeExecution,
        isExecutionOpen: e2ee.isExecutionOpen,
        authorizeSchedule: (request, localProjectId) =>
          Effect.gen(function* () {
            const owner = manager;
            if (!owner || !e2ee) return { _tag: 'Denied' as const, reason: 'unavailable' };
            const handle = yield* Effect.tryPromise({
              try: () => owner.repo.openPersistedDoc(getScheduleRoomId(request.scheduleId)),
              catch: (cause) => cause,
            });
            const synced = yield* Effect.result(
              Effect.tryPromise({
                try: () =>
                  owner.syncDocOrThrow(getScheduleRoomId(request.scheduleId), {
                    reason: 'schedule:execution-source',
                    timeoutMs: 8_000,
                  }),
                catch: (cause) => cause,
              })
            );
            if (synced._tag === 'Failure')
              return { _tag: 'Denied' as const, reason: 'e2ee_schedule_evidence_pending' };
            return yield* e2ee.authorizeScheduleExecution(request, handle.doc, { localProjectId });
          }),
        onClaim: (userTurnId) =>
          options.logger.debug('[e2ee-rpc-timing]', {
            stage: 'journal',
            journal: 'agent-start',
            userTurnId,
            at: Date.now(),
          }),
        resolveVerifiedOriginal: (intent, lookup) => {
          const owner = manager;
          const loaded = owner?.sessions.get(intent.sessionId as SessionId)?.handle?.doc;
          if (!e2ee || typeof e2ee.resolveVerifiedExecutionOriginal !== 'function')
            return Effect.succeed(undefined);
          const resolve = e2ee.resolveVerifiedExecutionOriginal;
          if (loaded || !lookup?.origin || !owner) return resolve(intent, loaded, lookup);
          // A derivation origin may live in a session this daemon has not opened yet.
          return Effect.tryPromise({
            try: () => owner.getOrCreateSessionDoc(intent.sessionId as SessionId),
            catch: (cause) => cause,
          }).pipe(
            Effect.flatMap((session) => resolve(intent, session.handle?.doc, lookup)),
            Effect.catch(() => Effect.succeed(undefined))
          );
        },
        ...(typeof e2ee.signingPublicKey === 'string' ? { selfDevice: e2ee.signingPublicKey } : {}),
      });
    }
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
      resolveRemovalOwner(null);
      await e2ee?.close();
      throw error;
    });
    const lody = new Lody(options, manager, encryptedExecution);
    lody.encryptedWorkspace = e2ee;
    if (e2ee)
      lody.clientLossReceipt = daemonLossObserver.register(
        {
          machineId: options.machineId,
          accountId: options.userId,
          workspaceId: options.workspaceId,
          deviceKey: e2ee.signingPublicKey,
        },
        () => {
          const work = lody.runtime.inspectClientLoss();
          return work
            ? { ...work, intakeClosed: work.intakeClosed && lody.clientLossRpcStopped }
            : null;
        },
        e2ee.inspectClientLossAuthority
      );
    resolveRemovalOwner(lody);
    return lody;
  }

  constructor(
    public readonly options: LodyOptions,
    public readonly documentManager: LoroDocumentManager,
    encryptedExecution?: EncryptedAgentExecution
  ) {
    this.logger = options.logger;

    this.userId = options.userId;
    this.workspaceId = options.workspaceId;
    this.workspaceSlug = options.workspaceSlug ?? undefined;
    this.token = options.token;
    this.machineId = options.machineId;
    this.machineName = options.machineName;
    this.supportRegistryAgentTypes = options.supportRegistryAgentTypes ?? [];
    documentManager.workflowSessionAuthority = async (id, installation, project, role) => {
      const identity = this.encryptedWorkspace,
        daemon = await this.encryptedPlugin;
      if (!identity || !daemon) throw Error('Workflow authorization unavailable');
      const lease = await daemon.activeWorkflowLease(id);
      if (!lease || lease.installationId !== installation)
        throw Error('Workflow installation changed');
      const proof = await identity.verifyDeclaredWorkflowGrant(lease.signature, this.machineId);
      const a = proof.approval;
      if (
        a.action !== 'grant' ||
        !a.allowed_ops.includes('sessions.create') ||
        a.plugin_id !== id ||
        a.installationId !== installation ||
        a.machineDigest !== lease.machineDigest ||
        a.targetDevice !== identity.signingPublicKey ||
        (a.allowed_role_ids !== '*' && !a.allowed_role_ids.includes(role)) ||
        (a.allowed_project_ids !== '*' && !a.allowed_project_ids.includes(project))
      )
        throw Error('Workflow approval mismatch');
      return () => {
        identity.pluginAuthoritySignal.throwIfAborted();
        if (!lease.isCurrent() || !proof.isCurrent()) throw Error('Workflow approval withdrawn');
      };
    };
    documentManager.workflowMachineId = this.machineId;
    documentManager.pluginDaemon = async () => {
      if (
        this.cleanedUp ||
        this.encryptedRevocation ||
        this.encryptedWorkspace?.pluginAuthoritySignal.aborted ||
        process.env.LODY_PLUGIN_SAFE_MODE === '1'
      )
        return undefined;
      return options.contentMode === 'e2ee'
        ? (this.startingEncryptedHost ?? (await this.encryptedPlugin))
        : options.localPlugin?.();
    };
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
        pluginRpc: async (request, actor, signal) => {
          if (this.cleanedUp || process.env.LODY_PLUGIN_SAFE_MODE === '1')
            throw new Error('Plugin host unavailable');
          const daemon =
            options.contentMode === 'e2ee' ? await this.encryptedPlugin : options.localPlugin?.();
          if (
            !daemon ||
            this.cleanedUp ||
            this.encryptedRevocation ||
            this.encryptedWorkspace?.pluginAuthoritySignal.aborted
          )
            throw new Error('Plugin host unavailable');
          signal?.throwIfAborted();
          const identity = this.encryptedWorkspace;
          if (request.method === 'plugin/declared-workflow-grant')
            actor = await bindDeclaredGrantActor({
              request,
              actor,
              identity,
              machineId: this.machineId,
              projectExists: (id) => this.runtime.workflowProjectExists(id),
            });
          return daemon.dispatchMachineRpc(
            request,
            { ...actor, targetDevice: identity?.signingPublicKey },
            signal
          );
        },
        sorbetCredentials: createSorbetCredentialsHandler(documentManager, this.machineId),
        token: this.token,
        encryptedWorkspace: options.contentMode === 'e2ee',
        encryptedExecution: options.contentMode === 'e2ee' ? encryptedExecution : undefined,
        workspaceId: this.workspaceId,
        workspaceSlug: this.workspaceSlug,
        userId: this.userId,
        machineId: this.machineId,
        machineName: this.machineName,
        cliVersion: pkg.version,
        machineLifecycleCapability: options.machineLifecycleCapability,
        hostsEncryptedWorkspace: options.hostsEncryptedWorkspace,
        prepareManagedUpgrade: options.prepareManagedUpgrade,
        supportRegistryAgentTypes: this.supportRegistryAgentTypes,
        ...(options.localWorkspaceCatalog
          ? { localWorkspaceCatalog: options.localWorkspaceCatalog }
          : {}),
        closeSessionTerminals: options.closeSessionTerminals,
        readHostedPresenceStates: options.readHostedPresenceStates,
        cleanupLocalProjectWorktreeSetupIfUnreferenced:
          options.cleanupLocalProjectWorktreeSetupIfUnreferenced,
        onInboxAvailabilityChange: options.onInboxAvailabilityChange,
        onFatalAuthFailure: options.onFatalAuthFailure,
        onProcessLifecycleAction: options.onProcessLifecycleAction,
        isMachineIdentityRestoreIdle: options.isMachineIdentityRestoreIdle,
        sealMachineIdentityRestore: options.sealMachineIdentityRestore,
        workspaceWatchCoordinator: options.workspaceWatchCoordinator,
        readWorkspaceAccess: options.readWorkspaceAccess,
        remoteAutomation: options.remoteAutomation,
        cloudPort: options.cloudPort,
      },
      logger: this.logger,
    });
  }

  async admitPluginEvent(
    frame: Parameters<import('../plugins/plugin-host-legacy').PluginDaemon['event']>[0]
  ) {
    const payload = frame.payload as {
      session?: {
        workspaceId?: string;
        machineId?: string;
        sessionId?: string;
        projectId?: string;
      };
    };
    const s = payload?.session;
    if (
      !s?.sessionId ||
      s.workspaceId !== this.workspaceId ||
      s.machineId !== this.machineId ||
      this.cleanedUp ||
      this.encryptedRevocation
    )
      return false;
    const record = await this.documentManager.repo.getDocMeta(
      getSessionRoomId(s.sessionId as SessionId)
    );
    const m = record?.meta as SessionMeta | undefined;
    if (
      record?.deleted ||
      !m ||
      m.id !== s.sessionId ||
      m.machineId !== this.machineId ||
      m.userId !== this.userId ||
      !!m.isArchived !== (frame.eventType === 'session.archived') ||
      (m.project?.kind === 'local' ? m.project.localProjectId : undefined) !== s.projectId
    )
      return false;
    return (
      !this.encryptedWorkspace ||
      (!this.encryptedWorkspace.pluginAuthoritySignal.aborted &&
        !m.parentSessionId &&
        (await this.documentManager.authorizeEncryptedSessionRead({
          machineId: m.machineId,
          rootSessionId: m.id,
          requesterUserId: this.userId,
          sessionOwnerUserId: m.userId,
          localProjectId: m.project?.kind === 'local' ? m.project.localProjectId : undefined,
        })))
    );
  }
  async start(): Promise<void> {
    if (this.encryptedRevocation) throw new Error(this.encryptedRevocation);
    return (this.startReceipt = this.startRuntime());
  }

  private async startRuntime(): Promise<void> {
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
    if (this.encryptedWorkspace && process.env.LODY_PLUGIN_SAFE_MODE !== '1') {
      const identity = this.encryptedWorkspace;
      this.encryptedPlugin ??= (async () => {
        const [{ PluginDaemon }, { identityPluginVault }, { join }] = await Promise.all([
          import('../plugins/plugin-host-legacy'),
          import('../plugins/identity-plugin-vault'),
          import('node:path'),
        ]);
        const root = join(identity.repositoryDirectory, 'plugins');
        if (this.cleanedUp || this.encryptedRevocation || identity.pluginAuthoritySignal.aborted)
          throw Error('Plugin identity closed');
        const resolve: ResolveStandalonePluginOperation = resolveDeclaredWorkflow({
          workspaceId: this.workspaceId,
          machineId: this.machineId,
          identity,
          manager: this.documentManager,
          lease: (id, instance) => host.workflowLease(id, instance),
          projectExists: (id) => this.runtime.workflowProjectExists(id),
          stopSession: (sid, turn) => {
            const h = this.runtime.getMessageHandler();
            if (!h) throw Error('Runtime unavailable');
            return h.stopDeclaredWorkflowSession(sid, turn);
          },
          forkSession: (sid, turn, principal, authorize) => {
            const h = this.runtime.getMessageHandler();
            if (!h) throw Error('Runtime unavailable');
            return h.forkDeclaredWorkflowSession(sid, turn, principal, authorize);
          },
          sessionScope: (id) => this.runtime.resolveSessionExecutionScope(id),
        });
        const host: PluginDaemon = new PluginDaemon(
          root,
          this.workspaceId,
          this.machineId,
          (m) => this.logger.warn(m),
          identityPluginVault(root),
          encryptedPluginDispatch(composeMachineHostDispatch(resolve)),
          undefined,
          (frame) => this.admitPluginEvent(frame)
        );
        this.startingEncryptedHost = host;
        const stop = () => {
          void host.dispose().catch(() => this.logger.warn('Plugin shutdown failed'));
        };
        identity.pluginAuthoritySignal.addEventListener('abort', stop, { once: true });
        try {
          await host.start();
          return host;
        } catch (error) {
          this.startingEncryptedHost = undefined;
          await host.dispose();
          throw error;
        }
      })();
      await this.encryptedPlugin.catch(() => this.logger.warn('Encrypted plugin host unavailable'));
    }
    await this.encryptedWorkspace?.startRpc(
      this.machineId,
      (input) => this.runtime.offerEncryptedRpcTurn(input),
      (event) => this.logger.debug('[e2ee-rpc-timing]', event),
      (request, context) => this.runtime.handleEncryptedFeatureRpc(request, context),
      (sessionId) => this.runtime.resolveSessionHistoryAccessTarget(sessionId),
      (sessionId) => this.runtime.resolveSessionExecutionScope(sessionId)
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
    let completed = false;
    try {
      completed = await this.ensureBuiltinAgentConfigs(cliTypes);
    } catch (error) {
      this.logger.debug(`[agent-config] Builtin registration failed: ${formatErrorMessage(error)}`);
    }
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

    let completed = true;
    for (const cliType of cliTypes) {
      try {
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
      } catch (error) {
        completed = false;
        this.logger.debug(
          `[agent-config] Builtin ${cliType} registration failed: ${formatErrorMessage(error)}`
        );
      }
    }
    return completed;
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
      void this.registerAgent(retryCliTypes).catch((error: unknown) => {
        this.scheduleBuiltinAgentConfigRetry(retryCliTypes);
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

  prepareForShutdown = () => this.runtime.prepareForShutdown();
  stopNewIdentityRestoreDispatch = () => this.runtime.stopNewIdentityRestoreDispatch();

  cleanup = async () => {
    this.cleanedUp = true;
    if (this.builtinAgentConfigRetryTimer) {
      clearTimeout(this.builtinAgentConfigRetryTimer);
      this.builtinAgentConfigRetryTimer = undefined;
    }
    this.pendingBuiltinAgentConfigRetryCliTypes.clear();
    this.builtinAgentConfigRetryAttempt = 0;
    try {
      await this.encryptedWorkspace?.stopRpc();
      this.clientLossRpcStopped = true;
    } finally {
      try {
        await this.runtime.cleanup();
      } finally {
        await (await this.encryptedPlugin?.catch(() => undefined))?.dispose();
      }
    }
  };

  async dispatchEncryptedPluginControl(command: unknown) {
    const identity = this.encryptedWorkspace;
    const host = await this.encryptedPlugin;
    if (
      !identity ||
      !host ||
      this.encryptedRevocation ||
      this.cleanedUp ||
      identity.pluginAuthoritySignal.aborted
    )
      throw Error('Encrypted plugin owner unavailable');
    return host.dispatch(command);
  }
  async dispatchLocalControl(
    message: LocalSessionControlRequest,
    options: { onResponse?: (response: LocalSessionControlResponse) => void } = {}
  ): Promise<LocalSessionControlResponse[]> {
    const responses = await this.runtime.dispatchLocalMessageForResponse(message, options);
    return responses as LocalSessionControlResponse[];
  }

  async dispatchLocalMachineRpc(
    message: LocalMachineRpcRequestValidated,
    signal?: AbortSignal
  ): Promise<LocalMachineRpcResponse> {
    return await this.runtime.dispatchLocalMachineRpc(message, signal);
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

  isMachineIdentityRestoreIdle(): boolean {
    return this.runtime.isMachineIdentityRestoreIdle();
  }

  async authorizeScheduleExecution(request: ScheduleAuthorizationRequest): Promise<boolean> {
    if (this.options.contentMode !== 'e2ee') return true;
    if (!this.encryptedWorkspace || this.cleanedUp) return false;
    const handle = await this.documentManager.repo.openPersistedDoc(
      getScheduleRoomId(request.scheduleId)
    );
    const result = await this.encryptedWorkspace.authorizeScheduleExecutionLegacy(
      request,
      handle.doc
    );
    return result._tag === 'Authorized';
  }

  hasAutomationSessionWork(sessionId: SessionId): boolean {
    return this.runtime.getMessageHandler()?.hasAutomationSessionWork(sessionId) ?? true;
  }

  getAutomationSessionAuthority() {
    const handler = this.runtime.getMessageHandler();
    if (!handler) throw new Error('AUTOMATION_SESSION_OWNER_UNAVAILABLE');
    return handler.getAutomationSessionAuthority();
  }

  hasAutomationTurnWork(sessionId: SessionId): boolean {
    return this.runtime.getMessageHandler()?.hasAutomationTurnWork(sessionId) ?? true;
  }

  /** Local pairing completion wakes ledger verification and key installation, never trusts a remote admission hint. */
  async confirmEncryptedWorkspacePairing(intent: {
    pairingSessionId: string;
    frontendSigningPublicKey: string;
    signingPublicKey: string;
  }): Promise<boolean> {
    if (!this.encryptedWorkspace) throw new Error('e2ee_workspace_unavailable');
    if ((await this.encryptedWorkspace.status()).devicePublicKey !== intent.signingPublicKey)
      return false;
    await this.encryptedWorkspace.confirmPairing(intent);
    await this.refreshEncryptedWorkspace(intent.signingPublicKey);
    return true;
  }

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
      this.builtinAgentRegistrationStarted = false;
      this.scheduleBuiltinAgentConfigRetry(this.options.builtinAgentConfigCliTypes ?? []);
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

  async resolveAutomationWorkdir(sessionId: SessionId): Promise<string | null> {
    const manager = this.runtime.getSessionManager();
    return manager ? await manager.resolveSessionWorkdir(sessionId) : null;
  }

  getConnectedRoomCount(): number {
    return this.documentManager.getConnectedRoomCount();
  }
}
