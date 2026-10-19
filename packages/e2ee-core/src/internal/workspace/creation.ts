import { Effect } from 'effect';
import * as Bytes from '../foundation/bytes';
import { decodeRecord, hashRecordBytes, verifyLedgerEffect } from '../ledger';
import { commitEpochKey } from '../keys/history';
import { disposeEpochKey } from '../foundation/epoch-key';
import { LedgerError } from '../ledger/errors';
/** Before first publication, prove that the initialized protected owner can read
 * back the exact initial key committed by the original signed genesis. */
export const verifyRetainedWorkspaceGenesis = Effect.fnUntraced(function* (input: {
  readonly genesis: Bytes.GenesisHash;
  readonly record: Uint8Array;
  readonly signer: Bytes.SigningPublicKey;
  readonly installed: { read(epoch: number): Effect.Effect<Bytes.EpochKey, unknown> };
}) {
  const record = new Uint8Array(input.record),
    parsed = yield* Effect.fromResult(decodeRecord(record));
  if (parsed.body.type !== 'genesis' || !parsed.body.signer.equals(input.signer))
    return yield* new LedgerError({ code: 'unauthorized' });
  const expected = parsed.body.epochCommitment;
  const view = yield* verifyLedgerEffect({
    anchor: input.genesis,
    records: [record],
    checkpoint: { head: hashRecordBytes(record), length: 1 },
  });
  yield* Effect.acquireUseRelease(
    input.installed.read(0),
    (key) =>
      Effect.gen(function* () {
        const actual = yield* Effect.fromResult(commitEpochKey(input.genesis, 0, key));
        if (!actual.equals(expected))
          return yield* new LedgerError({ code: 'checkpoint-mismatch' });
        return undefined;
      }),
    (key) => Effect.sync(() => disposeEpochKey(key))
  );
  return view;
});
