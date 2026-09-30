/** Legacy throwing names; the only schema implementation is pure. */
import * as pure from '../pure/ledger-schema';
import type {
  Body,
  DecodedRecord,
  DeviceKind,
  GenesisFields,
  JoinRequest,
  OrdinaryFields,
} from '../pure/ledger-schema';
import { unwrap } from './compat';
export * from '../pure/ledger-schema';

export function joinRequestSigningBytes(
  genesis: Uint8Array,
  request: Omit<JoinRequest, 'signature'>
): Uint8Array {
  return unwrap(pure.joinRequestSigningBytes(genesis, request));
}
export function possessionSigningBytes(input: {
  genesis: Uint8Array;
  targetMembershipId: Uint8Array;
  signingPublicKey: Uint8Array;
  encryptionPublicKey: Uint8Array;
  kind: DeviceKind;
}): Uint8Array {
  return unwrap(pure.possessionSigningBytes(input));
}
export function encodeGenesisBody(fields: GenesisFields): Uint8Array {
  return unwrap(pure.encodeGenesisBody(fields));
}
export function encodeOrdinaryBody(fields: OrdinaryFields): Uint8Array {
  return unwrap(pure.encodeOrdinaryBody(fields));
}
export function encodeSignedRecord(bodyBytes: Uint8Array, signature: Uint8Array): Uint8Array {
  return unwrap(pure.encodeSignedRecord(bodyBytes, signature));
}
export function signingBytesForBody(bodyBytes: Uint8Array): Uint8Array {
  return unwrap(pure.signingBytesForBody(bodyBytes));
}
export function decodeRecord(recordBytes: Uint8Array): DecodedRecord {
  return unwrap(pure.decodeRecord(recordBytes));
}
export function encodeRecord(body: Body, signature: Uint8Array): Uint8Array {
  return unwrap(pure.encodeRecord(body, signature));
}
