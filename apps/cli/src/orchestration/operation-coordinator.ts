import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import type { RepoWatchHandle } from 'loro-repo';

import {
  buildMissingEmail,
  getServerNow,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  makeLodyError,
  type AgentConfigId,
  type LodyOperationCompletion,
  type LodyOperationItemResult,
  type MachineId,
  type MessageContent,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type StoredLodyDelivery,
  type StoredLodyOperation,
  type WorkspaceId,
} from '@lody/shared';

import {
  readMergedAgentConfigById,
  type AgentConfigPointLookup,
} from '@/lib/agent-config-machine-flock';
import type { LoroDocumentManager, SessionDocument } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import type { SessionDispatchWatcher } from '@/session/session-dispatch-watcher';
import type { SessionExecutionService } from '@/session/session-execution-service';
import type { SessionUserResolver } from '@/session/session-user-resolver';

import { getLodyOperationStorePath, LodyOperationStore } from './operation-store';

type TargetSubscription = {
  unsubscribe: () => void;
};

const TARGET_OUTPUT_PREVIEW_MAX_BYTES = 8 * 1024;
const MATERIALIZATION_RETRY_MIN_MS = 1_000;
const MATERIALIZATION_RETRY_MAX_MS = 30_000;
// A Delivery that could not run within this grace window after its Operation's
// deadline is expired instead of dispatched: waking a Session with a
// continuation turn for work that ended long ago (stranded store, daemon down
// for days) surprises the user and spends tokens on a stale result. The
// default Operation deadline is 24h, so a legitimately finished completion
// always has at least this window to reach the requester's idle boundary.
const DELIVERY_EXPIRY_GRACE_MS = 8 * 60 * 60 * 1_000;

const truncateTargetOutput = (
  text: string
): { text: string; truncated?: true; omittedBytes?: number } => {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= TARGET_OUTPUT_PREVIEW_MAX_BYTES) return { text };
  const marker = '\n…\n';
  const characters = Array.from(text);
  const render = (keptCharacters: number) => {
    const headCount = Math.ceil(keptCharacters / 2);
    const tailCount = keptCharacters - headCount;
    return `${characters.slice(0, headCount).join('')}${marker}${characters
      .slice(characters.length - tailCount)
      .join('')}`;
  };
  let low = 0;
  let high = characters.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(render(middle), 'utf8') <= TARGET_OUTPUT_PREVIEW_MAX_BYTES) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const headCount = Math.ceil(best / 2);
  const tailCount = best - headCount;
  const kept = `${characters.slice(0, headCount).join('')}${characters
    .slice(characters.length - tailCount)
    .join('')}`;
  return {
    text: render(best),
    truncated: true,
    omittedBytes: originalBytes - Buffer.byteLength(kept, 'utf8'),
  };
};

const assistantOutputPreview = (
  assistant: Pick<SessionHistoryInput, 'items'>
): ReturnType<typeof truncateTargetOutput> | undefined => {
  const text = (assistant.items ?? [])
    .filter((item): item is Extract<MessageContent, { type: 'text' }> => item.type === 'text')
    .map((item) => item.text)
    .filter((item) => item.length > 0)
    .join('\n\n');
  return text.length > 0 ? truncateTargetOutput(text) : undefined;
};

export type LodyOperationCoordinatorOptions = {
  workspaceId: WorkspaceId;
  machineId: MachineId;
  userId: string;
  workspaceDocument: LoroDocumentManager;
  executionService: SessionExecutionService;
  dispatchWatcher: SessionDispatchWatcher;
  // Delivery turns run inside the requester's own Session, so they must carry
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
  materializeTarget: (
    operation: StoredLodyOperation,
    item: Extract<LodyOperationItemResult, { status: 'active' }>,
    index: number,
    signal: AbortSignal
  ) => Promise<void>;
};

const terminalAssistantFor = (
  history: SessionHistoryInput[],
  userTurnId: string
): SessionHistoryInput | undefined =>
  history.find(
    (entry) =>
      entry.role === 'assistant' &&
      entry.userTurnId === userTurnId &&
      (entry.finished === true || typeof entry.endedAt === 'number')
  );

const completionText = (operation: StoredLodyOperation): string =>
  [
    `Lody Operation ${operation.operationId} (${operation.kind}) finished.`,
    'Use the structured completion below to continue the user task. Do not restart completed targets.',
    JSON.stringify(operation.completion),
  ].join('\n\n');

