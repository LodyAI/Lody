import type { E2eeDeviceAccess } from './e2ee-device';

/** Public invitation pins transferred with the email/link, independently of the relay.
 * `signature` is the endorser device's Ed25519 signature over the pins
 * (`lody-e2ee/member-offer/v1`); only approving clients verify it, against their own
 * verified ledger, before admitting an email applicant automatically. */
export type E2eeMemberOffer = {
  version: 1;
  workspaceId: string;
  genesisHash: string;
  genesisRecordHex: string;
  endorser: string;
  token: string;
  mode: 'email' | 'link';
  expiresAt: number;
  /** Absent on invitations created before offers were signed, and stripped from previews,
   * invitation lists and links: only a request's own `offer` carries it to approvers. */
  signature?: string;
};

/** A signed core JoinRequest plus its exact device-credential binding; never secret keys. */
export type E2eeMemberKeyPackage = {
  version: 1;
  requestHex: string;
  credentialHash: string;
  bindingSignature: string;
};

/** Registration, key delivery and local installation are independent states. */
export type E2eeMemberRequest = {
  id: string;
  workspaceId: string;
  accountId: string;
  keyPackageHex: string;
  signingPublicKey: string;
  requestId: string;
  source: 'email' | 'link';
  state: 'pending' | 'admitting' | 'committed' | 'rejected' | 'cancelled';
  expiresAt: number;
  /** The relay's copy of the invitation this request answered. Approvers trust it only
   * after verifying its endorsement signature; `source` is a display label. */
  offer: E2eeMemberOffer;
};

export type E2eeMemberRequests = {
  createInvitation: E2eeDeviceAccess & { offer: E2eeMemberOffer; email?: string };
  preview: { token: string };
  submit: { token: string; keyPackageHex: string };
  retire: { token: string; keyPackageHex: string };
  pending: E2eeDeviceAccess;
  read: E2eeDeviceAccess & { requestId: string };
  reject: E2eeDeviceAccess & { requestId: string };
  revoke: E2eeDeviceAccess & { token: string };
  claim: { workspaceId: string; requestId: string };
};

export type E2eeMemberReplies = {
  createInvitation: { offer: E2eeMemberOffer };
  preview:
    | { status: 'unavailable' }
    | {
        status: 'available';
        workspaceName: string;
        workspaceSlug: string | null;
        offer: E2eeMemberOffer;
        recipientEmailMasked: string | null;
        matchesRecipient: boolean | null;
      };
  submit: E2eeMemberRequest;
  retire: { state: E2eeMemberRequest['state'] };
  pending: {
    /** Signature-free so clients that predate signed offers can still read the list.
     * Clients set `needsReissue` and `email` from `unsignedInvitations`. */
    invitations: (E2eeMemberOffer & { needsReissue?: true; email?: string })[];
    /** Email invitations created before offers were signed, with their address. Re-sending
     * one issues a signed replacement; they never qualify for automatic admission. */
    unsignedInvitations?: { token: string; email: string }[];
    items: (E2eeMemberRequest & { applicantName: string; applicantEmail: string })[];
    hasMore: boolean;
    seatPreview: import('./index').SeatInvitePreview;
  };
  read: E2eeMemberRequest;
  reject: { state: 'rejected' };
  revoke: { revoked: true };
  claim: E2eeMemberRequest;
};

/** Authenticated navigation/profile projection, never a content-access credential. */
export type E2eeMemberWorkspace = {
  id: string;
  name: string;
  slug: string;
  contentMode: 'e2ee';
  contentModeVersion: number;
  cryptoOrgId: string;
  genesisHash: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
  members: Array<{
    id: string;
    userId: string;
    role: string;
    user: { id: string; name: string; email: string; image?: string };
  }>;
};
