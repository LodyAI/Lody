import type {
  E2eeWorkspaceHistoryRequest,
  E2eeWorkspaceHistoryPage,
  E2eeContentTokenRequest,
  E2eeContentToken,
  E2eeMailboxRequests,
  E2eeMailboxReplies,
} from '@lody/cloud-api';
import type { NotificationPresentation } from '@lody/shared/notifications';
import type { Effect, Scope } from 'effect';
export type { LoroStreamsTokenProvider } from '@lody/shared';
import type { TerminalOutcome } from '@lody/shared/notifications';
import type {
  BugReportClientLog,
  LiveActivityConversationItem,
  LiveActivityPermissionAlert,
  LiveActivityStatusCounts,
  MachineBugReportResponse,
  PermissionRequestKind,
  SessionPullRequestMeta,
  BillingPlanTier,
  MachineId,
  SessionId,
  WorkspaceId,
  createLoroStreamsTokenProviderLegacy,
  LoroStreamsTokenProvider,
} from '@lody/shared';
import type { PlatformKind, WorkspaceSummary } from './provider';
import type {
  SessionShareRequestInput,
  SessionShareRequestResult,
} from '@lody/shared/session-sharing';

export interface CloudSessionSharingPort {
  request(input: SessionShareRequestInput): Promise<SessionShareRequestResult>;
  getResult(
    input: Pick<
      SessionShareRequestInput,
      'workspaceId' | 'sourceSessionId' | 'requesterUserId' | 'deliveryPublicKey'
    > & { shareRequestId: string }
  ): Promise<SessionShareRequestResult>;
}

/**
 * CloudPort is the CLI-side seam: every cloud service the daemon talks to is
 * reached through this object, assembled once at process startup. The local
 * (open-source) implementation carries `null` for every optional port — which
 * is the contract itself: a `null` port means the feature does not exist, so
 * an explicitly requested unavailable feature must reject at its public
 * boundary. Background best-effort work may skip only where its contract says
 * so. Call sites must never construct cloud clients or probe reachability to
 * invent a fallback.
 */
/** Device-scoped cloud transport; local opens and custody stay with its host. */
export interface CloudE2eePort {
  completeMachinePairing?(input: {
    workspaceId: string;
    credential: string;
    pairingSessionId: string;
  }): Promise<void>;
  /** CLI-only native kernel assembled by its optional cloud composition. */
  createContentTokenProvider?(input: {
    workspaceId: string;
    credential: string;
  }): Effect.Effect<
    LoroStreamsTokenProvider & { getBucketId(): string | undefined },
    never,
    Scope.Scope
  >;

  getHistory(
    input: Omit<E2eeWorkspaceHistoryRequest, 'cliToken'> & { credential: string }
  ): Promise<E2eeWorkspaceHistoryPage>;
  getContentToken(input: Omit<E2eeContentTokenRequest, 'cliToken'>): Promise<E2eeContentToken>;
  /** Untrusted current publication originals; the native host verifies ledger binding and HPKE. */
  readEpochGroup?(
    input: Omit<import('@lody/cloud-api').ReadEpochGroupRequest, 'cliToken'>
  ): Promise<import('@lody/cloud-api').EpochStagedGroupDto | null>;
  mailboxCall<K extends keyof E2eeMailboxRequests>(
    method: K,
    input: Omit<E2eeMailboxRequests[K], 'cliToken'>
  ): Promise<E2eeMailboxReplies[K]>;
}
export interface CloudPort {
  /** Absent in ordinary/local composition; does not own local key material. */
  e2ee?: CloudE2eePort | null;
  /** Explicit one-workspace machine service composition; never permits a legacy bridge. */
  readonly e2eeMachineScope?: { workspaceId: string; genesisHash: string };
  readonly kind: PlatformKind;
  /** The identity every durable write is authored under. */
  identity: CloudPortIdentity;
  access: CloudAccessPort;
  /** `null` ⇒ the data plane never attaches a cloud (Streams) transport. */
  streamsTokens: CloudStreamsTokenPort | null;
  /** `null` ⇒ no push notifications / live activity. */
  notifications: CloudNotificationsPort | null;
  /** `null` ⇒ no usage reporting. */
  usage: CloudUsagePort | null;
  /** `null` ⇒ no billing checks; session creation is always allowed. */
  billing: CloudBillingPort | null;
  /** `null` ⇒ no brokered GitHub tokens; git uses the host's own credentials. */
  githubTokens: CloudGithubTokenPort | null;
  /** `null` ⇒ no in-app bug report upload. */
  bugReports: CloudBugReportPort | null;
  /** Proposals only. Human approval and publication have no daemon port. */
  sessionSharing: CloudSessionSharingPort | null;
  /** `null` ⇒ no PR association / status reconciliation. */
  prAssociation: CloudPrAssociationPort | null;
  /**
   * `null` ⇒ attachment blobs stay in the local blob store forever (no R2
   * backfill) and blob URLs are served locally.
   */
  attachmentUpload: CloudAttachmentUploadPort | null;
  /** `null` ⇒ remote preview tunnels do not exist; only the local proxy is available. */
  remotePreview: CloudRemotePreviewPort | null;
  runtimeArtifacts: RuntimeArtifactsPort;
  /** Releases process-wide clients/timers owned by the platform assembly. */
  dispose(): Promise<void>;
}

