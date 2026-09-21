import {
  asArray,
  asBool,
  asExactBytes,
  asNullOrUint,
  asUint,
  copyBytes,
  decodeCbor,
  encodeCanonical,
  encodeCbor,
  type CborValue,
} from './cbor';
import {
  ENCRYPTION_KEY_BYTES,
  HASH_BYTES,
  HISTORY_PACKET_BYTES,
  MEMBERSHIP_ID_BYTES,
  PROTOCOL_VERSION,
  REQUEST_ID_BYTES,
  SIGNATURE_BYTES,
  SIGNING_KEY_BYTES,
  USER_ID_BYTES,
  checkEncryptionPublicKey,
  checkEpoch,
  checkHash,
  checkHistoryPacket,
  checkMembershipId,
  checkRequestId,
  checkSignature,
  checkSigningPublicKey,
  checkUserId,
  joinSigningBytes,
  possessSigningBytes,
  recordSigningBytes,
  type EncryptionPublicKey,
  type Hash,
  type Signature,
  type SigningPointCache,
  type SigningPublicKey,
} from './crypto';
import { fail } from './error';

export type Role = 'owner' | 'admin' | 'member' | 'guest';
export type DeviceKind = 'personal' | 'machine' | 'recovery';

export const ROLE_ADMIN = 1;
export const ROLE_MEMBER = 2;
export const ROLE_GUEST = 3;
export const KIND_PERSONAL = 0;
export const KIND_MACHINE = 1;
export const KIND_RECOVERY = 2;
export const OP_ADMIT_MEMBER = 1;
export const OP_REMOVE_MEMBER = 2;
export const OP_SET_ROLE = 3;
export const OP_ADMIT_DEVICE = 4;
export const OP_REVOKE_DEVICE = 5;
export const OP_TRANSFER_OWNER = 6;
export const OP_PUBLISH_EPOCH = 7;

export interface JoinRequest {
  readonly requestId: Uint8Array;
  readonly userId: Uint8Array;
  readonly signingPublicKey: SigningPublicKey;
  readonly encryptionPublicKey: EncryptionPublicKey;
  readonly expiresAt: number | null;
  readonly signature: Signature;
}

export type Operation =
  | {
      readonly type: 'admitMember';
      readonly membershipId: Uint8Array;
      readonly request: JoinRequest;
    }
  | { readonly type: 'removeMember'; readonly membershipId: Uint8Array }
  | {
      readonly type: 'setRole';
      readonly membershipId: Uint8Array;
      readonly role: Exclude<Role, 'owner'>;
    }
  | {
      readonly type: 'admitDevice';
      readonly kind: DeviceKind;
      readonly signingPublicKey: SigningPublicKey;
      readonly encryptionPublicKey: EncryptionPublicKey;
      readonly canManage: boolean;
      readonly possessionSignature: Signature;
    }
  | { readonly type: 'revokeDevice'; readonly target: SigningPublicKey }
  | { readonly type: 'transferOwner'; readonly successorMembershipId: Uint8Array }
  | {
      readonly type: 'publishEpoch';
      readonly epoch: number;
      readonly commitment: Hash;
      readonly previousEpochKey: Uint8Array;
    };

export interface GenesisFields {
  readonly signer: SigningPublicKey;
  readonly userId: Uint8Array;
  readonly membershipId: Uint8Array;
  readonly encryptionPublicKey: EncryptionPublicKey;
  readonly epochCommitment: Hash;
}

export interface OrdinaryFields {
  readonly previousHash: Hash;
  readonly signer: SigningPublicKey;
  readonly operation: Operation;
}

export type Body =
  | { readonly type: 'genesis'; readonly fields: GenesisFields }
  | {
      readonly type: 'ordinary';
      readonly fields: OrdinaryFields;
    };

export interface DecodedRecord {
  readonly body: Body;
  readonly bodyBytes: Uint8Array;
  readonly signature: Signature;
  readonly recordBytes: Uint8Array;
}

function encodeRole(role: Exclude<Role, 'owner'>): number {
  if (role === 'admin') return ROLE_ADMIN;
  if (role === 'member') return ROLE_MEMBER;
  return ROLE_GUEST;
}

