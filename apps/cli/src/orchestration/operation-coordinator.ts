import { withTimeout } from '@/lib/loro/timeout-utils';
import { isSessionCollaborationStopped } from '@lody/shared';
import { Effect, Exit, Layer, ManagedRuntime } from 'effect';
import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { CoordinatorScope, type CoordinatorWorkflow } from './coordinator-workflow';
import { operationInboxLegacy, type OperationInboxLegacy } from './inbox/legacy';
import type { InboxBatch } from './inbox/model';
import { coordinatorSessionsLayer } from './platform/coordinator-sessions';
import { operationRepositoryLayer, ownedDatabaseLayer } from './platform/operations';

import type { RepoWatchHandle } from 'loro-repo';

import {
  buildMissingEmail,
  getServerNow,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  type LodyOperationItemResult,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type StoredLodyOperation,
  type WorkspaceId,
} from '@lody/shared';

import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { SessionDispatchWatcher } from '@/session/session-dispatch-watcher';
import type { SessionExecutionService } from '@/session/session-execution-service';
import type { SessionUserResolver } from '@/session/session-user-resolver';
import type { Logger } from '@/utils/logger';

import { getLodyOperationStorePath, LodyOperationStore } from './operation-store';

const WORKER_BOOT_ID = randomUUID();

export type LodyOperationCoordinatorOptions = {
  workspaceId: WorkspaceId;
  machineId: MachineId;
  userId: string;
  workspaceDocument: LoroDocumentManager;
  executionService: SessionExecutionService;
  dispatchWatcher: SessionDispatchWatcher;
  // Inbox turns run inside the requester's own Session, so they must carry
  // the requester's commit identity. Without it the continuation turn would
  // overwrite the session's git identity with a placeholder, and any commit it
  // makes would be authored by the daemon host instead of the requesting user.
  userResolver?: Pick<SessionUserResolver, 'resolve'>;
  logger: Logger;
  storeFactory?: () => LodyOperationStore;
  storePath?: string;
  now?: () => number;
  operationStoreWatchFactory?: (
    directory: string,
    onChange: (filename: string | Buffer | null) => void
  ) => Pick<FSWatcher, 'close'>;
  workerBootId?: string;
  /** Confirm authoritative input absence before replay; cloud requires remote catch-up. */
  confirmTargetReadable?: (docId: string, reason: string) => Promise<void>;
  materializeTarget: (
    operation: StoredLodyOperation,
    item: Extract<LodyOperationItemResult, { status: 'active' }>,
    index: number,
    signal: AbortSignal
  ) => Promise<void>;
};

export class LodyOperationCoordinator {
  private readonly storeFactory: () => LodyOperationStore;
  private readonly now: () => number;
  private readonly operationAbortControllers = new Map<string, AbortController>();
  private metaWatch: RepoWatchHandle | null = null;
  private store: LodyOperationStore | null = null;
  private storeWatch: Pick<FSWatcher, 'close'> | null = null;
  private started = false;
  private nativeEpoch: object | undefined;
  private nativeRuntime?: ManagedRuntime.ManagedRuntime<CoordinatorScope, unknown>;
  private nativeReady?: Promise<CoordinatorScope['Service']>;
  private nativeCore?: CoordinatorWorkflow;
  private nativeClose?: Promise<void>;
  private nativeCloseFailed = false;
  private readonly nativeRawWork = new Set<Promise<unknown>>();
  private inbox: OperationInboxLegacy | undefined;
  private shutdown: Promise<void> | undefined;
  private quiesceReceipt: Promise<void> | undefined;
  private quiesceFailure: unknown;
  private stoppedComplete = true;
  private shutdownFailure: unknown;
  private shutdownRecovery: Promise<void> | undefined;
  private readonly inboxExecutions = new Set<Promise<void>>();
  private readonly materializationClaimToken = randomUUID();
  private readonly workerBootId: string;

