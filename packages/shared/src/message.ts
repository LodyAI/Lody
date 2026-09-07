import type {
  MachineId,
  ACPSessionConfig,
  SessionId,
  WorkspaceId,
  ProjectRef,
  LocalProjectId,
  LocalProjectGitState,
  LocalProjectHistoryCatalogItem,
  LocalProjectHistoryProvider,
  WorktreeCleanupScriptConfig,
  WorktreeSetupScriptConfig,
  AgentConfigId,
  AgentConfigCliType,
  SessionImageGroupContent,
  SessionImagePayload,
  SessionFilePayload,
  SessionTurnInputConfig,
  AcpCapabilityCacheEntry,
} from '.';
import type {
  PreviewCandidateReportRequest,
  PreviewCandidateReportResponse,
  SessionPreviewCreateRequest,
  SessionPreviewCreateResponse,
  SessionPreviewRevokeRequest,
  SessionPreviewRevokeResponse,
} from './preview';
import type { ProjectSkillsResult } from './acp/skills';
import type { RpcSecretPublicKey } from './rpc-secret';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

export type PermissionOutcome = RequestPermissionResponse['outcome'] & {
  _meta?: Record<string, unknown> | null;
};

export type {
  PreviewCandidateReportRequest,
  PreviewCandidateReportResponse,
  SessionPreviewCreateRequest,
  SessionPreviewCreateResponse,
  SessionPreviewEndpointAcquireResponse,
  SessionPreviewEndpointReleaseResponse,
  SessionPreviewRevokeRequest,
  SessionPreviewRevokeResponse,
} from './preview';

// ============================================
// CONTROL PROTOCOL MESSAGES
// ============================================

export type SessionStartMeta = {
  fromFeedbackPostId?: string;
};

// Session Create Messages
export interface SessionCreateRequest {
  type: 'session/create';
  sessionId: SessionId;
  machineId: MachineId;
  workspaceId: WorkspaceId;
  project?: ProjectRef;
  meta?: SessionStartMeta;
  acpSessionConfig: ACPSessionConfig;
  worktreeSetup?: WorktreeSetupScriptConfig;
  worktreeCleanup?: WorktreeCleanupScriptConfig;
  env?: Record<string, string>;
  /** Optional first user message history entry id for CRDT-driven dispatch tracking. */
  userTurnId?: string;
  userId: string;
  userName: string;
  userEmail: string;
  /** If set, this is a child tab session that should reuse the parent's workspace directory. */
  parentSessionId?: SessionId;
}

export type SessionCreateResponse = {
  type: 'session/create_response';
  sessionId: SessionId;
  success: boolean;
  error?: string;
};

// Session Create Ack - sent immediately when local control accepts the request
export type SessionCreateAck = {
  type: 'session/create_ack';
  sessionId: SessionId;
};

export type SessionTerminateResponse = {
  type: 'session/terminate_response';
  sessionId: SessionId;
  success: boolean;
  error?: string;
};

export type SessionChatRequest = {
  type: 'session/chat';
  sessionId: SessionId;
  machineId: MachineId;
  workspaceId: WorkspaceId;
  project?: ProjectRef;
  acpSessionConfig: ACPSessionConfig;
  /** User message history entry id (used for diff attribution + resume replay filtering) */
  userTurnId: string;
  userId: string;
  userName: string;
  userEmail: string;
};

export interface SessionChatResponse {
  type: 'session/chat_response';
  sessionId: SessionId;
  /** User message history entry id - correlates response to original request */
  userTurnId: string;
  success: boolean;
  error?: string;
}

// Session Chat Ack - sent immediately when local control accepts the request
export type SessionChatAck = {
  type: 'session/chat_ack';
  sessionId: SessionId;
  userTurnId: string;
};

export interface SessionCancelRequest {
  type: 'session/cancel';
  sessionId: SessionId;
  machineId: MachineId;
  workspaceId: WorkspaceId;
  /** Target assistant turn id. This is intentionally not the userTurnId. */
  turnId: string;
}

export interface SessionCancelResponse {
  type: 'session/cancel_response';
  sessionId: SessionId;
  success: boolean;
  error?: string;
}

export interface SessionSteerRequest {
  type: 'session/steer';
  sessionId: SessionId;
  machineId: MachineId;
  workspaceId: WorkspaceId;
  /** The assistant turn that must still own the in-flight ACP prompt. */
  expectedTurnId: string;
  userTurnId: string;
  userId: string;
  timestamp: string;
  inputConfig: SessionTurnInputConfig;
}

