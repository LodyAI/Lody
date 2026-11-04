/**
 * Independent lab reference model. Deliberately does not import
 * `deviceMayWriteDocument`, `canSendEpoch`, or ledger policy from e2ee-core.
 * Expected transitions are described here; the implementation under test is
 * compared against these rules, not against its own decision function.
 */

import type { LedgerState } from '@lody/e2ee-core';
const toHex = (value: { toBytes(): Uint8Array }) => Buffer.from(value.toBytes()).toString('hex');

export type RefKind = 'personal' | 'machine' | 'recovery';
export type RefRole = 'owner' | 'admin' | 'member' | 'guest';

export interface RefDevice {
  readonly id: string;
  readonly user: string;
  readonly kind: RefKind;
  readonly role: RefRole;
}

export interface RefState {
  readonly org: string;
  readonly epoch: number;
  readonly ownerUser: string;
  /** Missing observation is unmeasured, never permission to seal new content. */
  readonly rotationRequired?: boolean;
  readonly devices: ReadonlyMap<string, RefDevice>;
  readonly revoked: ReadonlySet<string>;
}

/** Map supplied factual metadata, never authority or independent policy evidence.
 * The actor must authenticate its source separately. This adapter calls no policy. */
export function refStateFromOrg(org: string, state: LedgerState): RefState {
  const devices = new Map<string, RefDevice>();
  const owner = state.members.get(toHex(state.owner));
  if (!owner || owner.role !== 'owner') throw new Error('reference-missing-owner');
  const ownerUser = toHex(owner.userId);
  for (const [id, device] of state.devices) {
    const member = state.members.get(toHex(device.membershipId));
    if (!member) throw new Error('reference-missing-member');
    const role = member.role;
    devices.set(id, {
      id,
      user: toHex(member.userId),
      kind: device.kind,
      role,
    });
  }
  return captureRefState({
    org,
    epoch: state.epoch.number,
    rotationRequired: state.epoch.rotationRequired,
    ownerUser,
    devices,
    revoked: new Set(),
  });
}

function deviceOf(state: RefState, deviceId: string): RefDevice | undefined {
  if (state.revoked.has(deviceId)) return undefined;
  return state.devices.get(deviceId);
}

function deviceFactsKnown(device: RefDevice, deviceId: string): boolean {
  return (
    device.id === deviceId &&
    deviceId.length > 0 &&
    typeof device.user === 'string' &&
    device.user.length > 0 &&
    ['personal', 'machine', 'recovery'].includes(device.kind) &&
    ['owner', 'admin', 'member', 'guest'].includes(device.role)
  );
}

function isPersonalManager(state: RefState, deviceId: string): boolean {
  const device = deviceOf(state, deviceId);
  if (!device || !deviceFactsKnown(device, deviceId) || device.kind !== 'personal') return false;
  return device.role === 'owner' || device.role === 'admin';
}

/** Org, resource, and epoch must match the bound context. */
export function refContextMatches(input: {
  org: string;
  resource?: string;
  epoch?: number;
  boundOrg: string;
  boundResource?: string;
  boundEpoch?: number;
}): boolean {
  if (input.org !== input.boundOrg) return false;
  if (input.boundResource !== undefined && input.resource !== input.boundResource) return false;
  if (input.boundEpoch !== undefined && input.epoch !== input.boundEpoch) return false;
  return true;
}

export function refMayAdmit(state: RefState, actorId: string, org: string): boolean {
  if (org !== state.org) return false;
  return isPersonalManager(state, actorId);
}

export type RefExpectation = 'allow' | 'deny' | 'unmeasured';
/** New-seal prediction only. Legal admitted historical reads use a separate
 * oracle; current revocation/rotation is not retroactive author rejection. */
export function refWriteExpectation(
  state: RefState,
  deviceId: string,
  org: string,
  epoch: number
): RefExpectation {
  if (org !== state.org) return 'deny';
  const { epoch: currentEpoch, rotationRequired } = state;
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    !Number.isSafeInteger(currentEpoch) ||
    currentEpoch < 0
  )
    return 'unmeasured';
  if (epoch !== currentEpoch) return 'deny';
  const device = deviceOf(state, deviceId);
  if (!device) return 'deny';
  if (!deviceFactsKnown(device, deviceId)) return 'unmeasured';
  if (device.kind === 'recovery' || device.role === 'guest') return 'deny';
  if (rotationRequired === true) return 'deny';
  if (rotationRequired !== false) return 'unmeasured';
  return 'allow';
}
export function refSendExpectation(state: RefState, deviceId: string, org: string): RefExpectation {
  if (org !== state.org) return 'deny';
  const device = deviceOf(state, deviceId);
  if (!device) return 'deny';
  if (!deviceFactsKnown(device, deviceId)) return 'unmeasured';
  return device.kind === 'recovery' ? 'deny' : 'allow';
}

