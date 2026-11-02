import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Scope,
  Semaphore,
} from 'effect';
import {
  LORO_STREAMS_TOKEN_REFRESH_SKEW_MS,
  LoroStreamsTokenAuthError,
  LoroStreamsTokenError,
  LoroStreamsTokenPorts,
  LoroStreamsTokenRequestSchema,
  LoroStreamsTokenResponseSchema,
  loroStreamsTokenStorageKey,
  type CachedLoroStreamsToken,
  type LoroStreamsTokenFailure,
  type LoroStreamsTokenProviderEvent,
} from '../loro-streams-auth';
import { LoroStreamsTokenReleaseFailed } from './io';

export interface LoroStreamsAuthContext {
  /** Only unauthorized rejects a JWT. Other protocol reasons use normal refresh/cache admission. */
  readonly reason: string;
  /** Explicit rejected JWT; otherwise a long-lived auth callback uses its last successful JWT. */
  readonly previousToken?: string;
}

export interface LoroStreamsTokenProviderOptions {
  readonly endpoint: string;
  readonly workspaceId: string;
  readonly refreshSkewMs?: number;
  readonly requestTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly onEvent?: (event: LoroStreamsTokenProviderEvent) => void;
}

export type LoroStreamsTokenReadFailure = LoroStreamsTokenFailure | Cause.TimeoutError;
type TokenFailure = LoroStreamsTokenReadFailure;
export type LoroStreamsTokenAuth = (
  context?: LoroStreamsAuthContext
) => Effect.Effect<string, LoroStreamsTokenReadFailure>;

export type LoroStreamsTokenFailureKind =
  | 'auth'
  | 'credential'
  | 'http'
  | 'response'
  | 'superseded'
  | 'closed'
  | 'timeout'
  | 'interruption'
  | 'release'
  | 'defect'
  | 'unknown-failure';

/** Safe for logging: no tokens, credentials, URLs, messages, stacks, Causes or owners. */
export interface LoroStreamsTokenErrorContext {
  readonly kinds: ReadonlyArray<LoroStreamsTokenFailureKind>;
  readonly authStatuses: ReadonlyArray<401 | 403>;
}

export interface LoroStreamsTokenHealth {
  readonly state: 'open' | 'closing' | 'closed' | 'release-failed';
  readonly closed: boolean;
  readonly generation: number;
  readonly activeReads: number;
  readonly leases: number;
  readonly refreshRunning: boolean;
  readonly pendingRawWork: boolean;
  readonly hasCachedToken: boolean;
  readonly terminalAuthStatus: 401 | 403 | undefined;
  readonly cleanupError: LoroStreamsTokenErrorContext | undefined;
}

export interface LoroStreamsTokenProvider {
  readonly getToken: LoroStreamsTokenAuth;
  readonly createAuthCallback: () => LoroStreamsTokenAuth;
  readonly health: Effect.Effect<LoroStreamsTokenHealth>;
  readonly invalidate: (reason?: 'manual' | 'unauthorized') => Effect.Effect<void>;
  readonly getGatewayBaseUrl: () => string | undefined;
  readonly getShardHostSuffix: () => string | undefined;
  readonly close: Effect.Effect<void>;
  /** Retry retained raw owners after a failed release; never admits new work during close. */
  readonly retryCleanup: Effect.Effect<void>;
}

export class LoroStreamsTokenShutdownFailed extends Data.TaggedError(
  'LoroStreamsTokenShutdownFailed'
)<{ readonly cause: Cause.Cause<unknown>; readonly owner: LoroStreamsTokenProvider }> {}

