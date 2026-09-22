import { Effect, Ref } from 'effect';
import {
  DeviceSigner,
  JournalStore,
  LedgerTransport,
  SignatureVerifier,
  type JournalTransaction,
} from '../ports/ledger';
import {
  PendingOperationExists,
  ContextMismatch,
  StorageError,
  ValidationError,
  type ClientError,
} from '../pure/errors';
import { commandOperation, type LedgerCommand } from '../pure/commands';
import {
  recordHash,
  signature,
  signingPublicKey,
  type GenesisHash,
  type RecordHash,
  type Signature,
  type SigningPublicKey,
} from '../pure/bytes';
import type { LedgerView } from '../pure/records';
import { bytesEqual, copyBytes } from '../pure/cbor';
import type { SigningPointCache } from '../ledger/crypto';
import { hashRecordBytes } from '../pure/wire-crypto';
import { decodeRecord, type Operation } from '../pure/ledger-schema';
import {
  MAX_LEDGER_RECORDS,
  MAX_LEDGER_READ_PAGES,
  MAX_LEDGER_READ_PAGE_RECORDS,
  type LedgerJournal,
} from '../pure/journal';
import {
  extendLedger,
  finalizePrepared,
  prepareChecked,
  verifyLedger,
  verifySnapshot,
} from './verification';

export type CommandOutcome =
  | { readonly _tag: 'Committed'; readonly ledger: LedgerView }
  | { readonly _tag: 'Conflict'; readonly ledger: LedgerView }
  | { readonly _tag: 'Pending'; readonly ledger: LedgerView }
  | { readonly _tag: 'Unsupported'; readonly ledger: LedgerView };
export type ResumeOutcome = CommandOutcome | { readonly _tag: 'Idle'; readonly ledger: LedgerView };

export interface SnapshotBootstrap {
  readonly genesis: GenesisHash;
  readonly endorser: SigningPublicKey;
  readonly head: RecordHash;
  readonly headSignature: Signature;
  readonly snapshot: Uint8Array;
}

type Session = { journal: LedgerJournal; ledger: LedgerView };
type Dependencies = JournalStore | LedgerTransport | SignatureVerifier;

function copyJournal(journal: LedgerJournal): LedgerJournal {
  return {
    ...journal,
    genesis: copyBytes(journal.genesis),
    records: journal.records.map(copyBytes),
    pending: journal.pending === null ? null : copyBytes(journal.pending),
    snapshot: journal.snapshot === undefined ? undefined : copyBytes(journal.snapshot),
    snapshotTrust:
      journal.snapshotTrust === undefined
        ? undefined
        : {
            genesis: copyBytes(journal.snapshotTrust.genesis),
            endorser: copyBytes(journal.snapshotTrust.endorser),
            head: copyBytes(journal.snapshotTrust.head),
            headSignature: copyBytes(journal.snapshotTrust.headSignature),
          },
  };
}

function offset(value: string) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && value !== 'now'
    ? Effect.void
    : Effect.fail(new ValidationError({ code: 'invalid-operation' }));
}

/** Owns the device, Org and exact pending submission. No internal Effect runtime. */
export class LedgerEngine {
  private constructor(
    private readonly anchor: GenesisHash,
    private readonly store: JournalStore['Type'],
    private readonly stream: LedgerTransport['Type'],
    private readonly cached: Ref.Ref<Session | undefined>,
    private readonly verifier: SignatureVerifier['Type'],
    private readonly initialRecord?: Uint8Array
  ) {}

  private withVerifier<A, E, R>(effect: Effect.Effect<A, E, R>) {
    return effect.pipe(Effect.provideService(SignatureVerifier, this.verifier));
  }

  static create(input: {
    readonly anchor: GenesisHash;
    readonly genesisRecord: Uint8Array;
  }): Effect.Effect<LedgerEngine, ClientError, Dependencies> {
    const record = copyBytes(input.genesisRecord);
    const anchor = input.anchor;
    return Effect.gen(function* () {
      const client = yield* LedgerEngine.make(anchor);
      const ledger = yield* client.withVerifier(verifyLedger({ anchor, records: [record] }));
      yield* client.store.exclusive((tx) =>
        Effect.gen(function* () {
          if ((yield* tx.load) !== null) yield* Effect.fail(new StorageError({ reason: 'exists' }));
          const journal: LedgerJournal = {
            genesis: anchor.toBytes(),
            records: [record],
            pending: null,
            offset: client.stream.initialOffset,
          };
          yield* Effect.uninterruptible(tx.save(copyJournal(journal)));
          yield* Ref.set(client.cached, { journal, ledger });
        })
      );
      return client;
    });
  }

