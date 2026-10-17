import { Cause, Effect, Exit, Scope, Semaphore } from 'effect';
import { RepoReleaseFailed } from 'loro-repo/effect';
import { DurableReleaseFailure } from '@loro-dev/streams-crdt/effect';

/** Retry the Repo/SDK receipt retained by a failed finalizer, never the closed Scope. */
const recoverWorkspaceRelease = (cause: Cause.Cause<unknown>): Effect.Effect<void, unknown> => {
  const releases = cause.reasons.map((reason): Effect.Effect<void, unknown> | undefined => {
    const error = Cause.isFailReason(reason)
      ? reason.error
      : Cause.isDieReason(reason)
        ? reason.defect
        : undefined;
    return error instanceof RepoReleaseFailed
      ? error.retry
      : error instanceof DurableReleaseFailure
        ? error.retryRelease
        : undefined;
  });
  if (!releases.length || releases.some((release) => release === undefined))
    return Effect.failCause(cause);
  return Effect.forEach(releases, (release) => release ?? Effect.void, {
    concurrency: 'unbounded',
    discard: true,
  });
};

export interface WorkspaceOwnedScope {
  readonly scope: Scope.Closeable;
  readonly close: Effect.Effect<void, RepoReleaseFailed>;
}

/** Acquire registers cleanup before a caller starts workers or borrows a replica. */
export const acquireWorkspaceScope = (resource: string) =>
  Effect.acquireRelease(
    Effect.sync((): WorkspaceOwnedScope => {
      const scope = Scope.makeUnsafe();
      const gate = Semaphore.makeUnsafe(1);
      let released = false;
      let failure: Cause.Cause<unknown> | undefined;
      const close: WorkspaceOwnedScope['close'] = Effect.suspend(() =>
        gate.withPermit(
          Effect.gen(function* () {
            if (released) return;
            const result = yield* (
              failure ? recoverWorkspaceRelease(failure) : Scope.close(scope, Exit.void)
            ).pipe(Effect.exit);
            if (Exit.isFailure(result)) {
              const original = failure;
              failure ??= result.cause;
              yield* Effect.fail(
                new RepoReleaseFailed(
                  resource,
                  original ? Cause.combine(original, result.cause) : result.cause,
                  close
                )
              );
            }
            released = true;
            failure = undefined;
          })
        )
      ).pipe(Effect.uninterruptible);
      return { scope, close };
    }),
    (owner) => owner.close.pipe(Effect.orDie)
  );
