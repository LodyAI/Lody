import { copyBytes, bytesEqual } from './cbor';
import { hashRecord, type Hash } from './crypto';
import { fail } from './error';
import { Ledger } from './ledger';
import { decodeRecord } from './schema';

export const MAX_LEDGER_READ_RECORDS = 4096;
export const MAX_LEDGER_READ_PAGES = 4096;

export interface LedgerJournal {
  readonly genesis: Uint8Array;
  readonly records: readonly Uint8Array[];
  readonly pending: Uint8Array | null;
  readonly offset: string;
}

export interface LedgerTransaction {
  load(): Promise<LedgerJournal | null>;
  save(journal: LedgerJournal): Promise<void>;
}

export interface LedgerStore {
  exclusive<T>(work: (transaction: LedgerTransaction) => Promise<T>): Promise<T>;
}

export interface LedgerReadPage {
  readonly records: readonly Uint8Array[];
  readonly nextOffset: string;
  readonly upToDate: boolean;
}

export interface LedgerStream {
  readonly initialOffset: string;
  readAfter(offset: string): Promise<LedgerReadPage>;
  appendCas(offset: string, record: Uint8Array): Promise<'accepted' | 'conflict' | 'unsupported'>;
}

export type LedgerSubmitStatus = 'committed' | 'conflict' | 'unknown' | 'unsupported';

export interface LedgerSubmitResult {
  readonly status: LedgerSubmitStatus;
  readonly ledger: Ledger;
}

type Session = { journal: LedgerJournal; ledger: Ledger };

function checkOffset(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value === 'now') {
    fail('invalid-operation');
  }
}

function copyRecordList(records: readonly Uint8Array[]): Uint8Array[] {
  return records.map((record) => {
    if (!(record instanceof Uint8Array)) fail('canonical');
    return copyBytes(record);
  });
}

function copyJournal(journal: LedgerJournal): LedgerJournal {
  return {
    genesis: copyBytes(journal.genesis),
    records: copyRecordList(journal.records),
    pending: journal.pending === null ? null : copyBytes(journal.pending),
    offset: journal.offset,
  };
}

async function containsHash(ledger: Ledger, record: Uint8Array): Promise<boolean> {
  const digest = await hashRecord(record);
  for (let i = 0; i < ledger.length; i++) {
    if (bytesEqual(ledger.hashAt(i), digest)) return true;
  }
  return false;
}

export class LedgerClient {
  private readonly anchor: Hash;
  private readonly genesisRecord: Uint8Array;

  constructor(
    genesisRecord: Uint8Array,
    anchor: Hash,
    private readonly store: LedgerStore,
    private readonly stream: LedgerStream
  ) {
    if (!(genesisRecord instanceof Uint8Array) || !(anchor instanceof Uint8Array)) {
      fail('canonical');
    }
    this.genesisRecord = copyBytes(genesisRecord);
    this.anchor = copyBytes(anchor);
    checkOffset(stream.initialOffset);
  }

  static async open(
    genesisRecord: Uint8Array,
    store: LedgerStore,
    stream: LedgerStream
  ): Promise<LedgerClient> {
    const record = copyBytes(genesisRecord);
    const anchor = await hashRecord(record);
    await Ledger.verify({ anchor, records: [record] });
    return new LedgerClient(record, anchor, store, stream);
  }

  private async save(
    tx: LedgerTransaction,
    session: Session,
    pending: Uint8Array | null,
    offset = session.journal.offset,
    records = session.journal.records
  ): Promise<void> {
    const next: LedgerJournal = {
      genesis: this.anchor,
      records: copyRecordList(records),
      pending: pending === null ? null : copyBytes(pending),
      offset,
    };
    await tx.save(copyJournal(next));
    session.journal = next;
  }

  private async load(tx: LedgerTransaction): Promise<Session> {
    const loaded = await tx.load();
    const journal = loaded
      ? copyJournal(loaded)
      : {
          genesis: copyBytes(this.anchor),
          records: [copyBytes(this.genesisRecord)],
          pending: null,
          offset: this.stream.initialOffset,
        };
    if (!bytesEqual(journal.genesis, this.anchor)) fail('wrong-anchor');
    if (journal.records.length === 0) fail('genesis-mismatch');
    const ledger = await Ledger.verify({ anchor: this.anchor, records: journal.records });
    checkOffset(journal.offset);
    return { journal, ledger };
  }

  private async refresh(tx: LedgerTransaction, session: Session): Promise<void> {
    const seen = new Set([this.stream.initialOffset, session.journal.offset]);
    for (let pageCount = 0; pageCount < MAX_LEDGER_READ_PAGES; pageCount++) {
      const page = await this.stream.readAfter(session.journal.offset);
      checkOffset(page.nextOffset);
      if (!Array.isArray(page.records)) fail('canonical');
      if (typeof page.upToDate !== 'boolean') fail('canonical');
      if (page.records.length === 0) {
        if (!page.upToDate) fail('canonical');
        if (page.nextOffset === session.journal.offset) return;
        if (session.journal.records.length !== 1) fail('canonical');
      }
      if (seen.has(page.nextOffset) && page.records.length > 0) fail('replay');
      if (session.journal.records.length + page.records.length > MAX_LEDGER_READ_RECORDS) {
        fail('oversize');
      }
      const copied = copyRecordList(page.records);
      const extended = copied.length === 0 ? session.ledger : await session.ledger.extend(copied);
      const records = [...session.journal.records, ...copied];
      await this.save(tx, session, session.journal.pending, page.nextOffset, records);
      session.ledger = extended;
      seen.add(page.nextOffset);
      if (page.upToDate) return;
    }
    fail('oversize');
  }