export interface SessionSteerResponse {
  type: 'session/steer_response';
  sessionId: SessionId;
  userTurnId: string;
  /** True only after adapter activation and CLI turn-ownership commit. */
  applied: boolean;
  disposition: 'applied' | 'unsupported' | 'no-active-turn' | 'stale-turn' | 'busy' | 'error';
  error?: string;
}

// Permission Messages
export interface PermissionRequestMessage {
  type: 'session/permission_request';
  sessionId: SessionId;
  requestId: string;
  request: RequestPermissionRequest;
}

export interface PermissionResponseMessage {
  type: 'session/permission_response';
  sessionId: SessionId;
  requestId: string;
  outcome: PermissionOutcome;
}

// ============================================
// MACHINE STATUS AND CONTROL MESSAGES
// ============================================

// Machine resource information
export interface MachineResourceInfo {
  totalMemoryGB: number;
  usedMemoryGB: number;
  freeMemoryGB: number;
  totalCpus: number;
  cpuUsagePercent: number;
}

// Machine Status Request (Client -> Server -> Machine)
export interface MachineStatusRequest {
  type: 'machine/status';
  machineId: MachineId;
  workspaceId: WorkspaceId;
}

export type MachineLifecycleLaunchMode = 'daemon' | 'foreground' | 'electron' | 'unknown';

export type MachineLifecycleUnsupportedReason = 'not_daemon' | 'electron' | 'unsupported_install';

export interface MachineLifecycleCapability {
  launchMode: MachineLifecycleLaunchMode;
  canRemoteRestart: boolean;
  canRemoteUpgrade: boolean;
  reason?: MachineLifecycleUnsupportedReason;
}

// Machine Status Response (Machine -> Server -> Client)
export interface MachineStatusResponse {
  type: 'machine/status_response';
  machineId: MachineId;
  success: boolean;
  resources?: MachineResourceInfo;
  lifecycle?: MachineLifecycleCapability;
  error?: string;
}

export interface MachinePingRequest {
  type: 'machine/ping';
  machineId: MachineId;
  workspaceId: WorkspaceId;
  requestId: string;
}

export interface MachinePingResponse {
  type: 'machine/ping_response';
  machineId: MachineId;
  requestId: string;
  success: boolean;
  message?: 'pong';
  error?: string;
}

export type MachineLifecycleDisposition =
  | 'accepted'
  | 'already_pending'
  | 'unauthorized'
  | 'invalid_target'
  | 'unsupported_launch_mode'
  | 'unsupported_install'
  | 'error';

export interface MachineRestartRequest {
  type: 'machine/restart';
  machineId: MachineId;
  workspaceId: WorkspaceId;
  requesterUserId: string;
  /** Signed requester proof minted by the backend for this lifecycle request. */
  requestToken: string;
  /** Client-generated operation id bound into requestToken for replay defense. */
  requestId: string;
}

export interface MachineRestartResponse {
  type: 'machine/restart_response';
  machineId: MachineId;
  requestId: string;
  success: boolean;
  accepted: boolean;
  disposition: MachineLifecycleDisposition;
  error?: string;
}

export interface MachineUpgradeRequest {
  type: 'machine/upgrade';
  machineId: MachineId;
  workspaceId: WorkspaceId;
  requesterUserId: string;
  /** Signed requester proof minted by the backend for this lifecycle request. */
  requestToken: string;
  /** Client-generated operation id bound into requestToken for replay defense. */
  requestId: string;
  /** Defaults to `latest`; exact semver-like versions are also accepted. */
  targetVersion?: string;
}

export interface MachineUpgradeResponse {
  type: 'machine/upgrade_response';
  machineId: MachineId;
  requestId: string;
  success: boolean;
  accepted: boolean;
  disposition: MachineLifecycleDisposition;
  currentVersion?: string;
  targetVersion?: string;
  error?: string;
}

export interface MachineAcpCapabilitiesRefreshRequest {
  type: 'machine/acp-capabilities-refresh';
  machineId: MachineId;
  workspaceId: WorkspaceId;
  configId: AgentConfigId;
}

