import {
  makeLodyError,
  type LodyOperationCompletion,
  type LodyOperationItemResult,
  type MachineId,
  type OperationProgressStatus,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type StoredLodyOperation,
  type WorkspaceId,
} from '@lody/shared';
import {
  getOperationProgressTargetKey,
  getOperationProgressTurnId,
  type OperationProgressStatusByTarget,
} from '@lody/shared/session-data';
import { Cause, Context, Effect, Exit, FiberMap, Layer, Scope, Semaphore } from 'effect';
import { CoordinatorActivity } from './coordinator-activity';
import {
  assistantOutputPreview,
  findSteerSuccessor,
  isTerminalAssistantEntry,
  MAX_STEER_HANDOFF_HOPS,
  progressIsSettled,
  resolveOperationTargetMachineId,
  targetFailureError,
} from './coordinator-model';
import {
  CoordinatorPorts,
  TARGET_CATCH_UP_TIMEOUT_MS,
  TargetCatchUpTimeoutError,
  type CoordinatorHistory,
} from './coordinator-ports';
import { OperationRepository } from './operation-repository';

/** Where a delegated target's work stands after following applied steer handoffs. */
type SteerHandoffOutcome =
  | { readonly _tag: 'Done'; readonly assistant: SessionHistoryInput }
  | { readonly _tag: 'Running' }
  | { readonly _tag: 'Failed' }
  | {
      readonly _tag: 'Cancelled';
      readonly cancellationReason: SessionHistoryInput['cancellationReason'];
    };

