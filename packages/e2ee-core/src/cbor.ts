import { decode, encode } from '@ipld/dag-cbor';
import { Result } from 'effect';
import { ValidationError } from './errors';
import type { ValidationErrorCode } from './errors';

export const MAX_RECORD_BYTES = 8192;
export const MAX_DEPTH = 8;
export const MAX_ARRAY_LENGTH = 32;
export const MAX_BSTR_BYTES = 256;
export type CborValue = null | boolean | number | Uint8Array | readonly CborValue[];
type Result<A> = Result.Result<A, ValidationError>;
const invalid = (code: ValidationErrorCode): Result<never> =>
  Result.fail(new ValidationError({ code }));

export const copyBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function asPlain(value: unknown, depth: number, maxArray: number): Result<CborValue> {
  if (depth > MAX_DEPTH) return invalid('nesting');
  if (value === null || value === true || value === false) return Result.succeed(value);
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? Result.succeed(value) : invalid('canonical');
  }
  if (value instanceof Uint8Array) {
    return value.byteLength <= MAX_BSTR_BYTES
      ? Result.succeed(copyBytes(value))
      : invalid('oversize');
  }
  if (Array.isArray(value)) {
    if (value.length > maxArray) return invalid('oversize');
    const result: CborValue[] = [];
    for (const item of value) {
      const parsed = asPlain(item, depth + 1, maxArray);
      if (Result.isFailure(parsed)) return parsed;
      result.push(parsed.success);
    }
    return Result.succeed(result);
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
  return Result.gen(function* () {
    if (!(input instanceof Uint8Array)) return yield* invalid('canonical');
    if (input.byteLength === 0) return yield* invalid('truncated');
    if (input.byteLength > maxBytes) return yield* invalid('oversize');
    const stable = copyBytes(input);
    const decoded: unknown = yield* Result.try({ try: () => decode(stable), catch: decodingError });
    const encoded = yield* Result.try({
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

function headerSize(value: number): number {
  if (value < 24) return 1;
  if (value <= 0xff) return 2;
  if (value <= 0xffff) return 3;
  if (value <= 0xffffffff) return 5;
  return 9;
}

// Charge each occurrence before copying it. A shared subtree costs its expanded
// wire size, not its object count; every visited item consumes at least one byte.
// Encode the bounded snapshot so input accessors cannot change it after checking.
function prepareEncoding(value: CborValue, maxBytes: number): Result<CborValue> {
  let remaining = maxBytes;
  const ancestors = new Set<readonly CborValue[]>();
  const charge = (size: number): boolean => {
    remaining -= size;
    return remaining >= 0;
  };
  const visit = (item: unknown, depth: number): Result<CborValue> => {
    if (depth > MAX_DEPTH) return invalid('nesting');
    if (!charge(1)) return invalid('oversize');
    if (item === null || item === true || item === false) return Result.succeed(item);
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || item < 0) return invalid('canonical');
      return charge(headerSize(item) - 1) ? Result.succeed(item) : invalid('oversize');
    }
    if (item instanceof Uint8Array) {
      const length = item.byteLength;
      if (length > MAX_BSTR_BYTES || !charge(headerSize(length) - 1 + length)) {
        return invalid('oversize');
      }
      return Result.succeed(copyBytes(item));
    }
    if (Array.isArray(item)) {
      const length = item.length;
      if (length > MAX_ARRAY_LENGTH || !charge(headerSize(length) - 1)) {
        return invalid('oversize');
      }
      if (ancestors.has(item)) return invalid('canonical');
      ancestors.add(item);
      const result: CborValue[] = [];
      for (let i = 0; i < length; i++) {
        const parsed = visit(item[i], depth + 1);
        if (Result.isFailure(parsed)) return parsed;
        result.push(parsed.success);
      }
      ancestors.delete(item);
      return Result.succeed(result);
    }
    return invalid('canonical');
  };
  return visit(value, 0);
}

function encodeBounded(value: CborValue, maxBytes: number): Result<Uint8Array<ArrayBuffer>> {
  return Result.gen(function* () {
    const prepared = yield* Result.try({
      try: () => prepareEncoding(value, maxBytes),
      catch: () => new ValidationError({ code: 'canonical' }),
    });
    const stable = yield* prepared;
    const bytes = yield* Result.try({
      try: () => copyBytes(encode(stable)),
      catch: () => new ValidationError({ code: 'canonical' }),
    });
    if (bytes.byteLength > maxBytes) return yield* invalid('oversize');
    return bytes;
  });
}

export const encodeCanonical = (value: CborValue) => encodeBounded(value, MAX_RECORD_BYTES);
export const encodeCbor = (value: CborValue): Result<Uint8Array<ArrayBuffer>> =>
  Result.gen(function* () {
    const bytes = yield* encodeCanonical(value);
    yield* decodeCbor(bytes);
    return bytes;
  });
