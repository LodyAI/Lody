import { Result } from 'effect';
import type { OrgState } from './ledger-state';
import type { ContentHeader } from './content-frame';
import { ContentError } from './errors';
import { keyId } from './identifiers';

/** Only active personal/machine devices of non-guest members may write content. */
export function deviceMayWriteDocument(state: OrgState, deviceIdHex: string): boolean {
  const device = state.devices.get(deviceIdHex);
  if (!device || (device.kind !== 'personal' && device.kind !== 'machine')) return false;
  const member = state.members.get(keyId(device.membershipId));
  return member !== undefined && member.role !== 'guest';
}

/**
 * Honest-writer seal gate: document-write rights AND no pending rotation. After a
 * member removal or device revoke the current key is still held by the removed party,
 * so new content must wait for `publishEpoch`. Hosts keep using `deviceMayWriteDocument`
 * for admission; ciphertext sealed before the removal may still be uploaded.
 */
export function maySealNewContent(state: OrgState, deviceIdHex: string): boolean {
  return !state.epoch.rotationRequired && deviceMayWriteDocument(state, deviceIdHex);
}

/** Signing keys are globally single-use within this Org's verified history.
 * Revoked devices authenticate history only; this never grants new write rights. */
export function contentAuthorKey(
  state: OrgState,
  header: Pick<ContentHeader, 'genesis' | 'device'>,
  wasAdmitted: (deviceIdHex: string) => boolean = () => false
): Result.Result<string, ContentError> {
  if (header.genesis !== keyId(state.genesis))
    return Result.fail(new ContentError({ code: 'unauthorized' }));
  const device = state.devices.get(header.device);
  return (device && state.members.has(keyId(device.membershipId))) || wasAdmitted(header.device)
    ? Result.succeed(header.device)
    : Result.fail(new ContentError({ code: 'unauthorized' }));
}

export type ContentIdentity =
  | {
      readonly kind: 'member';
      readonly device: string;
      readonly actor: string;
      readonly memberInstance: string;
    }
  | {
      readonly kind: 'device-only';
      readonly device: string;
      readonly reason: 'missing-history-context';
    };

/** Only call with privately retained verified replay state. */
export function historicalContentIdentity(
  state: import('./ledger-state').InternalState,
  device: string
): ContentIdentity | undefined {
  const author = state.contentAuthors.get(device);
  if (author) return Object.freeze({ kind: 'member', ...author });
  return state.usedSigningKeys.has(device)
    ? Object.freeze({ kind: 'device-only', device, reason: 'missing-history-context' })
    : undefined;
}
