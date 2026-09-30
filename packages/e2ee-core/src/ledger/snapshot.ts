/** Legacy throwing names; snapshot computation is implemented only in pure/. */
import * as pure from '../pure/ledger-snapshot';
import type { InternalState } from '../pure/ledger-state';
import { unwrap } from './compat';
export * from '../pure/ledger-snapshot';
export { headAttestationSigningBytes, snapshotSigningBytes } from './crypto';

export const encodeSnapshotBody = (state: InternalState, signer: Uint8Array) =>
  unwrap(pure.encodeSnapshotBody(state, signer));
export const digestBodyBytes = (state: InternalState) => unwrap(pure.digestBodyBytes(state));
export const stateDigestOf = (state: InternalState) => unwrap(pure.stateDigestOf(state));
export const encodeSignedSnapshot = (bodyBytes: Uint8Array, signature: Uint8Array) =>
  unwrap(pure.encodeSignedSnapshot(bodyBytes, signature));
export const assertEndorserEligible = (state: InternalState, signer: Uint8Array) =>
  unwrap(pure.assertEndorserEligible(state, signer));
export const parseSignedSnapshot = (bytes: Uint8Array) => unwrap(pure.parseSignedSnapshot(bytes));
export const snapshotStateFromParsed = (parsed: ReturnType<typeof parseSignedSnapshot>) =>
  unwrap(pure.snapshotStateFromParsed(parsed));
export const decodeSignedSnapshot = (bytes: Uint8Array) => unwrap(pure.decodeSignedSnapshot(bytes));
