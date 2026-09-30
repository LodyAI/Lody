import { Effect } from 'effect';
import type { JournalStore, JournalTransaction } from '../ports/ledger';
import type { KeyOutbox, KeyOutboxTransaction } from '../ports/key-delivery';
import { StorageError } from '../pure/errors';
import { copyBytes } from '../pure/cbor';
import type { LedgerJournal } from '../pure/journal';

type JournalStoreService = JournalStore['Type'];
type KeyOutboxService = KeyOutbox['Type'];

function copyJournal(journal: LedgerJournal): LedgerJournal {
  return {
    genesis: copyBytes(journal.genesis),
    records: journal.records.map(copyBytes),
    pending: journal.pending === null ? null : copyBytes(journal.pending),
    offset: journal.offset,
    snapshot: journal.snapshot ? copyBytes(journal.snapshot) : undefined,
    snapshotTrust: journal.snapshotTrust
      ? {
          genesis: copyBytes(journal.snapshotTrust.genesis),
          endorser: copyBytes(journal.snapshotTrust.endorser),
          head: copyBytes(journal.snapshotTrust.head),
          headSignature: copyBytes(journal.snapshotTrust.headSignature),
        }
      : undefined,
    snapshotBound: journal.snapshotBound === true ? true : undefined,
  };
}

/** Non-durable journal for tests and experiments. One holder at a time; an
 * interrupted holder or waiter releases its permit. `failSave` injects one fault. */
export class MemoryJournalStore implements JournalStoreService {
  journal: LedgerJournal | null = null;
  failSave: 'before' | 'after' | null = null;
  readonly #lock = Effect.unsafeMakeSemaphore(1);

  readonly exclusive: JournalStoreService['exclusive'] = (work) =>
    this.#lock.withPermits(1)(Effect.suspend(() => work(this.#transaction())));

  #transaction(): JournalTransaction {
    return {
      load: Effect.sync(() => (this.journal === null ? null : copyJournal(this.journal))),
      save: (journal) => {
        const owned = copyJournal(journal);
        return Effect.suspend(() => {
          const failure = this.failSave;
          this.failSave = null;
          if (failure === 'before') return Effect.fail(new StorageError({ reason: 'io' }));
          this.journal = owned;
          return failure === 'after'
            ? Effect.fail(new StorageError({ reason: 'io' }))
            : Effect.void;
        });
      },
    };
  }
}

/** Non-durable exact-byte outbox for tests and experiments. */
export class MemoryKeyOutbox implements KeyOutboxService {
  readonly frames = new Map<string, Uint8Array>();
  readonly #lock = Effect.unsafeMakeSemaphore(1);

  readonly exclusive: KeyOutboxService['exclusive'] = (work) =>
    this.#lock.withPermits(1)(Effect.suspend(() => work(this.#transaction())));

  #transaction(): KeyOutboxTransaction {
    return {
      load: (id) =>
        Effect.sync(() => {
          const saved = this.frames.get(id);
          return saved === undefined ? null : copyBytes(saved);
        }),
      save: (id, frame) => {
        const owned = copyBytes(frame);
        return Effect.sync(() => {
          this.frames.set(id, owned);
        });
      },
    };
  }
}
