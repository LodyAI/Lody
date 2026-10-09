import { Result } from 'effect';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { signingPublicKey } from './bytes';
import { copyBytes } from './cbor';
import { ContentError } from './errors';
import { keyId } from './identifiers';
import { concat } from './wire-crypto';

export type ContentPurpose =
  | 'doc-update'
  | 'doc-snapshot'
  | 'flock-update'
  | 'flock-snapshot'
  | 'blob'
  | 'epoch-history'
  | 'presence'
  | 'rpc-request'
  | 'rpc-response';

export interface ContentScope {
  readonly genesis: string;
  readonly epoch: number;
  /** Stable logical resource ID, not a transport URL. */
  readonly resource: string;
  readonly purpose: ContentPurpose;
}

export interface ContentAuthor {
  readonly actor: string;
  readonly memberInstance: string;
  readonly device: string;
}

/** Verified context plus the signing device. No claimed user/member identity. */
export interface ContentHeader extends ContentScope {
  readonly device: string;
}
export interface ContentMetadata {
  readonly version: 2;
  readonly epoch: number;
  readonly device: string;
}
export interface ContentPolicy {
  /** Resolve only through this Org's verified authority; rechecked after crypto.
   * Historical signature validity is separate from publication permission. */
  authorize(header: Readonly<ContentHeader>): string;
}
export interface SealContent {
  readonly scope: ContentScope;
  /** Local caller identity only; actor/memberInstance are never encoded or trusted. */
  readonly author: ContentAuthor;
  readonly epochKey: Uint8Array;
  readonly signingKey: CryptoKey;
  readonly plaintext: Uint8Array;
  /** Independent authenticated bytes; never embedded in the content frame. */
  readonly additionalData?: Uint8Array;
}
export interface ParsedContentFrame {
  readonly header: ContentMetadata;
  readonly nonce: Uint8Array;
  /** ciphertext || 16-byte AEAD tag. */
  readonly ciphertext: Uint8Array;
  readonly unsigned: Uint8Array;
  readonly signatureHex: string;
}
export const MAX_CONTENT_BYTES = 16 * 1024 * 1024;
export const CONTENT_NONCE_BYTES = 24;
export const CONTENT_TAG_BYTES = 16;
export const CONTENT_SIGNATURE_BYTES = 64;
export const CONTENT_KEY_BYTES = 32;
export const CONTENT_PREFIX_BYTES = 37;
export const CONTENT_OVERHEAD_BYTES = 141;
export const CONTENT_VERSION = 2;
export const MAX_CONTENT_ADDITIONAL_DATA_BYTES = 1024;
const encoder = new TextEncoder();
const PURPOSES: readonly ContentPurpose[] = [
  'doc-update',
  'doc-snapshot',
  'flock-update',
  'flock-snapshot',
  'blob',
  'epoch-history',
  'presence',
  'rpc-request',
  'rpc-response',
];
const fail = (code: string) => Result.fail(new ContentError({ code }));
const domain = (name: string) => encoder.encode(`lody-content-${name}/v2\0`);
export const CONTENT_HKDF_SALT = domain('hkdf');
function u32(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}
function fromHex(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/../g)!, (byte) => Number.parseInt(byte, 16));
}
export function copyContentKey(
  key: Uint8Array
): Result.Result<Uint8Array<ArrayBuffer>, ContentError> {
  return key instanceof Uint8Array && key.byteLength === CONTENT_KEY_BYTES
    ? Result.succeed(copyBytes(key))
    : fail('invalid-content-key');
}
export function checkContentSigningKey(value: unknown): Result.Result<string, ContentError> {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    return fail('invalid-signing-key');
  return Result.map(
    Result.mapError(
      signingPublicKey(fromHex(value)),
      () => new ContentError({ code: 'invalid-signing-key' })
    ),
    () => value
  );
}
/** Canonical context: raw genesis(32), u32be epoch, u16be ASCII resource length,
 * resource(1..1024 printable ASCII), purpose code(1..9). Never a transport URL. */
