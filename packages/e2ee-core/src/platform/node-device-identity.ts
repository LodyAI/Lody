import { Effect, Layer } from 'effect';
import { SqliteDeviceIdentityStore, type LocalDeviceProtection } from '../node-device-store';
import { DeviceIdentityStore } from '../ports/identity';
import { CryptoError, StorageError } from '../pure/errors';
import { ControlLogError } from '../pure/legacy-error';

function identityFailure(error: unknown): Effect.Effect<never, StorageError | CryptoError> {
  const code =
    error instanceof ControlLogError
      ? error.code
      : error instanceof Error
        ? error.message
        : undefined;
  if (code === 'device-identity-missing')
    return Effect.fail(new StorageError({ reason: 'missing', code }));
  if (code === 'device-identity-exists')
    return Effect.fail(new StorageError({ reason: 'exists', code }));
  if (code === 'device-binding-mismatch')
    return Effect.fail(new StorageError({ reason: 'foreign', code }));
  if (code === 'journal-busy') return Effect.fail(new StorageError({ reason: 'busy', code }));
  if (
    code === 'invalid-device-store' ||
    code === 'invalid-device-bundle' ||
    code === 'invalid-wrapped-device' ||
    code === 'device-protection-roundtrip-mismatch' ||
    code === 'device-key-pair-mismatch'
  )
    return Effect.fail(new StorageError({ reason: 'corrupt', code }));
  if (error instanceof TypeError || error instanceof ReferenceError) return Effect.die(error);
  if (error instanceof DOMException) return Effect.fail(new CryptoError({ operation: 'import' }));
  return Effect.die(error);
}

/** Node-only. Open/create semantics stay with SqliteDeviceIdentityStore. */
export function nodeDeviceIdentityLayer(input: {
  readonly path: string;
  readonly binding: string;
  readonly protection: LocalDeviceProtection;
}): Layer.Layer<DeviceIdentityStore> {
  const store = new SqliteDeviceIdentityStore(input.path, input.binding, input.protection);
  return Layer.succeed(DeviceIdentityStore, {
    create: Effect.tryPromise({ try: () => store.create(), catch: (error) => error }).pipe(
      Effect.catchAll(identityFailure)
    ),
    load: Effect.tryPromise({ try: () => store.load(), catch: (error) => error }).pipe(
      Effect.catchAll(identityFailure)
    ),
  });
}
