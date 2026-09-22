import { Cause, Effect, Exit, Layer } from 'effect';
import type { LedgerKeyOutbox, LedgerKeyRemote } from '../ledger/delivery';
import { LedgerError } from '../ledger/error';
import { KeyOutbox, KeyDeliveryRemote } from '../ports/key-delivery';
import { StorageError, TransportError, ValidationError } from '../pure/errors';
import { storageCall, storageError } from './ledger-ports';

/** Temporary Promise-store lease. No nested Effect runtime or async SQLite transaction. */
export function keyOutboxLayer(store: LedgerKeyOutbox): Layer.Layer<KeyOutbox> {
  type Transaction = Parameters<Parameters<LedgerKeyOutbox['exclusive']>[0]>[0];
  interface Held {
    readonly tx: Transaction;
    readonly release: () => void;
    readonly done: Promise<Exit.Exit<void, StorageError>>;
  }
  const acquire = Effect.async<Held, StorageError>((resume) => {
    let cancelled = false;
    let unlock: (() => void) | undefined;
    let complete: (exit: Exit.Exit<void, StorageError>) => void = () => {};
    const done = new Promise<Exit.Exit<void, StorageError>>((resolve) => {
      complete = resolve;
    });
    const running = store.exclusive(async (tx) => {
      if (cancelled) return;
      const wait = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      resume(Effect.succeed({ tx, release: () => unlock?.(), done }));
      await wait;
    });
    void running.then(
      () => complete(Exit.succeed(undefined)),
      (error: unknown) => {
        const failure = storageError(error);
        const defect = error instanceof TypeError || error instanceof ReferenceError;
        complete(defect ? Exit.die(error) : Exit.fail(failure));
        resume(defect ? Effect.die(error) : Effect.fail(failure));
      }
    );
    return Effect.sync(() => {
      cancelled = true;
      unlock?.();
    });
  });
  return Layer.succeed(KeyOutbox, {
    exclusive: (work) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const held = yield* restore(acquire);
          const result = yield* Effect.exit(
            restore(
              Effect.suspend(() =>
                work({
                  // A foreign Promise cannot be cancelled. Keep its lease until
                  // storage settles; interruption must not close an in-flight save.
                  load: (id) => Effect.uninterruptible(storageCall(() => held.tx.load(id))),
                  save: (id, bytes) => {
                    const owned = new Uint8Array(bytes);
                    return Effect.uninterruptible(
                      storageCall(() => held.tx.save(id, new Uint8Array(owned)))
                    );
                  },
                })
              )
            )
          );
          held.release();
          const closed = yield* Effect.promise(() => held.done);
          if (Exit.isFailure(result))
            return yield* Effect.failCause(
              Exit.isFailure(closed) ? Cause.sequential(result.cause, closed.cause) : result.cause
            );
          if (Exit.isFailure(closed)) return yield* Effect.failCause(closed.cause);
          return result.value;
        })
      ),
  });
}

export function keyDeliveryRemoteLayer(remote: LedgerKeyRemote): Layer.Layer<KeyDeliveryRemote> {
  const call = <A>(operation: 'read' | 'deliver', work: () => Promise<A>) =>
    Effect.tryPromise({ try: work, catch: (error) => error }).pipe(
      Effect.catchAll((error): Effect.Effect<never, TransportError | ValidationError> => {
        if (error instanceof LedgerError)
          return Effect.fail(new ValidationError({ code: error.code, position: error.position }));
        if (error instanceof TypeError || error instanceof ReferenceError) return Effect.die(error);
        return Effect.fail(new TransportError({ operation }));
      })
    );
  return Layer.succeed(KeyDeliveryRemote, {
    put: (id, bytes) => {
      const owned = new Uint8Array(bytes);
      return call('deliver', () => remote.put(id, new Uint8Array(owned)));
    },
    read: (id) =>
      call('read', () => remote.read(id)).pipe(
        Effect.map((bytes) => (bytes === null ? null : new Uint8Array(bytes)))
      ),
  });
}
