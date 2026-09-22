import { decode, encode } from '@ipld/dag-cbor';
import { Either } from 'effect';
import { ValidationError } from './errors';
import type { LedgerErrorCode } from './errors';

export const MAX_RECORD_BYTES = 8192;
export const MAX_DEPTH = 8;
export const MAX_ARRAY_LENGTH = 32;
export const MAX_BSTR_BYTES = 256;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_SNAPSHOT_ARRAY_LENGTH = 16_384;
export type CborValue = null | boolean | number | Uint8Array | readonly CborValue[];
type Result<A> = Either.Either<A, ValidationError>;
const invalid = (code: LedgerErrorCode): Result<never> =>
  Either.left(new ValidationError({ code }));

export const copyBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function asPlain(value: unknown, depth: number, maxArray: number): Result<CborValue> {
  if (depth > MAX_DEPTH) return invalid('nesting');
  if (value === null || value === true || value === false) return Either.right(value);
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? Either.right(value) : invalid('canonical');
  }
  if (value instanceof Uint8Array) {
    return value.byteLength <= MAX_BSTR_BYTES
      ? Either.right(copyBytes(value))
      : invalid('oversize');
  }
  if (Array.isArray(value)) {
    if (value.length > maxArray) return invalid('oversize');
    const result: CborValue[] = [];
    for (const item of value) {
      const parsed = asPlain(item, depth + 1, maxArray);
      if (Either.isLeft(parsed)) return parsed;
      result.push(parsed.right);
    }
    return Either.right(result);
  }
  return invalid('canonical');
}

function decodingError(error: unknown): ValidationError {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('too many') || message.includes('extra') || message.includes('trailing')) {
    return new ValidationError({ code: 'trailing' });
  }
  if (
    message.includes('not enough') ||
    message.includes('unexpected') ||
    message.includes('end of') ||
    message.includes('too short')
  ) {
    return new ValidationError({ code: 'truncated' });
  }
  return new ValidationError({ code: 'canonical' });
}

function decodeBounded(input: unknown, maxBytes: number, maxArray: number): Result<CborValue> {
  return Either.gen(function* () {
    if (!(input instanceof Uint8Array)) return yield* invalid('canonical');
    if (input.byteLength === 0) return yield* invalid('truncated');
    if (input.byteLength > maxBytes) return yield* invalid('oversize');
    const stable = copyBytes(input);
    const decoded: unknown = yield* Either.try({ try: () => decode(stable), catch: decodingError });
    const encoded = yield* Either.try({
      try: () => encode(decoded),
      catch: () => new ValidationError({ code: 'canonical' }),
    });
    if (!bytesEqual(encoded, stable)) {
      if (
        stable.byteLength > encoded.byteLength &&
        bytesEqual(encoded, stable.subarray(0, encoded.byteLength))
      ) {
        return yield* invalid('trailing');
      }
      return yield* invalid('canonical');
    }
    return yield* asPlain(decoded, 0, maxArray);
  });
}

export const decodeCbor = (input: unknown): Result<CborValue> =>
  decodeBounded(input, MAX_RECORD_BYTES, MAX_ARRAY_LENGTH);
export const decodeSnapshotCbor = (input: unknown): Result<CborValue> =>
  decodeBounded(input, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_ARRAY_LENGTH);

function encodeBounded(value: CborValue, maxBytes: number): Result<Uint8Array<ArrayBuffer>> {
  return Either.gen(function* () {
    const bytes = yield* Either.try({
      try: () => copyBytes(encode(value)),
      catch: () => new ValidationError({ code: 'canonical' }),
    });
    if (bytes.byteLength > maxBytes) return yield* invalid('oversize');
    return bytes;
  });
}

export const encodeCanonical = (value: CborValue) => encodeBounded(value, MAX_RECORD_BYTES);
export const encodeCbor = (value: CborValue): Result<Uint8Array<ArrayBuffer>> =>
  Either.gen(function* () {
    const bytes = yield* encodeCanonical(value);
    yield* decodeCbor(bytes);
    return bytes;
  });
export const encodeSnapshotCbor = (value: CborValue): Result<Uint8Array<ArrayBuffer>> =>
  Either.gen(function* () {
    const bytes = yield* encodeBounded(value, MAX_SNAPSHOT_BYTES);
    yield* decodeSnapshotCbor(bytes);
    return bytes;
  });

export function asArray(
  value: CborValue,
  code: LedgerErrorCode = 'canonical'
): Result<readonly CborValue[]> {
  return Array.isArray(value) ? Either.right(value) : invalid(code);
}
export function asUint(value: CborValue, code: LedgerErrorCode = 'canonical'): Result<number> {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Either.right(value)
    : invalid(code);
}
export function asBool(value: CborValue, code: LedgerErrorCode = 'canonical'): Result<boolean> {
  return value === true || value === false ? Either.right(value) : invalid(code);
}
export function asExactBytes(
  value: CborValue,
  length: number,
  code: LedgerErrorCode = 'canonical'
): Result<Uint8Array> {
  return value instanceof Uint8Array && value.byteLength === length
    ? Either.right(copyBytes(value))
    : invalid(code);
}
export function asNullOrUint(value: CborValue): Result<number | null> {
  return value === null ? Either.right(null) : asUint(value);
}
