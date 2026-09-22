import { Either } from 'effect';
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

export interface ContentHeader extends ContentScope, ContentAuthor {
  readonly messageId: string;
}

export interface ContentPolicy {
  /** Return a key from verified authority or throw. Called again after async crypto.
   * The caller owns freshness, historical-author rules and epoch eligibility.
   * This is NOT command execution authorization or durable replay protection. */
  authorize(header: Readonly<ContentHeader>): string;
}

export interface SealContent {
  readonly scope: ContentScope;
  readonly author: ContentAuthor;
  readonly epochKey: Uint8Array;
  readonly signingKey: CryptoKey;
  readonly plaintext: Uint8Array;
}

export interface ParsedContentFrame {
  readonly header: ContentHeader;
  readonly aad: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly unsigned: Uint8Array;
  readonly signatureHex: string;
}

export const MAX_CONTENT_BYTES = 16 * 1024 * 1024;
export const MAX_CONTENT_HEADER_BYTES = 4096;
export const CONTENT_NONCE_BYTES = 24;
export const CONTENT_TAG_BYTES = 16;
export const CONTENT_SIGNATURE_BYTES = 64;
export const CONTENT_KEY_BYTES = 32;
export const CONTENT_DOMAIN = 'lody-content/v1';
export const CONTENT_SIGNATURE_DOMAIN = new TextEncoder().encode('lody-content-signature/v1\0');

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
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
const fail = (code: string) => Either.left(new ContentError({ code }));

export function contentSigningBytes(unsigned: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat([CONTENT_SIGNATURE_DOMAIN, unsigned]);
}

export function copyContentKey(
  key: Uint8Array
): Either.Either<Uint8Array<ArrayBuffer>, ContentError> {
  if (!(key instanceof Uint8Array) || key.byteLength !== CONTENT_KEY_BYTES)
    return fail('invalid-content-key');
  return Either.right(copyBytes(key));
}

export function checkContentSigningKey(value: unknown): Either.Either<string, ContentError> {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(value)) return fail('invalid-hex');
  if (value.length !== 64) return fail('invalid-length');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return Either.map(
    Either.mapLeft(
      signingPublicKey(bytes),
      () => new ContentError({ code: 'invalid-signing-key' })
    ),
    () => value
  );
}

export function contentScopeParts(scope: ContentScope): Either.Either<string[], ContentError> {
  if (typeof scope.genesis !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(scope.genesis))
    return fail('invalid-hex');
  if (scope.genesis.length !== 64) return fail('invalid-length');
  if (!Number.isSafeInteger(scope.epoch) || scope.epoch < 0) return fail('invalid-content-epoch');
  if (typeof scope.resource !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(scope.resource))
    return fail('invalid-content-resource');
  if (!PURPOSES.includes(scope.purpose)) return fail('invalid-content-purpose');
  return Either.right([scope.genesis, String(scope.epoch), scope.resource, scope.purpose]);
}

export function encodeContentHeader(
  header: ContentHeader
): Either.Either<Uint8Array<ArrayBuffer>, ContentError> {
  return Either.gen(function* () {
    const scope = yield* contentScopeParts(header);
    for (const id of [header.actor, header.memberInstance, header.device]) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
        return yield* fail('invalid-content-author');
    }
    if (typeof header.messageId !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(header.messageId))
      return yield* fail('invalid-hex');
    if (header.messageId.length !== 32) return yield* fail('invalid-length');
    const encoded = encoder.encode(
      JSON.stringify([
        CONTENT_DOMAIN,
        ...scope,
        header.actor,
        header.memberInstance,
        header.device,
        header.messageId,
      ])
    );
    if (encoded.byteLength > MAX_CONTENT_HEADER_BYTES)
      return yield* fail('content-header-too-large');
    return encoded;
  });
}

export function contentKeyInfo(
  header: ContentHeader
): Either.Either<Uint8Array<ArrayBuffer>, ContentError> {
  return Either.map(contentScopeParts(header), (scope) =>
    encoder.encode(JSON.stringify(['lody-content-key/v1', ...scope]))
  );
}

export const CONTENT_HKDF_SALT = encoder.encode('lody-content-hkdf/v1');

