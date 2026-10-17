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
  /** Absent when this platform has no installed, persistent key-custody adapter.
   * A failed/unknown creation preserves its original local intent for reconciliation.
   */
  readonly prepareCreation?: (input: E2eeWorkspacePrepareInput) => Promise<E2eeWorkspacePrepared>;
  /** Commit exactly the prepared signed genesis. Unknown outcomes must retry the
   * same request, never generate another identity or silently create plaintext.
   */
  readonly create: (input: E2eeWorkspaceCreateRequest) => Promise<E2eeWorkspaceCreateResult>;
  /** Resolve persisted mode or explicit legacy admission before cloud attachment.
   * Legacy admission does not classify a workspace as plaintext. Cached IDs,
   * missing fields and unknown modes are never inferred to be plaintext proof.
   */
  readonly describe: (input: { workspaceId: string }) => Promise<WorkspaceAdmissionDescriptor>;
  /** Read original records from genesis through one fixed advertised checkpoint.
   * The caller verifies continuity/signatures and its independent genesis pin.
   */
  readonly history: (input: E2eeWorkspaceHistoryRequest) => Promise<E2eeWorkspaceHistoryPage>;
}
