import { Effect, Either } from 'effect';
import { expect, it } from 'vitest';
import {
  Bytes,
  applyAuthorizedRecord,
  authorizeRecord,
  decodeRecord,
  verifyLedger,
  verifyRecordSignature,
  SignatureVerifier,
  DeviceSigner,
  prepareDeviceAdmission,
  prepareJoinRequest,
} from '@lody/e2ee-core/effect';
import { admitDeviceOp, append, ed25519, signGenesis } from './ledger-fixtures';
import { applyGenesis, applyOperation } from '../src/ledger/policy';
import { decodeRecord as decodeLegacyRecord } from '../src/ledger/schema';
import { operationChanges } from '../src/pure/ledger-policy';
import { cloneState } from '../src/pure/ledger-state';
import { keyId } from '../src/pure/identifiers';
import * as Schema from '../src/pure/ledger-schema';
import { SigningFacts } from '../src/pure/signing-facts';
import { operationProofJobs } from '../src/pure/operation-proofs';
import { verifySignature } from '../src/ledger/crypto';
import { signatureVerifierLayer, deviceSignerLayer } from '@lody/e2ee-core/effect/platform';
import { recordSigningBytes } from '../src/pure/wire-crypto';

it('the signing adapter owns message bytes before execution and across repeated runs', async () => {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const record = decodeLegacyRecord(created.record);
  const message = recordSigningBytes(record.bodyBytes);
  const publicKey = Bytes.signingPublicKey(owner.publicKey);
  if (Either.isLeft(publicKey)) throw new Error('fixture key must be valid');
  await Effect.runPromise(
    Effect.gen(function* () {
      const signer = yield* DeviceSigner;
      const signing = signer.sign(message);
      message.fill(0);
      expect((yield* signing).toBytes()).toEqual(record.signature);
      expect((yield* signing).toBytes()).toEqual(record.signature);
    }).pipe(Effect.provide(deviceSignerLayer(publicKey.right, owner.sign)))
  );
});

it('enrollment refuses signatures from a different real device before returning proof material', async () => {
  const owner = await ed25519();
  const wrongSigner = await ed25519();
  const created = await signGenesis(owner);
  await Effect.runPromise(
    Effect.gen(function* () {
      const genesis = yield* Bytes.genesisHash(created.anchor);
      const membershipId = yield* Bytes.membershipId(created.membershipId);
      const encryptionPublicKey = yield* Bytes.encryptionPublicKey(owner.enc);
      const requestId = yield* Bytes.requestId(new Uint8Array(16).fill(1));
      const userId = yield* Bytes.userId(new Uint8Array(32).fill(2));
      const publicKey = yield* Bytes.signingPublicKey(owner.publicKey);
      const signer = deviceSignerLayer(publicKey, wrongSigner.sign);
      const admission = yield* Effect.either(
        prepareDeviceAdmission({
          genesis,
          membershipId,
          encryptionPublicKey,
          grant: { kind: 'personal', canManage: false },
        }).pipe(Effect.provide(signer))
      );
      const join = yield* Effect.either(
        prepareJoinRequest({
          genesis,
          requestId,
          userId,
          encryptionPublicKey,
          expiresAt: null,
        }).pipe(Effect.provide(signer))
      );
      expect(admission).toMatchObject({ _tag: 'Left', left: { code: 'bad-proof' } });
      expect(join).toMatchObject({ _tag: 'Left', left: { code: 'bad-proof' } });
    }).pipe(Effect.provide(signatureVerifierLayer))
  );
});

it('the verifier Service owns deferred message bytes and preserves real signature rejection', async () => {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const parsed = decodeLegacyRecord(created.record);
  const message = recordSigningBytes(parsed.bodyBytes);
  await Effect.runPromise(
    Effect.gen(function* () {
      const verifier = yield* SignatureVerifier;
      const publicKey = yield* Bytes.signingPublicKey(owner.publicKey);
      const signature = yield* Bytes.signature(parsed.signature);
      const pending = verifier.verify({ publicKey, signature, message });
      message.fill(0);
      yield* pending;
      const invalid = yield* Effect.either(verifier.verify({ publicKey, signature, message }));
      expect(invalid).toMatchObject({ _tag: 'Left', left: { code: 'bad-signature' } });
    }).pipe(Effect.provide(signatureVerifierLayer))
  );
});

