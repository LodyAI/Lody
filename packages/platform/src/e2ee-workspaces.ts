import type {
  E2eeWorkspaceCreateRequest,
  E2eeWorkspaceCreateResult,
  E2eeWorkspaceHistoryPage,
  E2eeWorkspaceHistoryRequest,
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
}

/** Control-plane access, independent of the ordinary document/execution runtime.
 * Existence of this port does not enable encrypted chat, attachments or RPC.
 * The developer preference controls new creation only, never existing reads.
 */
export interface PlatformE2eeWorkspaces {
  readonly runtime?: E2eeWorkspaceRuntime;
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
  readonly continuityPending: boolean;
  readonly upgradeRequiredAt?: number;
}
/** The main process's own public export, for ledger display without another replay. */
export interface E2eeRuntimeLedgerView {
  readonly status: E2eeRuntimeStatus;
  readonly stateHex: string;
  readonly recordsHex: readonly string[];
}
/** Desktop-only purpose-limited IPC; opening an existing workspace never creates an identity. */
export interface E2eeWorkspaceRuntime {
  recordCreated(input: { workspaceId: string; genesisHash: string; requestId?: string }): Promise<void>;
  open(workspaceId: string, observed?: { genesisHash: string; headHash: string; length: number }): Promise<E2eeRuntimeStatus>;
  close(workspaceId: string): Promise<void>;
  status(workspaceId: string): Promise<E2eeRuntimeStatus>;
  ingestLedgerRecords(workspaceId: string, page: E2eeWorkspaceHistoryPage): Promise<E2eeRuntimeStatus>;
  ledgerView(workspaceId: string): Promise<E2eeRuntimeLedgerView>;
}
