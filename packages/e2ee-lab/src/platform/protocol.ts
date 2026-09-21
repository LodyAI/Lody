export const CONTROL_STREAM = 'control';
export const KEYS_STREAM = 'keys';
export const LORO_STREAM = 'loro';
export const FLOCK_STREAM = 'flock';
export const CONTENT_TYPE = 'application/octet-stream';
export const MAX_LEASE_MS = 15 * 60 * 1000;
export const AUTH_HEADER = 'authorization';
export const DEVICE_HEADER = 'x-e2ee-demo-device';
export const NOW_HEADER = 'x-e2ee-demo-now';
export const ACCOUNT_HEADER = 'x-e2ee-demo-account';

export type Failpoint = 'drop-control-ack' | 'kill-after-commit' | 'hang-control-ack' | 'none';

export interface IssuedCredential {
  readonly token: string;
  readonly account: string;
  readonly deviceHex: string;
  readonly genesisHex: string | null;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface SpaceInfo {
  readonly genesisHex: string;
  readonly ownerDeviceHex: string;
}

export interface JoinRequestWire {
  readonly requestId: string;
  readonly userId: string;
  readonly signingPublicKey: string;
  readonly encryptionPublicKey: string;
  readonly expiresAt: number | null;
  readonly signature: string;
}

export interface ComparisonWire {
  readonly genesis: string;
  readonly length: number;
  readonly head: string;
  readonly stateDigest: string;
  readonly noteSigner: string;
}