export function parseContentFrame(
  frame: Uint8Array
): Either.Either<ParsedContentFrame, ContentError> {
  const min = 2 + CONTENT_NONCE_BYTES + CONTENT_TAG_BYTES + CONTENT_SIGNATURE_BYTES;
  const max =
    MAX_CONTENT_BYTES +
    MAX_CONTENT_HEADER_BYTES +
    2 +
    CONTENT_NONCE_BYTES +
    CONTENT_TAG_BYTES +
    CONTENT_SIGNATURE_BYTES;
  if (!(frame instanceof Uint8Array) || frame.byteLength < min || frame.byteLength > max)
    return fail('invalid-content-frame');
  const wire = copyBytes(frame);
  const size = new DataView(wire.buffer).getUint16(0);
  const start = 2 + size;
  if (
    size <= 0 ||
    size > MAX_CONTENT_HEADER_BYTES ||
    wire.byteLength < start + CONTENT_NONCE_BYTES + CONTENT_TAG_BYTES + CONTENT_SIGNATURE_BYTES
  )
    return fail('invalid-content-frame');
  if (
    wire.byteLength - start - CONTENT_NONCE_BYTES - CONTENT_TAG_BYTES - CONTENT_SIGNATURE_BYTES >
    MAX_CONTENT_BYTES
  )
    return fail('content-too-large');
  const aad = wire.subarray(2, start);
  let text: string;
  let fields: unknown;
  try {
    text = decoder.decode(aad);
    fields = JSON.parse(text);
  } catch {
    return fail('invalid-content-header');
  }
  if (
    !Array.isArray(fields) ||
    fields.length !== 9 ||
    !fields.every((field) => typeof field === 'string')
  )
    return fail('invalid-content-header');
  const values = fields as string[];
  if (values[0] !== CONTENT_DOMAIN) return fail('unsupported-content-version');
  if (!/^(0|[1-9][0-9]*)$/.test(values[2]!)) return fail('invalid-content-epoch');
  const purpose = values[4];
  if (!PURPOSES.includes(purpose as ContentPurpose)) return fail('invalid-content-purpose');
  const header: ContentHeader = Object.freeze({
    genesis: values[1]!,
    epoch: Number(values[2]),
    resource: values[3]!,
    purpose: purpose as ContentPurpose,
    actor: values[5]!,
    memberInstance: values[6]!,
    device: values[7]!,
    messageId: values[8]!,
  });
  return Either.flatMap(encodeContentHeader(header), (canonical) => {
    if (decoder.decode(canonical) !== text) return fail('noncanonical-content-header');
    return Either.right({
      header,
      aad,
      nonce: wire.subarray(start, start + CONTENT_NONCE_BYTES),
      ciphertext: wire.subarray(start + CONTENT_NONCE_BYTES, -CONTENT_SIGNATURE_BYTES),
      unsigned: wire.subarray(0, -CONTENT_SIGNATURE_BYTES),
      signatureHex: keyId(wire.subarray(-CONTENT_SIGNATURE_BYTES)),
    });
  });
}

export function inspectContentFrame(frame: Uint8Array): Either.Either<ContentHeader, ContentError> {
  return Either.map(parseContentFrame(frame), (parsed) => parsed.header);
}

export function assembleUnsignedContent(
  aad: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array
): Uint8Array<ArrayBuffer> {
  const length = new Uint8Array(2);
  new DataView(length.buffer).setUint16(0, aad.byteLength);
  return concat([length, aad, nonce, ciphertext]);
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
): Either.Either<Uint8Array, ContentError> {
  return Either.try({
    try: () => xchacha20poly1305(key, nonce, aad).encrypt(plaintext),
    catch: () => new ContentError({ code: 'invalid-content-key' }),
  });
}

export function decryptContent(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array
): Either.Either<Uint8Array, ContentError> {
  return Either.try({
    try: () => xchacha20poly1305(key, nonce, aad).decrypt(ciphertext),
    catch: () => new ContentError({ code: 'content-authentication-failed' }),
  });
}

export function contentScopeBinding(scope: ContentScope): Either.Either<string, ContentError> {
  return Either.map(contentScopeParts(scope), (parts) => JSON.stringify(parts));
}

export function hexBytes(bytes: Uint8Array): string {
  return keyId(bytes);
}
