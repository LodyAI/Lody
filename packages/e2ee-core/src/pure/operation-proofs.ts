import { Either } from 'effect';
import { copyBytes } from './cbor';
import { ValidationError } from './errors';
import { joinRequestSigningBytes, possessionSigningBytes, type Operation } from './ledger-schema';
import type { SignatureJob } from '../capabilities';

/** Construct messages only; these jobs do not attest to a signature or authority.
 * Device targets must come from the actor's preceding verified membership. */
export function operationProofJobs(
  genesis: Uint8Array,
  operation: Operation,
  targetMembershipId?: Uint8Array
): Either.Either<readonly SignatureJob[], ValidationError> {
  return Either.gen(function* () {
    if (operation.type === 'admitMember') {
      return [
        {
          pk: copyBytes(operation.request.signingPublicKey),
          msg: yield* joinRequestSigningBytes(genesis, operation.request),
          sig: copyBytes(operation.request.signature),
        },
      ];
    }
    if (operation.type === 'admitDevice') {
      if (!targetMembershipId) {
        return yield* Either.left(new ValidationError({ code: 'unauthorized' }));
      }
      return [
        {
          pk: copyBytes(operation.signingPublicKey),
          msg: yield* possessionSigningBytes({
            genesis,
            targetMembershipId,
            signingPublicKey: operation.signingPublicKey,
            encryptionPublicKey: operation.encryptionPublicKey,
            kind: operation.kind,
            canManage: operation.canManage,
          }),
          sig: copyBytes(operation.possessionSignature),
        },
      ];
    }
    return [];
  });
}