export interface MachineAcpCapabilitiesRefreshResponse {
  type: 'machine/acp-capabilities-refresh_response';
  machineId: MachineId;
  configId: AgentConfigId;
  cliType: AgentConfigCliType;
  agentType: string;
  success: boolean;
  modes?: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
  models?: Array<{
    modelId: string;
    name?: string;
    description?: string;
  }>;
  /** Summary of config options discovered (for display in toast). */
  configOptions?: Array<{
    id: string;
    name: string;
    category?: string;
    optionCount: number;
  }>;
  /** Complete persisted entry for immediate renderer convergence after the refresh RPC. */
  capability?: AcpCapabilityCacheEntry;
  /** Available slash commands advertised by the agent. */
  availableCommands?: Array<{
    name: string;
    description?: string;
  }>;
  /** True when initialize succeeded but session creation requires login. */
  authRequired?: boolean;
  authMethods?: MachineAcpAuthMethodSummary[];
  error?: string;
}

export interface MachineAcpAuthMethodSummary {
  type: 'agent' | 'env_var' | 'terminal';
  id?: string;
  name?: string;
  description?: string;
  /** Display-only. The machine resolves the trusted executable and arguments. */
  args?: string[];
}

export type MachineAcpAuthenticationFormField =
  | {
      id: string;
      type: 'text';
      label: string;
      description?: string;
      required: boolean;
      defaultValue?: string;
    }
  | {
      id: string;
      type: 'secret';
      label: string;
      description?: string;
      required: boolean;
    }
  | {
      id: string;
      type: 'select';
      label: string;
      description?: string;
      required: boolean;
      options: Array<{ value: string; label: string }>;
      defaultValue?: string;
    };

export interface MachineAcpAuthenticationForm {
  title?: string;
  description?: string;
  fields: MachineAcpAuthenticationFormField[];
}

type MachineAcpAuthenticateRequestBase = {
  type: 'machine/acp-authenticate';
  machineId: MachineId;
  workspaceId: WorkspaceId;
  requestId: string;
};

export type MachineAcpAuthenticateRequest = MachineAcpAuthenticateRequestBase &
  (
    | {
        action: 'start';
        /** Daemon-authoritative persisted Provider config. No launch fields cross RPC. */
        configId: AgentConfigId;
      }
    | {
        action: 'cancel';
        /** Authentication request whose frozen daemon-side target is cancelled. */
        authenticationRequestId: string;
      }
    | {
        action: 'submit-code';
        /** Target login request for a one-time browser authorization code. */
        authenticationRequestId: string;
        /** One-time provider input; never log or copy it into durable Lody product state. */
        authorizationCode: string;
      }
    | {
        action: 'submit-input';
        /** Authentication request whose frozen daemon-side target owns the interaction. */
        authenticationRequestId: string;
        /** Target interaction when replying to a method picker, URL consent, or form. */
        interactionId: string;
        /** Ephemeral interaction payload. It is encrypted by remote Machine RPC. */
        authenticationInput: string;
      }
  );

export interface MachineAcpAuthenticateResponse {
  type: 'machine/acp-authenticate_response';
  machineId: MachineId;
  requestId: string;
  agentType: string;
  success: boolean;
  /**
   * `method-required` means the agent advertises several sign-in methods and
   * the user must pick one; the request is then repeated with `methodId`.
   */
  disposition:
    | 'authenticated'
    | 'cancelled'
    | 'not-running'
    | 'input-accepted'
    | 'method-required'
    | 'error';
  /** Present when a post-login capability refresh was requested. */
  capabilitiesRefreshed?: boolean;
  /** A successful login command can still leave the runtime requiring auth. */
  authRequired?: boolean;
  authMethods?: MachineAcpAuthMethodSummary[];
  error?: string;
}

export interface MachineAcpAuthenticationProgressMessage {
  type: 'machine/acp-authentication-progress';
  machineId: MachineId;
  requestId: string;
  agentType: string;
  status:
    | 'starting'
    | 'auth-methods'
    | 'authorization'
    | 'input-required'
    | 'output'
    | 'authenticated'
    | 'cancelled'
    | 'error';
  authMethods?: MachineAcpAuthMethodSummary[];
  /** Opaque id echoed by submit-input. */
  interactionId?: string;
  message?: string;
  form?: MachineAcpAuthenticationForm;
  authorizationUrl?: string;
  /** Device user code entered on the provider's authorization page. */
  userCode?: string;
  /** The provider may return a code that must be submitted back to the CLI. */
  acceptsAuthorizationCode?: boolean;
  /** Ephemeral target-machine key used only to encrypt the one-time browser code. */
  authorizationCodePublicKey?: RpcSecretPublicKey;
  /** Ephemeral target-machine key for generic authentication interaction input. */
  authenticationInputPublicKey?: RpcSecretPublicKey;
  /** URL-mode ACP elicitation requires an explicit user action before navigation. */
  requiresAuthorizationConsent?: boolean;
  expiresInSeconds?: number;
  stream?: 'stdout' | 'stderr';
  output?: string;
  error?: string;
}

