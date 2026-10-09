import { Result } from 'effect';
import { MAX_CONTENT_BYTES, CONTENT_OVERHEAD_BYTES } from './content-frame';
import { bytesEqual } from './cbor';
import { SnapshotAdmissionError } from './errors';
import { STREAMS_SNAPSHOT_HEADER, streamsContentAdditionalData } from './streams-content';

/** Structural view of the host store. Not evidence of authenticity. */
export interface SnapshotTxView {
  current(): { readonly offset: string; readonly body: Uint8Array } | undefined;
  admitted(offset: string): Uint8Array | undefined;
  save(snapshot: { offset: string; body: Uint8Array }): void;
}

export const CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS = 15 * 60 * 1000;
const MAX_OFFSET = 1024;
const LSCE = new Uint8Array([0x4c, 0x53, 0x43, 0x45]);
const PROVIDER_ENVELOPE_VERSION = 2;
const SNAPSHOT_KIND = 2;
const PROVIDER_PREFIX_BYTES = 10;
const MAX_SNAPSHOT_BODY_BYTES =
  PROVIDER_PREFIX_BYTES + 1 + MAX_CONTENT_BYTES + CONTENT_OVERHEAD_BYTES;
const SNAPSHOT_PURPOSES = new Set(['doc-snapshot', 'flock-snapshot']);

export interface SnapshotAuthor {
  readonly device: string;
}

export interface SnapshotHeader extends SnapshotAuthor {
  readonly genesis: string;
  readonly epoch: number;
  readonly resource: string;
  readonly purpose: string;
}

export interface SnapshotPut {
  readonly streamKey: string;
  readonly offset: string;
  readonly body: Uint8Array;
  readonly submittingDevice: string;
  readonly leaseIssuedAt: number;
  readonly leaseExpiresAt: number;
  readonly expectedGenesis: string;
  readonly expectedResource: string;
  readonly expectedPurpose: 'doc-snapshot' | 'flock-snapshot';
}

export type SnapshotAdmitResult =
  | {
      readonly status: 'accepted';
      readonly currentOffset: string;
      readonly currentBody: Uint8Array;
      readonly header: SnapshotHeader;
    }
  | {
      readonly status: 'idempotent';
      readonly currentOffset: string;
      readonly currentBody: Uint8Array;
      readonly header: null;
    };

const fail = (code: string) => Result.fail(new SnapshotAdmissionError({ code }));

export function checkSnapshotOffset(offset: unknown) {
  return typeof offset === 'string' &&
    offset.length > 0 &&
    offset.length <= MAX_OFFSET &&
    offset !== 'now' &&
    offset !== '-1'
    ? Result.succeed(offset)
    : fail('invalid-snapshot-offset');
}

export function checkSnapshotLease(time: number, issuedAt: number, expiresAt: number) {
  if (
    !Number.isSafeInteger(time) ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    time < 0 ||
    issuedAt < 0 ||
    expiresAt <= issuedAt ||
    time < issuedAt ||
    expiresAt - issuedAt > CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS
  )
    return fail('snapshot-lease-invalid');
  return time < expiresAt ? Result.void : fail('snapshot-lease-expired');
}

