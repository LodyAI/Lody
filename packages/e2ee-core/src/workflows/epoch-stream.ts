import { Effect, Layer } from 'effect';
import { EpochStream } from '../ports/epoch-stream';
import { KeyDeliveryRemote } from '../ports/key-delivery';
import { parseEpochEnvelopeChunk } from '../pure/epoch-envelope-stream';
import { checkDeliveryId } from '../pure/key-delivery';
import { keyId } from '../pure/identifiers';
import { StreamProtocolError, ValidationError } from '../pure/errors';
import { bytesEqual } from '../pure/cbor';

/** Bounded complete scan; finding a matching prefix is not successful catch-up.
 * This is routing/exact-byte observation, never signature or authority verification.
 */
function scan(stream: EpochStream['Type'], id: string) {
  return Effect.gen(function* () {
    let offset = '-1';
    let tail: Uint8Array = new Uint8Array();
    let found: Uint8Array | null = null;
    let total = 0;
    const visited = new Set<string>([offset]);
    for (let pageNumber = 0; pageNumber < 64; pageNumber++) {
      const page = yield* stream.read(offset);
      if (
        page.requestOffset !== offset ||
        page.nextOffset.length === 0 ||
        page.nextOffset.length > 1024 ||
        page.nextOffset === 'now' ||
        (page.nextOffset === '-1' && (page.body.length !== 0 || !page.upToDate)) ||
        (page.body.length !== 0 && visited.has(page.nextOffset)) ||
        (page.nextOffset !== offset && visited.has(page.nextOffset)) ||
        (!page.upToDate && (page.body.length === 0 || visited.has(page.nextOffset)))
      )
        return yield* Effect.fail(new StreamProtocolError({ code: 'epoch-stream-offset' }));
      total += page.body.length;
      if (total > 16 * 1024 * 1024)
        return yield* Effect.fail(new StreamProtocolError({ code: 'epoch-stream-read-limit' }));
      const parsed = yield* parseEpochEnvelopeChunk(tail, page.body);
      tail = parsed.tail;
      for (const frame of parsed.frames) {
        if (keyId(frame.deliveryId.toBytes()) !== id) continue;
        if (found !== null && !bytesEqual(found, frame.bytes))
          return yield* Effect.fail(new ValidationError({ code: 'replay' }));
        found = frame.bytes;
      }
      if (page.upToDate) {
        if (tail.length !== 0)
          return yield* Effect.fail(new ValidationError({ code: 'truncated' }));
        return { offset: page.nextOffset, found };
      }
      offset = page.nextOffset;
      visited.add(offset);
    }
    return yield* Effect.fail(new StreamProtocolError({ code: 'epoch-stream-page-limit' }));
  });
}

/** Preserves raw envelope bytes. CAS contention is reconciled by the outbox's
 * readback, not by regenerating a frame or silently retrying append.
 */
export const epochStreamDeliveryLayer = Layer.effect(
  KeyDeliveryRemote,
  Effect.gen(function* () {
    const stream = yield* EpochStream;
    return KeyDeliveryRemote.of({
      read: (id) =>
        Effect.gen(function* () {
          yield* checkDeliveryId(id);
          return (yield* scan(stream, id)).found;
        }).pipe(Effect.withSpan('e2ee.epoch-stream.read')),
      put: (id, bytes) => {
        const owned = new Uint8Array(bytes);
        return Effect.gen(function* () {
          yield* checkDeliveryId(id);
          const parsed = yield* parseEpochEnvelopeChunk(new Uint8Array(), owned);
          const frame = parsed.frames[0];
          if (
            parsed.tail.length !== 0 ||
            parsed.frames.length !== 1 ||
            frame === undefined ||
            keyId(frame.deliveryId.toBytes()) !== id
          )
            return yield* Effect.fail(new ValidationError({ code: 'invalid-operation' }));
          const state = yield* scan(stream, id);
          if (state.found !== null) {
            if (!bytesEqual(state.found, owned))
              return yield* Effect.fail(new ValidationError({ code: 'replay' }));
            return undefined;
          }
          if ((yield* stream.append(state.offset, owned)) === 'conflict')
            return 'conflict' as const;
          return undefined;
        }).pipe(Effect.withSpan('e2ee.epoch-stream.put'));
      },
    });
  })
);
