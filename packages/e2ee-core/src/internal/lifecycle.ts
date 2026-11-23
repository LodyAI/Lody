import { Deferred, Effect } from 'effect';

/**
 * Admission gate for a scoped owner.
 *
 * `run(work)` admits work only while the owner is open and tracks it until it
 * settles. When the enclosing Scope closes, the finalizer first refuses new work,
 * then waits for every admitted operation, so storage and native resources are
 * released only after the work that borrows them has finished.
 */
export const makeAdmissionGate = <E>(closedError: () => E) =>
  Effect.gen(function* () {
    let closed = false;
    const active = new Set<Deferred.Deferred<void>>();
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closed = true;
        for (const done of active) yield* Deferred.await(done);
      })
    );
    const run = <A, E2, R>(work: Effect.Effect<A, E2, R>): Effect.Effect<A, E | E2, R> =>
      Effect.acquireUseRelease(
        Effect.suspend(() => {
          if (closed) return Effect.fail(closedError());
          return Deferred.make<void>().pipe(
            Effect.tap((done) => Effect.sync(() => active.add(done)))
          );
        }),
        () => work,
        (done) =>
          Effect.sync(() => {
            active.delete(done);
            Deferred.doneUnsafe(done, Effect.void);
          })
      );
    return {
      run,
      /** True once the owner started closing; long work re-checks between steps. */
      isClosed: () => closed,
      /** Fail with the closed error if the owner started closing. */
      guard: Effect.suspend(() => (closed ? Effect.fail(closedError()) : Effect.void)),
    };
  });

/**
 * Close flag for a scoped owner that borrows no native resource of its own.
 *
 * When the enclosing Scope closes, new work is refused and work already in
 * flight fails at its next `guard` instead of being awaited, so closing never
 * waits on a remote call. Use {@link makeAdmissionGate} instead when admitted
 * work borrows native or platform resources that must settle before release.
 */
export const makeCloseGuard = <E>(closedError: () => E) =>
  Effect.gen(function* () {
    let closed = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
      })
    );
    const guard = Effect.suspend(() => (closed ? Effect.fail(closedError()) : Effect.void));
    return {
      /** Admit `work` only while open; it is not awaited on close. */
      run: <A, E2, R>(work: Effect.Effect<A, E2, R>): Effect.Effect<A, E | E2, R> =>
        Effect.flatMap(guard, () => work),
      isClosed: () => closed,
      guard,
    };
  });

/**
 * Capture a borrowed service once: bind every method to its original receiver
 * and freeze the result, so later mutation of the provided object cannot swap a
 * capability out from under an in-flight workflow.
 */
export const own = <S extends object>(service: S): S => {
  const captured: Record<string, unknown> = {};
  for (const key of Object.keys(service)) {
    const value = (service as Record<string, unknown>)[key];
    captured[key] = typeof value === 'function' ? value.bind(service) : value;
  }
  return Object.freeze(captured) as S;
};

/** {@link own} for a device identity: captures the signer and copies the key pair. */
export const ownIdentity = <
  I extends { readonly signer: object; readonly encryptionKeyPair: CryptoKeyPair },
>(
  identity: I
): I =>
  Object.freeze({
    ...identity,
    signer: own(identity.signer),
    encryptionKeyPair: Object.freeze({
      publicKey: identity.encryptionKeyPair.publicKey,
      privateKey: identity.encryptionKeyPair.privateKey,
    }),
  });
