import { Effect } from 'effect';
import { SignatureVerifier, type SignatureJobInput } from '../ports/ledger';
import {
  decodeRecord as decodeWire,
  decodeRecordWithFacts,
  encodeOrdinaryBody,
  encodeSignedRecord,
  type DecodedRecord as SchemaRecord,
  type Operation,
} from '../pure/ledger-schema';
import {
  hashRecordBytes,
  headAttestationSigningBytes,
  recordSigningBytes,
  snapshotSigningBytes,
} from '../pure/wire-crypto';
import { applyDecodedRecord } from '../pure/ledger-apply';
import { cloneState, type InternalState } from '../pure/ledger-state';
import { operationChanges } from '../pure/ledger-policy';
import { operationProofJobs } from '../pure/operation-proofs';
import { bytesEqual, copyBytes } from '../pure/cbor';
import { SigningFacts } from '../pure/signing-facts';
import { keyId } from '../pure/identifiers';
import { parseSignedSnapshot, snapshotStateFromParsed } from '../pure/ledger-snapshot';
import {
  genesisHash,
  recordHash,
  signingPublicKey,
  signature,
  type GenesisHash,
  type RecordHash,
  type SigningPublicKey,
  type Signature,
} from '../pure/bytes';
import {
  applicableRecord,
  checkedRecord,
  decodedRecord,
  ledgerView,
  viewFacts,
  viewState,
  type ApplicableRecord,
  type DecodedRecord,
  type LedgerView,
  type SignatureCheckedRecord,
} from '../pure/records';
import { ValidationError } from '../pure/errors';

function viewOf(
  state: InternalState,
  facts = SigningFacts.empty
): Effect.Effect<LedgerView, ValidationError> {
  const headBytes = state.hashes[state.hashes.length - 1];
  if (!headBytes) return Effect.fail(new ValidationError({ code: 'invalid-operation' }));
  return Effect.gen(function* () {
    return ledgerView(
      state,
      yield* genesisHash(state.genesis),
      yield* recordHash(headBytes),
      facts
    );
  });
}

export function decodeRecord(input: Uint8Array): Effect.Effect<DecodedRecord, ValidationError> {
  const bytes = new Uint8Array(input);
  return Effect.gen(function* () {
    const parsed = yield* decodeWire(bytes);
    const signer = yield* signingPublicKey(parsed.body.fields.signer);
    return decodedRecord(parsed.recordBytes, signer);
  });
}

export function verifyRecordSignature(
  record: DecodedRecord
): Effect.Effect<SignatureCheckedRecord, ValidationError, SignatureVerifier> {
  return Effect.gen(function* () {
    const verifier = yield* SignatureVerifier;
    const parsed = yield* decodeWire(record.toBytes());
    yield* verifier.verify({
      publicKey: yield* signingPublicKey(parsed.body.fields.signer),
      message: recordSigningBytes(parsed.bodyBytes),
      signature: yield* signature(parsed.signature),
    });
    return checkedRecord(record);
  });
}

const atPosition = (position: number) => (error: ValidationError) =>
  error.position === undefined ? new ValidationError({ code: error.code, position }) : error;

const proofInputs = (
  jobs: readonly { readonly pk: Uint8Array; readonly msg: Uint8Array; readonly sig: Uint8Array }[],
  position?: number
): SignatureJobInput[] =>
  jobs.map((job) => ({
    publicKey: job.pk,
    message: job.msg,
    signature: job.sig,
    code: 'bad-proof' as const,
    position,
  }));

interface DecodedBatch {
  readonly records: readonly SchemaRecord[];
  readonly hashes: readonly Uint8Array[];
  readonly facts: SigningFacts;
}

/** Decode and hash every record, then check all outer signatures and admitMember
 * proofs in two batches. `genesis` defaults to the hash of the first record. */