/**
 * Check a registry binary or managed builtin runtime on the machine. The same
 * response also reports host incompatibility before a download starts.
 */
export interface MachineAcpBinaryStatusRequest {
  type: 'machine/acp-binary-status';
  machineId: MachineId;
  workspaceId: WorkspaceId;
  agentType: string;
}

export interface MachineAcpBinaryStatusResponse {
  type: 'machine/acp-binary-status_response';
  machineId: MachineId;
  agentType: string;
  success: boolean;
  status:
    | 'installed'
    | 'not-applicable'
    | 'not-installed'
    | 'unsupported-platform'
    | 'incompatible-host'
    | 'error';
  command?: string;
  platformArch?: string;
  installPath?: string;
  version?: string;
  current?: string;
  required?: string;
  error?: string;
}

/**
 * Install a registry binary or managed builtin runtime on the target machine.
 * Only a successful response unlocks the capability probe and save flow.
 */
export interface MachineAcpBinaryInstallRequest {
  type: 'machine/acp-binary-install';
  machineId: MachineId;
  workspaceId: WorkspaceId;
  agentType: string;
}

export interface MachineAcpBinaryInstallResponse {
  type: 'machine/acp-binary-install_response';
  machineId: MachineId;
  agentType: string;
  success: boolean;
  command?: string;
  installPath?: string;
  version?: string;
  error?: string;
}

export type MachineAcpBinaryProgressStatus =
  | 'checking'
  | 'not-installed'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'publishing'
  | 'installed'
  | 'unsupported-platform'
  | 'incompatible-host'
  | 'error';

export interface MachineAcpBinaryProgressMessage {
  type: 'machine/acp-binary-progress';
  machineId: MachineId;
  agentType: string;
  status: MachineAcpBinaryProgressStatus;
  downloadedBytes?: number;
  totalBytes?: number;
  percent?: number;
  platformArch?: string;
  version?: string;
  current?: string;
  required?: string;
  command?: string;
  error?: string;
}

/**
 * Ask the machine to upload its recent CLI logs (today + yesterday) together
 * with the user's bug description to the Lody backend. The machine responds
 * with the created bug-report id on success.
 */
export interface MachineBugReportRequest {
  type: 'machine/bug-report';
  machineId: MachineId;
  workspaceId: WorkspaceId;
  description: string;
  /**
   * Claimed requester id, used only for the CLI-side machine-access pre-check.
   * The authoritative reporter identity comes from `requestToken`, which the
   * backend verifies before accepting the upload.
   */
  reporterUserId: string;
  /** Signed requester proof minted by the backend for this workspace+machine. */
  requestToken: string;
}

export interface MachineBugReportResponse {
  type: 'machine/bug-report_response';
  machineId: MachineId;
  success: boolean;
  bugReportId?: string;
  error?: string;
}

/**
 * @deprecated Legacy compatibility only. Code Collab v1's session-scoped host
 * runtime has been removed; v2 file operations use machine RPC methods under
 * `code-collab/*`.
 */
export interface SessionCodeCollabHostStartRequest {
  type: 'session/code-collab-host-start';
  machineId: MachineId;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  requestedByUserId: string;
}

export type SessionCodeCollabHostStartStatus =
  | 'started'
  | 'already-running'
  | 'disabled'
  | 'failed'
  | 'stopped';

/**
 * @deprecated Legacy compatibility response for `session/code-collab-host-start`.
 * Current CLIs return `success: false` / `status: 'disabled'`.
 */
export interface SessionCodeCollabHostStartResponse {
  type: 'session/code-collab-host-start_response';
  sessionId: SessionId;
  success: boolean;
  status?: SessionCodeCollabHostStartStatus;
  error?: string;
  message?: string;
}

