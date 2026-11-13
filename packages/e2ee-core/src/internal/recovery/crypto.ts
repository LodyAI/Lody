import { decode, encode } from '@ipld/dag-cbor';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { Data, Effect, Result, Schema } from 'effect';
import { bytesEqual } from '../foundation/cbor';

/** A recovery vault operation failed; `code` names the reason, never secret material. */
export class RecoveryVaultError extends Data.TaggedError('RecoveryVaultError')<{
  readonly code:
    | 'invalid-input'
    | 'random-unavailable'
    | 'authentication'
    | 'rollback'
    | 'conflict'
    | 'storage'
    | 'missing'
    | 'closed'
    | 'unauthorized'
    | 'pending'
    | 'prf-unavailable';
}> {}
export const vaultError = (code: RecoveryVaultError['code']) => new RecoveryVaultError({ code });
export const MAX_VAULT_BYTES = 256 * 1024;
/** Minimum length (in Unicode code points, after NFC normalization) for a recovery password. */
export const MIN_RECOVERY_PASSWORD_LENGTH = 12;
/** Maximum UTF-8 byte length accepted for a recovery password. */
export const MAX_RECOVERY_PASSWORD_BYTES = 1024;
/** Argon2id cost parameters (`m` in KiB, `t` iterations, `p` lanes). */
export interface PasswordKdfParams {
  /** Memory size in KiB. */
  readonly m: number;
  /** Number of passes (iterations). */
  readonly t: number;
  /** Degree of parallelism (lanes). */
  readonly p: number;
}
/** Default RFC 9106 Argon2id parameters for password-wrapped vault master keys (64 MiB, 3 passes, 1 lane). */
export const DEFAULT_PASSWORD_KDF: PasswordKdfParams = Object.freeze({
  m: 65536,
  t: 3,
  p: 1,
});
/** Minimum Argon2id floor accepted before running KDF (OWASP 19 MiB, 2 passes, 1 lane). */
export const MIN_PASSWORD_KDF: PasswordKdfParams = Object.freeze({
  m: 19456,
  t: 2,
  p: 1,
});
/** Maximum Argon2id ceiling accepted from untrusted envelopes (256 MiB, 10 passes, 4 lanes). */
export const MAX_PASSWORD_KDF: PasswordKdfParams = Object.freeze({
  m: 262144,
  t: 10,
  p: 4,
});
export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
export const digest = (bytes: Uint8Array) => hex(sha256(bytes));
export const fromHex = (value: string, size = 32) => {
  if (typeof value !== 'string' || value.length !== size * 2 || !/^[0-9a-f]+$/.test(value))
    throw vaultError('invalid-input');
  return Uint8Array.from(value.match(/../g)!, (v) => parseInt(v, 16));
};
export const canonical = (value: unknown): Uint8Array => {
  const bytes = encode(value);
  if (bytes.length > MAX_VAULT_BYTES) throw vaultError('invalid-input');
  return bytes;
};
export const parseCanonical = (input: Uint8Array): unknown => {
  if (!(input instanceof Uint8Array) || input.length === 0 || input.length > MAX_VAULT_BYTES)
    throw vaultError('invalid-input');
  const bytes = new Uint8Array(input),
    value: unknown = decode(bytes);
  if (!bytesEqual(bytes, canonical(value))) throw vaultError('invalid-input');
  return value;
};
const wipeByteLeaves = (value: unknown, depth = 0): void => {
  if (value instanceof Uint8Array) value.fill(0);
  else if (depth < 8 && value !== null && typeof value === 'object')
    for (const item of Array.isArray(value) ? value : Object.values(value))
      wipeByteLeaves(item, depth + 1);
};
/** Decode canonical CBOR secret plaintext for `use` only. Whether `use` returns
 * or throws, the input copy, the canonical re-encoding and every decoded byte
 * string are wiped, so `use` must copy anything it keeps. */
