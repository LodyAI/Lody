import { Either } from 'effect';
import { epochNumber } from './bytes';
import { bytesEqual } from './cbor';
import { ValidationError } from './errors';
import { keyId } from './identifiers';

/** Existing Lab epochs.json format, not evidence of authority or correct Org binding. */
export function decodeEpochKeyring(text: string) {
  return Either.gen(function* () {
    const rows: unknown = yield* Either.try({
      try: (): unknown => JSON.parse(text),
      catch: () => new ValidationError({ code: 'canonical' }),
    });
    if (!Array.isArray(rows)) return yield* Either.left(new ValidationError({ code: 'canonical' }));
    const keys = new Map<number, Uint8Array>();
    for (const row of rows) {
      if (
        !Array.isArray(row) ||
        row.length !== 2 ||
        typeof row[1] !== 'string' ||
        !/^[0-9a-f]{64}$/.test(row[1])
      )
        return yield* Either.left(new ValidationError({ code: 'canonical' }));
      const epoch = yield* epochNumber(row[0]);
      if (keys.has(epoch)) return yield* Either.left(new ValidationError({ code: 'replay' }));
      const secret = new Uint8Array(32);
      for (let i = 0; i < 32; i++) secret[i] = Number.parseInt(row[1].slice(i * 2, i * 2 + 2), 16);
      keys.set(epoch, secret);
    }
    return keys;
  });
}

/** Same order/newline as the old writer. Existing slots cannot be silently replaced. */
export function installEpochKey(text: string, epoch: number, secret: Uint8Array) {
  return Either.gen(function* () {
    yield* epochNumber(epoch);
    if (secret.length !== 32)
      return yield* Either.left(new ValidationError({ code: 'invalid-key' }));
    const keys = yield* decodeEpochKeyring(text);
    const existing = keys.get(epoch);
    if (existing)
      return bytesEqual(existing, secret)
        ? text
        : yield* Either.left(new ValidationError({ code: 'replay' }));
    keys.set(epoch, new Uint8Array(secret));
    return `${JSON.stringify([...keys].map(([number, key]) => [number, keyId(key)]))}\n`;
  });
}