function decodeAndVerify(
  records: readonly Uint8Array[],
  start: number,
  initialFacts: SigningFacts,
  knownGenesis?: Uint8Array
): Effect.Effect<DecodedBatch, ValidationError, SignatureVerifier> {
  return Effect.gen(function* () {
    const verifier = yield* SignatureVerifier;
    const decoded: SchemaRecord[] = [];
    const hashes: Uint8Array[] = [];
    const outer: SignatureJobInput[] = [];
    const memberProofs: SignatureJobInput[] = [];
    let facts = initialFacts;
    let genesis = knownGenesis;
    for (let offset = 0; offset < records.length; offset++) {
      const position = start + offset;
      const parsed = yield* Effect.mapError(
        decodeRecordWithFacts(records[offset]!, facts),
        atPosition(position)
      );
      facts = parsed.facts;
      const record = parsed.record;
      const hash = hashRecordBytes(record.recordBytes);
      genesis ??= hash;
      decoded.push(record);
      hashes.push(hash);
      outer.push({
        publicKey: record.body.fields.signer,
        message: recordSigningBytes(record.bodyBytes),
        signature: record.signature,
        position,
      });
      // Position 0 must be genesis; replay rejects anything else structurally.
      if (
        position > 0 &&
        record.body.type === 'ordinary' &&
        record.body.fields.operation.type === 'admitMember'
      ) {
        const jobs = yield* Effect.mapError(
          operationProofJobs(genesis, record.body.fields.operation),
          atPosition(position)
        );
        memberProofs.push(...proofInputs(jobs, position));
      }
    }
    yield* verifier.verifyMany(outer, facts);
    if (memberProofs.length > 0) yield* verifier.verifyMany(memberProofs, facts);
    return { records: decoded, hashes, facts };
  });
}

/** Policy replay in order. Device possession proofs bind the actor's membership in
 * the preceding verified state, so they are checked here rather than batched. */
function replay(
  initial: InternalState | undefined,
  batch: DecodedBatch,
  start: number,
  anchor?: Uint8Array
): Effect.Effect<InternalState | undefined, ValidationError, SignatureVerifier> {
  return Effect.gen(function* () {
    const verifier = yield* SignatureVerifier;
    let state = initial;
    for (let offset = 0; offset < batch.records.length; offset++) {
      const position = start + offset;
      const record = batch.records[offset]!;
      // Without a genesis state, replay rejects the record structurally first.
      if (
        state !== undefined &&
        record.body.type === 'ordinary' &&
        record.body.fields.operation.type === 'admitDevice'
      ) {
        const jobs = yield* operationProofJobs(
          state.genesis,
          record.body.fields.operation,
          state.devices.get(keyId(record.body.fields.signer))?.membershipId
        );
        yield* verifier.verifyMany(proofInputs(jobs, position), batch.facts);
      }
      state = yield* applyDecodedRecord(
        state,
        record,
        batch.hashes[offset]!,
        position,
        position === 0 ? anchor : undefined,
        batch.facts
      );
    }
    return state;
  });
}

export function verifyLedger(input: {
  readonly anchor: GenesisHash;
  readonly records: readonly Uint8Array[];
}): Effect.Effect<LedgerView, ValidationError, SignatureVerifier> {
  const records = input.records.map((record) => new Uint8Array(record));
  const anchor = input.anchor.toBytes();
  return Effect.gen(function* () {
    if (records.length === 0)
      return yield* Effect.fail(new ValidationError({ code: 'genesis-mismatch', position: 0 }));
    const batch = yield* decodeAndVerify(records, 0, SigningFacts.empty);
    const state = yield* replay(undefined, batch, 0, anchor);
    if (!state)
      return yield* Effect.fail(new ValidationError({ code: 'genesis-mismatch', position: 0 }));
    if (!bytesEqual(state.genesis, anchor) || !bytesEqual(state.hashes[0]!, anchor))
      return yield* Effect.fail(new ValidationError({ code: 'wrong-anchor', position: 0 }));
    return yield* viewOf(state, batch.facts);
  }).pipe(Effect.withSpan('e2ee.verifyLedger', { attributes: { records: records.length } }));
}

export function extendLedger(
  view: LedgerView,
  suffix: readonly Uint8Array[]
): Effect.Effect<LedgerView, ValidationError, SignatureVerifier> {
  if (suffix.length === 0) return Effect.succeed(view);
  const records = suffix.map((record) => new Uint8Array(record));
  return Effect.gen(function* () {
    const state = cloneState(viewState(view));
    const start = state.hashes.length;
    const batch = yield* decodeAndVerify(records, start, viewFacts(view), state.genesis);
    yield* replay(state, batch, start);
    return yield* viewOf(state, batch.facts);
  }).pipe(Effect.withSpan('e2ee.extendLedger', { attributes: { records: records.length } }));
}

