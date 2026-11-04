import { Context, Deferred, Effect, Exit, Semaphore } from 'effect';
import { InboxExecutionRejected } from './admission-failure';
import type { InboxBatch, InboxInput, InboxMember, InboxRelease } from './model';
import { inboxFailureDiagnostic } from './model';
import { OperationInbox } from './service';

/** A process owner that background cleanup may terminate. Never gates admission. */
export type ExecutionResource = { key: object; terminate: Effect.Effect<void, unknown> };
export class ExecutionMembers extends Context.Service<
  ExecutionMembers,
  { members(batch: InboxBatch): Effect.Effect<InboxMember[], unknown> }
>()('lody/orchestration/ExecutionMembers') {}

/** One execution owns input, batch, submission and release receipts. */
export const makeExecutionOwner = Effect.fnUntraced(function* (
  initial: InboxInput,
  id: string,
  initialBatch?: InboxBatch
) {
  const inbox = yield* OperationInbox;
  const members = yield* ExecutionMembers;
  const released = yield* Deferred.make<void, unknown>();
  const releaseGate = yield* Semaphore.make(1);
  let input = initial;
  let batch = initialBatch;
  let phase: 'prepared' | 'submitting' | 'releasing' | 'failed' | 'released' = 'prepared';
  let failure: unknown;
  let firstFinish: Exit.Exit<void, unknown> | undefined;
  const resources = new Map<object, ExecutionResource>();
  const rawRequests: Effect.Effect<void, unknown>[] = [];
  if (!(yield* inbox.begin(input, id))) return yield* Effect.fail(new InboxExecutionRejected());
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
            outcome: failure ? 'failed' : outcome,
            cause: failure ? inboxFailureDiagnostic(failure) : undefined,
          });
          phase = failure ? 'failed' : 'released';
          if (!failure) yield* Deferred.succeed(released, undefined);
        })
      )
    );
    firstFinish = exit;
    if (Exit.isFailure(exit)) {
      failure = exit.cause;
      phase = 'failed';
    }
    return yield* exit;
  });
  const recoverWork = Effect.fnUntraced(function* (
    prepare: Effect.Effect<void, unknown>,
    beforeRelease: Effect.Effect<void, unknown>
  ) {
    if (phase === 'released') return;
    yield* prepare;
    yield* Effect.forEach(resources.values(), (resource) => resource.terminate, {
      concurrency: 'unbounded',
      discard: true,
    });
    yield* Effect.forEach(rawRequests, (raw) => raw, { concurrency: 'unbounded', discard: true });
    yield* beforeRelease;
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
    members: batch ? members.members(batch) : Effect.succeed([]),
    adopt: (next: InboxInput, update: () => void) =>
      inbox.adopt(input, next, id, () => {
        input = next;
        update();
      }),
    /** Retain a terminate handle for background cleanup; an owned execution is not withdrawable. */
    register: (resource: ExecutionResource) =>
      Effect.sync(() => {
        if (!resources.has(resource.key)) resources.set(resource.key, resource);
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
    /** Return an unsubmitted, resource-free execution's input to pending; false if ineligible. */
    withdraw: releaseGate.withPermit(
      Effect.gen(function* () {
        if (firstFinish || phase !== 'prepared' || resources.size > 0 || rawRequests.length > 0)
          return false;
        if (!(yield* inbox.withdraw(input, id))) return false;
        firstFinish = Exit.void;
        phase = 'released';
        yield* Deferred.succeed(released, undefined);
        return true;
      }).pipe(Effect.uninterruptible)
    ),
    awaitReleased: Deferred.await(released),
    recover: (prepare: Effect.Effect<void, unknown>, beforeRelease: Effect.Effect<void, unknown>) =>
      releaseGate.withPermit(recoverWork(prepare, beforeRelease)),
  };
});
export type ExecutionOwner = Effect.Success<ReturnType<typeof makeExecutionOwner>>;
