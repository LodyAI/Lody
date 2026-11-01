/**
 * `@lody/e2ee-core` — end-to-end encryption for collaborative documents synced
 * over an untrusted backend, built on a signed membership ledger.
 *
 * This entry is for **applications**: the workflows you call. They depend only
 * on the ports in `@lody/e2ee-core/services`, which you implement or take from
 * `@lody/e2ee-core/adapters/*`. Start with `README.md` (导读: `README.zh.md`).
 *
 * | Entry | For |
 * | --- | --- |
 * | `@lody/e2ee-core` | workflows, their errors and results |
 * | `@lody/e2ee-core/services` | ports to implement or provide |
 * | `@lody/e2ee-core/protocol` | the pure protocol (bytes, ledger, envelopes) |
 * | `@lody/e2ee-core/host` | backend rules and wire schemas |
 * | `@lody/e2ee-core/adapters/node-sqlite` | SQLite local stores, reference mailbox |
 * | `@lody/e2ee-core/adapters/loro-streams` | Loro/Durable Streams ledger log |
 * | `@lody/e2ee-core/cloudflare` | bundle-time strict Ed25519 WebAssembly for Workers |
 * | `@lody/e2ee-core/internal` | unstable; tests and the Lab only |
 *
 * @module
 */
export { E2eeWorkflows } from './workflows';

// Ledger
export { VerifiedLedger, VerifiedLedgerError } from './internal/ledger/verified-ledger';
export {
  LedgerFeed,
  type LedgerFeedOptions,
  type LedgerFeedOrigin,
  type SnapshotFeedOrigin,
} from './internal/ledger/ledger-feed';
export { LedgerSubmission, SubmissionError, type SubmissionFailure } from './internal/submission';

// Epoch keys
export {
  InstalledEpochKeys,
  InstalledEpochHistory,
  InstalledKeyError,
  MAX_PROTECTED_EPOCH_BYTES,
} from './internal/keys/installed-keys';
export {
  KeyReceiver,
  ReceiveError,
  MailboxInstallError,
  type ReceiveBatch,
  type ReceiveFailure,
} from './internal/keys/receiver';
export { KeyRepair, RepairError, type RepairBatch } from './internal/keys/repair';
export {
  KeyDistributor,
  DistributionError,
  type DistributionBatch,
  type DistributionFailure,
  type DistributionResult,
} from './internal/keys/distributor';
export { DeliveryError, type DeliveryOutcome } from './internal/keys/delivery';
export {
  EpochPublisher,
  EpochPublishError,
  type EpochPublishFailure,
  type EpochPublishResult,
} from './internal/keys/publisher';
export { EpochKeyError } from './internal/keys/history';

// Value types used by the workflows above.
/** Validated, copy-owning protocol byte values and their parsers; parsing does not establish authority. */
export * as Bytes from './internal/foundation/bytes';
export { ValidationError, ContentError } from './internal/foundation/errors';
export { LedgerError } from './internal/ledger/errors';
export {
  LedgerFeedError,
  type LedgerFeedState,
  type LedgerReadPage,
} from './internal/ledger/feed-page';
export type { LedgerView, LedgerCheckpoint, LedgerState } from './internal/ledger';
export type { DeviceSigner } from './internal/foundation/signing';
export type { EpochStagedGroup } from './internal/keys/staging';

// Recovery
export { RecoveryVaults } from './internal/recovery/vaults';
export {
  makeWorkspaceRecovery,
  RecoveryVaultError,
  type RecoveryVault,
  type RecoveryEntryReference,
  type RecoveryPrivatePackage,
  type WorkspaceRecoveryInput,
  type RecoveryCredentialRegistration,
  type RecoverySubmitResult,
  type RecoveryEnvelope,
} from './internal/recovery';

// Workspace facade
export {
  E2eeWorkspace,
  makeE2eeWorkspace,
  WorkspacePlatform,
  WorkspaceError,
  unavailableWorkspaceRecovery,
  WorkspaceControl,
  WorkspaceControlError,
  runWorkspaceKeyRound,
  WorkspaceKeyRoundCursors,
  WorkspaceKeyRoundError,
  WorkspaceKeyRoundFailure,
  issueWorkspaceInvitation,
  verifyWorkspaceInvitationSnapshot,
  verifyRetainedWorkspaceGenesis,
  type E2eeWorkspaceHandle,
  type WorkspaceDocumentState,
  type WorkspaceInvitation,
  type WorkspaceInvitationMailbox,
  type WorkspaceInvitationSnapshot,
  type WorkspaceModel,
  type WorkspacePorts,
  type WorkspaceRecoveryConfiguration,
  type WorkspaceResources,
  type WorkspaceRestorePlan,
  type WorkspaceRestoreRequest,
  type WorkspaceRotationStatus,
} from './internal/workspace';
