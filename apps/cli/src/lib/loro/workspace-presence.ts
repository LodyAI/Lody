import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Scope,
  Semaphore,
} from 'effect';
import {
  LODY_PRESENCE_HEARTBEAT_MS,
  LODY_PRESENCE_TTL_MS,
  LoroStreamsTokenShutdownFailed,
  type LoroStreamsTokenProvider,
  type LodyPresenceInstanceId,
  type WorkspaceId,
} from '@lody/shared';
import type { EphemeralStore } from 'loro-crdt';
import { PresenceReplica } from './presence-replica';

export interface PresenceStats {
  readonly status: string;
  readonly pendingLocalCount: number;
  readonly physicalEntries: number;
  readonly queuedBytes: number;
  readonly lastLocalAppendAtMs?: number;
  readonly lastWriteError?: { readonly code: string; readonly retryable: boolean };
  readonly releasePending: number;
}
export interface PresenceSubscription {
  readonly syncBarrier: () => Effect.Effect<void, unknown>;
}
export interface PresenceStream {
  readonly join: (options: {
    onStatusChange: (status: string) => void;
  }) => Effect.Effect<PresenceSubscription, unknown, Scope.Scope>;
  readonly rejoin: Effect.Effect<void, unknown>;
  readonly close: Effect.Effect<void, unknown>;
  readonly retryRelease: Effect.Effect<void, unknown>;
  readonly stats: PresenceStats;
}
export interface PresenceRemoteOptions {
  readonly streamsBaseUrl: string;
  readonly shardHostSuffix?: string;
  /** Borrowed from the workspace token owner. Remote detach never closes it. */
  readonly auth: (context?: {
    reason: string;
    previousToken?: string;
  }) => Effect.Effect<string | undefined, unknown>;
}
export class PresenceTransport extends Context.Service<
  PresenceTransport,
  {
    /** Concrete SDK adapter recognizes its typed release failures, including pending=0. */
    readonly isReleaseFailure: (cause: Cause.Cause<unknown>) => boolean;
    readonly create: (
      workspaceId: WorkspaceId,
      store: EphemeralStore,
      options: PresenceRemoteOptions,
      generation: number
    ) => Effect.Effect<PresenceStream, never, Scope.Scope>;
  }
>()('lody/loro/PresenceTransport') {}
export interface PresenceDiagnostic {
  readonly stage: 'heartbeat' | 'bootstrap' | 'joined' | 'retry' | 'barrier' | 'stall' | 'release';
  readonly generation: number;
  readonly attempt?: number;
  readonly code?: string;
  readonly ageMs?: number;
  readonly stats?: PresenceStats;
}
export class PresenceHost extends Context.Service<
  PresenceHost,
  {
    readonly instanceId: () => LodyPresenceInstanceId;
    readonly serverOffsetMs: () => number;
    readonly report: (workspaceId: WorkspaceId, event: PresenceDiagnostic) => void;
  }
>()('lody/loro/PresenceHost') {}
export class PresenceUnavailable extends Data.TaggedError('PresenceUnavailable')<{
  readonly stage: 'closed' | 'detached' | 'bootstrap' | 'configuration';
}> {}
export class PresenceDeliveryStalled extends Data.TaggedError('PresenceDeliveryStalled')<{
  readonly generation: number;
  readonly ageMs: number;
}> {}
export class PresenceReleaseFailed extends Data.TaggedError('PresenceReleaseFailed')<{
  readonly cause: Cause.Cause<unknown>;
  readonly owner: WorkspacePresence;
  readonly generation: number;
}> {}
export interface WorkspacePresence {
  readonly replica: PresenceReplica;
  readonly createTokenProvider: (
    factory: Effect.Effect<LoroStreamsTokenProvider, never, Scope.Scope>
  ) => Effect.Effect<LoroStreamsTokenProvider, PresenceUnavailable>;
  readonly attach: (
    options: PresenceRemoteOptions
  ) => Effect.Effect<void, PresenceReleaseFailed | PresenceUnavailable>;
  readonly detach: Effect.Effect<void, PresenceReleaseFailed>;
  readonly stop: Effect.Effect<void, PresenceReleaseFailed>;
  readonly retryCleanup: Effect.Effect<void, PresenceReleaseFailed>;
  readonly waitUntilJoined: (timeoutMs: number) => Effect.Effect<void, PresenceUnavailable>;
  readonly failure: () => Cause.Cause<unknown>;
  readonly isReleased: () => boolean;
  readonly deliveryHealth: () => PresenceDeliveryStalled | 'unknown' | 'pending' | 'idle';
}
type Generation = {
  readonly id: number;
  readonly scope: Scope.Closeable;
  ready: Deferred.Deferred<void, PresenceUnavailable>;
  readonly events: Queue.Queue<string>;
  readonly tasks: Set<Fiber.Fiber<void, unknown>>;
  health: PresenceDeliveryStalled | 'unknown' | 'pending' | 'idle';
  active: boolean;
  joined: boolean;
  stream?: PresenceStream;
  subscription?: PresenceSubscription;
  probe?: Fiber.Fiber<void, unknown>;
  closeWork?: Fiber.Fiber<void, unknown>;
  scopeClose?: Fiber.Fiber<void>;
  receipt?: Deferred.Deferred<void, PresenceReleaseFailed>;
  cause: Cause.Cause<unknown>;
};
const JOIN_BACKOFF = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const REJOIN_BACKOFF = [2_000, 5_000, 10_000, 30_000, 60_000];

