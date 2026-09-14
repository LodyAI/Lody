import { copyBytes } from './cbor';
import {
  assertSignature,
  checkEncryptionPublicKey,
  checkSigningPublicKey,
  joinKey,
  keyId,
  type Hash,
  type SigningPublicKey,
} from './crypto';
import { fail } from './error';
import {
  joinRequestSigningBytes,
  possessionSigningBytes,
  type DeviceKind,
  type GenesisFields,
  type Operation,
  type Role,
} from './schema';

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
    genesis: state.genesis,
    owner: copyBytes(state.owner),
    members: new Map(state.members),
    userIndex: new Map(state.userIndex),
    devices: new Map(state.devices),
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

function claimSigning(state: InternalState, key: SigningPublicKey): string {
  const id = keyId(checkSigningPublicKey(key));
  if (state.usedSigningKeys.has(id) || state.devices.has(id)) fail('replay');
  return id;
}

function claimEnc(state: InternalState, key: Uint8Array): string {
  const id = keyId(checkEncryptionPublicKey(key));
  if (state.usedEncKeys.has(id)) fail('replay');
  return id;
}

function activeDevice(state: InternalState, signer: SigningPublicKey): Device {
  const device = state.devices.get(keyId(signer));
  if (!device) fail('unauthorized');
  return device;
}

function memberOf(state: InternalState, device: Device): Member {
  const member = state.members.get(keyId(device.membershipId));
  if (!member) fail('unauthorized');
  return member;
}

function requirePersonalManage(
  state: InternalState,
  signer: SigningPublicKey
): { device: Device; member: Member } {
  const device = activeDevice(state, signer);
  if (device.kind !== 'personal' || !device.canManage) fail('unauthorized');
  const member = memberOf(state, device);
  if (member.role !== 'owner' && member.role !== 'admin') fail('unauthorized');
  return { device, member };
}

function requireOwnerManage(
  state: InternalState,
  signer: SigningPublicKey
): { device: Device; member: Member } {
  const found = requirePersonalManage(state, signer);
  if (found.member.role !== 'owner') fail('unauthorized');
  return found;
}

function requireOwnPersonalOrRecovery(
  state: InternalState,
  signer: SigningPublicKey
): { device: Device; member: Member } {
  const device = activeDevice(state, signer);
  if (device.kind !== 'personal' && device.kind !== 'recovery') fail('unauthorized');
  return { device, member: memberOf(state, device) };
}

function requireOwnPersonal(
  state: InternalState,
  signer: SigningPublicKey
): { device: Device; member: Member } {
  const device = activeDevice(state, signer);
  if (device.kind !== 'personal') fail('unauthorized');
  return { device, member: memberOf(state, device) };
}

function markRotation(state: InternalState): void {
  state.epoch = { ...state.epoch, rotationRequired: true };
}

export function verifyOperationProofs(genesis: Hash, operation: Operation): void {
  if (operation.type === 'admitMember') {
    assertSignature(
      operation.request.signingPublicKey,
      joinRequestSigningBytes(genesis, operation.request),
      operation.request.signature,
      'bad-proof'
    );
    return;
  }
  if (operation.type === 'admitDevice') {
    assertSignature(
      operation.signingPublicKey,
      possessionSigningBytes({
        genesis,
        signingPublicKey: operation.signingPublicKey,
        encryptionPublicKey: operation.encryptionPublicKey,
        kind: operation.kind,
        canManage: operation.canManage,
      }),
      operation.possessionSignature,
      'bad-proof'
    );
  }
}

export function applyGenesis(fields: GenesisFields, recordHash: Hash): InternalState {
  const signerId = keyId(checkSigningPublicKey(fields.signer));
  const encId = keyId(checkEncryptionPublicKey(fields.encryptionPublicKey));
  const membershipId = copyBytes(fields.membershipId);
  const userId = copyBytes(fields.userId);
  const member: Member = { userId, role: 'owner' };
  const device: Device = {
    membershipId,
    kind: 'personal',
    encryptionPublicKey: copyBytes(fields.encryptionPublicKey),
    canManage: true,
  };
  return {
    genesis: copyBytes(recordHash),
    owner: membershipId,
    members: new Map([[keyId(membershipId), member]]),
    userIndex: new Map([[keyId(userId), keyId(membershipId)]]),
    devices: new Map([[signerId, device]]),
    epoch: {
      number: 0,
      keyCommitment: copyBytes(fields.epochCommitment),
      rotationRequired: false,
    },
    usedSigningKeys: new Set([signerId]),
    usedEncKeys: new Set([encId]),
    usedMembershipIds: new Set([keyId(membershipId)]),
    closedJoins: new Set(),
    usedCommitments: new Set([keyId(fields.epochCommitment)]),
    hashes: [copyBytes(recordHash)],
    origin: 'genesis',
    endorser: null,
    snapshotLength: null,
    historyPackets: new Map([
      [
        0,
        {
          commitment: copyBytes(fields.epochCommitment),
          packet: new Uint8Array(0),
        },
      ],
    ]),
  };
}