function decodeRole(value: CborValue): Exclude<Role, 'owner'> {
  const role = asUint(value, 'invalid-operation');
  if (role === ROLE_ADMIN) return 'admin';
  if (role === ROLE_MEMBER) return 'member';
  if (role === ROLE_GUEST) return 'guest';
  return fail('invalid-operation');
}

function encodeKind(kind: DeviceKind): number {
  if (kind === 'personal') return KIND_PERSONAL;
  if (kind === 'machine') return KIND_MACHINE;
  return KIND_RECOVERY;
}

function decodeKind(value: CborValue): DeviceKind {
  const kind = asUint(value, 'invalid-operation');
  if (kind === KIND_PERSONAL) return 'personal';
  if (kind === KIND_MACHINE) return 'machine';
  if (kind === KIND_RECOVERY) return 'recovery';
  return fail('invalid-operation');
}

function joinPayload(genesis: Hash, request: Omit<JoinRequest, 'signature'>): CborValue {
  return [
    copyBytes(genesis),
    copyBytes(request.requestId),
    copyBytes(request.userId),
    copyBytes(request.signingPublicKey),
    copyBytes(request.encryptionPublicKey),
    request.expiresAt,
  ];
}

export function joinRequestSigningBytes(
  genesis: Hash,
  request: Omit<JoinRequest, 'signature'>
): Uint8Array {
  return joinSigningBytes(joinPayload(genesis, request));
}

export function possessionSigningBytes(input: {
  genesis: Hash;
  signingPublicKey: SigningPublicKey;
  encryptionPublicKey: EncryptionPublicKey;
  kind: DeviceKind;
  canManage: boolean;
}): Uint8Array {
  return possessSigningBytes([
    copyBytes(input.genesis),
    copyBytes(input.signingPublicKey),
    copyBytes(input.encryptionPublicKey),
    encodeKind(input.kind),
    input.canManage,
  ]);
}

function encodeJoinRequest(request: JoinRequest): CborValue {
  return [
    copyBytes(request.requestId),
    copyBytes(request.userId),
    copyBytes(request.signingPublicKey),
    copyBytes(request.encryptionPublicKey),
    request.expiresAt,
    copyBytes(request.signature),
  ];
}

function decodeJoinRequest(value: CborValue, cache?: SigningPointCache): JoinRequest {
  const parts = asArray(value, 'invalid-operation');
  if (parts.length !== 6) fail('invalid-operation');
  return {
    requestId: checkRequestId(asExactBytes(parts[0]!, REQUEST_ID_BYTES, 'invalid-operation')),
    userId: checkUserId(asExactBytes(parts[1]!, USER_ID_BYTES, 'invalid-operation')),
    signingPublicKey: checkSigningPublicKey(
      asExactBytes(parts[2]!, SIGNING_KEY_BYTES, 'invalid-key'),
      cache
    ),
    encryptionPublicKey: checkEncryptionPublicKey(
      asExactBytes(parts[3]!, ENCRYPTION_KEY_BYTES, 'invalid-key')
    ),
    expiresAt: asNullOrUint(parts[4]!),
    signature: checkSignature(asExactBytes(parts[5]!, SIGNATURE_BYTES, 'bad-proof')),
  };
}

function encodeOperation(operation: Operation): CborValue {
  switch (operation.type) {
    case 'admitMember':
      return [
        OP_ADMIT_MEMBER,
        copyBytes(operation.membershipId),
        encodeJoinRequest(operation.request),
      ];
    case 'removeMember':
      return [OP_REMOVE_MEMBER, copyBytes(operation.membershipId)];
    case 'setRole':
      return [OP_SET_ROLE, copyBytes(operation.membershipId), encodeRole(operation.role)];
    case 'admitDevice':
      return [
        OP_ADMIT_DEVICE,
        encodeKind(operation.kind),
        copyBytes(operation.signingPublicKey),
        copyBytes(operation.encryptionPublicKey),
        operation.canManage,
        copyBytes(operation.possessionSignature),
      ];
    case 'revokeDevice':
      return [OP_REVOKE_DEVICE, copyBytes(operation.target)];
    case 'transferOwner':
      return [OP_TRANSFER_OWNER, copyBytes(operation.successorMembershipId)];
    case 'publishEpoch':
      return [
        OP_PUBLISH_EPOCH,
        operation.epoch,
        copyBytes(operation.commitment),
        copyBytes(operation.previousEpochKey),
      ];
  }
  return fail('unknown-operation');
}