export class LodyOperationCoordinator {
  private readonly storeFactory: () => LodyOperationStore;
  private readonly now: () => number;
  private readonly targetSubscriptions = new Map<string, TargetSubscription>();
  private readonly deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly materializationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly materializationRetryAttempts = new Map<string, number>();
  private readonly configurationTimers = new Map<SessionId, ReturnType<typeof setTimeout>>();
  private readonly reconcileChains = new Map<string, Promise<void>>();
  private readonly deliveryChains = new Map<SessionId, Promise<void>>();
  private readonly queuedDeliveryIds = new Set<string>();
  private readonly dirtyDeliveryReasons = new Map<string, string>();
  private readonly operationAbortControllers = new Map<string, AbortController>();
  private metaWatch: RepoWatchHandle | null = null;
  private store: LodyOperationStore | null = null;
  private storeWatch: Pick<FSWatcher, 'close'> | null = null;
  private storeWakeTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private readonly materializationClaimToken = randomUUID();

  constructor(private readonly options: LodyOperationCoordinatorOptions) {
    const storePath = options.storePath ?? getLodyOperationStorePath(options.machineId);
    this.storeFactory = options.storeFactory ?? (() => new LodyOperationStore(storePath));
    this.now = options.now ?? getServerNow;
  }

  start(): void {
    if (this.started) return;
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
    const storePath = this.options.storePath ?? getLodyOperationStorePath(this.options.machineId);
    const storeBasename = path.basename(storePath);
    const watchOperationStore =
      this.options.operationStoreWatchFactory ??
      ((directory: string, onChange: (filename: string | Buffer | null) => void) =>
        watch(directory, (_event, filename) => onChange(filename)));
    this.storeWatch = watchOperationStore(path.dirname(storePath), (filename) => {
      if (!filename || !filename.toString().startsWith(storeBasename)) return;
      // Coalesce event bursts on the leading edge: a pending timer already
      // covers this event, and resetting it per event would let a sustained
      // event stream defer the wake indefinitely. The wake (and the
      // cancellation refresh) re-reads durable state, so batching is safe.
      if (this.storeWakeTimer) return;
      this.storeWakeTimer = setTimeout(() => {
        this.storeWakeTimer = null;
        this.abortTerminalCoordinators();
        void this.wake('operation-store');
      }, 10);
      this.storeWakeTimer.unref?.();
    });
    void this.wake('startup');
  }

  stop(): void {
    this.started = false;
    this.metaWatch?.unsubscribe();
    this.metaWatch = null;
    this.storeWatch?.close();
    this.storeWatch = null;
    if (this.storeWakeTimer) clearTimeout(this.storeWakeTimer);
    this.storeWakeTimer = null;
    this.store?.close();
    this.store = null;
    for (const subscription of this.targetSubscriptions.values()) {
      subscription.unsubscribe();
    }
    this.targetSubscriptions.clear();
    for (const timer of this.deadlineTimers.values()) {
      clearTimeout(timer);
    }
    this.deadlineTimers.clear();
    for (const timer of this.materializationTimers.values()) clearTimeout(timer);
    this.materializationTimers.clear();
    this.materializationRetryAttempts.clear();
    for (const timer of this.configurationTimers.values()) clearTimeout(timer);
    this.configurationTimers.clear();
    this.reconcileChains.clear();
    this.deliveryChains.clear();
    this.queuedDeliveryIds.clear();
    this.dirtyDeliveryReasons.clear();
    for (const controller of this.operationAbortControllers.values()) controller.abort();
    this.operationAbortControllers.clear();
  }

