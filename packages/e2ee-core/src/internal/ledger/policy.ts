import { Chunk, HashMap, HashSet, Option, Result } from 'effect';
import type * as Bytes from '../foundation/bytes';
import { keyId } from '../foundation/identifiers';
import { copyBytes } from '../foundation/cbor';
import { fail, type DeviceKind, type RecordBody, type Role } from './records';
import type { LedgerError } from './errors';

/** A current member: user id and role. */
export interface Member {
  readonly userId: Bytes.UserId;
  readonly role: Role;
}
/** A current device: its membership, kind and encryption public key. */
export interface Device {
  readonly membershipId: Bytes.MembershipId;
  readonly kind: DeviceKind;
  readonly encryptionPublicKey: Bytes.EncryptionPublicKey;
}
/** Detached snapshot of the state a verified view describes: owner, members, devices and epoch. */
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
/** Identity established at admission, retained after revocation/role changes. */
export interface HistoricalContentAuthor {
  readonly device: Bytes.SigningPublicKey;
  readonly actor: Bytes.UserId;
  readonly memberInstance: Bytes.MembershipId;
}
/** Signed ledger fact; packet validity/preimage is checked by the key workflow. */
export interface EpochHistoryPacket {
  readonly epoch: number;
  readonly commitment: Bytes.EpochCommitment;
  /** Epoch zero has no previous key: its packet is empty. */
  readonly packet: Uint8Array;
}
export interface InternalState {
  /** Only original tag7/8 bytes actually replayed; endorsed snapshots do not invent them. */
  epochPublications?: HashMap.HashMap<number, Uint8Array>;
  contentAuthors: HashMap.HashMap<string, HistoricalContentAuthor>;
  historyPackets: HashMap.HashMap<number, EpochHistoryPacket>;
  genesis: Bytes.GenesisHash;
  owner: Bytes.MembershipId;
  members: HashMap.HashMap<string, Member>;
  devices: HashMap.HashMap<string, Device>;
  epoch: LedgerState['epoch'];
  usedSigningKeys: HashSet.HashSet<string>;
  usedEncKeys: HashSet.HashSet<string>;
  usedMembershipIds: HashSet.HashSet<string>;
  closedJoins: HashSet.HashSet<string>;
  usedCommitments: HashSet.HashSet<string>;
  /** Only verified consecutive hashes; no invented pre-snapshot entries. */
  hashes: Chunk.Chunk<Bytes.RecordHash>;
  hashesOffset: number;
  verification: 'full-history' | 'endorsed-snapshot';
}
const id = (value: { toBytes(): Uint8Array }) => keyId(value.toBytes());
/** Capability codes this verifier implements. Adding one also adds its state and snapshot field. */
const SUPPORTED_CAPABILITIES: ReadonlySet<number> = new Set();
export function genesisState(
  body: Extract<RecordBody, { type: 'genesis' }>,
  genesis: Bytes.GenesisHash,
  hash: Bytes.RecordHash
): InternalState {
  return {
    contentAuthors: HashMap.fromIterable([
      [
        id(body.signer),
        Object.freeze({
          device: body.signer,
          actor: body.userId,
          memberInstance: body.membershipId,
        }),
      ],
    ]),
    historyPackets: HashMap.fromIterable([
      [0, Object.freeze({ epoch: 0, commitment: body.epochCommitment, packet: new Uint8Array() })],
    ]),
    genesis,
    owner: body.membershipId,
    members: HashMap.fromIterable([
      [id(body.membershipId), Object.freeze({ userId: body.userId, role: 'owner' })],
    ]),
    devices: HashMap.fromIterable([
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
    usedSigningKeys: HashSet.fromIterable([id(body.signer)]),
    usedEncKeys: HashSet.fromIterable([id(body.encryptionPublicKey)]),
    usedMembershipIds: HashSet.fromIterable([id(body.membershipId)]),
    closedJoins: HashSet.empty(),
    usedCommitments: HashSet.fromIterable([id(body.epochCommitment)]),
    hashes: Chunk.of(hash),
    hashesOffset: 0,
    verification: 'full-history',
  };
}
/** Copy only the root holder; HashMap/HashSet/Chunk updates are persistent.
 * Packet rows and opaque byte wrappers are private and immutable; exports copy. */
export function cloneState(s: InternalState): InternalState {
  return { ...s };
}
export const stateGet = <K, V>(map: HashMap.HashMap<K, V>, key: K): V | undefined =>
  Option.getOrUndefined(HashMap.get(map, key));
export const hashAt = (s: InternalState, index: number): Bytes.RecordHash | undefined =>
  Option.getOrUndefined(Chunk.get(s.hashes, index));
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
    const actor = stateGet(s.devices, id(body.signer));
    const member = actor && stateGet(s.members, id(actor.membershipId));
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
          HashSet.has(s.usedMembershipIds, membership) ||
          [...HashMap.values(s.members)].some((m) => id(m.userId) === user) ||
          HashSet.has(s.closedJoins, join) ||
          HashSet.has(s.usedSigningKeys, sign) ||
          HashSet.has(s.usedEncKeys, enc)
        )
          return yield* fail('replay');
        s.usedMembershipIds = HashSet.add(s.usedMembershipIds, membership);
        s.closedJoins = HashSet.add(s.closedJoins, join);
        s.usedSigningKeys = HashSet.add(s.usedSigningKeys, sign);
        s.usedEncKeys = HashSet.add(s.usedEncKeys, enc);
        s.members = HashMap.set(
          s.members,
          membership,
          Object.freeze({ userId: op.request.userId, role: 'member' })
        );
        s.contentAuthors = HashMap.set(
          s.contentAuthors,
          sign,
          Object.freeze({
            device: op.request.signingPublicKey,
            actor: op.request.userId,
            memberInstance: op.membershipId,
          })
        );
        s.devices = HashMap.set(
          s.devices,
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
          found = stateGet(s.members, target);
        if (!owner || target === id(s.owner) || !found) return yield* fail('unauthorized');
        if (found.role === op.role) return yield* fail('invalid-operation');
        s.members = HashMap.set(
          s.members,
          target,
          Object.freeze({ userId: found.userId, role: op.role })
        );
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
        if (HashSet.has(s.usedSigningKeys, sign) || HashSet.has(s.usedEncKeys, enc))
          return yield* fail('replay');
        s.usedSigningKeys = HashSet.add(s.usedSigningKeys, sign);
        s.usedEncKeys = HashSet.add(s.usedEncKeys, enc);
        s.contentAuthors = HashMap.set(
          s.contentAuthors,
          sign,
          Object.freeze({
            device: op.signingPublicKey,
            actor: member.userId,
            memberInstance: actor.membershipId,
          })
        );
        s.devices = HashMap.set(
          s.devices,
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
          found = stateGet(s.devices, target);
        if (
          actor.kind !== 'personal' ||
          !found ||
          id(found.membershipId) !== id(actor.membershipId) ||
          (id(found.membershipId) === id(s.owner) && !canGovern(s, id(s.owner), target))
        )
          return yield* fail('unauthorized');
        s.devices = HashMap.remove(s.devices, target);
        s.epoch = Object.freeze({ ...s.epoch, rotationRequired: true });
        break;
      }
      case 'transferOwner': {
        const target = id(op.successorMembershipId),
          found = stateGet(s.members, target);
        if (!owner || target === id(s.owner) || !found || !canGovern(s, target))
          return yield* fail('unauthorized');
        s.members = HashMap.set(
          s.members,
          id(s.owner),
          Object.freeze({ userId: member.userId, role: 'admin' })
        );
        s.members = HashMap.set(
          s.members,
          target,
          Object.freeze({ userId: found.userId, role: 'owner' })
        );
        s.owner = op.successorMembershipId;
        break;
      }
      case 'declareCapabilities': {
        if (!manage) return yield* fail('unauthorized');
        // Ledger v1 supports no capability yet. A genuine declaration is a valid
        // future record, so stop at it as an upgrade, never as corruption.
        if (op.capabilities.some((code) => !SUPPORTED_CAPABILITIES.has(code)))
          return yield* fail('upgrade-required');
        break;
      }
      case 'publishEpoch':
      case 'removeMemberAndPublishEpoch': {
        if (op.type === 'removeMemberAndPublishEpoch') {
          if (
            !owner ||
            op.membershipId.equals(s.owner) ||
            !HashMap.has(s.members, id(op.membershipId))
          )
            return yield* fail('unauthorized');
        } else if (!manage) return yield* fail('unauthorized');
        if (op.epoch !== s.epoch.number + 1) return yield* fail('invalid-operation');
        if (HashSet.has(s.usedCommitments, id(op.commitment))) return yield* fail('replay');
        if (op.type === 'removeMemberAndPublishEpoch') {
          s.members = HashMap.remove(s.members, id(op.membershipId));
          // Retain author identity, used keys and membership IDs. Only current
          // membership/devices disappear in this same epoch transition.
          for (const [key, device] of s.devices)
            if (device.membershipId.equals(op.membershipId))
              s.devices = HashMap.remove(s.devices, key);
        }
        s.usedCommitments = HashSet.add(s.usedCommitments, id(op.commitment));
        s.historyPackets = HashMap.set(
          s.historyPackets,
          op.epoch,
          Object.freeze({
            epoch: op.epoch,
            commitment: op.commitment,
            packet: copyBytes(op.previousEpochKey),
          })
        );
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
