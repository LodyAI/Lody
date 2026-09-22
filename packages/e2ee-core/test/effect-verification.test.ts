import { Effect, Either } from 'effect';
import { expect, it } from 'vitest';
import {
  Bytes,
  applyAuthorizedRecord,
  authorizeRecord,
  decodeRecord,
  verifyLedger,
  verifyRecordSignature,
} from '@lody/e2ee-core/effect';
import { admitDeviceOp, append, ed25519, signGenesis } from './ledger-fixtures';

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
    })
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
  const verified = await Effect.runPromise(verifyRecordSignature(decoded));
  expect(verified.stage).toBe('SignatureChecked');
  const corrupted = new Uint8Array(saved);
  corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
  const outcome = await Effect.runPromise(
    Effect.either(
      Effect.gen(function* () {
        return yield* verifyRecordSignature(yield* decodeRecord(corrupted));
      })
    )
  );
  expect(Either.isLeft(outcome)).toBe(true);
});
