import { Context, Effect, Layer, Queue, Semaphore } from 'effect';
import {
  InboxAdmissionRejected,
  inboxScopeKey,
  type InboxBatch,
  type InboxInput,
  type InboxRelease,
  type InboxScope,
} from './model';

type Repository = {
  abandon(workspaceId: string, sessionId: string, id: string): Effect.Effect<void, unknown>;
  deactivate(workspaceId: string, owner: string): Effect.Effect<void, unknown>;
  cancelExecution(
    scope: InboxScope,
    id: string,
    reason?: 'user_stop'
  ): Effect.Effect<boolean, unknown>;
  adopt(previous: InboxInput, next: InboxInput, id: string): Effect.Effect<boolean, unknown>;
  canSubmit(scope: InboxScope, executionId: string, owner: string): Effect.Effect<boolean, unknown>;
  accept(input: InboxInput): Effect.Effect<boolean, unknown>;
  begin(scope: InboxScope, executionId: string, owner?: string): Effect.Effect<boolean, unknown>;
  withdraw(input: InboxInput, executionId: string): Effect.Effect<boolean, unknown>;
  pause(
    scope: InboxScope,
    executionId: string,
    pendingIds?: readonly string[],
    cancelId?: string
  ): Effect.Effect<boolean, unknown>;
  release(event: InboxRelease): Effect.Effect<void, unknown>;
  prepare(
    input: InboxInput,
    owner: string,
    intentId?: string
  ): Effect.Effect<InboxBatch | undefined, unknown>;
  fence(batch: InboxBatch, executionId: string): Effect.Effect<boolean, unknown>;
  pending(
    workspaceId: string
  ): Effect.Effect<Array<{ intentId: string; input: InboxInput }>, unknown>;
  settle(
    batch: InboxBatch,
    outcome: 'submitted' | 'unknown' | 'settled',
    cause?: string
  ): Effect.Effect<void, unknown>;
};
export class InboxRepository extends Context.Service<InboxRepository, Repository>()(
  'lody/orchestration/InboxRepository'
) {}
/** Registered temporary adapter for the unfinished Session/ACP owner. */
export class InboxExecution extends Context.Service<
  InboxExecution,
  {
    ready(batch: InboxBatch): boolean;
    admit(batch: InboxBatch): boolean;
    launch(batch: InboxBatch): Effect.Effect<void, unknown>;
    report(cause: unknown): Effect.Effect<void>;
    quiesce?(): void;
  }
>()('lody/orchestration/InboxExecution') {}

export class OperationInbox extends Context.Service<
  OperationInbox,
  {
    adopt(
      previous: InboxInput,
      next: InboxInput,
      id: string,
      update: () => void
    ): Effect.Effect<void, unknown>;
    abandon(workspaceId: string, sessionId: string, id: string): Effect.Effect<void, unknown>;
    wake: Effect.Effect<void>;
    quiesce: Effect.Effect<void, unknown>;
    cancelExecution(
      scope: InboxScope,
      id: string,
      reason?: 'user_stop'
    ): Effect.Effect<boolean, unknown>;
    accept(input: InboxInput): Effect.Effect<boolean, unknown>;
    begin(scope: InboxScope, executionId: string): Effect.Effect<boolean, unknown>;
    withdraw(input: InboxInput, executionId: string): Effect.Effect<boolean, unknown>;
    pause(
      scope: InboxScope,
      executionId: string,
      pendingIds?: readonly string[],
      cancelId?: string
    ): Effect.Effect<boolean, unknown>;
    release(event: InboxRelease): Effect.Effect<void, unknown>;
    prepare(input: InboxInput): Effect.Effect<InboxBatch | undefined, unknown>;
    submit<A>(
      batch: InboxBatch | undefined,
      scope: InboxScope,
      executionId: string,
      start: () => A
    ): Effect.Effect<{ value: A }, unknown>;
    recoverSettlements(
      settle: Repository['settle'],
      release?: Repository['release'],
      pause?: Repository['pause']
    ): Effect.Effect<void, unknown>;
    settle(
      batch: InboxBatch,
      outcome: 'submitted' | 'unknown' | 'settled',
      cause?: string
    ): Effect.Effect<void, unknown>;
  }
