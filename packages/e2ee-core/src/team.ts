import type { ControlPolicy, SignatureProof, TrustAnchor } from './chain';
import { inspectJoinRequest, joinRequestKey } from './join-request';
import { invariant, toHex, type ControlEvent, type Signer } from './wire';
import {
  decodeTeamAction,
  encodeTeamGenesis,
  normalizeTeamGenesis,
  type TeamDeviceInput,
  type TeamGenesis,
  type TeamMemberInput,
} from './team-codec';

export type TeamDevice = TeamDeviceInput;
export interface TeamMember {
  readonly instance: string;
  role: 'owner' | 'admin' | 'member';
  readonly recoverySigningKey: string;
  readonly recoveryEncryptionKey: string;
  readonly devices: Map<string, TeamDevice>;
  /** Tombstones are scoped to this membership instance, never revived by device admission. */
  readonly usedDeviceIds: Set<string>;
  readonly usedDeviceKeys: Set<string>;
}
export interface TeamState {
  readonly members: Map<string, TeamMember>;
  readonly usedInstances: Set<string>;
  /** Detached requests are single-use across cancellation, admission, removal and readmission. */
  readonly closedJoinRequests: Map<string, 'admitted' | 'cancelled'>;
  owner: {
    userId: string;
    instance: string;
    configVersion: number;
  };
  /** Owner/Admin publication clears this obligation; not delivery, activation, or a write gate. */
  requiresKeyRotation: boolean;
  /** Consecutive authorized commitments; no key material or transport locations. */
  readonly epochs: Map<number, string>;
}

function deviceKeys(device: TeamDeviceInput): string[] {
  return [device.signingKey, device.encryptionKey];
}
function memberKeys(member: TeamMemberInput): string[] {
  return [member.recoverySigningKey, member.recoveryEncryptionKey, ...deviceKeys(member.device)];
}
function activeKeys(state: TeamState): Set<string> {
  const keys = new Set<string>();
  for (const member of state.members.values()) {
    keys.add(member.recoverySigningKey);
    keys.add(member.recoveryEncryptionKey);
    for (const device of member.devices.values())
      for (const key of deviceKeys(device)) keys.add(key);
  }
  return keys;
}

function claimKeys(
  state: TeamState,
  keys: string[],
  forbidden: Set<string> = activeKeys(state)
): void {
  invariant(
    new Set(keys).size === keys.length && keys.every((key) => !forbidden.has(key)),
    'team-key-reused'
  );
}

function newMember(input: TeamMemberInput, role: TeamMember['role']): TeamMember {
  invariant(input.device.kind === 'personal', 'initial-device-must-be-personal');
  return {
    instance: input.instance,
    role,
    recoverySigningKey: input.recoverySigningKey,
    recoveryEncryptionKey: input.recoveryEncryptionKey,
    devices: new Map([[input.device.id, { ...input.device }]]),
    usedDeviceIds: new Set([input.device.id]),
    usedDeviceKeys: new Set(deviceKeys(input.device)),
  };
}

/** Derive only from a genesis whose identity has been independently accepted. Hashing is NOT authentication. */
export async function deriveTeamAnchor(
  input: TeamGenesis,
  subtle: SubtleCrypto = globalThis.crypto.subtle
): Promise<TrustAnchor<TeamState>> {
  const genesis = normalizeTeamGenesis(input);
  const keys = memberKeys(genesis.owner);
  invariant(genesis.owner.device.canManage, 'device-management-required');
  invariant(new Set(keys).size === keys.length, 'team-key-reused');
  const state: TeamState = {
    members: new Map([[genesis.owner.userId, newMember(genesis.owner, 'owner')]]),
    usedInstances: new Set([genesis.owner.instance]),
    closedJoinRequests: new Map(),
    requiresKeyRotation: false,
    epochs: new Map(),
    owner: {
      userId: genesis.owner.userId,
      instance: genesis.owner.instance,
      configVersion: 0,
    },
  };
  const hash = await subtle.digest('SHA-256', new TextEncoder().encode(encodeTeamGenesis(genesis)));
  return { genesis: toHex(new Uint8Array(hash)), state };
}

function getMember(state: TeamState, userId: string, instance: string): TeamMember {
  const member = state.members.get(userId);
  invariant(member !== undefined && member.instance === instance, 'inactive-member-instance');
  return member;
}

function personalDevice(member: TeamMember, deviceId: string): TeamDevice {
  const device = member.devices.get(deviceId);
  invariant(device !== undefined && device.kind === 'personal', 'inactive-personal-device');
  invariant(device.canManage, 'device-management-required');
  return device;
}

