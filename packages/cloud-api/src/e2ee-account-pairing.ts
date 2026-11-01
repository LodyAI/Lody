import type { E2eeDeviceAccess } from './e2ee-device';

/** Account-wide personal device pairing relay. Every operation requires the
 * signed-in account and is scoped to it; the service never sees the pairing
 * secret, holds no keys and cannot approve. Byte values are lowercase hex. The
 * canonical request/approval bytes and their HMAC tags are authoritative: clients
 * verify them with `@lody/e2ee-core/protocol` and ignore every advisory field. */
export type E2eeAccountPairingDirection = 'requester-shows' | 'approver-shows';

/** Service view of a request. Advisory: clients enforce expiry, one-time use and
 * terminal states from their own verified bytes and local records. */
export type E2eeAccountPairingStatus = 'pending' | 'approved' | 'declined' | 'expired';

/** Routing hint for one workspace row of the canonical request. */
export type E2eeAccountPairingWorkspace = { workspaceId: string; genesisHash: string };

export type E2eeAccountPairingSubmitRequest = {
  /** HKDF lookup ID derived from the pairing secret; 16 bytes. */
  lookupId: string;
  /** Canonical DAG-CBOR request, exactly as covered by `requestTag`. */
  requestHex: string;
  requestTagHex: string;
  /** Unverified copies for routing, rate limiting and notifications only. */
  direction: E2eeAccountPairingDirection;
  deviceName: string;
  expiresAt: number;
  workspaces: E2eeAccountPairingWorkspace[];
};

/** Notification-level summary shown to the account's approved personal devices. */
export type E2eeAccountPairingSummary = {
  requestId: string;
  status: E2eeAccountPairingStatus;
  /** Name supplied by the requesting device; display as such. */
  deviceName: string;
  /** Estimated by the service from the request's IP address; may be absent. */
  approximateLocation: string | null;
  requestedAt: number;
  expiresAt: number;
};

/** The relayed request, read by an approver that holds the pairing secret. */
export type E2eeAccountPairingRequestRecord = E2eeAccountPairingSummary & {
  lookupId: string;
  requestHex: string;
  requestTagHex: string;
  workspaces: E2eeAccountPairingWorkspace[];
};

/** One workspace's signed snapshot invitation from the approver. The device
 * access proves the approver is an active device there; the admission itself is
 * appended through the ordinary ledger path. */
export type E2eeAccountPairingInvitation = E2eeDeviceAccess & {
  genesisHash: string;
  invitationHex: string;
};

/** One approver's publication. Several approvers may each cover the workspaces
 * they can sign for. */
export type E2eeAccountPairingApproval = {
  /** Canonical DAG-CBOR approval, exactly as covered by `approvalTag`. */
  approvalHex: string;
  approvalTagHex: string;
  invitations: { workspaceId: string; genesisHash: string; invitationHex: string }[];
  publishedAt: number;
};

export type E2eeAccountPairingRequests = {
  submit: E2eeAccountPairingSubmitRequest;
  /** Open requests of the signed-in account, for notifications and decline. */
  pending: Record<string, never>;
  read: { lookupId: string };
  decline: { requestId: string };
  publish: {
    lookupId: string;
    approvalHex: string;
    approvalTagHex: string;
    invitations: E2eeAccountPairingInvitation[];
  };
  /** Polled by the requesting device for approvals of its own request. */
  claim: { lookupId: string };
};

export type E2eeAccountPairingReplies = {
  submit: E2eeAccountPairingSummary;
  pending: E2eeAccountPairingSummary[];
  read: E2eeAccountPairingRequestRecord | null;
  decline: { status: 'declined' };
  publish: { status: 'published' };
  claim: {
    status: E2eeAccountPairingStatus;
    approvals: E2eeAccountPairingApproval[];
  } | null;
};
