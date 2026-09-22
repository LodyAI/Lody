import { Effect, Either, Layer } from 'effect';
import { Point, verifyAsync } from '@noble/ed25519';
import { ContentAuthority, ContentCrypto } from '../ports/content';
import {
  checkContentSigningKey,
  contentKeyInfo,
  CONTENT_HKDF_SALT,
  type ContentHeader,
  type ContentPolicy,
} from '../pure/content-frame';
import { ContentError, CryptoError } from '../pure/errors';
import { ControlLogError } from '../pure/legacy-error';

function contentFailure(error: unknown): Effect.Effect<never, ContentError | CryptoError> {
  if (error instanceof ContentError) return Effect.fail(error);
  if (error instanceof CryptoError) return Effect.fail(error);
  if (error instanceof ControlLogError) return Effect.fail(new ContentError({ code: error.code }));
  if (error instanceof DOMException) return Effect.fail(new CryptoError({ operation: 'import' }));
  return Effect.die(error);
}

function validSigningPoint(bytes: Uint8Array): boolean {
  try {
    const point = Point.fromBytes(bytes, false);
    return !point.isSmallOrder() && point.isTorsionFree();
  } catch {
    return false;
  }
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function contentAuthorityLayer(policy: ContentPolicy): Layer.Layer<ContentAuthority> {
  return Layer.succeed(ContentAuthority, {
    authorize: (header, expected) =>
      Effect.try({
        try: () => policy.authorize(header),
        catch: (error) => error,
      }).pipe(
        Effect.catchAll(contentFailure),
        Effect.flatMap((key) =>
          Effect.gen(function* () {
            yield* checkContentSigningKey(key);
            if (expected !== undefined && key !== expected)
              return yield* Effect.fail(new ContentError({ code: 'content-authority-changed' }));
            return key;
          })
        )
      ),
  });
}

export function contentCryptoLayer(
  platform: Pick<Crypto, 'subtle' | 'getRandomValues'>
): Layer.Layer<ContentCrypto> {
  return Layer.succeed(ContentCrypto, {
    random: (length) =>
      Effect.try({
        try: () => {
          const bytes = new Uint8Array(length);
          platform.getRandomValues(bytes);
          return bytes;
        },
        catch: (error) => error,
      }).pipe(Effect.catchAll(contentFailure)),
    derive: (epochKey, header: ContentHeader) => {
      const owned = new Uint8Array(epochKey);
      const info = contentKeyInfo(header);
      if (Either.isLeft(info)) {
        owned.fill(0);
        return Effect.fail(info.left);
      }
      const infoBytes = info.right;
      return Effect.tryPromise({
        try: async () => {
          try {
            const material = await platform.subtle.importKey('raw', owned, 'HKDF', false, [
              'deriveBits',
            ]);
            return new Uint8Array(
              await platform.subtle.deriveBits(
                { name: 'HKDF', hash: 'SHA-256', salt: CONTENT_HKDF_SALT, info: infoBytes },
                material,
                256
              )
            );
          } finally {
            owned.fill(0);
          }
        },
        catch: (error) => error,
      }).pipe(Effect.catchAll(contentFailure));
    },
    sign: (signingKey, message) => {
      const owned = new Uint8Array(message);
      return Effect.tryPromise({
        try: async () => new Uint8Array(await platform.subtle.sign('Ed25519', signingKey, owned)),
        catch: (error) => error,
      }).pipe(Effect.catchAll(contentFailure));
    },
    verify: (publicKeyHex, message, signatureHex) => {
      const owned = new Uint8Array(message);
      return Effect.tryPromise({
        try: async () => {
          if (!/^(?:[0-9a-f]{2})*$/.test(publicKeyHex) || publicKeyHex.length !== 64) return false;
          if (!/^(?:[0-9a-f]{2})*$/.test(signatureHex) || signatureHex.length !== 128) return false;
          const key = fromHex(publicKeyHex);
          const sig = fromHex(signatureHex);
          if (!validSigningPoint(key)) return false;
          try {
            if (!Point.fromBytes(sig.subarray(0, 32), false).isTorsionFree()) return false;
          } catch {
            return false;
          }
          return verifyAsync(sig, owned, key, { zip215: false });
        },
        catch: (error) => error,
      }).pipe(Effect.catchAll(contentFailure));
    },
  });
}

export function contentRuntimeLayer(
  policy: ContentPolicy,
  platform: Pick<Crypto, 'subtle' | 'getRandomValues'>
) {
  return Layer.merge(contentAuthorityLayer(policy), contentCryptoLayer(platform));
}
