/**
 * The backend contract: what a mailbox or staging *server* must enforce, and
 * the wire schemas it speaks. Platform-neutral (no Node APIs), so it runs in
 * any backend runtime.
 *
 * A backend is never trusted for confidentiality or authority: clients verify
 * everything against the signed ledger. These rules exist so a backend cannot
 * be used to spam, replay or hide delivery state, and so honest backends agree
 * on behavior. Read `docs/backend-guide.md` for the full checklist.
 *
 * - Staging ({@link EpochStagingStore}): DTO schemas, the device request
 *   signature, {@link checkEpochStageRequest} and the obsolescence check for
 *   deletion ({@link obsoleteEpochStagedGroup}).
 * - Mailbox ({@link KeyMailbox}): {@link envelopeRouting} and
 *   {@link authenticateEpochEnvelope} for `put`,
 *   {@link authenticateInstallationReport} and {@link checkLocalPublication}
 *   for `report`. A runnable reference backend is `makeSqliteKeyMailbox` in
 *   `@lody/e2ee-core/adapters/node-sqlite`.
 *
 * - Documents: {@link admitDocument} before storing a sealed frame, and
 *   {@link admitStreamsUpdateBatch} / {@link admitStreamsSnapshot} for
 *   `@loro-dev/streams-crdt` batches and snapshots (with a
 *   {@link StreamsRecordBoundaryPort} proving snapshot offsets).
 *
 * - Recovery vaults ({@link RecoveryVaultStore}): DTO schemas and
 *   `encode…`/`decode…` helpers in `recovery-vault.ts`.
 *
 * @module
 */
export * from './staging';
export {
  EpochStagingError,
  ownEpochStagedGroup,
  ownEpochStagedGroupKey,
  sameEpochStagedGroup,
  obsoleteEpochStagedGroup,
  getCommittedEpochStagingKey,
  type EpochStagedGroup,
  type EpochStagedGroupKey,
} from '../internal/keys/staging';
export {
  mailboxDigest,
  slotId,
  validSlot,
  envelopeRouting,
  checkLocalPublication,
  authenticateInstallationReport,
  decodeInstallationReport,
  type MailboxSlot,
  type InstallationContext,
} from '../internal/keys/reports';
export { authenticateEpochEnvelope } from '../internal/keys/envelope';
export type { KeyMailboxStatus } from '../services/keys';
export type { EpochStagingStore, KeyMailbox } from '../services/keys';
export { admitDocument } from '../internal/content';
export {
  admitStreamsSnapshot,
  admitStreamsSnapshotEffect,
  admitStreamsUpdateBatch,
  admitStreamsUpdateBatchEffect,
  authenticateStreamsSnapshotEffect,
} from '../internal/content/streams';
export type {
  StreamsRecordBoundary,
  StreamsRecordBoundaryPort,
} from '../internal/content/record-boundary';
export * from './recovery-vault';
export type { RecoveryVaultStore } from '../services/recovery';
