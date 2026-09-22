import type { OrgState } from './ledger-state';
import { keyId } from './identifiers';

/** Only active personal/machine devices of non-guest members may write content. */
export function deviceMayWriteDocument(state: OrgState, deviceIdHex: string): boolean {
  const device = state.devices.get(deviceIdHex);
  if (!device || (device.kind !== 'personal' && device.kind !== 'machine')) return false;
  const member = state.members.get(keyId(device.membershipId));
  return member !== undefined && member.role !== 'guest';
}