  async read(): Promise<Ledger> {
    return this.store.exclusive(async (tx) => {
      const session = await this.load(tx);
      await this.refresh(tx, session);
      return session.ledger;
    });
  }

  async submit(record: Uint8Array): Promise<LedgerSubmitResult> {
    if (!(record instanceof Uint8Array)) fail('canonical');
    decodeRecord(record);
    return this.run(copyBytes(record));
  }

  async resume(): Promise<LedgerSubmitResult> {
    return this.run();
  }

  private async run(requested?: Uint8Array): Promise<LedgerSubmitResult> {
    return this.store.exclusive(async (tx) => {
      const session = await this.load(tx);
      const retrying = session.journal.pending !== null;
      const wire = requested ?? session.journal.pending;
      if (wire === null || wire === undefined) fail('invalid-operation');
      if (session.journal.pending !== null && !bytesEqual(session.journal.pending, wire)) {
        fail('replay');
      }
      const decoded = decodeRecord(wire);
      if (decoded.body.type !== 'ordinary') fail('genesis-mismatch');
      const previousHash = decoded.body.fields.previousHash;
      await this.refresh(tx, session);

      const reconcile = async (): Promise<LedgerSubmitResult | undefined> => {
        if (await containsHash(session.ledger, wire)) {
          await this.save(tx, session, null);
          return { status: 'committed', ledger: session.ledger };
        }
        if (!bytesEqual(previousHash, session.ledger.head)) {
          await this.save(tx, session, null);
          return { status: 'conflict', ledger: session.ledger };
        }
        return undefined;
      };

      const prior = await reconcile();
      if (prior) return prior;
      await session.ledger.extend([wire]);
      await this.save(tx, session, wire);
      let result: 'accepted' | 'conflict' | 'unsupported' | 'unknown';
      try {
        result = await this.stream.appendCas(session.journal.offset, wire);
      } catch {
        result = 'unknown';
      }
      await this.refresh(tx, session);
      const observed = await reconcile();
      if (observed) return observed;
      if (result === 'unsupported' && !retrying) {
        await this.save(tx, session, null);
        return { status: 'unsupported', ledger: session.ledger };
      }
      return { status: 'unknown', ledger: session.ledger };
    });
  }
}

export class MemoryLedgerStore implements LedgerStore {
  journal: LedgerJournal | null = null;
  failSave: 'before' | 'after' | null = null;
  private queue: Promise<void> = Promise.resolve();

  async exclusive<T>(work: (tx: LedgerTransaction) => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work({
        load: async () => (this.journal === null ? null : copyJournal(this.journal)),
        save: async (journal) => {
          const failure = this.failSave;
          this.failSave = null;
          if (failure === 'before') throw new Error('disk-failure');
          this.journal = copyJournal(journal);
          if (failure === 'after') throw new Error('disk-failure');
        },
      });
    } finally {
      release();
    }
  }
}

export class MemoryLedgerStream implements LedgerStream {
  readonly initialOffset = 'empty:/+';
  records: Uint8Array[] = [];
  pageSize = 4096;
  mode: 'ok' | 'lost-response' | 'false-ack' | 'unsupported' = 'ok';
  inflight: Promise<void> | null = null;

  get tail(): string {
    return this.records.length === 0 ? this.initialOffset : `opaque:${this.records.length}/+`;
  }

  async readAfter(offset: string): Promise<LedgerReadPage> {
    const index =
      offset === this.initialOffset
        ? -1
        : this.records.findIndex((_, i) => `opaque:${i + 1}/+` === offset);
    if (index === -1 && offset !== this.initialOffset) fail('canonical');
    const slice = this.records.slice(index + 1, index + 1 + this.pageSize);
    const consumed = index + 1 + slice.length;
    return {
      records: slice.map(copyBytes),
      nextOffset: slice.length === 0 ? this.tail : `opaque:${consumed}/+`,
      upToDate: consumed >= this.records.length,
    };
  }

  async appendCas(
    offset: string,
    record: Uint8Array
  ): Promise<'accepted' | 'conflict' | 'unsupported'> {
    if (this.inflight) await this.inflight;
    if (this.mode === 'unsupported') return 'unsupported';
    if (offset !== this.tail) return 'conflict';
    if (this.mode !== 'false-ack') this.records.push(copyBytes(record));
    if (this.mode === 'lost-response') throw new Error('connection-lost-after-commit');
    return 'accepted';
  }
}
