import { Cause, Effect, Exit, Layer } from 'effect';
import {
  DeviceSigner,
  JournalStore,
  LedgerTransport,
  type JournalTransaction,
} from '../ports/ledger';
import {
  CryptoError,
  StorageError,
  TransportError,
  StreamProtocolError,
  ValidationError,
} from '../pure/errors';
import { ControlLogError } from '../pure/legacy-error';
import { signature, type SigningPublicKey } from '../pure/bytes';
import { LedgerError } from '../ledger/error';
import type { LedgerStore, LedgerStream, LedgerTransaction } from '../pure/journal';

function storageError(error: unknown): StorageError | ValidationError {
  if (error instanceof LedgerError)
    return new StorageError({
      reason:
        error.code === 'unknown-version' || error.code === 'wrong-anchor' ? 'foreign' : 'corrupt',
      code: error.code,
      position: error.position,
    });
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  if (code === 'ENOENT') return new StorageError({ reason: 'missing' });
  if (code === 'EEXIST') return new StorageError({ reason: 'exists' });
  if (code === 'journal-busy') return new StorageError({ reason: 'busy', code });
  if (code === 'journal-transaction-ended') return new StorageError({ reason: 'closed', code });
  if (code.includes('foreign') || code.includes('unsupported-journal'))
    return new StorageError({ reason: 'foreign' });
  if (code.includes('corrupt') || code.includes('canonical') || code === 'journal-too-large')
    return new StorageError({ reason: 'corrupt', code });
  return new StorageError({ reason: 'io' });
}

function storageCall<A>(work: () => Promise<A>): Effect.Effect<A, StorageError | ValidationError> {
  return Effect.tryPromise({ try: work, catch: (error) => error }).pipe(
    Effect.catchAll((error) =>
      error instanceof TypeError || error instanceof ReferenceError
        ? Effect.die(error)
        : Effect.fail(storageError(error))
    )
  );
}

/** Migration adapter: owns the Promise callback lock without starting an Effect runtime. */
export function journalStoreLayer(store: LedgerStore): Layer.Layer<JournalStore> {
  interface Held {
    tx: LedgerTransaction;
    release: () => void;
    done: Promise<Exit.Exit<void, StorageError | ValidationError>>;
  }
  const acquire = Effect.async<Held, StorageError | ValidationError>((resume) => {
    let cancelled = false;
    let unlocked: (() => void) | undefined;
    let complete: (value: Exit.Exit<void, StorageError | ValidationError>) => void = () => {};
    const done = new Promise<Exit.Exit<void, StorageError | ValidationError>>((resolve) => {
      complete = resolve;
    });
    // The callback only leases a transaction. The Effect workflow executes outside
    // it; releasing this promise lets the adapter close its database/queue lock.
    const running = store.exclusive(async (tx) => {
      if (cancelled) return;
      const wait = new Promise<void>((resolve) => {
        unlocked = resolve;
      });
      resume(Effect.succeed({ tx, release: () => unlocked?.(), done }));
      await wait;
    });
    void running.then(
      () => complete(Exit.succeed(undefined)),
      (error: unknown) => {
        const failure = storageError(error);
        complete(
          error instanceof TypeError || error instanceof ReferenceError
            ? Exit.die(error)
            : Exit.fail(failure)
        );
        resume(
          error instanceof TypeError || error instanceof ReferenceError
            ? Effect.die(error)
            : Effect.fail(failure)
        );
      }
    );
    return Effect.sync(() => {
      cancelled = true;
      unlocked?.();
    });
  });

  return Layer.succeed(JournalStore, {
    exclusive: (work) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const held = yield* restore(acquire);
          const outcome = yield* Effect.exit(
            restore(
              Effect.suspend(() => {
                const transaction: JournalTransaction = {
                  load: storageCall(() => held.tx.load()),
                  save: (journal) => storageCall(() => held.tx.save(journal)),
                };
                return work(transaction);
              })
            )
          );
          held.release();
          const released = yield* Effect.promise(() => held.done);
          if (Exit.isFailure(outcome)) {
            return yield* Effect.failCause(
              Exit.isFailure(released)
                ? Cause.sequential(outcome.cause, released.cause)
                : outcome.cause
            );
          }
          if (Exit.isFailure(released)) return yield* Effect.failCause(released.cause);
          return outcome.value;
        })
      ),
  });
}

export function ledgerTransportLayer(stream: LedgerStream): Layer.Layer<LedgerTransport> {
  return Layer.succeed(LedgerTransport, {
    initialOffset: stream.initialOffset,
    readAfter: (offset) =>
      Effect.tryPromise({
        try: () => stream.readAfter(offset),
        catch: (error) => error,
      }).pipe(Effect.catchAll((error) => transportFailure('read', error))),
    appendCas: (offset, bytes) =>
      Effect.tryPromise({
        try: () => stream.appendCas(offset, bytes),
        catch: (error) => error,
      }).pipe(Effect.catchAll((error) => transportFailure('append', error))),
  });
}

function transportFailure(
  operation: 'read' | 'append',
  error: unknown
): Effect.Effect<never, TransportError | StreamProtocolError | ValidationError> {
  if (error instanceof LedgerError)
    return Effect.fail(new ValidationError({ code: error.code, position: error.position }));
  if (error instanceof TypeError || error instanceof ReferenceError) return Effect.die(error);
  if (error instanceof ControlLogError) {
    return error.code.startsWith(`stream-${operation}-`)
      ? Effect.fail(new TransportError({ operation, code: error.code }))
      : Effect.fail(new StreamProtocolError({ code: error.code }));
  }
  return Effect.fail(new TransportError({ operation }));
}

export function deviceSignerLayer(
  publicKey: SigningPublicKey,
  sign: (message: Uint8Array) => Promise<Uint8Array>
): Layer.Layer<DeviceSigner> {
  return Layer.succeed(DeviceSigner, {
    publicKey,
    sign: (message) =>
      Effect.tryPromise({
        try: () => sign(new Uint8Array(message)),
        catch: (error) => error,
      }).pipe(
        Effect.catchAll((error) =>
          error instanceof TypeError || error instanceof ReferenceError
            ? Effect.die(error)
            : Effect.fail(new CryptoError({ operation: 'sign' }))
        ),
        Effect.flatMap(signature)
      ),
  });
}
