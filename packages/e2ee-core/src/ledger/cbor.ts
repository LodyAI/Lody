import { decode, encode } from '@ipld/dag-cbor';
import { fail, type LedgerErrorCode } from './error';

export const MAX_RECORD_BYTES = 8192;
export const MAX_DEPTH = 8;
export const MAX_ARRAY_LENGTH = 32;
export const MAX_BSTR_BYTES = 256;

export type CborValue = null | boolean | number | Uint8Array | readonly CborValue[];

export function copyBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function asPlain(value: unknown, depth: number): CborValue {
  if (depth > MAX_DEPTH) fail('nesting');
  if (value === null || value === true || value === false) return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail('canonical');
    return value;
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_BSTR_BYTES) fail('oversize');
    return copyBytes(value);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) fail('oversize');
    return value.map((item) => asPlain(item, depth + 1));
  }
  fail('canonical');
}

export function decodeCbor(bytes: Uint8Array, owned = false): CborValue {
  if (bytes.byteLength === 0) fail('truncated');
  if (bytes.byteLength > MAX_RECORD_BYTES) fail('oversize');
  const stable = owned ? bytes : copyBytes(bytes);
  let decoded: unknown;
  try {
    decoded = decode(stable);
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (message.includes('too many') || message.includes('extra') || message.includes('trailing')) {
      fail('trailing');
    }
    if (
      message.includes('not enough') ||
      message.includes('unexpected') ||
      message.includes('end of') ||
      message.includes('too short')
    ) {
      fail('truncated');
    }
    fail('canonical');
  }
  let encoded: Uint8Array;
  try {
    encoded = encode(decoded);
  } catch {
    fail('canonical');
  }
  if (!bytesEqual(encoded, stable)) {
    if (
      stable.byteLength > encoded.byteLength &&
      bytesEqual(encoded, stable.subarray(0, encoded.byteLength))
    ) {
      fail('trailing');
    }
    fail('canonical');
  }
  return asPlain(decoded, 0);
}

export function encodeCanonical(value: CborValue): Uint8Array<ArrayBuffer> {
  const bytes = copyBytes(encode(value));
  if (bytes.byteLength > MAX_RECORD_BYTES) fail('oversize');
  return bytes;
}

export function encodeCbor(value: CborValue): Uint8Array<ArrayBuffer> {
  const bytes = encodeCanonical(value);
  decodeCbor(bytes, true);
  return bytes;
}

export function asArray(
  value: CborValue,
  code: LedgerErrorCode = 'canonical'
): readonly CborValue[] {
  if (!Array.isArray(value)) fail(code);
  return value;
}

export function asUint(value: CborValue, code: LedgerErrorCode = 'canonical'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

export function asBool(value: CborValue, code: LedgerErrorCode = 'canonical'): boolean {
  if (value !== true && value !== false) fail(code);
  return value;
}

export function asExactBytes(
  value: CborValue,
  length: number,
  code: LedgerErrorCode = 'canonical'
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) fail(code);
  return copyBytes(value);
}

export function asNullOrUint(value: CborValue): number | null {
  if (value === null) return null;
  return asUint(value);
}