export interface SessionImageUploadRequest {
  type: 'session/image-upload';
  machineId: MachineId;
  sessionId: SessionId;
  workspaceId?: WorkspaceId;
  paths: string[];
}

export interface SessionImageUploadResponse {
  type: 'session/image-upload_response';
  sessionId: SessionId;
  workspaceId?: WorkspaceId;
  success: boolean;
  error?: string;
  message?: string;
  historyEntryId?: string;
  attachedTo?: 'active_turn' | 'new_entry';
  content?: SessionImageGroupContent;
  images?: Array<
    SessionImagePayload & {
      downloadUrl: string;
    }
  >;
}

export interface SessionFileUploadRequest {
  type: 'session/file-upload';
  machineId: MachineId;
  sessionId: SessionId;
  workspaceId?: WorkspaceId;
  paths: string[];
}

export interface SessionFileUploadResponse {
  type: 'session/file-upload_response';
  sessionId: SessionId;
  workspaceId?: WorkspaceId;
  success: boolean;
  error?: string;
  message?: string;
  historyEntryId?: string;
  attachedTo?: 'active_turn' | 'new_entry';
  /** The file blocks that were uploaded and appended to the session history. */
  files?: Array<
    SessionFilePayload & {
      downloadUrl: string;
    }
  >;
}

/**
 * Desktop local-transport file handoff (Electron -> local CLI).
 *
 * When the desktop app sends files to a session whose runtime is on the same
 * machine, it hands the bytes to the local CLI via local control. The CLI copies
 * each file into a local blob store and returns `file` blocks with
 * `transport: 'local'` + its own `machineId`. The composer then attaches those
 * blocks to the outgoing message (the CLI does NOT append history itself), and
 * the CLI backfills the bytes to the relay store in the background, flipping the
 * block to `transport: 'r2'` on success.
 *
 * Mirrors `SessionFileUploadRequest`; the only difference is the message type.
 */
export interface SessionFileSendLocalRequest {
  type: 'session/file-send-local';
  machineId: MachineId;
  sessionId: SessionId;
  workspaceId?: WorkspaceId;
  paths: string[];
}

export interface SessionFileSendLocalResponse {
  type: 'session/file-send-local_response';
  sessionId: SessionId;
  workspaceId?: WorkspaceId;
  success: boolean;
  error?: string;
  message?: string;
  /**
   * `file` blocks the local CLI stored for the caller, with `transport: 'local'`
   * and the runtime's `machineId`. No `downloadUrl` (bytes are not yet in the
   * relay store); the composer attaches these to the outgoing message.
   */
  files?: SessionFilePayload[];
}

// Local CLI control (Electron -> local CLI) message subsets
export type LocalSessionControlRequest =
  | SessionCreateRequest
  | SessionChatRequest
  | SessionCancelRequest
  | SessionSteerRequest
  | MachineStatusRequest
  | MachinePingRequest
  | MachineRestartRequest
  | MachineUpgradeRequest
  | MachineAcpCapabilitiesRefreshRequest
  | MachineAcpAuthenticateRequest
  | MachineAcpBinaryStatusRequest
  | MachineAcpBinaryInstallRequest
  | SessionCodeCollabHostStartRequest
  | SessionImageUploadRequest
  | SessionFileUploadRequest
  | SessionFileSendLocalRequest
  | PreviewCandidateReportRequest
  | SessionPreviewCreateRequest
  | SessionPreviewRevokeRequest;

export type LocalSessionControlResponse =
  | SessionCreateAck
  | SessionCreateResponse
  | SessionChatAck
  | SessionChatResponse
  | SessionCancelResponse
  | SessionSteerResponse
  | MachineStatusResponse
  | MachinePingResponse
  | MachineRestartResponse
  | MachineUpgradeResponse
  | MachineAcpCapabilitiesRefreshResponse
  | MachineAcpAuthenticateResponse
  | MachineAcpAuthenticationProgressMessage
  | MachineAcpBinaryStatusResponse
  | MachineAcpBinaryInstallResponse
  | MachineAcpBinaryProgressMessage
  | SessionCodeCollabHostStartResponse
  | SessionImageUploadResponse
  | SessionFileUploadResponse
  | SessionFileSendLocalResponse
  | PreviewCandidateReportResponse
  | SessionPreviewCreateResponse
  | SessionPreviewRevokeResponse;

export type LocalProjectFileListResult = {
  paths: string[];
  truncated: boolean;
};

