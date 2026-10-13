import { Result } from 'effect';
import { sha256 } from '@noble/hashes/sha2.js';
import * as Bytes from '../bytes';
import { decodeCbor, encodeCbor, type CborValue } from '../cbor';
import { concat } from '../concat';
import { LedgerError, type LedgerErrorCode } from './errors';

export type Role = 'owner' | 'admin' | 'member' | 'guest';
export type DeviceKind = 'personal' | 'machine' | 'recovery';
export interface JoinRequest {
  readonly requestId: Bytes.RequestId;
  readonly userId: Bytes.UserId;
  readonly signingPublicKey: Bytes.SigningPublicKey;
  readonly encryptionPublicKey: Bytes.EncryptionPublicKey;
  readonly expiresAt: number | null;
  readonly signature: Bytes.Signature;
}
export type Operation =
  | {
      readonly type: 'admitMember';
      readonly membershipId: Bytes.MembershipId;
      readonly request: JoinRequest;
    }
  | {
      readonly type: 'setRole';
      readonly membershipId: Bytes.MembershipId;
      readonly role: Exclude<Role, 'owner'>;
    }
  | {
      readonly type: 'admitDevice';
      readonly kind: DeviceKind;
      readonly signingPublicKey: Bytes.SigningPublicKey;
      readonly encryptionPublicKey: Bytes.EncryptionPublicKey;
      readonly possessionSignature: Bytes.Signature;
    }
  | { readonly type: 'revokeDevice'; readonly target: Bytes.SigningPublicKey }
  | { readonly type: 'transferOwner'; readonly successorMembershipId: Bytes.MembershipId }
  | {
      readonly type: 'publishEpoch';
      readonly epoch: Bytes.EpochNumber;
      readonly commitment: Bytes.EpochCommitment;
      readonly previousEpochKey: Uint8Array;
    };
export type RecordBody =
  | {
      readonly type: 'genesis';
      readonly signer: Bytes.SigningPublicKey;
      readonly userId: Bytes.UserId;
      readonly membershipId: Bytes.MembershipId;
      readonly encryptionPublicKey: Bytes.EncryptionPublicKey;
      readonly epochCommitment: Bytes.EpochCommitment;
    }
  | {
      readonly type: 'ordinary';
      readonly previousHash: Bytes.RecordHash;
      readonly signer: Bytes.SigningPublicKey;
      readonly operation: Operation;
    };
/** Parsing alone conveys no signature or permission authority. */
export interface DecodedRecord {
  readonly body: RecordBody;
  readonly bodyBytes: Uint8Array;
  readonly signature: Bytes.Signature;
  readonly recordBytes: Uint8Array;
}
export const fail = (code: LedgerErrorCode): Result.Result<never, LedgerError> =>
  Result.fail(new LedgerError({ code }));
const lift = <A>(result: Result.Result<A, { readonly code: LedgerErrorCode }>) =>
  Result.mapError(result, (error) => new LedgerError({ code: error.code }));
