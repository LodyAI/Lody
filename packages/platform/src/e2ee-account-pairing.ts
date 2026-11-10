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
  /** Another unfinished request owns pairing on this device; continue or cancel it first. */
  | 'pairing-elsewhere'
  /** The service refuses account pairing: it is switched off on this deployment. */
  | 'pairing-unavailable'
  /** The service refuses new requests for this account until its hourly limit resets. */
  | 'pairing-rate-limited'
  /** The native host cannot preserve the automatic exchange's original deadline. */
  | 'pairing-update-required';

const ERROR_CODES: readonly E2eeAccountPairingErrorCode[] = [
  'pairing-tampered',
  'pairing-expired',
  'pairing-used',
  'pairing-elsewhere',
  'pairing-unavailable',
  'pairing-rate-limited',
  'pairing-update-required',
];
/** Reads the typed refusal from a host error; anything else is an ordinary failure. */
export function accountPairingErrorCode(error: unknown): E2eeAccountPairingErrorCode | null {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code: unknown }).code
      : null;
  return ERROR_CODES.find((known) => known === code) ?? null;
}

export type E2eeAccountPairingWorkspace = { workspaceId: string; name: string };

/** The new device's own retained request. */
export type E2eeAccountPairingRequestState = {
  /** Public request identity, supplied only by hosts supporting exact-ID cancellation. */
  lookupId?: string;
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
  requestAccountPairing?(input: {
    pairingString?: string;
    /** Optional shorter original deadline for a committed automatic exchange. */
    expiresAt?: number;
    /** Refuse replacing a different retained request in the native account owner. */
    preserveExisting?: true;
    workspace?: { workspaceId: string; name: string; genesisHash: string };
  }): Promise<E2eeAccountPairingRequestState>;
  /** The retained request and its latest verified progress; never creates one. */
  accountPairingRequest?(): Promise<E2eeAccountPairingRequestState | null>;
  /** Abandons and destroys the secret; a later request starts fresh. */
  cancelAccountPairing?(input?: { expectedLookupId: string }): Promise<void>;
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

/** Verified automatic channel state; no raw pairing secret crosses this UI port. */
export type E2eeAutomaticPairingState = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  deviceName: string;
  expiresAt: number;
  comparisonCode: string | null;
  phase: 'preparing' | 'waiting' | 'syncing' | 'joined' | 'declined' | 'expired' | 'cancelled';
};
/** A host-authenticated, current-workspace-only approval preview. */
export type E2eeAutomaticPairingReview = E2eeAutomaticPairingState & { requestId: string };
/** Optional real runtime capability. Discovery alone never grants access. */
export interface E2eeAutomaticPairingRuntime {
  /** Optional push hints; verification still occurs through the ordinary runtime reads. */
  subscribeAutomaticPairing?(changed: () => void): () => void;
  startAutomaticPairing?(workspaceId: string): Promise<E2eeAutomaticPairingState>;
  automaticPairingState?(workspaceId: string): Promise<E2eeAutomaticPairingState | null>;
  cancelAutomaticPairing?(workspaceId: string): Promise<void>;
  /** Explicitly end the displayed native request, never a concurrently replaced one. */
  restartAutomaticPairing?(
    workspaceId: string,
    input: { expectedLookupId: string }
  ): Promise<E2eeAutomaticPairingState>;
  pendingAutomaticPairing?(): Promise<E2eeAutomaticPairingReview[]>;
  approveAutomaticPairing?(id: string): Promise<void>;
  declineAutomaticPairing?(id: string): Promise<void>;
}
