import type {
  E2eeWorkspaceCreateRequest,
  E2eeWorkspaceCreateResult,
  E2eeWorkspaceHistoryPage,
  E2eeWorkspaceHistoryRequest,
  E2eePersonalPairingOffer,
  E2eeWorkspaceMemberProfilesRequest,
  E2eeWorkspaceMemberProfiles,
  WorkspaceAdmissionDescriptor,
} from '@lody/cloud-api';

/** Public creation intent. The host verifies accountId against its signed-in account. */
export interface E2eeWorkspacePrepareInput {
  readonly accountId: string;
  readonly requestId: string;
  readonly name: string;
  readonly slug: string;
}

/** Returned only after protected device and epoch keys have been durably read back.
 * This contains public signed bytes, never private keys. Retrying the same intent
 * returns the same original; changing any field under its requestId must fail.
 */
export interface E2eeWorkspacePrepared extends E2eeWorkspacePrepareInput {
  readonly genesisRecordHex: string;
  readonly genesisHashHex: string;
  readonly deviceCredentialHash: string;
}

/** Control-plane access, independent of the ordinary document/execution runtime.
 * Existence of this port does not enable encrypted chat, attachments or RPC.
 * The developer preference controls new creation only, never existing reads.
 */
export interface PlatformE2eeWorkspaces {
  readonly runtime?: E2eeWorkspaceRuntime;
  /** Optional display directory. Names/images never establish permission, keys or identity pins. */
  readonly memberProfiles?: (
    input: E2eeWorkspaceMemberProfilesRequest
  ) => Promise<E2eeWorkspaceMemberProfiles>;
  /** Absent when this platform has no installed, persistent key-custody adapter.
   * A failed/unknown creation preserves its original local intent for reconciliation.
   */
  readonly prepareCreation?: (input: E2eeWorkspacePrepareInput) => Promise<E2eeWorkspacePrepared>;
  /** Commit exactly the prepared signed genesis. Unknown outcomes must retry the
   * same request, never generate another identity or silently create plaintext.
   */
  readonly create: (input: E2eeWorkspaceCreateRequest) => Promise<E2eeWorkspaceCreateResult>;
  /** Resolve persisted mode or explicit legacy admission. Workspaces with local
   * encrypted evidence or an encrypted listing need it before cloud attachment;
   * others open provisionally and are verified in the background.
   * Legacy admission does not classify a workspace as plaintext. Cached IDs,
   * missing fields and unknown modes are never inferred to be plaintext proof.
   */
  readonly describe: (input: { workspaceId: string }) => Promise<WorkspaceAdmissionDescriptor>;
  /** Read original records from genesis through one fixed advertised checkpoint.
   * The caller verifies continuity/signatures and its independent genesis pin.
   */
  readonly history: (input: E2eeWorkspaceHistoryRequest) => Promise<E2eeWorkspaceHistoryPage>;
}