  constructor(private readonly options: LodyOperationCoordinatorOptions) {
    const storePath = options.storePath ?? getLodyOperationStorePath(options.machineId);
    this.storeFactory = options.storeFactory ?? (() => new LodyOperationStore(storePath));
    this.now = options.now ?? getServerNow;
    this.workerBootId = options.workerBootId ?? WORKER_BOOT_ID;
  }

  start(): void {
    if (this.started) return;
    if (!this.stoppedComplete) throw new Error('Coordinator shutdown is not complete');
    this.shutdown = undefined;
    this.shutdownFailure = undefined;
    this.shutdownRecovery = undefined;
    this.quiesceReceipt = undefined;
    this.quiesceFailure = undefined;

    this.stoppedComplete = false;
    this.started = true;
    this.metaWatch = this.options.workspaceDocument.repo.watch(
      (event) => {
        if (event.kind !== 'doc-metadata') return;
        void this.wake('session-meta');
      },
      { kinds: ['doc-metadata'] }
    );
    // SQLite does the serialization; this watcher is only a cross-process wake
    // hint. Every wake re-reads durable state, so coalesced or duplicate file
    // events cannot affect correctness.
    //
    // The store connection MUST stay open for the coordinator's lifetime:
    // closing the last SQLite connection checkpoints and deletes the WAL/SHM
    // sidecar files, so per-reconcile open/close makes this directory watcher
    // observe its own file churn and wake itself in a loop that starves the
    // event loop (multiple workspace coordinators watching the shared
    // machine-level store amplify it).
    this.store = this.storeFactory();
    this.store.inbox.activate(this.options.workspaceId, this.workerBootId);
    this.inbox = operationInboxLegacy({
      workspaceId: this.options.workspaceId,
      owner: this.workerBootId,
      sql: this.store.inbox,
      ownsConnection: false,
      openRecoveryRepository: () => {
        const store = this.storeFactory();
        return { sql: store.inbox, close: () => store.close() };
      },
      quiesce: () => this.options.executionService.quiesceInboxExecutions?.(),
      ready: (batch) => {
        if (!this.started) return false;
        const sessionId = batch.sessionId as SessionId;
        const execution = this.options.executionService.getExecutionSnapshot(sessionId);
        // A delivery waiting on an unconfirmed release asks for its recovery; a
        // successful recovery wakes the Inbox, which runs this check again.
        if (execution.releaseBlocked)
          void this.options.executionService.requestReleaseRecovery?.(sessionId);
        return (
          !execution.hasActiveTurn && !this.options.dispatchWatcher.hasPendingDispatch(sessionId)
        );
      },
      admit: (batch) =>
        this.started &&
        (batch.kind !== 'automatic' ||
          !this.options.dispatchWatcher.hasPendingDispatch(batch.sessionId as SessionId)),
      launch: (batch) => {
        const pending = this.launchInboxBatch(batch);
        this.inboxExecutions.add(pending);
        void pending.finally(() => this.inboxExecutions.delete(pending)).catch(() => undefined);
        return pending;
      },
      report: (cause) => this.options.logger.warn(`[inbox] ${String(cause)}`),
    });
    this.options.executionService.setOperationInbox?.(this.inbox, (sessionId) => {
      void this.options.dispatchWatcher.enqueueSessionCheck?.(sessionId);
    });

    const epoch = {};
    this.nativeEpoch = epoch;
    const program = CoordinatorScope.layer({
      workspaceId: this.options.workspaceId,
      machineId: this.options.machineId,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          ownedDatabaseLayer(this.store),
          operationRepositoryLayer(this.store),
          coordinatorSessionsLayer(
            this.options,
            this.store,
            this.inbox,
            () => this.started && this.nativeEpoch === epoch,
            (effect) => {
              if (this.started && this.nativeEpoch === epoch) Effect.runSync(effect);
            },
            this.operationAbortControllers,
            this.nativeRawWork,
            this.materializationClaimToken
          )
        )
      )
    );
    this.nativeRuntime = ManagedRuntime.make(program);
    this.nativeReady = this.nativeRuntime.runPromise(CoordinatorScope);
    void this.nativeReady
      .then((value) => {
        this.nativeCore = value.core;
      })
      .catch((cause) => this.options.logger.warn(String(cause)));
    this.nativeClose = undefined;
    this.nativeCloseFailed = false;
    const storePath = this.options.storePath ?? getLodyOperationStorePath(this.options.machineId);
    const storeBasename = path.basename(storePath);
    const watchOperationStore =
      this.options.operationStoreWatchFactory ??
      ((directory: string, onChange: (filename: string | Buffer | null) => void) =>
        watch(directory, (_event, filename) => onChange(filename)));
    const runtime = this.nativeRuntime;
    const ready = this.nativeReady;
    this.storeWatch = watchOperationStore(path.dirname(storePath), (filename) => {
      if (!this.started || this.nativeEpoch !== epoch) return;
      if (!filename || !filename.toString().startsWith(storeBasename)) return;
      this.abortTerminalCoordinators();
      void ready
        .then(({ activity }) => {
          if (!this.started || this.nativeEpoch !== epoch) return Promise.resolve();
          return runtime.runPromise(activity.arm('store', 10, 'operation-store'));
        })
        .catch((cause) => this.options.logger.warn(String(cause)));
    });
    void this.wake('startup');
  }

  hasPendingWorkForRequester(sessionId: SessionId): boolean {
    return this.store?.hasPendingWorkForRequester(this.options.workspaceId, sessionId) ?? true;
  }

  stop(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.started = false;
    this.metaWatch?.unsubscribe();
    this.metaWatch = null;
    this.storeWatch?.close();
    this.storeWatch = null;
    this.quiesceReceipt = this.inbox?.quiesce() ?? Promise.resolve();
    void this.quiesceReceipt.catch((cause) => {
      this.quiesceFailure = cause;
    });
    for (const controller of this.operationAbortControllers.values()) controller.abort();
    this.operationAbortControllers.clear();
    this.shutdown = this.finishStop().catch((cause) => {
      this.shutdownFailure = cause;
      throw cause;
    });
    return this.shutdown;
  }

  private async finishStop(): Promise<void> {
    await this.quiesceReceipt;
    // Keep the native runtime/connection alive for the final release and settlement receipts.
    await withTimeout(
      (async () => {
        await this.idle();
        await this.options.executionService.drainInboxExecutions?.();
        await Promise.allSettled([...this.inboxExecutions, ...this.nativeRawWork]);
      })(),
      15_000,
      'Coordinator resources did not drain'
    );
    await this.inbox?.close();
    if (this.nativeCloseFailed) {
      if (this.nativeCore) await Effect.runPromise(this.nativeCore.recoverSubscriptions());
    } else {
      this.nativeClose ??= Effect.runPromiseExit(this.nativeRuntime!.disposeEffect)
        .then((exit) => {
          if (Exit.isFailure(exit))
            throw new Error('Coordinator Scope release failed', { cause: exit.cause });
        })
        .catch((cause) => {
          this.nativeCloseFailed = true;
          throw cause;
        });
      await this.nativeClose;
    }
    this.options.executionService.setOperationInbox?.(undefined);
    this.store?.close();
    this.store = null;
    this.stoppedComplete = true;
  }
  recoverStop(): Promise<void> {
    if (this.stoppedComplete) return Promise.resolve();
    if (!this.shutdownFailure) return this.stop();
    if (this.shutdownRecovery) return this.shutdownRecovery;
    const recovery = (async () => {
      if (this.quiesceFailure) {
        this.quiesceFailure = undefined;
        this.quiesceReceipt = this.inbox?.quiesce();
        await this.quiesceReceipt;
      }
      await this.options.executionService.recoverUnreleasedInboxExecutions?.();
      // close() deliberately preserves its original failure receipt. Retry only
      // retained durable receipts through the independent recovery owner.
      await this.inbox?.recoverClose();
      await this.finishStop();
    })();
    this.shutdownRecovery = recovery;
    void recovery
      .finally(() => {
        if (this.shutdownRecovery === recovery) this.shutdownRecovery = undefined;
      })
      .catch(() => undefined);
    return recovery;
  }

  wake(reason: string): Promise<void> {
    if (!this.started) return Promise.resolve();
    const epoch = this.nativeEpoch;
    const runtime = this.nativeRuntime!;
    return this.nativeReady!.then(({ activity }) => {
      if (!this.started || this.nativeEpoch !== epoch) return Promise.resolve();
      return runtime.runPromise(activity.wake(reason));
    }).catch((cause) => this.options.logger.warn(String(cause)));
  }
  async idle(): Promise<void> {
    if (!this.nativeReady) return;
    if (this.nativeClose) return;
    const { activity } = await this.nativeReady;
    await this.nativeRuntime!.runPromise(activity.drain);
  }
  private operationKey(operation: StoredLodyOperation): string {
    return `${operation.requesterSessionId}\0${operation.operationId}`;
  }

  private abortTerminalCoordinators(): void {
    if (!this.started || this.operationAbortControllers.size === 0) return;
    try {
      const active = this.store!.listActive(this.options.workspaceId, this.options.machineId);
      const keys = new Set(active.map((operation) => this.operationKey(operation)));
      for (const [key, controller] of this.operationAbortControllers)
        if (!keys.has(key)) {
          controller.abort();
          this.operationAbortControllers.delete(key);
        }
    } catch (error) {
      this.options.logger.debug(
        `[orchestration] Could not refresh coordinator cancellation state: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async launchInboxBatch(batch: InboxBatch): Promise<void> {
    if (!this.started || !this.store) return;
    const sessionId = batch.sessionId as SessionId;
    const record = await this.options.workspaceDocument.repo.getDocMeta(
      getSessionRoomId(sessionId)
    );
    if (!this.started || !record?.meta || isLoroRepoDocDeleted(record)) return;
    const meta = record.meta as SessionMeta;
    if (
      meta.isArchived ||
      meta.machineId !== this.options.machineId ||
      (await isSessionCollaborationStopped(this.options.workspaceDocument.repo, sessionId))
    )
      return;
    const cliType = batch.config.cliType ?? meta.cliType;
    if (!cliType) return;
    const requester = await this.resolveRequesterIdentity(batch.userId);
    if (!this.started) return;
    await this.options.executionService.continueSession(
      {
        type: 'session/chat',
        sessionId,
        machineId: this.options.machineId,
        workspaceId: this.options.workspaceId,
        userTurnId: batch.inputId,
        userId: batch.userId,
        userName: requester.name,
        userEmail: requester.email,
        acpSessionConfig: {
          ...batch.config,
          cliType,
          agentType: batch.config.agentType ?? meta.agentType,
          prompt: 'Review the completed results according to the current conversation request.',
          inputBlocks: undefined,
          resume: meta.acpSessionId ?? undefined,
          chainDepth: batch.chainDepth,
        },
      },
      { dispatchSource: 'inbox', inboxBatch: batch }
    );
  }

  private async resolveRequesterIdentity(
    requesterUserId: string
  ): Promise<{ name: string; email: string }> {
    const fallback = {
      name: requesterUserId,
      email: buildMissingEmail('lody', requesterUserId),
    };
    const resolver = this.options.userResolver;
    if (!resolver) {
      return fallback;
    }
    try {
      const profile = await resolver.resolve(requesterUserId);
      return { name: profile.name, email: profile.email };
    } catch (error) {
      this.options.logger.debug(
        `[operation-coordinator] Failed to resolve requester identity ${requesterUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return fallback;
    }
  }
}
