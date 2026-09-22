import { Context, type Effect } from 'effect';
import type { CryptoError, RecoveryError, StorageError } from '../pure/errors';
import type { RecoveryBackupContext } from '../pure/recovery-file';

export interface DeviceIdentityHandles {
  readonly id: string;
  readonly signing: CryptoKeyPair;
  readonly encryption: CryptoKeyPair;
}

export interface UserIdentityHandles {
  readonly fingerprint: string;
  readonly signing: CryptoKeyPair;
  readonly encryption: CryptoKeyPair;
}

/** Explicit create vs load. Load must never generate a replacement identity. */
export class UserIdentityStore extends Context.Tag('@lody/e2ee-core/UserIdentityStore')<
  UserIdentityStore,
  {
    readonly create: Effect.Effect<UserIdentityHandles, StorageError | CryptoError>;
    readonly load: Effect.Effect<UserIdentityHandles, StorageError | CryptoError>;
    readonly sealBackup: (
      file: Uint8Array,
      context: RecoveryBackupContext
    ) => Effect.Effect<Uint8Array, StorageError | CryptoError | RecoveryError>;
    readonly recover: (
      file: Uint8Array,
      context: RecoveryBackupContext,
      frame: Uint8Array
    ) => Effect.Effect<UserIdentityHandles, StorageError | CryptoError | RecoveryError>;
  }
>() {}

/** Explicit create vs load. Load must never generate a replacement identity. */
export class DeviceIdentityStore extends Context.Tag('@lody/e2ee-core/DeviceIdentityStore')<
  DeviceIdentityStore,
  {
    readonly create: Effect.Effect<DeviceIdentityHandles, StorageError | CryptoError>;
    readonly load: Effect.Effect<DeviceIdentityHandles, StorageError | CryptoError>;
  }
>() {}
