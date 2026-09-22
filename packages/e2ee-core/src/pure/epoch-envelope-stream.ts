import { Either } from 'effect';
import { decodeCbor, copyBytes } from './cbor';
import { epochNumber, type DeliveryId } from './bytes';
import { ValidationError } from './errors';
import { concat } from './wire-crypto';
import { unverifiedEpochDeliveryId } from './key-delivery';

/** Raw existing envelopes: canonical CBOR AAD followed by enc(32), ct(48), sig(64).
 * Routing metadata only: neither these bytes nor their delivery ID are authenticated.
 * A transport page may split anywhere, including inside the CBOR header.
 */
export function parseEpochEnvelopeChunk(tail: Uint8Array, chunk: Uint8Array) {
  return Either.gen(function* () {
    if (tail.length > 251 || chunk.length > 2 * 1024 * 1024)
      return yield* Either.left(new ValidationError({ code: 'oversize' }));
    const bytes = concat([tail, chunk]);
    const frames: { readonly bytes: Uint8Array; readonly deliveryId: DeliveryId }[] = [];
    let cursor = 0;
    while (cursor < bytes.length) {
      if (bytes[cursor] !== 0x84)
        return yield* Either.left(new ValidationError({ code: 'canonical' }));
      if (bytes.length - cursor < 36) break;
      // The first field is exactly a 32-byte genesis hash.
      if (bytes[cursor + 1] !== 0x58 || bytes[cursor + 2] !== 0x20)
        return yield* Either.left(new ValidationError({ code: 'canonical' }));
      const marker = bytes[cursor + 35];
      const width =
        marker !== undefined && marker < 24
          ? 1
          : marker === 0x18
            ? 2
            : marker === 0x19
              ? 3
              : marker === 0x1a
                ? 5
                : 0;
      if (width === 0) return yield* Either.left(new ValidationError({ code: 'canonical' }));
      const aadLength = 103 + width;
      if (bytes.length - cursor < aadLength) break;
      const aad = yield* decodeCbor(bytes.subarray(cursor, cursor + aadLength));
      if (!Array.isArray(aad) || aad.length !== 4)
        return yield* Either.left(new ValidationError({ code: 'canonical' }));
      const [genesis, , sender, recipient] = aad;
      if (
        !(genesis instanceof Uint8Array) ||
        !(sender instanceof Uint8Array) ||
        !(recipient instanceof Uint8Array)
      )
        return yield* Either.left(new ValidationError({ code: 'canonical' }));
      const epoch = yield* epochNumber(aad[1]);
      const id = yield* unverifiedEpochDeliveryId(genesis, epoch, sender, recipient);
      const length = aadLength + 144;
      if (bytes.length - cursor < length) break;
      frames.push({
        bytes: copyBytes(bytes.subarray(cursor, cursor + length)),
        deliveryId: id,
      });
      cursor += length;
    }
    return { frames, tail: copyBytes(bytes.subarray(cursor)) };
  });
}
