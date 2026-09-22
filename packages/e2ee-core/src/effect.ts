/** Effect-native migration surface. Experimental; not product E2EE. */
export * as Bytes from './pure/bytes';
export type {
  SigningPublicKey,
  EncryptionPublicKey,
  Signature,
  GenesisHash,
  RecordHash,
  EpochCommitment,
  EpochKey,
  MembershipId,
  RequestId,
  DeliveryId,
  UserId,
  EpochNumber,
} from './pure/bytes';
export * as Cbor from './pure/cbor';
export * from './pure/errors';
export type { CreateLedgerCommand, LedgerCommand, DeviceGrant } from './pure/commands';
export type {
  DecodedRecord,
  SignatureCheckedRecord,
  ApplicableRecord,
  LedgerView,
} from './pure/records';
export { applyAuthorizedRecord } from './pure/records';
export {
  decodeRecord,
  verifyRecordSignature,
  verifyLedger,
  extendLedger,
  authorizeRecord,
} from './workflows/verification';
export { LedgerClient } from './workflows/ledger-client';
export { prepareDeviceAdmission, prepareJoinRequest } from './workflows/enrollment';
export type { CommandOutcome, ResumeOutcome, SnapshotBootstrap } from './workflows/ledger-client';
export { JournalStore, LedgerTransport, DeviceSigner, SignatureVerifier } from './ports/ledger';
export type { JournalTransaction } from './ports/ledger';
export { HpkeSender, HpkeRecipient } from './ports/hpke';
export { CryptoEntropy } from './ports/entropy';
export type { PreparedEpochEnvelope } from './pure/epoch-envelope';
export { KeyOutbox, KeyDeliveryRemote } from './ports/key-delivery';
export type { KeyOutboxTransaction } from './ports/key-delivery';
export type { DeliveryOutcome } from './pure/key-delivery';
/** Advanced persistence codec; decoded candidates still require verified-ledger binding. */
export * as EpochCandidateStorage from './pure/epoch-candidate';
export { EpochCandidateStore, EpochKeyring } from './ports/epoch-rotation';
export type { EpochCandidateTransaction } from './ports/epoch-rotation';
export type { EpochRotationOutcome } from './workflows/epoch-rotation';
export { parseEpochEnvelopeChunk } from './pure/epoch-envelope-stream';
export { EpochStream } from './ports/epoch-stream';
export type { EpochStreamPage } from './ports/epoch-stream';
export { epochStreamDeliveryLayer } from './workflows/epoch-stream';
export { admitSnapshot } from './workflows/snapshot-admission';
export {
  SnapshotStore,
  SnapshotAuthenticator,
  SnapshotWriteGate,
  AdmissionClock,
} from './ports/snapshot';
export { SnapshotAdmissionError } from './pure/errors';
export { DeviceIdentityStore, UserIdentityStore } from './ports/identity';
export type { DeviceIdentityHandles, UserIdentityHandles } from './ports/identity';
export { ContentAuthority, ContentCrypto } from './ports/content';
export { sealContent, openContent, authenticateContent } from './workflows/content';
export { parseContentFrame, inspectContentFrame, MAX_CONTENT_BYTES } from './pure/content-frame';
export type {
  ContentAuthor,
  ContentHeader,
  ContentPolicy,
  ContentPurpose,
  ContentScope,
  SealContent,
} from './pure/content-frame';
export { ContentError, RecoveryError } from './pure/errors';
export {
  parseRecoveryFileBytes,
  openRecoveryBackupFrame,
  sealRecoveryBackupFrame,
} from './pure/recovery-file';
export type { RecoveryBackupContext } from './pure/recovery-file';
