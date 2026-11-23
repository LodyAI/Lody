import { Result } from 'effect';
import { LedgerError } from './errors';

const encoder = new TextEncoder();
// Keep a leading BOM as an identity byte sequence; do not strip or normalize it.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const invalid = () => Result.fail(new LedgerError({ code: 'canonical' }));

/** Strict, non-normalizing UTF-8 identity. Decoding never repairs malformed bytes. */
export function decodeMachineId(value: unknown): Result.Result<string, LedgerError> {
  if (!(value instanceof Uint8Array) || value.length < 1 || value.length > 256) return invalid();
  return Result.try({
    try: () => decoder.decode(value),
    catch: () => new LedgerError({ code: 'canonical' }),
  });
}

/** Own the exact UTF-8 bytes; reject lone UTF-16 surrogates rather than replacing them. */
export function encodeMachineId(value: unknown): Result.Result<Uint8Array, LedgerError> {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) return invalid();
  // Own encoder output in this realm (native encoders can return a foreign-realm view).
  const bytes = Uint8Array.from(encoder.encode(value));
  return Result.flatMap(decodeMachineId(bytes), (decoded) =>
    decoded === value ? Result.succeed(bytes) : invalid()
  );
}
