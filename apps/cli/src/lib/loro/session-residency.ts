import { Cause, Clock, Data, Effect, Exit, Scope, Semaphore } from 'effect';

/**
 * Per-Session residency: who may tear down a Session's resident state, and when.
 *
 * Every user of a Session's resident value (its SessionDocument) holds a lease.
 * Retirement (idle GC, memory-pressure eviction, archive, one-shot cleanup) is
 * decided and performed under a per-Session gate, and only while no lease is
 * held, so it can never destroy a value a turn, watcher or reader still uses.
 * An acquire that arrives during retirement waits for it and then opens a fresh
 * generation; it never runs alongside the teardown. A retirement that fails to
 * close keeps the value `retained`, and the next acquire reinitializes it.
 *
 * Releasing a lease is NOT a teardown. The last release only starts the idle
 * clock: the document and the Session's agent process stay resident for reuse
 * until the GC sweep retires a Session idle for `LODY_SESSION_GC_IDLE_TIMEOUT_MS`
 * (20 minutes by default), or memory pressure evicts an idle one.
 *
 * The gate is held for the whole of `open`, `close` and a retirement's
 * `teardown`, so those callbacks must be bounded by their owners, and must not
 * acquire the same Session (that would wait on the gate they hold).
 */
export type SessionResidencyOptions<K, A, O = undefined, C = undefined> = {
  /**
   * Open the value, or reinitialize one retained after a failed close. Receives
   * the options of the acquire that triggered the open.
   */
  readonly open: (
    key: K,
    retained: A | undefined,
    options: O | undefined
  ) => Effect.Effect<A, unknown>;
  readonly close: (key: K, value: A, options: C | undefined) => Effect.Effect<void, unknown>;
  /** Failure of a retirement deferred to the last lease release. */
  readonly reportDeferredRetireFailure?: (key: K, cause: Cause.Cause<unknown>) => void;
};

export type SessionRetireOptions<C = undefined, A = unknown> = {
  /** Keep a Session whose last lease was released less than this long ago. */
  readonly minIdleMs?: number;
  /** Evaluated under the gate; `true` keeps the Session resident. */
  readonly veto?: Effect.Effect<boolean, unknown>;
  /**
   * Session-level teardown run under the gate before the value closes, for
   * example terminating the idle agent process. It receives the resident value
   * (undefined when none is open) so it can finish writes without acquiring the
   * Session it holds the gate of. A failure aborts the retirement and leaves
   * the Session resident for a later attempt.
   */
  readonly teardown?: (value: A | undefined) => Effect.Effect<void, unknown>;
  /** While leases are held, retire after the last release instead of refusing. */
  readonly deferWhileInUse?: boolean;
  /** Passed to `close`. */
  readonly close?: C;
};

export type SessionRetireOutcome =
  /** Torn down; the next acquire opens a fresh generation. */
  | 'retired'
  /** A lease is held; nothing was touched. */
  | 'in-use'
  /** The last lease was released less than `minIdleMs` ago. */
  | 'recently-used'
  | 'vetoed'
  /** A lease is held; retirement runs when the last one is released. */
  | 'deferred';

/** The residency has shut down; no Session can be acquired any more. */
export class SessionResidencyClosed extends Data.TaggedError('SessionResidencyClosed')<{
  readonly key: unknown;
}> {
  override get message(): string {
    return `Session residency is closed (key=${String(this.key)})`;
  }
}

/**
 * `use` (default) counts as activity: the last release restarts the idle clock.
 * `observe` is for reads that must not keep a Session resident, such as GC's own
 * eligibility checks: the lease still protects the value while held, but its
 * release leaves the idle clock where it was before the lease.
 */
export type SessionLeaseMode = 'use' | 'observe';

export interface SessionResidency<K, A, O = undefined, C = undefined> {
  /** Lease the resident value for the current Scope, opening it if needed. */
  readonly acquire: (
    key: K,
    options?: O,
    mode?: SessionLeaseMode
  ) => Effect.Effect<A, unknown, Scope.Scope>;
  readonly retire: (
    key: K,
    options?: SessionRetireOptions<C, A>
  ) => Effect.Effect<SessionRetireOutcome, unknown>;
  /**
   * Final teardown at daemon shutdown, after turns have stopped: refuse new
   * acquires and close every value, leased or not. Resolves after every close
   * ran and fails with the combined failures, if any.
   */
  readonly shutdown: (options?: C) => Effect.Effect<void, unknown>;
  /** Opened, retained after a failed close, or under its gate right now. */
  readonly isResident: (key: K) => boolean;
  readonly holders: (key: K) => number;
  /** When the last lease was released; undefined while leased or never opened. */
  readonly idleSinceMs: (key: K) => number | undefined;
  /** Value of a resident key without leasing it, for synchronous observation. */
  readonly peek: (key: K) => A | undefined;
  readonly keys: () => K[];
}

