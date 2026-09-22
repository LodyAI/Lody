import { Either } from 'effect';
import { ValidationError } from './errors';
import { keyId } from './identifiers';
import { checkDeliveryId, selectDeliveryFrame } from './key-delivery';

const FORMAT = 'lody-e2ee-key-outbox/v0';
const MAX_BYTES = 32 * 1024 * 1024;

export function encodeKeyOutbox(frames: ReadonlyMap<string, Uint8Array>) {
  return Either.gen(function* () {
    if (frames.size > 4096) return yield* Either.left(new ValidationError({ code: 'oversize' }));
    const rows = [...frames.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [id, frame] of rows) {
      yield* checkDeliveryId(id);
      if (frame.byteLength === 0 || frame.byteLength > 1024)
        return yield* Either.left(new ValidationError({ code: 'oversize' }));
    }
    const text = JSON.stringify([FORMAT, rows.map(([id, frame]) => [id, keyId(frame)])]);
    // All encoded characters are ASCII.
    return text.length > MAX_BYTES
      ? yield* Either.left(new ValidationError({ code: 'oversize' }))
      : text;
  });
}

export function decodeKeyOutbox(text: string) {
  return Either.gen(function* () {
    if (typeof text !== 'string' || text.length > MAX_BYTES)
      return yield* Either.left(new ValidationError({ code: 'oversize' }));
    const parsed: unknown = yield* Either.try({
      try: (): unknown => JSON.parse(text),
      catch: () => new ValidationError({ code: 'canonical' }),
    });
    if (!Array.isArray(parsed) || parsed.length !== 2)
      return yield* Either.left(new ValidationError({ code: 'canonical' }));
    if (parsed[0] !== FORMAT)
      return yield* Either.left(new ValidationError({ code: 'unknown-version' }));
    const rows: unknown = parsed[1];
    if (!Array.isArray(rows)) return yield* Either.left(new ValidationError({ code: 'canonical' }));
    if (rows.length > 4096) return yield* Either.left(new ValidationError({ code: 'oversize' }));
    const frames = new Map<string, Uint8Array>();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string')
        return yield* Either.left(new ValidationError({ code: 'canonical' }));
      const id = yield* checkDeliveryId(row[0]);
      const hex: unknown = row[1];
      if (frames.has(id) || typeof hex !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(hex))
        return yield* Either.left(new ValidationError({ code: 'canonical' }));
      if (hex.length > 2048) return yield* Either.left(new ValidationError({ code: 'oversize' }));
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++)
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      frames.set(id, bytes);
    }
    if ((yield* encodeKeyOutbox(frames)) !== text)
      return yield* Either.left(new ValidationError({ code: 'canonical' }));
    return frames;
  });
}

/** Computes a new payload without mutating the loaded outbox. */
export function saveOutboxFrame(text: string | null, id: string, bytes: Uint8Array) {
  return Either.gen(function* () {
    yield* checkDeliveryId(id);
    const frames = text === null ? new Map<string, Uint8Array>() : yield* decodeKeyOutbox(text);
    frames.set(id, yield* selectDeliveryFrame(frames.get(id) ?? null, bytes));
    return yield* encodeKeyOutbox(frames);
  });
}
