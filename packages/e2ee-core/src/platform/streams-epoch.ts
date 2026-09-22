import type { StreamError, StreamsClient } from '@loro-dev/streams-client';
import { Effect, Layer } from 'effect';
import { EpochStream } from '../ports/epoch-stream';
import { StreamProtocolError, TransportError, ValidationError } from '../pure/errors';

function failure(error: StreamError, operation: 'read' | 'append') {
  if (error.code === 'unauthorized' || error.code === 'forbidden')
    return new ValidationError({ code: 'unauthorized' });
  if (
    error.code === 'network_error' ||
    error.code === 'timeout' ||
    error.code === 'rate_limited' ||
    (error.code === 'unknown' &&
      error.status !== undefined &&
      error.status >= 500 &&
      error.status !== 501)
  )
    return new TransportError({ operation, code: error.code });
  // Missing/gone streams and unsupported CAS are not uncertain network delivery.
  // Never copy server bodies/messages (which may contain secrets) into diagnostics.
  return new StreamProtocolError({ code: `epoch-stream-${error.code}` });
}

const validOffset = (offset: string) =>
  offset.length > 0 && offset.length <= 1024 && offset !== 'now';

/** The application selects/authenticates the stream. No implicit create or fallback append.
 * SDK Result failures are typed; unexpected rejected Promises remain defects.
 */
export function streamsEpochLayer(client: Pick<StreamsClient, 'read' | 'appendCas'>) {
  return Layer.succeed(
    EpochStream,
    EpochStream.of({
      read: (offset) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise((signal) => client.read({ offset, signal }));
          if (!response.ok) return yield* Effect.fail(failure(response.result, 'read'));
          const page = response.result;
          if (
            page.payload.contentType.split(';')[0]?.trim().toLowerCase() !==
            'application/octet-stream'
          )
            return yield* Effect.fail(
              new StreamProtocolError({ code: 'epoch-stream-content-type' })
            );
          return {
            requestOffset: page.requestOffset,
            nextOffset: page.nextOffset,
            upToDate: page.upToDate,
            body: new Uint8Array(page.payload.body),
          };
        }),
      append: (offset, bytes) => {
        const owned = new Uint8Array(bytes);
        return Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            client.appendCas({
              expectedOffset: offset,
              part: { contentType: 'application/octet-stream', body: new Uint8Array(owned) },
            })
          );
          if (!response.ok) return yield* Effect.fail(failure(response.result, 'append'));
          const result = response.result;
          if (result.kind === 'mismatch') {
            if (result.expectedOffset !== offset || !validOffset(result.currentOffset))
              return yield* Effect.fail(
                new StreamProtocolError({ code: 'epoch-stream-cas-offset' })
              );
            return 'conflict' as const;
          }
          if (
            !validOffset(result.value.nextOffset) ||
            result.value.nextOffset === offset ||
            result.value.nextOffset === '-1'
          )
            return yield* Effect.fail(new StreamProtocolError({ code: 'epoch-stream-cas-offset' }));
          return 'accepted' as const;
        });
      },
    })
  );
}
