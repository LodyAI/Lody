import { copyBytes } from './cbor';
import type { Hash } from './wire-crypto';
import type { DeviceKind, Role } from './ledger-schema';

export interface Member {
  readonly userId: Uint8Array;
  readonly role: Role;
}

export interface Device {
  readonly membershipId: Uint8Array;
  readonly kind: DeviceKind;
  readonly encryptionPublicKey: Uint8Array;
  readonly canManage: boolean;
}

export interface EpochState {
  readonly number: number;
  readonly keyCommitment: Uint8Array;
  readonly rotationRequired: boolean;
}

export interface OrgState {
  readonly genesis: Hash;
  readonly protocolVersion: 1;
  readonly owner: Uint8Array;
  readonly members: ReadonlyMap<string, Member>;
  readonly devices: ReadonlyMap<string, Device>;
  readonly epoch: EpochState;
}

export interface HistoryPacketRow {
  commitment: Uint8Array;
  packet: Uint8Array;
}

export interface InternalState {
  genesis: Hash;
  owner: Uint8Array;
  members: Map<string, Member>;
  userIndex: Map<string, string>;
  devices: Map<string, Device>;
  epoch: EpochState;
  usedSigningKeys: Set<string>;
  usedEncKeys: Set<string>;
  usedMembershipIds: Set<string>;
  closedJoins: Set<string>;
  usedCommitments: Set<string>;
  hashes: Array<Uint8Array | undefined>;
  origin: 'genesis' | 'snapshot';
  endorser: Uint8Array | null;
  snapshotLength: number | null;
  historyPackets: Map<number, HistoryPacketRow>;
}

export function cloneState(state: InternalState): InternalState {
  const historyPackets = new Map<number, HistoryPacketRow>();
  for (const [epoch, row] of state.historyPackets) {
    historyPackets.set(epoch, {
      commitment: copyBytes(row.commitment),
      packet: copyBytes(row.packet),
    });
  }
  return {
    genesis: copyBytes(state.genesis),
    owner: copyBytes(state.owner),
    members: new Map(Array.from(state.members, ([id, member]) => [id, freezeMember(member)])),
    userIndex: new Map(state.userIndex),
    devices: new Map(Array.from(state.devices, ([id, device]) => [id, freezeDevice(device)])),
    epoch: { ...state.epoch, keyCommitment: copyBytes(state.epoch.keyCommitment) },
    usedSigningKeys: new Set(state.usedSigningKeys),
    usedEncKeys: new Set(state.usedEncKeys),
    usedMembershipIds: new Set(state.usedMembershipIds),
    closedJoins: new Set(state.closedJoins),
    usedCommitments: new Set(state.usedCommitments),
    hashes: state.hashes.map((hash) => (hash ? copyBytes(hash) : undefined)),
    origin: state.origin,
    endorser: state.endorser ? copyBytes(state.endorser) : null,
    snapshotLength: state.snapshotLength,
    historyPackets,
  };
}

function freezeMember(member: Member): Member {
  return Object.freeze({
    userId: copyBytes(member.userId),
    role: member.role,
  });
}

function freezeDevice(device: Device): Device {
  return Object.freeze({
    membershipId: copyBytes(device.membershipId),
    kind: device.kind,
    encryptionPublicKey: copyBytes(device.encryptionPublicKey),
    canManage: device.canManage,
  });
}

export function publicState(state: InternalState): OrgState {
  const members = new Map<string, Member>();
  for (const [id, member] of state.members) members.set(id, freezeMember(member));
  const devices = new Map<string, Device>();
  for (const [id, device] of state.devices) devices.set(id, freezeDevice(device));
  return Object.freeze({
    genesis: copyBytes(state.genesis),
    protocolVersion: 1,
    owner: copyBytes(state.owner),
    members,
    devices,
    epoch: Object.freeze({
      number: state.epoch.number,
      keyCommitment: copyBytes(state.epoch.keyCommitment),
      rotationRequired: state.epoch.rotationRequired,
    }),
  });
}