  static restore(anchor: GenesisHash): Effect.Effect<LedgerEngine, ClientError, Dependencies> {
    return Effect.gen(function* () {
      const client = yield* LedgerEngine.make(anchor);
      yield* client.store.exclusive((tx) => client.load(tx));
      return client;
    });
  }

  /** The endorser/genesis/head must be obtained independently of the snapshot. */
  static createFromSnapshot(
    input: SnapshotBootstrap
  ): Effect.Effect<LedgerEngine, ClientError, Dependencies> {
    const snapshot = copyBytes(input.snapshot);
    const anchor = input.genesis;
    const trust = {
      genesis: input.genesis.toBytes(),
      endorser: input.endorser.toBytes(),
      head: input.head.toBytes(),
      headSignature: input.headSignature.toBytes(),
    };
    return Effect.gen(function* () {
      const client = yield* LedgerEngine.make(anchor);
      const ledger = yield* client.withVerifier(
        verifySnapshot({
          genesis: input.genesis,
          endorser: input.endorser,
          head: input.head,
          headSignature: input.headSignature,
          snapshot,
        })
      );
      yield* client.store.exclusive((tx) =>
        Effect.gen(function* () {
          if ((yield* tx.load) !== null) yield* Effect.fail(new StorageError({ reason: 'exists' }));
          const journal: LedgerJournal = {
            genesis: trust.genesis,
            snapshot,
            snapshotTrust: trust,
            records: [],
            pending: null,
            offset: client.stream.initialOffset,
          };
          yield* Effect.uninterruptible(tx.save(copyJournal(journal)));
          yield* Ref.set(client.cached, { journal, ledger });
        })
      );
      return client;
    });
  }

  private static make(
    anchor: GenesisHash
  ): Effect.Effect<LedgerEngine, ValidationError, Dependencies> {
    return Effect.gen(function* () {
      const store = yield* JournalStore;
      const stream = yield* LedgerTransport;
      const verifier = yield* SignatureVerifier;
      yield* offset(stream.initialOffset);
      const cache = yield* Ref.make<Session | undefined>(undefined);
      return new LedgerEngine(anchor, store, stream, cache, verifier);
    });
  }

  /** Temporary compatibility entry: the old API lazily initializes a missing journal.
   * New callers use create/restore and cannot accidentally recreate missing storage. */
  static legacy(
    anchor: GenesisHash,
    record: Uint8Array | null,
    store: JournalStore['Type'],
    stream: LedgerTransport['Type'],
    verifier: SignatureVerifier['Type'],
    _pointCache?: SigningPointCache
  ): Effect.Effect<LedgerEngine, ValidationError> {
    return Effect.gen(function* () {
      yield* offset(stream.initialOffset);
      const cache = yield* Ref.make<Session | undefined>(undefined);
      return new LedgerEngine(
        anchor,
        store,
        stream,
        cache,
        verifier,
        record === null ? undefined : copyBytes(record)
      );
    });
  }

  /** Advanced migration/audit boundary. Always verifies bytes against the current view. */
  submitEncoded(input: Uint8Array): Effect.Effect<CommandOutcome, ClientError> {
    const record = copyBytes(input);
    return this.store.exclusive((tx) =>
      Effect.gen(this, function* () {
        const session = yield* this.load(tx);
        const retrying = session.journal.pending !== null;
        if (session.journal.pending !== null && !bytesEqual(session.journal.pending, record)) {
          return yield* Effect.fail(new PendingOperationExists());
        }
        yield* this.synchronize(tx, session);
        return yield* this.submit(tx, session, record, retrying);
      })
    );
  }

