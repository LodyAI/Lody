import type { E2eeDeviceAccess } from './e2ee-device';

/** Transfer directly from the approving desktop. The service cannot choose the
 * joining host's genesis or endorser pin. Public evidence only, never keys. */
export type E2eePersonalPairingOffer = {
  version: 1;
  workspaceId: string;
  genesisHash: string;
  genesisRecordHex: string;
  endorser: string;
  membershipId: string;
  pairingSessionId: string;
};
export type E2eeJoinSessionRequest = { workspaceId: string; pairingSessionId: string };
export type E2eeJoinBeginRequest = E2eeJoinSessionRequest & {
  genesisHash: string;
  signingPublicKey: string;
  credentialHash: string;
  requestHex: string;
};
export type E2eeJoinSession = E2eeJoinBeginRequest & {
  accountId: string;
  status: 'pending' | 'cancelled' | 'admitting' | 'admitted' | 'conflict' | 'published';
};
export type E2eeJoinRequests = {
  begin: E2eeJoinBeginRequest;
  status: E2eeJoinSessionRequest;
  readRequest: E2eeDeviceAccess & { pairingSessionId: string };
  cancel: E2eeJoinSessionRequest;
  publish: E2eeDeviceAccess & { pairingSessionId: string; invitationHex: string };
  claim: E2eeJoinSessionRequest;
};
export type E2eeJoinReplies = {
  begin: E2eeJoinSession;
  status: E2eeJoinSession;
  readRequest: E2eeJoinSession;
  cancel: { status: 'cancelled' };
  publish: { status: 'published' };
  claim: E2eeJoinSession & { publisher: string | null; invitationHex: string | null };
};
