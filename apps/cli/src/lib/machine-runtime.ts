import {
  type LocalSessionControlRequestValidated,
  type LocalSessionControlResponse,
  type LocalMachineRpcRequestValidated,
  type LocalMachineRpcResponse,
  type MachineId,
  type SessionId,
} from '@lody/shared';
import {
  MessageHandler,
  type MessageDispatchContext,
  type MessageHandlerConfig,
} from '@/lib/message-handler';
import { MessageProcessor } from '@/lib/message-processor';
import { SessionGCManager, loadGCConfig } from '@/lib/session-gc-manager';
import { SessionManager } from '@/session/session-manager';
import { LoroDocumentManager } from '@/lib/loro/doc';
import { Logger } from '@/utils/logger';
import { traceAsync } from '@/utils/trace-span';
import { CliResourceMonitor } from '@/monitor/cli-resource-monitor';
import type { MemoryPressureSnapshotSource } from '@/monitor/memory-pressure-sampler';

export interface MachineRuntimeOptions {
  sessionManagerFactory: () => SessionManager;
  workspaceDocument: LoroDocumentManager;
  handlerConfig: MessageHandlerConfig;
  logger: Logger;
  memoryPressure: MemoryPressureSnapshotSource;
  /**
   * 最大并发处理的 session 数量
   * @default 30
   */
  maxConcurrentSessions?: number;
}

export class MachineRuntime {
  private handler: MessageHandler | null = null;
  private sessionManager: SessionManager | null = null;
  private readonly messageProcessor: MessageProcessor;
  private gcManager: SessionGCManager | null = null;
  private resourceMonitor: CliResourceMonitor | null = null;
  private initialized = false;
  private remoteBridgeAttached = false;
  private remoteServicesActivated = false;
  // Single-writer queue for remote-bridge state transitions (mirrors
  // `runRemoteTransportOp` in loro/doc.ts): attach/detach/revoke bodies never
  // interleave. Attach bodies are short (no meta catch-up wait), so a queued
  // detach/revoke stays prompt without any preemption machinery.
  private bridgeTransitionQueue: Promise<unknown> = Promise.resolve();
  private readonly sessionTerminatedHandlers = new Set<(sessionId: SessionId) => void>();

  constructor(private readonly options: MachineRuntimeOptions) {
    this.messageProcessor = new MessageProcessor(
      options.logger,
      options.maxConcurrentSessions ?? 30
    );
  }

  async initialize(): Promise<{
    sessionManager: SessionManager;
    messageHandler: MessageHandler;
  }> {
    if (this.initialized) {
      return {
        sessionManager: this.requireSessionManager(),
        messageHandler: this.requireHandler(),
      };
    }

    this.options.logger.debug('Initializing machine runtime');
    this.sessionManager = this.options.sessionManagerFactory();
    await traceAsync(this.options.logger, 'startup.session_manager', undefined, async () =>
      this.sessionManager!.initialize()
    );
    this.sessionManager.on('terminated', (event) => {
      for (const handler of this.sessionTerminatedHandlers) {
        handler(event.sessionId);
      }
    });
    this.options.logger.debug('Session manager initialized');

    this.handler = new MessageHandler(
      this.sessionManager,
      this.options.workspaceDocument,
      this.options.logger,
      this.options.handlerConfig
    );
    const machineId = this.options.handlerConfig.machineId as MachineId;
    this.resourceMonitor = new CliResourceMonitor(
      machineId,
      this.sessionManager,
      this.handler,
      this.options.memoryPressure,
      this.options.logger
    );
    this.options.workspaceDocument.configureMachineMonitor(
      machineId,
      () => this.resourceMonitor?.sample() ?? Promise.reject(new Error('Resource monitor stopped'))
    );
    // A dying ACP process ends any engine-opened turn it hosted: drop the
    // activity marker so busy status and the idle-GC guard release the session.
    this.onSessionTerminated((sessionId) => this.handler?.clearEngineTurnActivity(sessionId));
    this.initializeGCManager();
    this.initialized = true;

    await traceAsync(this.options.logger, 'startup.machine_registration', undefined, async () =>
      this.handler!.registerMachine()
    );
    void this.handler.ensureMachineRegistered();
    await traceAsync(this.options.logger, 'startup.dispatch_watcher', undefined, async () =>
      this.handler!.startSessionDispatchWatcher()
    );
    // Run stale-status reset AFTER bootstrapOwnedSessions (inside startSessionDispatchWatcher)
    // has loaded session docs into the sessions map. Running before that point reads an empty
    // list and resets nothing.
    void this.handler.resetMachineDisconnectedSessionsToIdle();
    // Recover desktop local-transport backfill tasks dropped by a prior CLI
    // restart (blobs still on disk = pending). Non-blocking; must not stall init.
    // No-ops until the remote bridge enables backfill (local-first gating).
    void this.handler.scanAndBackfillLocalSessionFiles();
    this.options.logger.debug('Machine runtime initialized');

    return {
      sessionManager: this.sessionManager,
      messageHandler: this.handler,
    };
  }