export function applyOperation(
  state: InternalState,
  signer: SigningPublicKey,
  operation: Operation
): void {
  switch (operation.type) {
    case 'admitMember': {
      const { member: actor } = requirePersonalManage(state, signer);
      if (actor.role !== 'owner' && actor.role !== 'admin') fail('unauthorized');
      const membershipHex = keyId(operation.membershipId);
      const userHex = keyId(operation.request.userId);
      const join = joinKey(operation.request.signingPublicKey, operation.request.requestId);
      if (state.usedMembershipIds.has(membershipHex)) fail('replay');
      if (state.userIndex.has(userHex)) fail('replay');
      if (state.closedJoins.has(join)) fail('replay');
      const signHex = claimSigning(state, operation.request.signingPublicKey);
      const encHex = claimEnc(state, operation.request.encryptionPublicKey);
      state.usedMembershipIds.add(membershipHex);
      state.closedJoins.add(join);
      state.usedSigningKeys.add(signHex);
      state.usedEncKeys.add(encHex);
      const membershipId = copyBytes(operation.membershipId);
      state.members.set(membershipHex, {
        userId: copyBytes(operation.request.userId),
        role: 'member',
      });
      state.userIndex.set(userHex, membershipHex);
      state.devices.set(signHex, {
        membershipId,
        kind: 'personal',
        encryptionPublicKey: copyBytes(operation.request.encryptionPublicKey),
        canManage: false,
      });
      return;
    }
    case 'removeMember': {
      requireOwnerManage(state, signer);
      const membershipHex = keyId(operation.membershipId);
      if (membershipHex === keyId(state.owner)) fail('unauthorized');
      const member = state.members.get(membershipHex);
      if (!member) fail('unauthorized');
      for (const [id, device] of [...state.devices]) {
        if (keyId(device.membershipId) === membershipHex) state.devices.delete(id);
      }
      state.userIndex.delete(keyId(member.userId));
      state.members.delete(membershipHex);
      markRotation(state);
      return;
    }
    case 'setRole': {
      requireOwnerManage(state, signer);
      const membershipHex = keyId(operation.membershipId);
      if (membershipHex === keyId(state.owner)) fail('unauthorized');
      const member = state.members.get(membershipHex);
      if (!member) fail('unauthorized');
      if (member.role === operation.role) fail('invalid-operation');
      state.members.set(membershipHex, { userId: member.userId, role: operation.role });
      return;
    }
    case 'admitDevice': {
      const { device: actor, member } = requireOwnPersonalOrRecovery(state, signer);
      if (actor.kind === 'recovery' && operation.kind !== 'personal') fail('unauthorized');
      if (member.role === 'guest' && operation.kind === 'machine') fail('unauthorized');
      if (operation.kind === 'machine' || operation.kind === 'recovery') {
        if (operation.canManage) fail('unauthorized');
      }
      if (operation.canManage) {
        if (operation.kind !== 'personal') fail('unauthorized');
        if (member.role !== 'owner' && member.role !== 'admin') fail('unauthorized');
      }
      const signHex = claimSigning(state, operation.signingPublicKey);
      const encHex = claimEnc(state, operation.encryptionPublicKey);
      state.usedSigningKeys.add(signHex);
      state.usedEncKeys.add(encHex);
      state.devices.set(signHex, {
        membershipId: copyBytes(actor.membershipId),
        kind: operation.kind,
        encryptionPublicKey: copyBytes(operation.encryptionPublicKey),
        canManage: operation.canManage,
      });
      return;
    }
    case 'revokeDevice': {
      const { device: actor } = requireOwnPersonal(state, signer);
      const targetHex = keyId(operation.target);
      const target = state.devices.get(targetHex);
      if (!target) fail('unauthorized');
      if (keyId(target.membershipId) !== keyId(actor.membershipId)) fail('unauthorized');
      state.devices.delete(targetHex);
      markRotation(state);
      return;
    }
    case 'transferOwner': {
      requireOwnerManage(state, signer);
      const successorHex = keyId(operation.successorMembershipId);
      if (successorHex === keyId(state.owner)) fail('unauthorized');
      const successor = state.members.get(successorHex);
      if (!successor) fail('unauthorized');
      const previousHex = keyId(state.owner);
      const previous = state.members.get(previousHex);
      if (!previous) fail('unauthorized');
      state.members.set(previousHex, { userId: previous.userId, role: 'admin' });
      state.members.set(successorHex, { userId: successor.userId, role: 'owner' });
      state.owner = copyBytes(operation.successorMembershipId);
      return;
    }
    case 'publishEpoch': {
      requirePersonalManage(state, signer);
      if (operation.epoch !== state.epoch.number + 1) fail('invalid-operation');
      const commitmentHex = keyId(operation.commitment);
      if (state.usedCommitments.has(commitmentHex)) fail('replay');
      state.usedCommitments.add(commitmentHex);
      state.epoch = {
        number: operation.epoch,
        keyCommitment: copyBytes(operation.commitment),
        rotationRequired: false,
      };
      state.historyPackets.set(operation.epoch, {
        commitment: copyBytes(operation.commitment),
        packet: copyBytes(operation.previousEpochKey),
      });
      return;
    }
  }
}
