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
  /** Ephemeral main-process reader owner; never persisted or an authorization credential. */
  readonly readerOwner?: string;
  /** Current self membership, derived only from the host's verified ledger. */
  readonly signingPublicKey?: string;
  readonly membershipId?: string | null;
  readonly memberRole?: 'owner' | 'admin' | 'member' | 'guest' | null;
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
/** Facts from the host's current verified ledger, never cloud projections. */
export interface E2eeManagementState {
  readonly epoch: number;
  readonly rotationRequired: boolean;
  readonly mayRotate: boolean;
  readonly updatePending: boolean;
  readonly recoveryIssue?: 'candidate-unavailable';
  readonly devices: readonly {
    key: string;
    kind: 'personal' | 'machine' | 'recovery';
    machineId: string | null;
    self: boolean;
    mayRevoke: boolean;
  }[];
}
/** Desktop-only purpose-limited IPC; opening an existing workspace never creates an identity. */
export interface E2eeWorkspaceRuntime {
  managementState?(workspaceId: string): Promise<E2eeManagementState>;
  updateKeys?(workspaceId: string): Promise<void>;
  revokeDevice?(workspaceId: string, signingPublicKey: string): Promise<void>;
  /** Explicit management intent; the host signs once and retains the exact original. */
  removeMember?(workspaceId: string, membershipId: string): Promise<void>;
  /** Owner-only Admin promotion/demotion, checked against the latest verified ledger. */
  setMemberRole?(
    workspaceId: string,
    membershipId: string,
    role: 'admin' | 'member'
  ): Promise<void>;
  /** Create public email/link pins using a current manager's native device. */
  createMemberInvitation?(input: {
    workspaceId: string;
    mode: 'email' | 'link';
    email?: string;
  }): Promise<import('@lody/cloud-api').E2eeMemberOffer>;
  prepareMemberJoin?(
    offer: import('@lody/cloud-api').E2eeMemberOffer
  ): Promise<import('@lody/cloud-api').E2eeMemberRequest>;
  pendingMemberJoin?(
    workspaceId: string
  ): Promise<{ offer: import('@lody/cloud-api').E2eeMemberOffer; requestId: string | null } | null>;
  memberJoinRequests?(
    workspaceId: string
  ): Promise<import('@lody/cloud-api').E2eeMemberReplies['pending']>;
  /** Automatic mode is permitted only for an accepted, targeted email invitation. */
  approveMemberJoin?(
    workspaceId: string,
    requestId: string,
    mode: 'automatic' | 'explicit'
  ): Promise<{ admitted: boolean; keyPending: boolean }>;
  rejectMemberJoin?(workspaceId: string, requestId: string): Promise<{ state: 'rejected' }>;
  revokeMemberInvitation?(workspaceId: string, token: string): Promise<{ revoked: true }>;
  claimMemberJoin?(
    workspaceId: string,
    requestId: string
  ): Promise<{ ready: boolean; state: string }>;
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
  beginRemoteMachinePairing?(
    workspaceId: string
  ): Promise<import('@lody/shared/e2ee-remote-pairing').RemoteMachineStatus & { command: string }>;
  inspectRemoteMachinePairing?(
    workspaceId: string,
    pairingSessionId: string
  ): Promise<
    import('@lody/shared/e2ee-remote-pairing').RemoteMachineStatus & { summary: string | null }
  >;
  approveRemoteMachinePairing?(
    workspaceId: string,
    pairingSessionId: string,
    summary: string
  ): Promise<{ admitted: boolean; ready: boolean }>;
  cancelRemoteMachinePairing?(
    workspaceId: string,
    pairingSessionId: string
  ): Promise<import('@lody/shared/e2ee-remote-pairing').RemoteMachineStatus>;
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
  /** Purpose-bound native preparation; persists the original before returning ciphertext. */
  prepareFeatureRpc?(
    workspaceId: string,
    input: import('@lody/shared/e2ee-rpc').E2eeFeatureInput
  ): Promise<import('@lody/shared/e2ee-rpc').E2eePreparedDispatch>;
  acceptFeatureRpcResponse?(
    workspaceId: string,
    input: import('@lody/shared/e2ee-rpc').E2eeFeatureInput,
    frame: string
  ): Promise<import('@lody/shared/e2ee-rpc').E2eeFeatureResponsePart>;
  prepareDispatch?(
    workspaceId: string,
    targetMachineId: string,
    input: import('@lody/shared/e2ee-rpc').E2eeDispatchInput
  ): Promise<import('@lody/shared/e2ee-rpc').E2eePreparedDispatch>;
  /** Verify and retain a correlated target-signed delivery ACK, never an execution result. */
  acceptDispatchResponse?(
    workspaceId: string,
    targetMachineId: string,
    input: import('@lody/shared/e2ee-rpc').E2eeDispatchInput,
    frameHex: string
  ): Promise<import('@lody/shared/e2ee-rpc').E2eeDispatchAck>;
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
    observed?: { genesisHash: string; headHash: string; length: number },
    expectedAccountId?: string
  ): Promise<E2eeRuntimeStatus>;
  close(workspaceId: string, expectedAccountId?: string, readerOwner?: string): Promise<void>;
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
