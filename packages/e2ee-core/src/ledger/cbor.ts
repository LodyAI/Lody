/** Legacy throwing names over pure/cbor. */
import * as Pure from '../pure/cbor';
import { unwrap } from './compat';
import type { LedgerErrorCode } from './error';

export {
  copyBytes,
  bytesEqual,
  MAX_RECORD_BYTES,
  MAX_DEPTH,
  MAX_ARRAY_LENGTH,
  MAX_BSTR_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_ARRAY_LENGTH,
} from '../pure/cbor';
export type { CborValue } from '../pure/cbor';

export const decodeCbor = (bytes: Uint8Array, _owned = false): Pure.CborValue =>
  unwrap(Pure.decodeCbor(bytes));
export const decodeSnapshotCbor = (bytes: Uint8Array, _owned = false): Pure.CborValue =>
  unwrap(Pure.decodeSnapshotCbor(bytes));
export const encodeCanonical = (value: Pure.CborValue) => unwrap(Pure.encodeCanonical(value));
export const encodeCbor = (value: Pure.CborValue) => unwrap(Pure.encodeCbor(value));
export const encodeSnapshotCbor = (value: Pure.CborValue) => unwrap(Pure.encodeSnapshotCbor(value));
export const asArray = (value: Pure.CborValue, code: LedgerErrorCode = 'canonical') =>
  unwrap(Pure.asArray(value, code));
export const asUint = (value: Pure.CborValue, code: LedgerErrorCode = 'canonical') =>
  unwrap(Pure.asUint(value, code));
export const asBool = (value: Pure.CborValue, code: LedgerErrorCode = 'canonical') =>
  unwrap(Pure.asBool(value, code));
export const asExactBytes = (
  value: Pure.CborValue,
  length: number,
  code: LedgerErrorCode = 'canonical'
) => unwrap(Pure.asExactBytes(value, length, code));
export const asNullOrUint = (value: Pure.CborValue) => unwrap(Pure.asNullOrUint(value));
