/** Opaque device credential. Remote machines use an explicitly admitted, device-scoped service grant. */
export type E2eeDeviceAccess = { workspaceId: string; credential: string; cliToken?: string };
export type E2eeContentTokenRequest = E2eeDeviceAccess & {
  rejectedToken?: string;
  /** Separate RPC-only stream grant; never permits document or snapshot writes. */
  rpcOnly?: true;
  /** Ask the existing action to append a fixed, short-lived repair hint for this
   * workspace stream. This grants no content write right, including to Guests. */
  requestSnapshotFor?: string;
};
export type E2eeContentToken = {
  /** Short-lived attachment-only grant; device credentials remain in the host. */
  attachmentToken?: string;
  token: string;
  bucketId: string;
  gatewayBaseUrl: string;
  expiresIn: number;
  expiresAt: number;
};
export type E2eeMailboxSlot = { genesis: string; epoch: number; recipient: string };
export type E2eeMailboxStatus = E2eeMailboxSlot & {
  revision: number;
  status: 'NeedsEnvelope' | 'EnvelopeStored' | 'InstallationReported' | 'Ineligible' | 'Obsolete';
};
export type E2eeMailboxRequests = {
  put: E2eeDeviceAccess & { id: string; frameHex: string };
  read: E2eeDeviceAccess & { id: string };
  fetch: E2eeDeviceAccess & { epoch: number; cursor: string | null; limit: number };
  status: E2eeDeviceAccess & { slot: E2eeMailboxSlot };
  report: E2eeDeviceAccess & { reportHex: string; publicationHex?: string };
  repair: E2eeDeviceAccess & { slot: E2eeMailboxSlot; id: string; rejectedDigest?: string };
};
export type E2eeMailboxReplies = {
  put: null;
  read: string | null;
  fetch: { items: { sender: string; frameHex: string }[]; next: string | null };
  status: E2eeMailboxStatus;
  report: null;
  repair: null;
};
export type E2eeAppendRecordRequest = {
  workspaceId: string;
  requestId: string;
  recordHex: string;
  credentialHash?: string;
  /** Remote machine cancellation/admission fence. */
  machinePairingSessionId?: string;
  /** Personal join cancellation fence, consumed with the writer reservation. */
  pairingSessionId?: string;
};
export type E2eeAppendRecordReply = { status: string; recordHash: string };