function decodeOperation(value: CborValue, cache?: SigningPointCache): Operation {
  const parts = asArray(value, 'unknown-operation');
  if (parts.length === 0) fail('unknown-operation');
  const tag = asUint(parts[0]!, 'unknown-operation');
  switch (tag) {
    case OP_ADMIT_MEMBER: {
      if (parts.length !== 3) fail('invalid-operation');
      return {
        type: 'admitMember',
        membershipId: checkMembershipId(
          asExactBytes(parts[1]!, MEMBERSHIP_ID_BYTES, 'invalid-operation')
        ),
        request: decodeJoinRequest(parts[2]!, cache),
      };
    }
    case OP_REMOVE_MEMBER: {
      if (parts.length !== 2) fail('invalid-operation');
      return {
        type: 'removeMember',
        membershipId: checkMembershipId(
          asExactBytes(parts[1]!, MEMBERSHIP_ID_BYTES, 'invalid-operation')
        ),
      };
    }
    case OP_SET_ROLE: {
      if (parts.length !== 3) fail('invalid-operation');
      return {
        type: 'setRole',
        membershipId: checkMembershipId(
          asExactBytes(parts[1]!, MEMBERSHIP_ID_BYTES, 'invalid-operation')
        ),
        role: decodeRole(parts[2]!),
      };
    }
    case OP_ADMIT_DEVICE: {
      if (parts.length !== 6) fail('invalid-operation');
      return {
        type: 'admitDevice',
        kind: decodeKind(parts[1]!),
        signingPublicKey: checkSigningPublicKey(
          asExactBytes(parts[2]!, SIGNING_KEY_BYTES, 'invalid-key'),
          cache
        ),
        encryptionPublicKey: checkEncryptionPublicKey(
          asExactBytes(parts[3]!, ENCRYPTION_KEY_BYTES, 'invalid-key')
        ),
        canManage: asBool(parts[4]!, 'invalid-operation'),
        possessionSignature: checkSignature(asExactBytes(parts[5]!, SIGNATURE_BYTES, 'bad-proof')),
      };
    }
    case OP_REVOKE_DEVICE: {
      if (parts.length !== 2) fail('invalid-operation');
      return {
        type: 'revokeDevice',
        target: checkSigningPublicKey(
          asExactBytes(parts[1]!, SIGNING_KEY_BYTES, 'invalid-key'),
          cache
        ),
      };
    }
    case OP_TRANSFER_OWNER: {
      if (parts.length !== 2) fail('invalid-operation');
      return {
        type: 'transferOwner',
        successorMembershipId: checkMembershipId(
          asExactBytes(parts[1]!, MEMBERSHIP_ID_BYTES, 'invalid-operation')
        ),
      };
    }
    case OP_PUBLISH_EPOCH: {
      if (parts.length !== 4) fail('invalid-operation');
      const epoch = asUint(parts[1]!, 'invalid-operation');
      const commitment = checkHash(asExactBytes(parts[2]!, HASH_BYTES, 'invalid-operation'));
      const previous = asExactBytes(parts[3]!, HISTORY_PACKET_BYTES, 'invalid-operation');
      checkEpoch(epoch, 1);
      return {
        type: 'publishEpoch',
        epoch,
        commitment,
        previousEpochKey: checkHistoryPacket(previous),
      };
    }
    default:
      return fail('unknown-operation');
  }
}

