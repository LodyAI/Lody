import { getPublicKey, hashes, sign } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { HkdfSha256, X25519 } from '@hpke/dhkem-x25519';
import { Effect, Result } from 'effect';
import * as Bytes from './bytes';
import { ContentError } from './errors';
import type { DeviceSigner } from './signing';
import { MAX_CONTENT_BYTES } from './content-format';

// The pinned synchronous Ed25519 implementation always uses this fixed hash.
hashes.sha512 = sha512;

/** Borrowed JS curve capabilities. The Scope owns them; close drains HPKE and wipes owned private bytes. */
export interface BrowserDevice extends DeviceSigner {
  /** Derived X25519 public key; its ledger admission must be established separately. */
  readonly enc: Bytes.EncryptionPublicKey;
  /** Opaque, in-isolate handles accepted by openEpochKeyHpke; these are not native WebCrypto keys. */
  readonly encryption: Readonly<CryptoKeyPair>;
  /** Stop new signing/HPKE immediately, await admitted HPKE settlement, then wipe the owned secrets. Idempotent. */
  readonly close: Effect.Effect<void>;
}

type State = {
  readonly publicHandle: CryptoKey;
  readonly pair: CryptoKeyPair;
  readonly active: Set<Promise<void>>;
  closed: boolean;
};
const keys = new WeakMap<CryptoKey, State>();
const fail = (code: string) => new ContentError({ code });
const handle = (type: KeyType) =>
  Object.freeze({
    type,
    extractable: false,
    algorithm: Object.freeze({ name: 'X25519' }),
    usages: Object.freeze(type === 'private' ? ['deriveBits'] : []),
  }) as unknown as CryptoKey;

/** Internal lease: no secret export. A closed/mixed browser handle never routes through native crypto. */
export function borrowBrowserEncryption(pair: CryptoKeyPair) {
  const state = keys.get(pair.privateKey);
  if (!state) return undefined;
  if (state.closed || state.publicHandle !== pair.publicKey) throw fail('closed-or-invalid-key');
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  state.active.add(pending);
  let released = false;
  return {
    pair: state.pair,
    release() {
      if (released) return;
      released = true;
      state.active.delete(pending);
      settle();
    },
  };
}

/**
 * Import independent raw 32-byte Ed25519 seed and X25519 secret supplied by the
 * platform. Inputs are copied, never exported; caller-owned input buffers still
 * require wiping. Scope release closes/drains these capabilities. No generation,
 * persistence, KEK, pairing or membership authority is supplied here. Derive and
 * compare the returned public identities with the retained approved binding before use.
 */
export const importBrowserDevice = Effect.fnUntraced(function* (input: {
  readonly signingPrivate: Uint8Array;
  readonly encryptionPrivate: Uint8Array;
}) {
  return yield* Effect.acquireRelease(
    Effect.uninterruptible(
      Effect.tryPromise({
        try: async (): Promise<BrowserDevice> => {
          if (
            !(input?.signingPrivate instanceof Uint8Array) ||
            input.signingPrivate.length !== 32 ||
            !(input.encryptionPrivate instanceof Uint8Array) ||
            input.encryptionPrivate.length !== 32
          )
            throw fail('invalid-private-key');
          const signing = new Uint8Array(input.signingPrivate);
          const encryption = new Uint8Array(input.encryptionPrivate);
          try {
            const publicKey = Result.getOrThrow(Bytes.signingPublicKey(getPublicKey(signing)));
            const curve = new X25519(new HkdfSha256());
            // Passing the owned ArrayBuffer keeps the upstream secret backed by
            // this same wipeable buffer; no raw field escapes in the public handles.
            const privateKey = await curve.deserializePrivateKey(encryption.buffer);
            const publicX = await curve.derivePublicKey(privateKey);
            const enc = Result.getOrThrow(
              Bytes.encryptionPublicKey(new Uint8Array(await curve.serializePublicKey(publicX)))
            );
            const privateHandle = handle('private');
            const publicHandle = handle('public');
            const state: State = {
              publicHandle,
              pair: { privateKey, publicKey: publicX },
              active: new Set(),
              closed: false,
            };
            keys.set(privateHandle, state);
            let closing: Promise<void> | undefined;
            const close = Effect.uninterruptible(
              Effect.promise(() => {
                state.closed = true;
                return (closing ??= Promise.all([...state.active]).then(() => {
                  signing.fill(0);
                  encryption.fill(0);
                }));
              })
            );
            return Object.freeze({
              publicKey,
              enc,
              encryption: Object.freeze({ privateKey: privateHandle, publicKey: publicHandle }),
              close,
              sign: (message: Uint8Array) =>
                Effect.suspend(() => {
                  if (state.closed) return Effect.fail(fail('closed'));
                  if (!(message instanceof Uint8Array) || message.length > MAX_CONTENT_BYTES + 4096)
                    return Effect.fail(fail('signing-message-too-large'));
                  const owned = new Uint8Array(message);
                  return Effect.try({
                    try: () => {
                      try {
                        return Result.getOrThrow(Bytes.signature(sign(owned, signing)));
                      } finally {
                        owned.fill(0);
                      }
                    },
                    catch: () => fail('sign-failed'),
                  });
                }),
            });
          } catch (cause) {
            signing.fill(0);
            encryption.fill(0);
            throw cause;
          }
        },
        catch: () => fail('invalid-private-key'),
      })
    ),
    (device) => device.close
  );
});
