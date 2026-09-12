import type { ControlJournal, ControlStore, JournalTransaction } from './client';
import { checkOffset, MAX_READ_RECORDS } from './client';
import { checkHex, decodeRecord, invariant } from './wire';
import { SqliteTextStore } from './node-text-store';
const FORMAT = 'lody-control-journal/v2';
const MAX_BYTES = 16 * 1024 * 1024;

export function encodeJournal(journal: ControlJournal): string {
  checkHex(journal.genesis, 32);
  const pages = journal.pages.map(({ records, nextOffset }) => {
    invariant(records.length <= MAX_READ_RECORDS, 'read-too-large');
    for (const wire of records)
      invariant(decodeRecord(wire).event.genesis === journal.genesis, 'journal-anchor-mismatch');
    checkOffset(nextOffset);
    return [records, nextOffset];
  });
  if (journal.pending !== null)
    invariant(
      decodeRecord(journal.pending).event.genesis === journal.genesis,
      'pending-anchor-mismatch'
    );
  const text = JSON.stringify([FORMAT, journal.genesis, pages, journal.pending]);
  invariant(Buffer.byteLength(text) <= MAX_BYTES, 'journal-too-large');
  return text;
}

export function decodeJournal(text: string): ControlJournal {
  const parsed: unknown = JSON.parse(text);
  invariant(Array.isArray(parsed) && parsed.length === 4, 'invalid-journal');
  const [format, genesis, rows, pending] = parsed as unknown[];
  invariant(format === FORMAT, 'unsupported-journal-version');
  checkHex(genesis, 32);
  invariant(Array.isArray(rows), 'invalid-journal');
  invariant(pending === null || typeof pending === 'string', 'invalid-journal');
  const pages = rows.map((row: unknown) => {
    invariant(Array.isArray(row) && row.length === 2, 'invalid-journal');
    const [records, nextOffset] = row as unknown[];
    invariant(
      Array.isArray(records) &&
        records.every((wire: unknown) => typeof wire === 'string') &&
        typeof nextOffset === 'string',
      'invalid-journal'
    );
    return { records, nextOffset };
  });
  const journal = { genesis, pages, pending };
  invariant(encodeJournal(journal) === text, 'noncanonical-journal');
  return journal;
}

/** Node >=22.13; public control records only, never plaintext secrets. */
export class SqliteControlStore implements ControlStore {
  private readonly database: SqliteTextStore;
  constructor(path: string) {
    this.database = new SqliteTextStore(path, 0x4c454332, 2);
  }
  exclusive<T>(work: (transaction: JournalTransaction) => Promise<T>): Promise<T> {
    return this.database.exclusive((tx) =>
      work({
        load: async () => {
          const text = await tx.load();
          return text === null ? null : decodeJournal(text);
        },
        save: async (journal) => tx.save(encodeJournal(journal)),
      })
    );
  }
}
