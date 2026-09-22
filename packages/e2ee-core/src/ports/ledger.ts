import { Context, Effect } from 'effect';
import type { SigningPublicKey, Signature } from '../pure/bytes';
import type {
  CryptoError,
  StorageError,
  TransportError,
  StreamProtocolError,
  ValidationError,
} from '../pure/errors';
import type { LedgerJournal, LedgerReadPage } from '../pure/journal';

export interface JournalTransaction {
  readonly load: Effect.Effect<LedgerJournal | null, StorageError | ValidationError>;
  readonly save: (journal: LedgerJournal) => Effect.Effect<void, StorageError | ValidationError>;
}

export class JournalStore extends Context.Tag('@lody/e2ee-core/JournalStore')<
  JournalStore,
  {
    readonly exclusive: <A, E, R>(
      work: (tx: JournalTransaction) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | StorageError | ValidationError, R>;
  }
>() {}

export class LedgerTransport extends Context.Tag('@lody/e2ee-core/LedgerTransport')<
  LedgerTransport,
  {
    readonly initialOffset: string;
    readonly readAfter: (
      offset: string
    ) => Effect.Effect<LedgerReadPage, TransportError | StreamProtocolError | ValidationError>;
    readonly appendCas: (
      offset: string,
      bytes: Uint8Array
    ) => Effect.Effect<
      'accepted' | 'conflict' | 'unsupported',
      TransportError | StreamProtocolError | ValidationError
    >;
  }
>() {}

export class DeviceSigner extends Context.Tag('@lody/e2ee-core/DeviceSigner')<
  DeviceSigner,
  {
    readonly publicKey: SigningPublicKey;
    readonly sign: (message: Uint8Array) => Effect.Effect<Signature, CryptoError | ValidationError>;
  }
>() {}

export interface SignatureJobInput {
  readonly publicKey: Uint8Array;
  readonly message: Uint8Array;
  readonly signature: Uint8Array;
  readonly code?: ValidationError['code'];
  readonly position?: number;
}

/** Trusted cryptographic implementation; success proves a signature, not permission. */
export class SignatureVerifier extends Context.Tag('@lody/e2ee-core/SignatureVerifier')<
  SignatureVerifier,
  {
    readonly verify: (input: {
      readonly publicKey: SigningPublicKey;
      readonly message: Uint8Array;
      readonly signature: Signature;
    }) => Effect.Effect<void, ValidationError>;
    /** One Effect for a batch. Do not construct an Effect per signature in replay. */
    readonly verifyMany: (
      jobs: readonly SignatureJobInput[]
    ) => Effect.Effect<void, ValidationError>;
  }
>() {}
