/** Promise facade over `workflows/ledger-engine.ts`: no second submit path. */
import { Effect, Layer } from 'effect';
import {
  genesisHash,
  recordHash,
  signature,
  signingPublicKey,
  type SigningPublicKey,
} from '../pure/bytes';
import { bytesEqual, copyBytes } from '../pure/cbor';
import type { LedgerCommand } from '../pure/commands';
import { ValidationError, type ClientError } from '../pure/errors';
import type { SnapshotTrust } from '../pure/ledger-snapshot';
import { makeSignatureVerifier, SigningPointCache } from '../platform/signature-verifier';
import { ledgerTransportLayer } from '../platform/ledger-ports';
import {
  DeviceSigner,
  JournalStore,
  LedgerTransport,
  SignatureVerifier,
  type JournalTransaction,
} from '../ports/ledger';
import { rotateEpoch } from '../workflows/epoch-rotation';
import { LedgerClient as EffectLedgerClient } from '../workflows/ledger-client';
import { LedgerEngine, type ResumeOutcome } from '../workflows/ledger-engine';
import { verifyLedger } from '../workflows/verification';
import { runLegacy } from './compat';
import type { Hash } from './crypto';
import { Ledger } from './ledger';
import {
  MAX_LEDGER_READ_PAGE_RECORDS,
  type LedgerReadPage,
  type LedgerStream,
} from '../pure/journal';
import { hashRecordBytes } from '../pure/wire-crypto';
import { LedgerError } from './error';
export {
  MAX_LEDGER_RECORDS,
  MAX_LEDGER_READ_PAGE_RECORDS,
  MAX_LEDGER_READ_PAGES,
  MAX_LEDGER_READ_RECORDS,
} from '../pure/journal';
export type { LedgerJournal, LedgerReadPage, LedgerStream } from '../pure/journal';
export { MemoryJournalStore as MemoryLedgerStore } from '../platform/memory-stores';

/** The journal port is the native Effect `JournalStore` service. */
export type LedgerStore = JournalStore['Service'];
export type LedgerTransaction = JournalTransaction;

export type LedgerSubmitStatus = 'committed' | 'conflict' | 'unknown' | 'unsupported';

export interface LedgerSubmitResult {
  readonly status: LedgerSubmitStatus;
  readonly ledger: Ledger;
}

const invalid = (code: ValidationError['code']): never => {
  throw new LedgerError(code);
};
const failWith = (code: ValidationError['code']) => Effect.fail(new ValidationError({ code }));

function checkOffset(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value === 'now')
    invalid('invalid-operation');
}

function ownBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) invalid('canonical');
  return copyBytes(value as Uint8Array);
}

function copyTrust(trust: SnapshotTrust): SnapshotTrust {
  return {
    genesis: copyBytes(trust.genesis),
    endorser: copyBytes(trust.endorser),
    head: copyBytes(trust.head),
    headSignature: copyBytes(trust.headSignature),
  };
}

export class LedgerClient {
  private readonly anchor: Hash;
  private readonly genesisRecord: Uint8Array | null;
  private readonly signatures: SignatureVerifier['Service'];
  private engine: LedgerEngine | undefined;

  constructor(
    genesisRecord: Uint8Array | null,
    anchor: Hash,
    private readonly store: LedgerStore,
    private readonly stream: LedgerStream,
    pointCache?: SigningPointCache
  ) {
    this.anchor = ownBytes(anchor);
    this.genesisRecord = genesisRecord === null ? null : ownBytes(genesisRecord);
    checkOffset(stream.initialOffset);
    this.signatures = makeSignatureVerifier({ cache: pointCache ?? new SigningPointCache() });
  }

  static async open(
    genesisRecord: Uint8Array,
    store: LedgerStore,
    stream: LedgerStream,
    pointCache?: SigningPointCache
  ): Promise<LedgerClient> {
    return runLegacy(LedgerClient.openEffect(ownBytes(genesisRecord), store, stream, pointCache));
  }

  /** Inert native description for consumers with an existing runtime owner. */
  static openEffect(
    genesisRecord: Uint8Array,
    store: LedgerStore,
    stream: LedgerStream,
    pointCache?: SigningPointCache
  ) {
    const record = copyBytes(genesisRecord);
    const anchor = hashRecordBytes(record);
    return Effect.gen(function* () {
      yield* verifyLedger({
        anchor: yield* Effect.fromResult(genesisHash(anchor)),
        records: [record],
      }).pipe(
        Effect.provideService(SignatureVerifier, makeSignatureVerifier({ cache: pointCache }))
      );
      return new LedgerClient(record, anchor, store, stream, pointCache);
    });
  }

  static async openFromSnapshot(input: {
    trust: SnapshotTrust;
    snapshot: Uint8Array;
    store: LedgerStore;
    stream: LedgerStream;
    pointCache?: SigningPointCache;
  }): Promise<LedgerClient> {
    const snapshot = ownBytes(input.snapshot);
    const trust = copyTrust(input.trust);
    const client = new LedgerClient(
      null,
      trust.genesis,
      input.store,
      input.stream,
      input.pointCache
    );
    client.engine = await runLegacy(
      client.provide(
        Effect.gen(function* () {
          return yield* LedgerEngine.legacyFromSnapshot({
            genesis: yield* Effect.fromResult(genesisHash(trust.genesis)),
            endorser: yield* Effect.fromResult(signingPublicKey(trust.endorser)),
            head: yield* Effect.fromResult(recordHash(trust.head)),
            headSignature: yield* Effect.fromResult(signature(trust.headSignature)),
            snapshot,
          });
        })
      )
    );
    return client;
  }

