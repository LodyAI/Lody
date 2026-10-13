import { Result } from 'effect';
import { extract, expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { type EpochKey, copyEpochKeyBytes } from '../epoch-key';
import { ContentError } from '../errors';
import {
  contentKeyInfo,
  contentHkdfSalt,
  contentAad,
  encodeContentContext,
  encodeContentHeader,
  CONTENT_NONCE_BYTES,
  CONTENT_TAG_BYTES,
  MAX_CONTENT_BYTES,
  type ContentScope,
  type ContentHeader,
} from '../content-format';

declare const contentKeyBrand: unique symbol;
/** Scoped derived secret. No public material accessor or constructor. */
export interface ContentKey {
  readonly [contentKeyBrand]: true;
}
const keys = new WeakMap<ContentKey, { bytes: Uint8Array; info: Uint8Array }>();
const fail = (code: string) => Result.fail(new ContentError({ code }));

// Result.gen short-circuits without closing the iterator. Cleanup must complete
// in an ordinary call before its returned Result is yielded.
function usingKey<A>(
  secret: Uint8Array,
  operation: () => Result.Result<A, ContentError>
): Result.Result<A, ContentError> {
  try {
    return operation();
  } finally {
    secret.fill(0);
  }
}

/** Four document purposes share a leaf; other purposes derive separate keys. */
export function deriveContentKey(
  epochKey: EpochKey,
  scope: ContentScope
): Result.Result<ContentKey, ContentError> {
  return Result.gen(function* () {
    yield* encodeContentContext(scope);
    const info = yield* contentKeyInfo(scope);
    const secret = yield* Result.try({
      try: () => copyEpochKeyBytes(epochKey),
      catch: () => new ContentError({ code: 'invalid-content-key' }),
    });
    return yield* usingKey(secret, () =>
      Result.try({
        try: () => {
          let prk: Uint8Array | undefined;
          try {
            if (secret.byteLength !== 32) throw new ContentError({ code: 'invalid-content-key' });
            prk = extract(sha256, secret, contentHkdfSalt());
            const bytes = expand(sha256, prk, info, 32);
            const key = Object.freeze({}) as ContentKey;
            keys.set(key, { bytes, info });
            return key;
          } finally {
            prk?.fill(0);
          }
        },
        catch: () => new ContentError({ code: 'invalid-content-key' }),
      })
    );
  });
}

function keyForScope(key: ContentKey, scope: ContentScope) {
  return Result.gen(function* () {
    yield* encodeContentContext(scope);
    const info = yield* contentKeyInfo(scope);
    const stored = keys.get(key);
    if (!stored) return yield* fail('invalid-content-key');
    if (stored.info.length !== info.length || stored.info.some((byte, i) => byte !== info[i]))
      return yield* fail('content-key-scope-mismatch');
    return new Uint8Array(stored.bytes);
  });
}

export interface SealedContentAead {
  readonly nonce: Uint8Array;
  /** ciphertext || one 16-byte tag; no header or signature. */
  readonly ciphertext: Uint8Array;
}

/** AEAD only. Does not sign, construct a frame, or establish write permission.
 * Each new encryption obtains a nonce from the host's secure random source.
 * Retries must retain the returned bytes instead of encrypting again. */
export function sealContentAead(
  key: ContentKey,
  trustedHeader: ContentHeader,
  plaintext: Uint8Array,
  additionalData?: Uint8Array
): Result.Result<SealedContentAead, ContentError> {
  return Result.gen(function* () {
    if (!(plaintext instanceof Uint8Array)) return yield* fail('invalid-content-plaintext');
    if (plaintext.byteLength > MAX_CONTENT_BYTES) return yield* fail('content-too-large');
    const prefix = yield* encodeContentHeader(trustedHeader);
    const aad = yield* contentAad(trustedHeader, prefix, additionalData);
    const secret = yield* keyForScope(key, trustedHeader);
    return yield* usingKey(secret, () => {
      // Capture before calling the host, including on failure paths.
      const owned = new Uint8Array(plaintext);
      try {
        return Result.flatMap(
          Result.try({
            try: () => {
              const bytes = new Uint8Array(CONTENT_NONCE_BYTES);
              globalThis.crypto.getRandomValues(bytes);
              return bytes;
            },
            catch: () => new ContentError({ code: 'content-random-unavailable' }),
          }),
          (nonce) =>
            Result.try({
              try: () => ({
                nonce,
                ciphertext: xchacha20poly1305(secret, nonce, aad).encrypt(owned),
              }),
              catch: () => new ContentError({ code: 'invalid-content-key' }),
            })
        );
      } finally {
        owned.fill(0);
      }
    });
  });
}

/** AEAD only. Caller must separately verify the signature and author authority
 * before consuming plaintext. Header context comes from the caller, not a URL. */
export function openContentAead(
  key: ContentKey,
  trustedHeader: ContentHeader,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  additionalData?: Uint8Array
): Result.Result<Uint8Array, ContentError> {
  return Result.gen(function* () {
    if (!(nonce instanceof Uint8Array) || nonce.byteLength !== CONTENT_NONCE_BYTES)
      return yield* fail('invalid-content-nonce');
    if (
      !(ciphertext instanceof Uint8Array) ||
      ciphertext.byteLength < CONTENT_TAG_BYTES ||
      ciphertext.byteLength > MAX_CONTENT_BYTES + CONTENT_TAG_BYTES
    )
      return yield* fail('invalid-content-ciphertext');
    const prefix = yield* encodeContentHeader(trustedHeader);
    const aad = yield* contentAad(trustedHeader, prefix, additionalData);
    const secret = yield* keyForScope(key, trustedHeader);
    return yield* usingKey(secret, () =>
      Result.try({
        try: () => xchacha20poly1305(secret, nonce, aad).decrypt(ciphertext),
        catch: () => new ContentError({ code: 'content-authentication-failed' }),
      })
    );
  });
}