export const useCanonicalSecret = <A>(input: Uint8Array, use: (value: unknown) => A): A => {
  if (!(input instanceof Uint8Array) || input.length === 0 || input.length > MAX_VAULT_BYTES)
    throw vaultError('invalid-input');
  const bytes = new Uint8Array(input);
  let value: unknown, again: Uint8Array | undefined;
  try {
    value = decode(bytes);
    again = encode(value);
    if (!bytesEqual(bytes, again)) throw vaultError('invalid-input');
    return use(value);
  } finally {
    bytes.fill(0);
    again?.fill(0);
    wipeByteLeaves(value);
  }
};
export const random = (size: number) => {
  try {
    return globalThis.crypto.getRandomValues(new Uint8Array(size));
  } catch {
    throw vaultError('random-unavailable');
  }
};
export const attempt = <A>(work: () => A) =>
  Effect.try({
    try: work,
    catch: (error) => (error instanceof RecoveryVaultError ? error : vaultError('invalid-input')),
  });
export type VaultPurpose = 'file-wrap' | 'prf-wrap' | 'password-wrap' | 'workspace-entry' | 'index';
/** The service sees only these opaque fields. Purpose and predecessor stay inside
 * an independently authenticated encrypted header, never SQL/DTO columns. */
export interface VaultCiphertext {
  readonly entryId: string;
  readonly revision: number;
  readonly body: Uint8Array;
}
const CiphertextSchema = Schema.Struct({
  entryId: Schema.String,
  revision: Schema.Number,
  body: Schema.Uint8Array,
});
/** Validate and copy a vault ciphertext. */
export function ownCiphertext(input: VaultCiphertext): VaultCiphertext {
  const value = Result.getOrThrow(Schema.decodeUnknownResult(CiphertextSchema)(input));
  fromHex(value.entryId);
  if (
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    value.body.length < 80 ||
    value.body.length > MAX_VAULT_BYTES
  )
    throw vaultError('invalid-input');
  return Object.freeze({ ...value, body: new Uint8Array(value.body) });
}
/** Byte-for-byte equality of two vault ciphertexts. */
export const sameCiphertext = (a: VaultCiphertext, b: VaultCiphertext) =>
  a.entryId === b.entryId && a.revision === b.revision && bytesEqual(a.body, b.body);
/** Digest naming a vault ciphertext. */
export const ciphertextDigest = (value: VaultCiphertext) =>
  digest(canonical([value.entryId, value.revision, value.body]));
const derive = (secret: Uint8Array, vaultId: string, purpose: string) =>
  hkdf(
    sha256,
    secret,
    fromHex(vaultId),
    new TextEncoder().encode(`lody-e2ee/vault-v1/${purpose}\0`),
    32
  );
type Header = {
  readonly entryId: string;
  readonly revision: number;
  readonly previous: string | null;
  readonly purpose: VaultPurpose;
};
const aad = (vaultId: string, value: Header) =>
  canonical(['vault-v1', vaultId, value.entryId, value.revision, value.previous, value.purpose]);
const outerAad = (vaultId: string, value: Pick<Header, 'entryId' | 'revision'>) =>
  canonical(['vault-v1', vaultId, value.entryId, value.revision, 'encrypted-header']);
