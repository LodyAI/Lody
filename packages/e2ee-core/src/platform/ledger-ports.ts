import { Effect, Layer } from 'effect';
import { DeviceSigner, LedgerTransport } from '../ports/ledger';
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
import type { LedgerStream } from '../pure/journal';

export function storageError(error: unknown): StorageError {
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  const sqliteCode = error instanceof Error && 'errcode' in error ? error.errcode : undefined;
  if (sqliteCode === 5) return new StorageError({ reason: 'busy', code });
  if (sqliteCode === 11 || sqliteCode === 26) return new StorageError({ reason: 'corrupt', code });
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

/** Synchronous foreign boundary. Expected storage failures stay typed; defects stay defects. */
export function storageSync<A>(work: () => A): Effect.Effect<A, StorageError | ValidationError> {
  return Effect.try({ try: work, catch: (error) => error }).pipe(
    Effect.catchAll((error) =>
      error instanceof TypeError || error instanceof ReferenceError
        ? Effect.die(error)
        : Effect.fail(storageError(error))
    )
  );
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
    sign: (message) => {
      const ownedMessage = new Uint8Array(message);
      return Effect.tryPromise({
        try: () => sign(new Uint8Array(ownedMessage)),
        catch: (error) => error,
      }).pipe(
        Effect.catchAll((error) =>
          error instanceof TypeError || error instanceof ReferenceError
            ? Effect.die(error)
            : Effect.fail(new CryptoError({ operation: 'sign' }))
        ),
        Effect.flatMap(signature)
      );
    },
  });
}