/** Workspace child owner. No execution runtime, Promise coordinator, or transport queue. */
export const makeWorkspacePresence = Effect.fnUntraced(function* (
  workspaceId: WorkspaceId,
  options: { releaseTimeoutMs?: number; bootstrapTimeoutMs?: number } = {}
): Effect.fn.Return<WorkspacePresence, never, PresenceTransport | PresenceHost | Scope.Scope> {
  const transport = yield* PresenceTransport;
  const host = yield* PresenceHost;
  const budget = options.releaseTimeoutMs ?? 5_000;
  const bootstrapBudget = options.bootstrapTimeoutMs ?? 10_000;
  if (
    !Number.isFinite(budget) ||
    budget <= 0 ||
    budget > 2_147_483_647 ||
    !Number.isFinite(bootstrapBudget) ||
    bootstrapBudget <= 0 ||
    bootstrapBudget > 2_147_483_647
  )
    return yield* Effect.die(new RangeError('Invalid presence release budget'));
  const scope = yield* Scope.make();
  const gate = yield* Semaphore.make(1);
  const replica = new PresenceReplica(host.instanceId());
  let generation: Generation | undefined;
  let sequence = 0;
  let stopped = false;
  let released = false;
  let failure: Cause.Cause<unknown> = Cause.empty;
  const observedFailures = new WeakSet<object>();
  let stopReceipt: Deferred.Deferred<void, PresenceReleaseFailed> | undefined;
  let heartbeat: Fiber.Fiber<void, unknown> | undefined;
  let workspaceScopeClose: Fiber.Fiber<void> | undefined;
  const tokenProviders = new Set<LoroStreamsTokenProvider>();
  let api: WorkspacePresence;
  const report = (event: PresenceDiagnostic) => host.report(workspaceId, event);
  const now = Clock.currentTimeMillis.pipe(Effect.map((time) => time + host.serverOffsetMs()));
  const releaseError = (g?: Generation) =>
    new PresenceReleaseFailed({ cause: failure, owner: api, generation: g?.id ?? sequence });
  const retain = (cause: Cause.Cause<unknown>, g?: Generation) => {
    failure = Cause.combine(failure, cause);
    if (g) g.cause = Cause.combine(g.cause, cause);
  };
  // Restore the owning mask before the Exit handler: v4 can otherwise strip
  // typed failures when interruption skips that handler. Retain the raw result.
  const rawExit = <A, E, R>(program: Effect.Effect<A, E, R>, g?: Generation) =>
    Effect.uninterruptibleMask((restore) =>
      restore(program).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
              if (g) g.cause = Cause.combine(g.cause, exit.cause);
              if (!g || !g.active) retain(exit.cause, g);
            }
          })
        )
      )
    );
  // Bound the interruptible observer, never timeout an uninterruptible release body.
  // The original Fiber and its eventual complete Exit stay reachable after timeout.
  const awaitActual = Effect.fnUntraced(function* <A, E>(
    fiber: Fiber.Fiber<A, E>,
    g?: Generation,
    recovered = false
  ) {
    const waited = yield* Effect.interruptible(Fiber.await(fiber)).pipe(
      Effect.timeoutOption(budget)
    );
    const result = Option.isSome(waited) ? waited.value : fiber.pollUnsafe();
    if (!result) {
      retain(Cause.fail(new Cause.TimeoutError()), g);
      return yield* Effect.fail(releaseError(g));
    }
    if (Exit.isFailure(result) && !Cause.hasInterruptsOnly(result.cause)) {
      if (!observedFailures.has(fiber)) {
        observedFailures.add(fiber);
        retain(result.cause, g);
      }
      if (!recovered) return yield* Effect.fail(releaseError(g));
    }

    return undefined;
  });
  const owned = Effect.fnUntraced(function* (g: Generation, effect: Effect.Effect<void, unknown>) {
    const fiber = yield* Effect.forkIn(
      Effect.interruptible(rawExit(effect, g).pipe(Effect.flatMap((exit) => exit))),
      g.scope
    );
    g.tasks.add(fiber);
    return fiber;
  });
  const startProbe = Effect.fnUntraced(function* (g: Generation) {
    if (!g.active || !g.subscription || (g.probe && !g.probe.pollUnsafe())) return undefined;
    if (g.probe) g.tasks.delete(g.probe);
    const barrier = g.subscription.syncBarrier();
    const capturedAtMs = yield* Clock.currentTimeMillis;
    g.probe = yield* owned(
      g,
      Effect.gen(function* () {
        yield* barrier;
        if (!g.active || generation !== g) return undefined;
        // This is a captured queue barrier; it is neither a per-write ACK nor peer receipt.
        report({
          stage: 'barrier',
          generation: g.id,
          ageMs: Math.max(0, (yield* Clock.currentTimeMillis) - capturedAtMs),
          stats: g.stream?.stats,
        });

        return undefined;
      })
    );

    return undefined;
  });
  const heartbeatOnce = Effect.gen(function* () {
    const time = yield* now;
    if (!replica.heartbeat(time)) return undefined;
    const g = generation;
    report({ stage: 'heartbeat', generation: g?.id ?? sequence, stats: g?.stream?.stats });
    if (g?.active) yield* startProbe(g);

    return undefined;
  });
  heartbeat = yield* Effect.forkIn(
    Effect.interruptible(
      rawExit(
        Effect.forever(Effect.sleep(LODY_PRESENCE_HEARTBEAT_MS).pipe(Effect.andThen(heartbeatOnce)))
      ).pipe(Effect.flatMap((exit) => exit))
    ),
    scope
  );

  const releaseGeneration = Effect.fnUntraced(function* (g: Generation, retry: boolean) {
    if (g.receipt && !retry) return yield* Deferred.await(g.receipt);
    // Recovery itself also has a shared receipt; failed completed receipts can be retried.
    if (g.receipt && !Deferred.isDoneUnsafe(g.receipt)) return yield* Deferred.await(g.receipt);
    const done = Deferred.makeUnsafe<void, PresenceReleaseFailed>();
    g.receipt = done;
    g.active = false;
    g.joined = false;
    g.health = 'unknown';
    Deferred.doneUnsafe(g.ready, Effect.fail(new PresenceUnavailable({ stage: 'detached' })));
    for (const task of g.tasks) task.interruptUnsafe();
    const result = yield* Effect.gen(function* () {
      if (!g.closeWork)
        g.closeWork = yield* Effect.forkDetach(
          rawExit(g.stream?.close ?? Effect.void, g).pipe(Effect.flatMap((exit) => exit))
        );
      const previous = g.closeWork.pollUnsafe();
      if (retry && previous && Exit.isFailure(previous))
        g.closeWork = yield* Effect.forkDetach(
          rawExit(g.stream?.retryRelease ?? Effect.void, g).pipe(Effect.flatMap((exit) => exit))
        );
      const closeExit = yield* awaitActual(g.closeWork, g).pipe(Effect.exit);
      // Readiness cancellation may run native subscription finalizers; inspect actual Exits.
      const taskExits = yield* Effect.forEach(
        [...g.tasks],
        (task) => awaitActual(task, g, retry && Exit.isSuccess(closeExit)).pipe(Effect.exit),
        { concurrency: 'unbounded' }
      );
      if (Exit.isFailure(closeExit) || taskExits.some(Exit.isFailure))
        return yield* Effect.fail(releaseError(g));
      g.scopeClose ??= yield* Effect.forkDetach(Scope.close(g.scope, Exit.void));
      yield* awaitActual(g.scopeClose, g);
      if (generation === g) generation = undefined;
      report({ stage: 'release', generation: g.id });

      return undefined;
    }).pipe(Effect.exit);
    yield* Deferred.done(done, result);
    return yield* result;
  });
  const detach = Effect.uninterruptible(
    Effect.suspend(() => (generation ? releaseGeneration(generation, false) : Effect.void))
  );
  const blockUnreleased = (g: Generation, cause: Cause.Cause<unknown>): boolean => {
    if (
      !transport.isReleaseFailure(cause) &&
      !(g.stream && g.stream.stats.releasePending > 0) &&
      !cause.reasons.some(Cause.isDieReason)
    )
      return false;
    retain(cause, g);
    g.active = false;
    g.joined = false;
    Deferred.doneUnsafe(g.ready, Effect.fail(new PresenceUnavailable({ stage: 'bootstrap' })));
    return true;
  };
  const attach = Effect.fnUntraced(
    function* (remote: PresenceRemoteOptions) {
      if (stopped) return yield* Effect.fail(new PresenceUnavailable({ stage: 'closed' }));
      if (generation) {
        if (generation.active) return undefined;
        return yield* Effect.fail(releaseError(generation));
      }
      if (!remote.streamsBaseUrl)
        return yield* Effect.fail(new PresenceUnavailable({ stage: 'configuration' }));
      const g: Generation = {
        id: ++sequence,
        scope: yield* Scope.make(),
        ready: Deferred.makeUnsafe(),
        events: yield* Queue.unbounded<string>(),
        tasks: new Set(),
        health: 'unknown',
        active: true,
        joined: false,
        cause: Cause.empty,
      };
      generation = g;
      const made = yield* Scope.provide(
        transport.create(workspaceId, replica.store, remote, g.id),
        g.scope
      ).pipe(Effect.exit);
      if (Exit.isFailure(made)) {
        retain(made.cause, g);
        yield* releaseGeneration(g, false);
        return yield* Effect.failCause(made.cause);
      }
      g.stream = made.value;
      if (!g.active || generation !== g) {
        yield* releaseGeneration(g, false);
        return yield* Effect.fail(new PresenceUnavailable({ stage: 'detached' }));
      }
      const stream = made.value;
      yield* owned(
        g,
        Effect.gen(function* () {
          yield* Effect.sleep(bootstrapBudget);
          if (!g.active || generation !== g || g.subscription) return undefined;
          // Observe the shared bootstrap; do not cancel it or create a reconnect storm.
          g.cause = Cause.combine(
            g.cause,
            Cause.fail(new PresenceUnavailable({ stage: 'bootstrap' }))
          );
          report({
            stage: 'retry',
            generation: g.id,
            code: 'first_join_no_bootstrap',
            ageMs: bootstrapBudget,
          });
          return undefined;
        })
      );
      yield* owned(
        g,
        Effect.gen(function* () {
          let attempt = 0;
          while (g.active) {
            report({ stage: 'bootstrap', generation: g.id, attempt });
            const joined = yield* rawExit(
              Scope.provide(
                stream.join({
                  onStatusChange: (status) => {
                    if (!g.active || generation !== g) return;
                    // Retire availability in the callback's synchronous step.
                    // A reader can arrive before the owned event fiber resumes.
                    if (status !== 'joined' && g.joined) {
                      g.joined = false;
                      g.ready = Deferred.makeUnsafe();
                    }
                    Queue.offerUnsafe(g.events, status);
                  },
                }),
                g.scope
              ),
              g
            );
            if (!g.active || generation !== g) {
              if (Exit.isFailure(joined) && !Cause.hasInterruptsOnly(joined.cause)) {
                return yield* Effect.failCause(joined.cause);
              }
              return undefined;
            }
            if (Exit.isSuccess(joined)) {
              g.subscription = joined.value;
              return undefined;
            }
            // Release defects and unresolved work forbid any replacement/rejoin.
            if (blockUnreleased(g, joined.cause)) return undefined;
            report({ stage: 'retry', generation: g.id, attempt, code: 'join_failed' });
            yield* Effect.sleep(
              JOIN_BACKOFF[Math.min(attempt++, JOIN_BACKOFF.length - 1)] ?? 30_000
            );
          }

          return undefined;
        })
      );
      yield* owned(
        g,
        Effect.gen(function* () {
          let attempt = 0;
          let joinedAt = 0;
          while (g.active) {
            const status = yield* Queue.take(g.events);
            if (!g.active || generation !== g) return undefined;
            if (status === 'joined') {
              if (stream.stats.status !== 'joined') continue;
              g.joined = true;
              joinedAt = yield* Clock.currentTimeMillis;
              Deferred.doneUnsafe(g.ready, Effect.void);
              replica.republish(yield* now);
              report({ stage: 'joined', generation: g.id, stats: stream.stats });
            } else {
              if (g.joined) g.ready = Deferred.makeUnsafe();
              g.joined = false;
              if (status !== 'error' && status !== 'disconnected') continue;
              if ((yield* Clock.currentTimeMillis) - joinedAt >= 5_000) attempt = 0;
              yield* Effect.sleep(
                REJOIN_BACKOFF[Math.min(attempt++, REJOIN_BACKOFF.length - 1)] ?? 60_000
              );
              if (!g.active || generation !== g || stream.stats.status === 'joined') continue;
              report({ stage: 'retry', generation: g.id, attempt, code: 'terminal_room' });
              let reconnect = yield* rawExit(stream.rejoin, g);
              while (Exit.isFailure(reconnect) && g.active) {
                if (blockUnreleased(g, reconnect.cause)) return undefined;
                report({ stage: 'retry', generation: g.id, attempt, code: 'rejoin_failed' });
                yield* Effect.sleep(
                  REJOIN_BACKOFF[Math.min(attempt++, REJOIN_BACKOFF.length - 1)] ?? 60_000
                );
                if (!g.active || generation !== g) return undefined;
                reconnect = yield* rawExit(stream.rejoin, g);
              }
            }
          }

          return undefined;
        })
      );
      yield* owned(
        g,
        Effect.gen(function* () {
          let lastProgress = yield* Clock.currentTimeMillis;
          let lastAck = stream.stats.lastLocalAppendAtMs;
          let warned = false;
          while (g.active) {
            yield* Effect.sleep(LODY_PRESENCE_HEARTBEAT_MS);
            const stats = stream.stats;
            const time = yield* Clock.currentTimeMillis;
            if (stats.pendingLocalCount === 0 || stats.lastLocalAppendAtMs !== lastAck) {
              g.health = stats.pendingLocalCount === 0 ? 'idle' : 'pending';
              lastProgress = time;
              lastAck = stats.lastLocalAppendAtMs;
              warned = false;
            } else if (time - lastProgress >= LODY_PRESENCE_TTL_MS && !warned) {
              warned = true;
              g.health = new PresenceDeliveryStalled({
                generation: g.id,
                ageMs: time - lastProgress,
              });
              report({
                stage: 'stall',
                generation: g.id,
                code: 'upload_no_progress',
                ageMs: time - lastProgress,
                stats,
              });
            }
          }

          return undefined;
        })
      );

      return undefined;
    },
    (effect) => gate.withPermit(Effect.uninterruptible(effect))
  );
  const finishStop = Effect.fnUntraced(function* (retry: boolean) {
    stopped = true;
    heartbeat?.interruptUnsafe();
    const retired = yield* Effect.sync(() => replica.retire()).pipe(Effect.exit);
    if (Exit.isFailure(retired)) retain(retired.cause);
    if (generation) yield* releaseGeneration(generation, retry);
    if (heartbeat) yield* awaitActual(heartbeat, undefined, retry);
    workspaceScopeClose ??= yield* Effect.forkDetach(Scope.close(scope, Exit.void));
    let tokenCleanupRecovered = false;
    const scopeExit = workspaceScopeClose.pollUnsafe();
    if (retry && scopeExit && Exit.isFailure(scopeExit)) {
      const failures = scopeExit.cause.reasons.flatMap((reason) =>
        Cause.isDieReason(reason) &&
        reason.defect instanceof LoroStreamsTokenShutdownFailed &&
        tokenProviders.has(reason.defect.owner)
          ? [reason.defect]
          : []
      );
      if (failures.length === scopeExit.cause.reasons.length) {
        for (const provider of new Set(failures.map((failed) => failed.owner)))
          yield* provider.retryCleanup;
        tokenCleanupRecovered = true;
      }
    }
    yield* awaitActual(workspaceScopeClose, undefined, tokenCleanupRecovered);
    replica.destroy();
    if (Exit.isFailure(retired)) return yield* Effect.fail(releaseError());
    released = true;

    return undefined;
  });
  const startStop = (retry: boolean): Effect.Effect<void, PresenceReleaseFailed> =>
    Effect.uninterruptible(
      Effect.suspend(() => {
        if (stopReceipt && (!retry || !Deferred.isDoneUnsafe(stopReceipt)))
          return Deferred.await(stopReceipt);
        stopReceipt = Deferred.makeUnsafe();
        const done = stopReceipt;
        return finishStop(retry).pipe(
          Effect.catchCause((cause) => {
            const reason = cause.reasons[0];
            if (
              cause.reasons.length === 1 &&
              reason &&
              Cause.isFailReason(reason) &&
              reason.error instanceof PresenceReleaseFailed
            )
              return Effect.fail(reason.error);
            // Synchronous CRDT/listener/destructor defects also transfer this owner.
            retain(cause);
            return Effect.fail(releaseError());
          }),
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(done, exit).pipe(Effect.andThen(exit)))
        );
      })
    );
  const stop = startStop(false);
  const retryCleanup = Effect.uninterruptible(
    Effect.suspend(() =>
      stopped ? startStop(true) : generation ? releaseGeneration(generation, true) : Effect.void
    )
  );
  api = {
    replica,
    createTokenProvider: (factory) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (stopped) return yield* Effect.fail(new PresenceUnavailable({ stage: 'closed' }));
          const provider = yield* Scope.provide(factory, scope);
          tokenProviders.add(provider);
          if (stopped) {
            yield* provider.close;
            return yield* Effect.fail(new PresenceUnavailable({ stage: 'closed' }));
          }
          return provider;
        })
      ),
    attach,
    detach,
    stop,
    retryCleanup,
    waitUntilJoined: (timeoutMs) =>
      Effect.suspend(() => {
        const g = generation;
        if (stopped) return Effect.fail(new PresenceUnavailable({ stage: 'closed' }));
        if (!g?.active) return Effect.fail(new PresenceUnavailable({ stage: 'detached' }));
        if (g.joined && g.stream?.stats.status === 'joined') return Effect.void;
        return Deferred.await(g.ready).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () => Effect.fail(new PresenceUnavailable({ stage: 'bootstrap' })),
          }),
          Effect.andThen(
            Effect.suspend(() =>
              g.active && g.joined && generation === g && g.stream?.stats.status === 'joined'
                ? Effect.void
                : Effect.fail(new PresenceUnavailable({ stage: 'detached' }))
            )
          )
        );
      }),
    failure: () => (generation ? Cause.combine(failure, generation.cause) : failure),
    isReleased: () => released,
    deliveryHealth: () => generation?.health ?? 'unknown',
  };
  yield* Effect.addFinalizer(() => stop.pipe(Effect.orDie));
  return api;
}, Effect.uninterruptible);