  getMessageHandler(): MessageHandler | null {
    return this.handler;
  }

  getSessionManager(): SessionManager | null {
    return this.sessionManager;
  }

  async resolveSessionWorkdir(sessionId: SessionId): Promise<string | null> {
    const sessionManager = this.requireSessionManager();
    const pendingSession = sessionManager.getPendingSession(sessionId);
    if (pendingSession) {
      const session = await pendingSession;
      return session.getWorkdir();
    }
    return sessionManager.getSession(sessionId)?.getWorkdir() ?? null;
  }

  onSessionTerminated(handler: (sessionId: SessionId) => void): () => void {
    this.sessionTerminatedHandlers.add(handler);
    return () => {
      this.sessionTerminatedHandlers.delete(handler);
    };
  }

  getActiveSessionCount(): number {
    return this.handler?.getActiveTurnCount() ?? 0;
  }

  isRemoteBridgeAttached(): boolean {
    return this.remoteBridgeAttached;
  }

  /**
   * Run one remote-bridge state transition at a time (single-writer queue,
   * mirroring `runRemoteTransportOp` in loro/doc.ts). Attach, detach, and
   * revoke bodies never interleave, so a completed successful attach can never
   * be torn down by the failure/rollback path of a racing or superseded one.
   */
  private runBridgeTransition<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.bridgeTransitionQueue.then(fn, fn);
    this.bridgeTransitionQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async attachRemoteBridge(): Promise<void> {
    await this.runBridgeTransition(() => this.attachRemoteBridgeInner());
  }

