import { Result } from 'effect';
import { Bytes, ValidationError, type LedgerCommand } from '@lody/e2ee-core/effect';
import type { Operation } from '@lody/e2ee-core/ledger';

export function ledgerCommand(operation: Operation): Result.Result<LedgerCommand, ValidationError> {
  return Result.gen(function* () {
    switch (operation.type) {
      case 'admitMember':
        return {
          _tag: 'AdmitMember' as const,
          membershipId: yield* Bytes.membershipId(operation.membershipId),
          request: {
            requestId: yield* Bytes.requestId(operation.request.requestId),
            userId: yield* Bytes.userId(operation.request.userId),
            signingPublicKey: yield* Bytes.signingPublicKey(operation.request.signingPublicKey),
            encryptionPublicKey: yield* Bytes.encryptionPublicKey(
              operation.request.encryptionPublicKey
            ),
            expiresAt: operation.request.expiresAt,
            signature: yield* Bytes.signature(operation.request.signature),
          },
        };
      case 'removeMember':
        return {
          _tag: 'RemoveMember' as const,
          membershipId: yield* Bytes.membershipId(operation.membershipId),
        };
      case 'setRole':
        return {
          _tag: 'SetRole' as const,
          membershipId: yield* Bytes.membershipId(operation.membershipId),
          role: operation.role,
        };
      case 'admitDevice': {
        const signingPublicKey = yield* Bytes.signingPublicKey(operation.signingPublicKey);
        const encryptionPublicKey = yield* Bytes.encryptionPublicKey(operation.encryptionPublicKey);
        const possessionSignature = yield* Bytes.signature(operation.possessionSignature);
        return {
          _tag: 'AdmitDevice' as const,
          kind: operation.kind,
          signingPublicKey,
          encryptionPublicKey,
          possessionSignature,
        };
      }
      case 'revokeDevice':
        return {
          _tag: 'RevokeDevice' as const,
          target: yield* Bytes.signingPublicKey(operation.target),
        };
      case 'transferOwner':
        return {
          _tag: 'TransferOwner' as const,
          successorMembershipId: yield* Bytes.membershipId(operation.successorMembershipId),
        };
      case 'publishEpoch':
        return yield* Result.fail(new ValidationError({ code: 'invalid-operation' }));
    }
    const exhaustive: never = operation;
    return exhaustive;
  });
}