export interface CloudPortIdentity {
  userId: string;
  email?: string;
  name?: string | null;
}

export interface MachineAccessRequest {
  workspaceId: WorkspaceId;
  requesterUserId: string;
  machineId?: MachineId;
  localProjectId?: string;
}

export interface MachineAccessRegistration {
  workspaceId: WorkspaceId;
  machineId: MachineId;
}

export interface CloudWorkspaceUserProfile {
  id: string;
  name?: string;
  email?: string;
  githubLogin?: string;
  githubAccountId?: string;
}

export type MachineAccessDenyReason =
  | 'requester_not_member'
  | 'machine_not_registered'
  | 'not_visible'
  | 'project_not_shared';

export type MachineAccessVerdict =
  | { allowed: true }
  | { allowed: false; reason: MachineAccessDenyReason };

export type CloudAccessSnapshot =
  | {
      status: 'authorized';
      userId: string;
      workspaces: readonly WorkspaceSummary[];
    }
  | { status: 'unauthorized'; reason: string };

/**
 * The authorization oracle. Local guarantees: the snapshot comes from the
 * local catalog, the owner is always allowed, and no network I/O happens.
 */
export interface CloudAccessPort {
  /**
   * Emits the current workspace set immediately and on every change.
   */
  watchWorkspaceAccess(
    listener: (snapshot: CloudAccessSnapshot) => void,
    onError: (error: unknown) => void
  ): () => void;
  verifyMachineAccess(request: MachineAccessRequest): Promise<MachineAccessVerdict>;
  registerMachineAccess(request: MachineAccessRegistration): Promise<void>;
  resolveWorkspaceUser(request: {
    workspaceId: WorkspaceId;
    userId: string;
  }): Promise<CloudWorkspaceUserProfile | null>;
}

export type LoroStreamsTokenProviderLegacy = ReturnType<
  typeof createLoroStreamsTokenProviderLegacy
>;

export interface CloudStreamsTokenPort {
  createTokenProvider(options: {
    workspaceId: WorkspaceId;
  }): Effect.Effect<LoroStreamsTokenProvider, never, Scope.Scope>;
  /** @deprecated Promise consumers retain the visible Legacy entry until their owners migrate. */
  createTokenProviderLegacy(options: { workspaceId: WorkspaceId }): LoroStreamsTokenProviderLegacy;
}

export interface CloudPermissionRequestNotificationInput {
  sessionId: SessionId;
  sessionTitle?: string | null;
  workspaceId: WorkspaceId;
  workspaceSlug: string;
  userId: string;
  requestId: string;
  toolCallId: string;
  toolTitle?: string | null;
  toolKind?: string | null;
  requestKind?: PermissionRequestKind;
  presentation?: NotificationPresentation;
}

export interface CloudPermissionRequestResolutionInput {
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  userId: string;
  requestId: string;
  toolCallId: string;
}

export interface CloudNotificationsPort {
  notifySessionCompleted(input: {
    sessionId: SessionId;
    occurrenceId: string;
    outcome?: TerminalOutcome;
    presentation?: NotificationPresentation;
    sessionTitle?: string | null;
    pullRequests?: readonly SessionPullRequestMeta[];
    workspaceId: WorkspaceId;
    workspaceSlug: string;
    userId: string;
  }): Promise<void>;
  notifyPermissionRequested(input: CloudPermissionRequestNotificationInput): Promise<void>;
  recordPermissionRequested(input: CloudPermissionRequestNotificationInput): Promise<void>;
  resolvePermissionRequested(input: CloudPermissionRequestResolutionInput): Promise<void>;
  syncLiveActivitySummary(input: {
    activityId: string;
    workspaceId: WorkspaceId;
    userId: string;
    totalCount: number;
    statusCounts: LiveActivityStatusCounts;
    items: readonly LiveActivityConversationItem[];
    updatedAt: number;
    permissionAlert?: LiveActivityPermissionAlert;
  }): Promise<{ sent: true; ended: boolean } | { sent: false; reason?: string }>;
}

