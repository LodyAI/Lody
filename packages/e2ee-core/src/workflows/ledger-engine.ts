import { Effect, Ref, type Result } from 'effect';
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
import { viewState, type LedgerView } from '../pure/records';
import { stateDigestOf } from '../pure/ledger-snapshot';
import { bytesEqual, copyBytes } from '../pure/cbor';
import { hashRecordBytes } from '../pure/wire-crypto';
import { decodeRecord, type Operation } from '../pure/ledger-schema';
import { selectLedgerPage } from '../pure/ledger-page';
import { SigningFacts } from '../pure/signing-facts';
import { classifyLedgerPresence, classifyUnresolvedSubmit } from '../pure/submit-outcome';
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

/** Verified durable checkpoint. The cache is only evidence for prefix reuse. */
type Session = { readonly journal: LedgerJournal; readonly ledger: LedgerView };
type SessionTransaction = {
  readonly journal: JournalTransaction;
  readonly session: Ref.Ref<Session>;
};
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
    private readonly store: JournalStore['Service'],
    private readonly stream: LedgerTransport['Service'],
    private readonly cached: Ref.Ref<Session | undefined>,
    private readonly verifier: SignatureVerifier['Service'],
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
          yield* Effect.uninterruptible(
            tx
              .save(copyJournal(journal))
              .pipe(Effect.andThen(Ref.set(client.cached, { journal, ledger })))
          );
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
    return LedgerEngine.openSnapshot(input, false);
  }

  /** Compatibility open may reuse an identical existing journal, never replace it. */
  static legacyFromSnapshot(
    input: SnapshotBootstrap
  ): Effect.Effect<LedgerEngine, ClientError, Dependencies> {
    return LedgerEngine.openSnapshot(input, true);
  }

  private static openSnapshot(
    input: SnapshotBootstrap,
    allowExisting: boolean
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
          const loaded = yield* tx.load;
          if (loaded !== null) {
            if (!allowExisting) return yield* Effect.fail(new StorageError({ reason: 'exists' }));
            if (!bytesEqual(loaded.genesis, anchor.toBytes()))
              return yield* invalid('wrong-anchor');
            const existing = yield* client.load(tx);
            if (
              ledger.length !== existing.ledger.length ||
              !bytesEqual(ledger.head.toBytes(), existing.ledger.head.toBytes()) ||
              !bytesEqual(
                yield* Effect.fromResult(stateDigestOf(viewState(ledger))),
                yield* Effect.fromResult(stateDigestOf(viewState(existing.ledger)))
              ) ||
              (loaded.snapshot !== undefined && !bytesEqual(loaded.snapshot, snapshot))
            )
              return yield* invalid('replay');
            // load retained the verified existing view, pending bytes and cursor.
            return undefined;
          }
          const journal: LedgerJournal = {
            genesis: trust.genesis,
            snapshot,
            snapshotTrust: trust,
            records: [],
            pending: null,
            offset: client.stream.initialOffset,
          };
          yield* Effect.uninterruptible(
            tx
              .save(copyJournal(journal))
              .pipe(Effect.andThen(Ref.set(client.cached, { journal, ledger })))
          );
          return undefined;
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
    store: JournalStore['Service'],
    stream: LedgerTransport['Service'],
    verifier: SignatureVerifier['Service']
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
    return this.transaction((tx) =>
      Effect.gen({ self: this }, function* () {
        const session = yield* Ref.get(tx.session);
        const retrying = session.journal.pending !== null;
        if (session.journal.pending !== null && !bytesEqual(session.journal.pending, record)) {
          return yield* Effect.fail(new PendingOperationExists());
        }
        yield* this.synchronize(tx);
        return yield* this.submit(tx, record, retrying);
      })
    ).pipe(Effect.withSpan('LedgerEngine.submitEncoded'));
  }

  /** Each exclusive operation owns its state; no transaction reads another's cache. */
  private transaction<A, E>(
    work: (tx: SessionTransaction) => Effect.Effect<A, E>
  ): Effect.Effect<A, E | ClientError> {
    return this.store.exclusive((tx) =>
      Effect.gen({ self: this }, function* () {
        const loaded = yield* this.load(tx);
        const session = yield* Ref.make(loaded);
        return yield* work({ journal: tx, session });
      })
    );
  }

  private load(tx: JournalTransaction): Effect.Effect<Session, ClientError> {
    return Effect.gen({ self: this }, function* () {
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
                endorser: yield* Effect.fromResult(
                  signingPublicKey(journal.snapshotTrust.endorser)
                ),
                head: yield* Effect.fromResult(recordHash(journal.snapshotTrust.head)),
                headSignature: yield* Effect.fromResult(
                  signature(journal.snapshotTrust.headSignature)
                ),
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

  /** Persists first; only then does the new session become visible. */
  private save(
    tx: SessionTransaction,
    journal: LedgerJournal,
    ledger?: LedgerView
  ): Effect.Effect<Session, ClientError> {
    return Effect.gen({ self: this }, function* () {
      const stable = copyJournal(journal);
      const view = ledger ?? (yield* Ref.get(tx.session)).ledger;
      const next = { journal: stable, ledger: view };
      // Once saved, publish both views before observing cancellation. Network work
      // remains interruptible; saved pages and exact pending bytes survive it.
      yield* Effect.uninterruptible(
        tx.journal
          .save(copyJournal(stable))
          .pipe(
            Effect.andThen(Ref.set(tx.session, next)),
            Effect.andThen(Ref.set(this.cached, next))
          )
      );
      return next;
    });
  }

  private synchronize(tx: SessionTransaction): Effect.Effect<void, ClientError> {
    return Effect.gen({ self: this }, function* () {
      const initial = (yield* Ref.get(tx.session)).journal;
      const seen = new Set([this.stream.initialOffset, initial.offset]);
      const snapshotMode = initial.snapshot !== undefined;
      const snapshotHead = initial.snapshotTrust?.head;
      let bound = !snapshotMode || initial.records.length > 0 || initial.snapshotBound === true;
      let cursor = initial.offset;
      let skippedUnknown = false;
      // Point validity only, not signatures or authority. Carry across pages of
      // a snapshot prefix without making a global cache or trusting that prefix.
      let prefixFacts = SigningFacts.empty;
      for (let pageIndex = 0; pageIndex < MAX_LEDGER_READ_PAGES; pageIndex++) {
        const session = yield* Ref.get(tx.session);
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
        const selected: Result.Result.Success<ReturnType<typeof selectLedgerPage>> =
          yield* Effect.fromResult(
            selectLedgerPage({
              records: page.records,
              ledger: session.ledger,
              snapshotMode,
              snapshotHead,
              bound,
              skippedUnknown,
              prefixFacts,
            })
          );
        const { fresh } = selected;
        ({ bound, skippedUnknown, prefixFacts } = selected);
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
    return this.transaction((tx) =>
      Effect.gen({ self: this }, function* () {
        yield* Ref.get(tx.session);
        yield* this.synchronize(tx);
        return (yield* Ref.get(tx.session)).ledger;
      })
    ).pipe(Effect.withSpan('LedgerEngine.refresh'));
  }

  /** Exact already-verified current publication, when retained in this journal.
   * An endorsed snapshot may not retain that record; never invent provenance. */
  currentEpochPublication() {
    return this.transaction((tx) =>
      Effect.gen({ self: this }, function* () {
        yield* this.synchronize(tx);
        const { journal, ledger } = yield* Ref.get(tx.session);
        const epoch = ledger.inspectState().epoch.number;
        for (const bytes of journal.records) {
          const record = yield* Effect.fromResult(decodeRecord(bytes));
          const b = record.body;
          if (
            (b.type === 'genesis' && epoch === 0) ||
            (b.type === 'ordinary' &&
              b.fields.operation.type === 'publishEpoch' &&
              b.fields.operation.epoch === epoch)
          ) {
            if (ledger.hasRecordHash(hashRecordBytes(bytes))) return new Uint8Array(bytes);
          }
        }
        return null;
      })
    );
  }

  /** Internal recovery guard: absence of the separate candidate is not permission to rotate. */
  hasPendingEpochPublication(): Effect.Effect<boolean, ClientError> {
    return this.transaction((tx) =>
      Effect.gen({ self: this }, function* () {
        const session = yield* Ref.get(tx.session);
        if (session.journal.pending === null) return false;
        const decoded = yield* Effect.fromResult(decodeRecord(session.journal.pending));
        return (
          decoded.body.type === 'ordinary' && decoded.body.fields.operation.type === 'publishEpoch'
        );
      })
    ).pipe(Effect.withSpan('LedgerEngine.hasPendingEpochPublication'));
  }

  /** Internal rotation boundary. Caller must durably save the candidate before submitEncoded. */
  prepareEpochPublication(
    operation: Extract<Operation, { type: 'publishEpoch' }>,
    signer: DeviceSigner['Service']
  ): Effect.Effect<Uint8Array, ClientError> {
    const captured = {
      ...operation,
      commitment: copyBytes(operation.commitment),
      previousEpochKey: copyBytes(operation.previousEpochKey),
    };
    return this.transaction((tx) =>
      Effect.gen({ self: this }, function* () {
        const loaded = yield* Ref.get(tx.session);
        if (loaded.journal.pending !== null)
          return yield* Effect.fail(new PendingOperationExists());
        yield* this.synchronize(tx);
        return yield* this.sign(tx, captured, signer);
      })
    ).pipe(Effect.withSpan('LedgerEngine.prepareEpochPublication'));
  }

  /** Checks policy and nested proofs against the synchronized view, then signs once. */
  private sign(tx: SessionTransaction, operation: Operation, signer: DeviceSigner['Service']) {
    return Effect.gen({ self: this }, function* () {
      const { ledger } = yield* Ref.get(tx.session);
      const proposal = yield* this.withVerifier(
        prepareChecked(ledger, operation, signer.publicKey)
      );
      const signed = yield* signer.sign(proposal.signingBytes);
      const finalized = yield* this.withVerifier(
        finalizePrepared(ledger, proposal.bodyBytes, proposal.previousHash, signed)
      );
      return finalized.record;
    });
  }

  execute(
    command: LedgerCommand,
    signer: DeviceSigner['Service']
  ): Effect.Effect<CommandOutcome, ClientError> {
    const captured =
      command._tag === 'AdmitMember'
        ? { ...command, request: { ...command.request } }
        : { ...command };
    return Effect.suspend(() => {
      const operation = commandOperation(captured);
      return this.transaction((tx) =>
        Effect.gen({ self: this }, function* () {
          const loaded = yield* Ref.get(tx.session);
          if (loaded.journal.pending !== null)
            return yield* Effect.fail(new PendingOperationExists());
          yield* this.synchronize(tx);
          const record = yield* this.sign(tx, operation, signer);
          return yield* this.submit(tx, record, false);
        })
      );
    }).pipe(Effect.withSpan('LedgerEngine.execute', { attributes: { command: captured._tag } }));
  }

  resume(expectedSigner?: SigningPublicKey): Effect.Effect<ResumeOutcome, ClientError> {
    return this.transaction((tx) =>
      Effect.gen({ self: this }, function* () {
        const session = yield* Ref.get(tx.session);
        const pending = session.journal.pending;
        if (pending !== null && expectedSigner !== undefined) {
          const parsed = yield* Effect.fromResult(decodeRecord(pending));
          if (!bytesEqual(parsed.body.fields.signer, expectedSigner.toBytes())) {
            return yield* Effect.fail(new ContextMismatch({ context: 'signer' }));
          }
        }
        yield* this.synchronize(tx);
        if (pending === null)
          return { _tag: 'Idle', ledger: (yield* Ref.get(tx.session)).ledger } as const;
        return yield* this.submit(tx, pending, true);
      })
    ).pipe(Effect.withSpan('LedgerEngine.resume'));
  }

  private submit(
    tx: SessionTransaction,
    record: Uint8Array,
    retrying: boolean
  ): Effect.Effect<CommandOutcome, ClientError> {
    return Effect.gen({ self: this }, function* () {
      const parsed = yield* Effect.fromResult(decodeRecord(record));
      if (parsed.body.type !== 'ordinary') return yield* invalid('genesis-mismatch');
      const parent = parsed.body.fields.previousHash;
      const hash = hashRecordBytes(record);
      const reconcile = Effect.gen({ self: this }, function* () {
        const { journal, ledger } = yield* Ref.get(tx.session);
        const presence = classifyLedgerPresence({
          containsRecord: ledger.hasRecordHash(hash),
          parentIsHead: bytesEqual(parent, ledger.head.toBytes()),
        });
        if (presence === 'absent') return undefined;
        yield* this.save(tx, { ...journal, pending: null });
        const tag = presence === 'committed' ? 'Committed' : 'Conflict';
        return { _tag: tag, ledger } as const;
      });
      const prior = yield* reconcile;
      if (prior) return prior;
      const before = yield* Ref.get(tx.session);
      yield* this.withVerifier(extendLedger(before.ledger, [record]));
      yield* Effect.uninterruptible(this.save(tx, { ...before.journal, pending: record }));
      const cas = yield* this.stream
        .appendCas(before.journal.offset, copyBytes(record))
        .pipe(Effect.catchTag('TransportError', () => Effect.succeed('unknown' as const)));
      // A failed read keeps every page it already saved: the session is re-read below.
      const refreshed = yield* this.synchronize(tx).pipe(
        Effect.as(true),
        Effect.catchTag('TransportError', () => Effect.succeed(false))
      );
      if (refreshed) {
        const observed = yield* reconcile;
        if (observed) return observed;
      }
      const after = yield* Ref.get(tx.session);
      if (classifyUnresolvedSubmit({ cas, retrying }) === 'unsupported') {
        yield* this.save(tx, { ...after.journal, pending: null });
        return { _tag: 'Unsupported', ledger: after.ledger } as const;
      }
      return { _tag: 'Pending', ledger: after.ledger } as const;
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