  private load(tx: JournalTransaction): Effect.Effect<Session, ClientError> {
    return Effect.gen(this, function* () {
      const loaded = yield* tx.load;
      if (loaded === null && this.initialRecord === undefined)
        return yield* Effect.fail(new StorageError({ reason: 'missing' }));
      const journal = copyJournal(
        loaded ?? {
          genesis: this.anchor.toBytes(),
          records: this.initialRecord ? [this.initialRecord] : [],
          pending: null,
          offset: this.stream.initialOffset,
        }
      );
      if (
        (journal.snapshot === undefined) !== (journal.snapshotTrust === undefined) ||
        (journal.snapshotBound !== undefined &&
          (journal.snapshotBound !== true || journal.snapshot === undefined))
      ) {
        return yield* Effect.fail(new StorageError({ reason: 'corrupt' }));
      }
      if (!bytesEqual(journal.genesis, this.anchor.toBytes()))
        return yield* Effect.fail(new StorageError({ reason: 'foreign' }));
      yield* offset(journal.offset);
      if (journal.records.length > MAX_LEDGER_RECORDS)
        return yield* Effect.fail(new ValidationError({ code: 'oversize' }));
      const previous = yield* Ref.get(this.cached);
      // Exact persisted bytes, including snapshot trust, are the cache identity.
      // A matching head alone must never import a different authorization state.
      const sameSnapshot = previous !== undefined && sameSnapshotBytes(previous.journal, journal);
      const prefix =
        previous !== undefined &&
        sameSnapshot &&
        journal.records.length >= previous.journal.records.length &&
        previous.journal.records.every((row, i) => {
          const other = journal.records[i];
          return other !== undefined && bytesEqual(row, other);
        });
      // Once a view is observed, reloading is not permission to replace its
      // authenticated prefix, even with another valid endorsement at the same head.
      if (
        previous &&
        (!prefix || (previous.journal.snapshotBound === true && journal.snapshotBound !== true))
      ) {
        return yield* Effect.fail(new ValidationError({ code: 'replay' }));
      }
      const ledger = prefix
        ? yield* this.withVerifier(
            extendLedger(previous.ledger, journal.records.slice(previous.journal.records.length))
          )
        : journal.snapshot && journal.snapshotTrust
          ? yield* this.withVerifier(
              verifySnapshot({
                genesis: this.anchor,
                endorser: yield* signingPublicKey(journal.snapshotTrust.endorser),
                head: yield* recordHash(journal.snapshotTrust.head),
                headSignature: yield* signature(journal.snapshotTrust.headSignature),
                snapshot: journal.snapshot,
                suffix: journal.records,
              })
            )
          : yield* this.withVerifier(
              verifyLedger({
                anchor: this.anchor,
                records: journal.records,
              })
            );
      const session = { journal, ledger };
      yield* Ref.set(this.cached, session);
      return session;
    });
  }

  private save(
    tx: JournalTransaction,
    session: Session,
    journal: LedgerJournal,
    ledger = session.ledger
  ) {
    return Effect.gen(this, function* () {
      const stable = copyJournal(journal);
      yield* Effect.uninterruptible(tx.save(copyJournal(stable)));
      session.journal = stable;
      session.ledger = ledger;
      yield* Ref.set(this.cached, { journal: stable, ledger });
    });
  }