>()('lody/orchestration/OperationInbox') {
  static layer(workspaceId: string, owner: string) {
    return Layer.effect(
      OperationInbox,
      Effect.gen(function* () {
        const repo = yield* InboxRepository;
        const execution = yield* InboxExecution;
        const scope = yield* Effect.scope;
        const submissionGate = Semaphore.makeUnsafe(1);
        let quiesced = false;
        const gates = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
        const running = new Set<string>();
        const vetoed = new Set<string>();
        const signal = yield* Queue.dropping<void>(1);
        const releases = new Map<string, InboxRelease>();
        const pauses = new Map<
          string,
          { scope: InboxScope; id: string; ids?: readonly string[]; cancelId?: string }
        >();
        const settlements = new Map<
          string,
          {
            batch: InboxBatch;
            outcome: 'submitted' | 'unknown' | 'settled';
            cause?: string;
          }
        >();
        const retrySettlements = Effect.fn('OperationInbox.retrySettlements')(function* (
          settle: Repository['settle'] = repo.settle,
          release: Repository['release'] = repo.release,
          pause: Repository['pause'] = repo.pause
        ) {
          for (const [key, receipt] of pauses) {
            yield* withGate(
              receipt.scope,
              pause(receipt.scope, receipt.id, receipt.ids, receipt.cancelId)
            );
            if (pauses.get(key) === receipt) pauses.delete(key);
          }
          for (const [id, receipt] of releases) {
            yield* release(receipt);
            if (releases.get(id) === receipt) releases.delete(id);
          }
          for (const [id, receipt] of settlements) {
            yield* settle(receipt.batch, receipt.outcome, receipt.cause);
            if (settlements.get(id) === receipt) settlements.delete(id);
          }
        });
        yield* Effect.addFinalizer(() => retrySettlements().pipe(Effect.orDie));
        // Count waiters as well as holders: never replace a lock while anyone owns a reference.
        const withGate = <A, E, R>(s: InboxScope, effect: Effect.Effect<A, E, R>) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const key = inboxScopeKey(s);
              let entry = gates.get(key);
              if (!entry) {
                entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
                gates.set(key, entry);
              }
              entry.users++;
              return { key, entry };
            }),
            ({ entry }) => entry.semaphore.withPermit(effect),
            ({ key, entry }) =>
              Effect.sync(() => {
                entry.users--;
                if (!entry.users && gates.get(key) === entry) gates.delete(key);
              })
          );
        const wake = Queue.offer(signal, undefined).pipe(Effect.asVoid);
        const prepare = Effect.fn('OperationInbox.prepare')(function* (input: InboxInput) {
          return yield* withGate(input, repo.prepare(input, owner));
        });
        const submit = <A>(
          batch: InboxBatch | undefined,
          s: InboxScope,
          id: string,
          start: () => A
        ) =>
          submissionGate.withPermit(
            withGate(
              s,
              Effect.uninterruptible(
                Effect.gen(function* () {
                  if (
                    quiesced ||
                    vetoed.has(inboxScopeKey(s)) ||
                    !(yield* repo.canSubmit(s, id, owner)) ||
                    (batch && (!execution.admit(batch) || !(yield* repo.fence(batch, id))))
                  )
                    return yield* Effect.fail(new InboxAdmissionRejected());
                  // Return a container: do not assimilate the raw Promise into gate ownership.
                  return yield* Effect.try({
                    try: () => ({ value: start() }),
                    catch: (cause) => cause,
                  });
                })
              )
            )
          );
        const scan = Effect.fn('OperationInbox.scan')(function* () {
          yield* retrySettlements();
          if (quiesced) return;
          const pending = yield* repo.pending(workspaceId);
          for (const item of pending) {
            const key = inboxScopeKey(item.input);
            if (running.has(key)) continue;
            const batch = yield* withGate(
              item.input,
              repo.prepare(item.input, owner, item.intentId)
            );
            if (!batch || !execution.ready(batch)) continue;
            running.add(key);
            yield* execution.launch(batch).pipe(
              Effect.catchCause((cause) => execution.report(cause)),
              Effect.ensuring(
                Effect.sync(() => running.delete(key)).pipe(
                  Effect.andThen(repo.pending(workspaceId)),
                  Effect.flatMap((items) =>
                    items.some(
                      (candidate) =>
                        inboxScopeKey(candidate.input) === key &&
                        candidate.input.inputId !== batch.inputId
                    )
                      ? wake
                      : Effect.void
                  ),
                  Effect.catchCause((cause) => execution.report(cause))
                )
              ),
              Effect.forkIn(scope)
            );
          }
        });
        yield* Effect.forever(
          Queue.take(signal).pipe(
            Effect.flatMap(() => scan()),
            Effect.catchCause((cause) => execution.report(cause))
          )
        ).pipe(Effect.forkScoped);
        yield* wake;
        return OperationInbox.of({
          adopt: Effect.fn('OperationInbox.adopt')(function* (
            previous: InboxInput,
            next: InboxInput,
            id: string,
            update: () => void
          ) {
            yield* withGate(
              previous,
              Effect.uninterruptible(
                Effect.gen(function* () {
                  if (!(yield* repo.adopt(previous, next, id)))
                    yield* Effect.fail(new Error('INBOX_HANDOFF_REJECTED'));
                  yield* Effect.sync(update);
                })
              )
            );
          }),
          abandon: (targetWorkspaceId, sessionId, id) =>
            withGate(
              { workspaceId: targetWorkspaceId, sessionId, userId: '' },
              repo.abandon(targetWorkspaceId, sessionId, id)
            ),
          wake,
          quiesce: submissionGate.withPermit(
            Effect.uninterruptible(
              Effect.gen(function* () {
                quiesced = true;
                yield* Effect.sync(() => execution.quiesce?.());
                yield* repo.deactivate(workspaceId, owner);
              })
            )
          ),
          cancelExecution: (s, id, reason) => withGate(s, repo.cancelExecution(s, id, reason)),
          prepare,
          submit,
          accept: Effect.fn('OperationInbox.accept')(function* (i: InboxInput) {
            return yield* withGate(
              i,
              Effect.gen(function* () {
                for (const [key, receipt] of pauses) {
                  if (inboxScopeKey(receipt.scope) !== inboxScopeKey(i)) continue;
                  yield* repo.pause(receipt.scope, receipt.id, receipt.ids, receipt.cancelId);
                  if (pauses.get(key) === receipt) pauses.delete(key);
                }
                return yield* repo.accept(i);
              }).pipe(
                Effect.tap((accepted) =>
                  Effect.sync(() => {
                    if (accepted && i.kind === 'human') vetoed.delete(inboxScopeKey(i));
                  })
                ),
                Effect.uninterruptible
              )
            );
          }),
          begin: Effect.fn('OperationInbox.begin')(function* (s: InboxScope, id: string) {
            return yield* withGate(s, repo.begin(s, id, owner));
          }),
          withdraw: Effect.fn('OperationInbox.withdraw')(function* (i: InboxInput, id: string) {
            return yield* withGate(i, repo.withdraw(i, id));
          }),
          pause: Effect.fn('OperationInbox.pause')(function* (
            s: InboxScope,
            id: string,
            ids?: readonly string[],
            cancelId?: string
          ) {
            return yield* withGate(
              s,
              Effect.gen(function* () {
                const key = JSON.stringify([inboxScopeKey(s), cancelId ?? `legacy:${id}`]);
                const receipt = { scope: s, id, ids, cancelId };
                pauses.set(key, receipt);
                const paused = yield* repo
                  .pause(s, id, ids, cancelId)
                  .pipe(Effect.tapError(() => Effect.sync(() => vetoed.add(inboxScopeKey(s)))));
                if (pauses.get(key) === receipt) pauses.delete(key);
                return paused;
              }).pipe(Effect.uninterruptible)
            );
          }),
          release: Effect.fn('OperationInbox.release')(function* (event: InboxRelease) {
            // Private retry receipt: storage fixes its watermark, never the caller's event.
            const e = { ...event };
            const key = JSON.stringify([e.workspaceId, e.sessionId, e.executionId]);
            releases.set(key, e);
            yield* withGate(
              e,
              repo.release(e).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (releases.get(key) === e) releases.delete(key);
                  })
                ),
                Effect.tapError(() =>
                  Effect.sync(() => {
                    if (e.releaseWatermark === undefined) e.outcome = 'failed';
                  })
                )
              )
            );
            yield* wake;
          }),
          recoverSettlements: retrySettlements,
          settle: Effect.fn('OperationInbox.settle')(function* (
            batch: InboxBatch,
            outcome: 'submitted' | 'unknown' | 'settled',
            cause?: string
          ) {
            const receipt = { batch, outcome, cause };
            settlements.set(batch.batchId, receipt);
            // A failed local write must not abandon the actual provider request.
            // Retry only the observed settlement, never transport submission.
            yield* repo.settle(batch, outcome, cause).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (settlements.get(batch.batchId) === receipt) settlements.delete(batch.batchId);
                })
              ),
              Effect.catchCause((failure) => execution.report(failure).pipe(Effect.andThen(wake)))
            );
          }),
        });
      })
    );
  }
}