export function encodeContentContext(
  scope: ContentScope
): Result.Result<Uint8Array<ArrayBuffer>, ContentError> {
  if (typeof scope.genesis !== 'string' || !/^[0-9a-f]{64}$/.test(scope.genesis))
    return fail('invalid-content-genesis');
  if (!Number.isInteger(scope.epoch) || scope.epoch < 0 || scope.epoch > 0xffffffff)
    return fail('invalid-content-epoch');
  if (typeof scope.resource !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(scope.resource))
    return fail('invalid-content-resource');
  const purpose = PURPOSES.indexOf(scope.purpose);
  if (purpose < 0) return fail('invalid-content-purpose');
  const resource = encoder.encode(scope.resource);
  const length = new Uint8Array(2);
  new DataView(length.buffer).setUint16(0, resource.byteLength, false);
  return Result.succeed(
    concat([
      fromHex(scope.genesis),
      u32(scope.epoch),
      length,
      resource,
      new Uint8Array([purpose + 1]),
    ])
  );
}
export function encodeContentHeader(
  header: ContentHeader
): Result.Result<Uint8Array<ArrayBuffer>, ContentError> {
  return Result.gen(function* () {
    yield* encodeContentContext(header);
    yield* checkContentSigningKey(header.device);
    return concat([new Uint8Array([CONTENT_VERSION]), u32(header.epoch), fromHex(header.device)]);
  });
}
export function contentKeyInfo(
  scope: ContentScope
): Result.Result<Uint8Array<ArrayBuffer>, ContentError> {
  return Result.map(encodeContentContext(scope), (context) => concat([domain('key'), context]));
}
export function copyContentAdditionalData(
  value: Uint8Array | undefined
): Result.Result<Uint8Array<ArrayBuffer>, ContentError> {
  if (value === undefined) return Result.succeed(new Uint8Array());
  return value instanceof Uint8Array && value.byteLength <= MAX_CONTENT_ADDITIONAL_DATA_BYTES
    ? Result.succeed(copyBytes(value))
    : fail('invalid-content-additional-data');
}

function authenticatedBytes(
  name: 'aad' | 'signature',
  scope: ContentScope,
  bytes: Uint8Array,
  additionalData: Uint8Array | undefined
): Result.Result<Uint8Array<ArrayBuffer>, ContentError> {
  return Result.gen(function* () {
    const context = yield* encodeContentContext(scope);
    const binding = yield* copyContentAdditionalData(additionalData);
    // Empty binding retains generic v2. A separate domain and length avoid
    // ambiguity between unbound content and SDK-bound content.
    if (binding.byteLength === 0) return concat([domain(name), context, bytes]);
    const length = new Uint8Array(2);
    new DataView(length.buffer).setUint16(0, binding.byteLength, false);
    return concat([domain(`${name}-bound`), context, length, binding, bytes]);
  });
}
export function contentAad(
  scope: ContentScope,
  prefix: Uint8Array,
  additionalData?: Uint8Array
): Result.Result<Uint8Array<ArrayBuffer>, ContentError> {
  return authenticatedBytes('aad', scope, prefix, additionalData);
}
export function contentSigningBytes(
  scope: ContentScope,
  unsigned: Uint8Array,
  additionalData?: Uint8Array
): Result.Result<Uint8Array<ArrayBuffer>, ContentError> {
  return authenticatedBytes('signature', scope, unsigned, additionalData);
}
export function parseContentFrame(
  frame: Uint8Array
): Result.Result<ParsedContentFrame, ContentError> {
  if (
    !(frame instanceof Uint8Array) ||
    frame.byteLength < CONTENT_OVERHEAD_BYTES ||
    frame.byteLength > MAX_CONTENT_BYTES + CONTENT_OVERHEAD_BYTES
  )
    return fail('invalid-content-frame');
  if (frame[0] !== CONTENT_VERSION) return fail('unsupported-content-version');
  const wire = copyBytes(frame);
  const device = keyId(wire.subarray(5, CONTENT_PREFIX_BYTES));
  return Result.map(checkContentSigningKey(device), () => ({
    header: Object.freeze({
      version: CONTENT_VERSION,
      epoch: new DataView(wire.buffer).getUint32(1, false),
      device,
    }),
    nonce: wire.subarray(CONTENT_PREFIX_BYTES, CONTENT_PREFIX_BYTES + CONTENT_NONCE_BYTES),
    ciphertext: wire.subarray(CONTENT_PREFIX_BYTES + CONTENT_NONCE_BYTES, -CONTENT_SIGNATURE_BYTES),
    unsigned: wire.subarray(0, -CONTENT_SIGNATURE_BYTES),
    signatureHex: keyId(wire.subarray(-CONTENT_SIGNATURE_BYTES)),
  }));
}
export function inspectContentFrame(
  frame: Uint8Array
): Result.Result<ContentMetadata, ContentError> {
  return Result.map(parseContentFrame(frame), (parsed) => parsed.header);
}
export function assembleUnsignedContent(
  prefix: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array
): Uint8Array<ArrayBuffer> {
  return concat([prefix, nonce, ciphertext]);
}
export function assembleContentFrame(
  unsigned: Uint8Array,
  signature: Uint8Array
): Uint8Array<ArrayBuffer> {
  return concat([unsigned, signature]);
}

export function encryptContent(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array
): Result.Result<Uint8Array, ContentError> {
  return Result.try({
    try: () => xchacha20poly1305(key, nonce, aad).encrypt(plaintext),
    catch: () => new ContentError({ code: 'invalid-content-key' }),
  });
}

export function decryptContent(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array
): Result.Result<Uint8Array, ContentError> {
  return Result.try({
    try: () => xchacha20poly1305(key, nonce, aad).decrypt(ciphertext),
    catch: () => new ContentError({ code: 'content-authentication-failed' }),
  });
}

export function hexBytes(bytes: Uint8Array): string {
  return keyId(bytes);
}