/** Application registry retains workspace owners; it never creates a per-workspace runtime. */
export class WorkspacePresenceOwners extends Context.Service<
  WorkspacePresenceOwners,
  {
    readonly create: (
      workspaceId: WorkspaceId
    ) => Effect.Effect<WorkspacePresence, PresenceReleaseFailed>;
  }
>()('lody/loro/WorkspacePresenceOwners') {}
export const WorkspacePresenceOwnersLive = Layer.effect(
  WorkspacePresenceOwners,
  Effect.gen(function* () {
    const root = yield* Scope.Scope;
    const services = yield* Effect.context<PresenceHost | PresenceTransport>();
    const owners = new Map<WorkspaceId, WorkspacePresence>();
    const gate = yield* Semaphore.make(1);
    return WorkspacePresenceOwners.of({
      create: (workspaceId) =>
        gate.withPermit(
          Effect.gen(function* () {
            const previous = owners.get(workspaceId);
            if (previous && !previous.isReleased())
              return yield* Effect.fail(
                new PresenceReleaseFailed({
                  cause: previous.failure(),
                  owner: previous,
                  generation: 0,
                })
              );
            const owner = yield* Scope.provide(
              makeWorkspacePresence(workspaceId).pipe(Effect.provideContext(services)),
              root
            );
            owners.set(workspaceId, owner);
            return owner;
          })
        ),
    });
  })
);

/** Recover the original workspace owners transferred by failed root Scope release. */
export const recoverWorkspacePresenceShutdown = (
  cause: Cause.Cause<unknown>
): Effect.Effect<void, unknown> => {
  const failures = cause.reasons.flatMap((reason) => {
    const error = Cause.isDieReason(reason)
      ? reason.defect
      : Cause.isFailReason(reason)
        ? reason.error
        : undefined;
    return error instanceof PresenceReleaseFailed ? [error] : [];
  });
  if (failures.length !== cause.reasons.length) return Effect.failCause(cause);
  return Effect.forEach(
    [...new Set(failures.map((error) => error.owner))],
    (owner) => owner.retryCleanup,
    { discard: true }
  );
};