export function authorizeRecord(
  view: LedgerView,
  record: SignatureCheckedRecord
): Effect.Effect<ApplicableRecord, ValidationError, SignatureVerifier> {
  return Effect.gen(function* () {
    const next = yield* extendLedger(view, [record.toBytes()]);
    return applicableRecord(view, next);
  });
}

export function prepareChecked(
  view: LedgerView,
  operation: Operation,
  signer: SigningPublicKey
): Effect.Effect<
  {
    readonly bodyBytes: Uint8Array;
    readonly signingBytes: Uint8Array;
    readonly previousHash: Uint8Array;
  },
  ValidationError,
  SignatureVerifier
> {
  return Effect.gen(function* () {
    const verifier = yield* SignatureVerifier;
    const state = viewState(view);
    const previousHash = state.hashes[state.hashes.length - 1];
    if (!previousHash)
      return yield* Effect.fail(new ValidationError({ code: 'invalid-operation' }));
    const jobs = yield* operationProofJobs(
      state.genesis,
      operation,
      state.devices.get(keyId(signer.toBytes()))?.membershipId
    );
    if (jobs.length > 0) yield* verifier.verifyMany(proofInputs(jobs), viewFacts(view));
    yield* operationChanges(state, signer.toBytes(), operation, viewFacts(view));
    const bodyBytes = yield* encodeOrdinaryBody({
      previousHash: copyBytes(previousHash),
      signer: signer.toBytes(),
      operation,
    });
    return {
      bodyBytes,
      signingBytes: recordSigningBytes(bodyBytes),
      previousHash: copyBytes(previousHash),
    };
  });
}

export function finalizePrepared(
  view: LedgerView,
  bodyBytes: Uint8Array,
  previousHash: Uint8Array,
  signed: Signature
): Effect.Effect<{ record: Uint8Array; view: LedgerView }, ValidationError, SignatureVerifier> {
  return Effect.gen(function* () {
    const head = viewState(view).hashes[viewState(view).hashes.length - 1];
    if (!head || !bytesEqual(previousHash, head))
      return yield* Effect.fail(new ValidationError({ code: 'wrong-parent' }));
    const record = yield* encodeSignedRecord(bodyBytes, signed.toBytes());
    return { record, view: yield* extendLedger(view, [record]) };
  });
}

export function verifySnapshot(input: {
  readonly genesis: GenesisHash;
  readonly endorser: SigningPublicKey;
  readonly head: RecordHash;
  readonly headSignature: Signature;
  readonly snapshot: Uint8Array;
  readonly suffix?: readonly Uint8Array[];
}): Effect.Effect<LedgerView, ValidationError, SignatureVerifier> {
  const snapshot = new Uint8Array(input.snapshot);
  const suffix = (input.suffix ?? []).map((record) => new Uint8Array(record));
  return Effect.gen(function* () {
    const verifier = yield* SignatureVerifier;
    const attestation = yield* headAttestationSigningBytes(
      input.genesis.toBytes(),
      input.head.toBytes()
    );
    yield* verifier.verify({
      publicKey: input.endorser,
      message: attestation,
      signature: input.headSignature,
    });
    const parsed = yield* parseSignedSnapshot(snapshot);
    if (
      !bytesEqual(parsed.genesis, input.genesis.toBytes()) ||
      !bytesEqual(parsed.signer, input.endorser.toBytes()) ||
      !bytesEqual(parsed.head, input.head.toBytes())
    )
      return yield* Effect.fail(new ValidationError({ code: 'wrong-anchor' }));
    yield* verifier.verify({
      publicKey: yield* signingPublicKey(parsed.signer),
      message: snapshotSigningBytes(parsed.bodyBytes),
      signature: yield* signature(parsed.signature),
    });
    const state = yield* snapshotStateFromParsed(parsed);
    const base = yield* viewOf(state);
    return suffix.length === 0 ? base : yield* extendLedger(base, suffix);
  });
}
