/**
 * Node SQLite (`better-sqlite3`) implementations of every local storage port.
 *
 * Each store is a dedicated file with its own application id and schema
 * version, bound to one workspace (and device) on creation; a file of another
 * kind or workspace is refused, never converted. {@link sqliteLocalStores}
 * composes all of them in one directory. Also contains the reference mailbox
 * backend and the reference snapshot publication journal used by tests and the Lab.
 *
 * @module
 */
import { Layer } from 'effect';
import { join } from 'node:path';
import { sqliteDeliveryOutbox } from './delivery-outbox';
import { sqliteDistributionJournal } from './distribution-journal';
import { sqliteEpochCandidateStore } from './epoch-candidate-store';
import { sqliteInstalledKeyStore } from './installed-key-store';
import { sqliteLedgerFeedStore } from './ledger-feed-store';
import { sqliteLedgerPinStore } from './ledger-pin';
import { sqliteReceiveJournal } from './receive-journal';
import { sqliteRepairJournal } from './repair-journal';
import { sqliteSubmissionJournal } from './submission-journal';

export type { SqliteFileOptions } from './store';
export { sqliteDeliveryOutbox } from './delivery-outbox';
export {
  sqliteDistributionJournal,
  type SqliteDistributionJournalOptions,
} from './distribution-journal';
export { sqliteEpochCandidateStore } from './epoch-candidate-store';
export { sqliteInstalledKeyStore } from './installed-key-store';
export { sqliteLedgerFeedStore } from './ledger-feed-store';
export { sqliteLedgerPinStore } from './ledger-pin';
export { sqliteReceiveJournal } from './receive-journal';
export { sqliteRecoveryVaultLocalStore } from './recovery-vault-local';
export { sqliteRepairJournal } from './repair-journal';
export { sqliteSubmissionJournal } from './submission-journal';
export {
  makeSqliteKeyMailbox,
  referenceKeyMailbox,
  MailboxError,
  type MailboxStatus,
  type MailboxTarget,
} from './reference-mailbox-host';
export {
  makeSqliteSnapshotPublication,
  snapshotPublicationDigest,
  SnapshotPublicationError,
  type SnapshotPublicationRow,
} from './reference-snapshot-journal';

/** File names used by {@link sqliteLocalStores}, relative to its directory. */
export const SQLITE_STORE_FILES = {
  ledgerPin: 'ledger-pin.sqlite',
  ledgerFeed: 'ledger-feed.sqlite',
  installedKeys: 'installed-keys.sqlite',
  receive: 'receive.sqlite',
  repair: 'repair.sqlite',
  distribution: 'distribution.sqlite',
  outbox: 'outbox.sqlite',
  candidates: 'epoch-candidates.sqlite',
  submissions: 'submissions.sqlite',
} as const;

/**
 * Every local storage port, each in its own file inside `directory` (one
 * directory per workspace and device). `mode` applies to every file.
 *
 * Requires `WorkspaceScope` and `DeviceIdentity`.
 *
 * @category Node SQLite adapters
 */
export const sqliteLocalStores = (options: {
  readonly directory: string;
  readonly mode: 'create' | 'open' | 'create-or-open';
}) => {
  const file = (name: keyof typeof SQLITE_STORE_FILES) => ({
    path: join(options.directory, SQLITE_STORE_FILES[name]),
    mode: options.mode,
  });
  return Layer.mergeAll(
    sqliteLedgerPinStore(file('ledgerPin')),
    sqliteLedgerFeedStore(file('ledgerFeed')),
    sqliteInstalledKeyStore(file('installedKeys')),
    sqliteReceiveJournal(file('receive')),
    sqliteRepairJournal(file('repair')),
    sqliteDistributionJournal(file('distribution')),
    sqliteDeliveryOutbox(file('outbox')),
    sqliteEpochCandidateStore(file('candidates')),
    sqliteSubmissionJournal({ path: file('submissions').path })
  );
};