/** Classifies the entire Cause without serializing external error payloads or recovery owners. */
export function describeLoroStreamsTokenCause(
  cause: Cause.Cause<unknown>
): LoroStreamsTokenErrorContext {
  const kinds = new Set<LoroStreamsTokenFailureKind>();
  const authStatuses = new Set<401 | 403>();
  const seen = new Set<Cause.Cause<unknown>>();
  const pending = [cause];
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const reason of current.reasons) {
      if (Cause.isInterruptReason(reason)) {
        kinds.add('interruption');
      } else if (Cause.isDieReason(reason)) {
        if (reason.defect instanceof LoroStreamsTokenShutdownFailed) {
          kinds.add('release');
          if (Cause.isCause(reason.defect.cause)) pending.push(reason.defect.cause);
        } else if (reason.defect instanceof LoroStreamsTokenReleaseFailed) {
          kinds.add('release');
        } else {
          kinds.add('defect');
        }
      } else if (Cause.isFailReason(reason)) {
        if (reason.error instanceof LoroStreamsTokenAuthError) {
          kinds.add('auth');
          if (reason.error.status === 401 || reason.error.status === 403)
            authStatuses.add(reason.error.status);
        } else if (Cause.isTimeoutError(reason.error)) {
          kinds.add('timeout');
        } else if (reason.error instanceof LoroStreamsTokenError) {
          switch (reason.error.reason) {
            case 'credential':
            case 'http':
            case 'response':
            case 'superseded':
            case 'closed':
              kinds.add(reason.error.reason);
              break;
            default:
              kinds.add('unknown-failure');
          }
        } else {
          kinds.add('unknown-failure');
        }
      }
    }
  }
  return { kinds: [...kinds].sort(), authStatuses: [...authStatuses].sort() };
}

export class LoroStreamsTokens extends Context.Service<
  LoroStreamsTokens,
  LoroStreamsTokenProvider
>()('@lody/shared/LoroStreamsTokens') {}