export type LocalProjectFileReadResult = {
  path: string;
  /**
   * File contents. Interpretation depends on `encoding`:
   * - absent (the back-compatible default) or `'utf8'`: `content` is the
   *   UTF-8-decoded text of the file.
   * - `'base64'`: `content` is the base64-encoded raw bytes of a binary file
   *   (e.g. an image). JSON/Streams transport cannot carry raw bytes, so binary
   *   reads are base64-encoded.
   *
   * IMPORTANT (forward/backward compat): producers MUST omit `encoding` for
   * text reads and only set it to `'base64'`. Older clients validate this
   * payload with a `.strict()` schema that rejects unknown keys, so a newer CLI
   * that emitted `encoding: 'utf8'` on text reads would break every text read
   * for an older bundle under version skew. Omitting it keeps the text wire
   * format identical to the legacy format.
   */
  content: string;
  truncated: boolean;
  encoding?: 'utf8' | 'base64';
};

export type LocalProjectDirectoryEntry = {
  name: string;
  type: 'file' | 'directory';
};

export type LocalProjectDirectoryListResult = {
  entries: LocalProjectDirectoryEntry[];
  truncated: boolean;
};

export type LocalProjectBrowseRootsResult = {
  platform: 'darwin' | 'linux' | 'win32';
  pathSeparator: '/' | '\\';
  homeDir: string;
  drives?: string[];
};

export type LocalProjectBrowseDirectoryEntry = {
  name: string;
  absolutePath: string;
  isSymlink: boolean;
  hidden: boolean;
  hints?: {
    git?: boolean;
  };
  registeredProjectId?: LocalProjectId;
  error?: 'unreadable';
};

export type LocalProjectBrowseDirectoryResult = {
  path: string;
  parentPath: string | null;
  entries: LocalProjectBrowseDirectoryEntry[];
  truncated: boolean;
  nextCursor?: string;
};

export type LocalProjectCheckoutBranchResult =
  | { success: true; currentBranch: string }
  | { success: false; error: string };

export type LocalProjectHistorySyncSummary = {
  listed: number;
  imported: number;
  refreshed: number;
  skipped: number;
  conflicted: number;
  failed: number;
  failures: Array<{
    acpSessionId: string;
    message: string;
  }>;
};

export type LocalProjectHistoryCatalogResult = {
  listed: number;
  lastListedAt: number;
  sessions: LocalProjectHistoryCatalogItem[];
};

export type LocalProjectHistoryImportResult = {
  summary: LocalProjectHistorySyncSummary;
  catalog: LocalProjectHistoryCatalogResult;
};

export type LocalProjectHistoryConflictResolveResult = {
  sessionId: SessionId;
  acpSessionId: string;
  status: 'resolved';
  catalog: LocalProjectHistoryCatalogResult;
};

export type LocalProjectSummary = {
  localProjectId: LocalProjectId;
  name: string;
  rootPath: string;
};

export type LocalProjectWorkspaceSummary = {
  workspaceId: WorkspaceId;
  workspaceName: string;
  projects: LocalProjectSummary[];
};

export type LocalProjectWorktreeCleanupItem = {
  sessionId: SessionId;
  title: string;
  path: string;
};

export type LocalProjectWorktreeCleanupPreflightResult = {
  clean: LocalProjectWorktreeCleanupItem[];
  dirty: LocalProjectWorktreeCleanupItem[];
  failed: Array<LocalProjectWorktreeCleanupItem & { message: string }>;
};

export type LocalProjectWorktreeCleanupResult = {
  completedAt: number;
  deleted: LocalProjectWorktreeCleanupItem[];
  skippedDirty: LocalProjectWorktreeCleanupItem[];
  failed: Array<LocalProjectWorktreeCleanupItem & { message: string }>;
};

