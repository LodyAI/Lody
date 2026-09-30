/** Node SQLite stores for the legacy facade: thin names over the native Effect services. */
import * as journalCodec from '../pure/journal-codec';
import type { LedgerJournal } from '../pure/journal';
import { SqliteTextStore } from '../node-text-store';
import { sqliteJournalService } from '../platform/node-journal';
import { sqliteKeyOutboxService } from '../platform/node-key-outbox';
import type { JournalStore } from '../ports/ledger';
import type { KeyOutbox } from '../ports/key-delivery';
import { unwrap } from './compat';

type JournalStoreService = JournalStore['Type'];
type KeyOutboxService = KeyOutbox['Type'];

export { createNodeSignatureVerifyExecutor } from './node-sig-pool';

export const encodeLedgerJournal = (journal: LedgerJournal): string =>
  unwrap(journalCodec.encodeLedgerJournal(journal));
export const decodeLedgerJournal = (text: string): LedgerJournal =>
  unwrap(journalCodec.decodeLedgerJournal(text));

/** Legacy lazy-create store. New callers use `nodeJournalStoreLayer` with explicit create/open. */
export class SqliteLedgerStore implements JournalStoreService {
  readonly exclusive: JournalStoreService['exclusive'];
  constructor(path: string, options?: { createFile: boolean; initializeSchema: boolean }) {
    this.exclusive = sqliteJournalService(
      new SqliteTextStore(path, 0x4c454c30, 0, options)
    ).exclusive;
  }
}

/** Experimental exact-byte key outbox. Disk is not authority; retry never re-encrypts. */
export class SqliteLedgerKeyOutbox implements KeyOutboxService {
  readonly exclusive: KeyOutboxService['exclusive'];
  constructor(path: string) {
    this.exclusive = sqliteKeyOutboxService(new SqliteTextStore(path, 0x4c454b30, 0)).exclusive;
  }
}