/** One native kernel. Its caller supplies a provider-specific I/O port and a Scope. */
export const makeLoroStreamsTokenProvider = Effect.fnUntraced(function* (
  options: LoroStreamsTokenProviderOptions
) {
  const cleanupTimeout = options.cleanupTimeoutMs ?? 5_000;
  if (
    !Number.isFinite(cleanupTimeout) ||
    cleanupTimeout <= 0 ||
    cleanupTimeout > 2_147_483_647 / 3
  ) {
    return yield* Effect.die(
      new RangeError('Streams cleanup base must be finite, positive and timer-safe')
    );
  }
  const ports = yield* LoroStreamsTokenPorts;
  const producerScope = yield* Scope.make();
  const serial = yield* Semaphore.make(1);
  const namespace = JSON.stringify([options.endpoint, options.workspaceId]);
  const skew = options.refreshSkewMs ?? LORO_STREAMS_TOKEN_REFRESH_SKEW_MS;
  let credential: string | null | undefined;
  let initialized = false;
  let generation = 0;
  let resolution = 0;
  let resolved = 0;
  let cached: CachedLoroStreamsToken | null = null;
  let rejectedToken: string | undefined;
  let hydrate = true;
  let terminal: LoroStreamsTokenAuthError | undefined;
  let closed = false;
  let closing: Deferred.Deferred<void> | undefined;
  let closeFailure: Cause.Cause<unknown> | undefined;
  let releaseFailure: Cause.Cause<unknown> | undefined;
  let cleanupReceipt: Deferred.Deferred<void> | undefined;
  type Task = {
    fiber: Fiber.Fiber<CachedLoroStreamsToken, TokenFailure>;
    epoch: number;
    leases: number;
  };
  let task: Task | undefined;
  const operations = new Set<Fiber.Fiber<string, TokenFailure>>();

  const emit = (event: LoroStreamsTokenProviderEvent) => options.onEvent?.(event);
  const remove = (key: string) => {
    try {
      ports.storage?.removeItem(loroStreamsTokenStorageKey(key));
    } catch {
      /* Optional cache. */
    }
  };
  const reset = (reason: 'manual' | 'unauthorized') => {
    cached = null;
    hydrate = false;
    remove(namespace);
    if (reason === 'manual') {
      generation++;
      terminal = undefined;
      rejectedToken = undefined;
    }
    emit({ type: 'invalidate', workspaceId: options.workspaceId, reason });
  };
  const superseded = () =>
    new LoroStreamsTokenError({
      reason: 'superseded',
      message: 'Loro Streams token request superseded by an auth change',
    });
  // The producer must have time to report its bounded raw-I/O finalizer Exit;
  // a read must in turn have time to report the producer join's full Cause.
  const bounded = <A, E>(work: Effect.Effect<A, E>, timeoutMs: number) =>
    Effect.raceFirst(
      Effect.interruptible(work),
      Effect.sleep(timeoutMs).pipe(
        Effect.andThen(
          Effect.die(
            new LoroStreamsTokenShutdownFailed({
              cause: Cause.die(
                new LoroStreamsTokenError({
                  reason: 'closed',
                  message: 'Loro Streams producer cleanup did not settle',
                })
              ),
              owner: provider,
            })
          )
        )
      )
    ).pipe(
      Effect.tapCause((cause) =>
        Effect.sync(() => {
          if (Cause.hasDies(cause)) releaseFailure ??= cause;
        })
      )
    );
  const stop = Effect.fnUntraced(function* (current: Task) {
    // v4's interrupt joins without a bound. Signal separately so the join can
    // have its own Clock bound even when called inside a finalizer.
    current.fiber.interruptUnsafe();
    const exit = yield* bounded(Fiber.await(current.fiber), cleanupTimeout * 2);
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      // Ordinary completed request failure has no unresolved resource. Preserve
      // complete mixed interruption/release Causes rather than selecting a Fail.
      if (Cause.hasDies(exit.cause)) {
        releaseFailure ??= exit.cause;
        return yield* Effect.die(
          new LoroStreamsTokenShutdownFailed({ cause: exit.cause, owner: provider })
        );
      }
    }
    if (task === current) task = undefined;
    return undefined;
  });

  const produce = Effect.fnUntraced(function* (auth: string, epoch: number) {
    const current = () => !closed && generation === epoch && credential === auth;
    const assertCurrent = Effect.gen(function* () {
      if (!current()) return yield* Effect.fail(superseded());
      const login = yield* ports.credential;
      if (!current() || login !== auth) return yield* Effect.fail(superseded());
      return undefined;
    });
    const request = Effect.fnUntraced(function* (sent: string | undefined) {
      emit({ type: 'fetch-start', workspaceId: options.workspaceId, endpoint: options.endpoint });
      const started = yield* ports.now;
      const workspace = yield* Effect.try({
        try: () => LoroStreamsTokenRequestSchema.shape.workspaceId.parse(options.workspaceId),
        catch: () =>
          new LoroStreamsTokenError({
            reason: 'response',
            message: 'Invalid Streams workspace id',
          }),
      });
      const response = yield* ports
        .request(options.endpoint, auth, {
          workspaceId: workspace,
          ...(sent ? { rejectedToken: sent } : {}),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const failedStatus = cause.reasons.find(
              (reason) =>
                Cause.isFailReason(reason) &&
                reason.error instanceof LoroStreamsTokenError &&
                (reason.error.status === 401 || reason.error.status === 403)
            );
            if (
              !failedStatus ||
              !Cause.isFailReason(failedStatus) ||
              !(failedStatus.error instanceof LoroStreamsTokenError)
            )
              return Effect.failCause(cause);
            const status = failedStatus.error.status!;
            return Effect.gen(function* () {
              yield* assertCurrent.pipe(
                Effect.catchCause((check) => Effect.failCause(Cause.combine(cause, check)))
              );
              terminal = new LoroStreamsTokenAuthError(
                `Loro Streams token authorization failed (status=${status})`,
                status
              );
              // A failed error-body release does not erase either authorization or
              // I/O failure; terminal suppression still belongs to this credential.
              return yield* Effect.failCause(Cause.combine(Cause.fail(terminal), cause));
            });
          })
        );
      yield* assertCurrent;
      if (response.status < 200 || response.status >= 300) {
        if (response.status === 401 || response.status === 403) {
          terminal = new LoroStreamsTokenAuthError(
            `Loro Streams token authorization failed (status=${response.status})`,
            response.status
          );
          return yield* Effect.fail(terminal);
        }
        return yield* Effect.fail(
          new LoroStreamsTokenError({
            reason: 'http',
            status: response.status,
            message: `Failed to fetch Loro Streams token (status=${response.status})`,
          })
        );
      }
      const parsed = LoroStreamsTokenResponseSchema.safeParse(response.body);
      if (!parsed.success)
        return yield* Effect.fail(
          new LoroStreamsTokenError({
            reason: 'response',
            message: 'Invalid Loro Streams token response',
          })
        );
      yield* assertCurrent;
      return {
        token: parsed.data.token,
        expiresAtMs: started + parsed.data.expiresIn * 1000,
        gatewayBaseUrl: parsed.data.gatewayBaseUrl,
        shardHostSuffix: parsed.data.shardHostSuffix,
      } satisfies CachedLoroStreamsToken;
    });
    if (hydrate) {
      hydrate = false;
      let raw: string | null = null;
      try {
        raw = ports.storage?.getItem(loroStreamsTokenStorageKey(namespace)) ?? null;
      } catch {
        /* Optional cache. */
      }
      if (raw) {
        const stored = yield* ports.decrypt(namespace, auth, raw);
        yield* assertCurrent;
        if (!stored) remove(namespace);
        if (
          stored &&
          stored.token !== rejectedToken &&
          (yield* ports.now) < stored.expiresAtMs - skew
        ) {
          // No asynchronous step between this fence and memory publication.
          if (!current()) return yield* Effect.fail(superseded());
          cached = stored;
          return stored;
        }
      }
    }
    emit({
      type: 'cache-miss',
      workspaceId: options.workspaceId,
      reason: cached ? 'expired-or-stale' : 'missing',
    });
    const sent = rejectedToken;
    let next = yield* request(sent);
    if (rejectedToken !== undefined && rejectedToken !== sent && next.token === rejectedToken) {
      next = yield* request(rejectedToken);
    }
    if (ports.storage) {
      const encrypted = yield* ports.encrypt(namespace, auth, next);
      yield* assertCurrent;
      // Encryption is asynchronous. Read BOTH fences in the synchronous write
      // step: unauthorized invalidation intentionally keeps the credential epoch.
      if (encrypted && current() && next.token !== rejectedToken) {
        try {
          ports.storage.setItem(loroStreamsTokenStorageKey(namespace), encrypted);
        } catch {
          /* Optional cache. */
        }
      }
    }
    const completedAt = yield* ports.now;
    yield* assertCurrent;
    if (!current()) return yield* Effect.fail(superseded());
    cached = next;
    if (next.token !== rejectedToken) rejectedToken = undefined;
    emit({
      type: 'fetch-success',
      workspaceId: options.workspaceId,
      expiresInMs: next.expiresAtMs - completedAt,
      hasGatewayBaseUrl: typeof next.gatewayBaseUrl === 'string',
    });
    return next;
  });

  const readToken = (context?: LoroStreamsAuthContext): Effect.Effect<string, TokenFailure> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (closed)
          return yield* Effect.fail(
            new LoroStreamsTokenError({
              reason: 'closed',
              message: 'Loro Streams token provider closed',
            })
          );
        const ticket = ++resolution;
        const login = yield* restore(ports.credential);
        const selected = yield* serial.withPermit(
          Effect.gen(function* () {
            if (releaseFailure)
              return yield* Effect.die(
                new LoroStreamsTokenShutdownFailed({ cause: releaseFailure, owner: provider })
              );
            if (closed)
              return yield* Effect.fail(
                new LoroStreamsTokenError({
                  reason: 'closed',
                  message: 'Loro Streams token provider closed',
                })
              );
            if (ticket < resolved && login !== credential) return yield* Effect.fail(superseded());
            resolved = Math.max(resolved, ticket);
            if (!initialized || credential !== login) {
              if (initialized) reset('manual');
              else remove(options.workspaceId); // Retire endpoint-agnostic plaintext/old cache.
              if (task) yield* stop(task);
              initialized = true;
              credential = login;
              hydrate = true;
            }
            if (!login)
              return yield* Effect.fail(
                new LoroStreamsTokenAuthError('Missing Loro Streams token provider auth token', 401)
              );
            if (terminal) return yield* Effect.fail(terminal);
            const failed = context?.reason === 'unauthorized' ? context.previousToken : undefined;
            if (failed && cached?.token === failed) {
              rejectedToken = failed;
              reset('unauthorized');
            }
            if (task) {
              const exit = task.fiber.pollUnsafe();
              if (exit) {
                if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) {
                  releaseFailure ??= exit.cause;
                  return yield* Effect.failCause(exit.cause);
                }
                task = undefined;
              }
            }
            if (task) {
              emit({ type: 'in-flight-reuse', workspaceId: options.workspaceId });
              task.leases++;
              return { task };
            }
            const now = yield* ports.now;
            if (cached && now < cached.expiresAtMs - skew) {
              emit({
                type: 'cache-hit',
                workspaceId: options.workspaceId,
                expiresInMs: cached.expiresAtMs - now,
                hasGatewayBaseUrl: typeof cached.gatewayBaseUrl === 'string',
              });
              return { cached };
            }
            const epoch = generation;
            const program = produce(login, epoch).pipe(
              Effect.catchCause((cause) =>
                Effect.uninterruptible(
                  Effect.sync(() =>
                    emit({
                      type: 'fetch-failure',
                      workspaceId: options.workspaceId,
                      error: cause,
                      status: terminal?.status,
                    })
                  ).pipe(
                    Effect.exit,
                    Effect.flatMap((observed) =>
                      Effect.failCause(
                        Exit.isFailure(observed) ? Cause.combine(cause, observed.cause) : cause
                      )
                    )
                  )
                )
              ),
              Effect.interruptible
            );
            const fiber = yield* Effect.forkIn(program, producerScope);
            task = { fiber, epoch, leases: 1 };
            return { task };
          })
        );
        if ('cached' in selected && selected.cached) return selected.cached.token;
        if (!selected.task) return yield* Effect.fail(superseded());
        const current = selected.task;
        return yield* restore(Fiber.join(current.fiber)).pipe(
          Effect.flatMap((value) =>
            generation === current.epoch && !closed
              ? Effect.succeed(value.token)
              : Effect.fail(superseded())
          ),
          Effect.catchCause((cause) =>
            generation !== current.epoch && Cause.hasInterruptsOnly(cause)
              ? Effect.fail(superseded())
              : Effect.failCause(cause)
          ),
          Effect.ensuring(
            serial.withPermit(
              Effect.gen(function* () {
                current.leases--;
                if (task === current && current.leases === 0) yield* stop(current);
              })
            )
          )
        );
      })
    );

  const joinOperation = Effect.fnUntraced(function* (operation: Fiber.Fiber<string, TokenFailure>) {
    operation.interruptUnsafe();
    const exit = yield* bounded(Fiber.await(operation), cleanupTimeout * 3);
    if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) {
      releaseFailure ??= exit.cause;
      return yield* Effect.die(
        new LoroStreamsTokenShutdownFailed({ cause: exit.cause, owner: provider })
      );
    }
    return undefined;
  });
  const getToken = (context?: LoroStreamsAuthContext): Effect.Effect<string, TokenFailure> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (closed)
          return yield* Effect.fail(
            new LoroStreamsTokenError({
              reason: 'closed',
              message: 'Loro Streams token provider closed',
            })
          );
        // Retained release failure fences admission before starting another
        // credential read, not only before replacing the refresh producer.
        if (releaseFailure)
          return yield* Effect.die(
            new LoroStreamsTokenShutdownFailed({ cause: releaseFailure, owner: provider })
          );
        const operation = yield* Effect.forkIn(
          readToken(context).pipe(Effect.interruptible),
          producerScope
        );
        operations.add(operation);
        // A reader cancelled before its first instruction never enters ensuring.
        // The completion observer also runs when the fiber has already ended.
        operation.addObserver(() => operations.delete(operation));
        return yield* restore(
          Fiber.join(operation).pipe(Effect.timeout(options.requestTimeoutMs ?? 30_000))
        ).pipe(Effect.ensuring(joinOperation(operation)));
      })
    );

  const closeWork = Effect.gen(function* () {
    if (task) yield* stop(task);
    yield* ports.cleanup;
    if (operations.size > 0)
      return yield* Effect.die(
        new LoroStreamsTokenError({
          reason: 'closed',
          message: 'Unreleased Streams credential readers still own the Scope',
        })
      );
    yield* Scope.close(producerScope, Exit.void);
    return undefined;
  });
  const close = Effect.uninterruptible(
    Effect.gen(function* () {
      if (closing) return yield* Deferred.await(closing);
      closing = Deferred.makeUnsafe<void>();
      closed = true;
      generation++;
      cached = null;
      const result = yield* Effect.gen(function* () {
        const readers = [...operations];
        for (const reader of readers) reader.interruptUnsafe();
        const exits = yield* Effect.forEach(
          readers,
          (reader) => joinOperation(reader).pipe(Effect.exit),
          { concurrency: 'unbounded' }
        );
        const cleanup = yield* serial.withPermit(closeWork).pipe(Effect.exit);
        const failures = [...exits, cleanup].filter(Exit.isFailure);
        if (failures.length)
          return yield* Effect.failCause(
            failures
              .map((failure) => failure.cause)
              .reduce((left, right) => Cause.combine(left, right))
          );
        return undefined;
      }).pipe(Effect.exit);
      if (Exit.isFailure(result)) {
        closeFailure = result.cause;
        const failed = Exit.die(
          new LoroStreamsTokenShutdownFailed({ cause: result.cause, owner: provider })
        );
        yield* Deferred.done(closing, failed);
        return yield* failed;
      }
      yield* Deferred.done(closing, result);
      return undefined;
    })
  );
  const retryCleanup = Effect.uninterruptible(
    Effect.gen(function* () {
      if (cleanupReceipt) return yield* Deferred.await(cleanupReceipt);
      const receipt = Deferred.makeUnsafe<void>();
      cleanupReceipt = receipt;
      const result = yield* Effect.gen(function* () {
        yield* ports.cleanup;
        // Readers can be running a lease finalizer that needs serial; join them
        // before taking the admission permit ourselves.
        for (const reader of [...operations]) yield* joinOperation(reader);
        yield* serial.withPermit(
          Effect.gen(function* () {
            if (task) {
              task.fiber.interruptUnsafe();
              yield* bounded(Fiber.await(task.fiber), cleanupTimeout * 2);
              task = undefined;
            }
            if (closed) yield* Scope.close(producerScope, Exit.void);
          })
        );
      }).pipe(Effect.exit);
      if (Exit.isFailure(result)) {
        closeFailure = closeFailure ? Cause.combine(closeFailure, result.cause) : result.cause;
        const failed = Exit.die(
          new LoroStreamsTokenShutdownFailed({ cause: closeFailure, owner: provider })
        );
        yield* Deferred.done(receipt, failed);
      } else {
        closeFailure = undefined;
        releaseFailure = undefined;
        if (closed) {
          closing = Deferred.makeUnsafe<void>();
          yield* Deferred.done(closing, Exit.void);
        }
        yield* Deferred.done(receipt, result);
      }
      cleanupReceipt = undefined;
      return yield* Deferred.await(receipt);
    })
  );
  const provider: LoroStreamsTokenProvider = {
    getToken,
    createAuthCallback: () => {
      let lastToken: string | undefined;
      return (context) =>
        getToken(
          context?.reason === 'unauthorized'
            ? { ...context, previousToken: context.previousToken ?? lastToken }
            : context
        ).pipe(
          Effect.tap((token) =>
            Effect.sync(() => {
              lastToken = token;
            })
          )
        );
    },
    health: Effect.sync(() => {
      const failure =
        closeFailure && releaseFailure
          ? Cause.combine(closeFailure, releaseFailure)
          : (closeFailure ?? releaseFailure);
      return {
        state: failure
          ? 'release-failed'
          : closed
            ? closing && !Deferred.isDoneUnsafe(closing)
              ? 'closing'
              : 'closed'
            : 'open',
        closed,
        generation,
        activeReads: operations.size,
        leases: task?.leases ?? 0,
        refreshRunning: task !== undefined && task.fiber.pollUnsafe() === undefined,
        pendingRawWork: ports.hasPending(),
        hasCachedToken: cached !== null,
        terminalAuthStatus:
          terminal?.status === 401 || terminal?.status === 403 ? terminal.status : undefined,
        cleanupError: failure ? describeLoroStreamsTokenCause(failure) : undefined,
      };
    }),
    invalidate: (reason = 'manual') =>
      Effect.gen(function* () {
        if (reason === 'unauthorized') rejectedToken = cached?.token ?? rejectedToken;
        reset(reason);
        if (reason === 'manual')
          yield* serial.withPermit(
            Effect.gen(function* () {
              if (task) yield* stop(task);
            })
          );
      }),
    getGatewayBaseUrl: () => cached?.gatewayBaseUrl,
    getShardHostSuffix: () => cached?.shardHostSuffix,
    close,
    retryCleanup,
  };
  yield* Effect.addFinalizer(() => close);
  return provider;
}) satisfies (
  options: LoroStreamsTokenProviderOptions
) => Effect.Effect<LoroStreamsTokenProvider, never, LoroStreamsTokenPorts | Scope.Scope>;

export const LoroStreamsTokensLive = (
  options: LoroStreamsTokenProviderOptions
): Layer.Layer<LoroStreamsTokens, never, LoroStreamsTokenPorts> =>
  Layer.effect(LoroStreamsTokens, makeLoroStreamsTokenProvider(options));