export type LocalProjectControlRequest =
  | {
      type: 'local-project/add';
      machineId: MachineId;
      rootPath: string;
      workspace?: string;
      allWorkspaces?: boolean;
    }
  | {
      type: 'local-project/prepare-add';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      rootPath: string;
    }
  | {
      type: 'local-project/list-roots';
      machineId: MachineId;
    }
  | {
      type: 'local-project/browse-dir';
      machineId: MachineId;
      workspaceId?: WorkspaceId;
      absolutePath?: string;
      showHidden?: boolean;
      limit?: number;
      cursor?: string;
    }
  | {
      type: 'local-project/delete';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
    }
  | {
      type: 'local-project/removal-preflight';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
      requestedByUserId?: string;
    }
  | {
      type: 'local-project/list';
      machineId: MachineId;
    }
  | {
      type: 'local-project/git-state';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
    }
  | {
      type: 'local-project/list-files';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
      maxFiles?: number;
      requestedByUserId?: string;
    }
  | {
      type: 'local-project/list-dir';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
      relativePath: string;
      limit?: number;
      requestedByUserId?: string;
    }
  | {
      type: 'local-project/list-skills';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
      skillDirs: string[];
      requestedByUserId?: string;
    }
  | {
      type: 'local-project/list-global-skills';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      requestedByUserId?: string;
    }
  | {
      type: 'local-project/read-file';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
      relativePath: string;
      maxBytes?: number;
      requestedByUserId?: string;
    }
  | {
      type: 'local-project/checkout-branch';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
      branchName: string;
    }
  | {
      type: 'local-project/get-worktree-setup';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
      requestedByUserId?: string;
    }
  | {
      type: 'local-project/set-worktree-setup';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
      config: WorktreeSetupScriptConfig;
      requestedByUserId?: string;
    }
  | {
      type: 'local-project/get-worktree-cleanup';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
      requestedByUserId?: string;
    }
  | {
      type: 'local-project/set-worktree-cleanup';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
      config: WorktreeCleanupScriptConfig;
      requestedByUserId?: string;
    }
  | {
      type: 'local-project/sync-history';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
      provider: LocalProjectHistoryProvider;
      requestedByUserId?: string;
    }
  | {
      type: 'local-project/import-history';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
      provider: LocalProjectHistoryProvider;
      acpSessionIds: string[];
      requestedByUserId?: string;
    }
  | {
      type: 'local-project/resolve-history-conflict';
      machineId: MachineId;
      workspaceId: WorkspaceId;
      localProjectId: LocalProjectId;
      provider: LocalProjectHistoryProvider;
      sessionId: SessionId;
      acpSessionId: string;
      requestedByUserId?: string;
    }
  | {
      type: 'worktree/list-files';
      machineId: MachineId;
      repoFullName: string;
      sessionId: SessionId;
      maxFiles?: number;
    }
  | {
      type: 'worktree/read-file';
      machineId: MachineId;
      repoFullName: string;
      sessionId: SessionId;
      relativePath: string;
      maxBytes?: number;
    };

export type LocalProjectControlErrorCode =
  | 'invalid_request'
  | 'machine_mismatch'
  | 'workspace_required'
  | 'workspace_not_found'
  | 'daemon_unavailable'
  | 'access_denied'
  | 'local_project_not_found'
  | 'path_invalid'
  | 'execution_failed'
  | 'invalid_response';

type LocalProjectControlErrorResponse = {
  ok: false;
  type: LocalProjectControlRequest['type'];
  error: LocalProjectControlErrorCode;
  message: string;
  data?: unknown;
};

type LocalProjectControlOkResponse<TType extends LocalProjectControlRequest['type'], TResult> = {
  ok: true;
  type: TType;
  result: TResult;
};

