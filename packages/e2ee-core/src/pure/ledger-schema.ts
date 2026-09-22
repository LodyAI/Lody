import { SigningFacts } from './signing-facts';
import { Either } from 'effect';
import { ValidationError, type LedgerErrorCode } from './errors';
const fail = (code: LedgerErrorCode): Either.Either<never, ValidationError> =>
  Either.left(new ValidationError({ code }));
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
  type SigningPublicKey,
} from './wire-crypto';
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
  | {
      readonly type: 'removeMember';
      readonly membershipId: Uint8Array;
    }
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
  | {
      readonly type: 'revokeDevice';
      readonly target: SigningPublicKey;
    }
  | {
      readonly type: 'transferOwner';
      readonly successorMembershipId: Uint8Array;
    }
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
  | {
      readonly type: 'genesis';
      readonly fields: GenesisFields;
    }
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
function decodeRole(value: CborValue): Either.Either<Exclude<Role, 'owner'>, ValidationError> {
  return Either.gen(function* () {
    const role = yield* asUint(value, 'invalid-operation');
    if (role === ROLE_ADMIN) return 'admin';
    if (role === ROLE_MEMBER) return 'member';
    if (role === ROLE_GUEST) return 'guest';
    return yield* fail('invalid-operation');
  });
}
function encodeKind(kind: DeviceKind): number {
  if (kind === 'personal') return KIND_PERSONAL;
  if (kind === 'machine') return KIND_MACHINE;
  return KIND_RECOVERY;
}
function decodeKind(value: CborValue): Either.Either<DeviceKind, ValidationError> {
  return Either.gen(function* () {
    const kind = yield* asUint(value, 'invalid-operation');
    if (kind === KIND_PERSONAL) return 'personal';
    if (kind === KIND_MACHINE) return 'machine';
    if (kind === KIND_RECOVERY) return 'recovery';
    return yield* fail('invalid-operation');
  });
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
): Either.Either<Uint8Array, ValidationError> {
  return Either.gen(function* () {
    return yield* joinSigningBytes(joinPayload(genesis, request));
  });
}
export function possessionSigningBytes(input: {
  genesis: Hash;
  targetMembershipId: Uint8Array;
  signingPublicKey: SigningPublicKey;
  encryptionPublicKey: EncryptionPublicKey;
  kind: DeviceKind;
  canManage: boolean;
}): Either.Either<Uint8Array, ValidationError> {
  return Either.gen(function* () {
    return yield* possessSigningBytes([
      copyBytes(input.genesis),
      copyBytes(yield* asExactBytes(input.targetMembershipId, MEMBERSHIP_ID_BYTES)),
      copyBytes(input.signingPublicKey),
      copyBytes(input.encryptionPublicKey),
      encodeKind(input.kind),
      input.canManage,
    ]);
  });
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
function decodeJoinRequest(
  value: CborValue,
  facts = SigningFacts.empty
): Either.Either<JoinRequest, ValidationError> {
  return Either.gen(function* () {
    const parts = yield* asArray(value, 'invalid-operation');
    if (parts.length !== 6) return yield* fail('invalid-operation');
    return {
      requestId: yield* checkRequestId(
        yield* asExactBytes(parts[0]!, REQUEST_ID_BYTES, 'invalid-operation')
      ),
      userId: yield* checkUserId(
        yield* asExactBytes(parts[1]!, USER_ID_BYTES, 'invalid-operation')
      ),
      signingPublicKey: yield* checkSigningPublicKey(
        yield* asExactBytes(parts[2]!, SIGNING_KEY_BYTES, 'invalid-key'),
        facts
      ),
      encryptionPublicKey: yield* checkEncryptionPublicKey(
        yield* asExactBytes(parts[3]!, ENCRYPTION_KEY_BYTES, 'invalid-key')
      ),
      expiresAt: yield* asNullOrUint(parts[4]!),
      signature: yield* checkSignature(
        yield* asExactBytes(parts[5]!, SIGNATURE_BYTES, 'bad-proof')
      ),
    };
  });
}
function encodeOperation(operation: Operation): Either.Either<CborValue, ValidationError> {
  return Either.gen(function* () {
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
    return yield* fail('unknown-operation');
  });
}
function decodeOperation(
  value: CborValue,
  facts = SigningFacts.empty
): Either.Either<Operation, ValidationError> {
  return Either.gen(function* () {
    const parts = yield* asArray(value, 'unknown-operation');
    if (parts.length === 0) return yield* fail('unknown-operation');
    const tag = yield* asUint(parts[0]!, 'unknown-operation');
    switch (tag) {
      case OP_ADMIT_MEMBER: {
        if (parts.length !== 3) return yield* fail('invalid-operation');
        return {
          type: 'admitMember',
          membershipId: yield* checkMembershipId(
            yield* asExactBytes(parts[1]!, MEMBERSHIP_ID_BYTES, 'invalid-operation')
          ),
          request: yield* decodeJoinRequest(parts[2]!, facts),
        };
      }
      case OP_REMOVE_MEMBER: {
        if (parts.length !== 2) return yield* fail('invalid-operation');
        return {
          type: 'removeMember',
          membershipId: yield* checkMembershipId(
            yield* asExactBytes(parts[1]!, MEMBERSHIP_ID_BYTES, 'invalid-operation')
          ),
        };
      }
      case OP_SET_ROLE: {
        if (parts.length !== 3) return yield* fail('invalid-operation');
        return {
          type: 'setRole',
          membershipId: yield* checkMembershipId(
            yield* asExactBytes(parts[1]!, MEMBERSHIP_ID_BYTES, 'invalid-operation')
          ),
          role: yield* decodeRole(parts[2]!),
        };
      }
      case OP_ADMIT_DEVICE: {
        if (parts.length !== 6) return yield* fail('invalid-operation');
        return {
          type: 'admitDevice',
          kind: yield* decodeKind(parts[1]!),
          signingPublicKey: yield* checkSigningPublicKey(
            yield* asExactBytes(parts[2]!, SIGNING_KEY_BYTES, 'invalid-key'),
            facts
          ),
          encryptionPublicKey: yield* checkEncryptionPublicKey(
            yield* asExactBytes(parts[3]!, ENCRYPTION_KEY_BYTES, 'invalid-key')
          ),
          canManage: yield* asBool(parts[4]!, 'invalid-operation'),
          possessionSignature: yield* checkSignature(
            yield* asExactBytes(parts[5]!, SIGNATURE_BYTES, 'bad-proof')
          ),
        };
      }
      case OP_REVOKE_DEVICE: {
        if (parts.length !== 2) return yield* fail('invalid-operation');
        return {
          type: 'revokeDevice',
          target: yield* checkSigningPublicKey(
            yield* asExactBytes(parts[1]!, SIGNING_KEY_BYTES, 'invalid-key'),
            facts
          ),
        };
      }
      case OP_TRANSFER_OWNER: {
        if (parts.length !== 2) return yield* fail('invalid-operation');
        return {
          type: 'transferOwner',
          successorMembershipId: yield* checkMembershipId(
            yield* asExactBytes(parts[1]!, MEMBERSHIP_ID_BYTES, 'invalid-operation')
          ),
        };
      }
      case OP_PUBLISH_EPOCH: {
        if (parts.length !== 4) return yield* fail('invalid-operation');
        const epoch = yield* asUint(parts[1]!, 'invalid-operation');
        const commitment = yield* checkHash(
          yield* asExactBytes(parts[2]!, HASH_BYTES, 'invalid-operation')
        );
        const previous = yield* asExactBytes(parts[3]!, HISTORY_PACKET_BYTES, 'invalid-operation');
        yield* checkEpoch(epoch, 1);
        return {
          type: 'publishEpoch',
          epoch,
          commitment,
          previousEpochKey: yield* checkHistoryPacket(previous),
        };
      }
      default:
        return yield* fail('unknown-operation');
    }
  });
}
export function encodeGenesisBody(
  fields: GenesisFields,
  facts = SigningFacts.empty
): Either.Either<Uint8Array, ValidationError> {
  return Either.gen(function* () {
    yield* checkSigningPublicKey(fields.signer, facts);
    yield* checkUserId(fields.userId);
    yield* checkMembershipId(fields.membershipId);
    yield* checkEncryptionPublicKey(fields.encryptionPublicKey);
    yield* checkHash(fields.epochCommitment);
    return yield* encodeCbor([
      PROTOCOL_VERSION,
      copyBytes(fields.signer),
      copyBytes(fields.userId),
      copyBytes(fields.membershipId),
      copyBytes(fields.encryptionPublicKey),
      copyBytes(fields.epochCommitment),
    ]);
  });
}
export function encodeOrdinaryBody(
  fields: OrdinaryFields,
  facts = SigningFacts.empty
): Either.Either<Uint8Array, ValidationError> {
  return Either.gen(function* () {
    yield* checkHash(fields.previousHash);
    yield* checkSigningPublicKey(fields.signer, facts);
    return yield* encodeCbor([
      copyBytes(fields.previousHash),
      copyBytes(fields.signer),
      yield* encodeOperation(fields.operation),
    ]);
  });
}
export function encodeSignedRecord(
  bodyBytes: Uint8Array,
  signature: Signature
): Either.Either<Uint8Array, ValidationError> {
  return Either.gen(function* () {
    yield* checkSignature(signature);
    const body = yield* decodeCbor(bodyBytes);
    return yield* encodeCbor([body, copyBytes(signature)]);
  });
}
export function signingBytesForBody(
  bodyBytes: Uint8Array
): Either.Either<Uint8Array, ValidationError> {
  return Either.gen(function* () {
    yield* decodeCbor(bodyBytes);
    return recordSigningBytes(bodyBytes);
  });
}
function decodeBody(
  value: CborValue,
  facts = SigningFacts.empty
): Either.Either<Body, ValidationError> {
  return Either.gen(function* () {
    const parts = yield* asArray(value);
    if (parts.length === 6 && typeof parts[0] === 'number') {
      if (parts[0] !== PROTOCOL_VERSION) return yield* fail('unknown-version');
      return {
        type: 'genesis',
        fields: {
          signer: yield* checkSigningPublicKey(
            yield* asExactBytes(parts[1]!, SIGNING_KEY_BYTES, 'invalid-key'),
            facts
          ),
          userId: yield* checkUserId(yield* asExactBytes(parts[2]!, USER_ID_BYTES, 'canonical')),
          membershipId: yield* checkMembershipId(
            yield* asExactBytes(parts[3]!, MEMBERSHIP_ID_BYTES, 'canonical')
          ),
          encryptionPublicKey: yield* checkEncryptionPublicKey(
            yield* asExactBytes(parts[4]!, ENCRYPTION_KEY_BYTES, 'invalid-key')
          ),
          epochCommitment: yield* checkHash(
            yield* asExactBytes(parts[5]!, HASH_BYTES, 'canonical')
          ),
        },
      };
    }
    if (parts.length === 3 && parts[0] instanceof Uint8Array) {
      return {
        type: 'ordinary',
        fields: {
          previousHash: yield* checkHash(yield* asExactBytes(parts[0], HASH_BYTES)),
          signer: yield* checkSigningPublicKey(
            yield* asExactBytes(parts[1]!, SIGNING_KEY_BYTES, 'invalid-key'),
            facts
          ),
          operation: yield* decodeOperation(parts[2]!, facts),
        },
      };
    }
    return yield* fail('canonical');
  });
}
function bodyBytesFromRecord(
  record: Uint8Array,
  bodyValue: CborValue
): Either.Either<Uint8Array, ValidationError> {
  return Either.gen(function* () {
    const signatureStart = record.byteLength - 66;
    if (
      record[0] === 0x82 &&
      signatureStart > 1 &&
      record[signatureStart] === 0x58 &&
      record[signatureStart + 1] === 0x40
    ) {
      return copyBytes(record.subarray(1, signatureStart));
    }
    return yield* encodeCanonical(bodyValue);
  });
}
export function decodeRecord(
  recordBytes: Uint8Array,
  facts = SigningFacts.empty
): Either.Either<DecodedRecord, ValidationError> {
  return Either.gen(function* () {
    const stable = copyBytes(recordBytes);
    const root = yield* asArray(yield* decodeCbor(stable));
    if (root.length !== 2) return yield* fail('canonical');
    const bodyValue = root[0]!;
    const signature = yield* checkSignature(
      yield* asExactBytes(root[1]!, SIGNATURE_BYTES, 'canonical')
    );
    return {
      body: yield* decodeBody(bodyValue, facts),
      bodyBytes: yield* bodyBytesFromRecord(stable, bodyValue),
      signature,
      recordBytes: stable,
    };
  });
}
export function encodeRecord(
  body: Body,
  signature: Signature,
  facts = SigningFacts.empty
): Either.Either<Uint8Array, ValidationError> {
  return Either.gen(function* () {
    const bodyBytes =
      body.type === 'genesis'
        ? yield* encodeGenesisBody(body.fields, facts)
        : yield* encodeOrdinaryBody(body.fields, facts);
    return yield* encodeSignedRecord(bodyBytes, signature);
  });
}

/** Returns updated immutable point facts; neither success nor failure mutates input facts. */
export function decodeRecordWithFacts(bytes: Uint8Array, facts = SigningFacts.empty) {
  return Either.gen(function* () {
    const record = yield* decodeRecord(bytes, facts);
    let next = facts;
    const keys = [record.body.fields.signer];
    if (record.body.type === 'ordinary') {
      const operation = record.body.fields.operation;
      if (operation.type === 'admitMember') keys.push(operation.request.signingPublicKey);
      if (operation.type === 'admitDevice') keys.push(operation.signingPublicKey);
      if (operation.type === 'revokeDevice') keys.push(operation.target);
    }
    for (const key of keys) next = (yield* next.check(key)).facts;
    return { record, facts: next };
  });
}