export function refMayRecover(
  state: RefState,
  recoveryDeviceId: string,
  user: string,
  org: string
): boolean {
  if (org !== state.org) return false;
  const device = deviceOf(state, recoveryDeviceId);
  if (!device || !deviceFactsKnown(device, recoveryDeviceId) || device.kind !== 'recovery')
    return false;
  return device.user === user && !state.revoked.has(recoveryDeviceId);
}

/** Local context/current personal-manager eligibility ONLY. Neither this
 * boolean nor refStateFromOrg verifies a snapshot/signature/head/endorsement.
 * Full admission belongs to public core with independently established trust. */
export function refSnapshotAdmissible(input: {
  snapshotOrg: string;
  snapshotResource: string;
  localOrg: string;
  localResource: string;
  endorserId: string;
  state: RefState;
}): boolean {
  if (input.snapshotOrg !== input.localOrg) return false;
  if (input.snapshotResource !== input.localResource) return false;
  if (input.snapshotOrg !== input.state.org) return false;
  return isPersonalManager(input.state, input.endorserId);
}

export function refCursorAllowed(input: {
  hasDocument: boolean;
  docCoversCursor: boolean;
}): 'ok' | 'ahead' | 'lost' | 'unmeasured' {
  if (typeof input.hasDocument !== 'boolean') return 'unmeasured';
  if (!input.hasDocument) return 'lost';
  if (typeof input.docCoversCursor !== 'boolean') return 'unmeasured';
  if (!input.docCoversCursor) return 'ahead';
  return 'ok';
}

export function refRetryExpectation(input: {
  originalHex: string;
  retryHex: string;
}): RefExpectation {
  const { originalHex, retryHex } = input;
  if (
    typeof originalHex !== 'string' ||
    typeof retryHex !== 'string' ||
    !/^(?:[0-9a-f]{2})+$/.test(originalHex) ||
    !/^(?:[0-9a-f]{2})+$/.test(retryHex)
  )
    return 'unmeasured';
  return originalHex === retryHex ? 'allow' : 'deny';
}

export function refRevokeIsLocal(input: {
  org: string;
  boundOrg: string;
  deviceId: string;
  otherDeviceId: string;
}): { targetRevoked: boolean; otherUntouched: boolean } {
  const local = input.org === input.boundOrg;
  return {
    targetRevoked: local && input.deviceId.length > 0,
    otherUntouched: !local || input.deviceId.length === 0 || input.deviceId !== input.otherDeviceId,
  };
}

/** Own inert factual observations before asynchronous measured actors run.
 * This is not authority registration. No production decision function is called. */
export function captureRefState(input: RefState): RefState {
  const { org, epoch, ownerUser, rotationRequired, devices, revoked } = input;
  const ownedDevices = new Map<string, RefDevice>();
  for (const [key, row] of devices) {
    const { id, user, kind, role } = row;
    ownedDevices.set(key, Object.freeze({ id, user, kind, role }));
  }
  const ownedRevoked = new Set(revoked);
  const deviceView: ReadonlyMap<string, RefDevice> = Object.freeze({
    get size() {
      return ownedDevices.size;
    },
    has: (key: string) => ownedDevices.has(key),
    get: (key: string) => ownedDevices.get(key),
    keys: () => ownedDevices.keys(),
    values: () => ownedDevices.values(),
    entries: () => ownedDevices.entries(),
    [Symbol.iterator]: () => ownedDevices.entries(),
    forEach: (
      callback: (value: RefDevice, key: string, map: ReadonlyMap<string, RefDevice>) => void,
      thisArg?: unknown
    ) => {
      for (const [key, value] of ownedDevices) callback.call(thisArg, value, key, deviceView);
    },
  });
  const revokedView: ReadonlySet<string> = Object.freeze({
    get size() {
      return ownedRevoked.size;
    },
    has: (key: string) => ownedRevoked.has(key),
    keys: () => ownedRevoked.keys(),
    values: () => ownedRevoked.values(),
    entries: () => ownedRevoked.entries(),
    [Symbol.iterator]: () => ownedRevoked.values(),
    forEach: (
      callback: (value: string, value2: string, set: ReadonlySet<string>) => void,
      thisArg?: unknown
    ) => {
      for (const value of ownedRevoked) callback.call(thisArg, value, value, revokedView);
    },
  });
  return Object.freeze({
    org,
    epoch,
    ownerUser,
    rotationRequired,
    devices: deviceView,
    revoked: revokedView,
  });
}