export function encodeGenesisBody(fields: GenesisFields, cache?: SigningPointCache): Uint8Array {
  checkSigningPublicKey(fields.signer, cache);
  checkUserId(fields.userId);
  checkMembershipId(fields.membershipId);
  checkEncryptionPublicKey(fields.encryptionPublicKey);
  checkHash(fields.epochCommitment);
  return encodeCbor([
    PROTOCOL_VERSION,
    copyBytes(fields.signer),
    copyBytes(fields.userId),
    copyBytes(fields.membershipId),
    copyBytes(fields.encryptionPublicKey),
    copyBytes(fields.epochCommitment),
  ]);
}

export function encodeOrdinaryBody(fields: OrdinaryFields, cache?: SigningPointCache): Uint8Array {
  checkHash(fields.previousHash);
  checkSigningPublicKey(fields.signer, cache);
  return encodeCbor([
    copyBytes(fields.previousHash),
    copyBytes(fields.signer),
    encodeOperation(fields.operation),
  ]);
}

export function encodeSignedRecord(bodyBytes: Uint8Array, signature: Signature): Uint8Array {
  checkSignature(signature);
  const body = decodeCbor(bodyBytes);
  return encodeCbor([body, copyBytes(signature)]);
}

export function signingBytesForBody(bodyBytes: Uint8Array): Uint8Array {
  decodeCbor(bodyBytes);
  return recordSigningBytes(bodyBytes);
}

function decodeBody(value: CborValue, cache?: SigningPointCache): Body {
  const parts = asArray(value);
  if (parts.length === 6 && typeof parts[0] === 'number') {
    if (parts[0] !== PROTOCOL_VERSION) fail('unknown-version');
    return {
      type: 'genesis',
      fields: {
        signer: checkSigningPublicKey(
          asExactBytes(parts[1]!, SIGNING_KEY_BYTES, 'invalid-key'),
          cache
        ),
        userId: checkUserId(asExactBytes(parts[2]!, USER_ID_BYTES, 'canonical')),
        membershipId: checkMembershipId(asExactBytes(parts[3]!, MEMBERSHIP_ID_BYTES, 'canonical')),
        encryptionPublicKey: checkEncryptionPublicKey(
          asExactBytes(parts[4]!, ENCRYPTION_KEY_BYTES, 'invalid-key')
        ),
        epochCommitment: checkHash(asExactBytes(parts[5]!, HASH_BYTES, 'canonical')),
      },
    };
  }
  if (parts.length === 3 && parts[0] instanceof Uint8Array) {
    return {
      type: 'ordinary',
      fields: {
        previousHash: checkHash(asExactBytes(parts[0], HASH_BYTES)),
        signer: checkSigningPublicKey(
          asExactBytes(parts[1]!, SIGNING_KEY_BYTES, 'invalid-key'),
          cache
        ),
        operation: decodeOperation(parts[2]!, cache),
      },
    };
  }
  return fail('canonical');
}

function bodyBytesFromRecord(record: Uint8Array, bodyValue: CborValue): Uint8Array {
  const signatureStart = record.byteLength - 66;
  if (
    record[0] === 0x82 &&
    signatureStart > 1 &&
    record[signatureStart] === 0x58 &&
    record[signatureStart + 1] === 0x40
  ) {
    return copyBytes(record.subarray(1, signatureStart));
  }
  return encodeCanonical(bodyValue);
}

export function decodeRecord(recordBytes: Uint8Array, cache?: SigningPointCache): DecodedRecord {
  const stable = copyBytes(recordBytes);
  const root = asArray(decodeCbor(stable, true));
  if (root.length !== 2) fail('canonical');
  const bodyValue = root[0]!;
  const signature = checkSignature(asExactBytes(root[1]!, SIGNATURE_BYTES, 'canonical'));
  return {
    body: decodeBody(bodyValue, cache),
    bodyBytes: bodyBytesFromRecord(stable, bodyValue),
    signature,
    recordBytes: stable,
  };
}

export function encodeRecord(
  body: Body,
  signature: Signature,
  cache?: SigningPointCache
): Uint8Array {
  const bodyBytes =
    body.type === 'genesis'
      ? encodeGenesisBody(body.fields, cache)
      : encodeOrdinaryBody(body.fields, cache);
  return encodeSignedRecord(bodyBytes, signature);
}
