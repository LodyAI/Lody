import { Result } from 'effect';
import { bytesEqual, copyBytes } from './cbor';
import { ValidationError } from './errors';
import { decodeRecordWithFacts } from './ledger-schema';
import type { LedgerView } from './records';
import { SigningFacts } from './signing-facts';
import { hashRecordBytes } from './wire-crypto';

/** Select a suffix without trusting unknown snapshot-prefix records. Point facts
 * are reusable validation evidence; signatures and authority are checked later. */
export function selectLedgerPage(input: {
  readonly records: readonly Uint8Array[];
  readonly ledger: LedgerView;
  readonly snapshotMode: boolean;
  readonly snapshotHead?: Uint8Array;
  readonly bound: boolean;
  readonly skippedUnknown: boolean;
  readonly prefixFacts: SigningFacts;
}) {
  return Result.gen(function* () {
    const fresh: Uint8Array[] = [];
    let expectedParent: Uint8Array = input.ledger.head.toBytes();
    let bound = input.bound;
    let skippedUnknown = input.skippedUnknown;
    let prefixFacts = input.prefixFacts;
    const invalid = (code: ValidationError['code']) => Result.fail(new ValidationError({ code }));
    for (const row of input.records) {
      if (!(row instanceof Uint8Array)) return yield* invalid('canonical');
      const record = copyBytes(row);
      const hash = hashRecordBytes(record);
      const wasBound = bound;
      if (input.ledger.hasRecordHash(hash)) {
        if (input.snapshotHead && bytesEqual(hash, input.snapshotHead)) bound = true;
        if (input.snapshotMode && wasBound) return yield* invalid('wrong-parent');
        continue;
      }
      if (!input.snapshotMode) {
        fresh.push(record);
        continue;
      }
      const parsed = yield* decodeRecordWithFacts(record, prefixFacts);
      prefixFacts = parsed.facts;
      const decoded = parsed.record;
      if (decoded.body.type === 'genesis') {
        if (wasBound) return yield* invalid('wrong-parent');
        skippedUnknown = true;
        continue;
      }
      if (bytesEqual(decoded.body.fields.previousHash, expectedParent)) {
        bound = true;
        fresh.push(record);
        expectedParent = new Uint8Array(hash);
        continue;
      }
      if (!wasBound) {
        skippedUnknown = true;
        continue;
      }
      return yield* invalid('wrong-parent');
    }
    return { fresh, bound, skippedUnknown, prefixFacts };
  });
}
