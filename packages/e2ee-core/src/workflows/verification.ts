import { Effect } from 'effect';
import { Ledger } from '../ledger/ledger';
import { decodeRecord as decodeWire } from '../ledger/schema';
import { assertSignature, recordSigningBytes } from '../ledger/crypto';
import { genesisHash, recordHash, signingPublicKey, type GenesisHash } from '../pure/bytes';
import {
  applicableRecord,
  checkedRecord,
  decodedRecord,
  ledgerView,
  rawLedger,
  type ApplicableRecord,
  type DecodedRecord,
  type LedgerView,
  type SignatureCheckedRecord,
} from '../pure/records';
import type { ValidationError } from '../pure/errors';
import { protocol, protocolAsync } from './protocol';

export function decodeRecord(input: Uint8Array): Effect.Effect<DecodedRecord, ValidationError> {
  const bytes = new Uint8Array(input);
  return Effect.gen(function* () {
    const parsed = yield* protocol(() => decodeWire(bytes));
    const signer = yield* signingPublicKey(parsed.body.fields.signer);
    return decodedRecord(parsed.recordBytes, signer);
  });
}

export function verifyRecordSignature(
  record: DecodedRecord
): Effect.Effect<SignatureCheckedRecord, ValidationError> {
  return Effect.gen(function* () {
    const parsed = yield* protocol(() => decodeWire(record.toBytes()));
    yield* protocol(() =>
      assertSignature(
        parsed.body.fields.signer,
        recordSigningBytes(parsed.bodyBytes),
        parsed.signature
      )
    );
    return checkedRecord(record);
  });
}

/** Internal lift of a view produced by the protocol validator, never untrusted state. */
export function verifiedView(ledger: Ledger): Effect.Effect<LedgerView, ValidationError> {
  return Effect.gen(function* () {
    const genesis = yield* genesisHash(ledger.summary().genesis);
    const head = yield* recordHash(ledger.head);
    return ledgerView(ledger, genesis, head);
  });
}

export function verifyLedger(input: {
  readonly anchor: GenesisHash;
  readonly records: readonly Uint8Array[];
}): Effect.Effect<LedgerView, ValidationError> {
  const records = input.records.map((record) => new Uint8Array(record));
  return Effect.flatMap(
    protocolAsync(() => Ledger.verify({ anchor: input.anchor.toBytes(), records })),
    verifiedView
  );
}

export function authorizeRecord(
  view: LedgerView,
  record: SignatureCheckedRecord
): Effect.Effect<ApplicableRecord, ValidationError> {
  return Effect.gen(function* () {
    const next = yield* protocolAsync(() => rawLedger(view).extend([record.toBytes()]));
    return applicableRecord(view, yield* verifiedView(next));
  });
}
