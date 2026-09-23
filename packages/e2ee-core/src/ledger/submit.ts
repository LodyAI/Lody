import { Effect, Layer } from 'effect';
import { runPromiseThrow } from '../effect-run';
import { copyBytes, bytesEqual } from './cbor';
import { hashRecord, type Hash, type SigningPointCache } from './crypto';
import { fail, LedgerError } from './error';
import { genesisHash, type SigningPublicKey } from '../pure/bytes';
import { viewState, type LedgerView } from '../pure/records';
import { makeSignatureVerifier } from '../platform/signature-verifier';
import type { ClientError } from '../pure/errors';
import { DeviceSigner, JournalStore, LedgerTransport, SignatureVerifier } from '../ports/ledger';
import type { LedgerCommand } from '../pure/commands';
import { rotateEpoch } from '../workflows/epoch-rotation';
import { LedgerClient as EffectLedgerClient } from '../workflows/ledger-client';
import { journalStoreLayer, ledgerTransportLayer } from '../platform/ledger-ports';
import { LedgerEngine, type ResumeOutcome } from '../workflows/ledger-engine';
import { Ledger } from './ledger';
import type { SnapshotTrust } from './snapshot';
export {
  MAX_LEDGER_RECORDS,
  MAX_LEDGER_READ_PAGE_RECORDS,
  MAX_LEDGER_READ_PAGES,
  MAX_LEDGER_READ_RECORDS,
} from '../pure/journal';
export type {
  LedgerJournal,
  LedgerTransaction,
  LedgerStore,
  LedgerReadPage,
  LedgerStream,
} from '../pure/journal';
import {
  MAX_LEDGER_READ_PAGE_RECORDS,
  type LedgerJournal,
  type LedgerTransaction,
  type LedgerStore,
  type LedgerReadPage,
  type LedgerStream,
} from '../pure/journal';

export type LedgerSubmitStatus = 'committed' | 'conflict' | 'unknown' | 'unsupported';

export interface LedgerSubmitResult {
  readonly status: LedgerSubmitStatus;
  readonly ledger: Ledger;
}

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

export class LedgerClient {
  private readonly anchor: Hash;
  private readonly genesisRecord: Uint8Array | null;

  constructor(
    genesisRecord: Uint8Array | null,
    anchor: Hash,
    private readonly store: LedgerStore,
    private readonly stream: LedgerStream,
    _pointCache?: SigningPointCache
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
    stream: LedgerStream,
    pointCache?: SigningPointCache
  ): Promise<LedgerClient> {
    const record = copyBytes(genesisRecord);
    const anchor = await hashRecord(record);
    await Ledger.verify({ anchor, records: [record], pointCache });
    return new LedgerClient(record, anchor, store, stream, pointCache);
  }