it('binds application evidence to the exact verified view, not merely its head', async () => {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const phone = await ed25519();
  const next = await append(
    created.ledger,
    owner,
    await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal', false)
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const anchor = yield* Bytes.genesisHash(created.anchor);
      const first = yield* verifyLedger({ anchor, records: [created.record] });
      const second = yield* verifyLedger({ anchor, records: [created.record] });
      const parsed = yield* decodeRecord(next.record);
      const signed = yield* verifyRecordSignature(parsed);
      const permitted = yield* authorizeRecord(first, signed);
      const applied = yield* applyAuthorizedRecord(first, permitted);
      return { first, second, applied, refused: applyAuthorizedRecord(second, permitted) };
    }).pipe(Effect.provide(signatureVerifierLayer))
  );
  expect(result.first.head.toBytes()).toEqual(result.second.head.toBytes());
  expect(result.applied.length).toBe(2);
  expect(result.first.length).toBe(1);
  expect(result.applied.deviceCount).toBe(2);
  expect(result.refused).toMatchObject({
    _tag: 'Left',
    left: { _tag: 'ContextMismatch', context: 'view' },
  });
});

it('copies decoded material and never turns an invalid signature into authority', async () => {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const saved = new Uint8Array(created.record);
  const decoded = await Effect.runPromise(decodeRecord(created.record));
  created.record.fill(0);
  decoded.toBytes().fill(0);
  expect(decoded.toBytes()).toEqual(saved);
  const verified = await Effect.runPromise(
    verifyRecordSignature(decoded).pipe(Effect.provide(signatureVerifierLayer))
  );
  expect(verified.stage).toBe('SignatureChecked');
  const corrupted = new Uint8Array(saved);
  corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
  const outcome = await Effect.runPromise(
    Effect.either(
      Effect.gen(function* () {
        return yield* verifyRecordSignature(yield* decodeRecord(corrupted));
      })
    ).pipe(Effect.provide(signatureVerifierLayer))
  );
  expect(Either.isLeft(outcome)).toBe(true);
});

it('computes policy changes without input mutation and never partially consumes keys on failure', async () => {
  const owner = await ed25519();
  const phone = await ed25519();
  const created = await signGenesis(owner);
  const decoded = decodeLegacyRecord(created.record);
  if (decoded.body.type !== 'genesis') throw new Error('expected genesis fixture');
  const state = applyGenesis(decoded.body.fields, created.anchor);
  const before = structuredClone(state);
  const operation = await admitDeviceOp(
    created.anchor,
    created.membershipId,
    phone,
    'personal',
    false
  );
  // Signing key is valid, but the encryption-key check fails later.
  const invalid = { ...operation, encryptionPublicKey: new Uint8Array(32) };
  expect(operationChanges(state, owner.publicKey, invalid)).toMatchObject({
    _tag: 'Left',
    left: { _tag: 'ValidationError', code: 'invalid-key' },
  });
  expect(state).toEqual(before);
  expect(() => applyOperation(state, owner.publicKey, invalid)).toThrow('invalid-key');
  expect(state).toEqual(before);
  const first = operationChanges(state, owner.publicKey, operation);
  expect(first).toEqual(operationChanges(state, owner.publicKey, operation));
  expect(state).toEqual(before);
  if (Either.isLeft(first)) throw new Error('expected admitted device');
  const entry = first.right.devices?.[0]?.[1];
  if (!entry) throw new Error('expected device delta');
  entry.membershipId.fill(0);
  entry.encryptionPublicKey.fill(0);
  expect(state).toEqual(before);
  expect(operation.encryptionPublicKey).toEqual(phone.enc);
  // The compatibility adapter must recompute, not accept this modified delta.
  const hashes = state.hashes;
  applyOperation(state, owner.publicKey, operation);
  expect(state.hashes).toBe(hashes);
  expect(state.devices.get(keyId(phone.publicKey))?.membershipId).toEqual(created.membershipId);
  expect(operationChanges(state, owner.publicKey, operation)).toMatchObject({
    _tag: 'Left',
    left: { code: 'replay' },
  });
});

