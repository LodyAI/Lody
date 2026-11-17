/** Account-bound discovery context. Untrusted until the clients verify the committed exchange. */
export type E2eeAutomaticPairingContext = {
  version: 1;
  id: string;
  accountId: string;
  workspaceId: string;
  genesisHash: string;
  deviceName: string;
  expiresAt: number;
};
/** Opaque public handshake messages. No pairing secret or private key reaches the relay. */
export type E2eeAutomaticPairingRecord = {
  context: E2eeAutomaticPairingContext;
  state: 'pending' | 'approved' | 'declined' | 'cancelled';
  commitment?: { peerId: string; commitment: string };
  requesterKey?: string;
  reveal?: { publicKey: string; nonce: string };
};
/** One bounded relay command; each field is immutable once published. */
export type E2eeAutomaticPairingCommand = {
  id: string;
  context?: E2eeAutomaticPairingContext;
  commitment?: { peerId: string; commitment: string };
  requesterKey?: string;
  reveal?: { publicKey: string; nonce: string };
  terminal?: 'approved' | 'declined' | 'cancelled';
};