type Entry<A, C> = {
  readonly gate: Semaphore.Semaphore;
  status: 'empty' | 'ready' | 'retained';
  value: A | undefined;
  refCount: number;
  idleSinceMs: number | undefined;
  /** Idle clock when the current run of leases began, restored if none was a use. */
  idleBeforeLeases: number | undefined;
  usedWhileLeased: boolean;
  /** Gate held by an open or a retirement; leases must wait for it. */
  busy: boolean;
  deferredRetire: SessionRetireOptions<C, A> | undefined;
};

export const makeSessionResidency = <K, A, O = undefined, C = undefined>(
  options: SessionResidencyOptions<K, A, O, C>
): SessionResidency<K, A, O, C> => {
  const entries = new Map<K, Entry<A, C>>();
  let closed = false;

  const entryFor = (key: K): Entry<A, C> => {
    const existing = entries.get(key);
    if (existing) return existing;
    const created: Entry<A, C> = {
      gate: Semaphore.makeUnsafe(1),
      status: 'empty',
      value: undefined,
      refCount: 0,
      idleSinceMs: undefined,
      idleBeforeLeases: undefined,
      usedWhileLeased: false,
      busy: false,
      deferredRetire: undefined,
    };
    entries.set(key, created);
    return created;
  };

  const dropIfUnused = (key: K, entry: Entry<A, C>): void => {
    if (
      entries.get(key) === entry &&
      entry.status === 'empty' &&
      entry.refCount === 0 &&
      !entry.busy &&
      !entry.deferredRetire
    ) {
      entries.delete(key);
    }
  };

  const releaseLease = Effect.fnUntraced(function* (key: K, entry: Entry<A, C>) {
    entry.refCount -= 1;
    if (entry.refCount > 0) return;
    // Only the idle clock moves here; nothing is torn down. Observation-only
    // leases leave it where it was, so GC's own checks never postpone GC.
    entry.idleSinceMs = entry.usedWhileLeased
      ? yield* Clock.currentTimeMillis
      : entry.idleBeforeLeases;
    const deferred = entry.deferredRetire;
    if (!deferred || entries.get(key) !== entry) return;
    entry.deferredRetire = undefined;
    yield* retire(key, { ...deferred, deferWhileInUse: true }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => options.reportDeferredRetireFailure?.(key, cause))
      )
    );
  });

  const lease = (
    key: K,
    entry: Entry<A, C>,
    mode: SessionLeaseMode
  ): Effect.Effect<void, never, Scope.Scope> => {
    if (entry.refCount === 0) {
      entry.idleBeforeLeases = entry.idleSinceMs;
      entry.usedWhileLeased = false;
    }
    if (mode === 'use') entry.usedWhileLeased = true;
    entry.refCount += 1;
    entry.idleSinceMs = undefined;
    return Effect.addFinalizer(() => releaseLease(key, entry));
  };

  // Uninterruptible as a whole, waiting included: an interrupt between taking
  // the reference and registering its finalizer would leak the lease and pin
  // the Session forever. Every gate holder is bounded, so the wait is too.
  const acquire = (
    key: K,
    openOptions?: O,
    mode: SessionLeaseMode = 'use'
  ): Effect.Effect<A, unknown, Scope.Scope> =>
    Effect.suspend(() => {
      if (closed) return Effect.fail(new SessionResidencyClosed({ key }));
      const entry = entryFor(key);
      if (entry.status === 'ready' && !entry.busy && entry.value !== undefined) {
        const value = entry.value;
        return Effect.as(lease(key, entry, mode), value);
      }
      return entry.gate
        .withPermit(
          Effect.gen(function* () {
            if (closed) return yield* new SessionResidencyClosed({ key });
            if (entries.get(key) !== entry) return undefined;
            if (entry.status !== 'ready' || entry.value === undefined) {
              entry.busy = true;
              const opened = yield* options
                .open(key, entry.status === 'retained' ? entry.value : undefined, openOptions)
                .pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      entry.busy = false;
                    })
                  ),
                  Effect.tapCause(() => Effect.sync(() => dropIfUnused(key, entry)))
                );
              entry.status = 'ready';
              entry.value = opened;
            }
            // Take the reference before the gate opens, so no retirement can
            // slip in between this open and the caller's lease.
            yield* lease(key, entry, mode);
            return { value: entry.value };
          })
        )
        .pipe(
          Effect.flatMap((leased) =>
            leased ? Effect.succeed(leased.value) : acquire(key, openOptions, mode)
          )
        );
    }).pipe(Effect.uninterruptible);

  const retireUnderGate = Effect.fnUntraced(function* (
    key: K,
    entry: Entry<A, C>,
    retireOptions: SessionRetireOptions<C, A>
  ): Effect.fn.Return<SessionRetireOutcome | 'stale', unknown> {
    if (entries.get(key) !== entry) return 'stale' as const;
    if (entry.refCount > 0) {
      if (!retireOptions.deferWhileInUse) return 'in-use' as const;
      entry.deferredRetire = retireOptions;
      return 'deferred' as const;
    }
    const now = yield* Clock.currentTimeMillis;
    if (
      retireOptions.minIdleMs !== undefined &&
      entry.idleSinceMs !== undefined &&
      now - entry.idleSinceMs < retireOptions.minIdleMs
    ) {
      return 'recently-used' as const;
    }
    if (retireOptions.veto && (yield* retireOptions.veto)) return 'vetoed' as const;
    if (retireOptions.teardown) yield* retireOptions.teardown(entry.value);
    if (entry.status !== 'empty' && entry.value !== undefined) {
      const closeExit = yield* Effect.exit(options.close(key, entry.value, retireOptions.close));
      if (Exit.isFailure(closeExit)) {
        // The next acquire reinitializes this value instead of opening a second one.
        entry.status = 'retained';
        entry.idleSinceMs = now;
        return yield* Effect.failCause(closeExit.cause);
      }
    }
    entry.status = 'empty';
    entry.value = undefined;
    if (entries.get(key) === entry) entries.delete(key);
    return 'retired' as const;
  });

  const retire = (
    key: K,
    retireOptions: SessionRetireOptions<C, A> = {}
  ): Effect.Effect<SessionRetireOutcome, unknown> =>
    Effect.suspend(() => {
      const entry = entryFor(key);
      return entry.gate
        .withPermit(
          Effect.suspend(() => {
            entry.busy = true;
            return retireUnderGate(key, entry, retireOptions).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  entry.busy = false;
                  dropIfUnused(key, entry);
                })
              )
            );
          })
        )
        .pipe(
          Effect.uninterruptible,
          Effect.flatMap((outcome) =>
            outcome === 'stale' ? retire(key, retireOptions) : Effect.succeed(outcome)
          )
        );
    });

  const shutdown = (closeOptions?: C): Effect.Effect<void, unknown> =>
    Effect.suspend(() => {
      closed = true;
      return Effect.forEach(
        [...entries.entries()],
        ([key, entry]) =>
          entry.gate.withPermit(
            Effect.suspend(() => {
              entries.delete(key);
              entry.deferredRetire = undefined;
              const value = entry.value;
              entry.status = 'empty';
              entry.value = undefined;
              const closing: Effect.Effect<Cause.Cause<unknown> | undefined> =
                value === undefined
                  ? Effect.succeed(undefined)
                  : Effect.exit(options.close(key, value, closeOptions)).pipe(
                      Effect.map((exit) => (Exit.isFailure(exit) ? exit.cause : undefined))
                    );
              return closing;
            })
          ),
        { discard: false }
      ).pipe(
        Effect.flatMap((causes) => {
          const failures = causes.filter((cause): cause is Cause.Cause<unknown> => !!cause);
          return failures.length === 0
            ? Effect.void
            : Effect.failCause(failures.reduce((left, right) => Cause.combine(left, right)));
        }),
        Effect.uninterruptible
      );
    });

  return {
    acquire,
    retire,
    shutdown,
    isResident: (key) => {
      const entry = entries.get(key);
      return !!entry && (entry.status !== 'empty' || entry.busy);
    },
    holders: (key) => entries.get(key)?.refCount ?? 0,
    idleSinceMs: (key) => entries.get(key)?.idleSinceMs,
    peek: (key) => {
      const entry = entries.get(key);
      return entry?.status === 'ready' ? entry.value : undefined;
    },
    keys: () => [...entries.keys()],
  };
};
