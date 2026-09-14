import { ContentCipher, type ContentAuthor, type ContentHeader } from './content';
import { ControlLogError, invariant } from './wire';

/** Worst residual authorization window already accepted for this package. Not a production JWT. */
export const CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS = 15 * 60 * 1000;

export const SNAPSHOT_ADMISSION_DEVICE_HEADER = 'x-lody-snapshot-device';
export const SNAPSHOT_ADMISSION_LEASE_ISSUED_HEADER = 'x-lody-lease-issued-at';
export const SNAPSHOT_ADMISSION_LEASE_EXPIRES_HEADER = 'x-lody-lease-expires-at';

const LSCE = new Uint8Array([0x4c, 0x53, 0x43, 0x45]);
const PROVIDER_ENVELOPE_VERSION = 2;
const SNAPSHOT_KIND = 2;
const PROVIDER_PREFIX_BYTES = 10;
const MAX_PROVIDER_HEADER_BYTES = 512;
const MAX_OFFSET = 1024;
const SNAPSHOT_PURPOSES = new Set(['doc-snapshot', 'flock-snapshot']);

export interface ContentSnapshotPut {
  readonly streamKey: string;
  readonly offset: string;
  readonly body: Uint8Array;
  /** Authenticated submitting device, not a header claim inside the envelope. */
  readonly submittingDevice: string;
  readonly leaseIssuedAt: number;
  readonly leaseExpiresAt: number;
  readonly expectedGenesis: string;
  readonly expectedResource: string;
}

export interface ContentSnapshotAdmissionResult {
  readonly status: 'accepted' | 'idempotent';
  readonly currentOffset: string;
  readonly currentBody: Uint8Array;
  readonly header: Readonly<ContentHeader> | null;
}

export interface ContentSnapshotAdmissionOptions {
  readonly cipher: ContentCipher;
  /** Current document-write capability at admit time. Not historical acceptance. */
  readonly mayWriteDocument: (author: ContentAuthor) => boolean;
  /** Injected Unix milliseconds. Queue delay must not extend leaseExpiresAt. */
  readonly now: () => number;
}

type StreamPublication = {
  currentOffset: string;
  currentBody: Uint8Array;
  admitted: Map<string, Uint8Array>;
};

/**
 * Host-side content-snapshot publication. Submit-time authorization is separate
 * from read-time historical open(). Trusts this host to enforce admission; does
 * not resist a malicious host colluding with a revoked device. Not a receipt.
 */