export function encryptVault(
  secret: Uint8Array,
  vaultId: string,
  header: Header,
  plaintext: Uint8Array
): VaultCiphertext {
  const key = derive(secret, vaultId, header.purpose),
    outerKey = derive(secret, vaultId, 'encrypted-header'),
    nonce = random(24),
    outerNonce = random(24);
  let hidden: Uint8Array | undefined;
  try {
    const inner = xchacha20poly1305(key, nonce, aad(vaultId, header)).encrypt(plaintext);
    hidden = canonical([header.previous, header.purpose, nonce, inner]);
    const sealed = xchacha20poly1305(outerKey, outerNonce, outerAad(vaultId, header)).encrypt(
      hidden
    );
    const body = new Uint8Array(24 + sealed.length);
    body.set(outerNonce);
    body.set(sealed, 24);
    return ownCiphertext({ entryId: header.entryId, revision: header.revision, body });
  } finally {
    key.fill(0);
    outerKey.fill(0);
    hidden?.fill(0);
  }
}
const HiddenSchema = Schema.Tuple([
  Schema.NullOr(Schema.String),
  Schema.Literals(['file-wrap', 'prf-wrap', 'password-wrap', 'workspace-entry', 'index']),
  Schema.Uint8Array,
  Schema.Uint8Array,
]);
export function inspectVault(secret: Uint8Array, vaultId: string, input: VaultCiphertext) {
  const value = ownCiphertext(input),
    outerKey = derive(secret, vaultId, 'encrypted-header');
  let hidden: Uint8Array | undefined, key: Uint8Array | undefined;
  try {
    hidden = xchacha20poly1305(
      outerKey,
      value.body.subarray(0, 24),
      outerAad(vaultId, value)
    ).decrypt(value.body.subarray(24));
    const [previous, purpose, nonce, inner] = Result.getOrThrow(
      Schema.decodeUnknownResult(HiddenSchema)(parseCanonical(hidden))
    );
    if ((previous !== null && !/^[0-9a-f]{64}$/.test(previous)) || nonce.length !== 24)
      throw vaultError('authentication');
    key = derive(secret, vaultId, purpose);
    return {
      previous,
      purpose,
      plaintext: xchacha20poly1305(
        key,
        nonce,
        aad(vaultId, { ...value, previous, purpose })
      ).decrypt(inner),
    };
  } catch {
    throw vaultError('authentication');
  } finally {
    key?.fill(0);
    outerKey.fill(0);
    hidden?.fill(0);
  }
}
export function decryptVault(
  secret: Uint8Array,
  vaultId: string,
  input: VaultCiphertext,
  purpose?: VaultPurpose
): Uint8Array {
  const value = inspectVault(secret, vaultId, input);
  if (purpose && value.purpose !== purpose) {
    value.plaintext.fill(0);
    throw vaultError('authentication');
  }
  return value.plaintext;
}
/** Normalize a recovery password with Unicode NFC and enforce length bounds, returning
 * owned UTF-8 bytes that the caller must wipe after use. */
export function normalizeRecoveryPassword(password: string): Uint8Array {
  if (typeof password !== 'string') throw vaultError('invalid-input');
  const normalized = password.normalize('NFC');
  if ([...normalized].length < MIN_RECOVERY_PASSWORD_LENGTH) throw vaultError('invalid-input');
  const encoded = new TextEncoder().encode(normalized);
  if (encoded.length > MAX_RECOVERY_PASSWORD_BYTES) {
    encoded.fill(0);
    throw vaultError('invalid-input');
  }
  return encoded;
}
const validPasswordKdf = (kdf: PasswordKdfParams) =>
  Number.isSafeInteger(kdf.m) &&
  kdf.m >= MIN_PASSWORD_KDF.m &&
  kdf.m <= MAX_PASSWORD_KDF.m &&
  Number.isSafeInteger(kdf.t) &&
  kdf.t >= MIN_PASSWORD_KDF.t &&
  kdf.t <= MAX_PASSWORD_KDF.t &&
  Number.isSafeInteger(kdf.p) &&
  kdf.p >= MIN_PASSWORD_KDF.p &&
  kdf.p <= MAX_PASSWORD_KDF.p;