it('copies mutable bytes when forking a replay state', async () => {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const decoded = decodeLegacyRecord(created.record);
  if (decoded.body.type !== 'genesis') throw new Error('expected genesis fixture');
  const state = applyGenesis(decoded.body.fields, created.anchor);
  const expected = structuredClone(state);
  const fork = cloneState(state);
  fork.genesis.fill(0);
  fork.owner.fill(0);
  for (const member of fork.members.values()) member.userId.fill(0);
  for (const device of fork.devices.values()) {
    device.membershipId.fill(0);
    device.encryptionPublicKey.fill(0);
  }
  for (const hash of fork.hashes) hash?.fill(0);
  for (const row of fork.historyPackets.values()) {
    row.commitment.fill(0);
    row.packet.fill(0);
  }
  expect(state).toEqual(expected);
});

it('pure decoding preserves wire bytes and returns errors without mutating point facts', async () => {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const saved = new Uint8Array(created.record);
  const result = Schema.decodeRecordWithFacts(created.record);
  if (Either.isLeft(result)) throw new Error('signed fixture must decode');
  const { record, facts } = result.right;
  expect(SigningFacts.empty.size).toBe(0);
  expect(facts.size).toBe(1);
  expect(Schema.encodeRecord(record.body, record.signature, facts)).toEqual(Either.right(saved));
  created.record.fill(0);
  record.body.fields.signer.fill(0);
  record.bodyBytes.fill(0);
  const again = Schema.decodeRecordWithFacts(saved, facts);
  if (Either.isLeft(again)) throw new Error('copied fixture must decode');
  expect(again.right.record.body.fields.signer).toEqual(owner.publicKey);
  expect(again.right.facts).toBe(facts);
  for (const input of [
    new Uint8Array(),
    Uint8Array.of(0x18, 0),
    saved.subarray(0, saved.length - 1),
  ]) {
    expect(Schema.decodeRecordWithFacts(input, facts)).toMatchObject({ _tag: 'Left' });
  }
  expect(facts.size).toBe(1);
});

it('pure proof jobs bind the target membership and own all signature material', async () => {
  const owner = await ed25519();
  const phone = await ed25519();
  const created = await signGenesis(owner);
  const operation = await admitDeviceOp(
    created.anchor,
    created.membershipId,
    phone,
    'personal',
    false
  );
  expect(operationProofJobs(created.anchor, operation)).toMatchObject({
    _tag: 'Left',
    left: { code: 'unauthorized' },
  });
  const jobs = operationProofJobs(created.anchor, operation, created.membershipId);
  if (Either.isLeft(jobs) || !jobs.right[0]) throw new Error('valid possession fixture required');
  const job = jobs.right[0];
  expect(verifySignature(job.pk, job.msg, job.sig)).toBe(true);
  const otherMembership = new Uint8Array(created.membershipId);
  otherMembership[0] = otherMembership[0]! ^ 1;
  const wrong = operationProofJobs(created.anchor, operation, otherMembership);
  if (Either.isLeft(wrong) || !wrong.right[0]) throw new Error('wrong target job required');
  expect(verifySignature(wrong.right[0].pk, wrong.right[0].msg, wrong.right[0].sig)).toBe(false);
  created.anchor.fill(0);
  created.membershipId.fill(0);
  operation.signingPublicKey.fill(0);
  operation.encryptionPublicKey.fill(0);
  operation.possessionSignature.fill(0);
  expect(verifySignature(job.pk, job.msg, job.sig)).toBe(true);
});