  static async openFromSnapshot(input: {
    trust: SnapshotTrust;
    snapshot: Uint8Array;
    store: LedgerStore;
    stream: LedgerStream;
    pointCache?: SigningPointCache;
  }): Promise<LedgerClient> {
    const snapshot = copyBytes(input.snapshot);
    const trust = copyTrust(input.trust);
    const incoming = await Ledger.verifySnapshot({
      trust,
      snapshot,
      suffix: [],
      pointCache: input.pointCache,
    });
    const client = new LedgerClient(
      null,
      trust.genesis,
      input.store,
      input.stream,
      input.pointCache
    );
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
                pointCache: input.pointCache,
              })
            : loaded.records.length === 0
              ? fail('genesis-mismatch')
              : await Ledger.verify({
                  anchor: loaded.genesis,
                  records: loaded.records,
                  pointCache: input.pointCache,
                });
        if (incoming.length < existing.length) fail('replay');
        if (incoming.length === existing.length) {
          if (!bytesEqual(incoming.head, existing.head)) fail('replay');
          const incomingDigest = incoming.comparisonNote(
            trust.endorser,
            input.pointCache
          ).stateDigest;
          const existingDigest = existing.comparisonNote(
            trust.endorser,
            input.pointCache
          ).stateDigest;
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
    stream: LedgerStream,
    pointCache?: SigningPointCache
  ): Promise<LedgerClient> {
    const client = new LedgerClient(null, genesis, store, stream, pointCache);
    await store.exclusive(async (tx) => {
      const loaded = await tx.load();
      if (!loaded) fail('invalid-operation');
      if (!bytesEqual(loaded.genesis, genesis)) fail('wrong-anchor');
    });
    return client;
  }

  private engine: LedgerEngine | undefined;
  private readonly signatures = makeSignatureVerifier();

  private provide<A, E, R>(effect: Effect.Effect<A, E, R>) {
    return effect.pipe(
      Effect.provide(Layer.succeed(SignatureVerifier, this.signatures)),
      Effect.provide(journalStoreLayer(this.store)),
      Effect.provide(ledgerTransportLayer(this.stream))
    );
  }

  private engineEffect(): Effect.Effect<LedgerEngine, ClientError> {
    return Effect.suspend(() => {
      if (this.engine) return Effect.succeed(this.engine);
      const self = this;
      return Effect.gen(function* () {
        const anchor = yield* genesisHash(self.anchor);
        const store = yield* JournalStore;
        const stream = yield* LedgerTransport;
        const engine = yield* LedgerEngine.legacy(
          anchor,
          self.genesisRecord,
          store,
          stream,
          self.signatures
        );
        self.engine = engine;
        return engine;
      }).pipe(this.provide.bind(this));
    });
  }

  /** Temporary Promise boundary. All state transitions live in LedgerEngine. */
  read(): Promise<Ledger> {
    return runPromiseThrow(
      this.provide(
        this.engineEffect().pipe(
          Effect.flatMap((engine) => engine.refresh()),
          Effect.map(asLedger),
          Effect.mapError(legacyError)
        )
      )
    );
  }

  submit(record: Uint8Array): Promise<LedgerSubmitResult> {
    return runPromiseThrow(this.submitEffect(record));
  }

  /** Intent submit. Callers do not assemble parent, nonce or signature bytes. */
  executeEffect(command: LedgerCommand) {
    const captured =
      command._tag === 'AdmitMember'
        ? { ...command, request: { ...command.request } }
        : { ...command };
    return this.provide(
      Effect.gen(this, function* () {
        const engine = yield* this.engineEffect();
        const signer = yield* DeviceSigner;
        return yield* EffectLedgerClient.fromEngine(engine, signer).execute(captured);
      }).pipe(Effect.flatMap(legacyResult), Effect.mapError(legacyError))
    );
  }

  /** Transitional consumer bridge; rotation behavior lives only in the native workflow. */
  rotateEpochEffect() {
    return this.provide(
      Effect.gen(this, function* () {
        const engine = yield* this.engineEffect();
        const signer = yield* DeviceSigner;
        return yield* rotateEpoch(engine, signer);
      })
    );
  }

  /** Transitional consumer bridge; send/install live only in the native workflows. */
  sendCurrentEpochKeyEffect(recipient: SigningPublicKey) {
    return this.provide(
      Effect.gen(this, function* () {
        const engine = yield* this.engineEffect();
        const signer = yield* DeviceSigner;
        return yield* EffectLedgerClient.fromEngine(engine, signer).sendCurrentEpochKey(recipient);
      })
    );
  }

  receiveEpochKeyEffect(sender: SigningPublicKey, frame: Uint8Array) {
    const owned = copyBytes(frame);
    return this.provide(
      Effect.gen(this, function* () {
        const engine = yield* this.engineEffect();
        const signer = yield* DeviceSigner;
        return yield* EffectLedgerClient.fromEngine(engine, signer).receiveEpochKey(sender, owned);
      })
    );
  }

  resume(): Promise<LedgerSubmitResult> {
    return runPromiseThrow(this.resumeEffect());
  }

  submitEffect(record: Uint8Array): Effect.Effect<LedgerSubmitResult, ClientError | LedgerError> {
    const owned = copyBytes(record);
    return this.provide(
      this.engineEffect().pipe(
        Effect.flatMap((engine) => engine.submitEncoded(owned)),
        Effect.flatMap(legacyResult),
        Effect.mapError(legacyError)
      )
    );
  }

  resumeEffect(): Effect.Effect<LedgerSubmitResult, ClientError | LedgerError> {
    return this.provide(
      this.engineEffect().pipe(
        Effect.flatMap((engine) => engine.resume()),
        Effect.flatMap(legacyResult),
        Effect.mapError(legacyError)
      )
    );
  }
}

function legacyError(error: ClientError | LedgerError): ClientError | LedgerError {
  if (error instanceof LedgerError) return error;
  if (error._tag === 'ValidationError') return new LedgerError(error.code, error.position);
  if (error._tag === 'PendingOperationExists') return new LedgerError('replay');
  return error;
}

function legacyResult(result: ResumeOutcome): Effect.Effect<LedgerSubmitResult, LedgerError> {
  if (result._tag === 'Idle') return Effect.fail(new LedgerError('invalid-operation'));
  const status: LedgerSubmitStatus =
    result._tag === 'Committed'
      ? 'committed'
      : result._tag === 'Conflict'
        ? 'conflict'
        : result._tag === 'Unsupported'
          ? 'unsupported'
          : 'unknown';
  return Effect.succeed({ status, ledger: asLedger(result.ledger) });
}

function asLedger(view: LedgerView): Ledger {
  return Ledger.fromInternal(viewState(view));
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
