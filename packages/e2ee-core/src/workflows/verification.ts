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
  viewState,
  type ApplicableRecord,
  type DecodedRecord,
  type LedgerView,
  type SignatureCheckedRecord,
} from '../pure/records';
import { ValidationError } from '../pure/errors';

function viewOf(state: InternalState): Effect.Effect<LedgerView, ValidationError> {
  const headBytes = state.hashes[state.hashes.length - 1];
  if (!headBytes) return Effect.fail(new ValidationError({ code: 'invalid-operation' }));
  return Effect.gen(function* () {
    return ledgerView(state, yield* genesisHash(state.genesis), yield* recordHash(headBytes));
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

export function verifyLedger(input: {
  readonly anchor: GenesisHash;
  readonly records: readonly Uint8Array[];
}): Effect.Effect<LedgerView, ValidationError, SignatureVerifier> {
  const records = input.records.map((record) => new Uint8Array(record));
  return Effect.gen(function* () {
    const verifier = yield* SignatureVerifier;
    if (records.length === 0)
      return yield* Effect.fail(new ValidationError({ code: 'genesis-mismatch', position: 0 }));
    const decoded: SchemaRecord[] = [];
    const hashes: Uint8Array[] = [];
    const outer: SignatureJobInput[] = [];
    const memberProofs: SignatureJobInput[] = [];
    let facts = SigningFacts.empty;
    for (let position = 0; position < records.length; position++) {
      const parsed = yield* Effect.mapError(
        decodeRecordWithFacts(records[position]!, facts),
        (error) =>
          error.position === undefined ? new ValidationError({ code: error.code, position }) : error
      );
      facts = parsed.facts;
      decoded.push(parsed.record);
      hashes.push(hashRecordBytes(parsed.record.recordBytes));
      outer.push({
        publicKey: parsed.record.body.fields.signer,
        message: recordSigningBytes(parsed.record.bodyBytes),
        signature: parsed.record.signature,
        position,
      });
    }
    yield* verifier.verifyMany(outer);
    const genesis = hashes[0]!;
    for (let position = 1; position < decoded.length; position++) {
      const record = decoded[position]!;
      if (record.body.type !== 'ordinary' || record.body.fields.operation.type !== 'admitMember')
        continue;
      const jobs = yield* Effect.mapError(
        operationProofJobs(genesis, record.body.fields.operation),
        (error) =>
          error.position === undefined ? new ValidationError({ code: error.code, position }) : error
      );
      for (const job of jobs)
        memberProofs.push({
          publicKey: job.pk,
          message: job.msg,
          signature: job.sig,
          code: 'bad-proof',
          position,
        });
    }
    if (memberProofs.length > 0) yield* verifier.verifyMany(memberProofs);
    let state: InternalState | undefined;
    for (let position = 0; position < decoded.length; position++) {
      const record = decoded[position]!;
      if (record.body.type === 'ordinary' && record.body.fields.operation.type === 'admitDevice') {
        const jobs = yield* operationProofJobs(
          genesis,
          record.body.fields.operation,
          state?.devices.get(keyId(record.body.fields.signer))?.membershipId
        );
        yield* verifier.verifyMany(
          jobs.map((job) => ({
            publicKey: job.pk,
            message: job.msg,
            signature: job.sig,
            code: 'bad-proof' as const,
            position,
          }))
        );
      }
      state = yield* applyDecodedRecord(
        state,
        record,
        hashes[position]!,
        position,
        position === 0 ? input.anchor.toBytes() : undefined,
        facts
      );
    }
    if (!state)
      return yield* Effect.fail(new ValidationError({ code: 'genesis-mismatch', position: 0 }));
    if (
      !bytesEqual(state.genesis, input.anchor.toBytes()) ||
      !bytesEqual(state.hashes[0]!, input.anchor.toBytes())
    )
      return yield* Effect.fail(new ValidationError({ code: 'wrong-anchor', position: 0 }));
    return yield* viewOf(state);
  });
}

export function extendLedger(
  view: LedgerView,
  suffix: readonly Uint8Array[]
): Effect.Effect<LedgerView, ValidationError, SignatureVerifier> {
  if (suffix.length === 0) return Effect.succeed(view);
  const records = suffix.map((record) => new Uint8Array(record));
  return Effect.gen(function* () {
    const verifier = yield* SignatureVerifier;
    const state = cloneState(viewState(view));
    const start = state.hashes.length;
    let facts = SigningFacts.empty;
    const decoded: SchemaRecord[] = [];
    const outer: SignatureJobInput[] = [];
    const memberProofs: SignatureJobInput[] = [];
    for (let offset = 0; offset < records.length; offset++) {
      const position = start + offset;
      const parsed = yield* Effect.mapError(
        decodeRecordWithFacts(records[offset]!, facts),
        (error) =>
          error.position === undefined ? new ValidationError({ code: error.code, position }) : error
      );
      facts = parsed.facts;
      decoded.push(parsed.record);
      outer.push({
        publicKey: parsed.record.body.fields.signer,
        message: recordSigningBytes(parsed.record.bodyBytes),
        signature: parsed.record.signature,
        position,
      });
      if (
        parsed.record.body.type === 'ordinary' &&
        parsed.record.body.fields.operation.type === 'admitMember'
      ) {
        const jobs = yield* Effect.mapError(
          operationProofJobs(state.genesis, parsed.record.body.fields.operation),
          (error) =>
            error.position === undefined
              ? new ValidationError({ code: error.code, position })
              : error
        );
        for (const job of jobs)
          memberProofs.push({
            publicKey: job.pk,
            message: job.msg,
            signature: job.sig,
            code: 'bad-proof',
            position,
          });
      }
    }
    yield* verifier.verifyMany(outer);
    if (memberProofs.length > 0) yield* verifier.verifyMany(memberProofs);
    for (let offset = 0; offset < decoded.length; offset++) {
      const position = start + offset;
      const record = decoded[offset]!;
      if (record.body.type === 'ordinary' && record.body.fields.operation.type === 'admitDevice') {
        const jobs = yield* operationProofJobs(
          state.genesis,
          record.body.fields.operation,
          state.devices.get(keyId(record.body.fields.signer))?.membershipId
        );
        yield* verifier.verifyMany(
          jobs.map((job) => ({
            publicKey: job.pk,
            message: job.msg,
            signature: job.sig,
            code: 'bad-proof' as const,
            position,
          }))
        );
      }
      yield* applyDecodedRecord(
        state,
        record,
        hashRecordBytes(record.recordBytes),
        position,
        undefined,
        facts
      );
    }
    return yield* viewOf(state);
  });
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
    if (jobs.length > 0)
      yield* verifier.verifyMany(
        jobs.map((job) => ({
          publicKey: job.pk,
          message: job.msg,
          signature: job.sig,
          code: 'bad-proof',
        }))
      );
    yield* operationChanges(state, signer.toBytes(), operation);
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