  static async openJournal(
    genesis: Hash,
    store: LedgerStore,
    stream: LedgerStream,
    pointCache?: SigningPointCache
  ): Promise<LedgerClient> {
    const client = new LedgerClient(null, genesis, store, stream, pointCache);
    await runLegacy(
      store.exclusive((tx) =>
        Effect.flatMap(tx.load, (loaded) =>
          loaded === null
            ? failWith('invalid-operation')
            : bytesEqual(loaded.genesis, genesis)
              ? Effect.void
              : failWith('wrong-anchor')
        )
      )
    );
    return client;
  }

  private provide<A, E, R>(effect: Effect.Effect<A, E, R>) {
    return effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(SignatureVerifier, this.signatures),
          Layer.succeed(JournalStore, this.store),
          ledgerTransportLayer(this.stream)
        )
      )
    );
  }

  private engineEffect(): Effect.Effect<LedgerEngine, ClientError> {
    return Effect.suspend(() => {
      if (this.engine) return Effect.succeed(this.engine);
      return Effect.gen({ self: this }, function* () {
        const engine = yield* LedgerEngine.legacy(
          yield* Effect.fromResult(genesisHash(this.anchor)),
          this.genesisRecord,
          yield* JournalStore,
          yield* LedgerTransport,
          this.signatures
        );
        this.engine = engine;
        return engine;
      }).pipe(this.provide.bind(this));
    });
  }

  private withEngine<A, E, R>(run: (engine: LedgerEngine) => Effect.Effect<A, E, R>) {
    return this.provide(Effect.flatMap(this.engineEffect(), run));
  }

  read(): Promise<Ledger> {
    return runLegacy(this.readEffect());
  }

  readEffect() {
    return this.withEngine((engine) => engine.refresh()).pipe(Effect.map(Ledger.fromView));
  }

  submit(record: Uint8Array): Promise<LedgerSubmitResult> {
    return runLegacy(this.submitEffect(record));
  }

  resume(): Promise<LedgerSubmitResult> {
    return runLegacy(this.resumeEffect());
  }

  /** Intent submit. Callers do not assemble parent, nonce or signature bytes. */
  executeEffect(command: LedgerCommand) {
    const captured =
      command._tag === 'AdmitMember'
        ? { ...command, request: { ...command.request } }
        : { ...command };
    return this.withEngine((engine) =>
      Effect.flatMap(DeviceSigner, (signer) =>
        EffectLedgerClient.fromEngine(engine, signer).execute(captured)
      )
    ).pipe(Effect.flatMap(legacyResult), Effect.mapError(legacyError));
  }

  /** Transitional consumer bridge; rotation behavior lives only in the native workflow. */
  rotateEpochEffect() {
    return this.withEngine((engine) =>
      Effect.flatMap(DeviceSigner, (signer) => rotateEpoch(engine, signer))
    );
  }

  /** Transitional consumer bridge; send/install live only in the native workflows. */
  sendCurrentEpochKeyEffect(recipient: SigningPublicKey) {
    return this.withEngine((engine) =>
      Effect.flatMap(DeviceSigner, (signer) =>
        EffectLedgerClient.fromEngine(engine, signer).sendCurrentEpochKey(recipient)
      )
    );
  }

  receiveEpochKeyEffect(sender: SigningPublicKey, frame: Uint8Array) {
    const owned = copyBytes(frame);
    return this.withEngine((engine) =>
      Effect.flatMap(DeviceSigner, (signer) =>
        EffectLedgerClient.fromEngine(engine, signer).receiveEpochKey(sender, owned)
      )
    );
  }

  submitEffect(record: Uint8Array): Effect.Effect<LedgerSubmitResult, ClientError | LedgerError> {
    const owned = copyBytes(record);
    return this.withEngine((engine) => engine.submitEncoded(owned)).pipe(
      Effect.flatMap(legacyResult),
      Effect.mapError(legacyError)
    );
  }

  resumeEffect(): Effect.Effect<LedgerSubmitResult, ClientError | LedgerError> {
    return this.withEngine((engine) => engine.resume()).pipe(
      Effect.flatMap(legacyResult),
      Effect.mapError(legacyError)
    );
  }
}

/** Legacy Effect methods keep their historical `LedgerError` failure values. */
function legacyError(error: ClientError): ClientError | LedgerError {
  if (error._tag === 'ValidationError') return new LedgerError(error.code, error.position);
  if (error._tag === 'PendingOperationExists') return new LedgerError('replay');
  return error;
}

function legacyResult(result: ResumeOutcome): Effect.Effect<LedgerSubmitResult, ValidationError> {
  if (result._tag === 'Idle') return failWith('invalid-operation');
  const status: LedgerSubmitStatus =
    result._tag === 'Committed'
      ? 'committed'
      : result._tag === 'Conflict'
        ? 'conflict'
        : result._tag === 'Unsupported'
          ? 'unsupported'
          : 'unknown';
  return Effect.succeed({ status, ledger: Ledger.fromView(result.ledger) });
}

/** In-memory Promise remote for tests; it models lost responses and false acks. */
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
    if (index === -1 && offset !== this.initialOffset) invalid('canonical');
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
