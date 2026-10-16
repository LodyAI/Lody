/**
 * UNSTABLE. Internal building blocks re-exported for this repository's tests
 * and the E2EE Lab. Not covered by any compatibility promise; anything here may
 * change or disappear in any release. Applications use `@lody/e2ee-core`,
 * `/services`, `/protocol`, `/host` or `/adapters/*` instead.
 *
 * @module
 */
export * from '../protocol';
export { makeAdmissionGate } from './lifecycle';
export { deliverEpochEnvelope } from './keys/delivery';
export { isHash, isBytes, fromHex, validSlot, validContext } from './keys/reports';
export { keyId } from './foundation/identifiers';
export {
  bytesEqual,
  decodeSnapshotCbor,
  encodeSnapshotCbor,
  MAX_RECORD_BYTES,
} from './foundation/cbor';
export { disposeEpochKey, copyEpochKeyBytes } from './foundation/epoch-key';
export {
  openSqliteStore,
  openSqliteConnection,
  makeSqliteLedgerPin,
} from '../adapters/node-sqlite/store';
export * from './testing';
export { createRecoveryVault, openRecoveryVault, openRecoveryVaultWithPasskey } from './recovery';
