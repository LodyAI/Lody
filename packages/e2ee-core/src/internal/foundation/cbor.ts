import { decode, encode } from '@ipld/dag-cbor';
import { Result } from 'effect';
import { ValidationError } from './errors';
import type { ValidationErrorCode } from './errors';

export const MAX_RECORD_BYTES = 8192;
export const MAX_DEPTH = 8;
export const MAX_ARRAY_LENGTH = 32;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
/** Per byte string in a record. Snapshot and retained state carry whole fixed-width tables as single byte strings, bounded only by their total budget. */
export const MAX_BSTR_BYTES = 256;
/** Values accepted by the bounded canonical CBOR codec: integers, byte strings, text, booleans, null and arrays of these. */
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

function asPlain(
  value: unknown,
  depth: number,
  maxArray: number,
  maxBstr: number
): Result<CborValue> {
  if (depth > MAX_DEPTH) return invalid('nesting');
  if (value === null || value === true || value === false) return Result.succeed(value);
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? Result.succeed(value) : invalid('canonical');
  }
  if (value instanceof Uint8Array) {
    return value.byteLength <= maxBstr ? Result.succeed(copyBytes(value)) : invalid('oversize');
  }
  if (Array.isArray(value)) {
    if (value.length > maxArray) return invalid('oversize');
    const result: CborValue[] = [];
    for (const item of value) {
      const parsed = asPlain(item, depth + 1, maxArray, maxBstr);
      if (Result.isFailure(parsed)) return parsed;
      result.push(parsed.success);
    }
    return Result.succeed(result);
  }
  return invalid('canonical');
}

/*
 * Fast paths for the plain canonical subset ledger bytes use: minimal-head
 * unsigned safe integers, byte strings within the codec's limit, definite arrays,
 * false, true and null, within the depth and array bounds. They decide nothing:
 * whatever they do not produce goes through the dag-cbor path below, which
 * alone rejects input and chooses the error code. Every value they produce is
 * the one that path produces (test/cbor-fast-path.test.ts).
 */
// Smallest value each head size may carry (shortest form). Plain branches and a
// DataView keep this valid under consumers' noUncheckedIndexedAccess as well.
const minimumFor = (size: number) =>
  size === 0 ? 24 : size === 1 ? 0x100 : size === 2 ? 0x10000 : 0x1_0000_0000;
function decodePlain(bytes: Uint8Array, maxArray: number, maxBstr: number): CborValue | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const argument = (info: number): number | undefined => {
    if (info < 24) return info;
    const size = info - 24;
    if (size > 3) return undefined;
    const length = 1 << size;
    if (at + length > bytes.length) return undefined;
    let value = 0;
    for (let i = 0; i < length; i++) value = value * 256 + view.getUint8(at++);
    return value >= minimumFor(size) && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
  };
  const item = (depth: number): CborValue | undefined => {
    if (depth > MAX_DEPTH || at >= bytes.length) return undefined;
    const initial = view.getUint8(at++);
    const major = initial >> 5;
    if (major === 7)
      return initial === 0xf4
        ? false
        : initial === 0xf5
          ? true
          : initial === 0xf6
            ? null
            : undefined;
    const value = argument(initial & 31);
    if (value === undefined) return undefined;
    if (major === 0) return value;
    if (major === 2) {
      if (value > maxBstr || at + value > bytes.length) return undefined;
      at += value;
      return bytes.slice(at - value, at);
    }
    if (major !== 4 || value > maxArray) return undefined;
    const items: CborValue[] = [];
    for (let i = 0; i < value; i++) {
      const next = item(depth + 1);
      if (next === undefined) return undefined;
      items.push(next);
    }
    return items;
  };
  const value = item(0);
  return at === bytes.length ? value : undefined;
}

