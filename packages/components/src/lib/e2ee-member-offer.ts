import type { E2eeMemberOffer } from '@lody/cloud-api';
const hash = /^[0-9a-f]{64}$/;
export function parseMemberOffer(input: string, token?: string): E2eeMemberOffer | null {
  if (input.length > 20480) return null;
  try {
    const value = JSON.parse(input) as E2eeMemberOffer;
    if (
      value.version !== 1 ||
      typeof value.workspaceId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.workspaceId) ||
      !hash.test(value.genesisHash) ||
      !hash.test(value.endorser) ||
      !hash.test(value.token) ||
      (token !== undefined && value.token !== token) ||
      typeof value.genesisRecordHex !== 'string' ||
      value.genesisRecordHex.length > 16384 ||
      !/^(?:[0-9a-f]{2})+$/.test(value.genesisRecordHex) ||
      !['email', 'link'].includes(value.mode) ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= 0
    )
      return null;
    return publicMemberOffer(value);
  } catch {
    return null;
  }
}
export function readMemberOffer(token: string): E2eeMemberOffer | null {
  if (typeof window === 'undefined') return null;
  // The desktop hash router can place the invitation fragment after its route hash.
  const marker = window.location.hash.lastIndexOf('e2ee=');
  const fragment = marker < 0 ? '' : window.location.hash.slice(marker);
  const value = new URLSearchParams(fragment).get('e2ee');
  return value ? parseMemberOffer(value, token) : null;
}
/** Public invitation pins only. Endorsements stay on relay requests for approvers;
 * older desktop builds parse invitation deep links strictly. */
export const publicMemberOffer = (offer: E2eeMemberOffer): Omit<E2eeMemberOffer, 'signature'> => ({
  version: offer.version,
  workspaceId: offer.workspaceId,
  genesisHash: offer.genesisHash,
  genesisRecordHex: offer.genesisRecordHex,
  endorser: offer.endorser,
  token: offer.token,
  mode: offer.mode,
  expiresAt: offer.expiresAt,
});
export const memberJoinPath = (offer: E2eeMemberOffer) =>
  `/join/${offer.token}#e2ee=${encodeURIComponent(JSON.stringify(publicMemberOffer(offer)))}`;
export const sameMemberOffer = (a: E2eeMemberOffer, b: E2eeMemberOffer) =>
  a.version === b.version &&
  a.workspaceId === b.workspaceId &&
  a.genesisHash === b.genesisHash &&
  a.genesisRecordHex === b.genesisRecordHex &&
  a.endorser === b.endorser &&
  a.token === b.token &&
  a.mode === b.mode &&
  a.expiresAt === b.expiresAt;
export const desktopMemberJoinLink = (offer: E2eeMemberOffer) =>
  `lody://invite/open?${new URLSearchParams({ memberOffer: JSON.stringify(publicMemberOffer(offer)) })}`;