  wake(reason: string): Promise<void> {
    if (!this.started) return Promise.resolve();
    const key = 'workspace';
    const previous = this.reconcileChains.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => await this.reconcile(reason))
      .catch((error: unknown) => {
        this.options.logger.warn(
          `[orchestration] reconciliation failed (${reason}): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      })
      .finally(() => {
        if (this.reconcileChains.get(key) === next) {
          this.reconcileChains.delete(key);
        }
      });
    this.reconcileChains.set(key, next);
    return next;
  }

  async idle(): Promise<void> {
    await Promise.all([...this.reconcileChains.values()]);
    await Promise.all([...this.deliveryChains.values()]);
  }

  private withStore<T>(fn: (store: LodyOperationStore) => T): T {
    // Use the lifetime connection while started; see start() for why transient
    // open/close cycles are forbidden (WAL/SHM churn re-wakes the watcher).
    if (this.store) return fn(this.store);
    // In-flight chains can outlive stop(); fall back to a transient connection.
    const store = this.storeFactory();
    try {
      return fn(store);
    } finally {
      store.close();
    }
  }

  private async reconcile(reason: string): Promise<void> {
    if (!this.started) return;
    const active = this.withStore((store) =>
      store.listActive(this.options.workspaceId, this.options.machineId)
    );
    const activeKeys = new Set(active.map((operation) => this.operationKey(operation)));
    this.dropInactiveResources(activeKeys);

    for (const operation of active) {
      await this.reconcileOperation(operation);
    }

    const pendingDeliveries = this.withStore((store) =>
      store.listPendingDeliveries(this.options.workspaceId)
    );
    for (const delivery of pendingDeliveries) {
      this.enqueueDelivery(delivery, reason);
    }
  }

  private async reconcileOperation(operation: StoredLodyOperation): Promise<void> {
    this.armDeadline(operation);
    const key = this.operationKey(operation);
    const controller = this.operationAbortControllers.get(key) ?? new AbortController();
    this.operationAbortControllers.set(key, controller);
    const isAtDeadline = () => this.now() >= Date.parse(operation.deadlineAt);
    let items: LodyOperationItemResult[];
    try {
      items = await this.mapItemsWithConcurrency(
        operation.items,
        5,
        async (item, index) =>
          await this.reconcileItem(operation, item, index, isAtDeadline, controller.signal)
      );
    } catch (error) {
      if (!isAtDeadline()) throw error;
      this.withStore((store) =>
        store.finish(operation.requesterSessionId, operation.operationId, {
          type: 'error',
          error: makeLodyError(
            'COORDINATOR_FAILED',
            `Operation could not read trustworthy target state at its deadline: ${
              error instanceof Error ? error.message : String(error)
            }`,
            false
          ),
        })
      );
      this.clearDeadline(operation);
      this.clearOperationMaterializationRetries(operation);
      return;
    }
    const changed = JSON.stringify(items) !== JSON.stringify(operation.items);
    if (changed) {
      this.withStore((store) =>
        store.updateItems(operation.requesterSessionId, operation.operationId, items)
      );
    }
    if (items.every((item) => item.status !== 'active')) {
      const completion: LodyOperationCompletion = { type: 'result', value: { items } };
      this.withStore((store) =>
        store.finish(operation.requesterSessionId, operation.operationId, completion)
      );
      this.clearDeadline(operation);
      this.clearOperationMaterializationRetries(operation);
    }
  }

  private async reconcileItem(
    operation: StoredLodyOperation,
    item: LodyOperationItemResult,
    index: number,
    isAtDeadline: () => boolean,
    signal: AbortSignal
  ): Promise<LodyOperationItemResult> {
    if (item.status !== 'active') return item;
    if (signal.aborted) return item;
    const target = item.target;
    if (!item.inputDurable) {
      let alreadyMaterialized = await this.isTargetInputDurable(
        target.sessionId,
        target.userTurnId
      );
      let claimedMaterialization = false;
      if (
        !alreadyMaterialized &&
        !isAtDeadline() &&
        this.hasMaterializationRetry(operation, index)
      ) {
        return item;
      }
      if (!alreadyMaterialized && !isAtDeadline()) {
        if (signal.aborted) return item;
        const claim = this.withStore((store) =>
          store.claimItemMaterialization(
            operation.requesterSessionId,
            operation.operationId,
            index,
            this.materializationClaimToken
          )
        );
        if (!claim.claimed) {
          if (claim.retryAtMs !== undefined) {
            this.armMaterializationRetry(operation, index, claim.retryAtMs);
          }
          return item;
        }
        claimedMaterialization = true;
        try {
          await this.options.workspaceDocument.syncRemoteDocOrThrow(
            getSessionRoomId(target.sessionId),
            {
              reason: `orchestration.materialize:${operation.operationId}:${index}`,
            }
          );
        } catch (error) {
          if (signal.aborted) return item;
          if (!isAtDeadline()) {
            const delayMs = this.armMaterializationFailureRetry(operation, index);
            this.options.logger.warn(
              `[orchestration] Target document catch-up was not confirmed ` +
                `(${operation.operationId}:${index}); retrying in ${delayMs}ms: ${
                  error instanceof Error ? error.message : String(error)
                }`
            );
            return item;
          }
        }
        if (signal.aborted) return item;
        alreadyMaterialized = await this.isTargetInputDurable(target.sessionId, target.userTurnId);
      }
      if (!alreadyMaterialized && !isAtDeadline()) {
        try {
          await this.options.materializeTarget(operation, item, index, signal);
        } catch (error) {
          if (signal.aborted) return item;
          const delayMs = this.armMaterializationFailureRetry(operation, index);
          this.options.logger.warn(
            `[orchestration] Target materialization failed ` +
              `(${operation.operationId}:${index}); retrying in ${delayMs}ms: ${
                error instanceof Error ? error.message : String(error)
              }`
          );
          return item;
        }
        if (signal.aborted) return item;
        alreadyMaterialized = true;
      }
      if (!alreadyMaterialized) {
        this.clearMaterializationRetry(operation, index);
        return {
          status: 'failed',
          ...(item.label ? { label: item.label } : {}),
          target: item.target,
          error: makeLodyError(
            'TARGET_TIMEOUT',
            'Target input was not durably materialized before the Operation deadline.',
            false
          ),
        };
      }
      this.withStore((store) =>
        store.markItemInputDurable(
          operation.requesterSessionId,
          operation.operationId,
          index,
          claimedMaterialization ? this.materializationClaimToken : undefined
        )
      );
      this.clearMaterializationRetry(operation, index);
      item = { ...item, inputDurable: true };
    }

    const metaRecord = await this.options.workspaceDocument.repo.getDocMeta(
      getSessionRoomId(item.target.sessionId)
    );
    if (!metaRecord?.meta || isLoroRepoDocDeleted(metaRecord)) {
      return isAtDeadline()
        ? {
            status: 'failed',
            ...(item.label ? { label: item.label } : {}),
            target: item.target,
            error: makeLodyError(
              'TARGET_TIMEOUT',
              'Target state was unavailable when the Operation deadline was enforced.',
              false
            ),
          }
        : item;
    }

    const sessionDoc = await this.options.workspaceDocument.getOrCreateSessionDoc(
      item.target.sessionId
    );
    this.subscribeTarget(item.target.sessionId, sessionDoc);
    const history = await sessionDoc.getHistory();
    const userTurn = history.find(
      (entry) => entry.id === item.target.userTurnId && entry.role === 'user'
    );
    const assistant = terminalAssistantFor(history, item.target.userTurnId);
    if (userTurn?.status === 'failed') {
      return {
        status: 'failed',
        ...(item.label ? { label: item.label } : {}),
        target: item.target,
        error: makeLodyError('TARGET_FAILED', 'Target Turn failed.', false),
      };
    }
    if (userTurn?.status === 'canceled') {
      return {
        status: 'cancelled',
        ...(item.label ? { label: item.label } : {}),
        target: item.target,
      };
    }
    if (assistant) {
      const output = assistantOutputPreview(assistant);
      return {
        status: 'succeeded',
        ...(item.label ? { label: item.label } : {}),
        target: item.target,
        assistantTurnId: assistant.id,
        ...(output ? { output } : {}),
      };
    }
    if (isAtDeadline()) {
      return {
        status: 'failed',
        ...(item.label ? { label: item.label } : {}),
        target: item.target,
        error: makeLodyError(
          'TARGET_TIMEOUT',
          'Target Turn was not terminal when the Operation deadline was enforced.',
          false
        ),
      };
    }
    return item;
  }

  private async isTargetInputDurable(sessionId: SessionId, userTurnId: string): Promise<boolean> {
    const metaRecord = await this.options.workspaceDocument.repo.getDocMeta(
      getSessionRoomId(sessionId)
    );
    if (!metaRecord?.meta || isLoroRepoDocDeleted(metaRecord)) {
      return false;
    }
    const sessionDoc = await this.options.workspaceDocument.getOrCreateSessionDoc(sessionId);
    const history = await sessionDoc.getHistory();
    const userTurn = history.find((entry) => entry.id === userTurnId && entry.role === 'user');
    if (!userTurn) return false;
    const meta = metaRecord.meta as SessionMeta;
    return (
      meta.latestUserMsgId === userTurnId ||
      meta.processingUserMsgId === userTurnId ||
      meta.lastHandledUserMsgId === userTurnId ||
      userTurn.status === 'handled' ||
      userTurn.status === 'failed' ||
      userTurn.status === 'canceled' ||
      terminalAssistantFor(history, userTurnId) !== undefined
    );
  }

  private subscribeTarget(sessionId: SessionId, sessionDoc: SessionDocument): void {
    if (this.targetSubscriptions.has(sessionId)) return;
    const unsubscribe =
      sessionDoc.mirror?.subscribe(() => {
        void this.wake('target-history');
      }) ?? (() => {});
    this.targetSubscriptions.set(sessionId, { unsubscribe });
  }

  private armDeadline(operation: StoredLodyOperation): void {
    const key = this.operationKey(operation);
    if (this.deadlineTimers.has(key)) return;
    const delay = Math.max(0, Date.parse(operation.deadlineAt) - this.now());
    const timer = setTimeout(
      () => {
        this.deadlineTimers.delete(key);
        void this.wake('deadline');
      },
      Math.min(delay, 2_147_483_647)
    );
    timer.unref?.();
    this.deadlineTimers.set(key, timer);
  }

  private armMaterializationRetry(
    operation: StoredLodyOperation,
    itemIndex: number,
    retryAtMs: number,
    wakeReason = 'materialization-claim-expired'
  ): void {
    const key = `${this.operationKey(operation)}\0${itemIndex}`;
    if (this.materializationTimers.has(key)) return;
    const timer = setTimeout(
      () => {
        this.materializationTimers.delete(key);
        void this.wake(wakeReason);
      },
      Math.max(0, retryAtMs - this.now())
    );
    timer.unref?.();
    this.materializationTimers.set(key, timer);
  }

  private armMaterializationFailureRetry(
    operation: StoredLodyOperation,
    itemIndex: number
  ): number {
    const key = this.materializationKey(operation, itemIndex);
    const attempt = this.materializationRetryAttempts.get(key) ?? 0;
    const exponent = Math.min(
      attempt,
      Math.ceil(Math.log2(MATERIALIZATION_RETRY_MAX_MS / MATERIALIZATION_RETRY_MIN_MS))
    );
    const delayMs = Math.min(
      MATERIALIZATION_RETRY_MIN_MS * 2 ** exponent,
      MATERIALIZATION_RETRY_MAX_MS
    );
    this.materializationRetryAttempts.set(key, exponent + 1);
    const now = this.now();
    const retryAtMs = Math.min(now + delayMs, Date.parse(operation.deadlineAt));
    this.armMaterializationRetry(operation, itemIndex, retryAtMs, 'materialization-retry');
    return Math.max(0, retryAtMs - now);
  }

  private hasMaterializationRetry(operation: StoredLodyOperation, itemIndex: number): boolean {
    return this.materializationTimers.has(this.materializationKey(operation, itemIndex));
  }

  private clearMaterializationRetry(operation: StoredLodyOperation, itemIndex: number): void {
    const key = this.materializationKey(operation, itemIndex);
    const timer = this.materializationTimers.get(key);
    if (timer) clearTimeout(timer);
    this.materializationTimers.delete(key);
    this.materializationRetryAttempts.delete(key);
  }

  private clearOperationMaterializationRetries(operation: StoredLodyOperation): void {
    const prefix = `${this.operationKey(operation)}\0`;
    for (const [key, timer] of this.materializationTimers) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(timer);
      this.materializationTimers.delete(key);
    }
    for (const key of this.materializationRetryAttempts.keys()) {
      if (key.startsWith(prefix)) this.materializationRetryAttempts.delete(key);
    }
  }

  private clearDeadline(operation: StoredLodyOperation): void {
    const key = this.operationKey(operation);
    const timer = this.deadlineTimers.get(key);
    if (timer) clearTimeout(timer);
    this.deadlineTimers.delete(key);
  }

  private operationKey(operation: StoredLodyOperation): string {
    return `${operation.requesterSessionId}\0${operation.operationId}`;
  }

  private materializationKey(operation: StoredLodyOperation, itemIndex: number): string {
    return `${this.operationKey(operation)}\0${itemIndex}`;
  }

  private dropInactiveResources(activeKeys: Set<string>): void {
    for (const [key, timer] of this.deadlineTimers) {
      if (!activeKeys.has(key)) {
        clearTimeout(timer);
        this.deadlineTimers.delete(key);
      }
    }
    for (const [key, controller] of this.operationAbortControllers) {
      if (!activeKeys.has(key)) {
        controller.abort();
        this.operationAbortControllers.delete(key);
      }
    }
    for (const [key, timer] of this.materializationTimers) {
      const active = [...activeKeys].some((operationKey) => key.startsWith(`${operationKey}\0`));
      if (active) continue;
      clearTimeout(timer);
      this.materializationTimers.delete(key);
      this.materializationRetryAttempts.delete(key);
    }
    for (const key of this.materializationRetryAttempts.keys()) {
      const active = [...activeKeys].some((operationKey) => key.startsWith(`${operationKey}\0`));
      if (!active) this.materializationRetryAttempts.delete(key);
    }
  }

  private abortTerminalCoordinators(): void {
    if (!this.started || this.operationAbortControllers.size === 0) return;
    try {
      const active = this.withStore((store) =>
        store.listActive(this.options.workspaceId, this.options.machineId)
      );
      this.dropInactiveResources(new Set(active.map((operation) => this.operationKey(operation))));
    } catch (error) {
      this.options.logger.debug(
        `[orchestration] Could not refresh coordinator cancellation state: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async mapItemsWithConcurrency<T, R>(
    values: readonly T[],
    concurrency: number,
    map: (value: T, index: number) => Promise<R>
  ): Promise<R[]> {
    const output = new Array<R>(values.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) output[index] = await map(value, index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
    return output;
  }

  private enqueueDelivery(delivery: StoredLodyDelivery, reason: string): void {
    if (this.queuedDeliveryIds.has(delivery.deliveryId)) {
      // A wake can carry the state transition that makes an earlier transient
      // return runnable. Coalesce duplicates, but remember to make one serial
      // follow-up attempt after the current attempt finishes.
      this.dirtyDeliveryReasons.set(delivery.deliveryId, reason);
      return;
    }
    this.queuedDeliveryIds.add(delivery.deliveryId);
    const sessionId = delivery.requesterSessionId;
    const previous = this.deliveryChains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        let attemptReason = reason;
        for (;;) {
          this.dirtyDeliveryReasons.delete(delivery.deliveryId);
          try {
            await this.deliverIfRunnable(delivery, attemptReason);
          } catch (error: unknown) {
            this.options.logger.warn(
              `[orchestration] Delivery ${delivery.deliveryId} failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
          const coalescedReason = this.dirtyDeliveryReasons.get(delivery.deliveryId);
          if (!this.started || !coalescedReason || !this.isDeliveryPending(delivery)) {
            return;
          }
          attemptReason = coalescedReason;
        }
      })
      .catch((error: unknown) => {
        this.options.logger.warn(
          `[orchestration] Delivery ${delivery.deliveryId} coalesced retry failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      })
      .finally(() => {
        const lateCoalescedReason = this.dirtyDeliveryReasons.get(delivery.deliveryId);
        this.queuedDeliveryIds.delete(delivery.deliveryId);
        this.dirtyDeliveryReasons.delete(delivery.deliveryId);
        if (this.deliveryChains.get(sessionId) === next) {
          this.deliveryChains.delete(sessionId);
        }
        // A wake can land after the worker loop decides it is clean but before
        // this chain's Promise settles. Clear this chain's ownership first so
        // the follow-up is enqueued behind any newer session work.
        if (this.started && lateCoalescedReason && this.isDeliveryPending(delivery)) {
          this.enqueueDelivery(delivery, lateCoalescedReason);
        }
      });
    this.deliveryChains.set(sessionId, next);
  }

  private isDeliveryPending(delivery: StoredLodyDelivery): boolean {
    return this.withStore((store) =>
      store
        .listPendingDeliveries(this.options.workspaceId, delivery.requesterSessionId)
        .some((candidate) => candidate.deliveryId === delivery.deliveryId)
    );
  }

  private async deliverIfRunnable(delivery: StoredLodyDelivery, reason: string): Promise<void> {
    if (!this.started) return;
    const metaRecord = await this.options.workspaceDocument.repo.getDocMeta(
      getSessionRoomId(delivery.requesterSessionId)
    );
    if (!metaRecord?.meta || isLoroRepoDocDeleted(metaRecord)) return;
    const meta = metaRecord.meta as SessionMeta;
    if (meta.isArchived || meta.machineId !== this.options.machineId) return;
    const sessionDoc = await this.options.workspaceDocument.getOrCreateSessionDoc(
      delivery.requesterSessionId
    );
    this.subscribeTarget(delivery.requesterSessionId, sessionDoc);

    // Durable recovery evidence is deliberately checked before configuration
    // lookup or remote sync. A completed continuation (or an authoritative
    // unavailable completion) must only consume the Delivery, regardless of
    // repo-meta size or later configuration changes. An active turn alone is
    // not durable evidence: leave the Delivery pending until history records an
    // assistant response or chat_failed notice.
    const execution = this.options.executionService.getExecutionSnapshot(
      delivery.requesterSessionId
    );
    const historyBeforeDispatch = await sessionDoc.getHistory();
    const continuationEvidence = this.getContinuationEvidence(
      historyBeforeDispatch,
      delivery.systemTurnId
    );
    if (continuationEvidence) {
      this.consumeDelivery(delivery, reason, continuationEvidence);
      return;
    }
    const operation = this.withStore((store) =>
      store.get(delivery.requesterSessionId, delivery.operationId)
    );
    if (this.now() >= Date.parse(operation.deadlineAt) + DELIVERY_EXPIRY_GRACE_MS) {
      this.consumeDelivery(delivery, reason, 'expired_stale');
      return;
    }
    if (execution.hasActiveTurn) return;
    if (this.options.dispatchWatcher.hasPendingDispatch(delivery.requesterSessionId)) return;

    const configuration = await this.resolveFrozenConfiguration(operation, delivery, reason);
    if (configuration === 'unknown') {
      this.armConfigurationRetry(delivery.requesterSessionId);
      return;
    }
    if (configuration === 'unavailable') {
      await this.writeCompletionTurn(sessionDoc, operation, delivery, false);
      this.consumeDelivery(delivery, reason, 'configuration_unavailable');
      return;
    }

    const frozen = operation.frozenContinuationConfig.inputConfig;
    const requester = await this.resolveRequesterIdentity(operation.requesterUserId);
    await this.options.executionService.continueSession(
      {
        type: 'session/chat',
        sessionId: delivery.requesterSessionId,
        machineId: this.options.machineId,
        workspaceId: this.options.workspaceId,
        acpSessionConfig: {
          prompt: completionText(operation),
          cliType: frozen.cliType ?? meta.cliType,
          agentType: frozen.agentType ?? meta.agentType,
          ...(frozen.customAcp ? { customAcp: frozen.customAcp } : {}),
          ...(frozen.runtimeOverrides ? { runtimeOverrides: frozen.runtimeOverrides } : {}),
          ...(frozen.modeId ? { modeId: frozen.modeId } : {}),
          ...(frozen.modelId ? { modelId: frozen.modelId } : {}),
          ...(frozen.configOptionValues ? { configOptionValues: frozen.configOptionValues } : {}),
          ...(meta.acpSessionId ? { resume: meta.acpSessionId } : {}),
          chainDepth: operation.initiatorChainDepth + 1,
        },
        userTurnId: delivery.systemTurnId,
        userId: operation.requesterUserId,
        userName: requester.name,
        userEmail: requester.email,
      },
      {
        dispatchSource: 'delivery',
        onTurnClaimed: async () => {
          await this.writeCompletionTurn(sessionDoc, operation, delivery, true);
        },
      }
    );
    const historyAfterExecution = await sessionDoc.getHistory();
    const evidenceAfterExecution = this.getContinuationEvidence(
      historyAfterExecution,
      delivery.systemTurnId
    );
    if (evidenceAfterExecution) {
      this.consumeDelivery(delivery, reason, evidenceAfterExecution);
    }
  }

  private consumeDelivery(
    delivery: StoredLodyDelivery,
    wakeReason: string,
    evidence: string
  ): void {
    const startedAt = performance.now();
    this.withStore((store) =>
      store.consumeDelivery(delivery.requesterSessionId, delivery.operationId)
    );
    const timer = this.configurationTimers.get(delivery.requesterSessionId);
    if (timer) clearTimeout(timer);
    this.configurationTimers.delete(delivery.requesterSessionId);
    this.options.logger.debug(
      `[orchestration] Delivery ${delivery.deliveryId} consumed reason=${evidence} wake=${wakeReason} durationMs=${(
        performance.now() - startedAt
      ).toFixed(2)}`
    );
  }

  /**
   * Requester commit identity for a delivery continuation turn. Resolution
   * failure degrades to the placeholder identity (which makes the session fall
   * back to the host's git config) rather than dropping the delivery.
   */
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

  private async resolveFrozenConfiguration(
    operation: StoredLodyOperation,
    delivery: StoredLodyDelivery,
    wakeReason: string
  ): Promise<'available' | 'unavailable' | 'unknown'> {
    const startedAt = performance.now();
    const agentConfigId = operation.frozenContinuationConfig.agentConfigId as
      | AgentConfigId
      | undefined;
    const finish = (
      result: 'available' | 'unavailable' | 'unknown',
      lookup: AgentConfigPointLookup | null,
      synced: boolean | null
    ) => {
      this.options.logger.debug(
        `[orchestration] Delivery ${delivery.deliveryId} configuration resolved result=${result} source=${
          lookup?.source ?? 'frozen-no-agent-config'
        } synced=${synced === null ? 'not-needed' : String(synced)} wake=${wakeReason} durationMs=${(
          performance.now() - startedAt
        ).toFixed(2)}`
      );
      return result;
    };
    if (!agentConfigId) return finish('available', null, null);
    const read = async () =>
      await readMergedAgentConfigById(
        this.options.workspaceDocument.repo,
        this.options.workspaceId,
        this.options.machineId,
        agentConfigId
      );
    const initial = await read();
    if (initial.config) return finish('available', initial, null);
    const synced = await this.options.workspaceDocument.syncMachineFlockDoc(
      this.options.machineId,
      { reason: 'orchestration-delivery-configuration', scheduleRetry: true }
    );
    if (!synced) return finish('unknown', initial, false);
    const afterSync = await read();
    return afterSync.config
      ? finish('available', afterSync, true)
      : finish('unavailable', afterSync, true);
  }

  private armConfigurationRetry(sessionId: SessionId): void {
    if (this.configurationTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.configurationTimers.delete(sessionId);
      void this.wake('configuration-retry');
    }, 5_000);
    timer.unref?.();
    this.configurationTimers.set(sessionId, timer);
  }

  private async writeCompletionTurn(
    sessionDoc: SessionDocument,
    operation: StoredLodyOperation,
    delivery: StoredLodyDelivery,
    configAvailable: boolean
  ): Promise<void> {
    if (!operation.completion) {
      throw new Error(`Finished Operation ${operation.operationId} has no completion.`);
    }
    const item: MessageContent = {
      type: 'operation_completion',
      deliveryId: delivery.deliveryId,
      operationId: operation.operationId,
      operationKind: operation.kind,
      completion: operation.completion,
      ...(!configAvailable
        ? {
            continuation: {
              status: 'not_started' as const,
              reason: {
                code: 'CONFIGURATION_UNAVAILABLE' as const,
                message: 'The frozen continuation agent configuration is no longer available.',
              },
            },
          }
        : {}),
    };
    const turn: SessionHistoryInput = {
      id: delivery.systemTurnId,
      role: 'system',
      userId: operation.requesterUserId,
      timestamp: new Date(this.now()).toISOString(),
      items: [item],
      fileDiff: [],
      finished: true,
      inputConfig: {
        ...operation.frozenContinuationConfig.inputConfig,
        prompt: completionText(operation),
        chainDepth: operation.initiatorChainDepth + 1,
      },
    };
    await sessionDoc.updateHistory((history) =>
      history.some((entry) => entry.id === delivery.systemTurnId) ? history : [...history, turn]
    );
  }

  private getContinuationEvidence(
    history: SessionHistoryInput[],
    systemTurnId: string
  ): string | null {
    const index = history.findIndex(
      (entry) => entry.id === systemTurnId && entry.role === 'system'
    );
    if (index < 0) return null;
    const completionWasUnavailable = history[index]?.items?.some(
      (item) =>
        item.type === 'operation_completion' &&
        item.continuation?.status === 'not_started' &&
        item.continuation.reason.code === 'CONFIGURATION_UNAVAILABLE'
    );
    if (completionWasUnavailable) return 'configuration_unavailable';
    for (const entry of history.slice(index + 1)) {
      if (entry.role === 'assistant') return 'assistant_history';
      if (entry.role === 'user') return null;
      if (
        entry.role === 'system' &&
        entry.items?.some((item) => item.type === 'system_notice' && item.name === 'chat_failed')
      ) {
        return 'chat_failed';
      }
    }
    return null;
  }
}