function encodePlain(
  value: CborValue,
  maxBytes: number,
  maxArray: number,
  maxBstr: number
): Uint8Array<ArrayBuffer> | undefined {
  let out = new Uint8Array(256);
  let size = 0;
  const reserve = (more: number) => {
    if (size + more > maxBytes) return false;
    if (size + more > out.length) {
      const grown = new Uint8Array(Math.min(maxBytes, Math.max(out.length * 2, size + more)));
      grown.set(out.subarray(0, size));
      out = grown;
    }
    return true;
  };
  const head = (major: number, n: number) => {
    const length = n < 24 ? 0 : n <= 0xff ? 1 : n <= 0xffff ? 2 : n <= 0xffffffff ? 4 : 8;
    if (!reserve(1 + length)) return false;
    out[size++] = (major << 5) | (length === 0 ? n : 23 + Math.log2(length) + 1);
    for (let i = length - 1; i >= 0; i--) out[size++] = Math.floor(n / 2 ** (8 * i)) % 256;
    return true;
  };
  const write = (item: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    if (item === null || item === true || item === false) {
      if (!reserve(1)) return false;
      out[size++] = item === null ? 0xf6 : item ? 0xf5 : 0xf4;
      return true;
    }
    if (typeof item === 'number') return Number.isSafeInteger(item) && item >= 0 && head(0, item);
    if (item instanceof Uint8Array) {
      const length = item.byteLength;
      if (length > maxBstr || !head(2, length) || !reserve(length)) return false;
      out.set(item, size);
      size += length;
      return true;
    }
    if (!Array.isArray(item)) return false;
    const length = item.length;
    if (length > maxArray || !head(4, length)) return false;
    for (let i = 0; i < length; i++) if (!write(item[i], depth + 1)) return false;
    return true;
  };
  return write(value, 0) ? out.slice(0, size) : undefined;
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

function decodeBounded(
  input: unknown,
  maxBytes: number,
  maxArray: number,
  maxBstr = MAX_BSTR_BYTES,
  fast = true
): Result<CborValue> {
  return Result.gen(function* () {
    if (!(input instanceof Uint8Array)) return yield* invalid('canonical');
    if (input.byteLength === 0) return yield* invalid('truncated');
    if (input.byteLength > maxBytes) return yield* invalid('oversize');
    const stable = copyBytes(input);
    const plain = fast ? decodePlain(stable, maxArray, maxBstr) : undefined;
    if (plain !== undefined) return plain;
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
    return yield* asPlain(decoded, 0, maxArray, maxBstr);
  });
}

/** Decode canonical bounded CBOR. Rejects non-canonical, truncated or trailing input with `ValidationError`. */
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
function prepareEncoding(
  value: CborValue,
  maxBytes: number,
  maxArray = MAX_ARRAY_LENGTH,
  maxBstr = MAX_BSTR_BYTES
): Result<CborValue> {
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
      if (length > maxBstr || !charge(headerSize(length) - 1 + length)) {
        return invalid('oversize');
      }
      return Result.succeed(copyBytes(item));
    }
    if (Array.isArray(item)) {
      const length = item.length;
      if (length > maxArray || !charge(headerSize(length) - 1)) {
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

function encodeBounded(
  value: CborValue,
  maxBytes: number,
  maxArray = MAX_ARRAY_LENGTH,
  maxBstr = MAX_BSTR_BYTES,
  fast = true
): Result<Uint8Array<ArrayBuffer>> {
  const plain = fast ? encodePlain(value, maxBytes, maxArray, maxBstr) : undefined;
  if (plain !== undefined) return Result.succeed(plain);
  return Result.gen(function* () {
    const prepared = yield* Result.try({
      try: () => prepareEncoding(value, maxBytes, maxArray, maxBstr),
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
/** Encode a `CborValue` as canonical CBOR, budgeting expanded size before serializing; fails on cycles or oversize input. */
export const encodeCbor = (value: CborValue): Result<Uint8Array<ArrayBuffer>> =>
  Result.gen(function* () {
    const bytes = yield* encodeCanonical(value);
    yield* decodeCbor(bytes);
    return bytes;
  });

/** Independent business-policy budget; it never widens ledger record limits. */
export const decodeMachineSharingCbor = (input: unknown): Result<CborValue> =>
  decodeBounded(input, 256 * 1024, 4096, 256);
export const encodeMachineSharingCbor = (value: CborValue): Result<Uint8Array<ArrayBuffer>> =>
  encodeBounded(value, 256 * 1024, 4096, 256);

/** Separate fixed snapshot budget; ordinary record limits remain unchanged. Its state is a few arrays of byte-string tables. */
export const decodeSnapshotCbor = (input: unknown): Result<CborValue> =>
  decodeBounded(input, MAX_SNAPSHOT_BYTES, MAX_ARRAY_LENGTH, MAX_SNAPSHOT_BYTES);
/** A party's own retained ledger state (never exchanged): a larger budget than an endorsed snapshot. */
export const MAX_RETAINED_STATE_BYTES = 16 * 1024 * 1024;
export const decodeRetainedCbor = (input: unknown): Result<CborValue> =>
  decodeBounded(input, MAX_RETAINED_STATE_BYTES, MAX_ARRAY_LENGTH, MAX_RETAINED_STATE_BYTES);
export const encodeRetainedCbor = (value: CborValue): Result<Uint8Array<ArrayBuffer>> =>
  encodeBounded(value, MAX_RETAINED_STATE_BYTES, MAX_ARRAY_LENGTH, MAX_RETAINED_STATE_BYTES);
export const encodeSnapshotCbor = (value: CborValue): Result<Uint8Array<ArrayBuffer>> =>
  Result.gen(function* () {
    const bytes = yield* encodeBounded(
      value,
      MAX_SNAPSHOT_BYTES,
      MAX_ARRAY_LENGTH,
      MAX_SNAPSHOT_BYTES
    );
    yield* decodeSnapshotCbor(bytes);
    return bytes;
  });

/** Tests only: the dag-cbor paths the fast paths must agree with. */
export const referenceCodec = {
  decode: (input: unknown, maxBytes: number, maxArray: number, maxBstr = MAX_BSTR_BYTES) =>
    decodeBounded(input, maxBytes, maxArray, maxBstr, false),
  encode: (value: CborValue, maxBytes: number, maxArray: number, maxBstr = MAX_BSTR_BYTES) =>
    encodeBounded(value, maxBytes, maxArray, maxBstr, false),
};
