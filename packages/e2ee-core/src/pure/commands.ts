import type {
  EncryptionPublicKey,
  EpochCommitment,
  MembershipId,
  RequestId,
  Signature,
  SigningPublicKey,
  UserId,
} from './bytes';
import type { Operation } from './ledger-schema';

/** Initial key material must already be durably retained by the key lifecycle.
 * A commitment is public data, not proof of possession or storage durability. */
export interface CreateLedgerCommand {
  readonly userId: UserId;
  readonly membershipId: MembershipId;
  readonly encryptionPublicKey: EncryptionPublicKey;
  readonly epochCommitment: EpochCommitment;
}

export type DeviceGrant =
  | { readonly kind: 'personal'; readonly canManage: boolean }
  | { readonly kind: 'machine' | 'recovery'; readonly canManage: false };

export type LedgerCommand =
  | {
      readonly _tag: 'AdmitMember';
      readonly membershipId: MembershipId;
      readonly request: {
        readonly requestId: RequestId;
        readonly userId: UserId;
        readonly signingPublicKey: SigningPublicKey;
        readonly encryptionPublicKey: EncryptionPublicKey;
        readonly expiresAt: number | null;
        readonly signature: Signature;
      };
    }
  | { readonly _tag: 'RemoveMember'; readonly membershipId: MembershipId }
  | {
      readonly _tag: 'SetRole';
      readonly membershipId: MembershipId;
      readonly role: 'admin' | 'member' | 'guest';
    }
  | ({
      readonly _tag: 'AdmitDevice';
      readonly signingPublicKey: SigningPublicKey;
      readonly encryptionPublicKey: EncryptionPublicKey;
      readonly possessionSignature: Signature;
    } & DeviceGrant)
  | { readonly _tag: 'RevokeDevice'; readonly target: SigningPublicKey }
  | { readonly _tag: 'TransferOwner'; readonly successorMembershipId: MembershipId };

/** Internal conversion owns all bytes before the first asynchronous operation. */
export function commandOperation(command: LedgerCommand): Operation {
  switch (command._tag) {
    case 'AdmitMember':
      return {
        type: 'admitMember',
        membershipId: command.membershipId.toBytes(),
        request: {
          requestId: command.request.requestId.toBytes(),
          userId: command.request.userId.toBytes(),
          signingPublicKey: command.request.signingPublicKey.toBytes(),
          encryptionPublicKey: command.request.encryptionPublicKey.toBytes(),
          expiresAt: command.request.expiresAt,
          signature: command.request.signature.toBytes(),
        },
      };
    case 'RemoveMember':
      return { type: 'removeMember', membershipId: command.membershipId.toBytes() };
    case 'SetRole':
      return { type: 'setRole', membershipId: command.membershipId.toBytes(), role: command.role };
    case 'AdmitDevice':
      return {
        type: 'admitDevice',
        kind: command.kind,
        canManage: command.canManage,
        signingPublicKey: command.signingPublicKey.toBytes(),
        encryptionPublicKey: command.encryptionPublicKey.toBytes(),
        possessionSignature: command.possessionSignature.toBytes(),
      };
    case 'RevokeDevice':
      return { type: 'revokeDevice', target: command.target.toBytes() };
    case 'TransferOwner':
      return {
        type: 'transferOwner',
        successorMembershipId: command.successorMembershipId.toBytes(),
      };
  }
  const exhaustive: never = command;
  return exhaustive;
}
