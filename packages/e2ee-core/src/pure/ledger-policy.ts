import { Either } from 'effect';
import { encryptionPublicKey } from './bytes';
import { SigningFacts } from './signing-facts';
import { copyBytes } from './cbor';
import { keyId, joinKey } from './identifiers';
import { ValidationError, type LedgerErrorCode } from './errors';
import type { InternalState, Member, Device, EpochState, HistoryPacketRow } from './ledger-state';
import type { Operation, GenesisFields } from './ledger-schema';

type Result<A> = Either.Either<A, ValidationError>;
export function genesisState(
  fields: GenesisFields,
  recordHash: Uint8Array,
  facts = SigningFacts.empty
): Result<InternalState> {
  return Either.gen(function* () {
    yield* Either.mapLeft(
      facts.check(fields.signer),
      () => new ValidationError({ code: 'invalid-key' })
    );
    const signerId = keyId(fields.signer);
    yield* Either.mapLeft(
      encryptionPublicKey(fields.encryptionPublicKey),
      () => new ValidationError({ code: 'invalid-key' })
    );
    const encId = keyId(fields.encryptionPublicKey);
    const membershipId = copyBytes(fields.membershipId);
    const userId = copyBytes(fields.userId);
    const member: Member = { userId, role: 'owner' };
    const device: Device = {
      membershipId,
      kind: 'personal',
      encryptionPublicKey: copyBytes(fields.encryptionPublicKey),
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
  });
}
const fail = (code: LedgerErrorCode): Result<never> => Either.left(new ValidationError({ code }));
const unknownOperation = (_operation: never): Result<never> => fail('unknown-operation');

/** Internal delta, not authority or a public patch-state API. No input is mutated. */
export interface PolicyChanges {
  members?: Array<readonly [string, Member | null]>;
  devices?: Array<readonly [string, Device | null]>;
  userIndex?: Array<readonly [string, string | null]>;
  usedSigningKeys?: string[];
  usedEncKeys?: string[];
  usedMembershipIds?: string[];
  closedJoins?: string[];
  usedCommitments?: string[];
  owner?: Uint8Array;
  epoch?: EpochState;
  historyPackets?: Array<readonly [number, HistoryPacketRow]>;
}

function activeDevice(state: InternalState, signer: Uint8Array): Result<Device> {
  const device = state.devices.get(keyId(signer));
  return device ? Either.right(device) : fail('unauthorized');
}
function memberOf(state: InternalState, device: Device): Result<Member> {
  const member = state.members.get(keyId(device.membershipId));
  return member ? Either.right(member) : fail('unauthorized');
}
function requirePersonalManage(state: InternalState, signer: Uint8Array) {
  return Either.gen(function* () {
    const device = yield* activeDevice(state, signer);
    if (device.kind !== 'personal') return yield* fail('unauthorized');
    const member = yield* memberOf(state, device);
    if (member.role !== 'owner' && member.role !== 'admin') return yield* fail('unauthorized');
    return { device, member };
  });
}
function requireOwnerManage(state: InternalState, signer: Uint8Array) {
  return Either.gen(function* () {
    const found = yield* requirePersonalManage(state, signer);
    if (found.member.role !== 'owner') return yield* fail('unauthorized');
    return found;
  });
}
function requireOwnPersonalOrRecovery(state: InternalState, signer: Uint8Array) {
  return Either.gen(function* () {
    const device = yield* activeDevice(state, signer);
    if (device.kind !== 'personal' && device.kind !== 'recovery')
      return yield* fail('unauthorized');
    return { device, member: yield* memberOf(state, device) };
  });
}
function requireOwnPersonal(state: InternalState, signer: Uint8Array) {
  return Either.gen(function* () {
    const device = yield* activeDevice(state, signer);
    if (device.kind !== 'personal') return yield* fail('unauthorized');
    return { device, member: yield* memberOf(state, device) };
  });
}
function claimSigning(state: InternalState, key: Uint8Array, facts: SigningFacts): Result<string> {
  return Either.gen(function* () {
    yield* Either.mapLeft(facts.check(key), () => new ValidationError({ code: 'invalid-key' }));
    const id = keyId(key);
    if (state.usedSigningKeys.has(id) || state.devices.has(id)) return yield* fail('replay');
    return id;
  });
}
function claimEnc(state: InternalState, key: Uint8Array): Result<string> {
  return Either.gen(function* () {
    yield* Either.mapLeft(
      encryptionPublicKey(key),
      () => new ValidationError({ code: 'invalid-key' })
    );
    const id = keyId(key);
    if (state.usedEncKeys.has(id)) return yield* fail('replay');
    return id;
  });
}

/** Policy only: caller must decode and verify all signatures/proofs first. */
export function operationChanges(
  state: InternalState,
  signer: Uint8Array,
  operation: Operation,
  facts = SigningFacts.empty
): Result<PolicyChanges> {
  return Either.gen(function* () {
    const changes: PolicyChanges = {};
    switch (operation.type) {
      case 'admitMember': {
        const { member: actor } = yield* requirePersonalManage(state, signer);
        if (actor.role !== 'owner' && actor.role !== 'admin') return yield* fail('unauthorized');
        const membershipHex = keyId(operation.membershipId);
        const userHex = keyId(operation.request.userId);
        const join = joinKey(operation.request.signingPublicKey, operation.request.requestId);
        if (state.usedMembershipIds.has(membershipHex)) return yield* fail('replay');
        if (state.userIndex.has(userHex)) return yield* fail('replay');
        if (state.closedJoins.has(join)) return yield* fail('replay');
        const signHex = yield* claimSigning(state, operation.request.signingPublicKey, facts);
        const encHex = yield* claimEnc(state, operation.request.encryptionPublicKey);
        (changes.usedMembershipIds ??= []).push(membershipHex);
        (changes.closedJoins ??= []).push(join);
        (changes.usedSigningKeys ??= []).push(signHex);
        (changes.usedEncKeys ??= []).push(encHex);
        const membershipId = copyBytes(operation.membershipId);
        (changes.members ??= []).push([
          membershipHex,
          {
            userId: copyBytes(operation.request.userId),
            role: 'member',
          },
        ]);
        (changes.userIndex ??= []).push([userHex, membershipHex]);
        (changes.devices ??= []).push([
          signHex,
          {
            membershipId,
            kind: 'personal',
            encryptionPublicKey: copyBytes(operation.request.encryptionPublicKey),
          },
        ]);
        return changes;
      }
      case 'removeMember': {
        yield* requireOwnerManage(state, signer);
        const membershipHex = keyId(operation.membershipId);
        if (membershipHex === keyId(state.owner)) return yield* fail('unauthorized');
        const member = state.members.get(membershipHex);
        if (!member) return yield* fail('unauthorized');
        for (const [id, device] of [...state.devices]) {
          if (keyId(device.membershipId) === membershipHex)
            (changes.devices ??= []).push([id, null]);
        }
        (changes.userIndex ??= []).push([keyId(member.userId), null]);
        (changes.members ??= []).push([membershipHex, null]);
        changes.epoch = {
          ...state.epoch,
          keyCommitment: copyBytes(state.epoch.keyCommitment),
          rotationRequired: true,
        };
        return changes;
      }
      case 'setRole': {
        yield* requireOwnerManage(state, signer);
        const membershipHex = keyId(operation.membershipId);
        if (membershipHex === keyId(state.owner)) return yield* fail('unauthorized');
        const member = state.members.get(membershipHex);
        if (!member) return yield* fail('unauthorized');
        if (member.role === operation.role) return yield* fail('invalid-operation');
        (changes.members ??= []).push([
          membershipHex,
          { userId: copyBytes(member.userId), role: operation.role },
        ]);
        return changes;
      }
      case 'admitDevice': {
        const { device: actor, member } = yield* requireOwnPersonalOrRecovery(state, signer);
        if (actor.kind === 'recovery' && operation.kind !== 'personal')
          return yield* fail('unauthorized');
        if (member.role === 'guest' && operation.kind === 'machine')
          return yield* fail('unauthorized');
        const signHex = yield* claimSigning(state, operation.signingPublicKey, facts);
        const encHex = yield* claimEnc(state, operation.encryptionPublicKey);
        (changes.usedSigningKeys ??= []).push(signHex);
        (changes.usedEncKeys ??= []).push(encHex);
        (changes.devices ??= []).push([
          signHex,
          {
            membershipId: copyBytes(actor.membershipId),
            kind: operation.kind,
            encryptionPublicKey: copyBytes(operation.encryptionPublicKey),
          },
        ]);
        return changes;
      }
      case 'revokeDevice': {
        const { device: actor } = yield* requireOwnPersonal(state, signer);
        const targetHex = keyId(operation.target);
        const target = state.devices.get(targetHex);
        if (!target) return yield* fail('unauthorized');
        if (keyId(target.membershipId) !== keyId(actor.membershipId))
          return yield* fail('unauthorized');
        (changes.devices ??= []).push([targetHex, null]);
        changes.epoch = {
          ...state.epoch,
          keyCommitment: copyBytes(state.epoch.keyCommitment),
          rotationRequired: true,
        };
        return changes;
      }
      case 'transferOwner': {
        yield* requireOwnerManage(state, signer);
        const successorHex = keyId(operation.successorMembershipId);
        if (successorHex === keyId(state.owner)) return yield* fail('unauthorized');
        const successor = state.members.get(successorHex);
        if (!successor) return yield* fail('unauthorized');
        const previousHex = keyId(state.owner);
        const previous = state.members.get(previousHex);
        if (!previous) return yield* fail('unauthorized');
        (changes.members ??= []).push([
          previousHex,
          { userId: copyBytes(previous.userId), role: 'admin' },
        ]);
        (changes.members ??= []).push([
          successorHex,
          { userId: copyBytes(successor.userId), role: 'owner' },
        ]);
        changes.owner = copyBytes(operation.successorMembershipId);
        return changes;
      }
      case 'publishEpoch': {
        yield* requirePersonalManage(state, signer);
        if (operation.epoch !== state.epoch.number + 1) return yield* fail('invalid-operation');
        const commitmentHex = keyId(operation.commitment);
        if (state.usedCommitments.has(commitmentHex)) return yield* fail('replay');
        (changes.usedCommitments ??= []).push(commitmentHex);
        changes.epoch = {
          number: operation.epoch,
          keyCommitment: copyBytes(operation.commitment),
          rotationRequired: false,
        };
        (changes.historyPackets ??= []).push([
          operation.epoch,
          {
            commitment: copyBytes(operation.commitment),
            packet: copyBytes(operation.previousEpochKey),
          },
        ]);
        return changes;
      }
      default:
        return yield* unknownOperation(operation);
    }
  });
}

/** Mutates the privately owned replay accumulator after a complete successful delta. */
export function applyPolicyChanges(state: InternalState, changes: PolicyChanges): void {
  for (const [key, value] of changes.members ?? []) {
    if (value === null) state.members.delete(key);
    else state.members.set(key, value);
  }
  for (const [key, value] of changes.devices ?? []) {
    if (value === null) state.devices.delete(key);
    else state.devices.set(key, value);
  }
  for (const [key, value] of changes.userIndex ?? []) {
    if (value === null) state.userIndex.delete(key);
    else state.userIndex.set(key, value);
  }
  for (const key of changes.usedSigningKeys ?? []) state.usedSigningKeys.add(key);
  for (const key of changes.usedEncKeys ?? []) state.usedEncKeys.add(key);
  for (const key of changes.usedMembershipIds ?? []) state.usedMembershipIds.add(key);
  for (const key of changes.closedJoins ?? []) state.closedJoins.add(key);
  for (const key of changes.usedCommitments ?? []) state.usedCommitments.add(key);
  for (const [epoch, row] of changes.historyPackets ?? []) state.historyPackets.set(epoch, row);
  if (changes.owner !== undefined) state.owner = changes.owner;
  if (changes.epoch !== undefined) state.epoch = changes.epoch;
}