export function createContentSnapshotPublication(options: ContentSnapshotAdmissionOptions) {
  const { cipher, mayWriteDocument, now } = options;
  const streams = new Map<string, StreamPublication>();
  const queues = new Map<string, Promise<void>>();

  function exclusive<T>(streamKey: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(streamKey) ?? Promise.resolve();
    const run = previous.then(work, work);
    queues.set(
      streamKey,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  return {
    async admit(input: ContentSnapshotPut): Promise<ContentSnapshotAdmissionResult> {
      invariant(
        typeof input.streamKey === 'string' && input.streamKey.length > 0,
        'invalid-snapshot-stream'
      );
      const offset = checkOffset(input.offset);
      invariant(
        input.body instanceof Uint8Array && input.body.byteLength > 0,
        'invalid-snapshot-body'
      );
      const body = input.body.slice();
      return await exclusive(input.streamKey, async () => {
        const row = streams.get(input.streamKey);
        const existing = row?.admitted.get(offset);
        if (row && existing && equalBytes(existing, body)) {
          return {
            status: 'idempotent' as const,
            currentOffset: row.currentOffset,
            currentBody: row.currentBody.slice(),
            header: null,
          };
        }
        if (existing) throw new ControlLogError('snapshot-identity-conflict');
        if (row && compareOffsets(offset, row.currentOffset) === 0) {
          if (equalBytes(row.currentBody, body)) {
            return {
              status: 'idempotent' as const,
              currentOffset: row.currentOffset,
              currentBody: row.currentBody.slice(),
              header: null,
            };
          }
          throw new ControlLogError('snapshot-identity-conflict');
        }

        checkLease(now(), input.leaseIssuedAt, input.leaseExpiresAt);
        const header = await authenticateSnapshot(cipher, body);
        invariant(header.device === input.submittingDevice, 'snapshot-device-mismatch');
        invariant(
          header.genesis === input.expectedGenesis && header.resource === input.expectedResource,
          'content-context-mismatch'
        );
        invariant(SNAPSHOT_PURPOSES.has(header.purpose), 'invalid-content-purpose');
        invariant(mayWriteDocument(header) === true, 'unauthorized');

        if (row) {
          const order = compareOffsets(offset, row.currentOffset);
          if (order === 'incomparable' || order < 0)
            throw new ControlLogError(
              order === 'incomparable'
                ? 'snapshot-offset-incomparable'
                : 'snapshot-offset-regression'
            );
        }

        const stored = body.slice();
        if (!row) {
          const created: StreamPublication = {
            currentOffset: offset,
            currentBody: stored,
            admitted: new Map([[offset, stored]]),
          };
          streams.set(input.streamKey, created);
        } else {
          row.admitted.set(offset, stored);
          row.currentOffset = offset;
          row.currentBody = stored;
        }
        return {
          status: 'accepted' as const,
          currentOffset: offset,
          currentBody: stored.slice(),
          header,
        };
      });
    },
    current(streamKey: string): { offset: string; body: Uint8Array } | undefined {
      const row = streams.get(streamKey);
      if (!row) return undefined;
      return { offset: row.currentOffset, body: row.currentBody.slice() };
    },
  };
}

export type ContentSnapshotPublication = ReturnType<typeof createContentSnapshotPublication>;

function checkOffset(offset: string): string {
  invariant(
    typeof offset === 'string' &&
      offset.length > 0 &&
      offset.length <= MAX_OFFSET &&
      offset !== 'now' &&
      offset !== '-1',
    'invalid-snapshot-offset'
  );
  return offset;
}

function checkLease(time: number, issuedAt: number, expiresAt: number): void {
  invariant(
    Number.isSafeInteger(time) &&
      Number.isSafeInteger(issuedAt) &&
      Number.isSafeInteger(expiresAt) &&
      time >= 0 &&
      issuedAt >= 0 &&
      expiresAt > issuedAt &&
      time >= issuedAt &&
      expiresAt - issuedAt <= CONTENT_SNAPSHOT_ADMISSION_WINDOW_MS,
    'snapshot-lease-invalid'
  );
  invariant(time < expiresAt, 'snapshot-lease-expired');
}

function parseOffsetOrder(value: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(value) && !/^\d{20}$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function compareOffsets(next: string, current: string): number | 'incomparable' {
  if (next === current) return 0;
  const left = parseOffsetOrder(next);
  const right = parseOffsetOrder(current);
  if (left === undefined || right === undefined) return 'incomparable';
  return left === right ? 0 : left < right ? -1 : 1;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, i) => byte === right[i]);
}

async function authenticateSnapshot(
  cipher: ContentCipher,
  envelope: Uint8Array
): Promise<Readonly<ContentHeader>> {
  const sealed = parseLsceSnapshot(envelope);
  return await cipher.authenticate(sealed);
}

function parseLsceSnapshot(payload: Uint8Array): Uint8Array {
  invariant(
    payload.byteLength >= PROVIDER_PREFIX_BYTES && LSCE.every((byte, i) => payload[i] === byte),
    'invalid-snapshot-envelope'
  );
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const headerLength = view.getUint16(6, false);
  invariant(
    payload[4] === PROVIDER_ENVELOPE_VERSION &&
      payload[5] === SNAPSHOT_KIND &&
      headerLength > 0 &&
      headerLength <= MAX_PROVIDER_HEADER_BYTES &&
      payload[8] === 0 &&
      payload[9] === 0,
    'invalid-snapshot-envelope'
  );
  const headerEnd = PROVIDER_PREFIX_BYTES + headerLength;
  invariant(
    payload.byteLength > headerEnd && payload[PROVIDER_PREFIX_BYTES] === SNAPSHOT_KIND,
    'invalid-snapshot-envelope'
  );
  return payload.slice(headerEnd);
}
