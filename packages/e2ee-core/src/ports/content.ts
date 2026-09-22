import { Context, type Effect } from 'effect';
import type { ContentError, CryptoError } from '../pure/errors';
import type { ContentHeader } from '../pure/content-frame';

/** Caller-owned authority lookup. Policy throws remain defects at the Promise boundary. */
export class ContentAuthority extends Context.Tag('@lody/e2ee-core/ContentAuthority')<
  ContentAuthority,
  {
    readonly authorize: (
      header: ContentHeader,
      expected?: string
    ) => Effect.Effect<string, ContentError | CryptoError>;
  }
>() {}

/** Injected WebCrypto/random for content HKDF, Ed25519 sign, and verify. */
export class ContentCrypto extends Context.Tag('@lody/e2ee-core/ContentCrypto')<
  ContentCrypto,
  {
    readonly random: (
      length: number
    ) => Effect.Effect<Uint8Array<ArrayBuffer>, CryptoError | ContentError>;
    readonly derive: (
      epochKey: Uint8Array<ArrayBuffer>,
      header: ContentHeader
    ) => Effect.Effect<Uint8Array<ArrayBuffer>, CryptoError | ContentError>;
    readonly sign: (
      signingKey: CryptoKey,
      message: Uint8Array
    ) => Effect.Effect<Uint8Array<ArrayBuffer>, CryptoError | ContentError>;
    readonly verify: (
      publicKeyHex: string,
      message: Uint8Array,
      signatureHex: string
    ) => Effect.Effect<boolean, ContentError | CryptoError>;
  }
>() {}