const PasswordEnvelopeSchema = Schema.Tuple([
  Schema.Literal('password-wrap-v1'),
  Schema.Literal(1),
  Schema.Uint8Array,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Uint8Array,
]);
const derivePasswordSecret = async (
  passwordBytes: Uint8Array,
  vaultId: string,
  entryId: string,
  salt: Uint8Array,
  kdf: PasswordKdfParams
): Promise<Uint8Array> => {
  const raw = await argon2idAsync(passwordBytes, salt, {
    m: kdf.m,
    t: kdf.t,
    p: kdf.p,
    dkLen: 32,
  });
  try {
    return hkdf(
      sha256,
      raw,
      salt,
      canonical(['vault-v1', 'password-kdf', 1, vaultId, entryId, kdf.m, kdf.t, kdf.p]),
      32
    );
  } finally {
    raw.fill(0);
  }
};
export const encryptPasswordWrap = (
  passwordBytes: Uint8Array,
  vaultId: string,
  entryId: string,
  plaintext: Uint8Array,
  kdf: PasswordKdfParams = DEFAULT_PASSWORD_KDF
): Effect.Effect<VaultCiphertext, RecoveryVaultError> =>
  Effect.gen(function* () {
    yield* attempt(() => {
      fromHex(vaultId);
      fromHex(entryId);
      if (!validPasswordKdf(kdf)) throw vaultError('invalid-input');
    });
    const salt = yield* attempt(() => random(32));
    const secret = yield* Effect.tryPromise({
      try: () => derivePasswordSecret(passwordBytes, vaultId, entryId, salt, kdf),
      catch: () => vaultError('invalid-input'),
    });
    return yield* Effect.acquireUseRelease(
      Effect.succeed(secret),
      (wrapSecret) =>
        attempt(() => {
          const inner = encryptVault(
            wrapSecret,
            vaultId,
            { entryId, revision: 0, previous: null, purpose: 'password-wrap' },
            plaintext
          );
          return ownCiphertext({
            entryId,
            revision: 0,
            body: canonical(['password-wrap-v1', 1, salt, kdf.m, kdf.t, kdf.p, inner.body]),
          });
        }),
      (wrapSecret) => Effect.sync(() => wrapSecret.fill(0))
    );
  });
export const decryptPasswordWrap = (
  passwordBytes: Uint8Array,
  vaultId: string,
  input: VaultCiphertext
): Effect.Effect<Uint8Array, RecoveryVaultError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => {
        fromHex(vaultId);
        const outer = ownCiphertext(input);
        const [, , salt, m, t, p, innerBody] = Result.getOrThrow(
          Schema.decodeUnknownResult(PasswordEnvelopeSchema)(parseCanonical(outer.body))
        );
        const kdf: PasswordKdfParams = { m, t, p };
        if (salt.length !== 32 || !validPasswordKdf(kdf)) throw vaultError('authentication');
        const inner = ownCiphertext({
          entryId: outer.entryId,
          revision: outer.revision,
          body: innerBody,
        });
        return { salt, kdf, inner };
      },
      catch: () => vaultError('authentication'),
    });
    const secret = yield* Effect.tryPromise({
      try: () =>
        derivePasswordSecret(passwordBytes, vaultId, input.entryId, parsed.salt, parsed.kdf),
      catch: () => vaultError('authentication'),
    });
    return yield* Effect.acquireUseRelease(
      Effect.succeed(secret),
      (wrapSecret) =>
        Effect.try({
          try: () => decryptVault(wrapSecret, vaultId, parsed.inner, 'password-wrap'),
          catch: () => vaultError('authentication'),
        }),
      (wrapSecret) => Effect.sync(() => wrapSecret.fill(0))
    );
  });
/** The one PRF input every vault ceremony evaluates. It is constant because a new
 * device does not know vaultId before the ceremony; HKDF salted by vaultId separates
 * vaults. */
export const vaultPrfInput = () => new TextEncoder().encode('lody-e2ee/vault-v1/prf-input\0');
/** The WebAuthn `user.id` of a vault passkey: the vaultId's 32 bytes. */
export const passkeyUserHandle = (vaultId: string) => fromHex(vaultId);
/** The vaultId named by a ceremony's user handle. This is only a hint: decryption, which
 * binds vaultId through the HKDF salt and AAD, decides whether the vault opens. */
