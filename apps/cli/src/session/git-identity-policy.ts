import { Cause, Clock, Effect, Exit } from 'effect';
import type { Logger } from '@/utils/logger';

export const GIT_IDENTITY_POLICY_TIMEOUT_MS = 3_000;

/** Bound the complete policy promise, including work outside the HTTP fetch. */
export const resolveGitIdentityPolicy = Effect.fnUntraced(function* (
  lookup: (signal: AbortSignal) => Promise<{ personalEnabled: boolean }>,
  logger: Pick<Logger, 'debug' | 'warn'>,
  context: string
) {
  const startedAt = yield* Clock.currentTimeMillis;
  let attempt = 0;
  let outcome = 'resolved';
  const policy = yield* Effect.suspend(() => {
    attempt += 1;
    return Effect.tryPromise({ try: lookup, catch: (error) => error }).pipe(
      Effect.timeout(GIT_IDENTITY_POLICY_TIMEOUT_MS),
      Effect.tapError((error) =>
        Effect.sync(() => {
          const attemptOutcome = Cause.isTimeoutError(error) ? 'timeout' : 'rejected';
          logger.warn(
            `[${context}] Git identity policy attempt=${attempt} outcome=${attemptOutcome}`
          );
        })
      )
    );
  }).pipe(
    Effect.retry({ times: 1 }),
    Effect.catch(() => {
      outcome = 'fallback';
      return Effect.succeed({ personalEnabled: false });
    })
  );
  const finishedAt = yield* Clock.currentTimeMillis;
  logger.debug(
    `[${context}] Git identity policy outcome=${outcome} elapsedMs=${finishedAt - startedAt} attempts=${attempt} personalEnabled=${policy.personalEnabled}`
  );
  return policy;
});

/** @deprecated Temporary Promise boundary for SessionManager. */
export async function resolveGitIdentityPolicyLegacy(
  lookup: (signal: AbortSignal) => Promise<{ personalEnabled: boolean }>,
  logger: Pick<Logger, 'debug' | 'warn'>,
  context: string,
  signal?: AbortSignal
): Promise<{ personalEnabled: boolean }> {
  signal?.throwIfAborted();
  const startedAt = performance.now();
  const exit = await Effect.runPromiseExit(resolveGitIdentityPolicy(lookup, logger, context), {
    signal,
  });
  if (signal?.aborted) {
    logger.debug(
      `[${context}] Git identity policy outcome=cancelled elapsedMs=${Math.round(performance.now() - startedAt)}`
    );
    signal.throwIfAborted();
  }
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  return exit.value;
}

/**
 * The owner's dispatch profile is a placeholder (owner turns skip the profile query), so an
 * owner who approved "Act as you" needs one bounded account lookup. Failure keeps the
 * owner's local Git identity for this turn instead of blocking it.
 */
export const resolveApprovedOwnerIdentity = Effect.fnUntraced(function* (
  lookup: () => Promise<{ name: string; email: string } | null>,
  logger: Pick<Logger, 'debug' | 'warn'>,
  context: string
) {
  return yield* Effect.tryPromise({ try: lookup, catch: (error) => error }).pipe(
    Effect.timeout(GIT_IDENTITY_POLICY_TIMEOUT_MS),
    Effect.map((identity) => identity ?? undefined),
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn(
          `[${context}] Approved owner Git identity outcome=${Cause.isTimeoutError(error) ? 'timeout' : 'rejected'}; using local Git identity`
        );
        return undefined;
      })
    )
  );
});

/** @deprecated Temporary Promise boundary for SessionManager. */
export async function resolveApprovedOwnerIdentityLegacy(
  lookup: () => Promise<{ name: string; email: string } | null>,
  logger: Pick<Logger, 'debug' | 'warn'>,
  context: string,
  signal?: AbortSignal
): Promise<{ name: string; email: string } | undefined> {
  signal?.throwIfAborted();
  const exit = await Effect.runPromiseExit(resolveApprovedOwnerIdentity(lookup, logger, context), {
    signal,
  });
  signal?.throwIfAborted();
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  return exit.value;
}