/** Public status of a host-owned runtime. No secret key material crosses this port. */
export interface E2eeRuntimeStatus {
  readonly workspaceId: string;
  readonly genesisHash: string;
  readonly length: number;
  readonly headHash: string;
  readonly stateDigest: string;
  readonly position: string | null;
  readonly epoch: number;
  readonly rotationRequired: boolean;
  readonly deviceKind: 'personal' | 'machine' | 'recovery' | null;
  readonly hasCurrentKey: boolean;
  /** Confirmed retained key usable for sends while current-key reception retries. */
  readonly writeEpoch?: number | null;
  /** Local credential availability only; the credential remains in the host. */
  readonly hasDeviceCredential?: boolean;
  readonly continuityPending: boolean;
  readonly upgradeRequiredAt?: number;
}
/** The main process's own public export, for ledger display without another replay. */
export interface E2eeRuntimeLedgerView {
  readonly status: E2eeRuntimeStatus;
  readonly stateHex: string;
  readonly recordsHex: readonly string[];
  /** Absolute ledger positions; a snapshot-origin host need not hold the prefix. */
  readonly recordPositions?: readonly number[];
}
/** Desktop-only purpose-limited IPC; opening an existing workspace never creates an identity. */
export interface E2eeWorkspaceRuntime {
  personalPairingOffer?(workspaceId: string): Promise<E2eePersonalPairingOffer>;
  preparePersonalJoin?(
    offer: E2eePersonalPairingOffer
  ): Promise<{ pairingSessionId: string; signingPublicKey: string; status: string }>;
  /** Query only the host's retained local request; never creates a session. */
  pendingPersonalJoin?(workspaceId: string): Promise<{
    pairingSessionId: string;
    signingPublicKey?: string;
    offer: E2eePersonalPairingOffer;
  } | null>;
  inspectPersonalJoin?(
    workspaceId: string,
    pairingSessionId: string
  ): Promise<{
    pairingSessionId: string;
    signingPublicKey: string;
    encryptionPublicKey: string;
    credentialHash: string;
    protection: 'os-keystore';
  }>;
  approvePersonalJoin?(
    workspaceId: string,
    pairingSessionId: string
  ): Promise<{ admitted: true; invitationPublished: boolean }>;
  claimPersonalJoin?(
    workspaceId: string,
    pairingSessionId: string
  ): Promise<{ ready: boolean; status: string }>;
  cancelPersonalJoin?(
    workspaceId: string,
    pairingSessionId: string
  ): Promise<{ status: 'cancelled' }>;
  /** Local identity only; never authorizes a cloud request. */
  account(options?: {
    token?: string;
  }): Promise<{ userId: string; source: 'network' | 'offline' } | null>;
  /** Prepare public same-user machine evidence; this never admits the device. */
  prepareLocalAgent?(
    workspaceId: string
  ): Promise<{ pairingSessionId: string; protection: 'os-keystore' | 'file'; admitted: boolean }>;
  /** Explicit approval only; retries reconcile the persisted original ledger record. */
  admitLocalAgent?(
    workspaceId: string,
    pairingSessionId: string
  ): Promise<{ admitted: true; ready: boolean }>;
  /** Ledger-only refresh separates discovery from retryable background key reception. */
  refresh(workspaceId: string, options?: { installKeys?: boolean }): Promise<E2eeRuntimeStatus>;
  contentStreamsToken(
    workspaceId: string,
    rejectedToken?: string,
    requestSnapshotFor?: string
  ): Promise<import('@lody/cloud-api').E2eeContentToken>;
  seal(
    workspaceId: string,
    input: E2eeContentSeal
  ): Promise<{ header: Uint8Array; sealed: Uint8Array }>;
  openContent(workspaceId: string, input: E2eeContentOpen): Promise<Uint8Array>;
  /** Explicitly archive local originals and require fresh independently approved pairing. */
  resetIdentity?(input: {
    workspaceId?: string;
    resetId: string;
    confirm: true;
  }): Promise<{ archive: string | null }>;
  /** Archive the local CLI machine identity; retain the desktop personal identity. */
  resetLocalAgent?(input: { workspaceId: string; resetId: string; confirm: true }): Promise<void>;
  recordCreated(input: {
    workspaceId: string;
    genesisHash: string;
    requestId?: string;
  }): Promise<void>;
  open(
    workspaceId: string,
    observed?: { genesisHash: string; headHash: string; length: number }
  ): Promise<E2eeRuntimeStatus>;
  close(workspaceId: string): Promise<void>;
  /** Read retained verified identity without granting this window a reader.
   * The host binds the expected account and releases its temporary read before
   * returning. Missing on older hosts; callers must not fall back to status. */
  readIdentity?(input: { accountId: string; workspaceId: string }): Promise<{
    workspaceId: string;
    genesisHash: string;
  }>;
  status(workspaceId: string): Promise<E2eeRuntimeStatus>;
  ingestLedgerRecords(
    workspaceId: string,
    page: E2eeWorkspaceHistoryPage
  ): Promise<E2eeRuntimeStatus>;
  ledgerView(workspaceId: string): Promise<E2eeRuntimeLedgerView>;
}

/** Purpose-bound IPC input. Functions, signing keys and document keys never cross. */
export type E2eeContentRoom =
  | { kind: 'meta' }
  | { kind: 'doc'; docId: string }
  | { kind: 'flock'; flockDocId: string };
export type E2eeContentContext = {
  protocol: 'loro-streams-crdt-payload-protection';
  version: 2;
  kind: 'update_batch' | 'snapshot';
  continuationOffset?: string;
};
export type E2eeContentSeal = {
  epoch: number;
  room: E2eeContentRoom;
  context: E2eeContentContext;
  plaintext: Uint8Array;
  additionalData: Uint8Array;
};
export type E2eeContentOpen = {
  room: E2eeContentRoom;
  context: E2eeContentContext;
  sealed: Uint8Array;
  header: Uint8Array;
  additionalData: Uint8Array;
};
