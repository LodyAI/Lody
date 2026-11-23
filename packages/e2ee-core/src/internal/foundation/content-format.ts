import { Result } from 'effect';
import { signingPublicKey } from './bytes';
import { copyBytes } from './cbor';
import { ContentError } from './errors';
import { keyId } from './identifiers';
import { concat } from './concat';

/** What a content frame carries; selects its key-derivation leaf and AAD domain. */
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

/** Trusted identity of one document: workspace genesis, epoch, logical resource id and document generation. */
export interface DocumentScope {
  readonly genesis: string;
  readonly epoch: number;
  /** Stable logical resource ID, not a transport URL. */
  readonly resource: string;
  /** Reserved document generation. Only 0 is supported. */
  readonly docEpoch?: number;
}
/** A `DocumentScope` plus the purpose of one content frame. */
export interface ContentScope extends DocumentScope {
  readonly purpose: ContentPurpose;
}

/** Caller context plus signing device. Constructing this value does not verify it. */
export interface ContentHeader extends ContentScope {
  readonly docEpoch: 0;
  readonly device: string;
  /** Snapshot continuation position; absent for updates and other purposes. */
  readonly continuationOffset?: string;
}
/** Unverified routing fields read from a content frame by `inspectContentFrame`; never authority. */
export interface ContentMetadata {
  readonly version: 0;
  readonly docEpoch: 0;
  readonly epoch: number;
  readonly device: string;
  /** Snapshot continuation position; absent for updates and other purposes. */
  readonly continuationOffset?: string;
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
export const CONTENT_PREFIX_BYTES = 39;
export const CONTENT_OVERHEAD_BYTES = 143;
export const MAX_SNAPSHOT_OFFSET_BYTES = 0xffff;
export const CONTENT_VERSION = 0;
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
const domain = (name: string) => encoder.encode(`lody-content-${name}/v0\0`);
/** Fresh copy of the fixed content HKDF salt. */
export const contentHkdfSalt = (): Uint8Array<ArrayBuffer> => domain('hkdf');
function u32(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}
function u16(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, false);
  return bytes;
}
function fromHex(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/../g)!, (byte) => Number.parseInt(byte, 16));
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
/** Raw genesis(32), org epoch(u32be), doc epoch(u16be), resource length(u16be), ASCII resource. */
export function encodeDocumentContext(
  scope: DocumentScope
): Result.Result<Uint8Array<ArrayBuffer>, ContentError> {
  if (typeof scope.genesis !== 'string' || !/^[0-9a-f]{64}$/.test(scope.genesis))
    return fail('invalid-content-genesis');
  if (!Number.isInteger(scope.epoch) || scope.epoch < 0 || scope.epoch > 0xffffffff)
    return fail('invalid-content-epoch');
  if (scope.docEpoch !== undefined && scope.docEpoch !== 0)
    return fail('unsupported-document-epoch');
  if (typeof scope.resource !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(scope.resource))
    return fail('invalid-content-resource');
  const resource = encoder.encode(scope.resource);
  return Result.succeed(
    concat([fromHex(scope.genesis), u32(scope.epoch), u16(0), u16(resource.byteLength), resource])
  );
}
/** Purpose stays authenticated even when document purposes share a key. */
export function encodeContentContext(
  scope: ContentScope
): Result.Result<Uint8Array<ArrayBuffer>, ContentError> {
  const purpose = PURPOSES.indexOf(scope.purpose);
  if (purpose < 0) return fail('invalid-content-purpose');
  return Result.map(encodeDocumentContext(scope), (context) =>
    concat([context, new Uint8Array([purpose + 1])])
  );
}
export function isDocumentPurpose(purpose: ContentPurpose): boolean {
  return PURPOSES.indexOf(purpose) >= 0 && PURPOSES.indexOf(purpose) < 4;
}

