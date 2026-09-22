import { Context, type Effect } from 'effect';
import type { EncryptionPublicKey, EpochKey } from '../pure/bytes';
import type { CryptoError, ValidationError } from '../pure/errors';

export class HpkeSender extends Context.Tag('@lody/e2ee-core/HpkeSender')<
  HpkeSender,
  {
    readonly seal: (input: {
      readonly recipient: EncryptionPublicKey;
      readonly key: EpochKey;
      readonly aad: Uint8Array;
    }) => Effect.Effect<
      { readonly enc: Uint8Array; readonly ct: Uint8Array },
      CryptoError | ValidationError
    >;
  }
>() {}

/** The private key handle stays inside the platform implementation. */
export class HpkeRecipient extends Context.Tag('@lody/e2ee-core/HpkeRecipient')<
  HpkeRecipient,
  {
    readonly publicKey: EncryptionPublicKey;
    readonly open: (input: {
      readonly enc: Uint8Array;
      readonly ct: Uint8Array;
      readonly aad: Uint8Array;
    }) => Effect.Effect<EpochKey, CryptoError | ValidationError>;
  }
>() {}