const HANDOFF_PROGRESS_STATUS = {
  Done: 'succeeded',
  Running: 'running',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const satisfies Record<SteerHandoffOutcome['_tag'], OperationProgressStatus>;
export class CoordinatorWorkflow {
  recoverSubscriptions = () =>
    Effect.forEach([...this.subscriptions.values()], (detach) => detach, { discard: true });
  private readonly projectedBatches = new Set<string>();
  private readonly subscriptions = new Map<string, Effect.Effect<void>>();
  private readonly materializationRetryAttempts = new Map<string, number>();
  constructor(
    private readonly options: {
      workspaceId: WorkspaceId;
      machineId: MachineId;
    },
    private readonly ports: CoordinatorPorts['Service'],
    private readonly operations: OperationRepository['Service'],
    private readonly activity: CoordinatorActivity['Service'],
    private readonly scope: Scope.Scope,
    private readonly materializations: FiberMap.FiberMap<string, void, never>,
    private readonly materializationPermits: Semaphore.Semaphore
  ) {}
  drain = Effect.gen(
    function* (this: CoordinatorWorkflow) {
      for (;;) {
        yield* this.activity.drain;
        const inFlight = yield* FiberMap.size(this.materializations);
        if (inFlight === 0 && !this.activity.hasPending()) return;
        if (inFlight > 0) yield* FiberMap.awaitEmpty(this.materializations);
      }
    }.bind(this)
  );
  stopDrain = Effect.gen(
    function* (this: CoordinatorWorkflow) {
      yield* FiberMap.clear(this.materializations);
      yield* this.activity.drain;
      yield* FiberMap.clear(this.materializations);
    }.bind(this)
  );
  cancelInactiveOperations = (activeKeys: Set<string>) => this.dropInactiveResources(activeKeys);
  private get started() {
    return this.ports.active();
  }
  private now = () => this.ports.now();
  private get materializationClaimToken() {
    return this.ports.claimToken;
  }
  private operationKey(operation: StoredLodyOperation) {
    return operation.requesterSessionId + '\0' + operation.operationId;
  }
  private materializationKey(operation: StoredLodyOperation, index: number) {
    return 'material:' + this.operationKey(operation) + '\0' + index;
  }
  private hasMaterializationRetry(operation: StoredLodyOperation, index: number) {
    return this.activity.has(this.materializationKey(operation, index));
  }
  private mapItemsWithConcurrency<T, R>(
    values: readonly T[],
    concurrency: number,
    map: (value: T, index: number) => Effect.Effect<R, unknown>
  ) {
    return Effect.forEach(values, map, { concurrency });
  }
  reconcile = Effect.fn('Coordinator.reconcile')(
    function* (this: CoordinatorWorkflow, _reason: string): Effect.fn.Return<void, unknown> {
      if (!this.started) return;
      yield* this.projectInboxReceipts();
      const active = yield* this.operations.listActive(
        this.options.workspaceId,
        this.options.machineId
      );
      const activeKeys = new Set(active.map((operation) => this.operationKey(operation)));
      yield* this.dropInactiveResources(activeKeys);
      for (const operation of active) {
        yield* this.reconcileOperation(operation);
      }
      const pendingProgress = yield* this.operations.listPendingProgress(
        this.options.workspaceId,
        this.options.machineId
      );
      for (const operation of pendingProgress) yield* this.writeOperationProgress(operation);
      if (
        (yield* this.operations.listPendingProgress(
          this.options.workspaceId,
          this.options.machineId
        )).length > 0
      ) {
        yield* this.activity.arm('progress', 5000, 'progress-retry');
      } else {
        yield* this.activity.cancel('progress');
      }
      yield* this.ports.wakeInbox;
    }.bind(this)
  );
  projectInboxReceipts = Effect.fnUntraced(
    function* (this: CoordinatorWorkflow): Effect.fn.Return<void, unknown> {
      const batches = yield* this.ports.receipts;
      const retained = new Set(
        batches.map((batch) => JSON.stringify([batch.batchId, batch.state]))
      );
      for (const key of this.projectedBatches)
        if (!retained.has(key)) this.projectedBatches.delete(key);
      for (const batch of batches) {
        const key = JSON.stringify([batch.batchId, batch.state]);
        if (this.projectedBatches.has(key)) continue;
        const meta = yield* this.ports.metadata(batch.sessionId as SessionId);
        if (!meta?.meta) continue;
        const doc = yield* this.ports.session(batch.sessionId as SessionId);
        const backend = doc;
        if (!this.started) return;
        yield* backend.applyHistoryAction({
          kind: 'operation-batch-status',
          batchId: batch.batchId,
          turnId: batch.kind === 'automatic' ? batch.inputId : `operation-batch:${batch.batchId}`,
          status:
            batch.state === 'superseded'
              ? 'not_submitted'
              : (batch.state as 'submitted' | 'unknown' | 'settled'),
        });
        this.projectedBatches.add(key);
      }
    }.bind(this)
  );
  reconcileOperation = Effect.fnUntraced(
    function* (
      this: CoordinatorWorkflow,
      operation: StoredLodyOperation
    ): Effect.fn.Return<void, unknown> {
      yield* this.activity.arm(
        'deadline:' + this.operationKey(operation),
        Date.parse(operation.deadlineAt) - this.now(),
        'deadline'
      );
      const isAtDeadline = () => this.now() >= Date.parse(operation.deadlineAt);
      const reconciled = yield* Effect.exit(
        this.mapItemsWithConcurrency(operation.items, 5, (item, index) =>
          this.reconcileItem(operation, item, index, isAtDeadline)
        )
      );
      if (Exit.isFailure(reconciled)) {
        if (!isAtDeadline() || Cause.hasInterrupts(reconciled.cause)) {
          yield* Effect.failCause(reconciled.cause);
          return;
        }
        yield* this.operations.finish(operation.requesterSessionId, operation.operationId, {
          type: 'error',
          error: makeLodyError(
            'COORDINATOR_FAILED',
            `Operation could not read trustworthy target state at its deadline: ${String(Cause.squash(reconciled.cause))}`,
            false
          ),
        });
        yield* this.activity.cancel('deadline:' + this.operationKey(operation));
        yield* this.clearOperationMaterializationRetries(operation);
        return;
      }
      const items = reconciled.value;
      const changed = JSON.stringify(items) !== JSON.stringify(operation.items);
      let latestOperation = operation;
      if (changed) {
        latestOperation = yield* this.operations.updateItems(
          operation.requesterSessionId,
          operation.operationId,
          items
        );
      }
      yield* this.writeOperationProgress(latestOperation);
      if (items.every((item) => item.status !== 'active')) {
        const completion: LodyOperationCompletion = { type: 'result', value: { items } };
        latestOperation = yield* this.operations.finish(
          operation.requesterSessionId,
          operation.operationId,
          completion
        );
        yield* this.writeOperationProgress(latestOperation);
        yield* this.activity.cancel('deadline:' + this.operationKey(operation));
        yield* this.clearOperationMaterializationRetries(operation);
      }
    }.bind(this)
  );
  writeOperationProgress = Effect.fnUntraced(
    function* (
      this: CoordinatorWorkflow,
      operation: StoredLodyOperation
    ): Effect.fn.Return<void, unknown> {
      if (operation.kind !== 'session_create' && operation.kind !== 'session_create_many') return;
      const metaRecord = yield* this.ports.metadata(operation.requesterSessionId);
      if (!metaRecord?.meta) return;
      const sessionDoc = yield* this.ports.session(operation.requesterSessionId);
      const backend = sessionDoc;
      const statusByTarget = yield* this.collectOperationProgressTargetStatuses(operation);
      // A previous lease must not resume writing after stop/restart.
      if (!this.started) return;
      yield* backend.applyHistoryAction({
        kind: 'operation-progress',
        operation,
        timestamp: new Date(this.now()).toISOString(),
        statuses: [...statusByTarget],
      });
      const progressTurn = yield* backend.readTurn(
        getOperationProgressTurnId(operation.requesterSessionId, operation.operationId)
      );
      if (
        operation.state === 'finished' &&
        progressIsSettled(
          operation,
          progressTurn.state === 'ready'
            ? (progressTurn.turn as unknown as SessionHistoryInput)
            : undefined,
          statusByTarget
        )
      ) {
        yield* backend.flushLocalWrites;
        if (!this.started) return;
        yield* this.operations.settleProgress(operation.requesterSessionId, operation.operationId);
      }
    }.bind(this),
    (effect, operation) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : this.ports.warn(
                `[orchestration] Progress update failed for ${operation.operationId}; retrying on a later wake: ${String(Cause.squash(cause))}`,
                cause
              )
        )
      )
  );
  collectOperationProgressTargetStatuses = Effect.fnUntraced(
    function* (
      this: CoordinatorWorkflow,
      operation: StoredLodyOperation
    ): Effect.fn.Return<OperationProgressStatusByTarget, unknown> {
      const statuses = new Map<string, OperationProgressStatus>();
      yield* this.mapItemsWithConcurrency(operation.items, 5, (item) =>
        Effect.gen(
          function* (this: CoordinatorWorkflow) {
            if (!('target' in item) || !item.target) return;
            if (item.status === 'active' && !item.inputDurable) return;
            const target = item.target;
            const metaRecord = yield* this.ports.metadata(target.sessionId);
            if (!metaRecord?.meta) return;
            const meta = metaRecord.meta as SessionMeta;
            const sessionDoc = yield* this.ports.session(target.sessionId);
            const backend = sessionDoc;
            yield* this.subscribeTarget(target.sessionId, backend);
            const output = yield* backend.readTurnOutput(target.userTurnId);
            const userTurn = output.find(
              (entry) => entry.id === target.userTurnId && entry.role === 'user'
            );
            if (!userTurn) return;
            const assistantRead = output.find(
              (entry) => entry.role === 'assistant' && entry.userTurnId === target.userTurnId
            );
            const key = getOperationProgressTargetKey(target);
            if (userTurn.status === 'failed') {
              statuses.set(key, 'failed');
              return;
            }
            if (userTurn.status === 'canceled') {
              statuses.set(key, 'cancelled');
              return;
            }
            if (assistantRead !== undefined && isTerminalAssistantEntry(assistantRead)) {
              const handoff = yield* this.followSteerHandoff(backend, meta, assistantRead);
              statuses.set(key, HANDOFF_PROGRESS_STATUS[handoff._tag]);
              return;
            }
            const execution = this.ports.execution(target.sessionId);
            if (
              execution.activeTurnId === `assistant:${target.userTurnId}` ||
              meta.processingUserMsgId === target.userTurnId ||
              userTurn.status === 'processing'
            ) {
              statuses.set(key, 'running');
              return;
            }
            statuses.set(key, 'created');
          }.bind(this)
        )
      );
      return statuses;
    }.bind(this)
  );
  /**
   * A steer applied to a target's running turn seals that turn and continues its
   * work under the steered input. Follow those handoffs so the delegated item
   * completes with the final reply instead of the sealed partial output.
   */
  followSteerHandoff = Effect.fnUntraced(function* (
    backend: CoordinatorHistory,
    meta: SessionMeta,
    assistant: SessionHistoryInput
  ): Effect.fn.Return<SteerHandoffOutcome, unknown> {
    let current = assistant;
    for (let hop = 0; hop < MAX_STEER_HANDOFF_HOPS; hop += 1) {
      const successorTurnId = findSteerSuccessor(meta, current.id);
      if (successorTurnId === undefined) break;
      const output = yield* backend.readTurnOutput(successorTurnId);
      const userTurn = output.find(
        (entry) => entry.id === successorTurnId && entry.role === 'user'
      );
      const next = output.find(
        (entry) => entry.role === 'assistant' && entry.userTurnId === successorTurnId
      );
      if (!next) {
        // An applied steer can still lose the race with the turn it targeted
        // (stale-turn, or a failure before handoff) and never start a successor.
        // Only an unsettled input may still hand off; otherwise `current` stands.
        const settling =
          userTurn === undefined ||
          userTurn.status === 'processing' ||
          userTurn.status === 'pending_apply';
        return settling ? { _tag: 'Running' } : { _tag: 'Done', assistant: current };
      }
      if (userTurn?.status === 'failed') return { _tag: 'Failed' };
      if (userTurn?.status === 'canceled') {
        return { _tag: 'Cancelled', cancellationReason: userTurn.cancellationReason };
      }
      if (!isTerminalAssistantEntry(next)) return { _tag: 'Running' };
      current = next;
    }
    return { _tag: 'Done', assistant: current };
  });
  runItemMaterialization = Effect.fn('Coordinator.materializeItem')(
    function* (
      this: CoordinatorWorkflow,
      operation: StoredLodyOperation,
      item: Extract<LodyOperationItemResult, { status: 'active' }>,
      index: number
    ): Effect.fn.Return<void, never> {
      const isAtDeadline = () => this.now() >= Date.parse(operation.deadlineAt);
      const target = item.target;
      yield* this.materializationPermits
        .withPermits(1)(
          Effect.gen(
            function* (this: CoordinatorWorkflow) {
              if (!this.started) return;
              const reason = `orchestration.materialize:${operation.operationId}:${index}`;
              const targetMetaRecord = yield* this.ports.metadata(target.sessionId);
              const requesterMetaRecord =
                !targetMetaRecord?.meta &&
                (operation.kind === 'session_create' || operation.kind === 'session_create_many')
                  ? yield* this.ports.metadata(operation.requesterSessionId)
                  : undefined;
              const targetMachineId = resolveOperationTargetMachineId({
                operation,
                index,
                targetMeta: targetMetaRecord?.meta,
                requesterMeta: requesterMetaRecord?.meta,
              });
              const caughtUp = yield* Effect.exit(
                this.ports.confirmReadable(target.sessionId, reason, targetMachineId).pipe(
                  Effect.timeoutOrElse({
                    duration: TARGET_CATCH_UP_TIMEOUT_MS,
                    orElse: () =>
                      Effect.fail(
                        new TargetCatchUpTimeoutError({
                          sessionId: target.sessionId,
                          reason,
                          timeoutMs: TARGET_CATCH_UP_TIMEOUT_MS,
                        })
                      ),
                  })
                )
              );
              if (Exit.isFailure(caughtUp)) {
                if (Cause.hasInterrupts(caughtUp.cause))
                  return yield* Effect.failCause(caughtUp.cause);
                if (!isAtDeadline()) {
                  const delayMs = yield* this.armMaterializationFailureRetry(operation, index);
                  yield* this.ports.warn(
                    `[orchestration] Target document catch-up was not confirmed (${operation.operationId}:${index}); retrying in ${delayMs}ms: ${String(Cause.squash(caughtUp.cause))}`,
                    caughtUp.cause
                  );
                  return;
                }
                yield* this.activity.signal('materialization-deadline');
                return;
              }
              if (!this.started) return;
              let alreadyMaterialized = yield* this.isTargetInputDurable(
                target.sessionId,
                target.userTurnId
              );
              if (!alreadyMaterialized && !isAtDeadline()) {
                const materialized = yield* Effect.exit(
                  this.ports.materialize(operation, item, index)
                );
                if (Exit.isFailure(materialized)) {
                  if (Cause.hasInterrupts(materialized.cause))
                    return yield* Effect.failCause(materialized.cause);
                  const delayMs = yield* this.armMaterializationFailureRetry(operation, index);
                  yield* this.ports.warn(
                    `[orchestration] Target materialization failed (${operation.operationId}:${index}); retrying in ${delayMs}ms: ${String(Cause.squash(materialized.cause))}`,
                    materialized.cause
                  );
                  return;
                }
                if (!this.started) return;
                alreadyMaterialized = true;
              }
              if (!alreadyMaterialized) {
                yield* this.activity.signal('materialization-deadline');
                return;
              }
              const materializedOperation = yield* this.operations.markItemInputDurable(
                operation.requesterSessionId,
                operation.operationId,
                index,
                this.materializationClaimToken
              );
              // Publish each recovered child without waiting for slower batch siblings.
              yield* this.writeOperationProgress(materializedOperation);
              yield* this.clearMaterializationRetry(operation, index);
              yield* this.activity.signal('materialized');
            }.bind(this)
          )
        )
        .pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.interrupt;
            return Effect.gen(
              function* (this: CoordinatorWorkflow) {
                if (!this.started) return;
                if (isAtDeadline()) {
                  yield* this.activity.signal('materialization-deadline');
                  return;
                }
                const delayMs = yield* this.armMaterializationFailureRetry(operation, index);
                yield* this.ports.warn(
                  `[orchestration] Target materialization failed (${operation.operationId}:${index}); retrying in ${delayMs}ms: ${String(Cause.squash(cause))}`,
                  cause
                );
              }.bind(this)
            );
          })
        );
    }.bind(this)
  );
  reconcileItem = Effect.fnUntraced(
    function* (
      this: CoordinatorWorkflow,
      operation: StoredLodyOperation,
      item: LodyOperationItemResult,
      index: number,
      isAtDeadline: () => boolean
    ): Effect.fn.Return<LodyOperationItemResult, unknown> {
      if (item.status !== 'active') return item;
      if (!this.started) return item;
      const target = item.target;
      // Local Stop is authoritative even if cancellation history has not flushed yet.
      if (
        (yield* this.operations.inputCancellationReason(
          operation.workspaceId,
          target.sessionId,
          target.userTurnId
        )) === 'user_stop'
      ) {
        yield* FiberMap.remove(this.materializations, this.materializationKey(operation, index));
        return {
          status: 'cancelled',
          cancellationReason: 'user_stop',
          target,
          ...(item.label ? { label: item.label } : {}),
        };
      }
      if (!item.inputDurable) {
        const materialKey = this.materializationKey(operation, index);
        const alreadyMaterialized = yield* this.isTargetInputDurable(
          target.sessionId,
          target.userTurnId
        );
        if (alreadyMaterialized) {
          const materializedOperation = yield* this.operations.markItemInputDurable(
            operation.requesterSessionId,
            operation.operationId,
            index
          );
          yield* this.writeOperationProgress(materializedOperation);
          yield* this.clearMaterializationRetry(operation, index);
          item = { ...item, inputDurable: true };
        } else if (isAtDeadline()) {
          yield* FiberMap.remove(this.materializations, materialKey);
          yield* this.clearMaterializationRetry(operation, index);
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
        } else {
          if (
            (yield* FiberMap.has(this.materializations, materialKey)) ||
            this.hasMaterializationRetry(operation, index)
          ) {
            return item;
          }
          const claim = yield* this.operations.claimItemMaterialization(
            operation.requesterSessionId,
            operation.operationId,
            index,
            this.materializationClaimToken
          );
          if (!claim.claimed) {
            if (claim.retryAtMs !== undefined) {
              yield* this.armMaterializationRetry(operation, index, claim.retryAtMs);
            }
            return item;
          }
          if (!this.started) return item;
          yield* FiberMap.run(
            this.materializations,
            materialKey,
            this.runItemMaterialization(operation, item, index),
            { onlyIfMissing: true }
          );
          return item;
        }
      }
      const metaRecord = yield* this.ports.metadata(item.target.sessionId);
      if (!metaRecord?.meta) {
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
      const sessionDoc = yield* this.ports.session(item.target.sessionId);
      const backend = sessionDoc;
      yield* this.subscribeTarget(item.target.sessionId, backend);
      const targetOutput = yield* backend.readTurnOutput(item.target.userTurnId);
      const userTurn = targetOutput.find(
        (entry) => entry.id === item.target.userTurnId && entry.role === 'user'
      );
      const assistant = targetOutput.find(
        (entry) =>
          entry.role === 'assistant' &&
          entry.userTurnId === item.target.userTurnId &&
          isTerminalAssistantEntry(entry)
      );
      const failedAssistantTurn =
        assistant ??
        targetOutput.find(
          (entry) => entry.role === 'assistant' && entry.userTurnId === item.target.userTurnId
        );
      const targetFailed = (): LodyOperationItemResult => ({
        status: 'failed',
        ...(item.label ? { label: item.label } : {}),
        target: item.target,
        error: targetFailureError(targetOutput, failedAssistantTurn?.id, this.now()),
      });
      const targetCancelled = (
        cancellationReason: SessionHistoryInput['cancellationReason']
      ): LodyOperationItemResult => ({
        status: 'cancelled',
        // Operation results record only a manual Stop; an update interruption is not one.
        ...(cancellationReason === 'user_stop' ? { cancellationReason } : {}),
        ...(item.label ? { label: item.label } : {}),
        target: item.target,
      });
      if (userTurn?.status === 'failed') return targetFailed();
      if (userTurn?.status === 'delivery_unknown') {
        // An Agent chat steer whose provider verdict is uncertain. Never replay it:
        // the requesting Agent decides whether resending is safe.
        return {
          status: 'failed',
          ...(item.label ? { label: item.label } : {}),
          target: item.target,
          error: makeLodyError(
            'STEER_DELIVERY_UNKNOWN',
            'The steer into the running target Turn may or may not have been applied; resend only if duplicate work is acceptable.',
            false
          ),
        };
      }
      if (userTurn?.status === 'canceled') return targetCancelled(userTurn.cancellationReason);
      const handoff = assistant
        ? yield* this.followSteerHandoff(backend, metaRecord.meta as SessionMeta, assistant)
        : undefined;
      if (handoff?._tag === 'Failed') return targetFailed();
      if (handoff?._tag === 'Cancelled') return targetCancelled(handoff.cancellationReason);
      if (handoff?._tag === 'Done') {
        const output = assistantOutputPreview(handoff.assistant);
        return {
          status: 'succeeded',
          ...(item.label ? { label: item.label } : {}),
          target: item.target,
          assistantTurnId: handoff.assistant.id,
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
    }.bind(this)
  );
  isTargetInputDurable = Effect.fnUntraced(
    function* (
      this: CoordinatorWorkflow,
      sessionId: SessionId,
      userTurnId: string
    ): Effect.fn.Return<boolean, unknown> {
      const metaRecord = yield* this.ports.metadata(sessionId);
      if (!metaRecord?.meta) {
        return false;
      }
      const sessionDoc = yield* this.ports.session(sessionId);
      const backend = sessionDoc;
      const output = yield* backend.readTurnOutput(userTurnId);
      const userTurn = output.find((entry) => entry.id === userTurnId && entry.role === 'user');
      if (!userTurn) return false;
      const meta = metaRecord.meta as SessionMeta;
      const assistantIsTerminal = output.some(
        (entry) =>
          entry.role === 'assistant' &&
          entry.userTurnId === userTurnId &&
          isTerminalAssistantEntry(entry)
      );
      return (
        meta.latestUserMsgId === userTurnId ||
        meta.processingUserMsgId === userTurnId ||
        meta.lastHandledUserMsgId === userTurnId ||
        userTurn.status === 'handled' ||
        userTurn.status === 'failed' ||
        userTurn.status === 'canceled' ||
        assistantIsTerminal
      );
    }.bind(this)
  );
  subscribeTarget = Effect.fnUntraced(
    function* (this: CoordinatorWorkflow, id: SessionId, history: CoordinatorHistory) {
      if (!this.started || this.subscriptions.has(id)) return;
      const detach = yield* history.observe(this.activity.signal('target-history'));
      this.subscriptions.set(id, detach);
      yield* Scope.addFinalizer(this.scope, detach);
    }.bind(this)
  );
  armMaterializationRetry = Effect.fnUntraced(
    function* (
      this: CoordinatorWorkflow,
      op: StoredLodyOperation,
      index: number,
      at: number,
      reason = 'materialization-claim-expired'
    ) {
      yield* this.activity.arm(this.materializationKey(op, index), at - this.now(), reason);
    }.bind(this)
  );
  armMaterializationFailureRetry = Effect.fnUntraced(
    function* (this: CoordinatorWorkflow, op: StoredLodyOperation, index: number) {
      const key = this.materializationKey(op, index);
      const attempt = Math.min(this.materializationRetryAttempts.get(key) ?? 0, 5);
      const delay = Math.min(1000 * 2 ** attempt, 30000);
      this.materializationRetryAttempts.set(key, attempt + 1);
      const now = this.now();
      const at = Math.min(now + delay, Date.parse(op.deadlineAt));
      yield* this.armMaterializationRetry(op, index, at, 'materialization-retry');
      return Math.max(0, at - now);
    }.bind(this)
  );
  clearMaterializationRetry = Effect.fnUntraced(
    function* (this: CoordinatorWorkflow, op: StoredLodyOperation, index: number) {
      const key = this.materializationKey(op, index);
      yield* this.activity.cancel(key);
      this.materializationRetryAttempts.delete(key);
    }.bind(this)
  );
  clearOperationMaterializationRetries = Effect.fnUntraced(
    function* (this: CoordinatorWorkflow, op: StoredLodyOperation) {
      const prefix = 'material:' + this.operationKey(op) + '\0';
      yield* this.activity.cancelWhere((key) => key.startsWith(prefix));
      for (const [key] of [...this.materializations]) {
        if (key.startsWith(prefix)) yield* FiberMap.remove(this.materializations, key);
      }
      for (const key of this.materializationRetryAttempts.keys())
        if (key.startsWith(prefix)) this.materializationRetryAttempts.delete(key);
    }.bind(this)
  );
  dropInactiveResources = Effect.fnUntraced(
    function* (this: CoordinatorWorkflow, keys: Set<string>) {
      const isInactiveMaterialKey = (key: string) =>
        key.startsWith('material:') &&
        ![...keys].some((op) => key.startsWith('material:' + op + '\0'));
      yield* this.activity.cancelWhere((key) =>
        key.startsWith('deadline:') ? !keys.has(key.slice(9)) : isInactiveMaterialKey(key)
      );
      for (const [key] of [...this.materializations]) {
        if (isInactiveMaterialKey(key)) yield* FiberMap.remove(this.materializations, key);
      }
      for (const key of this.materializationRetryAttempts.keys()) {
        if (isInactiveMaterialKey(key)) this.materializationRetryAttempts.delete(key);
      }
    }.bind(this)
  );
}
export class CoordinatorScope extends Context.Service<
  CoordinatorScope,
  {
    core: CoordinatorWorkflow;
    activity: CoordinatorActivity['Service'];
  }
>()('lody/orchestration/Coordinator') {
  static layer(options: { workspaceId: WorkspaceId; machineId: MachineId }) {
    return Layer.unwrap(
      Effect.gen(function* () {
        const outerPorts = yield* CoordinatorPorts;
        let core: CoordinatorWorkflow;
        const activityLayer = CoordinatorActivity.layer(
          (reason) => Effect.suspend(() => core.reconcile(reason)),
          (cause) => outerPorts.warn('Coordinator reconciliation failed', cause)
        );
        return Layer.effect(
          CoordinatorScope,
          Effect.gen(function* () {
            const ports = yield* CoordinatorPorts;
            const operations = yield* OperationRepository;
            const activity = yield* CoordinatorActivity;
            const scope = yield* Effect.scope;
            const materializations = yield* FiberMap.make<string, void, never>();
            const materializationPermits = yield* Semaphore.make(5);
            core = new CoordinatorWorkflow(
              options,
              ports,
              operations,
              activity,
              scope,
              materializations,
              materializationPermits
            );
            return { core, activity };
          })
        ).pipe(Layer.provideMerge(activityLayer));
      })
    );
  }
}