  private synchronize(tx: JournalTransaction, session: Session): Effect.Effect<void, ClientError> {
    return Effect.gen(this, function* () {
      const seen = new Set([this.stream.initialOffset, session.journal.offset]);
      const snapshotMode = session.journal.snapshot !== undefined;
      const snapshotHead = session.journal.snapshotTrust?.head;
      let bound =
        !snapshotMode ||
        session.journal.records.length > 0 ||
        session.journal.snapshotBound === true;
      let cursor = session.journal.offset;
      let skippedUnknown = false;
      for (let pageIndex = 0; pageIndex < MAX_LEDGER_READ_PAGES; pageIndex++) {
        const page = yield* this.stream.readAfter(cursor);
        yield* offset(page.nextOffset);
        if (!Array.isArray(page.records) || typeof page.upToDate !== 'boolean')
          return yield* invalid('canonical');
        if (page.records.length === 0) {
          if (!page.upToDate) return yield* invalid('canonical');
          if (page.nextOffset === cursor) {
            if (snapshotMode && !bound && skippedUnknown) return yield* invalid('wrong-parent');
            return yield* Effect.void;
          }
          if (session.journal.records.length !== 1 && !snapshotMode)
            return yield* invalid('canonical');
        }
        if (seen.has(page.nextOffset) && page.records.length > 0) return yield* invalid('replay');
        if (page.records.length > MAX_LEDGER_RECORDS) return yield* invalid('oversize');
        const fresh: Uint8Array[] = [];
        let expectedParent: Uint8Array = session.ledger.head.toBytes();
        for (const input of page.records) {
          if (!(input instanceof Uint8Array)) return yield* invalid('canonical');
          const record = copyBytes(input);
          const hash = hashRecordBytes(record);
          const wasBound = bound;
          if (session.ledger.hasRecordHash(hash)) {
            if (snapshotHead && bytesEqual(hash, snapshotHead)) bound = true;
            if (snapshotMode && wasBound) return yield* invalid('wrong-parent');
            continue;
          }
          if (snapshotMode) {
            const decoded = yield* decodeRecord(record);
            if (decoded.body.type === 'genesis') {
              if (wasBound) return yield* invalid('wrong-parent');
              skippedUnknown = true;
              continue;
            }
            if (bytesEqual(decoded.body.fields.previousHash, expectedParent)) {
              bound = true;
              fresh.push(record);
              expectedParent = new Uint8Array(hash);
              continue;
            }
            if (!wasBound) {
              skippedUnknown = true;
              continue;
            }
            return yield* invalid('wrong-parent');
          }
          fresh.push(record);
        }
        if (snapshotMode && !bound && skippedUnknown) {
          if (page.upToDate) return yield* invalid('wrong-parent');
          cursor = page.nextOffset;
          seen.add(cursor);
          continue;
        }
        if (session.journal.records.length + fresh.length > MAX_LEDGER_RECORDS)
          return yield* invalid('oversize');
        let ledger = session.ledger;
        for (let i = 0; i < fresh.length; i += MAX_LEDGER_READ_PAGE_RECORDS) {
          const suffix = fresh.slice(i, i + MAX_LEDGER_READ_PAGE_RECORDS);
          const prior = ledger;
          ledger = yield* this.withVerifier(extendLedger(prior, suffix));
        }
        yield* this.save(
          tx,
          session,
          {
            ...session.journal,
            offset: page.nextOffset,
            records: [...session.journal.records, ...fresh],
            snapshotBound: snapshotMode && bound ? true : undefined,
          },
          ledger
        );
        cursor = page.nextOffset;
        seen.add(cursor);
        if (page.upToDate) return yield* Effect.void;
      }
      return yield* invalid('oversize');
    });
  }

  refresh(): Effect.Effect<LedgerView, ClientError> {
    return this.store.exclusive((tx) =>
      Effect.gen(this, function* () {
        const session = yield* this.load(tx);
        yield* this.synchronize(tx, session);
        return session.ledger;
      })
    );
  }

  /** Internal recovery guard: absence of the separate candidate is not permission to rotate. */
  hasPendingEpochPublication(): Effect.Effect<boolean, ClientError> {
    return this.store.exclusive((tx) =>
      Effect.gen(this, function* () {
        const session = yield* this.load(tx);
        if (session.journal.pending === null) return false;
        const decoded = yield* decodeRecord(session.journal.pending);
        return (
          decoded.body.type === 'ordinary' && decoded.body.fields.operation.type === 'publishEpoch'
        );
      })
    );
  }

  /** Internal rotation boundary. Caller must durably save the candidate before submitEncoded. */
  prepareEpochPublication(
    operation: Extract<Operation, { type: 'publishEpoch' }>,
    signer: DeviceSigner['Type']
  ): Effect.Effect<Uint8Array, ClientError> {
    const captured = {
      ...operation,
      commitment: copyBytes(operation.commitment),
      previousEpochKey: copyBytes(operation.previousEpochKey),
    };
    return this.store.exclusive((tx) =>
      Effect.gen(this, function* () {
        const session = yield* this.load(tx);
        if (session.journal.pending !== null)
          return yield* Effect.fail(new PendingOperationExists());
        yield* this.synchronize(tx, session);
        const proposal = yield* this.withVerifier(
          prepareChecked(session.ledger, captured, signer.publicKey)
        );
        const signed = yield* signer.sign(proposal.signingBytes);
        return (yield* this.withVerifier(
          finalizePrepared(session.ledger, proposal.bodyBytes, proposal.previousHash, signed)
        )).record;
      })
    );
  }

