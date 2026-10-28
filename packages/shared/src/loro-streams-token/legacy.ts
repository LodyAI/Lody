import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime } from 'effect';
import {
  LoroStreamsTokenError,
  LoroStreamsTokenAuthError,
  LoroStreamsTokenWebLive,
  type FetchLike,
  type LoroStreamsTokenProviderEvent,
} from '../loro-streams-auth';
import { LoroStreamsTokens, LoroStreamsTokensLive, type LoroStreamsTokenProvider } from './service';

/** Full Cause and retained cleanup owners remain available across the Promise boundary. */
export class LoroStreamsTokenLegacyFailure extends Error {
  constructor(readonly effectCause: Cause.Cause<unknown>) {
    super(Cause.pretty(effectCause));
    this.name = 'LoroStreamsTokenLegacyFailure';
  }
}

function project(cause: Cause.Cause<unknown>): unknown {
  if (cause.reasons.length !== 1) return new LoroStreamsTokenLegacyFailure(cause);
  const reason = cause.reasons[0];
  if (!reason) return new LoroStreamsTokenLegacyFailure(cause);
  if (Cause.isFailReason(reason)) {
    const error = reason.error;
    if (error instanceof LoroStreamsTokenError && error.cause instanceof Error) return error.cause;
    return error;
  }
  if (Cause.isDieReason(reason)) return reason.defect;
  return new LoroStreamsTokenLegacyFailure(cause);
}

/**
 * @deprecated The only execution facade for renderer/durable/Machine RPC Promise callers.
 * Delete when those owners compose LoroStreamsTokens with their application Scope.
 */
type OwnedLegacyOptions = {
  endpoint: string;
  workspaceId: string;
  authToken:
    | string
    | null
    | undefined
    | ((signal?: AbortSignal) => Promise<string | null | undefined> | string | null | undefined);
  fetchImpl?: FetchLike;
  refreshSkewMs?: number;
  requestTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  onEvent?: (event: LoroStreamsTokenProviderEvent) => void;
};

type BorrowedLegacyOptions = {
  readonly provider: LoroStreamsTokenProvider;
  readonly executor: {
    readonly runPromiseExit: <A, E>(
      effect: Effect.Effect<A, E>,
      options?: { signal?: AbortSignal }
    ) => Promise<Exit.Exit<A, E>>;
    readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  };
};

/** @deprecated One facade; borrowing an application-owned provider creates no runtime or cache. */
export function createLoroStreamsTokenProviderLegacy(
  options: OwnedLegacyOptions | BorrowedLegacyOptions
) {
  const borrowed = 'provider' in options ? options : undefined;
  const owned = 'provider' in options ? undefined : options;
  const layer = owned
    ? LoroStreamsTokensLive(owned).pipe(
        Layer.provide(
          LoroStreamsTokenWebLive({
            credential: Effect.succeed(undefined),
            resolveCredentialLegacy: (signal) =>
              Promise.resolve(
                typeof owned.authToken === 'function' ? owned.authToken(signal) : owned.authToken
              ),
            fetchImpl: owned.fetchImpl,
            cleanupTimeoutMs: owned.cleanupTimeoutMs,
          })
        )
      )
    : undefined;
  const runtime = layer ? ManagedRuntime.make(layer) : undefined;
  let provider: LoroStreamsTokenProvider | undefined = borrowed?.provider;
  let closeReceipt: Promise<void> | undefined;
  let closing = false;
  const invalidations = new Set<Fiber.Fiber<void>>();
  const program = Effect.fnUntraced(function* <A, E>(
    operation: (tokens: LoroStreamsTokenProvider) => Effect.Effect<A, E>
  ) {
    const tokens = yield* LoroStreamsTokens;
    provider = tokens;
    return yield* operation(tokens);
  });
  const run = <A, E>(
    operation: (tokens: LoroStreamsTokenProvider) => Effect.Effect<A, E>,
    signal?: AbortSignal
  ): Promise<A> => {
    const exit = borrowed
      ? borrowed.executor.runPromiseExit(
          Effect.suspend(() => operation(borrowed.provider)),
          { signal }
        )
      : runtime
        ? runtime.runPromiseExit(program(operation), { signal })
        : Promise.reject(new Error('Streams token executor unavailable'));
    return exit.then((result) => {
      if (Exit.isFailure(result)) throw project(result.cause);
      return result.value;
    });
  };
  return {
    getToken: (signal?: AbortSignal) => run((tokens) => tokens.getToken(), signal),
    invalidate: (reason: 'manual' | 'unauthorized' = 'manual'): void => {
      // The imperative caller retains its old synchronous signature. A failed
      // invalidation stays observable through the retained provider/close receipt.
      // Close already fenced publication. Teardown retries may invalidate the
      // same retained owner again; cleanup/close receipts still report failure.
      if (closing) return;
      const fiber = borrowed
        ? borrowed.executor.runFork(borrowed.provider.invalidate(reason))
        : runtime
          ? runtime.runFork(program((tokens) => tokens.invalidate(reason)))
          : (() => {
              throw new Error('Streams token executor unavailable');
            })();
      invalidations.add(fiber);
      fiber.addObserver((exit) => {
        if (Exit.isSuccess(exit)) invalidations.delete(fiber);
      });
    },
    getGatewayBaseUrl: () => provider?.getGatewayBaseUrl(),
    getShardHostSuffix: () => provider?.getShardHostSuffix(),
    createAuthCallback: () => {
      let auth: ReturnType<LoroStreamsTokenProvider['createAuthCallback']> | undefined;
      return (context?: { reason: string; previousToken?: string }, signal?: AbortSignal) =>
        run((tokens) => {
          auth ??= tokens.createAuthCallback();
          // Undefined belongs only to the old transport protocol. Preserve every
          // non-auth reason, including mixed auth/interruption/release Causes.
          return auth(context).pipe(
            Effect.catchCause((cause) =>
              cause.reasons.length > 0 &&
              cause.reasons.every(
                (reason) =>
                  Cause.isFailReason(reason) && reason.error instanceof LoroStreamsTokenAuthError
              )
                ? Effect.succeed(undefined)
                : Effect.failCause(cause)
            )
          );
        }, signal);
    },
    close: () => {
      closing = true;
      return (closeReceipt ??= run((tokens) =>
        Effect.gen(function* () {
          const closed = yield* tokens.close.pipe(Effect.exit);
          // The facade is the explicit owner of its synchronous invalidate launches.
          // Native close has already fenced admission and joined their shared producer.
          const exits = yield* Effect.forEach([...invalidations], Fiber.await);
          const failures = [closed, ...exits].filter(Exit.isFailure);
          if (failures.length)
            return yield* Effect.failCause(
              failures.map((exit) => exit.cause).reduce((left, right) => Cause.combine(left, right))
            );
          return undefined;
        })
      ).then(async () => {
        if (!runtime) return;
        const exit = await Effect.runPromiseExit(runtime.disposeEffect);
        if (Exit.isFailure(exit)) throw project(exit.cause);
      }));
    },
    retryCleanup: () =>
      run((tokens) => tokens.retryCleanup).then(() => {
        invalidations.clear();
        closeReceipt = undefined;
      }),
  };
}