function parseOffsetOrder(value: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(value) && !/^\d{20}$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function compareSnapshotOffsets(next: string, current: string): number | 'incomparable' {
  if (next === current) return 0;
  const left = parseOffsetOrder(next);
  const right = parseOffsetOrder(current);
  if (left === undefined || right === undefined) return 'incomparable';
  return left === right ? 0 : left < right ? -1 : 1;
}

export function existingSnapshot(
  tx: SnapshotTxView,
  offset: string,
  body: Uint8Array
): Result.Result<SnapshotAdmitResult | undefined, SnapshotAdmissionError> {
  const current = tx.current();
  const prior = tx.admitted(offset);
  if (prior) {
    if (current === undefined) return fail('snapshot-store-corrupt');
    if (!bytesEqual(prior, body)) return fail('snapshot-identity-conflict');
    return Result.succeed({
      status: 'idempotent',
      currentOffset: current.offset,
      currentBody: current.body,
      header: null,
    });
  }
  if (current && compareSnapshotOffsets(offset, current.offset) === 0) {
    if (!bytesEqual(current.body, body)) return fail('snapshot-identity-conflict');
    return Result.succeed({
      status: 'idempotent',
      currentOffset: current.offset,
      currentBody: current.body,
      header: null,
    });
  }
  return Result.succeed(undefined);
}

export function commitSnapshotAdmission(
  tx: SnapshotTxView,
  input: {
    readonly offset: string;
    readonly body: Uint8Array;
    readonly header: SnapshotHeader;
    readonly submittingDevice: string;
    readonly expectedGenesis: string;
    readonly expectedResource: string;
    readonly expectedPurpose: 'doc-snapshot' | 'flock-snapshot';
    readonly mayWrite: boolean;
    readonly time: number;
    readonly leaseIssuedAt: number;
    readonly leaseExpiresAt: number;
  }
): Result.Result<SnapshotAdmitResult, SnapshotAdmissionError> {
  return Result.gen(function* () {
    // Identical bytes are not a credential: only the signing device may retry, in the
    // same context. A lost-ACK retry needs no fresh lease or write right because it
    // changes nothing; hosts must not republish a non-current idempotent result.
    if (input.header.device !== input.submittingDevice)
      return yield* fail('snapshot-device-mismatch');
    if (
      input.header.genesis !== input.expectedGenesis ||
      input.header.resource !== input.expectedResource ||
      input.header.purpose !== input.expectedPurpose
    )
      return yield* fail('content-context-mismatch');
    if (!SNAPSHOT_PURPOSES.has(input.header.purpose)) return yield* fail('invalid-content-purpose');
    const retry = yield* existingSnapshot(tx, input.offset, input.body);
    if (retry) return retry;
    if (input.mayWrite !== true) return yield* fail('unauthorized');
    yield* checkSnapshotLease(input.time, input.leaseIssuedAt, input.leaseExpiresAt);
    const current = tx.current();
    if (current) {
      const order = compareSnapshotOffsets(input.offset, current.offset);
      if (order === 'incomparable') return yield* fail('snapshot-offset-incomparable');
      if (order < 0) return yield* fail('snapshot-offset-regression');
    }
    tx.save({ offset: input.offset, body: input.body });
    return {
      status: 'accepted' as const,
      currentOffset: input.offset,
      currentBody: new Uint8Array(input.body),
      header: input.header,
    };
  });
}

/** Framing only. Does not authenticate the inner content signature. */
export function parseLsceSnapshot(payload: Uint8Array) {
  return Result.gen(function* () {
    if (
      payload.byteLength > MAX_SNAPSHOT_BODY_BYTES ||
      payload.byteLength < PROVIDER_PREFIX_BYTES ||
      !LSCE.every((byte, i) => payload[i] === byte)
    )
      return yield* fail('invalid-snapshot-envelope');
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const headerLength = view.getUint16(6, false);
    if (
      payload[4] !== PROVIDER_ENVELOPE_VERSION ||
      payload[5] !== SNAPSHOT_KIND ||
      headerLength !== 1 ||
      payload[8] !== 0 ||
      payload[9] !== 0
    )
      return yield* fail('invalid-snapshot-envelope');
    const headerEnd = PROVIDER_PREFIX_BYTES + headerLength;
    if (
      payload.byteLength <= headerEnd ||
      payload[PROVIDER_PREFIX_BYTES] !== STREAMS_SNAPSHOT_HEADER
    )
      return yield* fail('invalid-snapshot-envelope');
    return {
      inner: new Uint8Array(payload.subarray(headerEnd)),
      additionalData: streamsContentAdditionalData(payload.subarray(0, headerEnd)),
    };
  });
}

export function checkSnapshotPut(input: SnapshotPut) {
  return Result.gen(function* () {
    if (typeof input.streamKey !== 'string' || input.streamKey.length === 0)
      return yield* fail('invalid-snapshot-stream');
    const offset = yield* checkSnapshotOffset(input.offset);
    if (
      !(input.body instanceof Uint8Array) ||
      input.body.byteLength === 0 ||
      input.body.byteLength > MAX_SNAPSHOT_BODY_BYTES
    )
      return yield* fail('invalid-snapshot-body');
    return {
      streamKey: input.streamKey,
      offset,
      body: new Uint8Array(input.body),
      submittingDevice: input.submittingDevice,
      leaseIssuedAt: input.leaseIssuedAt,
      leaseExpiresAt: input.leaseExpiresAt,
      expectedGenesis: input.expectedGenesis,
      expectedResource: input.expectedResource,
      expectedPurpose: input.expectedPurpose,
    };
  });
}