  execute(
    command: LedgerCommand,
    signer: DeviceSigner['Type']
  ): Effect.Effect<CommandOutcome, ClientError> {
    const captured =
      command._tag === 'AdmitMember'
        ? { ...command, request: { ...command.request } }
        : { ...command };
    return Effect.suspend(() => {
      const operation = commandOperation(captured);
      return this.store.exclusive((tx) =>
        Effect.gen(this, function* () {
          const session = yield* this.load(tx);
          if (session.journal.pending !== null)
            return yield* Effect.fail(new PendingOperationExists());
          yield* this.synchronize(tx, session);
          const proposal = yield* this.withVerifier(
            prepareChecked(session.ledger, operation, signer.publicKey)
          );
          const signed = yield* signer.sign(proposal.signingBytes);
          const record = (yield* this.withVerifier(
            finalizePrepared(session.ledger, proposal.bodyBytes, proposal.previousHash, signed)
          )).record;
          return yield* this.submit(tx, session, record, false);
        })
      );
    });
  }

  resume(expectedSigner?: SigningPublicKey): Effect.Effect<ResumeOutcome, ClientError> {
    return this.store.exclusive((tx) =>
      Effect.gen(this, function* () {
        const session = yield* this.load(tx);
        const pending = session.journal.pending;
        if (pending !== null && expectedSigner !== undefined) {
          const parsed = yield* decodeRecord(pending);
          if (!bytesEqual(parsed.body.fields.signer, expectedSigner.toBytes())) {
            return yield* Effect.fail(new ContextMismatch({ context: 'signer' }));
          }
        }
        yield* this.synchronize(tx, session);
        if (pending === null) return { _tag: 'Idle', ledger: session.ledger } as const;
        return yield* this.submit(tx, session, pending, true);
      })
    );
  }

  private submit(
    tx: JournalTransaction,
    session: Session,
    record: Uint8Array,
    retrying: boolean
  ): Effect.Effect<CommandOutcome, ClientError> {
    return Effect.gen(this, function* () {
      const parsed = yield* decodeRecord(record);
      if (parsed.body.type !== 'ordinary') return yield* invalid('genesis-mismatch');
      const parent = parsed.body.fields.previousHash;
      const hash = hashRecordBytes(record);
      const reconcile = () =>
        Effect.gen(this, function* () {
          const tag = session.ledger.hasRecordHash(hash)
            ? 'Committed'
            : !bytesEqual(parent, session.ledger.head.toBytes())
              ? 'Conflict'
              : undefined;
          if (tag === undefined) return undefined;
          yield* this.save(tx, session, { ...session.journal, pending: null });
          return { _tag: tag, ledger: session.ledger } as const;
        });
      const prior = yield* reconcile();
      if (prior) return prior;
      yield* this.withVerifier(extendLedger(session.ledger, [record]));
      yield* Effect.uninterruptible(
        this.save(tx, session, { ...session.journal, pending: record })
      );
      const cas = yield* this.stream
        .appendCas(session.journal.offset, copyBytes(record))
        .pipe(Effect.catchTag('TransportError', () => Effect.succeed('unknown' as const)));
      const refreshed = yield* this.synchronize(tx, session).pipe(
        Effect.map(() => true),
        Effect.catchTag('TransportError', () => Effect.succeed(false))
      );
      if (refreshed) {
        const observed = yield* reconcile();
        if (observed) return observed;
      }
      if (cas === 'unsupported' && !retrying) {
        yield* this.save(tx, session, { ...session.journal, pending: null });
        return { _tag: 'Unsupported', ledger: session.ledger } as const;
      }
      return { _tag: 'Pending', ledger: session.ledger } as const;
    });
  }
}

function invalid(code: ValidationError['code']): Effect.Effect<never, ValidationError> {
  return Effect.fail(new ValidationError({ code }));
}

function sameSnapshotBytes(a: LedgerJournal, b: LedgerJournal): boolean {
  if (a.snapshot === undefined || b.snapshot === undefined)
    return a.snapshot === b.snapshot && a.snapshotTrust === b.snapshotTrust;
  if (
    !bytesEqual(a.snapshot, b.snapshot) ||
    a.snapshotTrust === undefined ||
    b.snapshotTrust === undefined
  )
    return false;
  return (
    bytesEqual(a.snapshotTrust.genesis, b.snapshotTrust.genesis) &&
    bytesEqual(a.snapshotTrust.head, b.snapshotTrust.head) &&
    bytesEqual(a.snapshotTrust.endorser, b.snapshotTrust.endorser) &&
    bytesEqual(a.snapshotTrust.headSignature, b.snapshotTrust.headSignature)
  );
}