export type LocalProjectControlResponse =
  | LocalProjectControlOkResponse<
      'local-project/add',
      {
        localProjectId: LocalProjectId;
        name: string;
        rootPath: string;
        workspaceIds: WorkspaceId[];
      }
    >
  | LocalProjectControlOkResponse<
      'local-project/prepare-add',
      {
        localProjectId: LocalProjectId;
        name: string;
        rootPath: string;
        alreadyRegistered: boolean;
      }
    >
  | LocalProjectControlOkResponse<'local-project/list-roots', LocalProjectBrowseRootsResult>
  | LocalProjectControlOkResponse<'local-project/browse-dir', LocalProjectBrowseDirectoryResult>
  | LocalProjectControlOkResponse<
      'local-project/delete',
      {
        localProjectId: LocalProjectId;
        name: string;
        rootPath: string;
        workspaceIds: WorkspaceId[];
      }
    >
  | LocalProjectControlOkResponse<
      'local-project/removal-preflight',
      LocalProjectWorktreeCleanupPreflightResult
    >
  | LocalProjectControlOkResponse<
      'local-project/list',
      { workspaces: LocalProjectWorkspaceSummary[] }
    >
  | LocalProjectControlOkResponse<'local-project/git-state', LocalProjectGitState>
  | LocalProjectControlOkResponse<'local-project/list-files', LocalProjectFileListResult>
  | LocalProjectControlOkResponse<'local-project/list-dir', LocalProjectDirectoryListResult>
  | LocalProjectControlOkResponse<'local-project/list-skills', ProjectSkillsResult>
  | LocalProjectControlOkResponse<'local-project/list-global-skills', ProjectSkillsResult>
  | LocalProjectControlOkResponse<'local-project/read-file', LocalProjectFileReadResult | null>
  | LocalProjectControlOkResponse<'local-project/checkout-branch', LocalProjectCheckoutBranchResult>
  | LocalProjectControlOkResponse<
      'local-project/get-worktree-setup',
      WorktreeSetupScriptConfig | null
    >
  | LocalProjectControlOkResponse<'local-project/set-worktree-setup', WorktreeSetupScriptConfig>
  | LocalProjectControlOkResponse<
      'local-project/get-worktree-cleanup',
      WorktreeCleanupScriptConfig | null
    >
  | LocalProjectControlOkResponse<'local-project/set-worktree-cleanup', WorktreeCleanupScriptConfig>
  | LocalProjectControlOkResponse<'local-project/sync-history', LocalProjectHistoryCatalogResult>
  | LocalProjectControlOkResponse<'local-project/import-history', LocalProjectHistoryImportResult>
  | LocalProjectControlOkResponse<
      'local-project/resolve-history-conflict',
      LocalProjectHistoryConflictResolveResult
    >
  | LocalProjectControlOkResponse<'worktree/list-files', LocalProjectFileListResult>
  | LocalProjectControlOkResponse<'worktree/read-file', LocalProjectFileReadResult | null>
  | LocalProjectControlErrorResponse;

// ============================================
// MESSAGE TYPE UNIONS
// ============================================

// Client to Server Messages
export type ClientToServer =
  | SessionCreateRequest
  | SessionChatRequest
  | SessionCancelRequest
  | PermissionResponseMessage
  | MachineStatusRequest
  | MachinePingRequest
  | MachineRestartRequest
  | MachineUpgradeRequest
  | MachineAcpCapabilitiesRefreshRequest
  | MachineAcpAuthenticateRequest
  | MachineAcpBinaryStatusRequest
  | MachineAcpBinaryInstallRequest;

// Server to Client Messages
export type ServerToClient =
  | SessionCreateResponse
  | SessionCreateAck
  | SessionChatResponse
  | SessionChatAck
  | SessionCancelResponse
  | PermissionRequestMessage
  | MachineStatusResponse
  | MachinePingResponse
  | MachineRestartResponse
  | MachineUpgradeResponse
  | MachineAcpCapabilitiesRefreshResponse
  | MachineAcpAuthenticateResponse
  | MachineAcpAuthenticationProgressMessage
  | MachineAcpBinaryStatusResponse
  | MachineAcpBinaryInstallResponse
  | MachineAcpBinaryProgressMessage;

// Machine to Server Messages
export type MachineToServer =
  | PermissionRequestMessage
  | SessionCreateResponse
  | SessionCancelResponse
  | SessionChatResponse
  | MachineStatusResponse
  | MachinePingResponse
  | MachineRestartResponse
  | MachineUpgradeResponse
  | MachineAcpCapabilitiesRefreshResponse
  | MachineAcpAuthenticateResponse
  | MachineAcpAuthenticationProgressMessage
  | MachineAcpBinaryStatusResponse
  | MachineAcpBinaryInstallResponse
  | MachineAcpBinaryProgressMessage;

// Server to Machine Messages
export type ServerToMachine =
  | SessionCreateRequest
  | SessionChatRequest
  | SessionCancelRequest
  | PermissionResponseMessage
  | MachineStatusRequest
  | MachinePingRequest
  | MachineRestartRequest
  | MachineUpgradeRequest
  | MachineAcpCapabilitiesRefreshRequest
  | MachineAcpAuthenticateRequest
  | MachineAcpBinaryStatusRequest
  | MachineAcpBinaryInstallRequest;

// Combined message types
export type ServerReceiveMessage = ClientToServer | MachineToServer;
export type ServerSendMessage = ServerToClient | ServerToMachine;

// WebSocket message type for general use
export type WebSocketMessage = ServerReceiveMessage | ServerSendMessage;
