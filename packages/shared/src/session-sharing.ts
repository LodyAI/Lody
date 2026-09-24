export * from './session-share-package';
export * from './session-share-export';
export * from './session-share-client';
export * from './session-share-concurrency';
export * from './session-share-codec';
export * from './session-share-delivery';
import type { ShareDeliveryEnvelope } from './session-share-delivery';

/** Request intent only; no daemon API accepts approval or publication credentials. */
export type SessionShareRequestInput = {
  workspaceId: string;
  requestId: string;
  requesterUserId: string;
  sourceSessionId: string;
  sourceTurnId: string;
  sessionIds: string[];
  purpose: string;
  deliveryPublicKey: string;
};
export type SessionShareRequestStatus =
  | 'pending'
  | 'confirmed'
  | 'cancelled'
  | 'expired'
  | 'published';
export type SessionShareRequestResult = {
  /** Echo of the caller's idempotency key; reuse this as requestId on retry. */
  requestId: string;
  /** Server record identity for human confirmation, never a retry key. */
  shareRequestId: string;
  status: SessionShareRequestStatus;
  shareId?: string;
  delivery?: ShareDeliveryEnvelope;
};

/** Every response body, including attachment downloads, is bounded. */
export const SESSION_SHARE_READ_LIFETIME_MS = 120_000;
export const SESSION_SHARE_READ_AUTH_PATH = '/api/sharing/read';

export * from './session-share-credentials';
