import type { E2eeMemberOffer } from '@lody/cloud-api';
const hash = /^[0-9a-f]{64}$/;
export function parseMemberOffer(input: string, token?: string): E2eeMemberOffer | null {
  if (input.length > 8192) return null;
  try {
    const value = JSON.parse(input) as E2eeMemberOffer;
    if (
      value.version !== 1 ||
      typeof value.workspaceId !== 'string' ||
      !value.workspaceId ||
      value.workspaceId.length > 256 ||
      !hash.test(value.genesisHash) ||
      !hash.test(value.endorser) ||
      !hash.test(value.token) ||
      (token !== undefined && value.token !== token) ||
      typeof value.genesisRecordHex !== 'string' ||
      value.genesisRecordHex.length > 4096 ||
      !/^(?:[0-9a-f]{2})+$/.test(value.genesisRecordHex) ||
      !['email', 'link'].includes(value.mode) ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt < 0
    )
      return null;
    return {
      version: 1,
      workspaceId: value.workspaceId,
      genesisHash: value.genesisHash,
      genesisRecordHex: value.genesisRecordHex,
      endorser: value.endorser,
      token: value.token,
      mode: value.mode,
      expiresAt: value.expiresAt,
    };
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
export const memberJoinPath = (offer: E2eeMemberOffer) =>
  `/join/${offer.token}#e2ee=${encodeURIComponent(JSON.stringify(offer))}`;
export const sameMemberOffer = (a: E2eeMemberOffer, b: E2eeMemberOffer) =>
  (Object.keys(a) as (keyof E2eeMemberOffer)[]).every((key) => a[key] === b[key]);
export const desktopMemberJoinLink = (offer: E2eeMemberOffer) =>
  `lody://invite/open?${new URLSearchParams({ memberOffer: JSON.stringify(offer) })}`;
