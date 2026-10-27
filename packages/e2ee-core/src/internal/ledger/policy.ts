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
  /** Present exactly for machine devices, including their historical binding. */
  readonly machineId?: string;
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
/** A device ever admitted, kept after revocation or its member's removal. */
export interface DeviceRecord {
  readonly kind: DeviceKind;
  readonly machineId?: string;
  readonly signingPublicKey: Bytes.SigningPublicKey;
  readonly encryptionPublicKey: Bytes.EncryptionPublicKey;
  readonly membershipId: Bytes.MembershipId;
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
  historyPackets: HashMap.HashMap<number, EpochHistoryPacket>;
  genesis: Bytes.GenesisHash;
  owner: Bytes.MembershipId;
  members: HashMap.HashMap<string, Member>;
  devices: HashMap.HashMap<string, Device>;
  /** Derived index of active machine bindings; never an independent authority. */
  machineDevices: HashMap.HashMap<string, string>;
  epoch: LedgerState['epoch'];
  /** Every membership ever admitted and its user, kept after removal. `members` is only the current ones. */
  membershipUsers: HashMap.HashMap<string, Bytes.UserId>;
  /** Every device ever admitted, by signing key, kept after revocation. `devices` is only the current ones. */
  deviceHistory: HashMap.HashMap<string, DeviceRecord>;
  /** Derived index of `deviceHistory` encryption keys; never encoded. */
  usedEncKeys: HashSet.HashSet<string>;
  /** Derived index of current members' user IDs, for re-admission checks; never encoded. */
  memberUsers: HashSet.HashSet<string>;
  closedJoins: HashSet.HashSet<string>;
  /** Derived index of `historyPackets` commitments; never encoded. */
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
    machineDevices: HashMap.empty(),
    epoch: Object.freeze({
      number: 0,
      keyCommitment: body.epochCommitment,
      rotationRequired: false,
    }),
    membershipUsers: HashMap.fromIterable([[id(body.membershipId), body.userId]]),
    deviceHistory: HashMap.fromIterable([
      [
        id(body.signer),
        Object.freeze({
          kind: 'personal',
          signingPublicKey: body.signer,
          encryptionPublicKey: body.encryptionPublicKey,
          membershipId: body.membershipId,
        }),
      ],
    ]),
    usedEncKeys: HashSet.fromIterable([id(body.encryptionPublicKey)]),
    memberUsers: HashSet.fromIterable([id(body.userId)]),
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
          HashMap.has(s.membershipUsers, membership) ||
          HashSet.has(s.memberUsers, user) ||
          HashSet.has(s.closedJoins, join) ||
          HashMap.has(s.deviceHistory, sign) ||
          HashSet.has(s.usedEncKeys, enc)
        )
          return yield* fail('replay');
        s.membershipUsers = HashMap.set(s.membershipUsers, membership, op.request.userId);
        s.memberUsers = HashSet.add(s.memberUsers, user);
        s.closedJoins = HashSet.add(s.closedJoins, join);
        s.deviceHistory = HashMap.set(
          s.deviceHistory,
          sign,
          Object.freeze({
            kind: 'personal',
            signingPublicKey: op.request.signingPublicKey,
            encryptionPublicKey: op.request.encryptionPublicKey,
            membershipId: op.membershipId,
          })
        );
        s.usedEncKeys = HashSet.add(s.usedEncKeys, enc);
        s.members = HashMap.set(
          s.members,
          membership,
          Object.freeze({ userId: op.request.userId, role: 'member' })
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
        if (HashMap.has(s.deviceHistory, sign) || HashSet.has(s.usedEncKeys, enc))
          return yield* fail('replay');
        // All checks precede either mutation: a replacement is one ledger transition,
        // never a separately completed revocation followed by a fallible admission.
        let replaced: string | undefined;
        if (op.kind === 'machine') {
          if (typeof op.machineId !== 'string' || op.machineId.length === 0)
            return yield* fail('invalid-operation');
          const current = stateGet(s.machineDevices, op.machineId);
          if (op.replaces == null) {
            if (current !== undefined) return yield* fail('invalid-operation');
          } else {
            replaced = id(op.replaces);
            const previous = stateGet(s.devices, replaced);
            if (
              actor.kind !== 'personal' ||
              !previous ||
              previous.kind !== 'machine' ||
              !previous.membershipId.equals(actor.membershipId) ||
              previous.machineId !== op.machineId ||
              current !== replaced
            )
              return yield* fail('unauthorized');
          }
        } else if (op.machineId !== undefined || op.replaces !== undefined) {
          return yield* fail('invalid-operation');
        }
        if (replaced !== undefined) {
          s.devices = HashMap.remove(s.devices, replaced);
          s.epoch = Object.freeze({ ...s.epoch, rotationRequired: true });
        }
        const machineBinding = op.kind === 'machine' ? { machineId: op.machineId } : {};
        s.deviceHistory = HashMap.set(
          s.deviceHistory,
          sign,
          Object.freeze({
            kind: op.kind,
            ...machineBinding,
            signingPublicKey: op.signingPublicKey,
            encryptionPublicKey: op.encryptionPublicKey,
            membershipId: actor.membershipId,
          })
        );
        s.usedEncKeys = HashSet.add(s.usedEncKeys, enc);
        s.devices = HashMap.set(
          s.devices,
          sign,
          Object.freeze({
            membershipId: actor.membershipId,
            kind: op.kind,
            encryptionPublicKey: op.encryptionPublicKey,
            ...machineBinding,
          })
        );
        if (op.kind === 'machine' && op.machineId !== undefined)
          s.machineDevices = HashMap.set(s.machineDevices, op.machineId, sign);
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
        if (found.kind === 'machine' && found.machineId !== undefined)
          s.machineDevices = HashMap.remove(s.machineDevices, found.machineId);
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
          const removed = stateGet(s.members, id(op.membershipId))!;
          s.memberUsers = HashSet.remove(s.memberUsers, id(removed.userId));
          s.members = HashMap.remove(s.members, id(op.membershipId));
          // The history tables keep this membership and its devices, so authorship
          // and replay facts survive; only the current views drop them.
          for (const [key, device] of s.devices) {
            if (!device.membershipId.equals(op.membershipId)) continue;
            s.devices = HashMap.remove(s.devices, key);
            if (device.kind === 'machine' && device.machineId !== undefined)
              s.machineDevices = HashMap.remove(s.machineDevices, device.machineId);
          }
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
