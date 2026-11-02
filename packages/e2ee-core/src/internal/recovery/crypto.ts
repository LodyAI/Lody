import { decode, encode } from '@ipld/dag-cbor';
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
export type VaultPurpose = 'file-wrap' | 'prf-wrap' | 'workspace-entry' | 'index';
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
  Schema.Literals(['file-wrap', 'prf-wrap', 'workspace-entry', 'index']),
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
/** An opaque verified passkey PRF output used to unlock a vault; dispose it with `disposePrf`. */
export type VerifiedPasskeyPrf = { readonly credentialId: string };
const prfCapabilities = new WeakMap<VerifiedPasskeyPrf, Uint8Array>();
/** Actual WebAuthn PRF extension result, not ordinary passkey login. The caller
 * authenticates the ceremony and credential; absent enabled/result never unlocks. */
export function verifiedPasskeyPrf(input: {
  readonly credentialId: string;
  readonly extension: unknown;
}) {
  return attempt(() => {
    const schema = Schema.Struct({
      enabled: Schema.Literal(true),
      results: Schema.Struct({ first: Schema.instanceOf(ArrayBuffer) }),
    });
    const value = Result.getOrThrow(Schema.decodeUnknownResult(schema)(input.extension));
    if (
      !input.credentialId ||
      input.credentialId.length > 1024 ||
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
