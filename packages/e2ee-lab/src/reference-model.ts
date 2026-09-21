/**
 * Independent lab reference model. Deliberately does not import
 * `deviceMayWriteDocument`, `canSendEpoch`, or ledger policy from e2ee-core.
 * Expected transitions are described here; the implementation under test is
 * compared against these rules, not against its own decision function.
 */

export type RefKind = 'personal' | 'machine' | 'recovery';
export type RefRole = 'owner' | 'admin' | 'member' | 'guest';

export interface RefDevice {
  readonly id: string;
  readonly user: string;
  readonly kind: RefKind;
  readonly role: RefRole;
  readonly canManage: boolean;
}

export interface RefState {
  readonly org: string;
  readonly epoch: number;
  readonly ownerUser: string;
  readonly devices: ReadonlyMap<string, RefDevice>;
  readonly revoked: ReadonlySet<string>;
}

function deviceOf(state: RefState, deviceId: string): RefDevice | undefined {
  if (state.revoked.has(deviceId)) return undefined;
  return state.devices.get(deviceId);
}

function isPersonalManager(state: RefState, deviceId: string): boolean {
  const device = deviceOf(state, deviceId);
  if (!device || device.kind !== 'personal' || !device.canManage) return false;
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

export function refMayWriteDocument(
  state: RefState,
  deviceId: string,
  org: string,
  epoch: number
): boolean {
  if (org !== state.org) return false;
  if (epoch !== state.epoch) return false;
  const device = deviceOf(state, deviceId);
  if (!device) return false;
  if (device.kind === 'recovery') return false;
  if (device.role === 'guest') return false;
  return device.kind === 'personal' || device.kind === 'machine';
}

export function refMaySendEpoch(state: RefState, deviceId: string, org: string): boolean {
  if (org !== state.org) return false;
  return isPersonalManager(state, deviceId);
}

export function refMayRecover(
  state: RefState,
  recoveryDeviceId: string,
  user: string,
  org: string
): boolean {
  if (org !== state.org) return false;
  const device = deviceOf(state, recoveryDeviceId);
  if (!device || device.kind !== 'recovery') return false;
  return device.user === user && !state.revoked.has(recoveryDeviceId);
}

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
}): 'ok' | 'ahead' | 'lost' {
  if (!input.hasDocument) return 'lost';
  if (!input.docCoversCursor) return 'ahead';
  return 'ok';
}

/** Lost-ACK retry must resubmit the exact pending bytes. */
export function refRetryPreservesCommit(input: { originalHex: string; retryHex: string }): boolean {
  return input.originalHex === input.retryHex;
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
    otherUntouched: input.deviceId !== input.otherDeviceId,
  };
}