function array(
  value: CborValue,
  length?: number
): Result.Result<readonly CborValue[], LedgerError> {
  return Array.isArray(value) && (length === undefined || value.length === length)
    ? Result.succeed(value)
    : fail('canonical');
}
function uint(value: CborValue): Result.Result<number, LedgerError> {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Result.succeed(value)
    : fail('canonical');
}
function parseJoin(value: CborValue): Result.Result<JoinRequest, LedgerError> {
  return Result.gen(function* () {
    const p = yield* array(value, 6);
    return Object.freeze({
      requestId: yield* lift(Bytes.requestId(p[0])),
      userId: yield* lift(Bytes.userId(p[1])),
      signingPublicKey: yield* lift(Bytes.signingPublicKey(p[2])),
      encryptionPublicKey: yield* lift(Bytes.encryptionPublicKey(p[3])),
      expiresAt: p[4] === null ? null : yield* uint(p[4]!),
      signature: yield* lift(Bytes.signature(p[5])),
    });
  });
}
function parseOperation(value: CborValue): Result.Result<Operation, LedgerError> {
  return Result.gen(function* () {
    const p = yield* array(value);
    const tag = yield* uint(p[0]!);
    switch (tag) {
      case 1:
        yield* array(p, 3);
        return Object.freeze({
          type: 'admitMember',
          membershipId: yield* lift(Bytes.membershipId(p[1])),
          request: yield* parseJoin(p[2]!),
        });
      // Tag 2 is the obsolete non-atomic removal. P12 owns its replacement.
      case 3: {
        yield* array(p, 3);
        const role = p[2] === 1 ? 'admin' : p[2] === 2 ? 'member' : p[2] === 3 ? 'guest' : null;
        if (role === null) return yield* fail('invalid-operation');
        return Object.freeze({
          type: 'setRole',
          membershipId: yield* lift(Bytes.membershipId(p[1])),
          role,
        });
      }
      case 4: {
        yield* array(p, 5);
        const kind =
          p[1] === 0 ? 'personal' : p[1] === 1 ? 'machine' : p[1] === 2 ? 'recovery' : null;
        if (kind === null) return yield* fail('invalid-operation');
        return Object.freeze({
          type: 'admitDevice',
          kind,
          signingPublicKey: yield* lift(Bytes.signingPublicKey(p[2])),
          encryptionPublicKey: yield* lift(Bytes.encryptionPublicKey(p[3])),
          possessionSignature: yield* lift(Bytes.signature(p[4])),
        });
      }
      case 5:
        yield* array(p, 2);
        return Object.freeze({
          type: 'revokeDevice',
          target: yield* lift(Bytes.signingPublicKey(p[1])),
        });
      case 6:
        yield* array(p, 2);
        return Object.freeze({
          type: 'transferOwner',
          successorMembershipId: yield* lift(Bytes.membershipId(p[1])),
        });
      case 7: {
        yield* array(p, 4);
        const epoch = yield* lift(Bytes.epochNumber(p[1]));
        if (epoch === 0 || !(p[3] instanceof Uint8Array) || p[3].length !== 72)
          return yield* fail('invalid-operation');
        return Object.freeze({
          type: 'publishEpoch',
          epoch,
          commitment: yield* lift(Bytes.epochCommitment(p[2])),
          previousEpochKey: new Uint8Array(p[3]),
        });
      }
      default:
        return yield* fail('unknown-operation');
    }
  });
}
export function decodeRecord(input: unknown): Result.Result<DecodedRecord, LedgerError> {
  return Result.gen(function* () {
    const root = yield* array(yield* lift(decodeCbor(input)), 2);
    const p = yield* array(root[0]!);
    let body: RecordBody;
    if (p.length === 6 && typeof p[0] === 'number') {
      if (p[0] !== 1) return yield* fail('unknown-version');
      body = Object.freeze({
        type: 'genesis',
        signer: yield* lift(Bytes.signingPublicKey(p[1])),
        userId: yield* lift(Bytes.userId(p[2])),
        membershipId: yield* lift(Bytes.membershipId(p[3])),
        encryptionPublicKey: yield* lift(Bytes.encryptionPublicKey(p[4])),
        epochCommitment: yield* lift(Bytes.epochCommitment(p[5])),
      });
    } else {
      yield* array(p, 3);
      body = Object.freeze({
        type: 'ordinary',
        previousHash: yield* lift(Bytes.recordHash(p[0])),
        signer: yield* lift(Bytes.signingPublicKey(p[1])),
        operation: yield* parseOperation(p[2]!),
      });
    }
    return Object.freeze({
      body,
      bodyBytes: yield* lift(encodeCbor(p)),
      signature: yield* lift(Bytes.signature(root[1])),
      recordBytes: yield* lift(encodeCbor(root)),
    });
  });
}
const domain = (name: string) => new TextEncoder().encode(`lody-e2ee/${name}\0`);
export const recordSigningBytes = (body: Uint8Array) => concat([domain('sig/v1'), body]);
export const hashRecordBytes = (record: Uint8Array): Bytes.RecordHash =>
  Result.getOrThrow(
    Bytes.recordHash(sha256.create().update(domain('rec/v1')).update(record).digest())
  );
export function joinRequestSigningBytes(
  genesis: Bytes.GenesisHash,
  request: Omit<JoinRequest, 'signature'>
) {
  return Result.map(
    lift(
      encodeCbor([
        genesis.toBytes(),
        request.requestId.toBytes(),
        request.userId.toBytes(),
        request.signingPublicKey.toBytes(),
        request.encryptionPublicKey.toBytes(),
        request.expiresAt,
      ])
    ),
    (body) => concat([domain('join/v1'), body])
  );
}
export function possessionSigningBytes(input: {
  readonly genesis: Bytes.GenesisHash;
  readonly targetMembershipId: Bytes.MembershipId;
  readonly signingPublicKey: Bytes.SigningPublicKey;
  readonly encryptionPublicKey: Bytes.EncryptionPublicKey;
  readonly kind: DeviceKind;
}) {
  return Result.map(
    lift(
      encodeCbor([
        input.genesis.toBytes(),
        input.targetMembershipId.toBytes(),
        input.signingPublicKey.toBytes(),
        input.encryptionPublicKey.toBytes(),
        input.kind === 'personal' ? 0 : input.kind === 'machine' ? 1 : 2,
      ])
    ),
    (body) => concat([domain('possess/v2'), body])
  );
}
