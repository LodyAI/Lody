import { Effect, Result } from 'effect';
import { decodeCbor, encodeCbor, copyBytes, bytesEqual, type CborValue } from '../foundation/cbor';
import { signingPublicKey, type SigningPublicKey } from '../foundation/bytes';
import { ContentError, type ValidationError } from '../foundation/errors';
import { signVerified, type DeviceSigner } from '../foundation/signing';
import { decodeRecord, recordSigningBytes, hashRecordBytes, fail } from './records';
import { LedgerError } from './errors';
import {
  authorizeUnsignedRecord,
  extendLedger,
  requireLedgerContinuation,
  type LedgerView,
} from './replay';

declare const prepared: unique symbol;
/** An ordinary record prepared against a genuine view, ready to sign exactly once. */
export interface PreparedLedgerRecord {
  readonly [prepared]: true;
  readonly signer: SigningPublicKey;
  signingBytes(): Uint8Array;
}
const proposals = new WeakMap<
  PreparedLedgerRecord,
  { view: LedgerView; body: CborValue; bodyBytes: Uint8Array; signer: SigningPublicKey }
>();
/** Ordinary records only. Canonical bytes/proofs/permissions checked before any signer work. */
export function prepareLedgerRecord(
  view: LedgerView,
  bodyBytes: Uint8Array
): Result.Result<PreparedLedgerRecord, LedgerError> {
  return Result.gen(function* () {
    // Runtime provenance checked before parsing an untrusted body.
    yield* authorizeView(view);
    const body = yield* Result.mapError(
      decodeCbor(bodyBytes),
      (error) => new LedgerError({ code: error.code })
    );
    const unsignedRecord = yield* Result.mapError(
      encodeCbor([body, new Uint8Array(64)]),
      (error) => new LedgerError({ code: error.code })
    );
    const decoded = yield* decodeRecord(unsignedRecord);
    if (decoded.body.type !== 'ordinary') return yield* fail('genesis-mismatch');
    yield* authorizeUnsignedRecord(view, decoded.body);
    const proposal = Object.freeze(
      Object.assign(Object.create(null), {
        signer: decoded.body.signer,
        signingBytes: () => recordSigningBytes(decoded.bodyBytes),
      })
    ) as PreparedLedgerRecord;
    proposals.set(proposal, {
      view,
      body,
      bodyBytes: copyBytes(decoded.bodyBytes),
      signer: decoded.body.signer,
    });
    return proposal;
  });
}
function authorizeView(view: LedgerView) {
  return requireLedgerContinuation(view, view);
}
/** Each run signs once; returned original bytes go to existing durable submission. */
export const signLedgerRecord = Effect.fnUntraced(function* (
  proposal: PreparedLedgerRecord,
  signer: DeviceSigner
): Effect.fn.Return<Uint8Array, LedgerError | ContentError | ValidationError> {
  const owned = proposals.get(proposal);
  if (!owned) return yield* Effect.fail(new LedgerError({ code: 'unauthorized' }));
  const key = yield* Effect.fromResult(
    Result.mapError(
      signingPublicKey(signer.publicKey.toBytes()),
      (error) => new LedgerError({ code: error.code })
    )
  );
  if (!bytesEqual(key.toBytes(), owned.signer.toBytes()))
    return yield* Effect.fail(new LedgerError({ code: 'unauthorized' }));
  const signature = yield* signVerified(signer, recordSigningBytes(owned.bodyBytes));
  const record = yield* Effect.fromResult(
    Result.mapError(
      encodeCbor([owned.body, signature.toBytes()]),
      (error) => new LedgerError({ code: error.code })
    )
  );
  yield* Effect.fromResult(
    extendLedger(owned.view, [record], {
      head: hashRecordBytes(record),
      length: owned.view.length + 1,
    })
  );
  return record;
});
