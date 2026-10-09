/** Node Promise boundary for applications using another Effect major. No Effect
 * values escape this module; all identity operations use the native Services. */
import { Effect } from 'effect';
import { DeviceIdentityStore, UserIdentityStore } from './ports/identity';
import { StorageError } from './pure/errors';
import { nodeDeviceIdentityLayer } from './platform/node-device-identity';
import { nodeUserIdentityLayer } from './platform/node-user-identity';
import { runPromiseThrow } from './effect-run';
import type { RecoveryBackupContext } from './pure/recovery-file';

export function nodeDeviceIdentityClient(input: Parameters<typeof nodeDeviceIdentityLayer>[0]) {
  const layer = nodeDeviceIdentityLayer(input);
  const run = <A, E>(work: Effect.Effect<A, E, DeviceIdentityStore>, signal?: AbortSignal) =>
    runPromiseThrow(work.pipe(Effect.provide(layer)), signal);
  return {
    create: (signal?: AbortSignal) =>
      run(
        Effect.flatMap(DeviceIdentityStore, (s) => s.create),
        signal
      ),
    load: (signal?: AbortSignal) =>
      run(
        Effect.flatMap(DeviceIdentityStore, (s) => s.load),
        signal
      ),
    initialize: (assertCurrent: () => void, signal?: AbortSignal) =>
      run(
        Effect.gen(function* () {
          const store = yield* DeviceIdentityStore;
          return yield* store.load.pipe(
            Effect.catchIf(
              (error): error is StorageError =>
                error instanceof StorageError && error.reason === 'missing',
              () => {
                assertCurrent();
                return store.create.pipe(
                  Effect.catchIf(
                    (error): error is StorageError =>
                      error instanceof StorageError && error.reason === 'exists',
                    () => store.load
                  )
                );
              }
            )
          );
        }),
        signal
      ),
  };
}

export function nodeUserIdentityClient(input: Parameters<typeof nodeUserIdentityLayer>[0]) {
  const layer = nodeUserIdentityLayer(input);
  const run = <A, E>(work: Effect.Effect<A, E, UserIdentityStore>, signal?: AbortSignal) =>
    runPromiseThrow(work.pipe(Effect.provide(layer)), signal);
  return {
    create: (signal?: AbortSignal) =>
      run(
        Effect.flatMap(UserIdentityStore, (s) => s.create),
        signal
      ),
    load: (signal?: AbortSignal) =>
      run(
        Effect.flatMap(UserIdentityStore, (s) => s.load),
        signal
      ),
    sealBackup: (file: Uint8Array, context: RecoveryBackupContext, signal?: AbortSignal) =>
      run(
        Effect.flatMap(UserIdentityStore, (s) => s.sealBackup(file, context)),
        signal
      ),
    recover: (
      file: Uint8Array,
      context: RecoveryBackupContext,
      frame: Uint8Array,
      signal?: AbortSignal
    ) =>
      run(
        Effect.flatMap(UserIdentityStore, (s) => s.recover(file, context, frame)),
        signal
      ),
  };
}