export interface CloudUsageUpdateInput {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  /** Accounting scope; may be a native session ID or a provider turn key. */
  acpSessionId: string;
  userId: string;
  machineId: MachineId;
  cliType: string;
  update: unknown;
}

export interface CloudUsagePort {
  recordSessionUsageUpdate(input: CloudUsageUpdateInput): void;
  flushSessionUsage(sessionId: string): Promise<void>;
}

export interface CloudPrAssociationInput {
  repoFullName: string;
  prNumber: number;
  prUrl: string;
  branch: string;
  status: string;
  ownerSessionId: SessionId;
  workspaceId: WorkspaceId;
}

export interface CloudPrAssociationPort {
  associatePullRequest(input: CloudPrAssociationInput): Promise<boolean>;
}

export interface CloudBugReportInput {
  workspaceId: WorkspaceId;
  machineId: MachineId;
  description: string;
  reporterUserId: string;
  requestToken: string;
  machineUserId: string;
  /** The reporter's client log, already validated against its schema. */
  clientLog?: BugReportClientLog;
}

export interface CloudBugReportPort {
  submit(report: CloudBugReportInput): Promise<MachineBugReportResponse>;
}

export interface CloudAttachmentUploadPort {
  /** Base URL of the blob upload service; URL construction stays with the callers. */
  serverBaseUrl: string;
}

export interface CloudRemotePreviewPort {
  /** Short-lived ICE credentials; null/absent providers never trigger cloud I/O. */
  simulatorIceServers?(input: MachineAccessRequest): Promise<{
    iceServers: Array<{ urls: string[]; username?: string; credential?: string }>;
    expiresAt: number;
  }>;
  verifyControl(
    input: import('@lody/shared').VerifyPreviewControlInput
  ): Promise<{ requesterUserId: string; expiresAt: number }>;
}

export interface RuntimeArtifactsPort {
  /**
   * Explicit base URL for managed agent runtime downloads. `null` means the
   * operator has not configured a distribution channel; an install request
   * must then fail before attempting network I/O.
   */
  baseUrl: string | null;
}

export interface CloudBillingEntitlement {
  effectivePlanTier: BillingPlanTier;
  checkoutPending: boolean;
}

export interface CloudBillingPort {
  /** Cooperative quotas fail open on errors; opt-in paid transfers require a positive entitlement. */
  getWorkspaceEntitlement(workspaceId: string): Promise<CloudBillingEntitlement>;
}

export interface CloudGithubWriteTokenContext {
  requesterUserId: string;
  machineId: string;
}

export interface CloudGithubTokenManager {
  getCredentialPolicy(context: CloudGithubWriteTokenContext): Promise<{ personalEnabled: boolean }>;
  getCredentialCandidate(
    repoFullName: string,
    context: CloudGithubWriteTokenContext,
    source: 'personal' | 'app',
    invalidatedPersonalToken?: string
  ): Promise<
    { token: string; tokenSource: 'personal' | 'app' } | { available: false; reason: string } | null
  >;
  startAutoRefresh(): void;
  getAppTokenForRepo(repoFullName: string): Promise<string>;
  getWriteTokenForRepo(
    repoFullName: string,
    context: CloudGithubWriteTokenContext
  ): Promise<string>;
  getAppTokenInfoForRepo(
    repoFullName: string
  ): Promise<{ token: string; tokenSource: 'personal' | 'app'; rateLimitScope?: string }>;
  getWriteTokenInfoForRepo(
    repoFullName: string,
    context: CloudGithubWriteTokenContext
  ): Promise<{ token: string; tokenSource: 'personal' | 'app'; rateLimitScope?: string }>;
  retainRepoOwner(repoFullName: string): void;
  invalidate(
    repoFullName: string,
    context?: {
      requesterUserId?: string;
      invalidatedToken?: string;
      markPersonalTokenInvalid?: boolean;
    }
  ): void;
  invalidateAll(): void;
  shutdown(): Promise<void>;
}

export interface CloudGithubTokenPort {
  createTokenManager(workspaceId: string): CloudGithubTokenManager;
}
