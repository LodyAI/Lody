import { Effect } from 'effect';
import { runPromiseThrow } from '../effect-run';
import { copyBytes, bytesEqual } from './cbor';
import { hashRecord, type Hash } from './crypto';
import { fail } from './error';
import { Ledger } from './ledger';
import { decodeRecord } from './schema';
import type { SnapshotTrust } from './snapshot';
import {
  classifyLedgerPresence,
  classifyUnresolvedSubmit,
  ordinaryPreviousHash,
  selectSubmitWire,
} from './submit-decision';

/** Cumulative verified records a client may retain. 10k from-zero chains must fit. */
export const MAX_LEDGER_RECORDS = 16_384;
/** Extend/work chunk. Adapter HTTP pages may be larger; refresh slices instead of rejecting. */
export const MAX_LEDGER_READ_PAGE_RECORDS = 1_024;
export const MAX_LEDGER_READ_PAGES = 256;
/** @deprecated Use MAX_LEDGER_RECORDS. Kept as the cumulative read budget alias. */
export const MAX_LEDGER_READ_RECORDS = MAX_LEDGER_RECORDS;

export interface LedgerJournal {
  readonly genesis: Uint8Array;
  readonly records: readonly Uint8Array[];
  readonly pending: Uint8Array | null;
  readonly offset: string;
  readonly snapshot?: Uint8Array;
  readonly snapshotTrust?: SnapshotTrust;
  /** True after the authenticated snapshot head is observed or a suffix extends it. */
  readonly snapshotBound?: boolean;
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

function copyTrust(trust: SnapshotTrust): SnapshotTrust {
  return {
    genesis: copyBytes(trust.genesis),
    endorser: copyBytes(trust.endorser),
    head: copyBytes(trust.head),
    headSignature: copyBytes(trust.headSignature),
  };
}

function copyJournal(journal: LedgerJournal): LedgerJournal {
  return {
    genesis: copyBytes(journal.genesis),
    records: copyRecordList(journal.records),
    pending: journal.pending === null ? null : copyBytes(journal.pending),
    offset: journal.offset,
    snapshot: journal.snapshot ? copyBytes(journal.snapshot) : undefined,
    snapshotTrust: journal.snapshotTrust ? copyTrust(journal.snapshotTrust) : undefined,
    snapshotBound: journal.snapshotBound === true ? true : undefined,
  };
}

async function containsHash(ledger: Ledger, record: Uint8Array): Promise<boolean> {
  return ledger.hasRecordHash(await hashRecord(record));
}

export class LedgerClient {
  private readonly anchor: Hash;
  private readonly genesisRecord: Uint8Array | null;