export function isSnapshotPurpose(purpose: ContentPurpose): boolean {
  return purpose === 'doc-snapshot' || purpose === 'flock-snapshot';
}
/** The position is an opaque printable ASCII token, never an ordered number. */
export function encodeSnapshotContinuationOffset(
  offset: unknown
): Result.Result<Uint8Array<ArrayBuffer>, ContentError> {
  if (
    typeof offset !== 'string' ||
    !/^[\x21-\x7e]+$/.test(offset) ||
    offset.length > MAX_SNAPSHOT_OFFSET_BYTES ||
    offset === 'now' ||
    offset === '-1'
  )
    return fail('invalid-snapshot-offset');
  const bytes = encoder.encode(offset);
  return Result.succeed(concat([u16(bytes.length), bytes]));
}
/** Canonical content v0 header bytes for a trusted `ContentHeader`. */
export function encodeContentHeader(
  header: ContentHeader
): Result.Result<Uint8Array<ArrayBuffer>, ContentError> {
  return Result.gen(function* () {
    yield* encodeContentContext(header);
    yield* checkContentSigningKey(header.device);
    const continuation = isSnapshotPurpose(header.purpose)
      ? yield* encodeSnapshotContinuationOffset(header.continuationOffset)
      : header.continuationOffset === undefined
        ? new Uint8Array()
        : yield* fail('invalid-snapshot-offset');
    return concat([
      new Uint8Array([CONTENT_VERSION]),
      u32(header.epoch),
      u16(0),
      fromHex(header.device),
      continuation,
    ]);
  });
}
/** HKDF `info` (derivation context) for a content scope; context, not key material. */
export function contentKeyInfo(
  scope: ContentScope
): Result.Result<Uint8Array<ArrayBuffer>, ContentError> {
  return isDocumentPurpose(scope.purpose)
    ? Result.map(encodeDocumentContext(scope), (context) =>
        concat([encoder.encode('lody-document-key/v0\0'), context])
      )
    : Result.map(encodeContentContext(scope), (context) => concat([domain('key'), context]));
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
    // Empty binding retains generic v0. A separate domain and length avoid
    // ambiguity between unbound content and SDK-bound content.
    if (binding.byteLength === 0) return concat([domain(name), context, bytes]);
    const length = new Uint8Array(2);
    new DataView(length.buffer).setUint16(0, binding.byteLength, false);
    return concat([domain(`${name}-bound`), context, length, binding, bytes]);
  });
}
/** AEAD additional data binding a content header to its trusted scope (and optional binding bytes). */
export function contentAad(
  scope: ContentScope,
  prefix: Uint8Array,
  additionalData?: Uint8Array
): Result.Result<Uint8Array<ArrayBuffer>, ContentError> {
  return authenticatedBytes('aad', scope, prefix, additionalData);
}
/** Exact bytes a device signs for a content frame. */
export function contentSigningBytes(
  scope: ContentScope,
  unsigned: Uint8Array,
  additionalData?: Uint8Array
): Result.Result<Uint8Array<ArrayBuffer>, ContentError> {
  return authenticatedBytes('signature', scope, unsigned, additionalData);
}
/** Parsing needs the caller-selected purpose because v0 carries no purpose tag. */
export function parseContentFrame(
  frame: Uint8Array,
  purpose: ContentPurpose = 'doc-update'
): Result.Result<ParsedContentFrame, ContentError> {
  return Result.gen(function* () {
    const snapshot = isSnapshotPurpose(purpose);
    const maximumExtra = snapshot ? 2 + MAX_SNAPSHOT_OFFSET_BYTES : 0;
    if (
      !(frame instanceof Uint8Array) ||
      frame.byteLength < CONTENT_OVERHEAD_BYTES + (snapshot ? 3 : 0) ||
      frame.byteLength > MAX_CONTENT_BYTES + CONTENT_OVERHEAD_BYTES + maximumExtra
    )
      return yield* fail('invalid-content-frame');
    if (frame[0] !== CONTENT_VERSION) return yield* fail('unsupported-content-version');
    if (new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(5, false) !== 0)
      return yield* fail('unsupported-document-epoch');
    const wire = copyBytes(frame);
    let prefixBytes = CONTENT_PREFIX_BYTES;
    let continuationOffset: string | undefined;
    if (snapshot) {
      const length = new DataView(wire.buffer).getUint16(CONTENT_PREFIX_BYTES, false);
      prefixBytes += 2 + length;
      if (!length || wire.length < CONTENT_OVERHEAD_BYTES + 2 + length)
        return yield* fail('invalid-snapshot-offset');
      const raw = wire.subarray(CONTENT_PREFIX_BYTES + 2, prefixBytes);
      if (raw.some((byte) => byte < 0x21 || byte > 0x7e))
        return yield* fail('invalid-snapshot-offset');
      continuationOffset = new TextDecoder().decode(raw);
      yield* encodeSnapshotContinuationOffset(continuationOffset);
    }
    if (
      wire.length - CONTENT_OVERHEAD_BYTES - (prefixBytes - CONTENT_PREFIX_BYTES) >
      MAX_CONTENT_BYTES
    )
      return yield* fail('invalid-content-frame');
    const device = keyId(wire.subarray(7, CONTENT_PREFIX_BYTES));
    yield* checkContentSigningKey(device);
    return {
      header: Object.freeze({
        version: CONTENT_VERSION,
        docEpoch: 0,
        epoch: new DataView(wire.buffer).getUint32(1, false),
        device,
        ...(snapshot ? { continuationOffset } : {}),
      }),
      nonce: wire.subarray(prefixBytes, prefixBytes + CONTENT_NONCE_BYTES),
      ciphertext: wire.subarray(prefixBytes + CONTENT_NONCE_BYTES, -CONTENT_SIGNATURE_BYTES),
      unsigned: wire.subarray(0, -CONTENT_SIGNATURE_BYTES),
      signatureHex: keyId(wire.subarray(-CONTENT_SIGNATURE_BYTES)),
    };
  });
}
/** Unverified metadata only; never establishes authority or authenticates content. */
export function inspectContentFrame(
  frame: Uint8Array,
  purpose: ContentPurpose = 'doc-update'
): Result.Result<ContentMetadata, ContentError> {
  return Result.map(parseContentFrame(frame, purpose), (parsed) => parsed.header);
}