export const vaultIdFromPasskeyUserHandle = (userHandle: Uint8Array) =>
  attempt(() => {
    if (!(userHandle instanceof Uint8Array) || userHandle.length !== 32)
      throw vaultError('prf-unavailable');
    return hex(userHandle);
  });
// Unpadded base64url of at most the 1023 raw bytes WebAuthn allows, so every platform
// computes the same entryId for one credential.
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const validCredentialId = (value: string) => {
  if (typeof value !== 'string' || value.length > 1364 || !/^[A-Za-z0-9_-]+$/.test(value))
    return false;
  // A partial final group carries zero padding bits, so one credential has one spelling.
  const remainder = value.length % 4,
    last = BASE64URL.indexOf(value.at(-1)!);
  return remainder === 0 || (remainder === 2 && !(last & 15)) || (remainder === 3 && !(last & 3));
};
/** A passkey whose registration reported PRF support; required to enroll it. */
export type VerifiedPasskeyRegistration = { readonly credentialId: string };
const registrations = new WeakSet<VerifiedPasskeyRegistration>();
/** Accept a registration ceremony. WebAuthn reports `enabled` only here; any PRF result
 * returned at registration is optional and is not used. */
export function verifiedPasskeyRegistration(input: {
  readonly credentialId: string;
  readonly extension: unknown;
}) {
  return attempt(() => {
    const schema = Schema.Struct({ enabled: Schema.Literal(true) });
    Result.getOrThrow(Schema.decodeUnknownResult(schema)(input.extension));
    if (!validCredentialId(input.credentialId)) throw vaultError('prf-unavailable');
    const capability = Object.freeze({ credentialId: input.credentialId });
    registrations.add(capability);
    return capability;
  }).pipe(Effect.mapError(() => vaultError('prf-unavailable')));
}
export const isVerifiedPasskeyRegistration = (value: VerifiedPasskeyRegistration) =>
  registrations.has(value);
/** An opaque verified passkey PRF output used to unlock a vault; dispose it with `disposePrf`. */
export type VerifiedPasskeyPrf = { readonly credentialId: string };
const prfCapabilities = new WeakMap<VerifiedPasskeyPrf, Uint8Array>();
/** Actual WebAuthn PRF result of an authentication ceremony, not ordinary passkey login.
 * WebAuthn never reports `enabled` at authentication, so only a user-verified 32-byte
 * `results.first` counts. The caller authenticates the ceremony and credential. */
export function verifiedPasskeyPrf(input: {
  readonly credentialId: string;
  readonly userVerified: boolean;
  readonly extension: unknown;
}) {
  return attempt(() => {
    const schema = Schema.Struct({
      enabled: Schema.optional(Schema.Literal(true)),
      results: Schema.Struct({ first: Schema.instanceOf(ArrayBuffer) }),
    });
    const value = Result.getOrThrow(Schema.decodeUnknownResult(schema)(input.extension));
    if (
      input.userVerified !== true ||
      !validCredentialId(input.credentialId) ||
      value.results.first.byteLength !== 32
    )
      throw vaultError('prf-unavailable');
    const key = new Uint8Array(value.results.first.slice(0));
    const capability = Object.freeze({ credentialId: input.credentialId });
    prfCapabilities.set(capability, key);
    return capability;
  }).pipe(Effect.mapError(() => vaultError('prf-unavailable')));
}
export function usePrf(capability: VerifiedPasskeyPrf) {
  const key = prfCapabilities.get(capability);
  if (!key) throw vaultError('prf-unavailable');
  return new Uint8Array(key);
}
/** Wipe a verified passkey PRF capability. */
export function disposePrf(capability: VerifiedPasskeyPrf) {
  prfCapabilities.get(capability)?.fill(0);
  prfCapabilities.delete(capability);
}
