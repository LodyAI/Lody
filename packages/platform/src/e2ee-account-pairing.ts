/**
 * Host contract for account-wide personal device pairing (foundations Spec,
 * "Account-wide personal device pairing"). The host owns the pairing secret, every
 * tag check, the 10-minute lifetime check, terminal-state records and all signing;
 * the UI only displays host-verified results and forwards explicit choices.
 * Every method is optional: a host without them shows no account pairing surface.
 */

/** Typed host refusals the UI explains. Hosts attach one as `code` on the thrown error. */
export type E2eeAccountPairingErrorCode =
  /** A tag did not verify: the request or approval changed after it was created. */
  | 'pairing-tampered'
  /** The authenticated expiry passed, or the request reached another terminal state. */
  | 'pairing-expired'
  /** This host already used or finished this pairing secret. */
  | 'pairing-used'
  /** Another tab of this browser owns the account pairing; it runs only there. */
  | 'pairing-elsewhere';

const ERROR_CODES: readonly E2eeAccountPairingErrorCode[] = [
  'pairing-tampered',
  'pairing-expired',
  'pairing-used',
  'pairing-elsewhere',
];
/** Reads the typed refusal from a host error; anything else is an ordinary failure. */
export function accountPairingErrorCode(error: unknown): E2eeAccountPairingErrorCode | null {
  const code =
    error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : null;
  return ERROR_CODES.find((known) => known === code) ?? null;
}

export type E2eeAccountPairingWorkspace = { workspaceId: string; name: string };

/** The new device's own retained request. */
export type E2eeAccountPairingRequestState = {
  direction: 'requester-shows' | 'approver-shows';
  /** Grouped pairing string, only while this device displays the code and it is open. */
  pairingString: string | null;
  /** The authenticated expiry this device created; never extended by a retry. */
  expiresAt: number;
  status: 'waiting' | 'joined' | 'declined' | 'expired';
  /** `blocked`: an unrelated, unfinished per-workspace pairing on this device must be
   * finished or cancelled before this workspace can be installed. */
  workspaces: (E2eeAccountPairingWorkspace & { state: 'pending' | 'joined' | 'blocked' })[];
};

/** Shown only after the host verified the request tag and its lifetime. */
export type E2eeAccountPairingPreview = {
  requestId: string;
  /** Supplied by the requesting device; display it as such. */
  deviceName: string;
  /** Estimated by the service from the request IP; display it as approximate. */
  approximateLocation: string | null;
  requestedAt: number;
  expiresAt: number;
  /** Requested workspaces where this device is an active personal device. */
  workspaces: E2eeAccountPairingWorkspace[];
  /** Requested workspaces this device cannot sign for; they stay pending. */
  unavailable: E2eeAccountPairingWorkspace[];
};

export type E2eeAccountPairingApproval = {
  workspaces: {
    workspaceId: string;
    outcome: 'admitted' | 'awaiting-delivery' | 'not-admitted';
  }[];
};

export interface E2eeAccountPairingRuntime {
  /** Start, or return the still-open, request of this device. Without a string the
   * host draws a new secret and shows it; with one it answers the approver's code. */
  requestAccountPairing?(input: { pairingString?: string }): Promise<E2eeAccountPairingRequestState>;
  /** The retained request and its latest verified progress; never creates one. */
  accountPairingRequest?(): Promise<E2eeAccountPairingRequestState | null>;
  /** Abandons and destroys the secret; a later request starts fresh. */
  cancelAccountPairing?(): Promise<void>;
  /** Reverse direction: this approved device shows a code for a new device to scan. */
  accountPairingCode?(): Promise<{ pairingString: string; expiresAt: number }>;
  /** Fetches and verifies the request for a code. `null` means no request has been
   * submitted under it yet (reverse direction). Refuses with a typed code. */
  inspectAccountPairing?(pairingString: string): Promise<E2eeAccountPairingPreview | null>;
  /** Signs the selected workspaces once and resumes after failure without re-signing. */
  approveAccountPairing?(input: {
    pairingString: string;
    requestId: string;
    workspaceIds: string[];
  }): Promise<E2eeAccountPairingApproval>;
  declineAccountPairing?(input: { pairingString: string; requestId: string }): Promise<void>;
}
