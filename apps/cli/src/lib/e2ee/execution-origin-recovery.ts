import { isCloudE2eeMemberRemoved, isCloudE2eeDeviceRevoked } from '../cloud-e2ee-errors';
import { Effect } from 'effect';
import type { PayloadProtectionOpenInput } from '@loro-dev/streams-crdt';
import { encodeStreamsRoomAdditionalData } from 'loro-repo/transport/streams';
import type { OpId } from 'loro-crdt';
import type { CloudE2eePort } from '@lody/platform';
import type { ExecutionOrigins } from './execution-origins';

const context = {
  protocol: 'loro-streams-crdt-payload-protection',
  version: 2,
  kind: 'update_batch',
} as const;
const prefix = new TextEncoder().encode('loro-streams-crdt-payload-protection/v2\0');

/** Released streams-crdt framing: u32be items containing LSCE v2 envelopes.
 * Routing metadata supplies neither the signer nor the logical room AAD. */
export function executionOriginalFrames(
  message: Uint8Array,
  namespace: string,
  docId: string
): PayloadProtectionOpenInput[] {
  const frames: PayloadProtectionOpenInput[] = [];
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  for (let offset = 0; offset < message.length;) {
    if (offset + 4 > message.length) throw new Error('e2ee_invalid_update_batch');
    const size = view.getUint32(offset, false);
    offset += 4;
    if (size < 12 || size > message.length - offset) throw new Error('e2ee_invalid_update_batch');
    const envelope = message.subarray(offset, offset + size);
    offset += size;
    const headerSize = new DataView(
      envelope.buffer,
      envelope.byteOffset,
      envelope.byteLength
    ).getUint16(6, false);
    if (
      envelope[0] !== 76 ||
      envelope[1] !== 83 ||
      envelope[2] !== 67 ||
      envelope[3] !== 69 ||
      envelope[4] !== 2 ||
      envelope[5] !== 1 ||
      envelope[8] !== 0 ||
      envelope[9] !== 0 ||
      headerSize < 1 ||
      headerSize > 512 ||
      10 + headerSize >= size
    )
      throw new Error('e2ee_invalid_update_batch');
    const aad = new Uint8Array(prefix.length + 10 + headerSize);
    aad.set(prefix);
    aad.set(envelope.subarray(0, 10 + headerSize), prefix.length);
    frames.push({
      context,
      header: envelope.slice(10, 10 + headerSize),
      sealed: envelope.slice(10 + headerSize),
      additionalData: encodeStreamsRoomAdditionalData(namespace, { kind: 'doc', docId }, aad),
    });
  }
  return frames;
}

/** One host owns bounded backward scans. A cache hit never performs network I/O.
 * Incomplete scans resume on the next dispatch; no negative result is durable. */
export function makeExecutionOriginRecovery(
  origins: ExecutionOrigins,
  readPage: NonNullable<CloudE2eePort['readExecutionOriginPage']>,
  access: { workspaceId: string; credential: string },
  namespace: string
) {
  const cursors = new Map<string, string>();
  const recover = Effect.fnUntraced(function* (
    docId: string,
    id: OpId,
    open: (
      input: PayloadProtectionOpenInput
    ) => Effect.Effect<{ plaintext: Uint8Array }, unknown, import('effect').Scope.Scope>
  ) {
    const key = `${docId}:${id.peer}:${id.counter}`;
    const work = Effect.gen(function* () {
      for (let page = 0; page < 8; page += 1) {
        const before = cursors.get(key);
        const result = yield* Effect.tryPromise({
          try: (signal) => readPage({ ...access, docId, before }, signal),
          catch: (cause) => cause,
        });
        let found = false;
        for (const message of result.messages) {
          const requests = yield* Effect.try({
            try: () => executionOriginalFrames(message, namespace, docId),
            catch: (cause) => cause,
          });
          for (const request of requests) {
            const opened = yield* open(request);
            try {
              const retained = yield* Effect.try({
                try: () => origins.retain(`doc:${docId}`, request, opened.plaintext, id),
                catch: (cause) => cause,
              });
              found = retained || found;
            } finally {
              opened.plaintext.fill(0);
            }
          }
        }
        if (found || result.atStart) {
          cursors.delete(key);
          return undefined;
        }
        if (result.before === before)
          return yield* Effect.fail(new Error('e2ee_origin_cursor_stalled'));
        cursors.set(key, result.before);
      }
      return undefined;
    });
    // SDK reads cooperate with the caller's abort signal. Timeout leaves the
    // unclaimed turn pending; cleanup and cancellation stay in its Effect scope.
    yield* work.pipe(
      Effect.timeout('3 seconds'),
      Effect.catch((cause) =>
        isCloudE2eeMemberRemoved(cause) || isCloudE2eeDeviceRevoked(cause)
          ? Effect.fail(cause)
          : Effect.void
      )
    );
  });
  return { recover, clear: () => cursors.clear() };
}