  private async attachRemoteBridgeInner(): Promise<void> {
    // The fleet re-runs attachAllowedRuntimes on every workspace-list tick;
    // once attached, skip the work instead of repeating it per tick. Checked
    // inside the queued body so it observes every earlier transition.
    if (this.remoteBridgeAttached) {
      return;
    }
    const handler = this.requireHandler();
    this.activateRemoteServices(handler);
    // Dual-author: the CLI only uploads its own authored ops, so attach does
    // not gate on a full meta catch-up — background room recovery converges.
    await this.options.workspaceDocument.attachRemoteStreamsTransport();
    this.remoteBridgeAttached = true;
    // Backfill enable flips its authorization flag synchronously (inside this
    // queued body); the scan itself is background work driven by cloud
    // reachability, decoupled from the attach transition.
    void handler.enableRemoteBackfillAndScan().catch((error: unknown) => {
      this.options.logger.debug(
        `Remote backfill scan failed after bridge attach: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
    handler.recheckPendingSessionAccess('remote-bridge-online');
  }

  private activateRemoteServices(handler: MessageHandler): void {
    if (this.remoteServicesActivated) {
      return;
    }
    this.remoteServicesActivated = true;
    void handler.activateRemoteServices();
  }

  async detachRemoteBridge(): Promise<void> {
    await this.runBridgeTransition(async () => {
      this.remoteBridgeAttached = false;
      this.handler?.disableRemoteBackfill();
      await this.options.workspaceDocument.detachRemoteStreamsTransport();
    });
  }

  async handleRemoteAccessRevoked(): Promise<void> {
    // Serialized behind any in-flight attach; disableRemoteBackfill bumps the
    // backfill authorization generation, so uploads started by a preceding
    // attach abort instead of adopting revoked output (S5 撤权不上传).
    await this.runBridgeTransition(async () => {
      this.remoteBridgeAttached = false;
      const handler = this.requireHandler();
      handler.disableRemoteBackfill();
      await this.options.workspaceDocument.detachRemoteStreamsTransport();
      await handler.cancelActiveTurnsForRemoteRevocation();
      handler.recheckPendingSessionAccess('remote-access-revoked');
    });
  }

  async cleanup(): Promise<void> {
    this.options.workspaceDocument.clearMachineMonitorProvider();
    this.resourceMonitor = null;
    if (this.gcManager) {
      this.gcManager.stop();
      this.gcManager = null;
    }

    this.messageProcessor.stop();
    this.handler?.cancelPendingPermissionRequests();
    await this.messageProcessor.drainWithTimeout(5000);

    if (this.handler) {
      await this.handler.cleanup();
      this.handler = null;
    } else {
      await this.sessionManager?.cleanUp();
    }

    this.sessionManager = null;
    this.initialized = false;
  }

  async dispatchLocalMessageForResponse(
    message: LocalSessionControlRequestValidated,
    options: { onResponse?: (response: LocalSessionControlResponse) => void } = {}
  ): Promise<LocalSessionControlResponse[]> {
    const handler = this.requireHandler();
    const dispatchStartedAt = Date.now();
    this.options.logger.debug(
      `Local control dispatch started type=${message.type} sessionId=${
        'sessionId' in message ? message.sessionId : 'N/A'
      } active=${this.messageProcessor.getActiveSessions()} waiting=${this.messageProcessor.getQueueSize()}`
    );

    return await new Promise<LocalSessionControlResponse[]>((resolve, reject) => {
      this.messageProcessor.enqueue(message, async (nextMessage) => {
        const responses: LocalSessionControlResponse[] = [];
        let settled = false;
        const resolveOnce = () => {
          if (settled) {
            return;
          }
          settled = true;
          this.options.logger.debug(
            `Local control dispatch resolved type=${message.type} sessionId=${
              'sessionId' in message ? message.sessionId : 'N/A'
            } duration=${Date.now() - dispatchStartedAt}ms responses=${
              responses.length
            } active=${this.messageProcessor.getActiveSessions()} waiting=${this.messageProcessor.getQueueSize()}`
          );
          resolve([...responses]);
        };
        const rejectOnce = (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          this.options.logger.debug(
            `Local control dispatch rejected type=${message.type} sessionId=${
              'sessionId' in message ? message.sessionId : 'N/A'
            } duration=${Date.now() - dispatchStartedAt}ms: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          reject(error);
        };
        const context: MessageDispatchContext = {
          source: 'local',
          send: (response) => {
            const typed = response as LocalSessionControlResponse;
            responses.push(typed);
            options.onResponse?.(typed);

            const isImmediateCreateResponse =
              nextMessage.type === 'session/create' &&
              typed.type === 'session/create_response' &&
              typed.sessionId === nextMessage.sessionId;
            const isImmediateChatResponse =
              nextMessage.type === 'session/chat' &&
              typed.type === 'session/chat_response' &&
              typed.sessionId === nextMessage.sessionId &&
              typed.userTurnId === nextMessage.userTurnId;

            if (isImmediateCreateResponse || isImmediateChatResponse) {
              resolveOnce();
            }
          },
        };

        try {
          await handler.handleMessage(nextMessage, context);
          resolveOnce();
        } catch (error) {
          rejectOnce(error);
          throw error;
        }
      });
    });
  }

  async dispatchLocalMachineRpc(
    message: LocalMachineRpcRequestValidated
  ): Promise<LocalMachineRpcResponse> {
    const handler = this.requireHandler();
    return await handler.handleLocalMachineRpc(message);
  }

  private initializeGCManager(): void {
    if (!this.handler) {
      return;
    }

    const handler = this.handler;
    const gcConfig = loadGCConfig();

    this.gcManager = new SessionGCManager(gcConfig, {
      getSessionLastActivity: (sessionId) => handler.getLastActivity(sessionId),
      hasActiveTurn: (sessionId) => handler.hasActiveTurn(sessionId),
      hasActiveGoal: async (sessionId) => await handler.hasActiveGoal(sessionId),
      hasPendingUpdates: (sessionId) => handler.hasPendingUpdates(sessionId),
      hasPendingUserWork: async (sessionId) => await handler.hasPendingUserWork(sessionId),
      isArchiveInFlight: (sessionId) => handler.isArchiveInFlight(sessionId),
      cleanSession: (sessionId) => handler.cleanSessionForGC(sessionId),
      getSessionIds: () => handler.getTrackedSessionIds(),
      memoryPressure: this.options.memoryPressure,
      logger: this.options.logger,
    });

    this.gcManager.start();

    // Wire up memory pressure eviction now that GC manager is ready
    handler.setEvictForMemoryPressure(async (excludeSessionId) => {
      if (this.gcManager) {
        return await this.gcManager.evictForMemoryPressure(excludeSessionId);
      }
      return {
        availableMemoryBytes: 0,
        thresholdBytes: 0,
        hadMemoryPressure: false,
        stillUnderPressure: false,
        evictedSessionIds: [],
        pressureReason: null,
      };
    });
  }

  private requireSessionManager(): SessionManager {
    if (!this.sessionManager) {
      throw new Error('Session manager has not been initialized');
    }
    return this.sessionManager;
  }

  private requireHandler(): MessageHandler {
    if (!this.handler) {
      throw new Error('Message handler has not been initialized');
    }
    return this.handler;
  }
}