  constructor(
    genesisRecord: Uint8Array | null,
    anchor: Hash,
    private readonly store: LedgerStore,
    private readonly stream: LedgerStream
  ) {
    if (!(anchor instanceof Uint8Array)) fail('canonical');
    if (genesisRecord !== null && !(genesisRecord instanceof Uint8Array)) fail('canonical');
    this.genesisRecord = genesisRecord === null ? null : copyBytes(genesisRecord);
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

  static async openFromSnapshot(input: {
    trust: SnapshotTrust;
    snapshot: Uint8Array;
    store: LedgerStore;
    stream: LedgerStream;
  }): Promise<LedgerClient> {
    const snapshot = copyBytes(input.snapshot);
    const trust = copyTrust(input.trust);
    const incoming = await Ledger.verifySnapshot({ trust, snapshot, suffix: [] });
    const client = new LedgerClient(null, trust.genesis, input.store, input.stream);
    await input.store.exclusive(async (tx) => {
      const loaded = await tx.load();
      if (loaded) {
        if (!bytesEqual(loaded.genesis, trust.genesis)) fail('wrong-anchor');
        const existing =
          loaded.snapshot && loaded.snapshotTrust
            ? await Ledger.verifySnapshot({
                trust: loaded.snapshotTrust,
                snapshot: loaded.snapshot,
                suffix: loaded.records,
              })
            : loaded.records.length === 0
              ? fail('genesis-mismatch')
              : await Ledger.verify({ anchor: loaded.genesis, records: loaded.records });
        if (incoming.length < existing.length) fail('replay');
        if (incoming.length === existing.length) {
          if (!bytesEqual(incoming.head, existing.head)) fail('replay');
          const incomingDigest = incoming.comparisonNote(trust.endorser).stateDigest;
          const existingDigest = existing.comparisonNote(trust.endorser).stateDigest;
          if (!bytesEqual(incomingDigest, existingDigest)) fail('replay');
          if (loaded.snapshot && !bytesEqual(loaded.snapshot, snapshot)) fail('replay');
          return;
        }
        fail('replay');
      }
      await tx.save({
        genesis: copyBytes(trust.genesis),
        records: [],
        pending: null,
        offset: input.stream.initialOffset,
        snapshot,
        snapshotTrust: trust,
      });
    });
    return client;
  }

  static async openJournal(
    genesis: Hash,
    store: LedgerStore,
    stream: LedgerStream
  ): Promise<LedgerClient> {
    const client = new LedgerClient(null, genesis, store, stream);
    await store.exclusive(async (tx) => {
      const loaded = await tx.load();
      if (!loaded) fail('invalid-operation');
      if (!bytesEqual(loaded.genesis, genesis)) fail('wrong-anchor');
    });
    return client;
  }

  private async save(
    tx: LedgerTransaction,
    session: Session,
    pending: Uint8Array | null,
    offset = session.journal.offset,
    records = session.journal.records,
    snapshotBound = session.journal.snapshotBound
  ): Promise<void> {
    const next: LedgerJournal = {
      genesis: this.anchor,
      records: copyRecordList(records),
      pending: pending === null ? null : copyBytes(pending),
      offset,
      snapshot: session.journal.snapshot ? copyBytes(session.journal.snapshot) : undefined,
      snapshotTrust: session.journal.snapshotTrust
        ? copyTrust(session.journal.snapshotTrust)
        : undefined,
      snapshotBound: snapshotBound === true ? true : undefined,
    };
    await tx.save(copyJournal(next));
    session.journal = next;
  }

  private async load(tx: LedgerTransaction): Promise<Session> {
    const loaded = await tx.load();
    const journal = loaded
      ? copyJournal(loaded)
      : this.genesisRecord
        ? {
            genesis: copyBytes(this.anchor),
            records: [copyBytes(this.genesisRecord)],
            pending: null,
            offset: this.stream.initialOffset,
          }
        : fail('invalid-operation');
    if (!bytesEqual(journal.genesis, this.anchor)) fail('wrong-anchor');
    checkOffset(journal.offset);
    const ledger =
      journal.snapshot && journal.snapshotTrust
        ? await Ledger.verifySnapshot({
            trust: journal.snapshotTrust,
            snapshot: journal.snapshot,
            suffix: journal.records,
          })
        : journal.records.length === 0
          ? fail('genesis-mismatch')
          : await Ledger.verify({ anchor: this.anchor, records: journal.records });
    return { journal, ledger };
  }

  private async refresh(tx: LedgerTransaction, session: Session): Promise<void> {
    const seen = new Set([this.stream.initialOffset, session.journal.offset]);
    const snapshotMode = session.journal.snapshot !== undefined;
    const snapshotHead = session.journal.snapshotTrust
      ? copyBytes(session.journal.snapshotTrust.head)
      : null;
    let bound =
      !snapshotMode || session.journal.records.length > 0 || session.journal.snapshotBound === true;
    let readOffset = session.journal.offset;
    let skippedUnknown = false;

    const applyFresh = async (
      fresh: Uint8Array[]
    ): Promise<{ ledger: Ledger; records: Uint8Array[] }> => {
      if (session.journal.records.length + fresh.length > MAX_LEDGER_RECORDS) fail('oversize');
      let ledger = session.ledger;
      let records = [...session.journal.records];
      for (let i = 0; i < fresh.length; i += MAX_LEDGER_READ_PAGE_RECORDS) {
        const slice = fresh.slice(i, i + MAX_LEDGER_READ_PAGE_RECORDS);
        ledger = await ledger.extend(slice);
        records = [...records, ...slice];
      }
      return { ledger, records };
    };

    for (let pageCount = 0; pageCount < MAX_LEDGER_READ_PAGES; pageCount++) {
      const page = await this.stream.readAfter(readOffset);
      checkOffset(page.nextOffset);
      if (!Array.isArray(page.records)) fail('canonical');
      if (typeof page.upToDate !== 'boolean') fail('canonical');
      if (page.records.length === 0) {
        if (!page.upToDate) fail('canonical');
        if (page.nextOffset === readOffset) {
          if (snapshotMode && !bound && skippedUnknown) fail('wrong-parent');
          return;
        }
        if (session.journal.records.length !== 1 && !session.journal.snapshot) fail('canonical');
      }
      if (seen.has(page.nextOffset) && page.records.length > 0) fail('replay');
      if (page.records.length > MAX_LEDGER_RECORDS) fail('oversize');
      const copied = copyRecordList(page.records);
      const fresh: Uint8Array[] = [];
      let expectedParent = session.ledger.head;
      for (const record of copied) {
        const digest = await hashRecord(record);
        const wasBound = bound;
        if (session.ledger.hasRecordHash(digest)) {
          if (snapshotHead && bytesEqual(digest, snapshotHead)) bound = true;
          if (snapshotMode && wasBound) fail('wrong-parent');
          continue;
        }
        if (snapshotMode) {
          const decoded = decodeRecord(record);
          if (decoded.body.type === 'genesis') {
            if (wasBound) fail('wrong-parent');
            skippedUnknown = true;
            continue;
          }
          if (decoded.body.type !== 'ordinary') fail('canonical');
          if (bytesEqual(decoded.body.fields.previousHash, expectedParent)) {
            bound = true;
            fresh.push(record);
            expectedParent = digest;
            continue;
          }
          if (!wasBound) {
            skippedUnknown = true;
            continue;
          }
          fail('wrong-parent');
        }
        fresh.push(record);
      }
      if (snapshotMode && !bound && skippedUnknown && page.upToDate) fail('wrong-parent');
      if (snapshotMode && !bound && skippedUnknown) {
        readOffset = page.nextOffset;
        seen.add(page.nextOffset);
        if (page.upToDate) fail('wrong-parent');
        continue;
      }
      const applied = await applyFresh(fresh);
      await this.save(
        tx,
        session,
        session.journal.pending,
        page.nextOffset,
        applied.records,
        snapshotMode && bound ? true : undefined
      );
      session.ledger = applied.ledger;
      readOffset = page.nextOffset;
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
    return runPromiseThrow(this.submitEffect(record));
  }

  async resume(): Promise<LedgerSubmitResult> {
    return runPromiseThrow(this.resumeEffect());
  }

  /** Same implementation as `submit`. Promise methods are thin runPromise wrappers. */
  submitEffect(record: Uint8Array): Effect.Effect<LedgerSubmitResult, unknown> {
    if (!(record instanceof Uint8Array)) fail('canonical');
    decodeRecord(record);
    return this.runEffect(copyBytes(record));
  }

  resumeEffect(): Effect.Effect<LedgerSubmitResult, unknown> {
    return this.runEffect();
  }

  private runEffect(requested?: Uint8Array): Effect.Effect<LedgerSubmitResult, unknown> {
    // Promise LedgerStore is the adapter boundary. One runtime at submit/resume.
    return tryCall(() =>
      this.store.exclusive((tx) => Effect.runPromise(this.submitSteps(tx, requested)))
    );
  }

  private submitSteps(
    tx: LedgerTransaction,
    requested?: Uint8Array
  ): Effect.Effect<LedgerSubmitResult, unknown> {
    return Effect.gen(this, function* () {
      const session = yield* tryCall(() => this.load(tx));
      const retrying = session.journal.pending !== null;
      const wire = selectSubmitWire(session.journal.pending, requested);
      const previousHash = ordinaryPreviousHash(wire);
      yield* tryCall(() => this.refresh(tx, session));

      const reconcile = (): Effect.Effect<LedgerSubmitResult | undefined, unknown> =>
        Effect.gen(this, function* () {
          const presence = classifyLedgerPresence({
            containsWire: yield* tryCall(() => containsHash(session.ledger, wire)),
            previousMatchesHead: bytesEqual(previousHash, session.ledger.head),
          });
          if (presence === 'absent') return undefined;
          yield* tryCall(() => this.save(tx, session, null));
          return { status: presence, ledger: session.ledger };
        });

      const prior = yield* reconcile();
      if (prior) return prior;
      yield* tryCall(() => session.ledger.extend([wire]));
      yield* Effect.uninterruptible(tryCall(() => this.save(tx, session, wire)));
      const cas = yield* appendCas(this.stream, session.journal.offset, wire);
      yield* tryCall(() => this.refresh(tx, session));
      const observed = yield* reconcile();
      if (observed) return observed;
      const unresolved = classifyUnresolvedSubmit({ cas, retrying });
      if (unresolved === 'unsupported') {
        yield* tryCall(() => this.save(tx, session, null));
      }
      return { status: unresolved, ledger: session.ledger };
    });
  }
}

function tryCall<A>(fn: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: fn, catch: (error) => error });
}

function appendCas(
  stream: LedgerStream,
  offset: string,
  record: Uint8Array
): Effect.Effect<'accepted' | 'conflict' | 'unsupported' | 'unknown', never> {
  return tryCall(() => stream.appendCas(offset, record)).pipe(
    Effect.catchAll(() => Effect.succeed('unknown' as const))
  );
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
  pageSize = MAX_LEDGER_READ_PAGE_RECORDS;
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
