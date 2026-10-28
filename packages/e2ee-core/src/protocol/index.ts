/**
 * The pure E2EE protocol: byte types, canonical encodings, signatures, the
 * ledger verifier, epoch-key envelopes and history, and the content format.
 *
 * No I/O, storage or service here; every function is deterministic over its
 * inputs (crypto aside). Workflows in `@lody/e2ee-core` are built on these.
 * Use this entry to interoperate at the byte level: build or inspect records,
 * verify a ledger in another runtime, or write a compatible implementation.
 * The normative description is the whitepaper (`specs/e2ee/whitepaper.md`).
 *
 * @module
 */

// Foundation
/** Validated, copy-owning protocol byte values and their parsers; parsing does not establish authority. */
export * as Bytes from '../internal/foundation/bytes';
export {
  ValidationError,
  ContentError,
  type ValidationErrorCode,
} from '../internal/foundation/errors';
export { decodeCbor, encodeCbor, type CborValue } from '../internal/foundation/cbor';
export { verifySignature, verifyContentSignature } from '../internal/foundation/signature';
/** Whether strict Ed25519 verification runs in WebAssembly in this isolate (false: the pure-JS fallback is in use); for host diagnostics. */
export { ed25519WasmActive } from '../internal/foundation/ed25519-wasm';
export {
  signVerified,
  nativeDeviceSigner,
  type DeviceSigner,
} from '../internal/foundation/signing';

export {
  deviceCredentialBindingBytes,
  signDeviceCredentialBinding,
  verifyDeviceCredentialBinding,
  type DeviceCredentialBinding,
} from '../internal/foundation/device-credential-binding';

// Content format and primitives
export {
  encodeDocumentContext,
  encodeContentContext,
  encodeContentHeader,
  contentKeyInfo,
  contentHkdfSalt,
  contentAad,
  contentSigningBytes,
  inspectContentFrame,
  type DocumentScope,
  type ContentScope,
  type ContentPurpose,
  type ContentHeader,
  type ContentMetadata,
} from '../internal/foundation/content-format';
export {
  deriveContentKey,
  disposeContentKey,
  sealContentAead,
  openContentAead,
  type ContentKey,
  type SealedContentAead,
} from '../internal/crypto/content';
export {
  epochHpkeAad,
  sealEpochKeyHpke,
  openEpochKeyHpke,
  HpkePrimitiveError,
  type EpochHpkeContext,
  type SealedEpochHpke,
} from '../internal/crypto/hpke';

// Purpose-specific opaque content primitives; no realtime authority or body profile.
export {
  sealPresenceContent,
  openPresenceContent,
  sealRpcRequestContent,
  openRpcRequestContent,
  sealRpcResponseContent,
  openRpcResponseContent,
} from '../internal/content/realtime';

// Machine sharing
export {
  updateMachineSharingState,
  encodeMachineSharingPolicy,
  decodeMachineSharingPolicy,
  machineSharingContentScope,
  machineSharingDigest,
  sealMachineSharingPolicy,
  openMachineSharingPolicy,
  verifyMachineSharingHistoryStep,
  authorizeMachineExecution,
  type MachineSharingBinding,
  type MachineSharingState,
  type MachineSharingChange,
  type MachineSharingPolicy,
  type MachineSharingHead,
  type VerifiedMachineSharingPolicy,
  type MachineExecutionDecision,
} from '../internal/machine-sharing';

// Documents
export {
  sealDocument,
  authenticateDocument,
  openDocument,
  admitDocument,
  deriveDocumentKey,
  disposeDocumentKey,
  scopedDocumentKey,
  importDocumentKey,
  exportDocumentKey,
  type DocumentKey,
} from '../internal/content';

// Ledger
export * from '../internal/ledger/index';
export {
  prepareLedgerRecord,
  signLedgerRecord,
  type PreparedLedgerRecord,
} from '../internal/ledger/signing';
export * from '../internal/ledger/snapshot';
export {
  prepareJoinRequest,
  prepareDeviceAdmission,
  prepareLedgerCommand,
  signGenesisRecord,
  type LedgerCommand,
} from '../internal/ledger/admission';
export {
  LedgerFeedError,
  validLedgerOffset,
  frameLedgerRecord,
  prepareLedgerPage,
  prepareLedgerPageEffect,
  type LedgerReadPage,
  type LedgerFeedState,
} from '../internal/ledger/feed-page';

// Epoch keys
export {
  EpochKeyError,
  commitEpochKey,
  sealHistoryPacket,
  openHistoryPacket,
  recoverLedgerHistory,
} from '../internal/keys/history';
export {
  authenticateEpochEnvelope,
  authenticateEpochEnvelopeSignature,
  prepareEpochEnvelope,
  openEpochEnvelope,
  type EpochEnvelopeContext,
} from '../internal/keys/envelope';
export {
  EpochStagingError,
  ownEpochStagedGroup,
  ownEpochStagedGroupKey,
  sameEpochStagedGroup,
  authenticateEpochStagedGroup,
  obsoleteEpochStagedGroup,
  getCommittedEpochStagingKey,
  type EpochStagedGroup,
  type EpochStagedGroupKey,
} from '../internal/keys/staging';
export {
  mailboxDigest,
  slotId,
  installationBody,
  installationSigningBytes,
  encodeInstallationReport,
  decodeInstallationReport,
  envelopeRouting,
  checkLocalPublication,
  checkInstallationContext,
  authenticateInstallationReport,
  type MailboxSlot,
  type InstallationSource,
  type InstallationContext,
} from '../internal/keys/reports';
export { epochDeliveryId } from '../internal/keys/delivery';

// Recovery
export {
  generateRecoveryPackage,
  importRecoveryIdentity,
  parseRecoveryFile,
  wipeRecoveryPackage,
  verifiedPasskeyPrf,
  disposePrf,
  ownVaultCiphertext,
  vaultCiphertextDigest,
  sameVaultCiphertext,
  RecoveryVaultError,
  type RecoveryIdentity,
  type RecoveryPrivatePackage,
  type VerifiedPasskeyPrf,
  type VaultCiphertext,
} from '../internal/recovery';
