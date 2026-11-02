/**
 * The services an integrator implements or provides.
 *
 * Every workflow in `@lody/e2ee-core` depends only on these ports, so the
 * library runs on any backend, platform and storage. Three groups:
 *
 * - **Backend ports** — the remote systems: {@link LedgerLog} and
 *   {@link LedgerFeedSource} (the append-only ledger, e.g. Loro Streams),
 *   {@link KeyMailbox} and {@link EpochStagingStore} (key delivery, e.g. a
 *   Convex or HTTP service), {@link RecoveryVaultStore} (encrypted recovery
 *   vaults). Rules and wire schemas: `@lody/e2ee-core/host`.
 * - **Platform ports** — {@link DeviceIdentity} (signing and encryption keys),
 *   {@link KeyProtector} (OS-level protection of installed keys at rest) and
 *   {@link CandidateProtector} (protection of unpublished rotation keys).
 * - **Application ports** — {@link WorkspaceScope}, {@link LedgerViewSource},
 *   {@link LedgerSync} and {@link EpochPublicationSource}.
 * - **Local storage ports** — durable journals and stores. Ready-made SQLite
 *   implementations: `@lody/e2ee-core/adapters/node-sqlite`.
 *
 * Every value a port returns is untrusted: workflows re-verify it against the
 * signed ledger, so a faulty port can delay progress but cannot grant access.
 * See `docs/services.md` for each port's contract.
 *
 * @module
 */
export {
  BackendError,
  KeyProtectorError,
  LedgerLogError,
  LedgerViewSourceError,
  LocalStoreError,
} from './errors';
export {
  CandidateProtector,
  EpochStagingStore,
  KeyMailbox,
  KeyProtector,
  type KeyMailboxStatus,
} from './keys';
export {
  EpochPublicationSource,
  LedgerFeedSource,
  LedgerLog,
  LedgerPinStore,
  LedgerSync,
  LedgerViewSource,
  SubmissionJournal,
  type SubmissionEntry,
  type SubmissionOutcome,
  type SubmissionResult,
} from './ledger';
export {
  DeliveryOutbox,
  DistributionJournal,
  EpochCandidateStore,
  InstalledKeyStore,
  LedgerFeedStore,
  ReceiveJournal,
  RepairJournal,
  type DistributionTaskPhase,
  type DistributionTaskRow,
  type EpochCandidateRow,
  type LedgerFeedContents,
  type LedgerFeedTail,
  type ReceiveTaskPhase,
  type ReceiveTaskRow,
  type RepairTaskPhase,
  type RepairTaskRow,
} from './stores';
export { DeviceIdentity, WorkspaceScope } from './workspace';
export { RecoveryVaultLocalStore, RecoveryVaultStore } from './recovery';
export {
  ClientCustodyError,
  ClientKeyCustody,
  ClientInstallationStore,
  CLIENT_KEY_PURPOSES,
  type ClientCustodyBinding,
  type ClientCustodyScope,
  type ClientCustodyStatus,
  type ClientKeyPurpose,
  type ClientWrappedKey,
  type ClientInstallation,
} from './client-custody';

// Value types that appear in port signatures.
export type { DeviceSigner } from '../internal/foundation/signing';
export { nativeDeviceSigner } from '../internal/foundation/signing';
export type { GenesisHash, SigningPublicKey } from '../internal/foundation/bytes';
export type { LedgerCheckpoint, LedgerView } from '../internal/ledger';
export { LedgerFeedError, type LedgerReadPage } from '../internal/ledger/feed-page';
export type { MailboxSlot } from '../internal/keys/reports';
export type { EpochStagedGroup, EpochStagedGroupKey } from '../internal/keys/staging';
export type { LedgerFeedState } from '../internal/ledger/feed-page';
export type { VaultCiphertext } from '../internal/recovery/crypto';

export {
  ClientPairingOriginalStore,
  type ClientPairingKey,
  type ClientPairingOriginal,
  type ClientPairingPurpose,
} from './client-pairing';

export { ClientCustodyWriter } from './client-custody';

export {
  SnapshotPublicationJournal,
  SnapshotPublicationError,
  snapshotPublicationDigest,
  type SnapshotPublicationRow,
  type SnapshotPublicationIdentity,
  type SnapshotPublicationOriginal,
} from './snapshot-publication';

export { ClientIdentityOriginals } from './client-custody';

export { ClientRpcOriginalStore, type ClientRpcOriginal } from './client-rpc';

export { ClientApprovalEvidenceStore } from './client-approval-evidence';
