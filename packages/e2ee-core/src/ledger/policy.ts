import { Result } from 'effect';
import type * as Bytes from '../bytes';
import { keyId } from '../identifiers';
import { fail, type DeviceKind, type RecordBody, type Role } from './records';
import type { LedgerError } from './errors';

export interface Member {
  readonly userId: Bytes.UserId;
  readonly role: Role;
}
export interface Device {
  readonly membershipId: Bytes.MembershipId;
  readonly kind: DeviceKind;
  readonly encryptionPublicKey: Bytes.EncryptionPublicKey;
}
export interface LedgerState {
  readonly genesis: Bytes.GenesisHash;
  readonly owner: Bytes.MembershipId;
  readonly members: ReadonlyMap<string, Member>;
  readonly devices: ReadonlyMap<string, Device>;
  readonly epoch: {
    readonly number: number;
    readonly keyCommitment: Bytes.EpochCommitment;
    readonly rotationRequired: boolean;
  };
}
export interface InternalState {
  genesis: Bytes.GenesisHash;
  owner: Bytes.MembershipId;
  members: Map<string, Member>;
  devices: Map<string, Device>;
  epoch: LedgerState['epoch'];
  usedSigningKeys: Set<string>;
  usedEncKeys: Set<string>;
  usedMembershipIds: Set<string>;
  closedJoins: Set<string>;
  usedCommitments: Set<string>;
  hashes: Bytes.RecordHash[];
}
const id = (value: { toBytes(): Uint8Array }) => keyId(value.toBytes());
export function genesisState(
  body: Extract<RecordBody, { type: 'genesis' }>,
  genesis: Bytes.GenesisHash,
  hash: Bytes.RecordHash
): InternalState {
  return {
    genesis,
    owner: body.membershipId,
    members: new Map([
      [id(body.membershipId), Object.freeze({ userId: body.userId, role: 'owner' })],
    ]),
    devices: new Map([
      [
        id(body.signer),
        Object.freeze({
          membershipId: body.membershipId,
          kind: 'personal',
          encryptionPublicKey: body.encryptionPublicKey,
        }),
      ],
    ]),
    epoch: Object.freeze({
      number: 0,
      keyCommitment: body.epochCommitment,
      rotationRequired: false,
    }),
    usedSigningKeys: new Set([id(body.signer)]),
    usedEncKeys: new Set([id(body.encryptionPublicKey)]),
    usedMembershipIds: new Set([id(body.membershipId)]),
    closedJoins: new Set(),
    usedCommitments: new Set([id(body.epochCommitment)]),
    hashes: [hash],
  };
}
export function cloneState(s: InternalState): InternalState {
  return {
    ...s,
    members: new Map(s.members),
    devices: new Map(s.devices),
    usedSigningKeys: new Set(s.usedSigningKeys),
    usedEncKeys: new Set(s.usedEncKeys),
    usedMembershipIds: new Set(s.usedMembershipIds),
    closedJoins: new Set(s.closedJoins),
    usedCommitments: new Set(s.usedCommitments),
    hashes: [...s.hashes],
  };
}
export function inspectState(s: InternalState): LedgerState {
  return Object.freeze({
    genesis: s.genesis,
    owner: s.owner,
    members: new Map(s.members),
    devices: new Map(s.devices),
    epoch: s.epoch,
  });
}
function canGovern(s: InternalState, membership: string, excluding?: string): boolean {
  return [...s.devices].some(
    ([key, device]) =>
      key !== excluding && id(device.membershipId) === membership && device.kind !== 'machine'
  );
}
/** Private accumulator only. Signature/proof checks precede this function. */
export function applyOperation(
  s: InternalState,
  body: Extract<RecordBody, { type: 'ordinary' }>
): Result.Result<void, LedgerError> {
  return Result.gen(function* () {
    const actor = s.devices.get(id(body.signer));
    const member = actor && s.members.get(id(actor.membershipId));
    if (!actor || !member) return yield* fail('unauthorized');
    const manage =
      actor.kind === 'personal' && (member.role === 'owner' || member.role === 'admin');
    const owner = manage && member.role === 'owner';
    const op = body.operation;
    switch (op.type) {
      case 'admitMember': {
        if (!manage) return yield* fail('unauthorized');
        const membership = id(op.membershipId),
          user = id(op.request.userId);
        const sign = id(op.request.signingPublicKey),
          enc = id(op.request.encryptionPublicKey);
        const join = `${sign}:${id(op.request.requestId)}`;
        if (
          s.usedMembershipIds.has(membership) ||
          [...s.members.values()].some((m) => id(m.userId) === user) ||
          s.closedJoins.has(join) ||
          s.usedSigningKeys.has(sign) ||
          s.usedEncKeys.has(enc)
        )
          return yield* fail('replay');
        s.usedMembershipIds.add(membership);
        s.closedJoins.add(join);
        s.usedSigningKeys.add(sign);
        s.usedEncKeys.add(enc);
        s.members.set(membership, Object.freeze({ userId: op.request.userId, role: 'member' }));
        s.devices.set(
          sign,
          Object.freeze({
            membershipId: op.membershipId,
            kind: 'personal',
            encryptionPublicKey: op.request.encryptionPublicKey,
          })
        );
        break;
      }
      case 'setRole': {
        const target = id(op.membershipId),
          found = s.members.get(target);
        if (!owner || target === id(s.owner) || !found) return yield* fail('unauthorized');
        if (found.role === op.role) return yield* fail('invalid-operation');
        s.members.set(target, Object.freeze({ userId: found.userId, role: op.role }));
        break;
      }
      case 'admitDevice': {
        if (
          actor.kind === 'machine' ||
          (actor.kind === 'recovery' && op.kind !== 'personal') ||
          (member.role === 'guest' && op.kind === 'machine')
        )
          return yield* fail('unauthorized');
        const sign = id(op.signingPublicKey),
          enc = id(op.encryptionPublicKey);
        if (s.usedSigningKeys.has(sign) || s.usedEncKeys.has(enc)) return yield* fail('replay');
        s.usedSigningKeys.add(sign);
        s.usedEncKeys.add(enc);
        s.devices.set(
          sign,
          Object.freeze({
            membershipId: actor.membershipId,
            kind: op.kind,
            encryptionPublicKey: op.encryptionPublicKey,
          })
        );
        break;
      }
      case 'revokeDevice': {
        const target = id(op.target),
          found = s.devices.get(target);
        if (
          actor.kind !== 'personal' ||
          !found ||
          id(found.membershipId) !== id(actor.membershipId) ||
          (id(found.membershipId) === id(s.owner) && !canGovern(s, id(s.owner), target))
        )
          return yield* fail('unauthorized');
        s.devices.delete(target);
        s.epoch = Object.freeze({ ...s.epoch, rotationRequired: true });
        break;
      }
      case 'transferOwner': {
        const target = id(op.successorMembershipId),
          found = s.members.get(target);
        if (!owner || target === id(s.owner) || !found || !canGovern(s, target))
          return yield* fail('unauthorized');
        s.members.set(id(s.owner), Object.freeze({ userId: member.userId, role: 'admin' }));
        s.members.set(target, Object.freeze({ userId: found.userId, role: 'owner' }));
        s.owner = op.successorMembershipId;
        break;
      }
      case 'publishEpoch': {
        if (!manage) return yield* fail('unauthorized');
        if (op.epoch !== s.epoch.number + 1) return yield* fail('invalid-operation');
        if (s.usedCommitments.has(id(op.commitment))) return yield* fail('replay');
        s.usedCommitments.add(id(op.commitment));
        s.epoch = Object.freeze({
          number: op.epoch,
          keyCommitment: op.commitment,
          rotationRequired: false,
        });
        break;
      }
    }
    return undefined;
  });
}