/** Explicit conservative profile: only Owner finalizes member removal. Not a product-default policy. */
export const ownerManagedTeamPolicy: ControlPolicy<TeamState> = {
  transition(previous, event: ControlEvent) {
    const action = decodeTeamAction(event);
    invariant(action.configVersion === previous.owner.configVersion, 'stale-owner-config');
    if (action.type === 'member.cancel') {
      const { request, proofs } = inspectJoinRequest(action.request);
      invariant(request.genesis === event.genesis, 'wrong-join-org');
      invariant(
        event.actor === request.member.userId &&
          event.memberInstance === request.member.instance &&
          event.device === request.member.device.id,
        'wrong-join-applicant'
      );
      const key = joinRequestKey(request);
      invariant(
        !previous.closedJoinRequests.has(key) &&
          !previous.usedInstances.has(request.member.instance),
        'join-request-closed'
      );
      const state = structuredClone(previous);
      state.closedJoinRequests.set(key, 'cancelled');
      return {
        state,
        signers: [{ id: 'actor-device', publicKey: request.member.device.signingKey }],
        proofs,
      };
    }
    const actor = getMember(previous, event.actor, event.memberInstance);
    const device = personalDevice(actor, event.device);
    const state = structuredClone(previous);
    const self = getMember(state, event.actor, event.memberInstance);
    const signers: Signer[] = [{ id: 'actor-device', publicKey: device.signingKey }];
    let proofs: readonly SignatureProof[] = [];
    const owner = () => {
      invariant(
        actor.role === 'owner' &&
          event.actor === previous.owner.userId &&
          actor.instance === previous.owner.instance,
        'owner-required'
      );
    };
    switch (action.type) {
      case 'epoch.publish': {
        invariant(actor.role === 'owner' || actor.role === 'admin', 'rotator-required');
        if (actor.role === 'owner') owner();
        invariant(action.epoch === state.epochs.size, 'nonconsecutive-epoch');
        invariant(![...state.epochs.values()].includes(action.commitment), 'epoch-key-reused');
        state.epochs.set(action.epoch, action.commitment);
        state.requiresKeyRotation = false;
        break;
      }
      case 'member.add':
      case 'member.admit': {
        invariant(actor.role === 'owner' || actor.role === 'admin', 'inviter-required');
        if (actor.role === 'owner') owner();
        let target: TeamMemberInput;
        if (action.type === 'member.admit') {
          const parsed = inspectJoinRequest(action.request);
          const request = parsed.request;
          invariant(request.genesis === event.genesis, 'wrong-join-org');
          invariant(
            request.approver.userId === event.actor &&
              request.approver.instance === event.memberInstance,
            'wrong-join-approver'
          );
          const key = joinRequestKey(request);
          invariant(!state.closedJoinRequests.has(key), 'join-request-closed');
          state.closedJoinRequests.set(key, 'admitted');
          target = request.member;
          proofs = parsed.proofs;
        } else target = action.member;
        invariant(
          !state.members.has(target.userId) && !state.usedInstances.has(target.instance),
          'member-already-admitted'
        );
        claimKeys(state, memberKeys(target));
        state.members.set(target.userId, newMember(target, 'member'));
        state.usedInstances.add(target.instance);
        if (action.type === 'member.add')
          signers.push(
            { id: 'joining-identity', publicKey: target.recoverySigningKey },
            { id: 'new-device', publicKey: target.device.signingKey }
          );
        break;
      }
      case 'member.remove': {
        owner();
        const target = getMember(state, action.userId, action.instance);
        invariant(target.role !== 'owner', 'cannot-remove-owner');
        state.members.delete(action.userId);
        state.requiresKeyRotation = true;
        break;
      }
      case 'member.role': {
        owner();
        const target = getMember(state, action.userId, action.instance);
        invariant(target.role !== 'owner', 'owner-transfer-required');
        invariant(target.role !== action.role, 'role-unchanged');
        target.role = action.role;
        break;
      }
      case 'device.add': {
        const target = action.device;
        invariant(!self.usedDeviceIds.has(target.id), 'device-id-reused');
        invariant(
          deviceKeys(target).every((key) => !self.usedDeviceKeys.has(key)),
          'device-key-reused'
        );
        claimKeys(state, deviceKeys(target));
        self.devices.set(target.id, { ...target });
        self.usedDeviceIds.add(target.id);
        for (const key of deviceKeys(target)) self.usedDeviceKeys.add(key);
        signers.push({ id: 'new-device', publicKey: target.signingKey });
        break;
      }
      case 'device.revoke': {
        invariant(self.devices.has(action.deviceId), 'inactive-device');
        // Admission history is audit evidence, not an ongoing dependency on the approving device.
        self.devices.delete(action.deviceId);
        state.requiresKeyRotation = true;
        break;
      }
      case 'owner.transfer': {
        owner();
        const target = getMember(state, action.userId, action.instance);
        invariant(target.role !== 'owner', 'owner-unchanged');
        const acceptingDevice = personalDevice(target, action.acceptingDevice);
        invariant(previous.owner.configVersion < Number.MAX_SAFE_INTEGER, 'owner-config-exhausted');
        signers.push({ id: 'accepting-device', publicKey: acceptingDevice.signingKey });
        self.role = 'admin';
        target.role = 'owner';
        state.owner = {
          userId: action.userId,
          instance: action.instance,
          configVersion: previous.owner.configVersion + 1,
        };
        break;
      }
    }
    return { state, signers, proofs };
  },
};

export interface TeamRecipient {
  readonly userId: string;
  readonly instance: string;
  readonly kind: 'device' | 'recovery';
  readonly id: string;
  readonly encryptionKey: string;
}

/** Eligible targets only, NOT a release instruction or a freshness/epoch-cutoff proof. */
export function listTeamRecipients(state: TeamState): TeamRecipient[] {
  const recipients: TeamRecipient[] = [];
  for (const [userId, member] of state.members) {
    recipients.push({
      userId,
      instance: member.instance,
      kind: 'recovery',
      id: userId,
      encryptionKey: member.recoveryEncryptionKey,
    });
    for (const device of member.devices.values())
      recipients.push({
        userId,
        instance: member.instance,
        kind: 'device',
        id: device.id,
        encryptionKey: device.encryptionKey,
      });
  }
  return recipients.sort((a, b) => {
    const left = JSON.stringify([a.userId, a.instance, a.kind, a.id]);
    const right = JSON.stringify([b.userId, b.instance, b.kind, b.id]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
