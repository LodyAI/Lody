import { Effect, Layer } from 'effect';
import { SqliteUserIdentityStore, type LocalUserProtection } from '../node-user-store';
import { UserIdentityStore } from '../ports/identity';
import { CryptoError, RecoveryError, StorageError } from '../pure/errors';
import { ControlLogError } from '../pure/legacy-error';

function identityFailure(error: unknown): Effect.Effect<never, StorageError | CryptoError> {
  const code =
    error instanceof ControlLogError
      ? error.code
      : error instanceof Error
        ? error.message
        : undefined;
  if (code === 'user-identity-missing')
    return Effect.fail(new StorageError({ reason: 'missing', code }));
  if (code === 'user-identity-exists')
    return Effect.fail(new StorageError({ reason: 'exists', code }));
  if (code === 'user-store-binding-mismatch')
    return Effect.fail(new StorageError({ reason: 'foreign', code }));
  if (code === 'journal-busy') return Effect.fail(new StorageError({ reason: 'busy', code }));
  if (code === 'invalid-user-store' || code === 'invalid-wrapped-user')
    return Effect.fail(new StorageError({ reason: 'corrupt', code }));
  if (error instanceof TypeError || error instanceof ReferenceError) return Effect.die(error);
  if (error instanceof DOMException) return Effect.fail(new CryptoError({ operation: 'import' }));
  return Effect.die(error);
}

function recoveryFailure(
  error: unknown
): Effect.Effect<never, StorageError | CryptoError | RecoveryError> {
  const code =
    error instanceof ControlLogError
      ? error.code
      : error instanceof Error
        ? error.message
        : undefined;
  if (
    code === 'user-identity-mismatch' ||
    code === 'invalid-recovery-file' ||
    code === 'invalid-recovery-revision' ||
    code === 'invalid-recovery-material' ||
    code === 'invalid-recovery-backup' ||
    code === 'noncanonical-recovery-file' ||
    code === 'recovery-context-mismatch' ||
    code === 'recovery-authentication-failed' ||
    code === 'invalid-hex' ||
    code === 'invalid-length'
  )
    return Effect.fail(new RecoveryError({ code: code ?? 'invalid-recovery-file' }));
  return identityFailure(error);
}

export function nodeUserIdentityLayer(input: {
  readonly path: string;
  readonly binding: string;
  readonly protection: LocalUserProtection;
}): Layer.Layer<UserIdentityStore> {
  const store = new SqliteUserIdentityStore(input.path, input.binding, input.protection);
  return Layer.succeed(UserIdentityStore, {
    create: Effect.tryPromise({ try: () => store.create(), catch: (error) => error }).pipe(
      Effect.catchAll(identityFailure)
    ),
    load: Effect.tryPromise({ try: () => store.load(), catch: (error) => error }).pipe(
      Effect.catchAll(identityFailure)
    ),
    sealBackup: (file, context) => {
      const owned = new Uint8Array(file);
      const expected = { ...context };
      return Effect.tryPromise({
        try: () => store.sealBackup(owned, expected),
        catch: (error) => error,
      }).pipe(Effect.catchAll(recoveryFailure));
    },
    recover: (file, context, frame) => {
      const ownedFile = new Uint8Array(file);
      const ownedFrame = new Uint8Array(frame);
      const expected = { ...context };
      return Effect.tryPromise({
        try: () => store.recover(ownedFile, expected, ownedFrame),
        catch: (error) => error,
      }).pipe(Effect.catchAll(recoveryFailure));
    },
  });
}
