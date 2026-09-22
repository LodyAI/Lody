import { Either } from 'effect';
import { bytesEqual } from './cbor';
import { ValidationError } from './errors';
import { applyPolicyChanges, genesisState, operationChanges } from './ledger-policy';
import type { InternalState } from './ledger-state';
import type { DecodedRecord } from './ledger-schema';
import { SigningFacts } from './signing-facts';

const positioned = (error: ValidationError, position: number) =>
  error.position === undefined ? new ValidationError({ code: error.code, position }) : error;

/** Policy replay of one already-decoded record. Does not verify signatures. */
export function applyDecodedRecord(
  state: InternalState | undefined,
  decoded: DecodedRecord,
  recordHash: Uint8Array,
  position: number,
  expectedAnchor: Uint8Array | undefined,
  facts = SigningFacts.empty
): Either.Either<InternalState, ValidationError> {
  return Either.gen(function* () {
    if (decoded.body.type === 'genesis') {
      if (position !== 0)
        return yield* Either.left(
          positioned(new ValidationError({ code: 'genesis-mismatch' }), position)
        );
      if (expectedAnchor && !bytesEqual(recordHash, expectedAnchor))
        return yield* Either.left(
          positioned(new ValidationError({ code: 'wrong-anchor' }), position)
        );
      if (state)
        return yield* Either.left(
          positioned(new ValidationError({ code: 'genesis-mismatch' }), position)
        );
      return yield* Either.mapLeft(genesisState(decoded.body.fields, recordHash, facts), (error) =>
        positioned(error, position)
      );
    }
    if (!state || position === 0 || decoded.body.type !== 'ordinary')
      return yield* Either.left(
        positioned(new ValidationError({ code: 'genesis-mismatch' }), position)
      );
    const ordinary = decoded.body.fields;
    const parent = state.hashes[state.hashes.length - 1];
    if (!parent || !bytesEqual(ordinary.previousHash, parent))
      return yield* Either.left(
        positioned(new ValidationError({ code: 'wrong-parent' }), position)
      );
    const changes = yield* Either.mapLeft(
      operationChanges(state, ordinary.signer, ordinary.operation, facts),
      (error) => positioned(error, position)
    );
    applyPolicyChanges(state, changes);
    state.hashes.push(recordHash);
    return state;
  });
}
