import { Context, Deferred, Effect, Exit, Semaphore } from 'effect';
import type { InboxBatch, InboxInput, InboxMember, InboxRelease } from './model';
import { inboxFailureDiagnostic } from './model';
import type { InboxResourceIdentity } from './recovery';
import { OperationInbox } from './service';

export type ExecutionResource = {
  key: object;
  observesAcquisitions: boolean;
  terminate: Effect.Effect<void, unknown>;
  observe(
    update: (
      identity: Pick<InboxResourceIdentity, 'roots' | 'complete'>
    ) => Effect.Effect<void, unknown>
  ): Effect.Effect<Effect.Effect<void>, unknown>;
};
export class ExecutionJournal extends Context.Service<
  ExecutionJournal,
  {
    record(
      input: InboxInput,
      id: string,
      identity: InboxResourceIdentity
    ): Effect.Effect<void, unknown>;
    confirm(input: InboxInput, id: string): Effect.Effect<void, unknown>;
    members(batch: InboxBatch): Effect.Effect<InboxMember[], unknown>;
    identity(roots: readonly number[], complete: boolean): InboxResourceIdentity;
  }
>()('lody/orchestration/ExecutionJournal') {}

/** One execution owns input, batch, acquisition journal and release/recovery receipts. */
export const makeExecutionOwner = Effect.fnUntraced(function* (
  initial: InboxInput,
  id: string,
  initialBatch?: InboxBatch
) {
  const inbox = yield* OperationInbox;
  const journal = yield* ExecutionJournal;
  const released = yield* Deferred.make<void, unknown>();
  const releaseGate = yield* Semaphore.make(1);
  let input = initial;
  let batch = initialBatch;
  let phase: 'prepared' | 'submitting' | 'releasing' | 'blocked' | 'released' = 'prepared';
  let failure: unknown;
  let firstFinish: Exit.Exit<void, unknown> | undefined;
  const resources = new Map<
    object,
    {
      resource: ExecutionResource;
      roots: readonly number[];
      complete: boolean;
      detach: Effect.Effect<void>;
    }
  >();
  const rawRequests: Effect.Effect<void, unknown>[] = [];
  const record = Effect.fnUntraced(function* () {
    yield* journal.record(
      input,
      id,
      journal.identity(
        [...new Set([...resources.values()].flatMap((resource) => resource.roots))],
        [...resources.values()].every((resource) => resource.complete)
      )
    );
  });
  const detach = Effect.suspend(() =>
    Effect.forEach([...resources.values()], (resource) => resource.detach, { discard: true })
  );
  if (!(yield* inbox.begin(input, id)))
    return yield* Effect.fail(
      new Error(
        'INBOX_EXECUTION_REJECTED: inspect blocked resources with lody session recover-inbox'
      )
    );
  if (!batch) batch = yield* inbox.prepare(input);
  const finishWork = Effect.fnUntraced(function* (
    outcome: InboxRelease['outcome'],
    cause?: unknown
  ) {
    if (firstFinish) return yield* firstFinish;
    const exit = yield* Effect.exit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          failure = cause;
          const submitted = phase === 'submitting';
          const incomplete = [...resources.values()].some(
            (resource) => resource.resource.observesAcquisitions && !resource.complete
          );
          if (!failure && incomplete)
            failure = new Error('Inbox resource acquisition remains incomplete');
          phase = 'releasing';
          if (batch && submitted)
            yield* inbox.settle(
              batch,
              outcome === 'normal' && !failure ? 'settled' : 'unknown',
              failure ? inboxFailureDiagnostic(failure) : undefined
            );
          yield* inbox.release({
            ...input,
            executionId: id,
            outcome: failure ? 'unreleased' : outcome,
            cause: failure ? inboxFailureDiagnostic(failure) : undefined,
          });
          phase = failure ? 'blocked' : 'released';
          if (!failure) {
            yield* detach;
            yield* Deferred.succeed(released, undefined);
          }
        })
      )
    );
    firstFinish = exit;
    if (Exit.isFailure(exit)) {
      failure = exit.cause;
      phase = 'blocked';
    }
    return yield* exit;
  });
  const recoverWork = Effect.fnUntraced(function* (
    prepare: Effect.Effect<void, unknown>,
    beforeRelease: Effect.Effect<void, unknown>
  ) {
    if (phase === 'released') return;
    yield* prepare;
    yield* Effect.forEach(resources.values(), (resource) => resource.resource.terminate, {
      concurrency: 'unbounded',
      discard: true,
    });
    yield* Effect.forEach(rawRequests, (raw) => raw, { concurrency: 'unbounded', discard: true });
    yield* beforeRelease;
    yield* journal.confirm(input, id);
    yield* detach;
    failure = undefined;
    phase = 'released';
    yield* Deferred.succeed(released, undefined);
    yield* inbox.wake;
  });
  return {
    get input() {
      return input;
    },
    get batch() {
      return batch;
    },
    id,
    get phase() {
      return phase;
    },
    get failure() {
      return failure;
    },
    members: batch ? journal.members(batch) : Effect.succeed([]),
    adopt: (next: InboxInput, update: () => void) =>
      inbox.adopt(input, next, id, () => {
        input = next;
        update();
      }),
    register: Effect.fnUntraced(function* (resource: ExecutionResource) {
      if (resources.has(resource.key)) return;
      const owned = {
        resource,
        roots: [] as readonly number[],
        complete: false,
        detach: Effect.void,
      };
      resources.set(resource.key, owned);
      yield* record();
      owned.detach = yield* resource.observe((identity) =>
        Effect.gen(function* () {
          owned.roots = identity.roots;
          owned.complete = identity.complete === true;
          yield* record();
        })
      );
    }),
    retain: (resource: ExecutionResource) =>
      Effect.sync(() => {
        if (!resources.has(resource.key))
          resources.set(resource.key, {
            resource,
            roots: [],
            complete: false,
            detach: Effect.void,
          });
      }),
    track: (raw: Effect.Effect<void, unknown>) =>
      Effect.sync(() => {
        rawRequests.push(raw);
      }),
    steer: <A>(start: () => A) => inbox.submit(undefined, input, id, start),
    submit: <A>(start: () => A) =>
      inbox
        .submit(batch, input, id, () => {
          phase = 'submitting';
          return start();
        })
        .pipe(Effect.tap(() => (batch ? inbox.settle(batch, 'submitted') : Effect.void))),
    finish: (outcome: InboxRelease['outcome'], cause?: unknown) =>
      releaseGate.withPermit(finishWork(outcome, cause)),
    awaitReleased: Deferred.await(released),
    detach,
    recover: (prepare: Effect.Effect<void, unknown>, beforeRelease: Effect.Effect<void, unknown>) =>
      releaseGate.withPermit(recoverWork(prepare, beforeRelease).pipe(Effect.uninterruptible)),
  };
});
export type ExecutionOwner = Effect.Success<ReturnType<typeof makeExecutionOwner>>;
