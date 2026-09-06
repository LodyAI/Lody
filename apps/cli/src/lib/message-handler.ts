import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';

import { v4 as uuidV4 } from 'uuid';
import { z } from 'zod';
import { Effect } from 'effect';
import {
  createLoroStreamsJsonStreamClient,
  LoroStreamsMachineRpcServer,
  LORO_STREAMS_RPC_RETENTION_SECONDS,
  LORO_STREAMS_RPC_VERSION,
  type LocalProjectGitStateRpcResponse,
} from '@lody/loro-streams-rpc';
import {
  MachineId,
  WorkspaceId,
  SessionInputBlockSchema,
  SessionId,
  SessionImageUploadRequestValidated,
  SessionImageUploadResponse,
  SessionFileUploadRequestValidated,
  SessionFileUploadResponse,
  SessionFileSendLocalRequestValidated,
  SessionFileSendLocalResponse,
  type SessionFilePayload,
  type LocalSessionControlRequestValidated,
  SessionCreateRequestValidated,
  SessionChatRequestValidated,
  SessionCancelRequestValidated,
  CliType,
  AgentConfigCliType,
  type AgentConfigId,
  type AgentWarningMeta,
  type BuiltinRuntimeOverrides,
  type CustomAcpLaunchSpec,
  type TitleGenerationConfig,
  isManagedBuiltinAgentType,
  sanitizeLodyInternalInstructions,
  usesAcpProvidedSessionTitle,
  SessionCreateResponse,
  SessionChatResponse,
  SessionStatusFactory,
  type MachineLegacyMetaFields,
  type MachineMeta,
  type MachineResourceInfo,
  SessionMeta,
  LocalProjectId,
  type NeedToDeleteSessionQueueItem,
  getMachineRoomId,
  getSessionRoomId,
  type IssuePRMention,
  type SessionImageGroupContent,
  type SessionInputBlock,
  formatCommentReferenceForPrompt,
  formatVisualAnnotationReferenceForPrompt,
  ACPSessionId,
  getCodeCollabFileIndexSignalFlockDocId,
  type SessionContextWindowUsage,
  type SessionHistoryInput,
  type SessionLegacyMetaFields,
  PERMISSION_REQUEST_TIMEOUT_MS,
  type ChatFailedCode,
  type ChatFailedReason,
  type ProjectRef,
  type SessionPreparationCancelSpec,
  resolveBaseBranchPreference,
  MachineStatusRequestValidated,
  MachinePingRequestValidated,
  MachineRestartRequestValidated,
  MachineRestartResponse,
  MachineUpgradeRequestValidated,
  MachineUpgradeResponse,
  MachineAcpCapabilitiesRefreshRequestValidated,
  MachineAcpCapabilitiesRefreshResponse,
  type MachineAcpAuthenticateRequestValidated,
  type MachineAcpAuthenticateResponse,
  SessionCodeCollabHostStartRequestValidated,
  SessionCodeCollabHostStartResponse,
  type MachineAcpBinaryStatusRequestValidated,
  type MachineAcpBinaryInstallRequestValidated,
  type LocalProjectControlErrorCode,
  type LocalProjectControlRequest,
  type LocalProjectControlResponse,
  type LocalMachineRpcRequestValidated,
  type LocalMachineRpcResponse,
  type LocalMachineRpcResult,
  type SessionTerminateResponse,
  type SessionForkResponse,
  type SessionForkSpec,
  sessionForkFailure,
  type SessionEditAndResendResponse,
  sessionEditAndResendFailure,
  type SessionPreparationSpec,
  type SessionPrepareCancelResponse,
  type SessionPrepareResponse,
  type MachineLifecycleCapability,
  PreviewCandidateReportRequestValidated,
  SessionPreviewCreateRequestValidated,
  SessionPreviewRevokeRequestValidated,
  type SessionStatus,
  buildSessionImageApiUrl,
  getSessionImageDownloadApiPath,
  getSessionImageUploadApiPath,
  buildSessionFileApiUrl,
  buildSessionFileUploadMetadataHeaders,
  getSessionFileDownloadApiPath,
  getSessionFileUploadApiPath,
  getSessionFileMultipartCreateApiPath,
  getSessionFileMultipartPartApiPath,
  getSessionFileMultipartCompleteApiPath,
  getSessionFilePartCount,
  shouldUseSingleShotUpload,
  isTextPreviewable,
  inputBlocksToHistoryItems,
  SESSION_FILE_MAX_COUNT,
  SESSION_FILE_MAX_SIZE_BYTES,
  SESSION_FILE_PART_SIZE_BYTES,
  SESSION_FILE_PREVIEW_SNIFF_BYTES,
  type AcpConfigOptionSummary,
  SESSION_IMAGE_ALLOWED_MIME_TYPES,
  SESSION_IMAGE_MAX_COUNT,
  SESSION_IMAGE_MAX_SIZE_BYTES,
  isAskUserQuestionPermissionRequest,
  getAskUserQuestionPermissionDisplayTitle,
  parseAskUserQuestionPermissionMeta,
  isLoroRepoDocDeleted,
  LORO_STREAMS_BUCKET_ID,
  type MessageContent,
  type AcpSessionNotification,
  getServerNow,
  CODE_COLLAB_V2_TEXT_LIMITS,
  isSessionGoalActive,
  resolveLatestSessionGoalFromHistory,
  resolveProjectGitHubRepo,
  type RepoId,
  deleteMachineFlockRowFromFlock,
  getMachineFlockDeleteLocalProjectEntries,
  getMachineFlockDocId,
  getMachineFlockLocalProjects,
  machineFlockKeys,
  machineDeleteCommandToQueueItem,
  parseMachineFlockKey,
  readMachineFlockRowsFromFlock,
  serializeMachineFlockKey,
  writeMachineFlockRowToFlock,
  type MachineDeleteLocalProjectCommand,
  type MachineDeleteSessionCommand,
  type MachineFlockEvent,
  type MachineFlockKey,
  type MachineFlockRow,
  type MachineFlockRowMap,
  buildLiveActivityConversationItems,
  countLiveActivityConversationCandidates,
  countLiveActivityConversationStatuses,
  findLiveActivityPermissionAlertCandidate,
  buildLodyConversationsLiveActivityId,
  LODY_CONVERSATIONS_LIVE_ACTIVITY_SCHEMA_VERSION,
  type LiveActivityConversationItem,
  type LiveActivityPermissionAlert,
  type LiveActivityStatusCounts,
  getCodeCollabFileIndexFlockDocId,
  shouldBypassSessionQuota,
  normalizeSessionTurnInputConfig,
  hasAgentRunConfigSelection,
  buildMissingEmail,
  type AgentRunConfigSelection,
  type LodyOperationItemResult,
  type StoredLodyOperation,
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  hasPendingUserTurnActivation,
} from '@lody/shared';
import { ISession, SessionManager } from '../session/session-manager';
import { captureCli } from '@/lib/analytics/posthog';
import { LoroDocumentManager, SessionDocument } from './loro/doc';
import {
  type ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import {
  publishCodeCollabFileIndexFlock,
  publishCodeCollabFileIndexSignalFlock,
} from './code-collab/code-collab-flock-publish';
import type { ModelInfo } from '@lody/shared';
import type {
  CloudNotificationsPort,
  CloudPort,
  CloudUsagePort,
  LoroStreamsTokenProvider,
} from '@lody/platform';
import { Logger } from '@/utils/logger';
import { ProviderSetupManager } from './provider-setup-manager';
import { MachineFlockCommandWatcher } from './loro/machine-flock-command-watcher';
import {
  EXIT_CODE_REMOTE_RESTART,
  EXIT_CODE_REMOTE_UPGRADE,
  type MachineProcessLifecycleAction,
  normalizeMachineUpgradeTargetVersion,
  verifyMachineLifecycleRequest,
  writeDaemonUpgradeIntent,
} from './machine-lifecycle';
import { formatErrorMessage } from '@/utils/format-error';
import { startTraceSpan, traceAsync } from '@/utils/trace-span';
import { getCliHttpFetch } from '@/utils/http-transport';
import { prepareCliStreamsGatewayBaseUrl } from './loro/streams-access';
import { readTimeoutEnv, withTimeout } from './loro/timeout-utils';
import {
  copyIntoSessionFileBlobStore,
  getDraftSessionFileBlobMaxAgeMs,
  getSessionFileBlobAgeMs,
  getSessionFileBlobPath,
  listPendingLocalSessionFiles,
  markSessionFileBlobBackfilled,
  readSessionFileBlobBackfillMarker,
  removeSessionFileBlob,
  sessionFileBlobExists,
  writeSessionFileBlobBackfillMarker,
} from '@/lib/session-file-blob-store';
import {
  SESSION_FILE_BACKFILL_MAX_ATTEMPTS,
  flipFileTransportToR2,
  sessionFileBackfillDelayMs,
} from '@/lib/session-file-backfill';
import {
  ATTACHMENTS_DIR_RELATIVE,
  buildAttachmentFileName,
  buildAttachmentPromptText,
  buildUnavailableAttachmentPromptText,
  ensureAttachmentsGitExcluded,
  resolveContainedUploadPath,
} from '@/lib/session-file-attachments';
import { deriveRepoIdFromGitHubRepo } from '@/utils/github';
import { getLocalProjectGitStateAtRootPath } from '@lody/shared/node/local-project';
import { deriveRepoIdFromLocalProjectPath } from '@lody/shared/node/worktree-paths';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  type LiveActivitySummarySyncResult,
  type PermissionRequestNotificationInput,
} from '@/lib/notifications';
import {
  appendACPNotificationsToAssistantEntry,
  applyMessageContentsBatch,
  ensurePermissionRequestOnToolCall,
  updatePermissionOutcomeInHistory,
  findPermissionOutcomeInHistory,
  upsertThreadGoalInHistory,
  clearThreadGoalFromHistory,
} from '@/lib/acp/history';
import type { AcpAgentEditEvidence, AcpStandardDiffBlockEvidence } from '@/lib/acp/history';
import { mergeAcpRuntimeConfigUpdates } from '@/lib/acp/runtime-config';
import { generateTitleIsolated, sanitizeTitle } from '@/agent/title-generator';
import type { AgentSessionWarning } from '@/agent/agent-client';
import { ensureValidBranchName } from '@/agent/branch-name-generator';
import {
  SessionActivePresenceController,
  type SessionActivePresencePhase,
} from './loro/session-active-presence';
import {
  resolveImageGenerationStatusWrite,
  shouldRestoreRunningAfterPermission,
} from './session-activity-status';
import { markAssistantTurnFinished } from './assistant-turn-finalize';
import type { RepoWatchHandle } from 'loro-repo';
import { resolveGitBranchName } from './git/resolve-git-branch-name';
import {
  AgentClient,
  type AcpWriteTextFileEvidence,
  type ImageGenerationBeginEvent,
  type ImageGenerationEndEvent,
} from 'src/agent/agent-client';
import type { RateLimit, SessionUsageUpdate } from 'acp-extension-core';
import { getWorktreeManager } from '@/session/worktree/worktree-manager';
import {
  isManagedWorktreeBranchName,
  renameBranchWithAvailableSuffix,
} from '@/session/worktree/branch-name-allocation';
import { createWorktreeScriptHistoryRecorder } from '@/session/worktree/worktree-script-history';
import { runWorktreeCleanup } from '@/session/worktree/worktree-setup-runner';
import {
  SessionTransientStore,
  type ACPUpdateTarget,
  type BufferedACPUpdate,
} from '@/lib/session-transient-store';
import { fetchAcpCapabilities, type FetchAcpCapabilitiesOptions } from '@/agent/acp-capabilities';
import type { WorkspaceWatchCoordinatorApi } from './code-collab/workspace-watch-coordinator';
import { appendIssuePrMentionsToPrompt } from '@/session/session-execution-helpers';
import {
  SessionExecutionService,
  type SessionDispatchSource,
} from '@/session/session-execution-service';
import { TurnHistoryGate } from '@/session/turn-history-gate';
import { SessionDispatchWatcher } from '@/session/session-dispatch-watcher';
import { SessionUserResolver } from '@/session/session-user-resolver';
import { SessionForkService } from '@/session/session-fork-service';
import { createFileSessionForkOperationStore } from '@/session/session-fork-operation-store';
import {
  SessionEditAndResendService,
  type SessionEditAndResendInput,
} from '@/session/session-edit-and-resend-service';
import { LodyOperationCoordinator } from '@/orchestration/operation-coordinator';
import { getLodyOperationStorePath, LodyOperationStore } from '@/orchestration/operation-store';
import {
  createSessionResult,
  resolveTurnDispatchConfig,
  sendSessionChatResult,
  type CreateOptions,
  type ResolvedTurnDispatchConfig,
} from '@/commands/session';
import {
  listAliveSessionMetas,
  resolveWorkspaceOrThrow,
  type AuthContext,
} from '@/lib/command-runtime';
import { makeSessionAccessPolicy } from '@/session/session-access-policy';
import { AutoPromptRunner } from '@/session/auto-prompt-runner';
import { TurnPostProcessingService } from '@/session/turn-post-processing-service';
import {
  applyAcpSessionRunConfig,
  type AcpSessionRunConfig,
} from '@/session/acp-session-config-applier';
import {
  readDiffStatsMetadata,
  resolveCodeCollabAllChangesDiffStatsPatch,
  resolveDiffStatsTarget,
} from '@/session/session-diff-stats-target';
import type { MachineAccessVerification } from '@/session/session-access-retry';
import {
  CodeCollabV2Service,
  CodeCollabV2ServiceError,
  type CodeCollabV2WorkspaceResolveOptions,
  type CodeCollabV2WorkspaceResolver,
} from '@/lib/code-collab/code-collab-v2-service';
import { FilePreviewService } from '@/lib/file-preview/file-preview-service';
import {
  CodeCollabV2DiffStore,
  type CodeCollabV2DiffStoreEvent,
} from '@/lib/code-collab/code-collab-v2-diff-store';
import {
  mergePendingDiffStoreEvents,
  pendingEventFromAgentEditEvidence,
  pendingEventFromStandardDiffEvidence,
  pendingEventFromWriteTextFileEvidence,
  resolveCodeCollabV2EvidencePath,
  type AgentEditLatestText,
  type CodeCollabV2PendingDiffStoreEvent,
  type CodeCollabV2WriteTextFileEvidence,
} from '@/lib/code-collab/code-collab-v2-diff-evidence';
import {
  readMachineLocalProjects,
  removeMachineLocalProject,
  resolveWorkspaceLocalProject,
  resolveWorkspaceLocalProjectRootPath,
  resolveWorkspaceLocalProjectRootPathWithRetry,
  resolveWorkspaceLocalProjectWithSyncOnMiss,
  isSessionInLocalProjectRemovalScope,
  shouldApplyMachineDeleteLocalProjectCommand,
  upsertMachineLocalProject,
} from '@/lib/local-project-meta';
import {
  isACPAgentRichContentNotification,
  materializeACPAgentRichContent,
} from '@/lib/acp-agent-attachments';
import { LocalProjectControlService } from '@/lib/local-project-control-service';
import {
  makeLocalWorkspaceCatalog,
  type LocalCatalogAccessSnapshot,
  type LocalWorkspaceCatalogService,
} from '@/lib/local-workspace-catalog';
import { resolveSessionLiveStatus } from './session-live-status';
import type { MemoryPressureEvictionResult } from './session-gc-manager';
import { PreviewService } from '@/preview/preview-service';
import { LocalProjectHistorySyncService } from '@/lib/local-project-history-sync-service';
import { precheckLocalProjectHistoryRequest } from '@/lib/local-project-history-precheck';
import {
  cleanupLocalProjectWorktrees,
  preflightLocalProjectWorktreeRemoval,
} from '@/lib/local-project-removal';
import {
  downloadSessionImageForPrompt,
  type DownloadedSessionImagePromptBlock,
} from '@/lib/session-image-download';
import {
  handleLocalProjectWorktreeConfigRequest,
  isLocalProjectWorktreeConfigRequest,
} from '@/session/worktree/worktree-setup-config-store';
import { readLegacySessionLaunchConfig } from '@/session/session-launch-config-resolver';
import { resolveSessionWorktreeCleanupConfig } from '@/session/worktree/worktree-config-resolver';

type RepoDocMetaPatch = Parameters<LoroDocumentManager['repo']['upsertDocMeta']>[1];
type LocalProjectFileRpcRequest = Extract<
  LocalProjectControlRequest,
  {
    type:
      | 'local-project/list-files'
      | 'local-project/list-dir'
      | 'local-project/list-skills'
      | 'local-project/read-file';
  }
>;
type LocalProjectGlobalSkillsRpcRequest = Extract<
  LocalProjectControlRequest,
  { type: 'local-project/list-global-skills' }
>;
type LocalProjectOwnerOnlyRpcRequest = Extract<
  LocalProjectControlRequest,
  {
    type:
      | 'local-project/add'
      | 'local-project/prepare-add'
      | 'local-project/list-roots'
      | 'local-project/browse-dir';
  }
>;

function isCodeCollabV2ServiceErrorForLocalRpc(error: unknown): error is CodeCollabV2ServiceError {
  return error instanceof CodeCollabV2ServiceError;
}

function isLocalProjectFileRpcRequest(
  request: LocalProjectControlRequest
): request is LocalProjectFileRpcRequest {
  return (
    request.type === 'local-project/list-files' ||
    request.type === 'local-project/list-dir' ||
    request.type === 'local-project/list-skills' ||
    request.type === 'local-project/read-file'
  );
}

function isLocalProjectGlobalSkillsRpcRequest(
  request: LocalProjectControlRequest
): request is LocalProjectGlobalSkillsRpcRequest {
  return request.type === 'local-project/list-global-skills';
}

function isLocalProjectOwnerOnlyRpcRequest(
  request: LocalProjectControlRequest
): request is LocalProjectOwnerOnlyRpcRequest {
  return (
    request.type === 'local-project/add' ||
    request.type === 'local-project/prepare-add' ||
    request.type === 'local-project/list-roots' ||
    request.type === 'local-project/browse-dir'
  );
}

type CodeCollabWorkspaceRootResolution =
  | {
      readonly ok: true;
      readonly workspaceRoot: string;
      readonly source: string;
      /** Owner session when a child session shares the parent worktree. */
      readonly ownerSessionId?: SessionId;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly message: string;
    };

const CODE_COLLAB_WORKSPACE_WAIT_TIMEOUT_MS = 8_000;
const CODE_COLLAB_WORKSPACE_WAIT_INTERVAL_MS = 100;

async function withTimeoutOrUndefined<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type DeleteRequest = NeedToDeleteSessionQueueItem | MachineDeleteSessionCommand;
type DeleteRequestRecord = Exclude<NeedToDeleteSessionQueueItem, boolean>;
type MachineCommandSnapshot = {
  machineMeta: MachineLegacyMetaFields | undefined;
  machineFlockRows: MachineFlockRowMap;
  archiveSessionIds: SessionId[];
  deleteEntries: [SessionId, DeleteRequest][];
  deleteSessionIds: Set<SessionId>;
  deleteLocalProjectEntries: [LocalProjectId, MachineDeleteLocalProjectCommand][];
};

function getMachineCommandEventImpact(events: readonly MachineFlockEvent[]): {
  archive: boolean;
  delete: boolean;
  deleteLocalProject: boolean;
  providerSetup: boolean;
} {
  let archive = false;
  let deleteCommand = false;
  let deleteLocalProject = false;
  let providerSetup = false;
  for (const event of events) {
    const parsed = parseMachineFlockKey(event.key);
    if (parsed?.kind === 'archiveSessionCommand') {
      archive = true;
    }
    if (parsed?.kind === 'deleteSessionCommand') {
      archive = true;
      deleteCommand = true;
    }
    if (parsed?.kind === 'deleteLocalProjectCommand') {
      deleteLocalProject = true;
    }
    if (parsed?.kind === 'providerSetup' || parsed?.kind === 'providerSetupCancellation') {
      providerSetup = true;
    }
  }
  return { archive, delete: deleteCommand, deleteLocalProject, providerSetup };
}

function getMachineFlockArchiveSessionIds(rows: MachineFlockRowMap): SessionId[] {
  const sessionIds: SessionId[] = [];
  for (const row of Object.values(rows)) {
    const parsed = parseMachineFlockKey(row.key);
    if (parsed?.kind === 'archiveSessionCommand') {
      sessionIds.push(parsed.sessionId);
    }
  }
  return sessionIds;
}

function getMachineFlockDeleteEntries(
  rows: MachineFlockRowMap
): [SessionId, MachineDeleteSessionCommand][] {
  const entries: [SessionId, MachineDeleteSessionCommand][] = [];
  for (const row of Object.values(rows)) {
    const parsed = parseMachineFlockKey(row.key);
    if (parsed?.kind === 'deleteSessionCommand') {
      entries.push([parsed.sessionId, row.value as MachineDeleteSessionCommand]);
    }
  }
  return entries;
}

function getMachineFlockDeleteCommand(
  rows: MachineFlockRowMap,
  sessionId: SessionId
): MachineDeleteSessionCommand | undefined {
  const key = machineFlockKeys.deleteSessionCommand(sessionId);
  const row = rows[serializeMachineFlockKey(key)];
  if (!row) {
    return undefined;
  }
  const parsed = parseMachineFlockKey(row.key);
  if (parsed?.kind !== 'deleteSessionCommand') {
    return undefined;
  }
  return row.value as MachineDeleteSessionCommand;
}

function buildMachineCommandSnapshot(
  machineMeta: MachineLegacyMetaFields | undefined,
  machineFlockRows: MachineFlockRowMap
): MachineCommandSnapshot {
  const needToArchiveSessions = machineMeta?.needToArchiveSessions ?? {};
  const archiveSessionIds = Array.from(
    new Set<SessionId>([
      ...(Object.keys(needToArchiveSessions) as SessionId[]),
      ...getMachineFlockArchiveSessionIds(machineFlockRows),
    ])
  );

  const entriesBySessionId = new Map<SessionId, DeleteRequest>();
  for (const [sessionId, request] of getMachineFlockDeleteEntries(machineFlockRows)) {
    entriesBySessionId.set(sessionId, request);
  }
  for (const [sessionId, request] of Object.entries(machineMeta?.needToDeleteSessions ?? {}) as [
    SessionId,
    NeedToDeleteSessionQueueItem,
  ][]) {
    if (!entriesBySessionId.has(sessionId)) {
      entriesBySessionId.set(sessionId, request);
    }
  }

  const deleteEntries = Array.from(entriesBySessionId.entries());
  return {
    machineMeta,
    machineFlockRows,
    archiveSessionIds,
    deleteEntries,
    deleteSessionIds: new Set(deleteEntries.map(([sessionId]) => sessionId)),
    deleteLocalProjectEntries: getMachineFlockDeleteLocalProjectEntries(machineFlockRows),
  };
}

type WorktreeCleanupTarget = {
  repoId: RepoId;
  source?: { kind: 'local-shared'; originalRootPath: string };
  branchName?: string;
  baseBranchName?: string;
};

type LiveActivitySummary = {
  activityId: string;
  totalCount: number;
  statusCounts: LiveActivityStatusCounts;
  items: LiveActivityConversationItem[];
  updatedAt: number;
  permissionAlert?: LiveActivityPermissionAlert;
};

function formatLiveActivityUpdatedAt(value: number, nowMs: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  const elapsedMs = Math.max(0, nowMs - value);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (elapsedMs < minute) return 'now';
  if (elapsedMs < hour) return `${Math.max(1, Math.floor(elapsedMs / minute))}m`;
  if (elapsedMs < day) return `${Math.max(1, Math.floor(elapsedMs / hour))}h`;
  return `${Math.max(1, Math.floor(elapsedMs / day))}d`;
}

export interface MessageHandlerConfig {
  token: string;
  workspaceId: WorkspaceId;
  workspaceSlug?: string;
  userId: string;
  machineId: string;
  machineName: string;
  cliVersion: string;
  machineLifecycleCapability?: MachineLifecycleCapability;
  supportRegistryAgentTypes?: string[];
  closeSessionTerminals?: (sessionId: SessionId) => void;
  localWorkspaceCatalog?: LocalWorkspaceCatalogService;
  cleanupLocalProjectWorktreeSetupIfUnreferenced?: (
    localProjectId: LocalProjectId
  ) => Promise<void>;
  /**
   * Invoked when a background worker discovers the CLI token has been
   * revoked (e.g. 401/403 from the Loro Streams token endpoint). The
   * process owner should use this to tear the CLI down instead of
   * retrying on a dead credential.
   */
  onFatalAuthFailure?: (error: Error) => void;
  /**
   * Invoked after a machine lifecycle RPC has been ACKed to the caller. The
   * process boundary owns the actual exit/restart behavior.
   */
  onProcessLifecycleAction?: (action: MachineProcessLifecycleAction) => void;
  workspaceWatchCoordinator?: WorkspaceWatchCoordinatorApi;
  cloudPort: CloudPort;
}

export type MessageDispatchSource = 'runtime' | 'local';

export type MessageDispatchContext = {
  source: MessageDispatchSource;
  send: (message: unknown) => void;
};

type ControlMessage = LocalSessionControlRequestValidated;
type ConversationTurnGateContext = {
  dispatchSource?: SessionDispatchSource;
  sessionDoc: SessionDocument;
  deferACPUpdateTarget?: boolean;
};

type UploadableImageFile = {
  absolutePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  // Bytes are read inside the validation function while the file is open with
  // O_NOFOLLOW. Carrying them to upload avoids a second `readFile` that would
  // re-open the path and follow a symlink swapped in after validation (TOCTOU).
  bytes: Buffer;
};

type UploadedSessionImage = NonNullable<SessionImageUploadResponse['images']>[number];
type SessionImageUploadAttachTarget =
  | { kind: 'active_turn'; turnId: string }
  | { kind: 'new_entry' }
  | { kind: 'unavailable'; statusType: string };
type SessionImageUploadOptions = {
  attachTarget?: SessionImageUploadAttachTarget;
};

type ValidatedUploadFile = {
  absolutePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  textPreview: boolean;
};

type UploadedSessionFile = SessionFilePayload & { downloadUrl: string };

/**
 * Persist workspace-relative attachment provenance with one cross-platform
 * separator convention so downstream canonical-path consumers can open it.
 */
export function normalizeSessionFileSourcePath(
  sourcePath: string,
  separator: string = path.sep
): string {
  return separator === '/' ? sourcePath : sourcePath.split(separator).join('/');
}

const SESSION_FILE_MAX_PART_RETRIES = 3;

// Best-effort MIME type from a file extension for the agent-send path. The
// server treats this as advisory only; preview gating re-sniffs content.
const SESSION_FILE_MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/plain',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

const DEFAULT_SESSION_FILE_MIME_TYPE = 'application/octet-stream';

// Backend multipart contract (backend/server/src/session-file-server.ts). Validated
// at the trust boundary since these are HTTP responses (cli-type-safety rule).
const MultipartCreateResponseSchema = z.object({
  success: z.literal(true),
  uploadId: z.string().min(1),
  fileId: z.string().min(1),
});
const MultipartPartResponseSchema = z.object({
  success: z.literal(true),
  partNumber: z.number().int(),
  etag: z.string().min(1),
});

const SESSION_IMAGE_MIME_TYPE_BY_EXTENSION: Record<
  string,
  (typeof SESSION_IMAGE_ALLOWED_MIME_TYPES)[number]
> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

// ACP ToolCallStatus values that represent a finished image generation.
// `pending`/`in_progress` keep the captured turnId alive for retries; everything
// else is terminal and clears the per-call tracking state.
const IMAGE_GENERATION_TERMINAL_STATUSES = new Set(['completed', 'failed']);

function isImageGenerationTerminalStatus(status: string): boolean {
  return IMAGE_GENERATION_TERMINAL_STATUSES.has(status.trim().toLowerCase());
}

/**
 * MessageHandler has two responsibilities:
 *
 * 1) Local control plane:
 *    Handles validated local control requests, such as:
 *    - session lifecycle: `session/create`, `session/cancel`,
 *    - chat (non-streaming): `session/chat`
 *    - local status / capability refresh requests
 *
 * 2) ACP notification plane (agent -> machine):
 *    Receives ACP SessionNotification streams emitted by the local agent process per session.
 *    Those updates are applied immediately onto the
 *    session doc history via `handleACPUpdateMessage`.
 *
 * Key invariants:
 * - ACP updates must be flushed before transitioning a session to terminal statuses
 *   (`completed` / `terminated` / `error`) so history is consistent.
 * - Permission requests are cross-plane: ACP tool calls may trigger a server permission UI.
 *   We persist permission metadata into history so the UI can render it deterministically.
 */

export class MessageHandler {
  private sessionManager: SessionManager;
  private logger: Logger;
  private machineId: MachineId;
  private token: string;
  private userId: string;
  private workspaceId: WorkspaceId;
  private workspaceSlug?: string;
  private machineName: string;
  private cliVersion: string;
  private supportRegistryAgentTypes: string[];
  private closeSessionTerminals?: (sessionId: SessionId) => void;
  private cleanupLocalProjectWorktreeSetupIfUnreferenced?: (
    localProjectId: LocalProjectId
  ) => Promise<void>;
  private onFatalAuthFailure?: (error: Error) => void;
  private onProcessLifecycleAction?: (action: MachineProcessLifecycleAction) => void;
  private readonly machineLifecycleCapability: MachineLifecycleCapability;
  private pendingProcessLifecycleAction: MachineProcessLifecycleAction | null = null;
  private readonly store = new SessionTransientStore();
  private sessionActivePresence!: SessionActivePresenceController;
  private readonly titleGenerationInFlight = new Map<SessionId, Promise<string | null>>();
  // Note: titleGenerationInFlight, archiveInFlight, deleteInFlight are self-cleaning
  // and stay as independent tracking. All other per-session state lives in this.store.
  private archiveWatchHandle: RepoWatchHandle | null = null;
  private readonly archiveInFlight = new Set<SessionId>();
  private deleteWatchHandle: RepoWatchHandle | null = null;
  private readonly deleteInFlight = new Set<SessionId>();
  private readonly deletedSessionIds = new Set<SessionId>();
  private readonly deleteLocalProjectInFlight = new Set<LocalProjectId>();
  private machineFlockCommandWatcher: MachineFlockCommandWatcher;
  // Desktop local-transport backfill: in-flight task keys (`${sessionId}:${fileId}`)
  // so a file is never backfilled by two concurrent workers (re-enqueue dedupe).
  private readonly sessionFileBackfillInFlight = new Set<string>();
  private sessionFileBackfillStopped = false;
  // Backfill authorization window (S5/D10 撤权不上传): every enable opens a new
  // generation with a fresh AbortController; disable (offline/revoke) aborts
  // in-flight uploads and bumps the generation. A backfill task may only COMMIT
  // (write the `.r2meta` marker / flip history local→r2) inside the exact
  // generation it started in — a revoke landing while an upload is in flight
  // must not let the resumed task adopt the uploaded bytes.
  private remoteBackfillGeneration = 0;
  private remoteBackfillAbort: AbortController | null = null;
  private get remoteBackfillEnabled(): boolean {
    return this.remoteBackfillAbort !== null;
  }
  private hasShownHappyCodingMessage = false;
  private readonly cloudPort: CloudPort;
  private notificationService: CloudNotificationsPort | null;
  private usageTrackingService: CloudUsagePort | null;
  // Backstop bound on how long turn finalization waits for a cloud side
  // effect once it has been allowed to run (see runTurnCloudSideEffect —
  // known-offline skips entirely; this bound covers half-open networks the
  // transport status has not noticed yet). These run inside the session
  // presence scope, so an unbounded Convex call keeps the UI "thinking" after
  // the agent finished (specs/local-first-two-plane.md).
  private static readonly TURN_CLOUD_SIDE_EFFECT_WAIT_MS = 10_000;

  private static readonly ACP_INITIAL_UPDATE_BATCH_WINDOW_MS = 10;
  private static readonly ACP_SUBSEQUENT_UPDATE_BATCH_WINDOW_MS = 100;
  private static readonly ACP_MAX_AUTOMATIC_FLUSH_FAILURES = 5;
  private static readonly ACP_FLUSH_RETRY_BASE_DELAY_MS = 100;
  private static readonly ACP_FLUSH_RETRY_MAX_DELAY_MS = 1_600;
  private static readonly CODE_COLLAB_EVIDENCE_MAX_AUTOMATIC_RETRIES = 5;
  private static readonly CODE_COLLAB_EVIDENCE_RETRY_BASE_DELAY_MS = 100;
  private static readonly CODE_COLLAB_EVIDENCE_RETRY_MAX_DELAY_MS = 1_600;
  private static readonly CONTEXT_WINDOW_USAGE_THROTTLE_MS = 400;
  // Track permission wait time: requestId -> timestamp when permission was requested
  private readonly permissionRequestStartTimes = new Map<string, number>();
  private static readonly MACHINE_ACCESS_REGISTRATION_CACHE_TTL_MS = 20 * 60_000;
  private machineAccessRegistrationInFlight: Promise<void> | null = null;
  private machineAccessRegistrationExpiresAtMs = 0;
  /** Late-bound memory pressure eviction, set by MachineRuntime after GC init */
  private evictForMemoryPressureFn: (
    excludeSessionId?: SessionId
  ) => Promise<MemoryPressureEvictionResult> = async () => ({
    availableMemoryBytes: 0,
    thresholdBytes: 0,
    hadMemoryPressure: false,
    stillUnderPressure: false,
    evictedSessionIds: [],
    pressureReason: null,
  });
  private executionService: SessionExecutionService;
  private providerSetupManager: ProviderSetupManager;
  private previewService: PreviewService;
  private sessionDispatchWatcher: SessionDispatchWatcher;
  private sessionUserResolver: SessionUserResolver;
  private sessionForkService: SessionForkService;
  private sessionEditAndResendService: SessionEditAndResendService;
  private operationCoordinator: LodyOperationCoordinator;
  private autoPromptRunner: AutoPromptRunner;
  private turnPostProcessingService: TurnPostProcessingService;
  private localProjectControlService: LocalProjectControlService;
  private localWorkspaceCatalog: LocalWorkspaceCatalogService;
  private machineRpcServer: LoroStreamsMachineRpcServer | null = null;
  private machineRpcTokenProvider: LoroStreamsTokenProvider | null = null;
  private machineRpcGatewayBaseUrl: string | null = null;
  private machineRpcServerStartPromise: Promise<void> | null = null;
  private machineRpcServerRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private machineRpcServerStartAttempt = 0;
  private cleanedUp = false;
  private readonly codeCollabV2DiffStore: CodeCollabV2DiffStore;
  private readonly codeCollabV2TurnDiffs = new Map<string, CodeCollabV2PendingDiffStoreEvent[]>();
  // Edit-tool changes (Codex apply_patch et al) for the in-flight turn. These bypass
  // fs/write_text_file + standard ACP diff blocks, so they are gap-filled into the diff
  // store at turn end (old text chained from the prior recorded state). Keyed by turn.
  private readonly codeCollabV2TurnEdits = new Map<string, AcpAgentEditEvidence[]>();
  private readonly codeCollabV2PendingEvidenceWrites = new Map<SessionId, Set<Promise<void>>>();
  private readonly codeCollabV2TurnPersistChains = new Map<string, Promise<void>>();
  private readonly codeCollabV2TurnRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly codeCollabV2TurnRetryFailures = new Map<string, number>();
  private codeCollabV2Service: CodeCollabV2Service;
  // File Preview v3. Separate from Code Collab on purpose: previewing a file must
  // not start a workspace watcher or publish a file index.
  private filePreviewService: FilePreviewService;

  /**
   * Get a logger with session context. Caches loggers per session for efficiency.
   */
  private getSessionLogger(sessionId: SessionId): Logger {
    const state = this.store.get(sessionId);
    if (!state.logger) {
      state.logger = this.logger.child({ sessionId });
    }
    return state.logger;
  }

  /**
   * Update the last activity timestamp for a session.
   * Used by GC to determine which sessions are idle.
   */
  private touchSession(sessionId: SessionId): void {
    this.store.get(sessionId).lastActivityMs = Date.now();
  }

  private readonly preferredBaseBranch = (process.env.LODY_BASE_BRANCH || 'main').trim() || 'main';

  private resolveGitHubProjectBranch(
    meta: SessionMeta | undefined,
    preferredBranch?: string | null
  ): string {
    return resolveBaseBranchPreference({
      preferredBranch,
      baseBranch: meta?.baseBranch,
      project: meta?.project,
      fallbackBranch: this.preferredBaseBranch,
    });
  }

  private resolveProjectFromMeta(
    meta: SessionMeta | undefined,
    preferredBranch?: string | null
  ): ProjectRef | undefined {
    const rawProject = meta?.project as
      | (
          | { kind: 'github'; repoFullName?: unknown; branch?: unknown }
          | {
              kind: 'local';
              localProjectId?: unknown;
              branch?: unknown;
              githubRepoFullName?: unknown;
              useWorktree?: unknown;
            }
        )
      | undefined;

    if (rawProject?.kind === 'github') {
      const repoFullName =
        typeof rawProject.repoFullName === 'string' ? rawProject.repoFullName.trim() : '';
      if (!repoFullName) {
        return undefined;
      }
      const branch = this.resolveGitHubProjectBranch(meta, preferredBranch);
      const projectBranch =
        typeof rawProject.branch === 'string' && rawProject.branch.trim()
          ? rawProject.branch.trim()
          : branch;
      return { kind: 'github', repoFullName, branch: projectBranch };
    }

    if (rawProject?.kind === 'local') {
      if (typeof rawProject.localProjectId !== 'string' || !rawProject.localProjectId.trim()) {
        return undefined;
      }
      const projectBranch =
        typeof rawProject.branch === 'string' && rawProject.branch.trim()
          ? rawProject.branch.trim()
          : typeof preferredBranch === 'string' && preferredBranch.trim()
            ? preferredBranch.trim()
            : undefined;
      const githubRepoFullName =
        typeof rawProject.githubRepoFullName === 'string' && rawProject.githubRepoFullName.trim()
          ? rawProject.githubRepoFullName.trim()
          : (meta?.repoFullName?.trim() ?? undefined);
      return {
        kind: 'local',
        localProjectId: rawProject.localProjectId as LocalProjectId,
        ...(githubRepoFullName ? { githubRepoFullName } : {}),
        ...(projectBranch ? { branch: projectBranch } : {}),
        ...(typeof rawProject.useWorktree === 'boolean'
          ? { useWorktree: rawProject.useWorktree }
          : {}),
      };
    }

    const repoFullName = meta?.repoFullName?.trim();
    if (!repoFullName) {
      return undefined;
    }
    const branch = this.resolveGitHubProjectBranch(meta, preferredBranch);
    return { kind: 'github', repoFullName, branch };
  }

  /**
   * Create an assistant entry in history for a new conversation turn.
   *
   * Association with the turn is by deterministic entry id (`assistant:<userTurnId>`),
   * not by timing, so creation may be deferred: when the turn's history gate is
   * still pending (RPC fast-path turn whose user entry has not synced locally),
   * writing now would race the user entry's list position. Skip — the gate
   * creates this exact entry the moment it opens, and later calls (finalization
   * patch) find the gate open and take the idempotent update branch.
   */
  private async createAssistantEntryForTurn(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    turnId: string,
    modelInfo: ModelInfo | undefined,
    userTurnId?: string
  ): Promise<void> {
    const gate = this.store.has(sessionId) ? this.store.get(sessionId).turnHistoryGate : null;
    if (gate && !gate.isOpen) {
      this.logger.debug(
        `[${sessionId}] Deferring assistant entry for turn ${turnId} until the user turn syncs`
      );
      return;
    }
    await this.writeAssistantEntryForTurn(sessionId, sessionDoc, turnId, modelInfo, userTurnId);
  }

  private async writeAssistantEntryForTurn(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    turnId: string,
    modelInfo: ModelInfo | undefined,
    userTurnId?: string
  ): Promise<void> {
    const span = startTraceSpan(this.logger, 'history.write_assistant_entry', {
      sessionId,
      turnId,
      ...(userTurnId ? { userTurnId } : {}),
    });
    this.logger.debug(`[${sessionId}] Creating assistant entry for turn ${turnId}`);
    try {
      await sessionDoc.updateHistory((history) => {
        const existingEntry = history.find(
          (entry) => entry.id === turnId && entry.role === 'assistant'
        );
        if (existingEntry) {
          return history.map((entry) => {
            if (entry.id !== turnId || entry.role !== 'assistant') {
              return entry;
            }
            // Reopen a reused assistant entry for a live turn: clear the terminal
            // footprint that `finalizeACPState` may have stamped on it. Assistant
            // entry ids are deterministic (`assistant:<userTurnId>`), so when a turn
            // is re-dispatched after the machine died/restarted mid-turn (durable
            // pointer recovery), execution reuses THIS finalized entry and streams
            // fresh output into it. Without this reset `finished`/`endedAt` stay true
            // from the pre-death teardown finalize, and the web renderer folds the
            // still-streaming turn into a "Worked for …" summary (and shared
            // "active assistant entry" logic treats it as terminal). This branch only
            // runs at genuine turn (re)start via `openAssistantEntry`, so resetting to
            // the not-finished state here is correctly scoped. See
            // apps/cli/src/session/AGENTS.md (assistant entry id reuse) and
            // packages/components/src/components/ai-gui/AGENTS.md ("Worked for …").
            return {
              ...entry,
              userTurnId: entry.userTurnId ?? userTurnId,
              modelInfo: modelInfo ?? entry.modelInfo,
              finished: false,
              endedAt: undefined,
              permissionWaitMs: undefined,
            };
          });
        }

        history.push({
          id: turnId,
          role: 'assistant',
          userTurnId,
          items: [] as unknown as SessionHistoryInput['items'],
          timestamp: new Date(getServerNow()).toISOString(),
          userId: undefined,
          read: undefined,
          modelInfo,
          fileDiff: [],
        });
        return history;
      });
      span.end();
      this.logger.debug(`[${sessionId}] Assistant entry created`);
    } catch (error) {
      span.fail(error);
      throw error;
    }
  }

  /**
   * Run a Lody-cloud side effect attached to a visible turn (usage flush,
   * completion notification, Live Activity sync). Two-layer discipline —
   * cloud work must never hold the turn's presence scope
   * (specs/local-first-two-plane.md):
   *
   * - Known-offline: skip immediately. The Loro Streams transport status is
   *   the CLI's cloud-plane reachability signal; when it is down these Convex
   *   calls cannot succeed and waiting on them only keeps the UI "thinking".
   *   Callers tolerate skipped delivery by contract (usage stays staged for
   *   the next flush; notifications are best-effort).
   * - Otherwise: run with a bounded wait as the backstop for half-open
   *   networks the transport status has not noticed yet. On timeout the call
   *   keeps running in the background with its own error logging.
   *
   * Scope note: this gates LODY-cloud effects only. Third-party reachability
   * (GitHub, model APIs) is a different domain and is bounded by its own
   * tooling, never by this signal.
   */
  private async runTurnCloudSideEffect(
    sessionId: SessionId,
    label: string,
    run: () => Promise<void>
  ): Promise<void> {
    if (!this.workspaceDocument.isTransportConnected()) {
      this.logger.debug(`[${sessionId}] Skipping ${label}: cloud plane is offline`);
      return;
    }
    try {
      await withTimeout(
        run(),
        MessageHandler.TURN_CLOUD_SIDE_EFFECT_WAIT_MS,
        `Timed out waiting for ${label} (session=${sessionId})`
      );
    } catch (error) {
      this.logger.debug(`[${sessionId}] ${label} did not complete: ${formatErrorMessage(error)}`);
    }
  }

  private async flushSessionUsage(sessionId: SessionId): Promise<void> {
    await this.flushSessionContextWindowUsage(sessionId);
    if (!this.usageTrackingService) return;
    const usageTrackingService = this.usageTrackingService;

    // Drain all in-flight onUsageUpdate handlers so that recordSessionUsageUpdate
    // has been called before we flush. Loop because new handlers may be added
    // while we await the current batch.
    for (;;) {
      const state = this.store.get(sessionId);
      if (state.pendingUsageHandlers.size === 0) break;
      await Promise.all([...state.pendingUsageHandlers]);
    }

    // Skipped/failed flushes keep the usage staged in the tracking service;
    // the next flush (later turn or shutdown, once online) sends the merged
    // totals.
    await this.runTurnCloudSideEffect(sessionId, 'session usage flush', async () => {
      await usageTrackingService.flushSessionUsage(sessionId);
    });
  }

  private async handleUsageUpdate(
    sessionId: SessionId,
    acpSessionId: ACPSessionId,
    update: SessionUsageUpdate
  ): Promise<void> {
    try {
      const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
      const meta = await sessionDoc.getMetaState();
      if (!meta) return;
      if (meta.cliType !== 'builtin' || !isManagedBuiltinAgentType(meta.agentType)) {
        return;
      }
      const cliType = meta.agentType;
      const latestAssistant = sessionDoc.getLatestAssistantHistory();

      let userId = latestAssistant?.userId;
      if (!userId) {
        const history = await sessionDoc.getHistory();
        for (let i = history.length - 1; i >= 0; i--) {
          const entry = history[i];
          if (entry?.userId) {
            userId = entry.userId;
            break;
          }
        }
      }

      if (!userId) {
        this.logger.debug(`[${sessionId}] Skipping usage update: missing userId`);
        return;
      }

      this.usageTrackingService?.recordSessionUsageUpdate({
        workspaceId: this.workspaceId,
        sessionId,
        acpSessionId,
        userId,
        machineId: this.machineId,
        cliType,
        update,
      });
    } catch (error) {
      this.logger.debug(
        `[${sessionId}] Failed to resolve usage update context: ${formatErrorMessage(error)}`
      );
    }
  }

  private trackPendingContextWindowPersist(sessionId: SessionId, promise: Promise<void>): void {
    const state = this.store.get(sessionId);
    state.pendingContextWindowHandlers.add(promise);
    void promise.finally(() => {
      state.pendingContextWindowHandlers.delete(promise);
    });
  }

  private enqueueSessionNoticeHistoryPersist(
    sessionId: SessionId,
    task: () => Promise<void>
  ): void {
    const state = this.store.get(sessionId);
    const promise = state.historyNoticePersistChain.catch(() => undefined).then(task);
    state.historyNoticePersistChain = promise;
    state.pendingHistoryNoticeHandlers.add(promise);
    void promise.finally(() => {
      state.pendingHistoryNoticeHandlers.delete(promise);
      if (state.historyNoticePersistChain === promise) {
        state.historyNoticePersistChain = Promise.resolve();
      }
    });
  }

  private async flushThreadGoalHistoryPersists(sessionId: SessionId): Promise<void> {
    for (;;) {
      const state = this.store.get(sessionId);
      if (state.pendingHistoryNoticeHandlers.size === 0) break;
      await Promise.all([...state.pendingHistoryNoticeHandlers]);
    }
  }

  private async flushCodexGeneratedImageUploads(sessionId: SessionId): Promise<void> {
    for (;;) {
      const state = this.store.get(sessionId);
      if (state.imageGenerationUploads.size === 0) break;
      await Promise.all([...state.imageGenerationUploads.values()]);
    }
  }

  private handleImageGenerationBegin(sessionId: SessionId, event: ImageGenerationBeginEvent): void {
    const turnId = this.store.getTurnId(sessionId) ?? null;
    const state = this.store.get(sessionId);
    state.imageGenerationTurnIds.set(event.callId, turnId);
    state.imageGenerationActiveCallIds.add(event.callId);
    this.enqueueImageGenerationActivityStatusSync(sessionId);
    this.logger.debug(
      `[${sessionId}] Codex image generation started (callId=${event.callId} turnId=${turnId ?? 'none'})`
    );
  }

  private enqueueImageGenerationActivityStatusSync(sessionId: SessionId): void {
    const state = this.store.get(sessionId);
    const task = state.imageGenerationActivityStatusChain
      .catch(() => undefined)
      .then(async () => {
        const currentState = this.store.get(sessionId);
        const hasActiveImageGeneration = currentState.imageGenerationActiveCallIds.size > 0;
        const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
        const status = (await sessionDoc.getMetaState())?.status;

        // This chain rides on ACP events and can drain after the visible active
        // scope ended; a working-status write is only sustainable while this
        // session still has active presence.
        const nextStatus = resolveImageGenerationStatusWrite({
          hasActiveImageGeneration,
          hasActivePresence: this.hasSessionActivePresence(sessionId),
          status,
        });
        if (nextStatus) {
          await sessionDoc.setStatus(nextStatus);
          this.setSessionActivePresencePhase(
            sessionId,
            nextStatus.type === 'running' && nextStatus.activity === 'image_generation'
              ? 'image_generation'
              : 'thinking'
          );
        }
      });

    state.imageGenerationActivityStatusChain = task;
    void task.catch((error) => {
      try {
        this.logger.debug(
          `[${sessionId}] Failed to sync Codex image generation activity: ${formatErrorMessage(
            error
          )}`
        );
      } catch {
        // Logging must never make the status chain fail recursively.
      }
    });
  }

  private handleImageGenerationEnd(sessionId: SessionId, event: ImageGenerationEndEvent): void {
    const state = this.store.get(sessionId);
    const isTerminal = isImageGenerationTerminalStatus(event.status);
    if (isTerminal) {
      state.imageGenerationActiveCallIds.delete(event.callId);
      this.enqueueImageGenerationActivityStatusSync(sessionId);
    }

    if (state.imageGenerationUploadedCallIds.has(event.callId)) {
      this.logger.debug(
        `[${sessionId}] Ignoring duplicate Codex image generation upload (callId=${event.callId} status=${event.status})`
      );
      return;
    }
    if (state.imageGenerationUploads.has(event.callId)) {
      this.logger.debug(
        `[${sessionId}] Codex image generation upload already in flight (callId=${event.callId} status=${event.status})`
      );
      return;
    }

    const cachedTurnId = state.imageGenerationTurnIds.get(event.callId);
    const capturedTurnId =
      cachedTurnId !== undefined ? cachedTurnId : (this.store.getTurnId(sessionId) ?? null);

    const savedPath = this.resolveCodexGeneratedImagePath(sessionId, event.savedPath);
    if (!savedPath && !event.image) {
      if (isTerminal) {
        state.imageGenerationTurnIds.delete(event.callId);
      }
      this.logger.debug(
        `[${sessionId}] Codex image generation has neither a usable savedPath nor inline image data (callId=${event.callId} status=${event.status} terminal=${isTerminal})`
      );
      return;
    }

    const attachTarget = capturedTurnId
      ? ({ kind: 'active_turn', turnId: capturedTurnId } satisfies SessionImageUploadAttachTarget)
      : undefined;

    const callId = event.callId;
    const uploadPromise = (async () => {
      let pathError: unknown;
      if (savedPath) {
        try {
          await this.uploadCodexGeneratedImage({
            sessionId,
            callId,
            savedPath,
            attachTarget,
          });
          return;
        } catch (error) {
          pathError = error;
          if (!event.image) throw error;
          this.logger.debug(
            `[${sessionId}] Codex generated image path upload failed; falling back to inline ACP image (callId=${callId} path=${savedPath}): ${formatErrorMessage(error)}`
          );
        }
      }

      if (event.image) {
        await this.uploadCodexGeneratedInlineImage({
          sessionId,
          callId,
          image: event.image,
          attachTarget,
        });
        return;
      }
      throw pathError ?? new Error('Codex generated image has no uploadable payload');
    })()
      .then(() => {
        state.imageGenerationUploadedCallIds.add(callId);
        state.imageGenerationTurnIds.delete(callId);
      })
      .catch((error) => {
        this.logger.debug(
          `[${sessionId}] Failed to upload Codex generated image (callId=${callId} path=${savedPath ?? 'none'}): ${formatErrorMessage(error)}`
        );
        if (isTerminal) {
          state.imageGenerationTurnIds.delete(callId);
        }
      })
      .finally(() => {
        state.imageGenerationUploads.delete(callId);
      });

    state.imageGenerationUploads.set(callId, uploadPromise);
  }

  private async uploadCodexGeneratedInlineImage(args: {
    sessionId: SessionId;
    callId: string;
    image: NonNullable<ImageGenerationEndEvent['image']>;
    attachTarget?: SessionImageUploadAttachTarget;
  }): Promise<void> {
    const notification: AcpSessionNotification = {
      sessionId: args.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'image',
          data: args.image.data,
          mimeType: args.image.mimeType,
          ...(args.image.uri ? { uri: args.image.uri } : {}),
        },
      },
    };
    const contents = await materializeACPAgentRichContent({
      workspaceId: this.workspaceId,
      sessionId: args.sessionId,
      notification,
      logger: this.logger,
      resolveSessionWorkspaceRoot: (sessionId) => this.resolveSessionWorkspaceRoot(sessionId),
      validateSessionImageUploadPath: async (filePath) =>
        await this.validateSessionImageUploadPath(filePath),
      uploadSessionImageFile: async (uploadArgs) => await this.uploadSessionImageFile(uploadArgs),
      validateSessionFileUploadPath: async (filePath, options) =>
        await this.validateSessionFileUploadPath(filePath, options),
      uploadValidatedSessionFile: async (uploadArgs) =>
        await this.uploadValidatedSessionFile(uploadArgs),
    });
    const content = contents.find(
      (item): item is SessionImageGroupContent => item.type === 'image_group'
    );
    if (!content) {
      throw new Error('Codex inline image could not be materialized as an image');
    }

    const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(args.sessionId);
    const initialTarget =
      args.attachTarget ??
      (await this.resolveSessionImageUploadAttachTarget(args.sessionId, sessionDoc));
    let historyEntryId: string;

    if (initialTarget.kind === 'active_turn') {
      const appended = await this.appendAssistantImageGroupToActiveTurn({
        sessionDoc,
        turnId: initialTarget.turnId,
        content,
      });
      if (appended) {
        historyEntryId = initialTarget.turnId;
      } else {
        const latestTarget = await this.resolveSessionImageUploadAttachTarget(
          args.sessionId,
          sessionDoc
        );
        if (latestTarget.kind !== 'new_entry') {
          throw new Error('The original assistant turn is no longer available for image upload');
        }
        historyEntryId = await this.createAssistantImageGroupEntry({
          sessionId: args.sessionId,
          sessionDoc,
          content,
        });
      }
    } else if (initialTarget.kind === 'new_entry') {
      historyEntryId = await this.createAssistantImageGroupEntry({
        sessionId: args.sessionId,
        sessionDoc,
        content,
      });
    } else {
      throw new Error(`Session is ${initialTarget.statusType}; image upload is unavailable`);
    }

    await sessionDoc.setLastMessageAt(Date.now());
    this.logger.debug(
      `[${args.sessionId}] Codex inline image uploaded (callId=${args.callId} historyEntryId=${historyEntryId})`
    );
  }

  private resolveCodexGeneratedImagePath(
    sessionId: SessionId,
    savedPath: string | undefined
  ): string | null {
    const trimmed = savedPath?.trim();
    if (!trimmed) {
      return null;
    }
    if (path.isAbsolute(trimmed)) {
      return trimmed;
    }

    try {
      const hostWorkdir = this.sessionManager.getSession(sessionId)?.getHostWorkdir();
      if (!hostWorkdir) {
        return null;
      }
      return path.resolve(hostWorkdir, trimmed);
    } catch (error) {
      this.logger.debug(
        `[${sessionId}] Failed to resolve Codex generated image path ${trimmed}: ${formatErrorMessage(error)}`
      );
      return null;
    }
  }

  private async uploadCodexGeneratedImage(args: {
    sessionId: SessionId;
    callId: string;
    savedPath: string;
    attachTarget?: SessionImageUploadAttachTarget;
  }): Promise<void> {
    const responses: SessionImageUploadResponse[] = [];
    await this.handleSessionImageUpload(
      {
        type: 'session/image-upload',
        machineId: this.machineId,
        sessionId: args.sessionId,
        workspaceId: this.workspaceId,
        paths: [args.savedPath],
      },
      {
        source: 'runtime',
        send: (message) => {
          if (
            message &&
            typeof message === 'object' &&
            (message as { type?: unknown }).type === 'session/image-upload_response'
          ) {
            responses.push(message as SessionImageUploadResponse);
          }
        },
      },
      { attachTarget: args.attachTarget }
    );

    const response = responses.find((item) => item.sessionId === args.sessionId);
    if (!response?.success) {
      throw new Error(
        response?.message ?? response?.error ?? 'Codex generated image upload failed'
      );
    }

    this.logger.debug(
      `[${args.sessionId}] Codex generated image uploaded (callId=${args.callId} attachedTo=${response.attachedTo ?? 'unknown'} historyEntryId=${response.historyEntryId ?? 'unknown'})`
    );
  }

  private async persistThreadGoalUpdate(
    sessionId: SessionId,
    goal: Extract<MessageContent, { type: 'goal' }>
  ): Promise<void> {
    try {
      const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
      await upsertThreadGoalInHistory(sessionDoc, goal, {
        targetEntryId: this.store.getTurnId(sessionId),
      });
      await this.workspaceDocument.repo.upsertDocMeta(sessionDoc.roomId, {
        latestGoal: undefined,
      } satisfies Partial<SessionLegacyMetaFields>);
    } catch (error) {
      this.logger.debug(
        `[${sessionId}] Failed to persist thread goal update: ${formatErrorMessage(error)}`
      );
    }
  }

  private async persistThreadGoalClear(sessionId: SessionId, threadId: string): Promise<void> {
    try {
      const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
      const meta = await sessionDoc.getMetaState();
      const legacyMeta = meta as SessionLegacyMetaFields | null | undefined;
      const current =
        resolveLatestSessionGoalFromHistory(await sessionDoc.getHistory()) ??
        legacyMeta?.latestGoal ??
        null;
      // Skip both the history sweep and the meta write when the snapshot is
      // already cleared — `clearThreadGoalFromHistory` would otherwise scan
      // every entry to find no work to do.
      if (current?.threadId === threadId && current.status === 'cleared') {
        return;
      }
      await clearThreadGoalFromHistory(sessionDoc, threadId);
      // Keep the cleared snapshot in history so the UI can render it without
      // carrying another copy in doc meta.
      if (current && current.threadId === threadId) {
        await upsertThreadGoalInHistory(sessionDoc, {
          ...current,
          status: 'cleared',
          updatedAt: getServerNow(),
        });
      }
      await this.workspaceDocument.repo.upsertDocMeta(sessionDoc.roomId, {
        latestGoal: undefined,
      } satisfies Partial<SessionLegacyMetaFields>);
    } catch (error) {
      this.logger.debug(
        `[${sessionId}] Failed to persist thread goal clear: ${formatErrorMessage(error)}`
      );
    }
  }

  private async persistContextWindowUsage(
    sessionId: SessionId,
    usage: SessionContextWindowUsage
  ): Promise<void> {
    try {
      const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
      await sessionDoc.setContextWindowUsage(usage);
    } catch (error) {
      this.logger.debug(
        `[${sessionId}] Failed to persist context window usage: ${formatErrorMessage(error)}`
      );
    }
  }

  private enqueueContextWindowUsageUpdate(
    sessionId: SessionId,
    usage: SessionContextWindowUsage
  ): void {
    const state = this.store.get(sessionId);
    state.contextWindowUsageBuffer = usage;
    if (state.contextWindowUsageTimer) {
      return;
    }
    state.contextWindowUsageTimer = setTimeout(() => {
      state.contextWindowUsageTimer = null;
      const latest = state.contextWindowUsageBuffer;
      if (!latest) {
        return;
      }
      state.contextWindowUsageBuffer = null;
      const promise = this.persistContextWindowUsage(sessionId, latest);
      this.trackPendingContextWindowPersist(sessionId, promise);
    }, MessageHandler.CONTEXT_WINDOW_USAGE_THROTTLE_MS);
  }

  private async flushSessionContextWindowUsage(sessionId: SessionId): Promise<void> {
    const state = this.store.get(sessionId);
    if (state.contextWindowUsageTimer) {
      clearTimeout(state.contextWindowUsageTimer);
      state.contextWindowUsageTimer = null;
    }

    const latest = state.contextWindowUsageBuffer;
    if (latest) {
      state.contextWindowUsageBuffer = null;
      const promise = this.persistContextWindowUsage(sessionId, latest);
      this.trackPendingContextWindowPersist(sessionId, promise);
    }

    for (;;) {
      const cwState = this.store.get(sessionId);
      if (cwState.pendingContextWindowHandlers.size === 0) break;
      await Promise.all([...cwState.pendingContextWindowHandlers]);
    }
  }

  /**
   * Record a chat failure notice in session history so the user can see what went wrong.
   * This adds a system message with the failure reason instead of silently failing.
   */
  private async recordChatFailure(
    sessionDoc: SessionDocument,
    reason: ChatFailedReason,
    message?: string,
    code?: ChatFailedCode
  ): Promise<void> {
    // Failure notices append to the history list; order them after the user
    // turn entry for RPC fast-path turns (no-op when no gate is pending).
    await this.awaitTurnHistoryGate(sessionDoc.sessionId);
    type SessionHistoryItemInput = NonNullable<SessionHistoryInput['items']>[number];
    const noticeItem: SessionHistoryItemInput = {
      type: 'system_notice',
      text: undefined,
      name: 'chat_failed',
      meta: {
        reason,
        ...(code ? { code } : {}),
        message,
      },
    };
    const systemNotice: SessionHistoryInput = {
      id: `system-notice-${Date.now()}`,
      role: 'system',
      timestamp: new Date().toISOString(),
      read: undefined,
      userId: undefined,
      fileDiff: [],
      items: [noticeItem],
    };
    await sessionDoc.updateHistory((prevHistory) => {
      return [...prevHistory, systemNotice];
    });
  }

  private async applyAcpModeAndModel(
    session: {
      sessionId: SessionId;
      acpSessionId: ACPSessionId | null;
      agentClient: AgentClient | null;
    },
    config: AcpSessionRunConfig,
    context: {
      sessionDoc: SessionDocument;
      basedOnUserTurnId?: string;
    }
  ): Promise<void> {
    const { runtimeConfigPatch, warningSelections } = await applyAcpSessionRunConfig({
      session,
      config,
      logger: this.logger,
    });

    if (runtimeConfigPatch && context.basedOnUserTurnId) {
      const basedOnUserTurnId = context.basedOnUserTurnId;
      const persistRuntimeConfig = async (): Promise<void> => {
        await this.awaitTurnHistoryGate(session.sessionId);
        context.sessionDoc.applyAcpRuntimeConfigPatch(basedOnUserTurnId, runtimeConfigPatch);
      };
      void persistRuntimeConfig().catch((error) => {
        this.logger.warn(
          `[${session.sessionId}] Failed to persist ACP runtime config: ${formatErrorMessage(error)}`
        );
      });
    }

    if (warningSelections.length > 0) {
      // Not awaited: this is reporting, and the prompt hot path must not block
      // on a history write.
      void this.recordAgentWarning(session.sessionId, {
        message: `The agent rejected part of the requested run configuration (${warningSelections.join(
          ', '
        )}) and is using its own values instead. Reasoning effort and fast mode depend on the selected model.`,
        source: 'configWarning',
      });
    }
  }

  private resolveServerBaseUrl(): string {
    const serverUrl = this.cloudPort.attachmentUpload?.serverBaseUrl.trim();
    if (!serverUrl) {
      throw new Error('cloud_attachment_upload_unavailable');
    }
    return serverUrl.endsWith('/') ? serverUrl.slice(0, -1) : serverUrl;
  }

  private async validateSessionImageUploadPath(filePath: string): Promise<UploadableImageFile> {
    const trimmed = filePath.trim();
    if (!trimmed) {
      throw new Error('Image path is empty');
    }

    const absolutePath = path.resolve(trimmed);
    // O_NOFOLLOW makes the open() fail with ELOOP if the final path component is a
    // symlink. We then fstat / read through the same fd, so an attacker who swaps
    // the file after validation cannot redirect us at a different inode.
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(
        absolutePath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ELOOP') {
        throw new Error(`Image path must not be a symlink: ${filePath}`, { cause: error });
      }
      throw new Error(`Image file not found: ${filePath}`, { cause: error });
    }

    try {
      const stat = await handle.stat();

      if (!stat.isFile()) {
        throw new Error(`Image path is not a file: ${filePath}`);
      }

      if (stat.size <= 0) {
        throw new Error(`Image is empty: ${filePath}`);
      }

      if (stat.size > SESSION_IMAGE_MAX_SIZE_BYTES) {
        throw new Error(
          `Image must be <= ${Math.floor(SESSION_IMAGE_MAX_SIZE_BYTES / (1024 * 1024))}MB: ${filePath}`
        );
      }

      const fileName = path.basename(absolutePath);
      const extension = path.extname(fileName).slice(1).trim().toLowerCase();
      const mimeType = SESSION_IMAGE_MIME_TYPE_BY_EXTENSION[extension];
      if (!mimeType) {
        throw new Error(`Unsupported image file extension: ${fileName}`);
      }

      const bytes = await handle.readFile();

      return {
        absolutePath,
        fileName,
        mimeType,
        sizeBytes: stat.size,
        bytes,
      };
    } finally {
      await handle.close();
    }
  }

  private async uploadSessionImageFile(args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    file: UploadableImageFile;
  }): Promise<UploadedSessionImage> {
    const serverBaseUrl = this.resolveServerBaseUrl();
    const uploadUrl = buildSessionImageApiUrl(
      serverBaseUrl,
      getSessionImageUploadApiPath(args.workspaceId)
    );

    const formData = new FormData();
    formData.set('sessionId', args.sessionId);
    const fileBytes = new Uint8Array(args.file.bytes.byteLength);
    fileBytes.set(args.file.bytes);
    formData.set('file', new Blob([fileBytes], { type: args.file.mimeType }), args.file.fileName);

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      const detail = errorBody ? `: ${errorBody.slice(0, 200)}` : '';
      throw new Error(`Failed to upload image (${response.status})${detail}`);
    }

    const responseBody = await response.json().catch(() => null);
    const parsed = SessionInputBlockSchema.safeParse(
      responseBody && typeof responseBody === 'object' && 'image' in responseBody
        ? (responseBody as Record<string, unknown>).image
        : undefined
    );
    if (!parsed.success || parsed.data.type !== 'image') {
      throw new Error('Invalid image upload payload');
    }

    const downloadUrl = buildSessionImageApiUrl(
      serverBaseUrl,
      getSessionImageDownloadApiPath(args.workspaceId, args.sessionId, parsed.data.imageId)
    );

    return {
      imageId: parsed.data.imageId,
      mimeType: parsed.data.mimeType,
      fileName: parsed.data.fileName,
      sizeBytes: parsed.data.sizeBytes,
      width: parsed.data.width,
      height: parsed.data.height,
      downloadUrl,
    };
  }

  private async appendAssistantImageGroupToActiveTurn(args: {
    sessionDoc: SessionDocument;
    turnId: string;
    content: SessionImageGroupContent;
  }): Promise<boolean> {
    let appended = false;
    await args.sessionDoc.updateHistory((history) => {
      for (const entry of history) {
        if (!entry || entry.id !== args.turnId || entry.role !== 'assistant') {
          continue;
        }

        const items = Array.isArray(entry.items) ? [...entry.items] : [];
        items.push(args.content as unknown as NonNullable<SessionHistoryInput['items']>[number]);
        entry.items = items as SessionHistoryInput['items'];
        appended = true;
        break;
      }
      return history;
    });
    return appended;
  }

  private async createAssistantImageGroupEntry(args: {
    sessionId: SessionId;
    sessionDoc: SessionDocument;
    content?: SessionImageGroupContent;
  }): Promise<string> {
    // Pushes a new history entry — subject to the same fast-path ordering gate.
    await this.awaitTurnHistoryGate(args.sessionId);
    const entryId = `assistant-image-${uuidV4()}`;
    const modelInfo = this.sessionManager.getSession(args.sessionId)?.agentClient?.currentModel;
    await args.sessionDoc.updateHistory((history) => {
      history.push({
        id: entryId,
        role: 'assistant',
        items: args.content
          ? ([args.content] as unknown as SessionHistoryInput['items'])
          : ([] as unknown as SessionHistoryInput['items']),
        timestamp: new Date().toISOString(),
        userId: undefined,
        read: undefined,
        modelInfo,
        fileDiff: [],
        finished: true,
      });
      return history;
    });
    return entryId;
  }

  private async replaceAssistantEntryItems(args: {
    sessionDoc: SessionDocument;
    entryId: string;
    content: SessionImageGroupContent;
  }): Promise<boolean> {
    let replaced = false;
    await args.sessionDoc.updateHistory((history) => {
      for (const entry of history) {
        if (!entry || entry.id !== args.entryId || entry.role !== 'assistant') {
          continue;
        }

        entry.items = [args.content] as unknown as SessionHistoryInput['items'];
        replaced = true;
        break;
      }
      return history;
    });
    return replaced;
  }

  private async removeHistoryEntryById(args: {
    sessionDoc: SessionDocument;
    entryId: string;
  }): Promise<boolean> {
    let removed = false;
    await args.sessionDoc.updateHistory((history) => {
      const nextHistory = history.filter((entry) => {
        if (!entry || entry.id !== args.entryId) {
          return true;
        }
        removed = true;
        return false;
      });
      return nextHistory;
    });
    return removed;
  }

  private async resolveSessionImageUploadAttachTarget(
    sessionId: SessionId,
    sessionDoc: SessionDocument
  ): Promise<SessionImageUploadAttachTarget> {
    const turnId = this.store.getTurnId(sessionId);
    if (turnId) {
      return { kind: 'active_turn', turnId };
    }

    const statusType = (await sessionDoc.getMetaState())?.status?.type;
    if (statusType === undefined || statusType === 'idle') {
      return { kind: 'new_entry' };
    }

    return {
      kind: 'unavailable',
      statusType,
    };
  }

  private async fetchSessionImageForPrompt(args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    imageId: string;
    expectedMimeType: string;
  }): Promise<DownloadedSessionImagePromptBlock> {
    return await downloadSessionImageForPrompt({
      ...args,
      serverBaseUrl: this.resolveServerBaseUrl(),
      token: this.token,
      logger: this.logger,
    });
  }

  /**
   * Resolve the workspace root where agent-facing files live for a session.
   * Prefers the host workdir (the directory the agent actually sees); falls back
   * to the execution workdir.
   */
  private resolveSessionWorkspaceRoot(sessionId: SessionId): string | null {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return null;
    }
    return session.getHostWorkdir() ?? session.getWorkdir();
  }

  private async ensureSessionAttachmentsDir(sessionId: SessionId): Promise<string | null> {
    const workspaceRoot = this.resolveSessionWorkspaceRoot(sessionId);
    if (!workspaceRoot) {
      this.logger.debug(
        `[${sessionId}] No workspace root resolved; cannot materialize attachments`
      );
      return null;
    }

    const attachmentsDir = path.join(workspaceRoot, ATTACHMENTS_DIR_RELATIVE);
    await fs.promises.mkdir(attachmentsDir, { recursive: true });

    // Keep `.lody/` out of git's untracked set so attachments don't pollute the
    // working tree (worktree-safe via `--git-path`). Best-effort.
    try {
      await ensureAttachmentsGitExcluded(workspaceRoot);
    } catch (error) {
      this.logger.debug(
        `[${sessionId}] Failed to update .git/info/exclude for attachments: ${formatErrorMessage(error)}`
      );
    }

    return attachmentsDir;
  }

  private resolveSessionImageAttachmentFileName(
    block: Extract<SessionInputBlock, { type: 'image' }>,
    mimeType: string
  ): string {
    const fileName = block.fileName?.trim();
    if (fileName) {
      return fileName;
    }

    const normalized = mimeType.trim().toLowerCase();
    let extension = '.img';
    switch (normalized) {
      case 'image/jpeg':
        extension = '.jpg';
        break;
      case 'image/png':
        extension = '.png';
        break;
      case 'image/gif':
        extension = '.gif';
        break;
      case 'image/webp':
        extension = '.webp';
        break;
      case 'image/heic':
        extension = '.heic';
        break;
      case 'image/heif':
        extension = '.heif';
        break;
      case 'image/svg+xml':
        extension = '.svg';
        break;
    }
    return `image-${block.imageId.slice(0, 8)}${extension}`;
  }

  private async materializeSessionImageAttachments(args: {
    sessionId: SessionId;
    imageBlocks: Array<{
      inputBlock: Extract<SessionInputBlock, { type: 'image' }>;
      downloaded: DownloadedSessionImagePromptBlock;
    }>;
  }): Promise<ContentBlock[]> {
    if (args.imageBlocks.length === 0) {
      return [];
    }

    let attachmentsDir: string | null;
    try {
      attachmentsDir = await this.ensureSessionAttachmentsDir(args.sessionId);
    } catch (error) {
      this.logger.debug(
        `[${args.sessionId}] Failed to prepare image attachment directory: ${formatErrorMessage(error)}`
      );
      return [];
    }
    if (!attachmentsDir) {
      return [];
    }

    const existingNames = new Set<string>();
    try {
      for (const entry of await fs.promises.readdir(attachmentsDir)) {
        existingNames.add(entry);
      }
    } catch {
      // Directory was just created; treat as empty.
    }

    const promptBlocks: ContentBlock[] = [];
    for (const { inputBlock, downloaded } of args.imageBlocks) {
      const sourceFileName = this.resolveSessionImageAttachmentFileName(
        inputBlock,
        downloaded.mimeType
      );
      const baseName = buildAttachmentFileName(inputBlock.imageId, sourceFileName);
      const basePath = path.join(attachmentsDir, baseName);
      const downloadedSha256 = crypto.createHash('sha256').update(downloaded.bytes).digest('hex');

      let alreadyPresent = false;
      try {
        const stat = await fs.promises.stat(basePath);
        if (stat.size === downloaded.sizeBytes) {
          const hash = crypto.createHash('sha256');
          for await (const chunk of fs.createReadStream(basePath)) {
            hash.update(chunk as Buffer);
          }
          alreadyPresent = hash.digest('hex').toLowerCase() === downloadedSha256.toLowerCase();
        }
      } catch {
        // Not present (or unreadable) → write below.
      }

      let materializedFileName = baseName;
      let destPath = basePath;
      if (alreadyPresent) {
        existingNames.add(baseName);
      } else {
        materializedFileName = buildAttachmentFileName(
          inputBlock.imageId,
          sourceFileName,
          existingNames
        );
        existingNames.add(materializedFileName);
        destPath = path.join(attachmentsDir, materializedFileName);
      }

      if (!alreadyPresent) {
        const tempPath = `${destPath}.${uuidV4()}.part`;
        try {
          await fs.promises.writeFile(tempPath, downloaded.bytes, { flag: 'wx' });
          await fs.promises.rename(tempPath, destPath);
        } catch (error) {
          await fs.promises.unlink(tempPath).catch(() => undefined);
          this.logger.debug(
            `[${args.sessionId}] Failed to materialize image attachment ${inputBlock.imageId}: ${formatErrorMessage(error)}`
          );
          continue;
        }
      }

      const relativePath = path.join(ATTACHMENTS_DIR_RELATIVE, materializedFileName);
      promptBlocks.push({
        type: 'resource_link',
        uri: pathToFileURL(destPath).href,
        name: sourceFileName,
        title: sourceFileName,
        mimeType: downloaded.mimeType || inputBlock.mimeType,
        size: downloaded.sizeBytes,
        description: buildAttachmentPromptText({
          fileName: sourceFileName,
          sizeBytes: downloaded.sizeBytes,
          mimeType: downloaded.mimeType || inputBlock.mimeType,
          relativePath,
        }),
      });
    }

    return promptBlocks;
  }

  /**
   * Copy a local-transport file blob (held by THIS machine) from the local blob
   * store to `destPath`, verifying sha256. Returns false if the blob is missing
   * or fails verification so the caller can fall back to the relay download path.
   * Streams to bound memory and renames atomically (matches the download path).
   */
  private async copyLocalSessionFileBlobToDisk(args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    fileId: string;
    expectedSha256?: string;
    destPath: string;
  }): Promise<boolean> {
    let blobPath: string;
    try {
      blobPath = getSessionFileBlobPath({
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        fileId: args.fileId,
      });
    } catch {
      return false;
    }

    const tempPath = `${args.destPath}.${uuidV4()}.part`;
    const hash = crypto.createHash('sha256');
    let source: fs.ReadStream;
    try {
      source = fs.createReadStream(blobPath);
    } catch {
      return false;
    }
    const fileHandle = await fs.promises.open(tempPath, 'wx');
    try {
      for await (const chunk of source) {
        const buf = chunk as Buffer;
        hash.update(buf);
        await fileHandle.write(buf);
      }
    } catch (error) {
      await fileHandle.close().catch(() => undefined);
      await fs.promises.unlink(tempPath).catch(() => undefined);
      this.logger.debug(
        `[${args.sessionId}] Local blob copy failed for ${args.fileId}: ${formatErrorMessage(error)}`
      );
      return false;
    }
    await fileHandle.close();

    if (args.expectedSha256) {
      const computed = hash.digest('hex');
      if (computed.toLowerCase() !== args.expectedSha256.toLowerCase()) {
        await fs.promises.unlink(tempPath).catch(() => undefined);
        this.logger.debug(`[${args.sessionId}] Local blob ${args.fileId} failed sha256 check`);
        return false;
      }
    }

    try {
      await fs.promises.rename(tempPath, args.destPath);
    } catch {
      await fs.promises.unlink(tempPath).catch(() => undefined);
      return false;
    }
    return true;
  }

  /**
   * Download a session file (transport: 'r2') to disk, streaming to bound
   * memory. Verifies sha256 if provided. Returns false on a 404 (file not yet
   * available) so the caller can inject a "not available" note instead of
   * failing the whole message.
   */
  private async downloadSessionFileToDisk(args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    fileId: string;
    expectedSha256?: string;
    destPath: string;
  }): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'error'; message: string }> {
    const serverBaseUrl = this.resolveServerBaseUrl();
    const fileUrl = buildSessionFileApiUrl(
      serverBaseUrl,
      getSessionFileDownloadApiPath(args.workspaceId, args.sessionId, args.fileId)
    );

    let response: Response;
    try {
      response = await fetch(fileUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch (error) {
      return { ok: false, reason: 'error', message: formatErrorMessage(error) };
    }

    if (response.status === 404) {
      return { ok: false, reason: 'not_found', message: 'File not available in relay store yet' };
    }
    if (!response.ok || !response.body) {
      const errorBody = await response.text().catch(() => '');
      const detail = errorBody ? `: ${errorBody.slice(0, 200)}` : '';
      return {
        ok: false,
        reason: 'error',
        message: `Failed to download file (${response.status})${detail}`,
      };
    }

    // Stream the body to a temp file, hashing as we go, then atomically rename.
    const tempPath = `${args.destPath}.${uuidV4()}.part`;
    const hash = crypto.createHash('sha256');
    const fileHandle = await fs.promises.open(tempPath, 'wx');
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value && value.length > 0) {
          hash.update(value);
          await fileHandle.write(value);
        }
      }
    } catch (error) {
      await fileHandle.close().catch(() => undefined);
      await fs.promises.unlink(tempPath).catch(() => undefined);
      return { ok: false, reason: 'error', message: formatErrorMessage(error) };
    }
    await fileHandle.close();

    if (args.expectedSha256) {
      const computed = hash.digest('hex');
      if (computed.toLowerCase() !== args.expectedSha256.toLowerCase()) {
        await fs.promises.unlink(tempPath).catch(() => undefined);
        return {
          ok: false,
          reason: 'error',
          message: 'Downloaded file failed sha256 verification',
        };
      }
    }

    try {
      await fs.promises.rename(tempPath, args.destPath);
    } catch (error) {
      await fs.promises.unlink(tempPath).catch(() => undefined);
      return { ok: false, reason: 'error', message: formatErrorMessage(error) };
    }

    return { ok: true };
  }

  /**
   * Materialize human→agent file attachments under
   * `<workspace>/.lody/attachments/<fileId8>-<sanitized name>` and return ACP
   * resource links that reference each by file URI. Idempotent:
   * an existing file whose sha256 matches is reused without re-downloading
   * (user-resend scenario). File contents are never inlined into the prompt.
   */
  private async materializeSessionFileAttachments(args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    fileBlocks: Extract<SessionInputBlock, { type: 'file' }>[];
  }): Promise<ContentBlock[]> {
    if (args.fileBlocks.length === 0) {
      return [];
    }

    const attachmentsDir = await this.ensureSessionAttachmentsDir(args.sessionId);
    if (!attachmentsDir) {
      return args.fileBlocks.map((block) => ({
        type: 'text',
        text: buildUnavailableAttachmentPromptText({
          fileName: block.fileName,
          sizeBytes: block.sizeBytes,
          mimeType: block.mimeType,
        }),
      }));
    }

    // Listing once up front lets buildAttachmentFileName resolve collisions
    // deterministically within this turn.
    const existingNames = new Set<string>();
    try {
      for (const entry of await fs.promises.readdir(attachmentsDir)) {
        existingNames.add(entry);
      }
    } catch {
      // Directory was just created; treat as empty.
    }

    const promptBlocks: ContentBlock[] = [];
    for (const block of args.fileBlocks) {
      const storageSessionId = block.storageSessionId ?? args.sessionId;
      // Deterministic name from fileId+fileName (no collision bump). A resend
      // lands on this same name, so the reuse check below can hit it; bumping
      // up front (against the disk-seeded `existingNames`) would always miss and
      // re-download into a duplicate `-1` copy.
      const baseName = buildAttachmentFileName(block.fileId, block.fileName);
      const basePath = path.join(attachmentsDir, baseName);

      // Idempotency: if the deterministic path already holds the exact bytes
      // (size + sha256), reuse it instead of re-downloading. Size precheck first
      // so a mismatch is never read; the hash is streamed so a matching 100 MB
      // file is never buffered.
      let alreadyPresent = false;
      try {
        const stat = await fs.promises.stat(basePath);
        if (stat.size === block.sizeBytes) {
          const hash = crypto.createHash('sha256');
          for await (const chunk of fs.createReadStream(basePath)) {
            hash.update(chunk as Buffer);
          }
          alreadyPresent = hash.digest('hex').toLowerCase() === block.sha256.toLowerCase();
        }
      } catch {
        // Not present (or unreadable) → download below.
      }

      // Reuse the deterministic name on a content match; otherwise resolve a
      // non-colliding name (bumps only on a genuine fileId8-prefix clash with
      // different content).
      let fileName = baseName;
      let destPath = basePath;
      if (alreadyPresent) {
        existingNames.add(baseName);
      } else {
        fileName = buildAttachmentFileName(block.fileId, block.fileName, existingNames);
        existingNames.add(fileName);
        destPath = path.join(attachmentsDir, fileName);
      }
      const relativePath = path.join(ATTACHMENTS_DIR_RELATIVE, fileName);

      if (!alreadyPresent) {
        // Local-transport blocks held by THIS machine are served from the local
        // blob store directly (no relay round trip): the desktop fast path means
        // the bytes are already on disk before backfill completes. Blocks held by
        // another machine (or already on r2) fall through to the HTTP path, where
        // a 404 from the not-yet-backfilled relay store yields "unavailable".
        const servedLocally =
          block.transport === 'local' &&
          block.machineId === this.machineId &&
          (await this.copyLocalSessionFileBlobToDisk({
            workspaceId: args.workspaceId,
            sessionId: storageSessionId,
            fileId: block.fileId,
            expectedSha256: block.sha256,
            destPath,
          }));

        if (!servedLocally) {
          const result = await this.downloadSessionFileToDisk({
            workspaceId: args.workspaceId,
            sessionId: storageSessionId,
            fileId: block.fileId,
            expectedSha256: block.sha256,
            destPath,
          });
          if (!result.ok) {
            this.logger.debug(
              `[${args.sessionId}] File attachment ${block.fileId} unavailable (${result.reason}): ${result.message}`
            );
            promptBlocks.push({
              type: 'text',
              text: buildUnavailableAttachmentPromptText({
                fileName: block.fileName,
                sizeBytes: block.sizeBytes,
                mimeType: block.mimeType,
              }),
            });
            continue;
          }
        }
      }

      // The dispatched message proves the block is persisted in history, which
      // is what the relay backfill needs to flip it — this is the reliable
      // enqueue point. (At handoff time the user hasn't sent the message yet,
      // so a backfill attempt would find no block.) The runner bails cheaply
      // if the blob is already gone (flipped earlier / cleaned up).
      if (block.transport === 'local' && block.machineId === this.machineId) {
        this.enqueueSessionFileBackfill(storageSessionId, block.fileId);
      }

      promptBlocks.push({
        type: 'resource_link',
        uri: pathToFileURL(destPath).href,
        name: block.fileName,
        title: block.fileName,
        mimeType: block.mimeType || 'application/octet-stream',
        size: block.sizeBytes,
        description: buildAttachmentPromptText({
          fileName: block.fileName,
          sizeBytes: block.sizeBytes,
          mimeType: block.mimeType,
          relativePath,
        }),
      });
    }

    return promptBlocks;
  }

  private async buildAcpPromptBlocks(args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    inputBlocks: SessionInputBlock[];
    issuePRMentions?: IssuePRMention[];
    replayPromptText?: string;
  }): Promise<ContentBlock[]> {
    const textParts: string[] = [];
    const imageInputBlocks: Extract<SessionInputBlock, { type: 'image' }>[] = [];
    const fileInputBlocks: Extract<SessionInputBlock, { type: 'file' }>[] = [];
    const commentRefTexts: string[] = [];
    const visualAnnotationRefTexts: string[] = [];

    for (const block of args.inputBlocks) {
      if (block.type === 'text') {
        const trimmed = block.text.trim();
        if (trimmed) {
          textParts.push(trimmed);
        }
        continue;
      }

      if (block.type === 'comment_reference') {
        commentRefTexts.push(formatCommentReferenceForPrompt(block));
        continue;
      }

      if (block.type === 'visual_annotation_reference') {
        visualAnnotationRefTexts.push(formatVisualAnnotationReferenceForPrompt(block));
        continue;
      }

      if (block.type === 'file') {
        fileInputBlocks.push(block);
        continue;
      }

      imageInputBlocks.push(block);
    }

    // Download prompt images in parallel so multi-image turns do not pay per-image RTT serially.
    const imagePromptAttachments = await Promise.all(
      imageInputBlocks.map(async (block) => {
        const downloaded = await this.fetchSessionImageForPrompt({
          workspaceId: args.workspaceId,
          sessionId: block.storageSessionId ?? args.sessionId,
          imageId: block.imageId,
          expectedMimeType: block.mimeType,
        });
        return { inputBlock: block, downloaded };
      })
    );
    const imageBlocks = imagePromptAttachments.map(({ downloaded }) => downloaded.block);

    // Keep ACP image blocks for visual context, and also expose the same bytes
    // through a baseline ACP resource_link so agents can read/re-upload the file
    // by path when they need to echo or transform it.
    const imageAttachmentBlocks = await this.materializeSessionImageAttachments({
      sessionId: args.sessionId,
      imageBlocks: imagePromptAttachments,
    });

    // Materialize human→agent file attachments under `<workspace>/.lody/attachments/`
    // and reference them with ACP resource links (never inline their contents).
    const fileAttachmentBlocks = await this.materializeSessionFileAttachments({
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      fileBlocks: fileInputBlocks,
    });

    // Build the full text prompt: comment references first, then user text
    const allTextParts = [...commentRefTexts, ...visualAnnotationRefTexts, ...textParts];
    const textPrompt = appendIssuePrMentionsToPrompt(
      allTextParts.join('\n\n'),
      args.issuePRMentions
    ).trim();

    const hasCurrentRequestContent =
      imageBlocks.length > 0 || fileAttachmentBlocks.length > 0 || textPrompt.length > 0;
    const replayText = args.replayPromptText?.trim() ?? '';

    const promptBlocks: ContentBlock[] = [];
    if (replayText) {
      promptBlocks.push({
        type: 'text',
        text: hasCurrentRequestContent ? `${replayText}\n\n=== Current Request ===` : replayText,
      });
    }

    promptBlocks.push(...imageBlocks);
    promptBlocks.push(...imageAttachmentBlocks);
    promptBlocks.push(...fileAttachmentBlocks);

    if (textPrompt) {
      promptBlocks.push({
        type: 'text',
        text: textPrompt,
      });
    }

    if (promptBlocks.length === 0) {
      throw new Error('Prompt content is empty');
    }

    return promptBlocks;
  }

  private async getLocalProjectGitStateForRpc(args: {
    localProjectId: LocalProjectId;
    requestedByUserId: string;
  }): Promise<LocalProjectGitStateRpcResponse> {
    const failure = (error: string, message: string): LocalProjectGitStateRpcResponse => ({
      type: 'local-project/git-state_response',
      machineId: this.machineId,
      workspaceId: this.workspaceId,
      localProjectId: args.localProjectId,
      success: false,
      error,
      message,
    });

    let access: Awaited<ReturnType<CloudPort['access']['verifyMachineAccess']>>;
    try {
      access = await this.cloudPort.access.verifyMachineAccess({
        workspaceId: this.workspaceId,
        machineId: this.machineId,
        requesterUserId: args.requestedByUserId,
        localProjectId: args.localProjectId,
      });
    } catch (error) {
      return failure('access_check_failed', formatErrorMessage(error));
    }

    if (!access.allowed) {
      return failure('access_denied', access.reason);
    }

    const rootPath = await resolveWorkspaceLocalProjectRootPathWithRetry(
      this.workspaceDocument.repo,
      this.workspaceId,
      this.machineId,
      args.localProjectId,
      {
        requestSync: () =>
          this.workspaceDocument.syncMachineFlockDoc(this.machineId, {
            reason: 'local-project-git-state-resolve',
            timeoutMs: readTimeoutEnv('LODY_LOCAL_PROJECT_RESOLVE_SYNC_TIMEOUT_MS', 1_500),
          }),
      }
    );
    if (!rootPath) {
      return failure('local_project_not_found', `Local project not found: ${args.localProjectId}`);
    }

    try {
      const state = await getLocalProjectGitStateAtRootPath(rootPath);
      return {
        type: 'local-project/git-state_response',
        machineId: this.machineId,
        workspaceId: this.workspaceId,
        localProjectId: args.localProjectId,
        success: true,
        state,
        observedAtMs: getServerNow(),
      };
    } catch (error) {
      return failure('git_state_failed', formatErrorMessage(error));
    }
  }

  private async verifyMachineAccess(args: {
    requesterUserId: string;
    sessionId: SessionId;
    localProjectId?: string;
    forceBackendVerification?: boolean;
  }): Promise<MachineAccessVerification> {
    // The daemon owner's token already authorizes their own machine. Other
    // workspace members require the backend visibility/project check.
    if (
      !args.forceBackendVerification &&
      args.requesterUserId &&
      args.requesterUserId === this.userId
    ) {
      return { outcome: 'allowed' };
    }
    try {
      const access = await this.cloudPort.access.verifyMachineAccess({
        workspaceId: this.workspaceId,
        machineId: this.machineId,
        requesterUserId: args.requesterUserId,
        localProjectId: args.localProjectId,
      });
      return access.allowed ? { outcome: 'allowed' } : { outcome: 'denied', reason: access.reason };
    } catch (error) {
      const message = formatErrorMessage(error);
      const cause = /unauthorized/i.test(message) ? ('auth' as const) : ('network' as const);
      this.logger.error(
        `[${args.sessionId}] Failed to verify machine access (${cause}): ${message}`
      );
      return { outcome: 'indeterminate', cause, error: message };
    }
  }

  private async verifySessionMachineAccess(
    sessionId: SessionId,
    requesterUserId: string
  ): Promise<MachineAccessVerification> {
    const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
    const meta = await sessionDoc.getMetaState();
    return await this.verifyMachineAccess({
      sessionId,
      requesterUserId,
      ...(meta?.project?.kind === 'local' ? { localProjectId: meta.project.localProjectId } : {}),
    });
  }

  private async prepareSessionWithAccessCheck(
    spec: SessionPreparationSpec
  ): Promise<SessionPrepareResponse> {
    const { sessionId } = spec;
    const access = await this.verifyMachineAccess({
      sessionId,
      requesterUserId: spec.requestedByUserId,
      ...(spec.project?.kind === 'local' ? { localProjectId: spec.project.localProjectId } : {}),
    });
    if (access.outcome !== 'allowed') {
      return {
        type: 'session/prepare_response',
        preparationId: spec.preparationId,
        sessionId,
        accepted: false,
        disposition: access.outcome === 'denied' ? 'not-owned' : 'error',
        error: access.outcome === 'denied' ? access.reason : access.error,
      };
    }
    return this.sessionManager.requestSessionPreparation(spec);
  }

  private async cancelSessionPreparationWithAccessCheck(
    args: SessionPreparationCancelSpec
  ): Promise<SessionPrepareCancelResponse> {
    const { sessionId } = args;
    const access = await this.verifyMachineAccess({
      sessionId,
      requesterUserId: args.requestedByUserId,
    });
    if (access.outcome !== 'allowed') {
      return {
        type: 'session/prepare-cancel_response',
        preparationId: args.preparationId,
        sessionId,
        cancelled: false,
        disposition: access.outcome === 'denied' ? 'not-owned' : 'error',
        error: access.outcome === 'denied' ? access.reason : access.error,
      };
    }
    return this.sessionManager.cancelSessionPreparation(args);
  }

  // Single access choke point for prompt-handoff steer: both RPC arrival paths
  // (Loro Streams deps callback and local Machine RPC switch) route through here
  // so neither can bypass machine/local-project verification.
  private async steerSessionWithAccessCheck(
    args: Parameters<SessionExecutionService['steerSession']>[0]
  ): ReturnType<SessionExecutionService['steerSession']> {
    const access = await this.verifySessionMachineAccess(args.sessionId, args.userId);
    if (access.outcome !== 'allowed') {
      return {
        type: 'session/steer_response',
        sessionId: args.sessionId,
        userTurnId: args.userTurnId,
        applied: false,
        disposition: 'error',
        error: `Steer access verification ${access.outcome}`,
      };
    }
    return await this.executionService.steerSession(args);
  }

  private async forkSessionWithAccessCheck(args: SessionForkSpec): Promise<SessionForkResponse> {
    const access = await this.verifySessionMachineAccess(
      args.sourceSessionId,
      args.requestedByUserId
    );
    if (access.outcome !== 'allowed') {
      return sessionForkFailure(
        args,
        'MACHINE_ACCESS_DENIED',
        `Fork access verification ${access.outcome}.`
      );
    }
    return await this.sessionForkService.fork(args);
  }

  private async editAndResendSessionWithAccessCheck(
    args: SessionEditAndResendInput
  ): Promise<SessionEditAndResendResponse> {
    const access = await this.verifySessionMachineAccess(args.sessionId, args.requestedByUserId);
    if (access.outcome !== 'allowed') {
      return sessionEditAndResendFailure(
        args,
        'MACHINE_ACCESS_DENIED',
        `Edit and resend access verification ${access.outcome}.`
      );
    }
    return await this.sessionEditAndResendService.editAndResend(args);
  }

  private async materializeOperationTarget(
    operation: StoredLodyOperation,
    item: Extract<LodyOperationItemResult, { status: 'active' }>,
    index: number
  ): Promise<void> {
    const root = operation.canonicalCommand;
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
      throw new Error(`Operation ${operation.operationId} has an invalid recovery Command.`);
    }
    const rootRecord = root as Record<string, unknown>;
    const selected = operation.kind.endsWith('_many')
      ? Array.isArray(rootRecord.items)
        ? rootRecord.items[index]
        : undefined
      : rootRecord;
    if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
      throw new Error(`Operation ${operation.operationId} item ${index} has no recovery input.`);
    }
    const command = selected as Record<string, unknown>;
    const prompt = typeof command.prompt === 'string' ? command.prompt : undefined;
    if (!prompt) {
      throw new Error(`Operation ${operation.operationId} item ${index} has no prompt.`);
    }

    const auth: AuthContext = {
      token: this.token,
      userId: this.userId,
      userName: this.userId,
      userEmail: buildMissingEmail('lody', this.userId),
      machineId: this.machineId,
      machineName: this.machineName,
    };
    const workspace = await resolveWorkspaceOrThrow(auth, this.workspaceId);
    const requesterRecord = await this.workspaceDocument.repo.getDocMeta(
      getSessionRoomId(operation.requesterSessionId)
    );
    if (!requesterRecord?.meta || isLoroRepoDocDeleted(requesterRecord)) {
      throw new Error(`Requester Session not found: ${operation.requesterSessionId}`);
    }
    const requester = requesterRecord.meta as SessionMeta;
    const delegatedRequester = operation.frozenContinuationConfig.sourceTurnId
      ? ({ userId: operation.requesterUserId } as const)
      : undefined;

    if (operation.kind === 'session_create' || operation.kind === 'session_create_many') {
      const runConfig: AgentRunConfigSelection = {
        ...(typeof command.modelId === 'string' ? { modelId: command.modelId } : {}),
        ...(typeof command.reasoningEffort === 'string'
          ? { reasoningEffort: command.reasoningEffort }
          : {}),
        ...(typeof command.fastMode === 'boolean' ? { fastMode: command.fastMode } : {}),
        ...(typeof command.planMode === 'boolean' ? { planMode: command.planMode } : {}),
      };
      const frozenTargetDispatchConfig =
        operation.frozenContinuationConfig.targetDispatchConfigs?.[index];
      const frozenInputConfig = operation.frozenContinuationConfig.inputConfig;
      const dispatchConfig =
        frozenTargetDispatchConfig ??
        ({
          frozenInheritedInputConfig: frozenInputConfig,
          inheritSessionDefaults: false,
          ...(hasAgentRunConfigSelection(runConfig) ? { runConfig } : {}),
        } satisfies ResolvedTurnDispatchConfig);
      const options: CreateOptions = {
        workspace: this.workspaceId,
        currentSessionId: operation.requesterSessionId,
        workspaceMetaPrewriteSatisfied: true,
        ...(delegatedRequester
          ? { delegatedRequester }
          : {
              requesterUserId: operation.requesterUserId,
              sessionOwnerUserId: requester.userId,
            }),
        defaultMachineId: requester.machineId,
        sessionId: item.target.sessionId,
        userTurnId: item.target.userTurnId,
        chainDepth: operation.initiatorChainDepth + 1,
        bypassSessionQuota: shouldBypassSessionQuota(operation.kind),
      };
      if (typeof command.machineId === 'string') options.machine = command.machineId;
      if (typeof command.agentConfigId === 'string') options.agentConfig = command.agentConfigId;
      if (typeof command.agentRoleId === 'string') options.agentRoleId = command.agentRoleId;
      if (typeof command.agentRoleRevision === 'number') {
        options.agentRoleRevision = command.agentRoleRevision;
      }
      if (typeof command.useCurrentSessionAsParent === 'boolean') {
        options.useCurrentSessionAsParent = command.useCurrentSessionAsParent;
      }
      const workContext = command.workContext;
      if (workContext && typeof workContext === 'object' && !Array.isArray(workContext)) {
        const context = workContext as Record<string, unknown>;
        if (context.kind === 'github' && typeof context.repo === 'string') {
          options.repo = context.repo;
        } else if (context.kind === 'local' && typeof context.projectId === 'string') {
          options.localProject = context.projectId;
          if (typeof context.worktree === 'boolean') options.worktree = context.worktree;
        }
        if (typeof context.branch === 'string') options.branch = context.branch;
      }
      await createSessionResult(
        auth,
        workspace,
        this.workspaceDocument,
        prompt,
        options,
        dispatchConfig
      );
      return;
    }

    await sendSessionChatResult(
      auth,
      workspace,
      this.workspaceDocument,
      item.target.sessionId,
      prompt,
      {
        ...resolveTurnDispatchConfig({}),
        taskToolsEnabled: operation.frozenContinuationConfig.inputConfig.taskToolsEnabled === true,
      },
      undefined,
      delegatedRequester ? undefined : operation.requesterUserId,
      {
        userTurnId: item.target.userTurnId,
        chainDepth: operation.initiatorChainDepth + 1,
        bypassSessionQuota: shouldBypassSessionQuota(operation.kind),
      },
      delegatedRequester
    );
  }

  constructor(
    sessionManager: SessionManager,
    protected workspaceDocument: LoroDocumentManager,
    logger: Logger,
    config: MessageHandlerConfig
  ) {
    this.sessionManager = sessionManager;
    // Create a child logger with workspace context for file logging
    this.logger = logger.child({
      workspaceName: config.workspaceSlug || config.workspaceId,
    });
    this.token = config.token;
    this.userId = config.userId;
    this.workspaceId = config.workspaceId;
    this.workspaceSlug = config.workspaceSlug;
    this.machineName = config.machineName;
    this.cliVersion = config.cliVersion;
    this.machineId = config.machineId as MachineId;
    this.sessionActivePresence = new SessionActivePresenceController(
      this.workspaceDocument,
      this.machineId,
      this.logger
    );
    this.supportRegistryAgentTypes = config.supportRegistryAgentTypes ?? [];
    this.closeSessionTerminals = config.closeSessionTerminals;
    this.cleanupLocalProjectWorktreeSetupIfUnreferenced =
      config.cleanupLocalProjectWorktreeSetupIfUnreferenced;
    this.onFatalAuthFailure = config.onFatalAuthFailure;
    this.localWorkspaceCatalog = config.localWorkspaceCatalog ?? makeLocalWorkspaceCatalog();
    this.onProcessLifecycleAction = config.onProcessLifecycleAction;
    this.machineLifecycleCapability = config.machineLifecycleCapability ?? {
      launchMode: 'foreground',
      canRemoteRestart: false,
      canRemoteUpgrade: false,
      reason: 'not_daemon',
    };
    this.logger.debug(
      `[machine-lifecycle] launchMode=${this.machineLifecycleCapability.launchMode} canRestart=${this.machineLifecycleCapability.canRemoteRestart} canUpgrade=${this.machineLifecycleCapability.canRemoteUpgrade}`
    );
    this.cloudPort = config.cloudPort;
    this.notificationService = this.cloudPort.notifications;
    this.usageTrackingService = this.cloudPort.usage;
    this.localProjectControlService = new LocalProjectControlService(this.logger);
    this.codeCollabV2DiffStore = new CodeCollabV2DiffStore(this.workspaceId);
    this.codeCollabV2Service = new CodeCollabV2Service({
      resolveWorkspace: this.resolveCodeCollabV2Workspace,
      diffStore: this.codeCollabV2DiffStore,
      workspaceId: this.workspaceId,
      workspaceWatchCoordinator: config.workspaceWatchCoordinator,
      publishFileIndex: async (state) => {
        const publishStartedAtMs = Date.now();
        const pathCount = Object.keys(state.fileIndex).length;
        const result = await publishCodeCollabFileIndexFlock({
          repo: this.workspaceDocument.repo,
          flockDocId: getCodeCollabFileIndexFlockDocId(this.workspaceId, state.ownerSessionId),
          fileIndex: state.fileIndex,
          updatedAtMs: state.updatedAtMs,
          reconcileRemote: state.reconcileRemote,
        });
        if (state.persistAllChangesDiffStats && state.allChangesDiffStats) {
          try {
            await this.persistCodeCollabAllChangesDiffStats(
              state.ownerSessionId,
              state.allChangesDiffStats
            );
          } catch (error) {
            this.logger.debug(
              `[code-collab-v2] Failed to persist All Changes diffStats ownerSessionId=${
                state.ownerSessionId
              }: ${formatErrorMessage(error)}`
            );
          }
        }
        this.logger.info(
          `[code-collab-v2] file-index flock publish completed ownerSessionId=${
            state.ownerSessionId
          } paths=${pathCount} changed=${result.changed} reconcileRemote=${
            state.reconcileRemote
          } durationMs=${Date.now() - publishStartedAtMs}`
        );
        return result;
      },
      publishFileIndexSignal: async (state) => {
        const publishStartedAtMs = Date.now();
        const result = await publishCodeCollabFileIndexSignalFlock({
          repo: this.workspaceDocument.repo,
          flockDocId: getCodeCollabFileIndexSignalFlockDocId(
            this.workspaceId,
            state.ownerSessionId
          ),
          updatedAtMs: state.updatedAtMs,
        });
        this.logger.info(
          `[code-collab-v2] file-index signal publish completed ownerSessionId=${
            state.ownerSessionId
          } revision=${result.revision} changed=${result.changed} durationMs=${
            Date.now() - publishStartedAtMs
          }`
        );
      },
    });
    this.filePreviewService = new FilePreviewService({
      resolveWorkspace: async (sessionId) => {
        const resolved = await this.resolveCodeCollabV2Workspace(sessionId);
        return resolved.ok
          ? {
              ok: true,
              ownerSessionId: resolved.ownerSessionId,
              workspaceRoot: resolved.workspaceRoot,
            }
          : { ok: false, code: resolved.code, message: resolved.message };
      },
    });
    this.sessionManager.setRequestPermissionHandler((sessionId, requestId, request, agentClient) =>
      this.handleAgentPermissionRequest(sessionId, requestId, request, agentClient?.currentModel)
    );
    this.autoPromptRunner = new AutoPromptRunner({
      workspaceId: this.workspaceId,
      beginConversationTurn: (sessionId, userTurnId) =>
        this.beginConversationTurn(sessionId, userTurnId),
      clearActiveTurnId: (sessionId, turnId) => this.clearActiveTurnIdIfMatches(sessionId, turnId),
      buildAcpPromptBlocks: async (args) => await this.buildAcpPromptBlocks(args),
      createAssistantEntryForTurn: async (sessionId, sessionDoc, turnId, modelInfo) =>
        await this.createAssistantEntryForTurn(sessionId, sessionDoc, turnId, modelInfo),
      finalizeACPState: async (sessionId) => await this.finalizeACPState(sessionId),
      flushSessionUsage: async (sessionId) => await this.flushSessionUsage(sessionId),
    });
    this.turnPostProcessingService = new TurnPostProcessingService({
      logger: this.logger,
      workspaceDocument: this.workspaceDocument,
      workspaceId: this.workspaceId,
      preferredBaseBranch: this.preferredBaseBranch,
      prAssociation: this.cloudPort.prAssociation,
      runAutoPrompt: async (ctx) => await this.autoPromptRunner.run(ctx),
    });
    this.executionService = new SessionExecutionService({
      logger: this.logger,
      sessionManager: this.sessionManager,
      workspaceDocument: this.workspaceDocument,
      machineId: this.machineId,
      userId: this.userId,
      workspaceId: this.workspaceId,
      preferredBaseBranch: this.preferredBaseBranch,
      touchSession: (sessionId) => this.touchSession(sessionId),
      startSessionActivePresence: (sessionId, phase) =>
        this.startSessionActivePresence(sessionId, phase),
      clearSessionActivePresence: (sessionId) => this.clearSessionActivePresence(sessionId),
      setSessionActivePresencePhase: (sessionId, phase, detail) =>
        this.setSessionActivePresencePhase(sessionId, phase, detail),
      beginACPReplaySuppression: (sessionId) => this.beginACPReplaySuppression(sessionId),
      endACPReplaySuppression: (sessionId) => this.endACPReplaySuppression(sessionId),
      beginConversationTurn: (sessionId, userTurnId, gateContext) =>
        this.beginConversationTurn(sessionId, userTurnId, gateContext),
      activateConversationTurnForACPUpdates: (sessionId, turnId) =>
        this.activateConversationTurnForACPUpdates(sessionId, turnId),
      clearConversationTurn: (sessionId, turnId) =>
        this.clearConversationTurnIfMatches(sessionId, turnId),
      getActiveTurnId: (sessionId) => this.store.getActiveTurnId(sessionId),
      clearActiveTurnId: (sessionId, turnId) => this.clearActiveTurnIdIfMatches(sessionId, turnId),
      hasPromptOutputForTurn: (sessionId, turnId) => this.hasPromptOutputForTurn(sessionId, turnId),
      observePromptOutputForTurn: (sessionId, turnId) =>
        this.observePromptOutputForTurn(sessionId, turnId),
      buildAcpPromptBlocks: async (args) => await this.buildAcpPromptBlocks(args),
      applyAcpModeAndModel: async (session, acpConfig, context) =>
        await this.applyAcpModeAndModel(
          session as {
            sessionId: SessionId;
            acpSessionId: ACPSessionId | null;
            agentClient: AgentClient | null;
          },
          acpConfig,
          context
        ),
      createAssistantEntryForTurn: async (sessionId, sessionDoc, turnId, modelInfo, userTurnId) =>
        await this.createAssistantEntryForTurn(
          sessionId,
          sessionDoc,
          turnId,
          modelInfo,
          userTurnId
        ),
      turnFinalization: {
        finalizeACPState: async (sessionId, turnId) =>
          await this.finalizeACPState(sessionId, turnId),
        persistCodeCollabTurnDiffs: async (sessionId, turnId) =>
          await this.persistCodeCollabTurnDiffs(sessionId, turnId),
        flushSessionUsage: async (sessionId) => await this.flushSessionUsage(sessionId),
        syncSessionBranchName: async (sessionId, session) =>
          await this.turnPostProcessingService.syncSessionBranchName(sessionId, session),
        updateSessionDiffStats: async (sessionId, session, options) =>
          await this.turnPostProcessingService.updateSessionDiffStats(sessionId, session, options),
        refreshCodeCollabSharedState: async (sessionId) =>
          await this.codeCollabV2Service.refreshSharedStateAfterTurn({ sessionId }),
        detectAndAssociatePR: async (ctx) =>
          await this.turnPostProcessingService.detectAndAssociatePR(ctx),
        autoCommitAndPushForPR: async (ctx) =>
          await this.turnPostProcessingService.autoCommitAndPushForPR(ctx),
        notifySessionCompleted: async (sessionId, userId, occurrenceId) =>
          await this.notifySessionCompleted(sessionId, userId, occurrenceId),
      },
      recordChatFailure: async (sessionDoc, reason, message, code) =>
        await this.recordChatFailure(sessionDoc, reason, message, code),
      maybeGenerateAndStoreSessionTitle: async (
        sessionId,
        cliType,
        agentType,
        prompt,
        env,
        customAcp,
        runtimeOverrides
      ) =>
        await this.maybeGenerateAndStoreSessionTitle(
          sessionId,
          cliType,
          agentType,
          prompt,
          env,
          customAcp,
          runtimeOverrides
        ),
      maybeRenameSessionBranchFromPrompt: async (
        sessionId,
        session,
        cliType,
        agentType,
        prompt,
        env
      ) =>
        await this.maybeRenameSessionBranchFromPrompt(
          sessionId,
          session,
          cliType,
          agentType,
          prompt,
          env
        ),
      processMessageQueue: async (sessionId) => await this.processMessageQueue(sessionId),
      syncLiveActivitySummary: async (userId) => {
        await this.syncLiveActivitySummary(userId);
      },
      collectMachineResources: async () => await this.collectMachineResources(),
      getMachineLifecycleCapability: () => this.machineLifecycleCapability,
      fetchAcpCapabilities: async (cliType, agentType, env, customAcp, runtimeOverrides, options) =>
        await this.fetchAcpCapabilities(
          cliType,
          agentType,
          env,
          customAcp,
          runtimeOverrides,
          options
        ),
      evictForMemoryPressure: async (excludeSessionId) =>
        await this.evictForMemoryPressureFn(excludeSessionId),
    });
    this.providerSetupManager = new ProviderSetupManager({
      repo: this.workspaceDocument.repo,
      workspaceId: this.workspaceId,
      machineId: this.machineId,
      execution: this.executionService,
      sync: this.workspaceDocument,
      logger: this.logger,
    });
    this.machineFlockCommandWatcher = new MachineFlockCommandWatcher({
      repo: this.workspaceDocument.repo,
      docId: this.getMachineFlockDocIdForMachine(),
      logContext: this.getMachineFlockLogContext(),
      waitForRemoteAuthority: this.cloudPort.kind !== 'local',
      logger: this.logger,
      onEvents: (events, { authoritative }) =>
        this.rescanMachineCommands(getMachineCommandEventImpact(events), authoritative),
      onReady: () => this.rescanMachineCommands(),
    });
    this.previewService = new PreviewService({
      logger: this.logger,
      workspaceDocument: this.workspaceDocument,
      machineId: this.machineId,
      workspaceId: this.workspaceId,
      userId: this.userId,
      authToken: () => this.token,
      remoteGatewayUrl: this.cloudPort.remotePreview?.gatewayBaseUrl ?? null,
    });
    const streamsTokens = this.cloudPort.streamsTokens;
    if (streamsTokens) {
      const cliHttpFetch = getCliHttpFetch({ logger: this.logger });
      const rpcConnectTimeoutMs = readTimeoutEnv('LODY_LORO_RPC_CONNECT_TIMEOUT_MS', 30_000);
      this.logger.debug(
        `[rpc-server:${this.machineId}] using Loro Streams RPC connect timeout ${rpcConnectTimeoutMs}ms`
      );
      const streamsTokenProvider = streamsTokens.createTokenProvider({
        workspaceId: this.workspaceId,
      });
      this.machineRpcTokenProvider = streamsTokenProvider;
      const jsonStreamClient = createLoroStreamsJsonStreamClient({
        bucketId: LORO_STREAMS_BUCKET_ID,
        getToken: async () => await streamsTokenProvider.getToken(),
        getBaseUrl: () =>
          streamsTokenProvider.getGatewayBaseUrl() ?? this.machineRpcGatewayBaseUrl ?? undefined,
        fetchImpl: cliHttpFetch,
        timeout: {
          connectTimeoutMs: rpcConnectTimeoutMs,
        },
      });
      this.machineRpcServer = new LoroStreamsMachineRpcServer({
        logger: this.logger,
        workspaceId: this.workspaceId,
        machineId: this.machineId,
        streamClient: jsonStreamClient,
        rpcVersion: LORO_STREAMS_RPC_VERSION,
        retentionSeconds: LORO_STREAMS_RPC_RETENTION_SECONDS,
        now: getServerNow,
        getMachineStatus: async () =>
          await this.executionService.getMachineStatus({
            type: 'machine/status',
            machineId: this.machineId,
            workspaceId: this.workspaceId,
          }),
        pingMachine: async ({ requestId }) =>
          await this.executionService.pingMachine({
            type: 'machine/ping',
            machineId: this.machineId,
            workspaceId: this.workspaceId,
            requestId,
          }),
        restartMachine: async ({ requesterUserId, requestToken, requestId }) =>
          await this.prepareMachineRestart({
            requesterUserId,
            requestToken,
            requestId,
          }),
        upgradeMachine: async ({ requesterUserId, requestToken, requestId, targetVersion }) =>
          await this.prepareMachineUpgrade({
            requesterUserId,
            requestToken,
            requestId,
            targetVersion,
          }),
        onMachineLifecycleResponseAppended: ({ response }) => {
          if (response.accepted) {
            this.triggerPendingProcessLifecycleAction(response.requestId);
          }
        },
        refreshMachineAcpCapabilities: async ({ configId, onAcpBinaryProgress, signal }) =>
          await this.executionService.refreshMachineAcpCapabilities(
            {
              type: 'machine/acp-capabilities-refresh',
              machineId: this.machineId,
              workspaceId: this.workspaceId,
              configId,
            },
            { onAcpBinaryProgress, signal }
          ),
        authenticateMachineAcp: async (args) => {
          const common = {
            type: 'machine/acp-authenticate' as const,
            machineId: this.machineId,
            workspaceId: this.workspaceId,
            requestId: args.requestId,
          };
          const message: MachineAcpAuthenticateRequestValidated = (() => {
            switch (args.action) {
              case 'start':
                return { ...common, action: args.action, configId: args.configId };
              case 'cancel':
                return {
                  ...common,
                  action: args.action,
                  authenticationRequestId: args.authenticationRequestId,
                };
              case 'submit-code':
                return {
                  ...common,
                  action: args.action,
                  authenticationRequestId: args.authenticationRequestId,
                  authorizationCode: args.authorizationCode,
                };
              case 'submit-input':
                return {
                  ...common,
                  action: args.action,
                  authenticationRequestId: args.authenticationRequestId,
                  interactionId: args.interactionId,
                  authenticationInput: args.authenticationInput,
                };
              default:
                throw new Error('Unsupported ACP authentication action');
            }
          })();
          return await this.authenticateMachineAcpAndResumeSetup(message, {
            onProgress: args.onProgress,
          });
        },
        getMachineAcpBinaryStatus: async ({ agentType }) =>
          await this.executionService.getMachineAcpBinaryStatus({
            type: 'machine/acp-binary-status',
            machineId: this.machineId,
            workspaceId: this.workspaceId,
            agentType,
          }),
        installMachineAcpBinary: async ({ agentType, onAcpBinaryProgress }) =>
          await this.executionService.installMachineAcpBinary(
            {
              type: 'machine/acp-binary-install',
              machineId: this.machineId,
              workspaceId: this.workspaceId,
              agentType,
            },
            { onAcpBinaryProgress }
          ),
        submitBugReport: async ({ description, reporterUserId, requestToken }) => {
          if (!this.cloudPort.bugReports) {
            return {
              type: 'machine/bug-report_response' as const,
              machineId: this.machineId,
              success: false,
              error: 'Bug reporting is unavailable on this platform.',
            };
          }
          return await this.cloudPort.bugReports.submit({
            workspaceId: this.workspaceId,
            machineId: this.machineId,
            description,
            reporterUserId,
            requestToken,
            machineUserId: this.userId,
          });
        },
        cancelSession: async ({ sessionId, turnId }) => {
          const result = await this.executionService.cancelSession({
            type: 'session/cancel',
            machineId: this.machineId,
            workspaceId: this.workspaceId,
            sessionId,
            turnId,
          });
          return {
            type: 'session/cancel_response' as const,
            sessionId,
            success: result.success,
            error: result.error,
          };
        },
        getSessionLiveStatus: async ({ sessionId }) => {
          const liveStatus = resolveSessionLiveStatus({
            presence: this.sessionActivePresence.getStatus(sessionId),
            execution: this.executionService.getExecutionSnapshot(sessionId),
            hasPendingDispatch: this.sessionDispatchWatcher.hasPendingDispatch(sessionId),
          });
          return {
            type: 'session/live-status_response' as const,
            machineId: this.machineId,
            sessionId,
            success: true,
            ...liveStatus,
            observedAtMs: getServerNow(),
          };
        },
        steerSession: async (args) => await this.steerSessionWithAccessCheck(args),
        terminateSession: async ({ sessionId }) => await this.terminateAcpSession(sessionId),
        forkSession: async (args) => await this.forkSessionWithAccessCheck(args),
        editAndResendSession: async (args) => await this.editAndResendSessionWithAccessCheck(args),
        dispatchSessionTurn: async ({ sessionId, userTurnId, userId, timestamp, inputConfig }) => {
          const disposition = await this.sessionDispatchWatcher.offerRpcTurn({
            sessionId,
            userTurnId,
            userId,
            timestamp,
            inputConfig,
          });
          return {
            type: 'session/dispatch-turn_response' as const,
            sessionId,
            userTurnId,
            accepted:
              disposition === 'accepted' ||
              disposition === 'duplicate' ||
              disposition === 'already-terminal',
            disposition,
          };
        },
        prepareSession: async (spec) => await this.prepareSessionWithAccessCheck(spec),
        cancelSessionPreparation: async (args) =>
          await this.cancelSessionPreparationWithAccessCheck(args),
        resolveCodeCollabOwnerSessionId: this.resolveCodeCollabV2OwnerSessionId,
        previewFile: async (request) => await this.filePreviewService.previewFile(request),
        openCodeCollabText: async (request) => await this.codeCollabV2Service.openText(request),
        refreshCodeCollabText: async (request) =>
          await this.codeCollabV2Service.refreshText(request),
        saveCodeCollabText: async (request) => await this.codeCollabV2Service.saveText(request),
        openCodeCollabCurrentDiff: async (request) =>
          await this.codeCollabV2Service.openCurrentDiff(request),
        openCodeCollabAllChangesDiff: async (request) =>
          await this.codeCollabV2Service.openAllChangesDiff(request),
        openCodeCollabTurnDiff: async (request) =>
          await this.codeCollabV2Service.openTurnDiff(request),
        initCodeCollabDirectory: async (request) =>
          await this.codeCollabV2Service.initDirectory(request),
        getCodeCollabLspDefinition: async () => await this.codeCollabV2Service.lspDefinition(),
        getCodeCollabLspReferences: async () => await this.codeCollabV2Service.lspReferences(),
        createSessionPreview: async ({
          sessionId,
          requestedByUserId,
          target,
          approval,
          replaceExisting,
        }) =>
          await this.previewService.createPreview({
            type: 'session/preview-create',
            machineId: this.machineId,
            workspaceId: this.workspaceId,
            sessionId,
            requestedByUserId,
            target,
            approval,
            replaceExisting,
          }),
        revokeSessionPreview: async ({ sessionId, requestedByUserId, reason }) =>
          await this.previewService.revokePreview({
            type: 'session/preview-revoke',
            machineId: this.machineId,
            workspaceId: this.workspaceId,
            sessionId,
            requestedByUserId,
            reason,
          }),
        getLocalProjectGitState: async ({ localProjectId, requestedByUserId }) =>
          await this.getLocalProjectGitStateForRpc({
            localProjectId,
            requestedByUserId,
          }),
        dispatchLocalProjectControl: async (request) =>
          await this.dispatchLocalProjectControlViaRpc(request),
        onFatalAuthFailure: (error) => this.onFatalAuthFailure?.(error),
      });
    } else {
      this.logger.debug('Streams RPC disabled: cloud Streams port unavailable');
    }
    // One resolver instance (and one profile cache) for both the dispatch
    // watcher and the Operation coordinator: both need the requesting user's
    // real commit identity, and both must go through the CLI-token query.
    this.sessionUserResolver = new SessionUserResolver(
      this.logger,
      this.workspaceId,
      async (userId) =>
        await this.cloudPort.access.resolveWorkspaceUser({
          workspaceId: this.workspaceId,
          userId,
        })
    );
    this.sessionDispatchWatcher = new SessionDispatchWatcher({
      logger: this.logger,
      machineId: this.machineId,
      workspaceId: this.workspaceId,
      currentUserId: this.userId,
      userResolver: this.sessionUserResolver,
      workspaceDocument: this.workspaceDocument,
      executionService: this.executionService,
      getPreparedSessionLaunchConfig: (input) =>
        this.sessionManager.getPreparedSessionLaunchConfig(input),
      accessPolicy: makeSessionAccessPolicy(this.localWorkspaceCatalog),
      canUseMachine: async (args) => await this.verifyMachineAccess(args),
      // P5/D11 snapshot bookkeeping for the watcher's background owner
      // recheck. Only confirmed online verdicts reach this: an allow refreshes
      // the optimistic-allow snapshot (the sole writer of `verifiedAt`), a
      // definitive deny clears the cached allow so the next dispatch falls
      // back to remote verification instead of trusting a revoked cache.
      recordOwnerAccessSnapshot: async (verdict) => {
        if (verdict === 'allowed') {
          await this.recordOwnerAccessAllowedSnapshot();
          return;
        }
        await this.recordWorkspaceAccessSnapshot(null);
      },
      recordChatFailure: async (sessionDoc, reason, message) =>
        await this.recordChatFailure(sessionDoc, reason, message),
      onStartupBootstrapComplete: () => {
        void this.resetMachineDisconnectedSessionsToIdle().catch((error: unknown) => {
          this.logger.debug(
            `[dispatch] Failed to reset stale sessions after startup bootstrap: ${formatErrorMessage(
              error,
              { includeStack: true }
            )}`
          );
        });
      },
      onFatalAuthFailure: (error) => this.onFatalAuthFailure?.(error),
    });
    this.sessionForkService = new SessionForkService({
      workspaceDocument: this.workspaceDocument,
      sessionManager: this.sessionManager,
      userResolver: this.sessionUserResolver,
      logger: this.logger,
      workspaceId: this.workspaceId,
      machineId: this.machineId,
      forkOperationStore: createFileSessionForkOperationStore(),
      isSourceBusy: (sessionId) => {
        const live = resolveSessionLiveStatus({
          presence: this.sessionActivePresence.getStatus(sessionId),
          execution: this.executionService.getExecutionSnapshot(sessionId),
          hasPendingDispatch: this.sessionDispatchWatcher.hasPendingDispatch(sessionId),
        });
        return live.state !== 'unknown';
      },
    });
    void this.sessionForkService.recoverPendingForks().catch((error: unknown) => {
      this.logger.debug(
        `[session-fork] Failed to recover pending forks: ${formatErrorMessage(error)}`
      );
    });
    this.sessionEditAndResendService = new SessionEditAndResendService({
      workspaceDocument: this.workspaceDocument,
      sessionManager: this.sessionManager,
      executionService: this.executionService,
      userResolver: this.sessionUserResolver,
      logger: this.logger,
      workspaceId: this.workspaceId,
      machineId: this.machineId,
      enqueueDispatch: (sessionId) => {
        void this.sessionDispatchWatcher.enqueueSessionCheck(sessionId);
      },
    });
    this.operationCoordinator = new LodyOperationCoordinator({
      workspaceId: this.workspaceId,
      machineId: this.machineId,
      userId: this.userId,
      workspaceDocument: this.workspaceDocument,
      executionService: this.executionService,
      dispatchWatcher: this.sessionDispatchWatcher,
      userResolver: this.sessionUserResolver,
      logger: this.logger,
      materializeTarget: async (operation, item, index) =>
        await this.materializeOperationTarget(operation, item, index),
    });

    this.setupSessionEventHandlers();
    // Machine registration is triggered by the runtime only after SessionManager is initialized.
    // This prevents dispatch from racing ahead of local session startup prerequisites.
    this.setupArchiveWatcher();
    this.setupDeleteWatcher();
    void this.machineFlockCommandWatcher.start();
  }

  /**
   * Ensure the machine metadata exists after reconnect.
   * Useful when the runtime disconnects during transport churn and the CRDT
   * metadata was not updated locally.
   */
  async ensureMachineRegistered(): Promise<void> {
    try {
      const machineRoomId = getMachineRoomId(this.machineId);
      const machineMeta = (await this.workspaceDocument.repo.getDocMeta(machineRoomId))?.meta as
        | MachineMeta
        | undefined;
      const supportsStreamsRpc = !!this.machineRpcServer;

      const hasMeta = !!machineMeta;

      if (hasMeta) {
        await this.publishMachineDotlodyPath();
        this.logger.debug('Machine already registered in machine meta after reconnect');
        return;
      }

      this.logger.debug('Machine not present after reconnect, re-registering');
      await this.workspaceDocument.registerMachine(this.machineId, {
        id: this.machineId,
        name: this.machineName,
        ownerUserId: this.userId,
        hostType: 'user',
        cliVersion: this.cliVersion,
        os: process.platform,
        rpcVersion: supportsStreamsRpc ? LORO_STREAMS_RPC_VERSION : undefined,
        supportsLocalProjectHistoryRpc: supportsStreamsRpc,
        protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
        supportRegistryAgentTypes: this.supportRegistryAgentTypes,
        sessions: [],
      });
      await this.publishMachineDotlodyPath();
      void this.attemptMachineAccessRegistration();
      this.logger.debug('Machine re-registered in machine meta');
    } catch (error) {
      this.logger.error(`Failed to ensure machine registration after reconnect: ${error}`);
    }
  }

  /**
   * After reconnect, reset stale sessions owned by this machine back to idle.
   *
   * Only resets sessions that:
   * 1. Are owned by this machine
   * 2. Are not already idle
   * 3. Have no local active presence (agent is no longer running)
   *
   * Sessions with local active presence are still actively running and should NOT be reset,
   * as that would cause overlapping turns if the UI sends a new prompt.
   */
  async resetMachineDisconnectedSessionsToIdle(): Promise<void> {
    const sessionIds = [...this.workspaceDocument.sessions.keys()];
    if (sessionIds.length === 0) {
      return;
    }

    let resetCount = 0;
    for (const sessionId of sessionIds) {
      try {
        const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
        const meta = await sessionDoc.getMetaState();
        if (!meta) continue;
        if (meta.machineId !== this.machineId) continue;
        // Skip sessions that are already idle
        if (meta.status?.type === 'idle') continue;
        // Skip sessions that are still actively running locally.
        if (this.hasSessionActivePresence(sessionId)) continue;

        await sessionDoc.setStatus(SessionStatusFactory.idle());
        resetCount += 1;
      } catch (error) {
        this.logger.debug(
          `[${sessionId}] Failed to reset stale session status after reconnect: ${error}`
        );
      }
    }

    if (resetCount > 0) {
      this.logger.debug(`Reset ${resetCount} stale sessions to idle after reconnect`);
    }
  }

  /**
   * Wire session runtime events into doc/history updates.
   */
  private setupSessionEventHandlers(): void {
    // Session stdout/stderr (best-effort logging).
    this.sessionManager.on('output', (output) => {
      this.logger.debug(`Output from session [${output.sessionId}]: <${output.data.length} bytes>`);
    });

    // ACP updates are delivered out-of-band from the agent process and must be merged into the
    // session history. We buffer them briefly to reduce the number of CRDT writes.
    this.sessionManager.on('onACPUpdateMessage', (sessionId, update) => {
      this.enqueueACPUpdate(sessionId, update);
    });

    this.sessionManager.on('onWriteTextFile', (sessionId, event) => {
      this.trackCodeCollabEvidenceWrite(
        sessionId,
        this.collectCodeCollabWriteTextFileEvidence(sessionId, event)
      );
    });

    this.sessionManager.on('onUsageUpdate', ({ sessionId, acpSessionId, usage }) => {
      const promise = this.handleUsageUpdate(sessionId, acpSessionId, usage);
      const usageState = this.store.get(sessionId);
      usageState.pendingUsageHandlers.add(promise);
      void promise.finally(() => {
        usageState.pendingUsageHandlers.delete(promise);
      });
    });

    this.sessionManager.on('onContextWindowUsageUpdate', (sessionId, usage) => {
      this.enqueueContextWindowUsageUpdate(sessionId, usage);
    });

    this.sessionManager.on(
      'onRateLimitUpdate',
      (machineId: MachineId, cliType: CliType, limits: RateLimit) => {
        void this.workspaceDocument.updateRateLimits(machineId, cliType, limits);
      }
    );

    this.sessionManager.on('onThreadGoalUpdated', (sessionId, goal) => {
      this.enqueueSessionNoticeHistoryPersist(sessionId, () =>
        this.persistThreadGoalUpdate(sessionId, goal)
      );
    });

    this.sessionManager.on('onThreadGoalCleared', (sessionId, threadId) => {
      this.enqueueSessionNoticeHistoryPersist(sessionId, () =>
        this.persistThreadGoalClear(sessionId, threadId)
      );
    });

    this.sessionManager.on('onSessionTitleUpdate', (sessionId, title) => {
      void this.maybeStoreAgentSessionTitle(sessionId, title);
    });

    this.sessionManager.on('onAgentWarning', (sessionId, warning) => {
      this.enqueueSessionNoticeHistoryPersist(sessionId, () =>
        this.recordAgentWarning(sessionId, warning)
      );
    });

    this.sessionManager.on('onImageGenerationBegin', (sessionId, event) => {
      this.handleImageGenerationBegin(sessionId, event);
    });

    this.sessionManager.on('onImageGenerationEnd', (sessionId, event) => {
      this.handleImageGenerationEnd(sessionId, event);
    });

    // Session error: flush ACP updates first, then set to idle (error is turn-level, recorded in history).
    this.sessionManager.on('error', (event) => {
      void (async () => {
        this.logger.error(`[${event.sessionId}] Session error event received:`, event);
        const sessionId = event.sessionId;
        this.clearSessionActivePresence(sessionId);
        await this.finalizeACPState(sessionId);
        await this.flushSessionUsage(sessionId);
        const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
        await sessionDoc.setStatus(SessionStatusFactory.idle());
        this.logger.debug(`[${sessionId}] Status set to idle (via error event)`);
      })();
    });

    // Session exit: flush ACP updates before marking idle.
    this.sessionManager.on('exit', (exit) => {
      void (async () => {
        const sessionId = exit.sessionId;
        this.logger.debug(`[${sessionId}] Session exit event received (exitCode=${exit.exitCode})`);
        if (!this.store.has(sessionId)) {
          this.logger.debug(`[${sessionId}] Ignoring exit event for GC-cleaned session`);
          return;
        }
        this.clearSessionActivePresence(sessionId);
        await this.finalizeACPState(sessionId);
        await this.flushSessionUsage(sessionId);
        const session = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
        await session.setStatus(SessionStatusFactory.idle());
        this.logger.debug(`[${sessionId}] Status set to idle (via exit event)`);
      })();
    });

    // Session termination can race with exit/error; always flush ACP updates first.
    // Skip if session was already cleaned by GC to avoid re-creating transient state.
    this.sessionManager.on('terminated', (event) => {
      this.codeCollabV2Service.releaseWorkspaceWatchForOwner(event.sessionId);
      void (async () => {
        const sessionId = event.sessionId;
        if (!this.store.has(sessionId)) {
          this.logger.debug(`[${sessionId}] Ignoring terminated event for GC-cleaned session`);
          return;
        }
        try {
          this.clearSessionActivePresence(sessionId);
          await this.finalizeACPState(sessionId);
          await this.flushSessionUsage(sessionId);
        } catch (error) {
          this.logger.error(
            `[${sessionId}] Failed to handle termination event: ${formatErrorMessage(error)}`
          );
        }
      })();
    });
  }

  private getMachineFlockDocIdForMachine(): string {
    return getMachineFlockDocId(this.workspaceId, this.machineId);
  }

  private getMachineFlockLogContext(): string {
    const docId = this.getMachineFlockDocIdForMachine();
    return `workspaceId=${this.workspaceId}, machineId=${this.machineId}, docId=${docId}`;
  }

  /**
   * Drains the durable Machine Flock command queues.
   *
   * `impact` narrows the drain to the families a live event actually touched;
   * an authoritative rejoin passes nothing and rescans everything, which is the
   * only retry path for a queue whose earlier drain threw. Keep both callers on
   * this one method: a new command family that reaches the event path but not
   * the rejoin path fails silently — its queue simply never drains again.
   */
  private rescanMachineCommands(
    impact?: ReturnType<typeof getMachineCommandEventImpact>,
    authoritative = true
  ): void {
    if (!impact || impact.archive) void this.processArchiveRequests();
    if (!impact || impact.delete) void this.processDeleteRequests();
    if (!impact || impact.deleteLocalProject) void this.processDeleteLocalProjectRequests();
    // A stale local setup row must not outrun a remote cancellation, so provider
    // setup drains only once the command room has established remote authority.
    if ((!impact || impact.providerSetup) && authoritative) {
      void this.providerSetupManager.kick();
    }
  }

  private async readMachineFlockCommandRows(): Promise<MachineFlockRowMap> {
    const handle = await this.workspaceDocument.repo.openFlockDoc(
      this.getMachineFlockDocIdForMachine()
    );
    return readMachineFlockRowsFromFlock(handle.flock, {
      families: ['archiveSessionCommand', 'deleteSessionCommand', 'deleteLocalProjectCommand'],
    });
  }

  private async tryReadMachineFlockCommandRows(): Promise<MachineFlockRowMap> {
    try {
      return await this.readMachineFlockCommandRows();
    } catch (error) {
      this.logger.debug(
        `[machine-flock] Failed to read command rows; falling back to machine meta queues (${this.getMachineFlockLogContext()}): ${formatErrorMessage(
          error,
          { includeStack: true }
        )}`
      );
      return {} as MachineFlockRowMap;
    }
  }

  private async readMachineCommandSnapshot(): Promise<MachineCommandSnapshot> {
    const machineRoomId = getMachineRoomId(this.machineId);
    const [machineMetaDoc, machineFlockRows] = await Promise.all([
      this.workspaceDocument.repo.getDocMeta(machineRoomId),
      this.tryReadMachineFlockCommandRows(),
    ]);
    return buildMachineCommandSnapshot(
      machineMetaDoc?.meta as MachineLegacyMetaFields | undefined,
      machineFlockRows
    );
  }

  private async deleteMachineFlockCommandRow(
    key: MachineFlockKey,
    nowMs = getServerNow()
  ): Promise<boolean> {
    const handle = await this.workspaceDocument.repo.openFlockDoc(
      this.getMachineFlockDocIdForMachine()
    );
    const changed = deleteMachineFlockRowFromFlock(handle.flock, key, nowMs);
    if (!changed) {
      return false;
    }
    await this.workspaceDocument.repo.flush();
    this.workspaceDocument.markMachineFlockDocDirty(this.machineId, {
      reason: 'command-row-delete',
    });
    return true;
  }

  private async writeMachineFlockRow(
    row: MachineFlockRow,
    nowMs = getServerNow()
  ): Promise<boolean> {
    const handle = await this.workspaceDocument.repo.openFlockDoc(
      this.getMachineFlockDocIdForMachine()
    );
    const changed = writeMachineFlockRowToFlock(handle.flock, row, nowMs);
    if (!changed) {
      return false;
    }
    await this.workspaceDocument.repo.flush();
    this.workspaceDocument.markMachineFlockDocDirty(this.machineId, {
      reason: 'machine-row-write',
    });
    return true;
  }

  private async publishMachineDotlodyPath(): Promise<void> {
    try {
      await this.writeMachineFlockRow({
        key: machineFlockKeys.dotlodyPath(),
        value: getLodyDataDir(),
      });
    } catch (error) {
      this.logger.debug(
        `[machine-flock] Failed to publish dotlodyPath (${this.getMachineFlockLogContext()}): ${formatErrorMessage(
          error,
          { includeStack: true }
        )}`
      );
    }
  }

  private setupArchiveWatcher(): void {
    if (this.archiveWatchHandle) {
      return;
    }
    const machineRoomId = getMachineRoomId(this.machineId);
    this.archiveWatchHandle = this.workspaceDocument.repo.watch(
      (event) => {
        if (event.kind !== 'doc-metadata') return;
        if (event.docId !== machineRoomId) return;
        this.logger.debug(`[archive] Machine meta updated (docId=${machineRoomId})`);
        void this.processArchiveRequests();
      },
      {
        docIds: [machineRoomId],
        kinds: ['doc-metadata'],
        metadataFields: ['needToArchiveSessions'],
      }
    );
    this.logger.debug(`[archive] Archive watcher registered (docId=${machineRoomId})`);
    void this.processArchiveRequests();
  }

  private async processArchiveRequests(): Promise<void> {
    const snapshot = await this.readMachineCommandSnapshot();
    const sessionIds = snapshot.archiveSessionIds;
    if (sessionIds.length === 0) {
      this.logger.debug('[archive] No pending archive requests');
      return;
    }

    this.logger.debug(`[archive] Processing ${sessionIds.length} archive request(s)`);
    for (const sessionId of sessionIds) {
      if (snapshot.deleteSessionIds.has(sessionId)) {
        this.logger.debug(
          `[archive] Skipping archive for ${sessionId} (session is queued for deletion)`
        );
        await this.removeArchiveRequest(sessionId);
        continue;
      }
      if (this.archiveInFlight.has(sessionId)) {
        this.logger.debug(`[archive] Session ${sessionId} already in progress`);
        continue;
      }
      this.archiveInFlight.add(sessionId);
      try {
        this.logger.debug(`[archive] Start archiving session ${sessionId}`);
        await this.archiveSessionResources(sessionId);
        await this.removeArchiveRequest(sessionId);
        this.logger.debug(`[archive] Finished archiving session ${sessionId}`);
      } catch (error) {
        this.logger.error(`[${sessionId}] Failed to archive session: ${formatErrorMessage(error)}`);
      } finally {
        this.archiveInFlight.delete(sessionId);
      }
    }

    void this.processDeleteLocalProjectRequests();
  }

  private async archiveSessionResources(
    sessionId: SessionId,
    options?: { preserveWorktree?: boolean }
  ): Promise<void> {
    this.logger.debug(`[${sessionId}] Archiving session resources`);

    this.clearSessionActivePresence(sessionId);
    this.closeSessionTerminals?.(sessionId);
    this.logger.debug(`[${sessionId}] Active presence cleared`);

    await this.finalizeACPState(sessionId);
    this.logger.debug(`[${sessionId}] ACP state finalized`);

    await this.previewService.closeSessionPreviewForCleanup(sessionId, 'Session archived');
    this.logger.debug(`[${sessionId}] Preview tunnel closed for archive`);

    const sessionRoomId = getSessionRoomId(sessionId);
    const [sessionMetaDoc, archiveMachineMetaDoc] = await Promise.all([
      this.workspaceDocument.repo.getDocMeta(sessionRoomId),
      this.workspaceDocument.repo.getDocMeta(getMachineRoomId(this.machineId)),
    ]);
    const sessionMeta = sessionMetaDoc?.meta as SessionMeta | undefined;
    const archiveMachineMeta = archiveMachineMetaDoc?.meta as MachineLegacyMetaFields | undefined;

    await this.terminateActiveChildSessions(sessionId, 'Parent session archived');

    if (this.sessionManager.hasSession(sessionId)) {
      this.logger.debug(`[${sessionId}] Terminating active session`);
      await this.sessionManager.terminateSession(sessionId, true);
    }

    if (!options?.preserveWorktree) {
      const cleanupTarget = this.resolveWorktreeCleanupTarget({
        sessionMeta,
        machineMeta: archiveMachineMeta,
      });
      if (cleanupTarget) {
        const worktreeManager = getWorktreeManager(this.buildWorktreeManagerConfig(cleanupTarget));
        const worktreePath = worktreeManager.getWorktreeHostPath(sessionId);
        if (fs.existsSync(worktreePath)) {
          const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
          await runWorktreeCleanup({
            config: await resolveSessionWorktreeCleanupConfig({
              token: this.token,
              workspaceId: this.workspaceId,
              machineId: this.machineId,
              sessionId,
              sessionMeta,
              workspaceDocument: this.workspaceDocument,
              logger: this.logger,
            }),
            sessionId,
            workspaceId: this.workspaceId,
            workdir: worktreePath,
            branch: cleanupTarget.branchName ?? sessionMeta?.branchName?.trim() ?? '',
            repoFullName:
              sessionMeta?.project?.kind === 'local' ? undefined : sessionMeta?.repoFullName,
            localProjectId:
              sessionMeta?.project?.kind === 'local'
                ? sessionMeta.project.localProjectId
                : undefined,
            logger: this.logger,
            events: createWorktreeScriptHistoryRecorder({
              sessionDoc,
              sessionId,
              phase: 'cleanup',
              logger: this.logger,
            }),
          });
        }
        try {
          const archiveResult = await worktreeManager.archiveWorktree(sessionId);
          if (
            archiveResult.branchName &&
            archiveResult.branchName !== sessionMeta?.branchName?.trim()
          ) {
            await this.workspaceDocument.repo.upsertDocMeta(sessionRoomId, {
              branchName: archiveResult.branchName,
            } as Partial<SessionMeta>);
          }
        } catch (error) {
          this.logger.debug(
            `[${sessionId}] Failed to archive worktree: ${formatErrorMessage(error)}`
          );
        }
      }
    }

    await this.sessionManager.archiveSession(sessionId);
    this.logger.debug(`[${sessionId}] Session doc cleaned`);

    await this.workspaceDocument.repo.upsertDocMeta(sessionRoomId, {
      isArchived: true,
      status: SessionStatusFactory.idle(),
    } as Partial<SessionMeta>);
    this.logger.debug(`[${sessionId}] Session meta archived`);

    // Clean up session-specific logger cache
    this.store.get(sessionId).logger = null;
  }

  private async removeArchiveRequest(sessionId: SessionId): Promise<void> {
    const machineRoomId = getMachineRoomId(this.machineId);
    let removedFlockRow = false;
    try {
      removedFlockRow = await this.deleteMachineFlockCommandRow(
        machineFlockKeys.archiveSessionCommand(sessionId)
      );
    } catch (error) {
      this.logger.debug(
        `[archive] Failed to remove archive Flock request (${sessionId}): ${formatErrorMessage(
          error
        )}`
      );
    }

    const machineMeta = (await this.workspaceDocument.repo.getDocMeta(machineRoomId))?.meta as
      | MachineLegacyMetaFields
      | undefined;
    if (!machineMeta?.needToArchiveSessions?.[sessionId]) {
      if (!removedFlockRow) {
        this.logger.debug(`[archive] Archive request already cleared (${sessionId})`);
      } else {
        this.logger.debug(`[archive] Archive Flock request removed (${sessionId})`);
      }
      return;
    }
    const nextQueue = { ...machineMeta.needToArchiveSessions };
    delete nextQueue[sessionId];
    await this.workspaceDocument.repo.upsertDocMeta(machineRoomId, {
      needToArchiveSessions: nextQueue,
    } as RepoDocMetaPatch);
    if (removedFlockRow) {
      this.logger.debug(`[archive] Archive request removed (${sessionId})`);
    } else {
      this.logger.debug(`[archive] Legacy archive request removed (${sessionId})`);
    }
  }

  private async removeDeleteLocalProjectRequest(localProjectId: LocalProjectId): Promise<void> {
    try {
      const removed = await this.deleteMachineFlockCommandRow(
        machineFlockKeys.deleteLocalProjectCommand(localProjectId)
      );
      if (removed) {
        this.logger.debug(`[local-project] Delete request removed (${localProjectId})`);
      } else {
        this.logger.debug(`[local-project] Delete request already cleared (${localProjectId})`);
      }
    } catch (error) {
      this.logger.debug(
        `[local-project] Failed to remove delete request (${localProjectId}): ${formatErrorMessage(
          error
        )}`
      );
    }
  }

  private async processDeleteLocalProjectRequests(): Promise<void> {
    const snapshot = await this.readMachineCommandSnapshot();
    const localProjectEntries = snapshot.deleteLocalProjectEntries;
    if (localProjectEntries.length === 0) {
      this.logger.debug('[local-project] No pending delete requests');
      return;
    }

    if (snapshot.archiveSessionIds.length > 0 || this.archiveInFlight.size > 0) {
      this.logger.debug(
        `[local-project] Deferring ${localProjectEntries.length} delete request(s) until archive requests finish`
      );
      return;
    }

    this.logger.debug(`[local-project] Processing ${localProjectEntries.length} delete request(s)`);
    for (const [localProjectId, command] of localProjectEntries) {
      if (command.status === 'completed') {
        continue;
      }
      if (this.deleteLocalProjectInFlight.has(localProjectId)) {
        this.logger.debug(`[local-project] ${localProjectId} already in progress`);
        continue;
      }
      this.deleteLocalProjectInFlight.add(localProjectId);
      try {
        const cleanupResult = await this.deleteLocalProjectResources(localProjectId, command);
        if (command.cleanupWorktrees && cleanupResult) {
          await this.writeMachineFlockRow({
            key: machineFlockKeys.deleteLocalProjectCommand(localProjectId),
            value: { ...command, status: 'completed', cleanupResult },
          });
        } else {
          await this.removeDeleteLocalProjectRequest(localProjectId);
        }
      } catch (error) {
        this.logger.error(
          `[local-project] Failed to delete ${localProjectId}: ${formatErrorMessage(error)}`
        );
      } finally {
        this.deleteLocalProjectInFlight.delete(localProjectId);
      }
    }
  }

  private async cleanupLocalProjectWorktreeSetup(localProjectId: LocalProjectId): Promise<void> {
    if (!this.cleanupLocalProjectWorktreeSetupIfUnreferenced) {
      return;
    }
    try {
      await this.cleanupLocalProjectWorktreeSetupIfUnreferenced(localProjectId);
    } catch (error) {
      this.logger.debug(
        `[local-project] Failed to cleanup worktree setup for ${localProjectId}: ${formatErrorMessage(
          error
        )}`
      );
    }
  }

  private async archiveLocalProjectSessions(localProjectId: LocalProjectId): Promise<void> {
    const sessions = (await listAliveSessionMetas(this.workspaceDocument)).filter(({ meta }) =>
      isSessionInLocalProjectRemovalScope(meta, {
        machineId: this.machineId,
        localProjectId,
      })
    );
    if (sessions.length === 0) return;

    const rootSessions = sessions.filter(
      ({ meta }) => meta.isArchived !== true && !meta.parentSessionId
    );
    const archivedRootSessionIds = new Set(rootSessions.map(({ meta }) => meta.id));
    for (const { meta } of rootSessions) {
      await this.archiveSessionResources(meta.id, { preserveWorktree: true });
    }

    for (const { roomId, meta } of sessions) {
      if (archivedRootSessionIds.has(meta.id)) continue;
      if (this.sessionManager.hasSession(meta.id)) {
        await this.archiveSessionResources(meta.id, { preserveWorktree: true });
        continue;
      }
      if (meta.isArchived === true) continue;
      await this.workspaceDocument.repo.upsertDocMeta(roomId, {
        isArchived: true,
        status: SessionStatusFactory.idle(),
      } as Partial<SessionMeta>);
    }

    this.logger.debug(
      `[local-project] Processed ${sessions.length} session(s) before removing ${localProjectId}`
    );
  }

  private async deleteLocalProjectResources(
    localProjectId: LocalProjectId,
    command: MachineDeleteLocalProjectCommand
  ): Promise<MachineDeleteLocalProjectCommand['cleanupResult'] | undefined> {
    const existingProject = await resolveWorkspaceLocalProject(
      this.workspaceDocument.repo,
      this.workspaceId,
      this.machineId,
      localProjectId
    );
    if (!existingProject && !command.cleanupWorktrees) {
      this.logger.debug(`[local-project] ${localProjectId} already removed`);
      await this.cleanupLocalProjectWorktreeSetup(localProjectId);
      return undefined;
    }

    if (existingProject && !shouldApplyMachineDeleteLocalProjectCommand(existingProject, command)) {
      this.logger.debug(
        `[local-project] Skipping stale delete request for ${localProjectId}; project was created after the request`
      );
      return undefined;
    }

    await this.archiveLocalProjectSessions(localProjectId);

    let cleanupResult: MachineDeleteLocalProjectCommand['cleanupResult'];
    const originalRootPath = existingProject?.rootPath ?? command.originalRootPath;
    if (command.cleanupWorktrees && originalRootPath) {
      const sessions = (await listAliveSessionMetas(this.workspaceDocument)).map(
        ({ meta }) => meta
      );
      cleanupResult = await cleanupLocalProjectWorktrees({
        machineId: this.machineId,
        localProjectId,
        originalRootPath,
        sessions,
        logger: this.logger,
      });
    }

    if (existingProject) {
      await removeMachineLocalProject(
        this.workspaceDocument.repo,
        this.workspaceId,
        this.machineId,
        localProjectId,
        undefined,
        { sync: this.workspaceDocument, reason: 'local-project-delete-command' }
      );
      this.logger.debug(
        `[local-project] Removed ${existingProject.name} (${existingProject.rootPath})`
      );
    }
    await this.cleanupLocalProjectWorktreeSetup(localProjectId);
    return cleanupResult;
  }

  private toDeleteRequestRecord(request: DeleteRequest | undefined): DeleteRequestRecord {
    if (!request || typeof request !== 'object') {
      return {};
    }
    if ('v' in request) {
      return machineDeleteCommandToQueueItem(request);
    }
    return request;
  }

  private async isDeleteRequestQueued(sessionId: SessionId): Promise<boolean> {
    const snapshot = await this.readMachineCommandSnapshot();
    return snapshot.deleteSessionIds.has(sessionId);
  }

  private async writeKeptWorktreePath(
    sessionId: SessionId,
    request: DeleteRequest | undefined,
    keptWorktreePath: string
  ): Promise<void> {
    const machineFlockRows = await this.tryReadMachineFlockCommandRows();
    const deleteKey = machineFlockKeys.deleteSessionCommand(sessionId);
    const currentCommand = getMachineFlockDeleteCommand(machineFlockRows, sessionId);

    const nextRecord = {
      ...this.toDeleteRequestRecord(request),
      ...(currentCommand ? this.toDeleteRequestRecord(currentCommand) : {}),
      keptWorktreePath,
    };
    const { isWorktree, requestedAt, ...rest } = nextRecord;
    const nextCommand: MachineDeleteSessionCommand = {
      v: 1,
      ...rest,
      requestedAt: requestedAt ?? getServerNow(),
      ...(isWorktree === true ? { isWorktree: true } : {}),
    };
    await this.writeMachineFlockRow({
      key: deleteKey,
      value: nextCommand,
    });
  }

  private async terminateActiveChildSessions(
    parentSessionId: SessionId,
    reason: string
  ): Promise<void> {
    const childSessionIds = this.sessionManager.getActiveChildSessionIds(parentSessionId);
    if (childSessionIds.length === 0) {
      return;
    }

    this.logger.debug(
      `[${parentSessionId}] Terminating ${childSessionIds.length} active child session(s) before workspace cleanup`
    );
    await Promise.all(
      childSessionIds.map(async (childSessionId) => {
        this.clearSessionActivePresence(childSessionId);
        this.closeSessionTerminals?.(childSessionId);
        await this.finalizeACPState(childSessionId);
        await this.previewService.closeSessionPreviewForCleanup(childSessionId, reason);
        await this.sessionManager.terminateSession(childSessionId, true);
        this.store.get(childSessionId).logger = null;
      })
    );
  }

  private resolveWorktreeCleanupTarget(options: {
    sessionMeta: SessionMeta | undefined;
    request?: DeleteRequest;
    machineMeta?: MachineLegacyMetaFields;
    machineFlockRows?: MachineFlockRowMap;
  }): WorktreeCleanupTarget | null {
    const { sessionMeta, machineMeta } = options;
    const localProjects = {
      ...(machineMeta?.localProjects ?? {}),
      ...getMachineFlockLocalProjects(options.machineFlockRows ?? ({} as MachineFlockRowMap)),
    };
    const requestRecord = this.toDeleteRequestRecord(options.request);
    const trimmed = (value: string | undefined): string | undefined => {
      const v = value?.trim();
      return v ? v : undefined;
    };
    const branchName = trimmed(requestRecord.branchName) ?? trimmed(sessionMeta?.branchName);
    const baseBranchName =
      trimmed(requestRecord.baseBranchName) ?? trimmed(sessionMeta?.baseBranch);
    const requestLocalProjectId = trimmed(requestRecord.localProjectId);
    const requestOriginalRootPath = trimmed(requestRecord.originalRootPath);
    const requestHasLocalTarget =
      requestLocalProjectId !== undefined || requestOriginalRootPath !== undefined;
    const isLocalWorktree =
      sessionMeta?.project?.kind === 'local'
        ? sessionMeta.isWorktree === true || requestRecord.isWorktree === true
        : requestHasLocalTarget && requestRecord.isWorktree === true;

    if (isLocalWorktree) {
      const localProjectId =
        requestLocalProjectId ??
        (sessionMeta?.project?.kind === 'local' ? sessionMeta.project.localProjectId : undefined);
      const originalRootPath =
        requestOriginalRootPath ||
        (localProjectId ? localProjects[localProjectId as LocalProjectId]?.rootPath?.trim() : '');
      if (!originalRootPath) {
        return null;
      }
      return {
        repoId: deriveRepoIdFromLocalProjectPath(originalRootPath),
        source: { kind: 'local-shared', originalRootPath },
        ...(branchName ? { branchName } : {}),
        ...(baseBranchName ? { baseBranchName } : {}),
      };
    }

    const repoFullName =
      sessionMeta?.project?.kind === 'local'
        ? undefined
        : (trimmed(requestRecord.repoFullName) ?? trimmed(sessionMeta?.repoFullName));
    if (!repoFullName) {
      return null;
    }

    return {
      repoId: deriveRepoIdFromGitHubRepo(repoFullName),
      ...(branchName ? { branchName } : {}),
      ...(baseBranchName ? { baseBranchName } : {}),
    };
  }

  private buildWorktreeManagerConfig(target: WorktreeCleanupTarget): {
    repoId: RepoId;
    source?: WorktreeCleanupTarget['source'];
    logger: Logger;
  } {
    return {
      repoId: target.repoId,
      ...(target.source ? { source: target.source } : {}),
      logger: this.logger,
    };
  }

  private setupDeleteWatcher(): void {
    if (this.deleteWatchHandle) {
      return;
    }
    const machineRoomId = getMachineRoomId(this.machineId);
    this.deleteWatchHandle = this.workspaceDocument.repo.watch(
      (event) => {
        if (event.kind !== 'doc-metadata') return;
        if (event.docId !== machineRoomId) return;
        this.logger.debug(`[delete] Machine meta updated (docId=${machineRoomId})`);
        void this.processDeleteRequests();
      },
      {
        docIds: [machineRoomId],
        kinds: ['doc-metadata'],
        metadataFields: ['needToDeleteSessions'],
      }
    );
    this.logger.debug(`[delete] Delete watcher registered (docId=${machineRoomId})`);
    void this.processDeleteRequests();
  }

  private async processDeleteRequests(): Promise<void> {
    const snapshot = await this.readMachineCommandSnapshot();
    const entries = snapshot.deleteEntries;
    if (entries.length === 0) {
      this.logger.debug('[delete] No pending delete requests');
      return;
    }

    this.logger.debug(`[delete] Processing ${entries.length} delete request(s)`);
    for (const [sessionId, request] of entries) {
      const keptWorktreePath =
        typeof request === 'object' && request !== null
          ? request.keptWorktreePath?.trim()
          : undefined;
      if (keptWorktreePath) {
        this.logger.debug(
          `[delete] Skipping retry for ${sessionId}; local worktree was preserved at ${keptWorktreePath}`
        );
        continue;
      }
      if (this.deleteInFlight.has(sessionId)) {
        this.logger.debug(`[delete] Session ${sessionId} already in progress`);
        continue;
      }
      this.deleteInFlight.add(sessionId);
      try {
        this.logger.debug(`[delete] Start deleting session ${sessionId}`);
        const result = await this.deleteSessionResources(sessionId, request);
        if (!result.keptWorktreePath) {
          await this.removeDeleteRequest(sessionId);
        }
        this.logger.debug(`[delete] Finished deleting session ${sessionId}`);
      } catch (error) {
        this.logger.error(`[${sessionId}] Failed to delete session: ${formatErrorMessage(error)}`);
      } finally {
        this.deleteInFlight.delete(sessionId);
      }
    }
  }

  private async deleteSessionResources(
    sessionId: SessionId,
    request?: DeleteRequest
  ): Promise<{ keptWorktreePath?: string }> {
    this.logger.debug(`[${sessionId}] Deleting session resources permanently`);

    const sessionRoomId = getSessionRoomId(sessionId);
    const [commandSnapshot, sessionMetaDoc] = await Promise.all([
      this.readMachineCommandSnapshot(),
      this.workspaceDocument.repo.getDocMeta(sessionRoomId),
    ]);
    const sessionMeta = sessionMetaDoc?.meta as SessionMeta | undefined;
    if (!commandSnapshot.deleteSessionIds.has(sessionId)) {
      this.logger.debug(
        `[${sessionId}] Skipping permanent deletion (delete request is no longer queued)`
      );
      return {};
    }

    if (sessionMeta?.isArchived === false) {
      this.logger.debug(
        `[${sessionId}] Skipping permanent deletion (session is not archived anymore)`
      );
      return {};
    }

    // First archive resources if not already done
    await this.terminateActiveChildSessions(sessionId, 'Parent session deleted');

    this.clearSessionActivePresence(sessionId);
    this.closeSessionTerminals?.(sessionId);

    await this.finalizeACPState(sessionId);

    await this.previewService.closeSessionPreviewForCleanup(sessionId, 'Session deleted');
    this.logger.debug(`[${sessionId}] Preview tunnel closed for deletion`);

    if (this.sessionManager.hasSession(sessionId)) {
      this.logger.debug(`[${sessionId}] Terminating active session`);
      await this.sessionManager.terminateSession(sessionId, true);
    }

    if (!(await this.isDeleteRequestQueued(sessionId))) {
      this.logger.debug(
        `[${sessionId}] Skipping permanent deletion (delete request was cleared before worktree cleanup)`
      );
      return {};
    }

    const cleanupTarget = this.resolveWorktreeCleanupTarget({
      sessionMeta,
      request,
      machineMeta: commandSnapshot.machineMeta,
      machineFlockRows: commandSnapshot.machineFlockRows,
    });

    let keptWorktreePath: string | undefined;
    if (cleanupTarget) {
      const worktreeManager = getWorktreeManager(this.buildWorktreeManagerConfig(cleanupTarget));
      try {
        await worktreeManager.removeWorktree(
          sessionId,
          cleanupTarget.source === undefined,
          cleanupTarget.branchName,
          { baseBranchName: cleanupTarget.baseBranchName }
        );
      } catch (error) {
        if (cleanupTarget.source) {
          const keptPath = worktreeManager.getWorktreeHostPath(sessionId);
          keptWorktreePath = keptPath;
          await this.writeKeptWorktreePath(sessionId, request, keptPath);
          this.logger.warn(
            `[${sessionId}] Local worktree was kept because cleanup failed or it has uncommitted changes: ${keptPath} (${formatErrorMessage(error)})`
          );
        } else {
          this.logger.debug(
            `[${sessionId}] Failed to remove worktree: ${formatErrorMessage(error)}`
          );
        }
      }
    }

    if (keptWorktreePath) {
      return { keptWorktreePath };
    }

    if (!(await this.isDeleteRequestQueued(sessionId))) {
      this.logger.debug(
        `[${sessionId}] Skipping session doc deletion (delete request was cleared after worktree cleanup)`
      );
      return {};
    }

    // Clean up worktree and disk resources via session manager
    await this.sessionManager.archiveSession(sessionId);
    this.logger.debug(`[${sessionId}] Session doc cleaned`);

    if (!(await this.isDeleteRequestQueued(sessionId))) {
      this.logger.debug(
        `[${sessionId}] Skipping session doc deletion (delete request was cleared after archive)`
      );
      return {};
    }

    // This is the point of no return for the session document. Stop accepting
    // late ACP output and drop any retained retry timer/buffer before deleting
    // the doc, otherwise a failed tail flush can recreate it afterwards.
    this.deletedSessionIds.add(sessionId);
    await this.quiesceACPFlushForDeletion(sessionId);

    // Delete the session doc permanently
    try {
      await this.workspaceDocument.repo.deleteDoc(sessionRoomId);
      this.logger.debug(`[${sessionId}] Session doc deleted`);
    } catch (error) {
      // The durable delete request must remain retryable. Rolling the barrier
      // back lets the next attempt quiesce the session again; swallowing this
      // error would acknowledge a deletion that never happened and reject all
      // future output forever.
      this.deletedSessionIds.delete(sessionId);
      throw error;
    }

    try {
      // Transient non-owner open: skip the open-time maintenance writes so this
      // does not contend on the shared WAL store's write lock.
      const operationStore = new LodyOperationStore(
        getLodyOperationStorePath(this.machineId),
        undefined,
        { maintenance: false }
      );
      try {
        operationStore.deleteRequesterSession(sessionId);
      } finally {
        operationStore.close();
      }
    } catch (error) {
      this.logger.debug(
        `[${sessionId}] Failed to delete requester-private Operation data: ${formatErrorMessage(error)}`
      );
    }

    // Some best-effort deletion tails may consult transient session state for
    // diagnostics. Re-assert the deletion barrier before returning so those
    // reads cannot leave an empty state record behind.
    this.store.deleteSession(sessionId);

    return {};
  }

  private async removeDeleteRequest(sessionId: SessionId): Promise<void> {
    const machineRoomId = getMachineRoomId(this.machineId);
    let removedFlockRow = false;
    let removedLaunchConfigRow = false;
    try {
      removedFlockRow = await this.deleteMachineFlockCommandRow(
        machineFlockKeys.deleteSessionCommand(sessionId)
      );
    } catch (error) {
      this.logger.debug(
        `[delete] Failed to remove delete Flock request (${sessionId}): ${formatErrorMessage(
          error
        )}`
      );
    }
    try {
      removedLaunchConfigRow = await this.deleteMachineFlockCommandRow(
        machineFlockKeys.sessionLaunchConfig(sessionId)
      );
    } catch (error) {
      this.logger.debug(
        `[delete] Failed to remove session launch config row (${sessionId}): ${formatErrorMessage(
          error
        )}`
      );
    }

    const machineMeta = (await this.workspaceDocument.repo.getDocMeta(machineRoomId))?.meta as
      | MachineLegacyMetaFields
      | undefined;
    if (!machineMeta?.needToDeleteSessions?.[sessionId]) {
      if (removedFlockRow || removedLaunchConfigRow) {
        this.logger.debug(`[delete] Delete Flock request removed (${sessionId})`);
      } else {
        this.logger.debug(`[delete] Delete request already cleared (${sessionId})`);
      }
      return;
    }
    const nextQueue = { ...machineMeta.needToDeleteSessions };
    delete nextQueue[sessionId];
    const nextWorkspacePaths = machineMeta.workspacePaths
      ? { ...machineMeta.workspacePaths }
      : null;
    if (nextWorkspacePaths && sessionId in nextWorkspacePaths) {
      delete nextWorkspacePaths[sessionId];
    }
    await this.workspaceDocument.repo.upsertDocMeta(machineRoomId, {
      needToDeleteSessions: nextQueue,
      ...(nextWorkspacePaths ? { workspacePaths: nextWorkspacePaths } : {}),
    } as RepoDocMetaPatch);
    if (removedFlockRow) {
      this.logger.debug(`[delete] Delete request removed (${sessionId})`);
    } else {
      this.logger.debug(`[delete] Legacy delete request removed (${sessionId})`);
    }
  }

  private enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void {
    // Note: ACP notifications are internal agent events, NOT user activity.
    // We intentionally do NOT call touchSession() here to avoid keeping sessions
    // artificially alive. Only user-initiated actions (chat, image upload) reset
    // the idle timer.
    if (this.deletedSessionIds.has(sessionId)) {
      this.logger.debug(
        `[${sessionId}] Dropping ACP update after permanent deletion reached its commit boundary`
      );
      return;
    }
    if (this.store.recordSuppressedAcpReplay(sessionId)) {
      return;
    }
    const target = this.store.getCurrentACPUpdateTarget(sessionId);
    if (!target) {
      this.captureACPUpdateInvariant('out_of_turn_acp_update_without_target', sessionId, update);
      this.logger.debug(
        `[${sessionId}] Dropping ACP update without an active/finalized assistant entry target (${update.update.sessionUpdate})`
      );
      return;
    }
    if (target.source === 'finalized_turn') {
      this.captureACPUpdateInvariant(
        'late_acp_update_routed_to_finalized_turn',
        sessionId,
        update,
        {
          assistantEntryId: target.assistantEntryId,
          turnEpoch: target.turnEpoch,
        }
      );
    }
    this.store.get(sessionId).acpUpdateBuffer.push({ notification: update, target });
    this.scheduleFlushACPUpdates(sessionId);
  }

  private clearScheduledACPFlush(sessionId: SessionId): void {
    const state = this.store.get(sessionId);
    if (!state.acpFlushTimer) {
      return;
    }
    clearTimeout(state.acpFlushTimer);
    state.acpFlushTimer = null;
  }

  private async quiesceACPFlushForDeletion(sessionId: SessionId): Promise<void> {
    // Capture the state object once. Concurrent idempotent delete workers may
    // remove it from the store while this function awaits; calling store.get()
    // again after that point would recreate an empty record for a deleted doc.
    const state = this.store.has(sessionId) ? this.store.get(sessionId) : null;
    if (state?.acpFlushTimer) {
      clearTimeout(state.acpFlushTimer);
      state.acpFlushTimer = null;
    }
    const inFlight = state?.acpFlushInFlight;
    if (inFlight) {
      await inFlight;
    }
    // The in-flight finally callback observes deletedSessionIds and cannot
    // schedule a successor, but clear once more in case a timer was already
    // installed immediately before the deletion barrier.
    if (state?.acpFlushTimer) {
      clearTimeout(state.acpFlushTimer);
      state.acpFlushTimer = null;
    }
    if (state) {
      state.acpUpdateBuffer = [];
    }
    await this.quiesceCodeCollabTurnPersistenceForDeletion(sessionId);
    this.store.deleteSession(sessionId);
  }

  private startACPUpdateFlush(sessionId: SessionId): Promise<void> | null {
    if (this.deletedSessionIds.has(sessionId)) {
      return null;
    }
    const state = this.store.get(sessionId);
    if (state.acpFlushInFlight) {
      return state.acpFlushInFlight;
    }

    let failed = false;
    const flushPromise = this.flushACPUpdates(sessionId)
      .then(() => {
        state.acpFlushConsecutiveFailures = 0;
      })
      .catch((error: unknown) => {
        failed = true;
        state.acpFlushConsecutiveFailures += 1;
        const detail = formatErrorMessage(error, { includeStack: true });
        this.logger.error(`[${sessionId}] Failed to flush ACP updates: ${detail}`);
      })
      .finally(() => {
        state.acpFlushInFlight = null;
        if (this.deletedSessionIds.has(sessionId)) {
          return;
        }
        if (state.acpUpdateBuffer.length === 0) {
          return;
        }
        if (
          failed &&
          state.acpFlushConsecutiveFailures >= MessageHandler.ACP_MAX_AUTOMATIC_FLUSH_FAILURES
        ) {
          this.logger.warn(
            `[${sessionId}] Pausing automatic ACP flush retries after ${state.acpFlushConsecutiveFailures} consecutive failures; buffered updates remain for a later notification or explicit drain`
          );
          return;
        }
        const retryDelayMs = failed
          ? Math.min(
              MessageHandler.ACP_FLUSH_RETRY_BASE_DELAY_MS *
                2 ** Math.max(0, state.acpFlushConsecutiveFailures - 1),
              MessageHandler.ACP_FLUSH_RETRY_MAX_DELAY_MS
            )
          : undefined;
        this.scheduleFlushACPUpdates(sessionId, retryDelayMs);
      });

    state.acpFlushInFlight = flushPromise;
    return flushPromise;
  }

  /**
   * Schedule a flush of ACP updates for the given session.
   * If a flush is already in progress, the new updates will be picked up
   * after the current flush completes (via the buffer check in flushACPUpdates).
   */
  private scheduleFlushACPUpdates(sessionId: SessionId, retryDelayMs?: number): void {
    if (this.deletedSessionIds.has(sessionId)) {
      return;
    }
    const state = this.store.get(sessionId);
    if (state.acpFlushInFlight || state.acpFlushTimer) {
      return;
    }
    const batchWindowMs =
      retryDelayMs ??
      (state.acpFlushCountInTurn === 0
        ? MessageHandler.ACP_INITIAL_UPDATE_BATCH_WINDOW_MS
        : MessageHandler.ACP_SUBSEQUENT_UPDATE_BATCH_WINDOW_MS);
    const timer = setTimeout(() => {
      state.acpFlushTimer = null;
      void this.startACPUpdateFlush(sessionId);
    }, batchWindowMs);
    timer.unref?.();
    state.acpFlushTimer = timer;
  }

  private async flushACPUpdatesNow(sessionId: SessionId): Promise<void> {
    const span = startTraceSpan(this.logger, 'acp.flush_updates_now', {
      sessionId,
      turnId: this.store.getTurnId(sessionId),
    });
    const state = this.store.get(sessionId);
    // Failed flushes re-queue their batch (at-least-once), so a persistently
    // failing append could otherwise spin this drain loop forever. Give up
    // after a bounded number of rounds; re-queued updates stay buffered for
    // the next trigger instead of being lost.
    let flushRounds = 0;
    try {
      this.clearScheduledACPFlush(sessionId);

      while (true) {
        if (!state.acpFlushInFlight) {
          if (state.acpUpdateBuffer.length === 0) {
            span.end({ pendingUpdates: 0 });
            return;
          }
          void this.startACPUpdateFlush(sessionId);
        }

        const inFlight = state.acpFlushInFlight;
        if (!inFlight) {
          span.end({ pendingUpdates: state.acpUpdateBuffer.length });
          return;
        }

        await inFlight;
        this.clearScheduledACPFlush(sessionId);

        if (state.acpUpdateBuffer.length === 0 && !state.acpFlushInFlight) {
          span.end({ pendingUpdates: 0 });
          return;
        }
        flushRounds += 1;
        if (flushRounds >= 5) {
          this.logger.warn(
            `[${sessionId}] Giving up ACP flush drain after ${flushRounds} rounds; ${state.acpUpdateBuffer.length} updates stay buffered for the next flush trigger`
          );
          span.end({ pendingUpdates: state.acpUpdateBuffer.length });
          return;
        }
      }
    } catch (error) {
      span.fail(error);
      throw error;
    }
  }

  private shouldMarkSessionUnread(messages: readonly AcpSessionNotification[]): boolean {
    return messages.some((message) => {
      switch (message.update.sessionUpdate) {
        case 'agent_message_chunk':
          return true;
        case 'agent_thought_chunk':
        case 'tool_call':
        case 'tool_call_update':
        case 'plan':
        case 'available_commands_update':
        case 'user_message_chunk':
        case 'current_mode_update':
        case 'session_info_update':
        default:
          return false;
      }
    });
  }

  private summarizeACPUpdateBatch(batch: readonly AcpSessionNotification[]): string {
    const bySessionUpdate: Record<string, number> = {};
    const contentTypes: Record<string, number> = {};
    for (const message of batch) {
      const update = message.update;
      const updateType = update?.sessionUpdate ?? 'unknown';
      bySessionUpdate[updateType] = (bySessionUpdate[updateType] ?? 0) + 1;

      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
        case 'agent_thought_chunk':
        case 'tool_call':
        case 'tool_call_update': {
          if ('content' in update) {
            const content = update.content;
            if (content && typeof content === 'object' && 'type' in content) {
              const type = (content as { type?: unknown }).type;
              if (typeof type === 'string') {
                contentTypes[type] = (contentTypes[type] ?? 0) + 1;
              } else {
                contentTypes.unknown = (contentTypes.unknown ?? 0) + 1;
              }
            }
          }
          break;
        }
        default:
          break;
      }
    }

    return JSON.stringify({
      total: batch.length,
      bySessionUpdate,
      contentTypes,
    });
  }

  private captureACPUpdateInvariant(
    eventName: 'late_acp_update_routed_to_finalized_turn' | 'out_of_turn_acp_update_without_target',
    sessionId: SessionId,
    notification: AcpSessionNotification,
    extra?: { assistantEntryId?: string; turnEpoch?: number }
  ): void {
    captureCli(
      eventName,
      {
        workspace_id: this.workspaceId,
        session_id: sessionId,
        session_update: notification.update.sessionUpdate,
        ...(extra?.assistantEntryId ? { assistant_entry_id: extra.assistantEntryId } : {}),
        ...(typeof extra?.turnEpoch === 'number' ? { turn_epoch: extra.turnEpoch } : {}),
      },
      { tier: 'C' }
    );
  }

  private getACPUpdateTargetKey(target: ACPUpdateTarget): string {
    return `${target.assistantEntryId}\0${target.turnEpoch}\0${target.source}`;
  }

  private groupBufferedACPUpdates(
    queue: readonly BufferedACPUpdate[]
  ): Array<{ target: ACPUpdateTarget; updates: BufferedACPUpdate[] }> {
    const groups = new Map<string, { target: ACPUpdateTarget; updates: BufferedACPUpdate[] }>();
    for (const item of queue) {
      const key = this.getACPUpdateTargetKey(item.target);
      const existing = groups.get(key);
      if (existing) {
        existing.updates.push(item);
      } else {
        groups.set(key, { target: item.target, updates: [item] });
      }
    }
    return [...groups.values()];
  }

  private summarizeModelInfo(model: ModelInfo | undefined): Record<string, unknown> | null {
    if (!model) return null;
    const meta = model._meta;
    const metaRecord =
      meta && typeof meta === 'object' && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)
        : null;
    const metaKeys = metaRecord ? Object.keys(metaRecord) : [];
    const undefinedMetaKeys = metaRecord
      ? metaKeys.filter((key) => metaRecord[key] === undefined).slice(0, 10)
      : [];
    return {
      modelId: model.modelId,
      name: model.name,
      descriptionType: typeof model.description,
      metaType: meta === null ? 'null' : Array.isArray(meta) ? 'array' : typeof meta,
      metaKeys: metaKeys.length,
      undefinedMetaKeys,
    };
  }

  private sanitizeModelInfoForHistory(model: ModelInfo | undefined): ModelInfo | undefined {
    if (!model) return undefined;
    const out: ModelInfo = {
      modelId: model.modelId,
      name: model.name,
    };
    if (typeof model.description === 'string' || model.description === null) {
      out.description = model.description;
    }
    return out;
  }

  private summarizeSessionHistoryForDiagnostics(
    history: SessionHistoryInput[]
  ): Record<string, unknown> {
    const historyItemTypes: Record<string, number> = {};
    const systemNoticeMetaUndefinedKeys: Array<{ entryId: string; keys: string[] }> = [];
    let historyItems = 0;

    for (const entry of history) {
      if (!entry || typeof entry !== 'object') continue;
      const items = Array.isArray(entry.items) ? (entry.items as unknown[]) : [];
      for (const item of items) {
        historyItems += 1;
        const type = (item as { type?: unknown } | undefined)?.type;
        const typeKey = typeof type === 'string' ? type : 'unknown';
        historyItemTypes[typeKey] = (historyItemTypes[typeKey] ?? 0) + 1;

        if (typeKey === 'system_notice') {
          const meta = (item as { meta?: unknown } | undefined)?.meta;
          if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
            const metaRecord = meta as Record<string, unknown>;
            const keys = Object.keys(metaRecord);
            const undefinedKeys = keys.filter((k) => metaRecord[k] === undefined);
            if (undefinedKeys.length > 0 && systemNoticeMetaUndefinedKeys.length < 5) {
              systemNoticeMetaUndefinedKeys.push({
                entryId: entry.id,
                keys: undefinedKeys.slice(0, 10),
              });
            }
          }
        }
      }
    }

    const last = history.length > 0 ? history[history.length - 1] : undefined;
    const lastItems = last && Array.isArray(last.items) ? (last.items as unknown[]) : [];
    const lastItemTypes: Record<string, number> = {};
    for (const item of lastItems) {
      const type = (item as { type?: unknown } | undefined)?.type;
      const typeKey = typeof type === 'string' ? type : 'unknown';
      lastItemTypes[typeKey] = (lastItemTypes[typeKey] ?? 0) + 1;
    }

    return {
      historyEntries: history.length,
      historyItems,
      historyItemTypes,
      systemNoticeMetaUndefinedKeys,
      lastEntry: last
        ? {
            id: last.id,
            role: last.role,
            timestamp: last.timestamp,
            items: lastItems.length,
            itemTypes: lastItemTypes,
          }
        : null,
    };
  }

  private async appendACPUpdatesToAssistantEntry(args: {
    sessionId: SessionId;
    sessionDoc: SessionDocument;
    updates: BufferedACPUpdate[];
    assistantEntryId: string;
    turnId: string;
    targetSource: ACPUpdateTarget['source'];
    modelInfo?: ModelInfo;
    // Counts notifications (in `args.updates` order) whose history writes
    // committed. Text batches and rich-content uploads interleave inside one
    // call, so a mid-group failure leaves a persisted prefix; the caller must
    // only re-queue past this watermark or short text chunks (intentionally not
    // deduplicated) would duplicate on retry.
    progress?: { persistedNotifications: number };
  }): Promise<void> {
    const persistNotifications = async (notifications: AcpSessionNotification[]) => {
      if (notifications.length === 0) {
        return;
      }
      await appendACPNotificationsToAssistantEntry(
        args.sessionDoc,
        notifications,
        args.assistantEntryId,
        {
          logger: this.logger,
          editCallback: async (edits) => {
            // Edit tool calls (Codex apply_patch et al) bypass `fs/write_text_file` and
            // standard ACP diff blocks. Collect them so the turn-end persist can gap-fill
            // them into the diff store (old text chained from the prior recorded state),
            // keeping the turn-diff badge and its clickable content from the same source.
            this.collectCodeCollabEditEvidence(args.sessionId, args.turnId, edits);
          },
          standardDiffCallback: async (diffs) => {
            await this.collectCodeCollabStandardDiffs(args.sessionId, args.turnId, diffs);
          },
        },
        args.modelInfo
      );
      if (args.progress) {
        args.progress.persistedNotifications += notifications.length;
      }
      await this.markACPNotificationsUnread(args.sessionId, args.sessionDoc, notifications);
      if (args.targetSource === 'finalized_turn') {
        await this.persistLateCodeCollabTurnDiffs(args.sessionId, args.turnId);
      }
    };

    const flushNotifications = async (notifications: AcpSessionNotification[]) => {
      // Plan persistence has a second doc write (`setPlan`) after the history
      // batch. Keep plan and non-plan notifications at separate progress
      // boundaries, while retaining the existing coalescing semantics for
      // consecutive plan snapshots (only the latest snapshot is written).
      let batch: AcpSessionNotification[] = [];
      for (const notification of notifications) {
        const isPlan = notification.update.sessionUpdate === 'plan';
        const batchIsPlan = batch[0]?.update.sessionUpdate === 'plan';
        if (batch.length > 0 && isPlan !== batchIsPlan) {
          await persistNotifications(batch);
          batch = [];
        }
        batch.push(notification);
      }
      await persistNotifications(batch);
    };

    const appendContents = async (contents: MessageContent[]) => {
      if (contents.length === 0) {
        return;
      }
      await args.sessionDoc.updateHistory((history) =>
        applyMessageContentsBatch(history, contents, {
          targetAssistantEntryId: args.assistantEntryId,
          createId: () => args.assistantEntryId,
          now: () => new Date(getServerNow()).toISOString(),
          model: args.modelInfo,
        })
      );
    };

    let pendingNotifications: AcpSessionNotification[] = [];
    for (const update of args.updates) {
      const { notification } = update;
      if (!isACPAgentRichContentNotification(notification)) {
        pendingNotifications.push(notification);
        continue;
      }

      await flushNotifications(pendingNotifications);
      pendingNotifications = [];

      const contents =
        update.materializedContents ??
        (await materializeACPAgentRichContent({
          workspaceId: this.workspaceId,
          sessionId: args.sessionId,
          notification,
          logger: this.logger,
          resolveSessionWorkspaceRoot: (sessionId) => this.resolveSessionWorkspaceRoot(sessionId),
          validateSessionImageUploadPath: async (filePath) =>
            await this.validateSessionImageUploadPath(filePath),
          uploadSessionImageFile: async (uploadArgs) =>
            await this.uploadSessionImageFile(uploadArgs),
          validateSessionFileUploadPath: async (filePath, options) =>
            await this.validateSessionFileUploadPath(filePath, options),
          uploadValidatedSessionFile: async (uploadArgs) =>
            await this.uploadValidatedSessionFile(uploadArgs),
        }));
      update.materializedContents = contents;
      await appendContents(contents);
      if (args.progress) {
        args.progress.persistedNotifications += 1;
      }
      await this.markACPNotificationsUnread(args.sessionId, args.sessionDoc, [notification]);
    }

    await flushNotifications(pendingNotifications);
  }

  private async flushACPUpdates(sessionId: SessionId): Promise<void> {
    // Ordering barrier for RPC fast-path turns: persist nothing until the user
    // turn entry is local (or the gate times out). The buffer keeps
    // accumulating behind the in-flight flush, so this coalesces naturally.
    await this.awaitTurnHistoryGate(sessionId);
    const state = this.store.get(sessionId);
    this.clearScheduledACPFlush(sessionId);
    const queue = state.acpUpdateBuffer;
    if (queue.length === 0) {
      return;
    }
    state.acpUpdateBuffer = [];
    state.acpFlushCountInTurn += 1;
    const notifications = queue.map((item) => item.notification);
    const groups = this.groupBufferedACPUpdates(queue);
    const span = startTraceSpan(this.logger, 'acp.flush_updates_batch', {
      sessionId,
      turnId: this.store.getTurnId(sessionId),
      updates: notifications.length,
      groups: groups.length,
      flushCount: state.acpFlushCountInTurn,
    });

    const session = this.sessionManager.getSession(sessionId);
    const modelInfo = session?.agentClient?.currentModel;
    const modelInfoForHistory = this.sanitizeModelInfoForHistory(modelInfo);
    let sessionDoc: SessionDocument | undefined;
    const writtenTargetKeys = new Set<string>();
    // A group can fail after part of it persisted (text batches and rich-content
    // uploads interleave inside appendACPUpdatesToAssistantEntry), so failure
    // progress is tracked per notification, not per group: re-queueing an
    // already-persisted text prefix would duplicate short chunks, which the
    // stream merge intentionally does not deduplicate.
    let failedGroupKey: string | null = null;
    let failedGroupPersisted = 0;
    try {
      sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
      for (const group of groups) {
        const progress = { persistedNotifications: 0 };
        try {
          const runtimeConfigPatch = mergeAcpRuntimeConfigUpdates(
            group.updates.map((update) => update.notification)
          );
          if (runtimeConfigPatch && group.target.userTurnId) {
            sessionDoc.applyAcpRuntimeConfigPatch(group.target.userTurnId, runtimeConfigPatch);
          } else if (runtimeConfigPatch) {
            this.logger.debug(
              `[${sessionId}] Ignoring ACP runtime config update without a driving user turn`
            );
          }
          await this.appendACPUpdatesToAssistantEntry({
            sessionId,
            sessionDoc,
            updates: group.updates,
            assistantEntryId: group.target.assistantEntryId,
            turnId: group.target.turnId,
            targetSource: group.target.source,
            modelInfo: modelInfoForHistory,
            progress,
          });
        } catch (error) {
          failedGroupKey = this.getACPUpdateTargetKey(group.target);
          failedGroupPersisted = progress.persistedNotifications;
          throw error;
        }
        writtenTargetKeys.add(this.getACPUpdateTargetKey(group.target));
      }
      span.end();
    } catch (error) {
      // At-least-once: re-queue every update that was not persisted at the head
      // of the buffer (ahead of updates enqueued during this flush), so a later
      // flush — scheduled, forced, or the finalize drain — retries instead of
      // silently losing a window of streamed output. The failed group's
      // persisted prefix is skipped (grouping preserves per-target queue order).
      let skipPersistedOfFailedGroup = failedGroupPersisted;
      const unwritten = queue.filter((item) => {
        const key = this.getACPUpdateTargetKey(item.target);
        if (writtenTargetKeys.has(key)) {
          return false;
        }
        if (key === failedGroupKey && skipPersistedOfFailedGroup > 0) {
          skipPersistedOfFailedGroup -= 1;
          return false;
        }
        return true;
      });
      if (unwritten.length > 0) {
        state.acpUpdateBuffer = [...unwritten, ...state.acpUpdateBuffer];
      }
      span.fail(error);
      this.logger.error(
        `[${sessionId}] ACP update batch summary: ${this.summarizeACPUpdateBatch(notifications)}`
      );
      this.logger.error(
        `[${sessionId}] ACP model info: ${JSON.stringify(this.summarizeModelInfo(modelInfo))}`
      );
      try {
        const history = sessionDoc ? await sessionDoc.getHistory() : undefined;
        this.logger.error(
          `[${sessionId}] ACP history diagnostics: ${
            history ? JSON.stringify(this.summarizeSessionHistoryForDiagnostics(history)) : 'no doc'
          }`
        );
      } catch (diagnosticError) {
        this.logger.error(
          `[${sessionId}] Failed to collect ACP history diagnostics: ${formatErrorMessage(
            diagnosticError
          )}`
        );
      }
      this.logger.error(
        `[${sessionId}] ACP flush error: ${formatErrorMessage(error, { includeStack: true })}`
      );
      throw error;
    }
  }

  private async markACPNotificationsUnread(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    notifications: readonly AcpSessionNotification[]
  ): Promise<void> {
    if (!this.shouldMarkSessionUnread(notifications)) {
      return;
    }
    const state = this.store.get(sessionId);
    if (state.turn.phase !== 'idle') {
      state.pendingUnread = true;
      return;
    }
    try {
      await sessionDoc.setLastMessageAt();
    } catch (error) {
      this.logger.debug(
        `[${sessionId}] Failed to persist unread marker for out-of-turn ACP update: ${formatErrorMessage(error)}`
      );
    }
  }

  private async flushAllACPUpdates(): Promise<void> {
    for (const sessionId of this.store.sessionIds()) {
      if (this.store.hasPendingTurnWork(sessionId)) {
        await this.finalizeACPState(sessionId);
      }
    }
  }

  private codeCollabTurnDiffKey(sessionId: SessionId, turnId: string): string {
    return `${sessionId}\0${turnId}`;
  }

  private trackCodeCollabEvidenceWrite(sessionId: SessionId, promise: Promise<void>): void {
    let pending = this.codeCollabV2PendingEvidenceWrites.get(sessionId);
    if (!pending) {
      pending = new Set();
      this.codeCollabV2PendingEvidenceWrites.set(sessionId, pending);
    }
    pending.add(promise);
    void promise
      .finally(() => {
        const latest = this.codeCollabV2PendingEvidenceWrites.get(sessionId);
        latest?.delete(promise);
        if (latest?.size === 0) {
          this.codeCollabV2PendingEvidenceWrites.delete(sessionId);
        }
      })
      .catch(() => {});
  }

  private async flushCodeCollabEvidenceWrites(sessionId: SessionId): Promise<void> {
    while (true) {
      const pending = this.codeCollabV2PendingEvidenceWrites.get(sessionId);
      if (!pending || pending.size === 0) {
        return;
      }
      const results = await Promise.allSettled([...pending]);
      for (const result of results) {
        if (result.status === 'rejected') {
          this.logger.debug(
            `[${sessionId}] Code Collab v2 diff evidence collection failed: ${formatErrorMessage(
              result.reason
            )}`
          );
        }
      }
    }
  }

  private async flushAllCodeCollabEvidenceWrites(): Promise<void> {
    while (true) {
      const pending = [...this.codeCollabV2PendingEvidenceWrites.values()].flatMap((writes) => [
        ...writes,
      ]);
      if (pending.length === 0) {
        return;
      }
      await Promise.allSettled(pending);
    }
  }

  private async collectCodeCollabStandardDiffs(
    sessionId: SessionId,
    turnId: string,
    diffs: readonly AcpStandardDiffBlockEvidence[]
  ): Promise<void> {
    if (diffs.length === 0) {
      return;
    }
    const resolved = await this.resolveCodeCollabV2Workspace(sessionId);
    if (!resolved.ok) {
      if (resolved.code === 'transient_io' || resolved.code === 'machine_offline') {
        throw new CodeCollabV2ServiceError(resolved.code, resolved.message, { retryable: true });
      }
      this.logger.debug(
        `[${sessionId}] Dropping Code Collab v2 standard diff evidence: ${resolved.code}`
      );
      return;
    }
    const key = this.codeCollabTurnDiffKey(sessionId, turnId);
    const existing = this.codeCollabV2TurnDiffs.get(key) ?? [];
    for (const diff of diffs) {
      const event = await pendingEventFromStandardDiffEvidence({
        workspaceRoot: resolved.workspaceRoot,
        diff,
      });
      if (event) {
        existing.push(event);
      }
    }
    if (existing.length > 0) {
      this.codeCollabV2TurnDiffs.set(key, existing);
    }
  }

  private async collectCodeCollabWriteTextFileEvidence(
    sessionId: SessionId,
    evidence: AcpWriteTextFileEvidence
  ): Promise<void> {
    const turnId = this.store.getTurnId(sessionId);
    if (!turnId) {
      return;
    }
    await this.collectCodeCollabWriteEvidence(sessionId, turnId, evidence);
  }

  private async collectCodeCollabWriteEvidence(
    sessionId: SessionId,
    turnId: string,
    evidence: CodeCollabV2WriteTextFileEvidence
  ): Promise<void> {
    // Buffer the exact fs/write_text_file payload before resolving workspace
    // ownership. Resolution is retried by turn persistence; doing it here would
    // turn a transient machine/workspace lookup failure into permanent evidence
    // loss because this event is delivered only once.
    const event = pendingEventFromWriteTextFileEvidence(evidence);
    const key = this.codeCollabTurnDiffKey(sessionId, turnId);
    const existing = this.codeCollabV2TurnDiffs.get(key) ?? [];
    existing.push(event);
    this.codeCollabV2TurnDiffs.set(key, existing);
  }

  private collectCodeCollabEditEvidence(
    sessionId: SessionId,
    turnId: string,
    edits: readonly AcpAgentEditEvidence[]
  ): void {
    if (edits.length === 0) {
      return;
    }
    const key = this.codeCollabTurnDiffKey(sessionId, turnId);
    const existing = this.codeCollabV2TurnEdits.get(key) ?? [];
    existing.push(...edits);
    this.codeCollabV2TurnEdits.set(key, existing);
  }

  // Gap-fill edit-tool changes (apply_patch et al) that produced no fs/write_text_file or
  // standard ACP diff evidence: new text is the file's current on-disk content, old text is
  // chained from the prior recorded state for the path (see pendingEventFromAgentEditEvidence).
  // `getLatestText` is read before recordTurnDiffs, so it reflects the pre-turn state. Paths
  // already covered by strong ACP evidence this turn are skipped (that evidence is exact).
  private async buildCodeCollabEditGapEvents(
    workspaceRoot: string,
    ownerSessionId: SessionId,
    acpEvents: readonly CodeCollabV2PendingDiffStoreEvent[],
    editEvidence: readonly AcpAgentEditEvidence[]
  ): Promise<CodeCollabV2PendingDiffStoreEvent[]> {
    if (editEvidence.length === 0) {
      return [];
    }
    const coveredRelativePaths = new Set<string>();
    for (const event of acpEvents) {
      const resolved = resolveCodeCollabV2EvidencePath(workspaceRoot, event.path);
      if (resolved) {
        coveredRelativePaths.add(resolved.relativePath);
      }
    }
    // Dedup edits per path; the converter reads the file's final on-disk state, so the last
    // edit to a path in the turn subsumes earlier ones.
    const latestEditByPath = new Map<string, AcpAgentEditEvidence>();
    for (const edit of editEvidence) {
      latestEditByPath.set(edit.path, edit);
    }
    const gapEvents: CodeCollabV2PendingDiffStoreEvent[] = [];
    for (const edit of latestEditByPath.values()) {
      const resolved = resolveCodeCollabV2EvidencePath(workspaceRoot, edit.path);
      if (!resolved || coveredRelativePaths.has(resolved.relativePath)) {
        continue;
      }
      const normalizedEdit = {
        path: edit.path,
        changeType: edit.changeType,
        contentOldText: edit.contentOldText,
        oldString: edit.oldString,
        newString: edit.newString,
      };
      const hasDirectOldEvidence =
        typeof edit.contentOldText === 'string' ||
        (edit.oldString !== undefined && edit.newString !== undefined);
      let latestText: AgentEditLatestText = { status: 'untracked' };
      let event = hasDirectOldEvidence
        ? await pendingEventFromAgentEditEvidence({
            workspaceRoot,
            edit: normalizedEdit,
            latestText,
          })
        : null;
      if (!event) {
        latestText = await this.codeCollabV2DiffStore.getLatestText({
          ownerSessionId,
          path: resolved.relativePath,
          maxRawBytes: CODE_COLLAB_V2_TEXT_LIMITS.maxRawTextBytes,
        });
        event = await pendingEventFromAgentEditEvidence({
          workspaceRoot,
          edit: normalizedEdit,
          latestText,
        });
      }
      if (!event) {
        const message = `Code Collab v2 edit evidence for ${edit.path} (${edit.changeType}) could not be converted into a turn diff event; missing pre-image or unreadable current file`;
        this.logger.error(
          `[${ownerSessionId}] ${message} latestText=${latestText.status} workspaceRoot=${workspaceRoot}`
        );
        throw new Error(message);
      }
      gapEvents.push(event);
    }
    return gapEvents;
  }

  private mergeCodeCollabTurnDiffEvents(
    events: readonly CodeCollabV2PendingDiffStoreEvent[]
  ): CodeCollabV2DiffStoreEvent[] {
    return mergePendingDiffStoreEvents(events);
  }

  private async persistCodeCollabTurnDiffsOnce(
    sessionId: SessionId,
    turnId: string
  ): Promise<boolean> {
    await this.flushCodeCollabEvidenceWrites(sessionId);
    const key = this.codeCollabTurnDiffKey(sessionId, turnId);
    const acpEvents = this.codeCollabV2TurnDiffs.get(key) ?? [];
    this.codeCollabV2TurnDiffs.delete(key);
    const editEvidence = this.codeCollabV2TurnEdits.get(key) ?? [];
    this.codeCollabV2TurnEdits.delete(key);
    if (acpEvents.length === 0 && editEvidence.length === 0) {
      return false;
    }
    try {
      const resolved = await this.resolveCodeCollabV2Workspace(sessionId);
      if (!resolved.ok) {
        if (resolved.code === 'transient_io' || resolved.code === 'machine_offline') {
          throw new CodeCollabV2ServiceError(resolved.code, resolved.message, { retryable: true });
        }
        this.logger.debug(
          `[${sessionId}] Dropping Code Collab v2 diff evidence for turn ${turnId}: ${resolved.code}`
        );
        return false;
      }
      const gapEvents = await this.buildCodeCollabEditGapEvents(
        resolved.workspaceRoot,
        resolved.ownerSessionId,
        acpEvents,
        editEvidence
      );
      const mergedEvents = this.mergeCodeCollabTurnDiffEvents([...acpEvents, ...gapEvents]);
      if (mergedEvents.length === 0) {
        return false;
      }
      const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
      const recordedAtMs = getServerNow();
      const turnStorageMetadata = sessionDoc.getAssistantHistoryEntryTurnStorageMetadata(turnId);
      const capturedAtMs = turnStorageMetadata?.capturedAtMs ?? recordedAtMs;
      const fileDiff = await this.codeCollabV2DiffStore.recordTurnDiffs({
        workspaceRoot: resolved.workspaceRoot,
        ownerSessionId: resolved.ownerSessionId,
        turnId,
        events: mergedEvents,
        capturedAtMs,
        recordedAtMs,
        orderKey:
          turnStorageMetadata?.orderKey ??
          `${capturedAtMs.toString().padStart(16, '0')}:${sessionId}:${turnId}`,
      });
      if (fileDiff.length === 0) {
        return false;
      }
      const updated = sessionDoc.setLatestAssistantHistoryFileDiff(fileDiff, turnId);
      if (!updated) {
        this.logger.debug(
          `[${sessionId}] Code Collab v2 diff evidence persisted, but no assistant history entry matched turn ${turnId}`
        );
      }
      return updated;
    } catch (error) {
      // A later finalized-turn update is a natural retry trigger. Put the
      // captured evidence back ahead of anything collected concurrently so a
      // transient workspace/SQLite/history failure cannot lose it.
      const concurrentAcpEvents = this.codeCollabV2TurnDiffs.get(key) ?? [];
      const concurrentEditEvidence = this.codeCollabV2TurnEdits.get(key) ?? [];
      const restoredAcpEvents = [...acpEvents, ...concurrentAcpEvents];
      const restoredEditEvidence = [...editEvidence, ...concurrentEditEvidence];
      if (restoredAcpEvents.length > 0) {
        this.codeCollabV2TurnDiffs.set(key, restoredAcpEvents);
      }
      if (restoredEditEvidence.length > 0) {
        this.codeCollabV2TurnEdits.set(key, restoredEditEvidence);
      }
      throw error;
    }
  }

  private async persistCodeCollabTurnDiffs(sessionId: SessionId, turnId: string): Promise<boolean> {
    const key = this.codeCollabTurnDiffKey(sessionId, turnId);
    const previous = this.codeCollabV2TurnPersistChains.get(key) ?? Promise.resolve();
    let persisted = false;
    const next = previous
      .catch(() => {})
      .then(async () => {
        persisted = await this.persistCodeCollabTurnDiffsOnce(sessionId, turnId);
      });
    this.codeCollabV2TurnPersistChains.set(key, next);
    try {
      await next;
      return persisted;
    } finally {
      if (this.codeCollabV2TurnPersistChains.get(key) === next) {
        this.codeCollabV2TurnPersistChains.delete(key);
      }
    }
  }

  private clearCodeCollabTurnRetry(sessionId: SessionId, turnId: string): void {
    const key = this.codeCollabTurnDiffKey(sessionId, turnId);
    const timer = this.codeCollabV2TurnRetryTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.codeCollabV2TurnRetryTimers.delete(key);
    }
    this.codeCollabV2TurnRetryFailures.delete(key);
  }

  private scheduleCodeCollabTurnRetry(sessionId: SessionId, turnId: string): void {
    if (this.cleanedUp || this.deletedSessionIds.has(sessionId)) {
      return;
    }
    const key = this.codeCollabTurnDiffKey(sessionId, turnId);
    if (this.codeCollabV2TurnRetryTimers.has(key)) {
      return;
    }
    const failures = (this.codeCollabV2TurnRetryFailures.get(key) ?? 0) + 1;
    this.codeCollabV2TurnRetryFailures.set(key, failures);
    if (failures > MessageHandler.CODE_COLLAB_EVIDENCE_MAX_AUTOMATIC_RETRIES) {
      this.logger.warn(
        `[${sessionId}] Pausing automatic Code Collab evidence retries for turn ${turnId} after ${failures - 1} failures; evidence remains buffered for a later trigger`
      );
      return;
    }
    const retryDelayMs = Math.min(
      MessageHandler.CODE_COLLAB_EVIDENCE_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, failures - 1),
      MessageHandler.CODE_COLLAB_EVIDENCE_RETRY_MAX_DELAY_MS
    );
    const timer = setTimeout(() => {
      this.codeCollabV2TurnRetryTimers.delete(key);
      if (this.cleanedUp || this.deletedSessionIds.has(sessionId)) {
        this.codeCollabV2TurnRetryFailures.delete(key);
        return;
      }
      void this.persistLateCodeCollabTurnDiffs(sessionId, turnId);
    }, retryDelayMs);
    timer.unref?.();
    this.codeCollabV2TurnRetryTimers.set(key, timer);
  }

  private cancelAllCodeCollabTurnRetryTimers(): void {
    for (const timer of this.codeCollabV2TurnRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.codeCollabV2TurnRetryTimers.clear();
  }

  private async drainCodeCollabTurnPersistenceForCleanup(): Promise<void> {
    this.cancelAllCodeCollabTurnRetryTimers();
    // Producers have stopped, but their async write_text_file collectors may
    // still be resolving workspace ownership. Wait until they have populated
    // the per-turn maps before taking any map/chain snapshot.
    await this.flushAllCodeCollabEvidenceWrites();
    const inFlight = [...this.codeCollabV2TurnPersistChains.values()];
    if (inFlight.length > 0) {
      await Promise.allSettled(inFlight);
    }

    // Cleanup cannot leave timer-backed evidence for the next process: these
    // maps are memory-only. Retry each retained turn directly while the diff
    // store and session documents are still alive, without replaying history.
    for (
      let round = 0;
      round < MessageHandler.CODE_COLLAB_EVIDENCE_MAX_AUTOMATIC_RETRIES;
      round += 1
    ) {
      const keys = new Set([
        ...this.codeCollabV2TurnDiffs.keys(),
        ...this.codeCollabV2TurnEdits.keys(),
      ]);
      if (keys.size === 0) {
        break;
      }
      for (const key of keys) {
        const separatorIndex = key.indexOf('\0');
        if (separatorIndex <= 0) {
          continue;
        }
        const sessionId = key.slice(0, separatorIndex) as SessionId;
        const turnId = key.slice(separatorIndex + 1);
        try {
          await this.persistCodeCollabTurnDiffs(sessionId, turnId);
        } catch (error) {
          this.logger.debug(
            `[${sessionId}] Cleanup retry ${round + 1} failed to persist Code Collab v2 evidence for turn ${turnId}: ${formatErrorMessage(error)}`
          );
        }
      }
    }

    const remainingKeys = new Set([
      ...this.codeCollabV2TurnDiffs.keys(),
      ...this.codeCollabV2TurnEdits.keys(),
    ]);
    if (remainingKeys.size > 0) {
      this.logger.warn(
        `Message handler cleanup could not persist Code Collab v2 evidence for ${remainingKeys.size} turn(s)`
      );
    }
    this.cancelAllCodeCollabTurnRetryTimers();
    this.codeCollabV2TurnRetryFailures.clear();
  }

  private async quiesceCodeCollabTurnPersistenceForDeletion(sessionId: SessionId): Promise<void> {
    const keyPrefix = `${sessionId}\0`;
    for (const [key, timer] of this.codeCollabV2TurnRetryTimers) {
      if (key.startsWith(keyPrefix)) {
        clearTimeout(timer);
        this.codeCollabV2TurnRetryTimers.delete(key);
      }
    }
    for (const key of this.codeCollabV2TurnRetryFailures.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.codeCollabV2TurnRetryFailures.delete(key);
      }
    }
    await this.flushCodeCollabEvidenceWrites(sessionId);
    const inFlight = [...this.codeCollabV2TurnPersistChains]
      .filter(([key]) => key.startsWith(keyPrefix))
      .map(([, promise]) => promise);
    if (inFlight.length > 0) {
      await Promise.allSettled(inFlight);
    }
    for (const key of this.codeCollabV2TurnDiffs.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.codeCollabV2TurnDiffs.delete(key);
      }
    }
    for (const key of this.codeCollabV2TurnEdits.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.codeCollabV2TurnEdits.delete(key);
      }
    }
  }

  private async persistLateCodeCollabTurnDiffs(
    sessionId: SessionId,
    turnId: string
  ): Promise<void> {
    try {
      await this.persistCodeCollabTurnDiffs(sessionId, turnId);
      this.clearCodeCollabTurnRetry(sessionId, turnId);
    } catch (error) {
      this.logger.debug(
        `[${sessionId}] Failed to persist late Code Collab v2 evidence for turn ${turnId}: ${formatErrorMessage(error)}`
      );
      this.scheduleCodeCollabTurnRetry(sessionId, turnId);
    }
  }

  private async finalizeACPState(sessionId: SessionId, turnId?: string): Promise<void> {
    // Finalization marks the last assistant entry finished — that entry must
    // exist and be correctly ordered first, so wait for the turn history gate
    // (bounded; opens on user-turn sync or timeout).
    if (!turnId || this.store.getTurnId(sessionId) === turnId) {
      await this.awaitTurnHistoryGate(sessionId);
    }
    // Capture timing data and turnId before clearing state
    const endedAt = Date.now();
    const state = this.store.get(sessionId);
    const currentTarget = this.store.getCurrentACPUpdateTarget(sessionId);
    const finalizedTarget = !turnId || currentTarget?.turnId === turnId ? currentTarget : undefined;
    const permissionWaitMs = state.permissionWaitMs || undefined;
    try {
      await this.flushSessionContextWindowUsage(sessionId);
      await this.flushACPUpdatesNow(sessionId);
      await this.flushThreadGoalHistoryPersists(sessionId);
      await this.flushCodexGeneratedImageUploads(sessionId);
      if (state.pendingUnread) {
        state.pendingUnread = false;
        const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
        await sessionDoc.setLastMessageAt();
      }

      // Mark the owning assistant entry as finished and record timing.
      const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
      await sessionDoc.updateHistory((history) =>
        markAssistantTurnFinished(history, { turnId, endedAt, permissionWaitMs })
      );
      await sessionDoc.waitUntilSynced();
    } catch (error) {
      this.logger.error(`[${sessionId}] Failed to flush ACP updates during finalization:`, error);
    } finally {
      if (finalizedTarget) {
        this.store.rememberFinalizedTurnForLateACPUpdates(sessionId, finalizedTarget);
      }
      if (turnId) {
        this.clearConversationTurnIfMatches(sessionId, turnId);
      } else {
        this.clearACPState(sessionId);
      }
      // Updates buffered during the finalization tail survive the turn clear
      // (each carries its enqueue-time target); make sure something drains them.
      if (this.store.get(sessionId).acpUpdateBuffer.length > 0) {
        this.scheduleFlushACPUpdates(sessionId);
      }
    }
  }

  private clearACPState(sessionId: SessionId): void {
    this.store.clearTurnState(sessionId);
  }

  private clearConversationTurnIfMatches(sessionId: SessionId, turnId: string): void {
    if (this.store.getTurnId(sessionId) !== turnId) {
      return;
    }
    this.clearACPState(sessionId);
  }

  private beginACPReplaySuppression(sessionId: SessionId): void {
    this.store.beginAcpReplaySuppression(sessionId);
  }

  private endACPReplaySuppression(sessionId: SessionId): void {
    const droppedCount = this.store.endAcpReplaySuppression(sessionId);
    if (droppedCount > 0) {
      this.logger.debug(
        `[${sessionId}] Dropped ${droppedCount} ACP replay notifications emitted during session restore before turn initialization`
      );
    }
  }

  private clearActiveTurnIdIfMatches(sessionId: SessionId, turnId: string): void {
    this.store.markPromptReturned(sessionId, turnId);
  }

  private startSessionActivePresence(
    sessionId: SessionId,
    phase?: SessionActivePresencePhase | null,
    detail?: string
  ): void {
    this.sessionActivePresence.start(sessionId, phase, detail);
  }

  private setSessionActivePresencePhase(
    sessionId: SessionId,
    phase: SessionActivePresencePhase | null,
    detail?: string
  ): void {
    this.sessionActivePresence.setPhase(sessionId, phase, detail);
  }

  private hasSessionActivePresence(sessionId: SessionId): boolean {
    return this.sessionActivePresence.has(sessionId);
  }

  private clearSessionActivePresence(sessionId: SessionId): void {
    this.sessionActivePresence.clear(sessionId);
  }

  private createRuntimeDispatchContext(): MessageDispatchContext {
    return {
      source: 'runtime',
      send: () => {},
    };
  }

  private resolveDispatchContext(context?: MessageDispatchContext): MessageDispatchContext {
    return context ?? this.createRuntimeDispatchContext();
  }

  private getAssistantEntryIdForUserTurn(userTurnId: string): string {
    return `assistant:${userTurnId}`;
  }

  private beginConversationTurn(
    sessionId: SessionId,
    userTurnId?: string,
    gateContext?: ConversationTurnGateContext
  ): string {
    const turnId = userTurnId ? this.getAssistantEntryIdForUserTurn(userTurnId) : uuidV4();
    this.store.beginTurn(sessionId, {
      turnId,
      assistantEntryId: turnId,
      ownsACPUpdates: !gateContext?.deferACPUpdateTarget,
      ...(userTurnId ? { userTurnId } : {}),
    });
    this.setTurnHistoryGate(sessionId, turnId, userTurnId, gateContext);
    return turnId;
  }

  private async recordOwnerAccessAllowedSnapshot(): Promise<void> {
    await this.recordWorkspaceAccessSnapshot({
      ownerUserId: this.userId,
      verifiedAt: new Date(getServerNow()).toISOString(),
    });
  }

  // Optimistic-allow cache write (D11). Reached only via the dispatch
  // watcher's background owner recheck (`recordOwnerAccessSnapshot` dep):
  // non-null refreshes the cached allow after a confirmed backend allow,
  // `null` clears it after a definitive backend deny. Never called from the
  // owner fast-path — snapshots reflect real online verdicts only.
  private async recordWorkspaceAccessSnapshot(
    accessSnapshot: LocalCatalogAccessSnapshot | null
  ): Promise<void> {
    await Effect.runPromise(
      this.localWorkspaceCatalog.recordWorkspaceAccessSnapshot({
        workspaceId: this.workspaceId,
        accessSnapshot,
      })
    );
  }

  private activateConversationTurnForACPUpdates(sessionId: SessionId, turnId: string): void {
    this.store.activateTurnACPUpdateTarget(sessionId, turnId);
  }

  /**
   * Install the turn's history-write gate. Only RPC fast-path turns get a
   * pending gate: their payload can outrun the user entry's CRDT sync, and
   * persisting turn output before that entry exists locally makes the two list
   * insertions concurrent — the Loro merge tiebreak can then permanently order
   * the agent reply before the user message. CRDT/queue-sourced turns have the
   * entry locally by construction and need no gate.
   *
   * The gate itself creates the turn's assistant entry when it opens, so every
   * gated writer resumes against an existing, correctly-ordered entry.
   */
  private setTurnHistoryGate(
    sessionId: SessionId,
    turnId: string,
    userTurnId: string | undefined,
    gateContext?: ConversationTurnGateContext
  ): void {
    const state = this.store.get(sessionId);
    state.turnHistoryGate?.dispose();
    if (gateContext?.dispatchSource !== 'rpc' || !userTurnId) {
      state.turnHistoryGate = null;
      return;
    }
    const { sessionDoc } = gateContext;
    state.turnHistoryGate = TurnHistoryGate.waitForUserTurn({
      logger: this.logger,
      sessionId,
      userTurnId,
      readHistory: () => sessionDoc.getHistory(),
      subscribeHistory: (listener) => sessionDoc.mirror?.subscribe(listener),
      onBeforeOpen: async () => {
        await this.writeAssistantEntryForTurn(
          sessionId,
          sessionDoc,
          turnId,
          this.sessionManager.getSession(sessionId)?.agentClient?.currentModel,
          userTurnId
        );
      },
    });
  }

  /** Wait until turn-scoped history writes may proceed (no-op without a gate). */
  private async awaitTurnHistoryGate(sessionId: SessionId): Promise<void> {
    if (!this.store.has(sessionId)) {
      return;
    }
    const state = this.store.get(sessionId);
    const gate = state.turnHistoryGate;
    if (!gate) {
      return;
    }
    const turn = state.turn;
    await traceAsync(
      this.logger,
      'history.turn_gate_wait',
      {
        sessionId,
        ...(turn.phase === 'idle' ? {} : { turnId: turn.turnId }),
        ...(turn.phase === 'idle' || !turn.userTurnId ? {} : { userTurnId: turn.userTurnId }),
      },
      async () => await gate.waitUntilOpen()
    );
  }

  private async registerMachineAccess(): Promise<void> {
    await this.ensureMachineAccessRegistered();
  }

  private async attemptMachineAccessRegistration(): Promise<void> {
    try {
      await this.registerMachineAccess();
    } catch (error) {
      this.logger.warn(
        `Failed to register backend machine access: ${formatErrorMessage(error, {
          includeStack: true,
        })}`
      );
    }
  }

  private async ensureMachineAccessRegistered(): Promise<void> {
    const now = Date.now();
    if (this.machineAccessRegistrationExpiresAtMs > now) {
      return;
    }
    if (this.machineAccessRegistrationInFlight) {
      return await this.machineAccessRegistrationInFlight;
    }
    const startedAtMs = now;
    const registration = this.cloudPort.access
      .registerMachineAccess({
        workspaceId: this.workspaceId,
        machineId: this.machineId,
      })
      .then(() => {
        this.machineAccessRegistrationExpiresAtMs =
          Date.now() + MessageHandler.MACHINE_ACCESS_REGISTRATION_CACHE_TTL_MS;
        // Note: registration success is NOT a canUseMachine verdict; access
        // snapshots are written only from real canUseMachine results.
        this.logCodeCollabDebug(
          `[machine:${this.machineId}] Code Collab machine access registration completed durationMs=${Date.now() - startedAtMs}`
        );
      })
      .finally(() => {
        if (this.machineAccessRegistrationInFlight === registration) {
          this.machineAccessRegistrationInFlight = null;
        }
      });
    this.machineAccessRegistrationInFlight = registration;
    await registration;
  }

  /**
   * Ensure machine metadata and presence runtime are live for this runtime.
   */
  async registerMachine(): Promise<void> {
    try {
      const supportsStreamsRpc = !!this.machineRpcServer;
      // Restore the machine document first to ensure it's marked as online
      await this.workspaceDocument.restoreMachineDocument(this.machineId);

      // Start watching for existence changes and auto-restore the document
      this.workspaceDocument.watchMachineDocumentExistence(this.machineId);

      const machineRoomId = getMachineRoomId(this.machineId);
      const machineMeta = (await this.workspaceDocument.repo.getDocMeta(machineRoomId))?.meta as
        | MachineMeta
        | undefined;
      const existingName = machineMeta?.name?.trim();
      // The CLI startup name is only a bootstrap default. Settings-page renames own the
      // persisted display name, so reconnect/registration must not overwrite synced edits.
      const registeredName = existingName || this.machineName;
      await this.workspaceDocument.registerMachine(this.machineId, {
        id: this.machineId,
        name: registeredName,
        ownerUserId: this.userId,
        hostType: 'user',
        cliVersion: this.cliVersion,
        os: process.platform,
        rpcVersion: supportsStreamsRpc ? LORO_STREAMS_RPC_VERSION : machineMeta?.rpcVersion,
        supportsLocalProjectHistoryRpc: supportsStreamsRpc,
        protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
        supportRegistryAgentTypes: this.supportRegistryAgentTypes,
        sessions: machineMeta?.sessions ?? [],
      });
      await this.publishMachineDotlodyPath();
      this.logger.debug(`Machine registered with name: ${registeredName}`);
    } catch (error) {
      this.logger.error(`Failed to register machine: ${formatErrorMessage(error)}`);
      throw error;
    }
  }

  private async resolveCodeCollabWorkspaceRoot(
    sessionId: SessionId
  ): Promise<CodeCollabWorkspaceRootResolution> {
    const resolveActiveSessionWorkspaceRoot = (
      targetSessionId: SessionId,
      source: string
    ): CodeCollabWorkspaceRootResolution | null => {
      const session = this.sessionManager.getSession(targetSessionId);
      if (!session) {
        return null;
      }
      return {
        ok: true,
        workspaceRoot: session.getHostWorkdir() ?? session.getWorkdir(),
        source,
      };
    };

    const waitForSessionWorkspaceRoot = async (input: {
      readonly targetSessionId: SessionId;
      readonly activeSource: string;
      readonly pendingSource: string;
      readonly timeoutMs: number;
    }): Promise<CodeCollabWorkspaceRootResolution | null> => {
      const deadline = Date.now() + input.timeoutMs;
      while (Date.now() <= deadline) {
        const active = resolveActiveSessionWorkspaceRoot(input.targetSessionId, input.activeSource);
        if (active) {
          return active;
        }

        const pending = this.sessionManager.getPendingSession(input.targetSessionId);
        if (pending) {
          const remainingMs = Math.max(1, deadline - Date.now());
          try {
            const session = await withTimeoutOrUndefined(pending, remainingMs);
            if (session) {
              return {
                ok: true,
                workspaceRoot: session.getHostWorkdir() ?? session.getWorkdir(),
                source: input.pendingSource,
              };
            }
          } catch (error) {
            this.logger.warn(
              `[${sessionId}] Code Collab v2 workspace resolution waited for session ${input.targetSessionId}, but session initialization failed: ${formatErrorMessage(error)}`
            );
          }
          return null;
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          break;
        }
        await delay(Math.min(CODE_COLLAB_WORKSPACE_WAIT_INTERVAL_MS, remainingMs));
      }
      return null;
    };

    const ownerSessionIdField = (
      parentSessionId: SessionId | undefined
    ): { readonly ownerSessionId?: SessionId } =>
      parentSessionId === undefined || parentSessionId === sessionId
        ? {}
        : { ownerSessionId: parentSessionId };

    const activeSession = this.sessionManager.getSession(sessionId);
    if (activeSession) {
      return {
        ok: true,
        workspaceRoot: activeSession.getHostWorkdir() ?? activeSession.getWorkdir(),
        source: 'active-session',
        ...ownerSessionIdField(activeSession.getParentSessionId()),
      };
    }

    const pendingSession = this.sessionManager.getPendingSession(sessionId);
    if (pendingSession) {
      let session: ISession | undefined;
      try {
        session = await withTimeoutOrUndefined(
          pendingSession,
          CODE_COLLAB_WORKSPACE_WAIT_TIMEOUT_MS
        );
      } catch (error) {
        this.logger.warn(
          `[${sessionId}] Code Collab v2 workspace resolution waited for session, but session initialization failed: ${formatErrorMessage(error)}`
        );
      }
      if (!session) {
        return {
          ok: false,
          error: 'session_initializing',
          message:
            'Session workspace is still being prepared. Code Collab will start after the session is ready.',
        };
      }
      return {
        ok: true,
        workspaceRoot: session.getHostWorkdir() ?? session.getWorkdir(),
        source: 'pending-session',
        ...ownerSessionIdField(session.getParentSessionId()),
      };
    }

    const metaRecord = await this.workspaceDocument.repo.getDocMeta(getSessionRoomId(sessionId));
    const meta =
      metaRecord?.meta && !isLoroRepoDocDeleted(metaRecord)
        ? (metaRecord.meta as SessionMeta)
        : undefined;
    if (!meta) {
      return {
        ok: false,
        error: 'session_not_found',
        message: 'Session metadata is not available.',
      };
    }
    if (meta.isArchived) {
      return {
        ok: false,
        error: 'session_archived',
        message: 'Session is archived.',
      };
    }

    const project = meta.project;
    const ownerSessionId = (meta.parentSessionId ?? sessionId) as SessionId;
    if (project?.kind === 'local') {
      const originalRootPath = await resolveWorkspaceLocalProjectRootPath(
        this.workspaceDocument.repo,
        this.workspaceId,
        this.machineId,
        project.localProjectId
      );
      if (!originalRootPath) {
        return {
          ok: false,
          error: 'workspace_unavailable',
          message: `Local project not found in workspace: ${project.localProjectId}`,
        };
      }
      const isLocalWorktree = meta.isWorktree === true || project.useWorktree === true;
      if (!isLocalWorktree) {
        return {
          ok: true,
          workspaceRoot: originalRootPath,
          source: `local-project:${project.localProjectId}`,
          ...ownerSessionIdField(ownerSessionId),
        };
      }

      const worktreeManager = getWorktreeManager({
        repoId: deriveRepoIdFromLocalProjectPath(originalRootPath),
        source: { kind: 'local-shared', originalRootPath },
        logger: this.logger,
      });
      if (worktreeManager.hasWorktree(ownerSessionId)) {
        return {
          ok: true,
          workspaceRoot: worktreeManager.getWorktreeHostPath(ownerSessionId),
          source: `local-worktree-existing:${ownerSessionId}`,
          ...ownerSessionIdField(ownerSessionId),
        };
      }

      // Fork metadata is persisted before asynchronous worktree creation starts. Never fall
      // back to originalRootPath here: it is the shared main checkout, so All Changes would
      // show another checkout's edits. Wait for the session, then recheck the worktree manager.
      this.logCodeCollabDebug(
        `[${sessionId}] Code Collab v2 workspace resolution waiting for local worktree ownerSessionId=${ownerSessionId} project=${project.localProjectId}`
      );
      const waited = await waitForSessionWorkspaceRoot({
        targetSessionId: ownerSessionId,
        activeSource:
          ownerSessionId === sessionId
            ? 'active-session-after-wait'
            : `active-parent-session:${ownerSessionId}`,
        pendingSource:
          ownerSessionId === sessionId
            ? 'pending-session-after-wait'
            : `pending-parent-session:${ownerSessionId}`,
        timeoutMs: CODE_COLLAB_WORKSPACE_WAIT_TIMEOUT_MS,
      });
      if (waited) {
        return waited.ok ? { ...waited, ...ownerSessionIdField(ownerSessionId) } : waited;
      }

      if (worktreeManager.hasWorktree(ownerSessionId)) {
        return {
          ok: true,
          workspaceRoot: worktreeManager.getWorktreeHostPath(ownerSessionId),
          source: `local-worktree-existing-after-wait:${ownerSessionId}`,
          ...ownerSessionIdField(ownerSessionId),
        };
      }

      return {
        ok: false,
        error: 'session_initializing',
        message:
          'Session workspace is still being prepared. Code Collab will start after the session is ready.',
      };
    }

    if (meta.parentSessionId) {
      const parentSession = this.sessionManager.getSession(meta.parentSessionId);
      if (parentSession) {
        return {
          ok: true,
          workspaceRoot: parentSession.getHostWorkdir() ?? parentSession.getWorkdir(),
          source: `active-parent-session:${meta.parentSessionId}`,
          ...ownerSessionIdField(ownerSessionId),
        };
      }
      const pendingParentSession = this.sessionManager.getPendingSession(meta.parentSessionId);
      if (pendingParentSession) {
        let session: ISession | undefined;
        try {
          session = await withTimeoutOrUndefined(
            pendingParentSession,
            CODE_COLLAB_WORKSPACE_WAIT_TIMEOUT_MS
          );
        } catch (error) {
          this.logger.warn(
            `[${sessionId}] Code Collab v2 workspace resolution waited for parent session ${meta.parentSessionId}, but session initialization failed: ${formatErrorMessage(error)}`
          );
        }
        if (!session) {
          return {
            ok: false,
            error: 'session_initializing',
            message:
              'Session workspace is still being prepared. Code Collab will start after the session is ready.',
          };
        }
        return {
          ok: true,
          workspaceRoot: session.getHostWorkdir() ?? session.getWorkdir(),
          source: `pending-parent-session:${meta.parentSessionId}`,
          ...ownerSessionIdField(ownerSessionId),
        };
      }
    }

    const repoFullName = resolveProjectGitHubRepo(project) ?? meta.repoFullName?.trim();
    if (repoFullName) {
      const repoId = deriveRepoIdFromGitHubRepo(repoFullName);
      const worktreeManager = getWorktreeManager({
        repoId,
        logger: this.logger,
      });

      if (worktreeManager.hasWorktree(ownerSessionId)) {
        return {
          ok: true,
          workspaceRoot: worktreeManager.getWorktreeHostPath(ownerSessionId),
          source: `github-worktree-existing:${ownerSessionId}`,
          ...ownerSessionIdField(ownerSessionId),
        };
      }

      this.logCodeCollabDebug(
        `[${sessionId}] Code Collab v2 workspace resolution waiting for session workspace ownerSessionId=${ownerSessionId} repo=${repoFullName}`
      );
      const waited = await waitForSessionWorkspaceRoot({
        targetSessionId: ownerSessionId,
        activeSource:
          ownerSessionId === sessionId
            ? 'active-session-after-wait'
            : `active-parent-session:${ownerSessionId}`,
        pendingSource:
          ownerSessionId === sessionId
            ? 'pending-session-after-wait'
            : `pending-parent-session:${ownerSessionId}`,
        timeoutMs: CODE_COLLAB_WORKSPACE_WAIT_TIMEOUT_MS,
      });
      if (waited) {
        return waited.ok ? { ...waited, ...ownerSessionIdField(ownerSessionId) } : waited;
      }

      if (worktreeManager.hasWorktree(ownerSessionId)) {
        return {
          ok: true,
          workspaceRoot: worktreeManager.getWorktreeHostPath(ownerSessionId),
          source: `github-worktree-existing-after-wait:${ownerSessionId}`,
          ...ownerSessionIdField(ownerSessionId),
        };
      }

      return {
        ok: false,
        error: 'session_initializing',
        message:
          'Session workspace is still being prepared. Code Collab will start after the session is ready.',
      };
    }

    return {
      ok: false,
      error: 'workspace_unavailable',
      message: 'Session has no local project or GitHub repository workspace.',
    };
  }

  private readonly resolveCodeCollabV2Workspace: CodeCollabV2WorkspaceResolver = async (
    sessionId,
    options?: CodeCollabV2WorkspaceResolveOptions
  ) => {
    try {
      const resolved = await this.resolveCodeCollabWorkspaceRoot(sessionId);
      if (resolved.ok) {
        const ownerSessionId = resolved.ownerSessionId ?? sessionId;
        const ownerMeta = await this.resolveCodeCollabOwnerSessionMeta(ownerSessionId);
        if (
          options?.access === 'write' &&
          !this.canWriteCodeCollabOwnerSession({
            requestedByUserId: options.requestedByUserId,
            ownerMeta,
          })
        ) {
          return {
            ok: false,
            code: 'permission_denied',
            message: 'Code Collab write access is denied for this user.',
          };
        }
        return {
          ok: true,
          ownerSessionId,
          workspaceRoot: resolved.workspaceRoot,
          allChangesBaseBranch: this.resolveGitHubProjectBranch(ownerMeta),
        };
      }
      if (resolved.error === 'session_not_found') {
        return {
          ok: false,
          code: 'session_not_found',
          message: resolved.message,
        };
      }
      if (resolved.error === 'session_archived') {
        return {
          ok: false,
          code: 'permission_denied',
          message: resolved.message,
        };
      }
      return {
        ok: false,
        code: 'workspace_root_unavailable',
        message: resolved.message,
      };
    } catch (error) {
      return {
        ok: false,
        code: 'transient_io',
        message: formatErrorMessage(error),
      };
    }
  };

  private readonly resolveCodeCollabV2OwnerSessionId = async (
    sessionId: SessionId
  ): Promise<SessionId> => {
    const resolved = await this.resolveCodeCollabV2Workspace(sessionId);
    if (resolved.ok) {
      return resolved.ownerSessionId;
    }
    throw new CodeCollabV2ServiceError(resolved.code, resolved.message, {
      retryable: resolved.code === 'transient_io' || resolved.code === 'machine_offline',
    });
  };

  private async resolveCodeCollabOwnerSessionMeta(
    ownerSessionId: SessionId
  ): Promise<SessionMeta | undefined> {
    const metaRecord = await this.workspaceDocument.repo.getDocMeta(
      getSessionRoomId(ownerSessionId)
    );
    if (!metaRecord?.meta || isLoroRepoDocDeleted(metaRecord)) {
      return undefined;
    }
    return metaRecord.meta as SessionMeta;
  }

  private async persistCodeCollabAllChangesDiffStats(
    ownerSessionId: SessionId,
    diffStats: NonNullable<SessionMeta['diffStats']>
  ): Promise<void> {
    const ownerRoomId = getSessionRoomId(ownerSessionId);
    const metaRecord = await this.workspaceDocument.repo.getDocMeta(ownerRoomId);
    if (!metaRecord?.meta || isLoroRepoDocDeleted(metaRecord)) {
      return;
    }
    const ownerMeta = readDiffStatsMetadata(metaRecord.meta);
    const target = resolveDiffStatsTarget({ ownerRoomId, ownerMeta });
    const patch = resolveCodeCollabAllChangesDiffStatsPatch({ target, ownerMeta, diffStats });
    if (!patch) {
      return;
    }
    await this.workspaceDocument.repo.upsertDocMeta(ownerRoomId, patch);
  }

  private canWriteCodeCollabOwnerSession(args: {
    readonly requestedByUserId?: string;
    readonly ownerMeta?: SessionMeta;
  }): boolean {
    const requester = args.requestedByUserId?.trim();
    if (!requester) {
      return false;
    }
    const ownerUserId = args.ownerMeta?.userId?.trim();
    return requester === ownerUserId || requester === this.userId;
  }

  async handleLocalMachineRpc(
    request: LocalMachineRpcRequestValidated
  ): Promise<LocalMachineRpcResponse> {
    try {
      const result = await this.dispatchLocalMachineRpc(request);
      return { ok: true, result };
    } catch (error) {
      if (isCodeCollabV2ServiceErrorForLocalRpc(error)) {
        return { ok: true, result: error.toRpcError() };
      }
      return { ok: false, error: formatErrorMessage(error) };
    }
  }

  private async dispatchLocalMachineRpc(
    request: LocalMachineRpcRequestValidated
  ): Promise<LocalMachineRpcResult> {
    const assertOwner = async (sessionId: SessionId): Promise<void> => {
      if (!request.ownerSessionId) {
        return;
      }
      const ownerSessionId = await this.resolveCodeCollabV2OwnerSessionId(sessionId);
      if (ownerSessionId !== request.ownerSessionId) {
        throw new CodeCollabV2ServiceError(
          'permission_denied',
          'Code Collab RPC owner session mismatch.',
          { retryable: false }
        );
      }
    };

    switch (request.method) {
      case 'code-collab/get-file-index':
        await assertOwner(request.params.sessionId as SessionId);
        return await this.codeCollabV2Service.getFileIndex(request.params);
      case 'code-collab/open-text':
        await assertOwner(request.params.sessionId as SessionId);
        return await this.codeCollabV2Service.openText(request.params);
      case 'code-collab/refresh-text':
        await assertOwner(request.params.sessionId as SessionId);
        return await this.codeCollabV2Service.refreshText(request.params);
      case 'code-collab/save-text':
        await assertOwner(request.params.sessionId as SessionId);
        return await this.codeCollabV2Service.saveText(request.params);
      case 'code-collab/open-current-diff':
        await assertOwner(request.params.sessionId as SessionId);
        return await this.codeCollabV2Service.openCurrentDiff(request.params);
      case 'code-collab/open-all-changes-diff':
        await assertOwner(request.params.sessionId as SessionId);
        return await this.codeCollabV2Service.openAllChangesDiff(request.params);
      case 'code-collab/open-turn-diff':
        await assertOwner(request.params.sessionId as SessionId);
        return await this.codeCollabV2Service.openTurnDiff(request.params);
      case 'code-collab/init-directory':
        await assertOwner(request.params.sessionId as SessionId);
        return await this.codeCollabV2Service.initDirectory(request.params);
      case 'code-collab/lsp-definition':
        await assertOwner(request.params.sessionId as SessionId);
        return await this.codeCollabV2Service.lspDefinition();
      case 'code-collab/lsp-references':
        await assertOwner(request.params.sessionId as SessionId);
        return await this.codeCollabV2Service.lspReferences();
      case 'file/preview':
        await assertOwner(request.params.sessionId as SessionId);
        return await this.filePreviewService.previewFile(request.params);
      case 'file/preview-local':
        await assertOwner(request.params.sessionId as SessionId);
        // Same machine: no wire to protect, so the read is not held to the
        // remote transport's size budget.
        return await this.filePreviewService.previewFile(request.params, {
          allowArbitraryPaths: true,
          sameMachine: true,
        });
      case 'session/get-active-invocation-context': {
        const sessionId = request.params.sessionId as SessionId;
        const invocation = this.executionService.getActiveInvocationContext(sessionId);
        return invocation
          ? {
              type: 'session/active-invocation-context' as const,
              sessionId,
              active: true as const,
              ...invocation,
            }
          : {
              type: 'session/active-invocation-context' as const,
              sessionId,
              active: false as const,
            };
      }
      case 'session/cancel': {
        const result = await this.executionService.cancelSession({
          type: 'session/cancel',
          machineId: request.machineId as MachineId,
          workspaceId: request.workspaceId as WorkspaceId,
          sessionId: request.params.sessionId,
          turnId: request.params.turnId,
        });
        return {
          type: 'session/cancel_response' as const,
          sessionId: request.params.sessionId,
          success: result.success,
          error: result.error,
        };
      }
      case 'session/dispatch-turn': {
        // Mirrors the Loro Streams Machine RPC path: normalize the opaque
        // transport-level input config, then offer the turn to the dispatch
        // watcher (ack-then-execute; idempotent by userTurnId).
        const inputConfig = normalizeSessionTurnInputConfig(request.params.inputConfig);
        if (!inputConfig) {
          return {
            type: 'session/dispatch-turn_response' as const,
            sessionId: request.params.sessionId,
            userTurnId: request.params.userTurnId,
            accepted: false,
            disposition: 'error' as const,
            error: 'Dispatch turn input config could not be parsed.',
          };
        }
        const disposition = await this.sessionDispatchWatcher.offerRpcTurn({
          sessionId: request.params.sessionId,
          userTurnId: request.params.userTurnId,
          userId: request.params.userId,
          timestamp: request.params.timestamp,
          inputConfig,
        });
        return {
          type: 'session/dispatch-turn_response' as const,
          sessionId: request.params.sessionId,
          userTurnId: request.params.userTurnId,
          accepted:
            disposition === 'accepted' ||
            disposition === 'duplicate' ||
            disposition === 'already-terminal',
          disposition,
        };
      }
      case 'session/prepare':
        return await this.prepareSessionWithAccessCheck(request.params);
      case 'session/prepare-cancel':
        return await this.cancelSessionPreparationWithAccessCheck(request.params);
      case 'session/preview-endpoint-acquire':
        return await this.previewService.acquireEndpoint({
          machineId: request.machineId as MachineId,
          workspaceId: request.workspaceId as WorkspaceId,
          sessionId: request.params.sessionId as SessionId,
          requestedByUserId: request.params.requestedByUserId,
          target: request.params.target,
        });
      case 'session/preview-endpoint-release':
        return await this.previewService.releaseEndpoint({
          machineId: request.machineId as MachineId,
          workspaceId: request.workspaceId as WorkspaceId,
          sessionId: request.params.sessionId as SessionId,
          endpointId: request.params.endpointId,
        });
      case 'session/steer': {
        return await this.steerSessionWithAccessCheck({
          ...request.params,
          sessionId: request.params.sessionId as SessionId,
        });
      }
      case 'session/terminate':
        return await this.terminateAcpSession(request.params.sessionId as SessionId);
      case 'session/fork':
        return await this.forkSessionWithAccessCheck(request.params);
      case 'session/edit-and-resend': {
        const inputConfig = normalizeSessionTurnInputConfig(request.params.inputConfig);
        if (!inputConfig) {
          return sessionEditAndResendFailure(
            request.params,
            'USER_TURN_NOT_EDITABLE',
            'Edit and resend input config could not be parsed.'
          );
        }
        return await this.editAndResendSessionWithAccessCheck({
          ...request.params,
          inputConfig,
        });
      }
      default: {
        const exhaustive: never = request;
        throw new Error(`Unsupported local Machine RPC method: ${String(exhaustive)}`);
      }
    }
  }

  private async terminateAcpSession(sessionId: SessionId): Promise<SessionTerminateResponse> {
    try {
      // Handles both resident and still-starting sessions: a session shown as
      // `initializing` lives in pendingSessionCreates (not `sessions`), so a plain
      // hasSession check would report success while the ACP process keeps running.
      await this.sessionManager.requestSessionTerminate(sessionId, true);
      return { type: 'session/terminate_response', sessionId, success: true };
    } catch (error) {
      return {
        type: 'session/terminate_response',
        sessionId,
        success: false,
        error: formatErrorMessage(error),
      };
    }
  }

  private async respondToLegacyCodeCollabHostStart(
    message: SessionCodeCollabHostStartRequestValidated
  ): Promise<SessionCodeCollabHostStartResponse> {
    const sessionId = message.sessionId;
    this.touchSession(sessionId);
    this.logger.debug(
      `[${sessionId}] Ignoring legacy Code Collab host-start request; v1 session-specific host has been removed.`
    );
    return {
      type: 'session/code-collab-host-start_response',
      sessionId,
      success: false,
      status: 'disabled',
      error: 'unsupported',
      message: 'Code Collab v1 session-specific host is no longer supported.',
    };
  }

  /**
   * Handles a validated local control message.
   */
  async handleMessage(
    message: ControlMessage,
    dispatchContext?: MessageDispatchContext
  ): Promise<void> {
    this.logger.debug(`Received message: ${message.type}`);
    const context = this.resolveDispatchContext(dispatchContext);

    switch (message.type) {
      case 'session/create':
        await this.handleSessionCreate(message, context);
        break;
      // case 'session/archive':
      //   await this.handleSessionTerminate(message);
      //   break;
      case 'session/cancel':
        await this.handleSessionCancel(message, context);
        break;
      case 'session/chat':
        await this.handleSessionChat(message, context);
        break;
      case 'machine/status':
        await this.handleMachineStatus(message, context);
        break;
      case 'machine/ping':
        await this.handleMachinePing(message, context);
        break;
      case 'machine/restart':
        await this.handleMachineRestart(message, context);
        break;
      case 'machine/upgrade':
        await this.handleMachineUpgrade(message, context);
        break;
      case 'machine/acp-capabilities-refresh':
        await this.handleMachineAcpCapabilitiesRefresh(message, context);
        break;
      case 'machine/acp-authenticate':
        await this.handleMachineAcpAuthenticate(message, context);
        break;
      case 'machine/acp-binary-status':
        await this.handleMachineAcpBinaryStatus(message, context);
        break;
      case 'machine/acp-binary-install':
        await this.handleMachineAcpBinaryInstall(message, context);
        break;
      case 'session/code-collab-host-start':
        await this.handleCodeCollabHostStart(message, context);
        break;
      case 'session/image-upload':
        await this.handleSessionImageUpload(message, context);
        break;
      case 'session/file-upload':
        await this.handleSessionFileUpload(message, context);
        break;
      case 'session/file-send-local':
        await this.handleSessionFileSendLocal(message, context);
        break;
      case 'session/preview-candidate-report':
        await this.handlePreviewCandidateReport(message, context);
        break;
      case 'session/preview-create':
        await this.handlePreviewCreate(message, context);
        break;
      case 'session/preview-revoke':
        await this.handlePreviewRevoke(message, context);
        break;
    }
  }

  private async handleCodeCollabHostStart(
    message: SessionCodeCollabHostStartRequestValidated,
    dispatchContext: MessageDispatchContext
  ): Promise<void> {
    const response = await this.respondToLegacyCodeCollabHostStart(message);
    dispatchContext.send(response);
  }

  private async handlePreviewCandidateReport(
    message: PreviewCandidateReportRequestValidated,
    dispatchContext: MessageDispatchContext
  ): Promise<void> {
    this.touchSession(message.sessionId);
    const response = await this.previewService.reportCandidate(message);
    dispatchContext.send(response);
  }

  private async handlePreviewCreate(
    message: SessionPreviewCreateRequestValidated,
    dispatchContext: MessageDispatchContext
  ): Promise<void> {
    this.touchSession(message.sessionId);
    const response = await this.previewService.createPreview(message);
    dispatchContext.send(response);
  }

  private async handlePreviewRevoke(
    message: SessionPreviewRevokeRequestValidated,
    dispatchContext: MessageDispatchContext
  ): Promise<void> {
    this.touchSession(message.sessionId);
    const response = await this.previewService.revokePreview(message);
    dispatchContext.send(response);
  }

  private async handleSessionImageUpload(
    message: SessionImageUploadRequestValidated,
    dispatchContext: MessageDispatchContext = this.createRuntimeDispatchContext(),
    options: SessionImageUploadOptions = {}
  ): Promise<void> {
    const { sessionId } = message;
    this.touchSession(sessionId);
    this.logger.info(`Image upload received for session ${sessionId} (${message.paths.length})`);
    this.logger.debug(
      `[${sessionId}] Received image upload request (count=${message.paths.length} source=${dispatchContext.source})`
    );

    const respond = (response: Omit<SessionImageUploadResponse, 'type' | 'sessionId'>) => {
      dispatchContext.send({
        type: 'session/image-upload_response',
        sessionId,
        ...response,
      } as SessionImageUploadResponse);
    };

    const sessionMetaRecord = await this.workspaceDocument.repo.getDocMeta(
      getSessionRoomId(sessionId)
    );
    if (!sessionMetaRecord?.meta || isLoroRepoDocDeleted(sessionMetaRecord)) {
      respond({
        success: false,
        error: 'session_not_found',
        message: `Session not found: ${sessionId}`,
      });
      return;
    }

    const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
    const meta = await sessionDoc.getMetaState();
    if (meta?.isArchived) {
      respond({
        success: false,
        workspaceId: this.workspaceId,
        error: 'session_archived',
        message: 'Session is archived',
      });
      return;
    }

    if (message.paths.length > SESSION_IMAGE_MAX_COUNT) {
      respond({
        success: false,
        workspaceId: this.workspaceId,
        error: 'too_many_images',
        message: `At most ${SESSION_IMAGE_MAX_COUNT} images are allowed per upload`,
      });
      return;
    }

    const initialAttachTarget =
      options.attachTarget ??
      (await this.resolveSessionImageUploadAttachTarget(sessionId, sessionDoc));
    if (initialAttachTarget.kind === 'unavailable') {
      respond({
        success: false,
        workspaceId: this.workspaceId,
        error: 'active_turn_unavailable',
        message: `Session is ${initialAttachTarget.statusType} but no active assistant turn was found`,
      });
      return;
    }

    let reservedEntryId: string | undefined;
    if (initialAttachTarget.kind === 'new_entry') {
      reservedEntryId = await this.createAssistantImageGroupEntry({
        sessionId,
        sessionDoc,
      });
    }

    let files: UploadableImageFile[];
    try {
      files = await Promise.all(
        message.paths.map(async (filePath) => await this.validateSessionImageUploadPath(filePath))
      );
    } catch (error) {
      if (reservedEntryId) {
        await this.removeHistoryEntryById({
          sessionDoc,
          entryId: reservedEntryId,
        });
      }
      respond({
        success: false,
        workspaceId: this.workspaceId,
        error: 'invalid_file',
        message: formatErrorMessage(error),
      });
      return;
    }

    const uploadedImages: UploadedSessionImage[] = [];
    let uploadError: unknown = null;
    for (const file of files) {
      try {
        uploadedImages.push(
          await this.uploadSessionImageFile({
            workspaceId: this.workspaceId,
            sessionId,
            file,
          })
        );
      } catch (error) {
        uploadError = error;
        break;
      }
    }

    if (uploadedImages.length === 0) {
      if (reservedEntryId) {
        await this.removeHistoryEntryById({
          sessionDoc,
          entryId: reservedEntryId,
        });
      }
      respond({
        success: false,
        workspaceId: this.workspaceId,
        error: 'upload_failed',
        message: formatErrorMessage(uploadError),
      });
      return;
    }

    const content: SessionImageGroupContent = {
      type: 'image_group',
      images: uploadedImages.map(({ downloadUrl: _downloadUrl, ...image }) => image),
    };

    let historyEntryId: string;
    let attachedTo: SessionImageUploadResponse['attachedTo'];

    if (initialAttachTarget.kind === 'active_turn') {
      const appended = await this.appendAssistantImageGroupToActiveTurn({
        sessionDoc,
        turnId: initialAttachTarget.turnId,
        content,
      });

      if (appended) {
        historyEntryId = initialAttachTarget.turnId;
        attachedTo = 'active_turn';
      } else {
        const latestAttachTarget = await this.resolveSessionImageUploadAttachTarget(
          sessionId,
          sessionDoc
        );
        if (latestAttachTarget.kind === 'new_entry') {
          historyEntryId = await this.createAssistantImageGroupEntry({
            sessionId,
            sessionDoc,
            content,
          });
          attachedTo = 'new_entry';
        } else {
          const failureMessage =
            latestAttachTarget.kind === 'unavailable'
              ? `Session is ${latestAttachTarget.statusType} and the original assistant turn is no longer available for image upload`
              : 'The original assistant turn is no longer available for image upload';
          respond({
            success: false,
            workspaceId: this.workspaceId,
            error: 'active_turn_unavailable',
            message: failureMessage,
          });
          return;
        }
      }
    } else {
      const targetEntryId =
        reservedEntryId ??
        (await this.createAssistantImageGroupEntry({
          sessionId,
          sessionDoc,
        }));

      const replaced = await this.replaceAssistantEntryItems({
        sessionDoc,
        entryId: targetEntryId,
        content,
      });

      if (!replaced) {
        const latestAttachTarget = await this.resolveSessionImageUploadAttachTarget(
          sessionId,
          sessionDoc
        );
        const failureMessage =
          latestAttachTarget.kind === 'active_turn'
            ? 'Session started a new assistant turn during image upload; retry after the turn completes'
            : latestAttachTarget.kind === 'unavailable'
              ? `Session is ${latestAttachTarget.statusType} and no idle assistant entry can be created`
              : 'Reserved assistant image entry is no longer available';
        respond({
          success: false,
          workspaceId: this.workspaceId,
          error: 'active_turn_unavailable',
          message: failureMessage,
        });
        return;
      }

      historyEntryId = targetEntryId;
      attachedTo = 'new_entry';
    }

    await sessionDoc.setLastMessageAt();

    const remainingUploads = files.length - uploadedImages.length;
    const partialUploadMessage =
      uploadError && remainingUploads > 0
        ? `Uploaded ${uploadedImages.length} of ${files.length} images; failed to upload the remaining ${remainingUploads}: ${formatErrorMessage(
            uploadError
          )}`
        : undefined;

    respond({
      success: true,
      workspaceId: this.workspaceId,
      ...(partialUploadMessage ? { message: partialUploadMessage } : {}),
      historyEntryId,
      attachedTo,
      content,
      images: uploadedImages,
    });
  }

  /**
   * Validate a file path for the agent-send upload: open with O_NOFOLLOW (no
   * symlink final component), reject non-files/empty/oversize, compute sha256
   * and text-previewability by streaming (bounded memory).
   */
  private async validateSessionFileUploadPath(
    filePath: string,
    options?: {
      /**
       * Reject paths outside this root (realpath-canonicalized, parent-symlink
       * safe). REQUIRED for the agent-facing MCP channel so the upload tool
       * cannot bypass the agent's own out-of-workspace read approval gate.
       * Omitted for the desktop local handoff, whose user-picked files are
       * staged in tmpdir by the user's own Electron process.
       */
      containWithin?: string;
    }
  ): Promise<ValidatedUploadFile> {
    const trimmed = filePath.trim();
    if (!trimmed) {
      throw new Error('File path is empty');
    }
    const absolutePath = options?.containWithin
      ? await resolveContainedUploadPath(trimmed, options.containWithin)
      : path.resolve(trimmed);

    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(
        absolutePath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ELOOP') {
        throw new Error(`File path must not be a symlink: ${filePath}`, { cause: error });
      }
      throw new Error(`File not found: ${filePath}`, { cause: error });
    }

    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error(`Path is not a file: ${filePath}`);
      }
      if (stat.size <= 0) {
        throw new Error(`File is empty: ${filePath}`);
      }
      if (stat.size > SESSION_FILE_MAX_SIZE_BYTES) {
        throw new Error(
          `File must be <= ${Math.floor(SESSION_FILE_MAX_SIZE_BYTES / (1024 * 1024))}MB: ${filePath}`
        );
      }

      const fileName = path.basename(absolutePath);
      const extension = path.extname(fileName).slice(1).trim().toLowerCase();
      const mimeType =
        SESSION_FILE_MIME_TYPE_BY_EXTENSION[extension] ?? DEFAULT_SESSION_FILE_MIME_TYPE;

      // Stream the file once: hash incrementally, capture the first 8 KB for the
      // text-preview sniff. Avoids reading the whole (up to 100 MB) file into RAM.
      const hash = crypto.createHash('sha256');
      const sniffPrefix = Buffer.alloc(SESSION_FILE_PREVIEW_SNIFF_BYTES);
      let sniffLength = 0;
      const stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) {
        const buf = chunk as Buffer;
        hash.update(buf);
        if (sniffLength < SESSION_FILE_PREVIEW_SNIFF_BYTES) {
          const take = Math.min(SESSION_FILE_PREVIEW_SNIFF_BYTES - sniffLength, buf.length);
          buf.copy(sniffPrefix, sniffLength, 0, take);
          sniffLength += take;
        }
      }

      const sha256 = hash.digest('hex');
      const textPreview = isTextPreviewable(
        fileName,
        mimeType,
        sniffPrefix.subarray(0, sniffLength)
      );

      return {
        absolutePath,
        fileName,
        mimeType,
        sizeBytes: stat.size,
        sha256,
        textPreview,
      };
    } finally {
      await handle.close();
    }
  }

  private buildSessionFileUploadHeaders(file: ValidatedUploadFile, sessionId: SessionId): Headers {
    const headers = new Headers(
      buildSessionFileUploadMetadataHeaders({
        sessionId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        textPreview: file.textPreview,
      })
    );
    headers.set('Authorization', `Bearer ${this.token}`);
    return headers;
  }

  /** Parse the server's `{ success, file: SessionFilePayload }` upload response. */
  private parseUploadedFileResponse(
    body: unknown,
    serverBaseUrl: string,
    sessionId: SessionId,
    workspaceId: WorkspaceId
  ): UploadedSessionFile {
    const parsed = SessionInputBlockSchema.safeParse(
      body && typeof body === 'object' && 'file' in body
        ? (body as Record<string, unknown>).file
        : undefined
    );
    if (!parsed.success || parsed.data.type !== 'file') {
      throw new Error('Invalid file upload payload');
    }
    const downloadUrl = buildSessionFileApiUrl(
      serverBaseUrl,
      getSessionFileDownloadApiPath(workspaceId, sessionId, parsed.data.fileId)
    );
    return { ...parsed.data, downloadUrl };
  }

  private async uploadSessionFileSingleShot(args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    file: ValidatedUploadFile;
    signal?: AbortSignal;
  }): Promise<UploadedSessionFile> {
    const serverBaseUrl = this.resolveServerBaseUrl();
    const uploadUrl = buildSessionFileApiUrl(
      serverBaseUrl,
      getSessionFileUploadApiPath(args.workspaceId)
    );

    const bytes = await fs.promises.readFile(args.file.absolutePath);
    const headers = this.buildSessionFileUploadHeaders(args.file, args.sessionId);
    headers.set('Content-Type', 'application/octet-stream');

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers,
      body: bytes,
      signal: args.signal,
    });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      const detail = errorBody ? `: ${errorBody.slice(0, 200)}` : '';
      throw new Error(`Failed to upload file (${response.status})${detail}`);
    }
    const body = await response.json().catch(() => null);
    return this.parseUploadedFileResponse(body, serverBaseUrl, args.sessionId, args.workspaceId);
  }

  private async uploadSessionFileMultipart(args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    file: ValidatedUploadFile;
    signal?: AbortSignal;
  }): Promise<UploadedSessionFile> {
    const serverBaseUrl = this.resolveServerBaseUrl();

    // 1. create
    const createUrl = buildSessionFileApiUrl(
      serverBaseUrl,
      getSessionFileMultipartCreateApiPath(args.workspaceId)
    );
    const createResponse = await fetch(createUrl, {
      method: 'POST',
      headers: this.buildSessionFileUploadHeaders(args.file, args.sessionId),
      signal: args.signal,
    });
    if (!createResponse.ok) {
      const errorBody = await createResponse.text().catch(() => '');
      const detail = errorBody ? `: ${errorBody.slice(0, 200)}` : '';
      throw new Error(`Failed to create multipart upload (${createResponse.status})${detail}`);
    }
    const createBody = MultipartCreateResponseSchema.safeParse(
      await createResponse.json().catch(() => null)
    );
    if (!createBody.success) {
      throw new Error('Invalid multipart create response');
    }
    const { uploadId, fileId } = createBody.data;

    // 2. upload parts (1-based), retrying each part up to N times.
    const partCount = getSessionFilePartCount(args.file.sizeBytes);
    const completedParts: Array<{ partNumber: number; etag: string }> = [];
    const handle = await fs.promises.open(args.file.absolutePath, 'r');
    try {
      for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
        const offset = (partNumber - 1) * SESSION_FILE_PART_SIZE_BYTES;
        const length = Math.min(SESSION_FILE_PART_SIZE_BYTES, args.file.sizeBytes - offset);
        const partBuffer = Buffer.alloc(length);
        // POSIX read may return fewer bytes than requested; loop until the
        // part buffer is full (a zero-filled tail would only fail later at the
        // server's sha256 verification, with a far less actionable error).
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(
            partBuffer,
            filled,
            length - filled,
            offset + filled
          );
          if (bytesRead <= 0) {
            throw new Error(
              `Short read for part ${partNumber}: got ${filled} of ${length} bytes (file changed during upload?)`
            );
          }
          filled += bytesRead;
        }

        const partUrl = buildSessionFileApiUrl(
          serverBaseUrl,
          getSessionFileMultipartPartApiPath(args.workspaceId, uploadId, partNumber)
        );
        const partHeaders = new Headers();
        partHeaders.set('Authorization', `Bearer ${this.token}`);
        partHeaders.set('x-session-id', args.sessionId);
        partHeaders.set('x-file-id', fileId);
        partHeaders.set('x-file-part-size-bytes', String(length));
        partHeaders.set('Content-Type', 'application/octet-stream');

        let lastError: unknown = null;
        let uploaded = false;
        for (let attempt = 1; attempt <= SESSION_FILE_MAX_PART_RETRIES; attempt += 1) {
          try {
            const partResponse = await fetch(partUrl, {
              method: 'PUT',
              headers: partHeaders,
              body: partBuffer,
              signal: args.signal,
            });
            if (!partResponse.ok) {
              const errorBody = await partResponse.text().catch(() => '');
              throw new Error(
                `part ${partNumber} failed (${partResponse.status})${errorBody ? `: ${errorBody.slice(0, 120)}` : ''}`
              );
            }
            const partBody = MultipartPartResponseSchema.safeParse(
              await partResponse.json().catch(() => null)
            );
            if (!partBody.success) {
              throw new Error(`part ${partNumber} returned an invalid response`);
            }
            completedParts.push({ partNumber, etag: partBody.data.etag });
            uploaded = true;
            break;
          } catch (error) {
            lastError = error;
            // An aborted upload (backfill revoke) can never succeed on retry.
            if (args.signal?.aborted) {
              break;
            }
          }
        }
        if (!uploaded) {
          throw new Error(
            `Failed to upload part ${partNumber} after ${SESSION_FILE_MAX_PART_RETRIES} attempts: ${formatErrorMessage(lastError)}`
          );
        }
      }
    } finally {
      await handle.close();
    }

    // 3. complete
    const completeUrl = buildSessionFileApiUrl(
      serverBaseUrl,
      getSessionFileMultipartCompleteApiPath(args.workspaceId, uploadId)
    );
    const completeHeaders = new Headers();
    completeHeaders.set('Authorization', `Bearer ${this.token}`);
    completeHeaders.set('x-session-id', args.sessionId);
    completeHeaders.set('x-file-id', fileId);
    completeHeaders.set('Content-Type', 'application/json');
    const completeResponse = await fetch(completeUrl, {
      method: 'POST',
      headers: completeHeaders,
      body: JSON.stringify({ parts: completedParts }),
      signal: args.signal,
    });
    if (!completeResponse.ok) {
      const errorBody = await completeResponse.text().catch(() => '');
      const detail = errorBody ? `: ${errorBody.slice(0, 200)}` : '';
      throw new Error(`Failed to complete multipart upload (${completeResponse.status})${detail}`);
    }
    const completeBody = await completeResponse.json().catch(() => null);
    return this.parseUploadedFileResponse(
      completeBody,
      serverBaseUrl,
      args.sessionId,
      args.workspaceId
    );
  }

  private async uploadValidatedSessionFile(args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    file: ValidatedUploadFile;
    /** Cancels the relay upload mid-flight (backfill revoke, S5/D10). */
    signal?: AbortSignal;
  }): Promise<UploadedSessionFile> {
    if (shouldUseSingleShotUpload(args.file.sizeBytes)) {
      return await this.uploadSessionFileSingleShot(args);
    }
    return await this.uploadSessionFileMultipart(args);
  }

  /** Append uploaded file blocks to an assistant turn's items (active turn). */
  private async appendAssistantFileBlocksToActiveTurn(args: {
    sessionDoc: SessionDocument;
    turnId: string;
    files: UploadedSessionFile[];
  }): Promise<boolean> {
    const items = inputBlocksToHistoryItems(
      args.files.map(({ downloadUrl: _downloadUrl, ...file }) => file)
    );
    let appended = false;
    await args.sessionDoc.updateHistory((history) => {
      for (const entry of history) {
        if (!entry || entry.id !== args.turnId || entry.role !== 'assistant') {
          continue;
        }
        const existing = Array.isArray(entry.items) ? [...entry.items] : [];
        entry.items = [...existing, ...items] as SessionHistoryInput['items'];
        appended = true;
        break;
      }
      return history;
    });
    return appended;
  }

  /** Create a new assistant history entry carrying the uploaded file blocks. */
  private async createAssistantFileEntry(args: {
    sessionId: SessionId;
    sessionDoc: SessionDocument;
    files?: UploadedSessionFile[];
  }): Promise<string> {
    const entryId = `assistant-file-${uuidV4()}`;
    const modelInfo = this.sessionManager.getSession(args.sessionId)?.agentClient?.currentModel;
    const items = args.files
      ? inputBlocksToHistoryItems(args.files.map(({ downloadUrl: _downloadUrl, ...file }) => file))
      : ([] as NonNullable<SessionHistoryInput['items']>);
    await args.sessionDoc.updateHistory((history) => {
      history.push({
        id: entryId,
        role: 'assistant',
        items: items as SessionHistoryInput['items'],
        timestamp: new Date().toISOString(),
        userId: undefined,
        read: undefined,
        modelInfo,
        fileDiff: [],
        finished: true,
      });
      return history;
    });
    return entryId;
  }

  private async handleSessionFileUpload(
    message: SessionFileUploadRequestValidated,
    dispatchContext: MessageDispatchContext = this.createRuntimeDispatchContext()
  ): Promise<void> {
    const { sessionId } = message;
    this.touchSession(sessionId);
    this.logger.info(`File upload received for session ${sessionId} (${message.paths.length})`);

    const respond = (response: Omit<SessionFileUploadResponse, 'type' | 'sessionId'>) => {
      dispatchContext.send({
        type: 'session/file-upload_response',
        sessionId,
        ...response,
      } as SessionFileUploadResponse);
    };

    const sessionMetaRecord = await this.workspaceDocument.repo.getDocMeta(
      getSessionRoomId(sessionId)
    );
    if (!sessionMetaRecord?.meta || isLoroRepoDocDeleted(sessionMetaRecord)) {
      respond({
        success: false,
        error: 'session_not_found',
        message: `Session not found: ${sessionId}`,
      });
      return;
    }

    const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
    const meta = await sessionDoc.getMetaState();
    if (meta?.isArchived) {
      respond({
        success: false,
        workspaceId: this.workspaceId,
        error: 'session_archived',
        message: 'Session is archived',
      });
      return;
    }

    if (message.paths.length > SESSION_FILE_MAX_COUNT) {
      respond({
        success: false,
        workspaceId: this.workspaceId,
        error: 'too_many_files',
        message: `At most ${SESSION_FILE_MAX_COUNT} files are allowed per upload`,
      });
      return;
    }

    const attachTarget = await this.resolveSessionImageUploadAttachTarget(sessionId, sessionDoc);
    if (attachTarget.kind === 'unavailable') {
      respond({
        success: false,
        workspaceId: this.workspaceId,
        error: 'active_turn_unavailable',
        message: `Session is ${attachTarget.statusType} but no active assistant turn was found`,
      });
      return;
    }

    // This channel is agent-facing (MCP lody_upload_files): paths MUST stay
    // inside the session workspace, or the tool would let a prompt-injected
    // agent exfiltrate arbitrary host files past its own read-approval gate.
    const workspaceRoot = this.resolveSessionWorkspaceRoot(sessionId);
    if (!workspaceRoot) {
      respond({
        success: false,
        workspaceId: this.workspaceId,
        error: 'workspace_unavailable',
        message: 'Session workspace is not available on this machine',
      });
      return;
    }

    // Validate every path up front (existence/readable/size + sha256/textPreview).
    let validatedFiles: ValidatedUploadFile[];
    try {
      validatedFiles = await Promise.all(
        message.paths.map((filePath) =>
          this.validateSessionFileUploadPath(filePath, { containWithin: workspaceRoot })
        )
      );
    } catch (error) {
      respond({
        success: false,
        workspaceId: this.workspaceId,
        error: 'invalid_file',
        message: formatErrorMessage(error),
      });
      return;
    }

    const uploadedFiles: UploadedSessionFile[] = [];
    const failures: string[] = [];
    const canonicalWorkspaceRoot = await fs.promises.realpath(workspaceRoot);
    for (const file of validatedFiles) {
      try {
        const uploaded = await this.uploadValidatedSessionFile({
          workspaceId: this.workspaceId,
          sessionId,
          file,
        });
        // Validation above canonicalized the path and proved containment. Keep
        // only the workspace-relative provenance in history so a local Lody
        // client can reopen the live artifact without publishing a host path.
        const sourcePath = normalizeSessionFileSourcePath(
          path.relative(canonicalWorkspaceRoot, file.absolutePath)
        );
        uploadedFiles.push({ ...uploaded, sourcePath });
      } catch (error) {
        failures.push(`${file.fileName}: ${formatErrorMessage(error)}`);
      }
    }

    if (uploadedFiles.length === 0) {
      respond({
        success: false,
        workspaceId: this.workspaceId,
        error: 'upload_failed',
        message: failures.length > 0 ? failures.join('; ') : 'No files were uploaded',
      });
      return;
    }

    let historyEntryId: string;
    let attachedTo: SessionFileUploadResponse['attachedTo'];
    if (attachTarget.kind === 'active_turn') {
      const appended = await this.appendAssistantFileBlocksToActiveTurn({
        sessionDoc,
        turnId: attachTarget.turnId,
        files: uploadedFiles,
      });
      if (appended) {
        historyEntryId = attachTarget.turnId;
        attachedTo = 'active_turn';
      } else {
        historyEntryId = await this.createAssistantFileEntry({
          sessionId,
          sessionDoc,
          files: uploadedFiles,
        });
        attachedTo = 'new_entry';
      }
    } else {
      historyEntryId = await this.createAssistantFileEntry({
        sessionId,
        sessionDoc,
        files: uploadedFiles,
      });
      attachedTo = 'new_entry';
    }

    await sessionDoc.setLastMessageAt();

    const partialMessage =
      failures.length > 0
        ? `Uploaded ${uploadedFiles.length} of ${validatedFiles.length} files; failed: ${failures.join('; ')}`
        : undefined;

    respond({
      success: true,
      workspaceId: this.workspaceId,
      ...(partialMessage ? { message: partialMessage } : {}),
      historyEntryId,
      attachedTo,
      files: uploadedFiles,
    });
  }

  /**
   * Desktop local-transport file handoff. Unlike `handleSessionFileUpload`, this
   * does NOT upload to the relay store or append history; it copies each file
   * into the local blob store and returns `transport: 'local'` blocks. The
   * composer attaches those blocks to the outgoing message (keeping them tied to
   * the user's text), then the runtime backfills the bytes to R2 in the
   * background and flips the persisted block to `transport: 'r2'`.
   */
  private async handleSessionFileSendLocal(
    message: SessionFileSendLocalRequestValidated,
    dispatchContext: MessageDispatchContext = this.createRuntimeDispatchContext()
  ): Promise<void> {
    const { sessionId } = message;
    this.touchSession(sessionId);
    this.logger.info(
      `Local file handoff received for session ${sessionId} (${message.paths.length})`
    );

    const respond = (response: Omit<SessionFileSendLocalResponse, 'type' | 'sessionId'>) => {
      dispatchContext.send({
        type: 'session/file-send-local_response',
        sessionId,
        ...response,
      } as SessionFileSendLocalResponse);
    };

    const sessionMetaRecord = await this.workspaceDocument.repo.getDocMeta(
      getSessionRoomId(sessionId)
    );
    if (!sessionMetaRecord?.meta || isLoroRepoDocDeleted(sessionMetaRecord)) {
      respond({
        success: false,
        error: 'session_not_found',
        message: `Session not found: ${sessionId}`,
      });
      return;
    }

    if (message.paths.length > SESSION_FILE_MAX_COUNT) {
      respond({
        success: false,
        workspaceId: this.workspaceId,
        error: 'too_many_files',
        message: `At most ${SESSION_FILE_MAX_COUNT} files are allowed per upload`,
      });
      return;
    }

    // Reuse the upload-path validation (existence/size/sha256/textPreview).
    // Deliberately NO workspace containment here: this channel's caller is the
    // user's own desktop app staging user-picked files via tmpdir (same
    // privileges as the user). The agent-facing MCP channel above is the one
    // that must be contained.
    let validatedFiles: ValidatedUploadFile[];
    try {
      validatedFiles = await Promise.all(
        message.paths.map((filePath) => this.validateSessionFileUploadPath(filePath))
      );
    } catch (error) {
      respond({
        success: false,
        workspaceId: this.workspaceId,
        error: 'invalid_file',
        message: formatErrorMessage(error),
      });
      return;
    }

    const uploadedAt = getServerNow();
    const localBlocks: SessionFilePayload[] = [];
    const failures: string[] = [];
    for (const file of validatedFiles) {
      const fileId = `file-${uuidV4()}`;
      try {
        const copied = await copyIntoSessionFileBlobStore({
          workspaceId: this.workspaceId,
          sessionId,
          fileId,
          sourcePath: file.absolutePath,
        });
        if (copied.warn) {
          this.logger.warn(
            `Local session file blob store is ${Math.round(
              (copied.usedBytes / copied.quotaBytes) * 100
            )}% full; pending offline attachments are never evicted`
          );
        }
      } catch (error) {
        failures.push(`${file.fileName}: ${formatErrorMessage(error)}`);
        continue;
      }
      localBlocks.push({
        type: 'file',
        fileId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        textPreview: file.textPreview,
        transport: 'local',
        machineId: this.machineId,
        uploadedAt,
      });
    }

    if (localBlocks.length === 0) {
      respond({
        success: false,
        workspaceId: this.workspaceId,
        error: 'local_handoff_failed',
        message: failures.length > 0 ? failures.join('; ') : 'No files were stored locally',
      });
      return;
    }

    // Opportunistic early backfill: the block only enters history when the user
    // sends the message, so the first attempts may retry on "not yet persisted"
    // and succeed once the send lands within the backoff window. The reliable
    // trigger is message dispatch (materializeSessionFileAttachments enqueues
    // when it serves the block), with the startup scan as the final net.
    // Re-enqueues are deduped by the in-flight key set.
    for (const block of localBlocks) {
      this.enqueueSessionFileBackfill(sessionId, block.fileId);
    }

    const partialMessage =
      failures.length > 0
        ? `Stored ${localBlocks.length} of ${validatedFiles.length} files; failed: ${failures.join('; ')}`
        : undefined;

    respond({
      success: true,
      workspaceId: this.workspaceId,
      ...(partialMessage ? { message: partialMessage } : {}),
      files: localBlocks,
    });
  }

  /**
   * Enqueue a background backfill task for a local-transport file. Idempotent:
   * a file already being backfilled is skipped. On success the persisted history
   * block is flipped `local -> r2` (single-field) and the local blob is removed.
   * Failures retry with exponential backoff up to a cap; past the cap the block
   * stays `local` (other devices keep showing pending) and the failure is logged.
   */
  private enqueueSessionFileBackfill(sessionId: SessionId, fileId: string): void {
    if (this.sessionFileBackfillStopped || !this.remoteBackfillEnabled) {
      return;
    }
    const key = `${sessionId}:${fileId}`;
    if (this.sessionFileBackfillInFlight.has(key)) {
      return;
    }
    this.sessionFileBackfillInFlight.add(key);
    void this.runSessionFileBackfill(sessionId, fileId).finally(() => {
      this.sessionFileBackfillInFlight.delete(key);
    });
  }

  private async runSessionFileBackfill(sessionId: SessionId, fileId: string): Promise<void> {
    const blobArgs = { workspaceId: this.workspaceId, sessionId, fileId };
    for (let attempt = 1; attempt <= SESSION_FILE_BACKFILL_MAX_ATTEMPTS; attempt += 1) {
      if (this.sessionFileBackfillStopped) {
        return;
      }
      if (!this.remoteBackfillEnabled) {
        return;
      }
      // The block may have already been flipped (e.g. another device's relay
      // upload won), or the blob removed; bail without churn.
      if (!(await sessionFileBlobExists(blobArgs))) {
        return;
      }
      try {
        await this.backfillSessionFileOnce(sessionId, fileId);
        return;
      } catch (error) {
        this.logger.warn(
          `[${sessionId}] Backfill attempt ${attempt}/${SESSION_FILE_BACKFILL_MAX_ATTEMPTS} for ${fileId} failed: ${formatErrorMessage(error)}`
        );
        if (attempt >= SESSION_FILE_BACKFILL_MAX_ATTEMPTS) {
          this.logger.error(
            `[${sessionId}] Backfill gave up for ${fileId}; block stays local (pending on other devices)`
          );
          return;
        }
        // Revocation/offline transitions deliberately abort the upload. Do not
        // pay a retry delay when this task is no longer authorized to retry.
        if (this.sessionFileBackfillStopped || !this.remoteBackfillEnabled) {
          return;
        }
        await delay(sessionFileBackfillDelayMs(attempt));
      }
    }
  }

  /** Upload one local blob to R2, flip its history block, and drop the blob. */
  private async backfillSessionFileOnce(sessionId: SessionId, fileId: string): Promise<void> {
    // Capture this task's authorization window. The signal cancels the upload
    // when a revoke lands mid-flight; the generation re-checks below cover the
    // race where the upload resolves anyway (abort raced completion).
    const generation = this.remoteBackfillGeneration;
    const abortSignal = this.remoteBackfillAbort?.signal;
    if (!abortSignal) {
      throw new Error('remote backfill is disabled');
    }
    const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
    const history = await sessionDoc.getHistory();

    // Find the persisted block so we upload with its real metadata.
    let target: Extract<SessionInputBlock, { type: 'file' }> | null = null;
    for (const entry of history) {
      const items = Array.isArray(entry.items) ? entry.items : [];
      for (const item of items) {
        if (
          item &&
          typeof item === 'object' &&
          (item as { type?: unknown }).type === 'file' &&
          (item as { fileId?: unknown }).fileId === fileId
        ) {
          const block = item as unknown as Extract<SessionInputBlock, { type: 'file' }>;
          if (block.transport === 'local') {
            target = block;
          }
        }
      }
    }
    const blobArgs = { workspaceId: this.workspaceId, sessionId, fileId };
    // A marker written before the flip lets us recover from a crash in the
    // flip→mark window (R5.3): the flip rewrites the fileId, so after it the
    // local block is gone and a naive re-run would throw "not yet persisted"
    // forever, stranding the blob and its quota.
    const markerRelayFileId = await readSessionFileBlobBackfillMarker(blobArgs);

    if (!target) {
      if (markerRelayFileId) {
        // Flip already committed (crash before mark) — just finalize.
        await markSessionFileBlobBackfilled(blobArgs);
        this.logger.info(`[${sessionId}] Finalized backfill of local file ${fileId} after restart`);
        return;
      }
      // No history block references this blob. Retryable while recent (the user
      // may still send the draft), but reclaim genuinely-abandoned drafts (R5.4)
      // so a staged-but-never-sent file cannot hold quota forever.
      const ageMs = await getSessionFileBlobAgeMs(blobArgs);
      if (ageMs !== null && ageMs > getDraftSessionFileBlobMaxAgeMs()) {
        await removeSessionFileBlob(blobArgs);
        this.logger.warn(
          `[${sessionId}] Reclaimed abandoned draft file blob ${fileId} (age ${Math.round(ageMs / 1000)}s)`
        );
        return;
      }
      throw new Error('file block not yet persisted in session history');
    }

    const blobPath = getSessionFileBlobPath(blobArgs);

    // Reuse a prior upload recorded by the marker (crash before flip) instead of
    // re-uploading; otherwise upload now and record the relay key before flipping.
    let relayFileId = markerRelayFileId;
    if (!relayFileId) {
      const uploaded = await this.uploadValidatedSessionFile({
        workspaceId: this.workspaceId,
        sessionId,
        file: {
          absolutePath: blobPath,
          fileName: target.fileName,
          mimeType: target.mimeType,
          sizeBytes: target.sizeBytes,
          sha256: target.sha256,
          textPreview: target.textPreview,
        },
        signal: abortSignal,
      });
      // A revoke may have landed while the upload was in flight: do NOT record
      // or adopt the uploaded bytes. No marker is written, so restart recovery
      // sees a plain pending blob — never the "flip committed" R5.3 window.
      this.throwIfBackfillSuperseded(generation);
      relayFileId = uploaded.fileId;
      await writeSessionFileBlobBackfillMarker({ ...blobArgs, relayFileId });
    }

    // Last gate before the point of no return. Past the flip we always
    // finalize: the bytes are already adopted by history, and aborting between
    // flip and mark would only recreate the R5.3 crash window on purpose.
    this.throwIfBackfillSuperseded(generation);
    // Flip transport local -> r2 and adopt the relay-store key (see
    // flipFileTransportToR2 for why fileId must change).
    await sessionDoc.updateHistory((current) => {
      const flipped = flipFileTransportToR2(current, fileId, relayFileId);
      return flipped ?? current;
    });
    await markSessionFileBlobBackfilled(blobArgs);
    this.logger.info(`[${sessionId}] Backfilled local file ${fileId} -> relay ${relayFileId}`);
  }

  /**
   * On workspace runtime startup, re-enqueue backfill for every blob still on
   * disk in this workspace's local file store. A blob is removed only after its
   * history block is flipped to `r2`, so an on-disk blob IS a durable pending
   * task — this recovers from CLI restarts that dropped in-memory backfill tasks
   * without depending on meta-room session enumeration. Best-effort, non-blocking.
   */
  async scanAndBackfillLocalSessionFiles(): Promise<void> {
    if (this.sessionFileBackfillStopped || !this.remoteBackfillEnabled) {
      return;
    }
    let pending: Awaited<ReturnType<typeof listPendingLocalSessionFiles>>;
    try {
      pending = await listPendingLocalSessionFiles({ workspaceId: this.workspaceId });
    } catch (error) {
      this.logger.debug(`Backfill startup scan failed: ${formatErrorMessage(error)}`);
      return;
    }
    if (pending.length > 0) {
      this.logger.info(`Re-enqueuing ${pending.length} pending local file backfill task(s)`);
    }
    for (const { sessionId, fileId } of pending) {
      this.enqueueSessionFileBackfill(sessionId as SessionId, fileId);
    }
  }

  async enableRemoteBackfillAndScan(): Promise<void> {
    // Open a fresh authorization generation. Any task from a prior generation
    // (including one whose upload is still in flight) can no longer commit.
    this.remoteBackfillGeneration += 1;
    this.remoteBackfillAbort?.abort();
    this.remoteBackfillAbort = new AbortController();
    await this.scanAndBackfillLocalSessionFiles();
  }

  disableRemoteBackfill(): void {
    // Close the window: abort in-flight uploads and supersede every started
    // task so a resumed backfill cannot commit post-revoke (S5/D10).
    this.remoteBackfillGeneration += 1;
    this.remoteBackfillAbort?.abort();
    this.remoteBackfillAbort = null;
  }

  /**
   * Guard between backfill commit steps: throws when a disable/revoke (or a
   * re-enable, which starts a new generation) landed after the task captured
   * `generation`. Uploaded-but-uncommitted relay bytes are intentionally
   * orphaned — there is no client-facing delete endpoint; the R2 lifecycle
   * (90 days) reaps them.
   */
  private throwIfBackfillSuperseded(generation: number): void {
    if (this.remoteBackfillAbort === null || generation !== this.remoteBackfillGeneration) {
      throw new Error('remote_backfill_superseded');
    }
  }

  recheckPendingSessionAccess(reason: string): void {
    this.sessionDispatchWatcher.recheckPendingAccess(reason);
  }

  async cancelActiveTurnsForRemoteRevocation(): Promise<void> {
    const activeTurns = this.executionService.getActiveTurnIds();
    for (const { sessionId, turnId } of activeTurns) {
      await this.executionService.cancelSession({
        type: 'session/cancel',
        machineId: this.machineId,
        workspaceId: this.workspaceId,
        sessionId,
        turnId,
      });
    }
  }

  private async handleSessionChat(
    message: SessionChatRequestValidated,
    dispatchContext: MessageDispatchContext = this.createRuntimeDispatchContext()
  ): Promise<void> {
    const { sessionId, userTurnId } = message;

    if (dispatchContext.source === 'local') {
      dispatchContext.send({
        type: 'session/chat_response',
        sessionId,
        userTurnId,
        success: true,
      } as SessionChatResponse);
    }

    await this.executionService.continueSession(message);
  }

  /**
   * Handle session create
   */
  private async handleSessionCreate(
    message: SessionCreateRequestValidated,
    dispatchContext: MessageDispatchContext = this.createRuntimeDispatchContext()
  ): Promise<void> {
    const { sessionId } = message;

    // IMPORTANT: respond immediately so the web client can treat the session as "accepted" only
    // after the machine has actually received the request. Subsequent execution success/failure
    // is tracked via session metadata/status updates.
    dispatchContext.send({
      type: 'session/create_response',
      sessionId,
      success: true,
    } as SessionCreateResponse);

    await this.executionService.startSession(message);
  }

  /**
   * Handle session stop (cancel prompt without ending session)
   *
   * The cancel flow:
   * 1. Send cancel signal to agent (this makes prompt() return)
   * 2. Flush any pending ACP notifications
   * 3. Set status to cancelled
   * 4. Wait a bit for CRDT sync
   * 5. Send ACK to frontend
   */
  private async handleSessionCancel(
    message: SessionCancelRequestValidated,
    dispatchContext: MessageDispatchContext = this.createRuntimeDispatchContext()
  ): Promise<void> {
    const { sessionId } = message;
    const result = await this.executionService.cancelSession(message);
    dispatchContext.send({
      type: 'session/cancel_response',
      sessionId,
      success: result.success,
      error: result.error,
    });
  }

  /**
   * Handle machine status request.
   * Collects system resource info and container statuses.
   */
  private async handleMachineStatus(
    message: MachineStatusRequestValidated,
    dispatchContext: MessageDispatchContext = this.createRuntimeDispatchContext()
  ): Promise<void> {
    const response = await this.executionService.getMachineStatus(message);
    dispatchContext.send(response);
  }

  private async handleMachinePing(
    message: MachinePingRequestValidated,
    dispatchContext: MessageDispatchContext = this.createRuntimeDispatchContext()
  ): Promise<void> {
    const response = await this.executionService.pingMachine(message);
    dispatchContext.send(response);
  }

  private machineRestartFailure(
    requestId: string,
    disposition: MachineRestartResponse['disposition'],
    error: string
  ): MachineRestartResponse {
    return {
      type: 'machine/restart_response',
      machineId: this.machineId,
      requestId,
      success: false,
      accepted: false,
      disposition,
      error,
    };
  }

  private machineUpgradeFailure(
    requestId: string,
    disposition: MachineUpgradeResponse['disposition'],
    error: string,
    targetVersion?: string
  ): MachineUpgradeResponse {
    return {
      type: 'machine/upgrade_response',
      machineId: this.machineId,
      requestId,
      success: false,
      accepted: false,
      disposition,
      ...(targetVersion === undefined ? {} : { targetVersion }),
      error,
    };
  }

  private lifecycleErrorDisposition(result: {
    ok: false;
    status?: number;
  }): MachineRestartResponse['disposition'] {
    return result.status === 401 || result.status === 403 ? 'unauthorized' : 'error';
  }

  private machineLifecycleUnsupportedMessage(action: 'restart' | 'upgrade'): string {
    const capability = this.machineLifecycleCapability;
    if (capability.reason === 'electron') {
      return `Machine ${action} is not available for the Electron-managed CLI.`;
    }
    if (capability.reason === 'not_daemon') {
      return `Machine ${action} requires the CLI to be launched with \`lody daemon start\`.`;
    }
    return `Machine ${action} is not available in this process.`;
  }

  private triggerPendingProcessLifecycleAction(requestId: string): void {
    const action = this.pendingProcessLifecycleAction;
    if (!action || action.requestId !== requestId) {
      return;
    }
    if (!this.onProcessLifecycleAction) {
      this.logger.warn(`[machine-lifecycle] no process lifecycle callback for ${action.action}`);
      return;
    }
    this.logger.info(`[machine-lifecycle] triggering ${action.action} for request ${requestId}`);
    this.onProcessLifecycleAction(action);
  }

  private async prepareMachineRestart(args: {
    requesterUserId: string;
    requestToken: string;
    requestId: string;
  }): Promise<MachineRestartResponse> {
    if (!this.machineLifecycleCapability.canRemoteRestart) {
      return this.machineRestartFailure(
        args.requestId,
        'unsupported_launch_mode',
        this.machineLifecycleUnsupportedMessage('restart')
      );
    }
    if (this.pendingProcessLifecycleAction) {
      return this.machineRestartFailure(
        args.requestId,
        'already_pending',
        'A machine lifecycle operation is already pending.'
      );
    }
    if (!this.onProcessLifecycleAction) {
      return this.machineRestartFailure(
        args.requestId,
        'error',
        'Machine restart is not available in this process.'
      );
    }

    const verified = await verifyMachineLifecycleRequest({
      token: this.token,
      workspaceId: this.workspaceId,
      machineId: this.machineId,
      action: 'restart',
      requesterUserId: args.requesterUserId,
      requestId: args.requestId,
      requestToken: args.requestToken,
    });
    if (!verified.ok) {
      this.logger.warn(`[machine-lifecycle] restart verification failed: ${verified.error}`);
      return this.machineRestartFailure(
        args.requestId,
        this.lifecycleErrorDisposition(verified),
        verified.error
      );
    }

    this.pendingProcessLifecycleAction = {
      action: 'restart',
      exitCode: EXIT_CODE_REMOTE_RESTART,
      requestId: args.requestId,
    };
    this.logger.info(`[machine-lifecycle] restart accepted for request ${args.requestId}`);
    return {
      type: 'machine/restart_response',
      machineId: this.machineId,
      requestId: args.requestId,
      success: true,
      accepted: true,
      disposition: 'accepted',
    };
  }

  private async prepareMachineUpgrade(args: {
    requesterUserId: string;
    requestToken: string;
    requestId: string;
    targetVersion?: string;
  }): Promise<MachineUpgradeResponse> {
    let targetVersion: string;
    try {
      targetVersion = normalizeMachineUpgradeTargetVersion(args.targetVersion);
    } catch (error) {
      return this.machineUpgradeFailure(
        args.requestId,
        'invalid_target',
        formatErrorMessage(error)
      );
    }

    if (!this.machineLifecycleCapability.canRemoteUpgrade) {
      return this.machineUpgradeFailure(
        args.requestId,
        'unsupported_launch_mode',
        this.machineLifecycleUnsupportedMessage('upgrade'),
        targetVersion
      );
    }
    if (this.pendingProcessLifecycleAction) {
      return this.machineUpgradeFailure(
        args.requestId,
        'already_pending',
        'A machine lifecycle operation is already pending.',
        targetVersion
      );
    }
    if (!this.onProcessLifecycleAction) {
      return this.machineUpgradeFailure(
        args.requestId,
        'unsupported_install',
        'Machine upgrade is not available in this process.',
        targetVersion
      );
    }

    const verified = await verifyMachineLifecycleRequest({
      token: this.token,
      workspaceId: this.workspaceId,
      machineId: this.machineId,
      action: 'upgrade',
      requesterUserId: args.requesterUserId,
      requestId: args.requestId,
      requestToken: args.requestToken,
      targetVersion,
    });
    if (!verified.ok) {
      this.logger.warn(`[machine-lifecycle] upgrade verification failed: ${verified.error}`);
      return this.machineUpgradeFailure(
        args.requestId,
        this.lifecycleErrorDisposition(verified),
        verified.error,
        targetVersion
      );
    }

    try {
      await writeDaemonUpgradeIntent({
        action: 'upgrade',
        requestId: args.requestId,
        requesterUserId: args.requesterUserId,
        targetVersion,
        currentVersion: this.cliVersion,
        requestedAtMs: getServerNow(),
      });
    } catch (error) {
      return this.machineUpgradeFailure(
        args.requestId,
        'error',
        `Could not persist upgrade intent: ${formatErrorMessage(error)}`,
        targetVersion
      );
    }

    this.pendingProcessLifecycleAction = {
      action: 'upgrade',
      exitCode: EXIT_CODE_REMOTE_UPGRADE,
      requestId: args.requestId,
    };
    this.logger.info(
      `[machine-lifecycle] upgrade accepted for request ${args.requestId} target=${targetVersion}`
    );
    return {
      type: 'machine/upgrade_response',
      machineId: this.machineId,
      requestId: args.requestId,
      success: true,
      accepted: true,
      disposition: 'accepted',
      currentVersion: this.cliVersion,
      targetVersion,
    };
  }

  private async handleMachineRestart(
    message: MachineRestartRequestValidated,
    dispatchContext: MessageDispatchContext = this.createRuntimeDispatchContext()
  ): Promise<void> {
    const response = await this.prepareMachineRestart(message);
    dispatchContext.send(response);
    if (response.accepted) {
      this.triggerPendingProcessLifecycleAction(response.requestId);
    }
  }

  private async handleMachineUpgrade(
    message: MachineUpgradeRequestValidated,
    dispatchContext: MessageDispatchContext = this.createRuntimeDispatchContext()
  ): Promise<void> {
    const response = await this.prepareMachineUpgrade(message);
    dispatchContext.send(response);
    if (response.accepted) {
      this.triggerPendingProcessLifecycleAction(response.requestId);
    }
  }

  private async handleMachineAcpCapabilitiesRefresh(
    message: MachineAcpCapabilitiesRefreshRequestValidated,
    dispatchContext: MessageDispatchContext = this.createRuntimeDispatchContext()
  ): Promise<void> {
    const response = await this.executionService.refreshMachineAcpCapabilities(message, {
      onAcpBinaryProgress: (progress) => dispatchContext.send(progress),
    });
    dispatchContext.send(response);
  }

  private async handleMachineAcpAuthenticate(
    message: MachineAcpAuthenticateRequestValidated,
    dispatchContext: MessageDispatchContext = this.createRuntimeDispatchContext()
  ): Promise<void> {
    const response = await this.authenticateMachineAcpAndResumeSetup(message, {
      onProgress: (progress) => dispatchContext.send(progress),
    });
    dispatchContext.send(response);
  }

  private async authenticateMachineAcpAndResumeSetup(
    message: MachineAcpAuthenticateRequestValidated,
    options: Parameters<SessionExecutionService['authenticateMachineAcp']>[1] = {}
  ): Promise<MachineAcpAuthenticateResponse> {
    const response = await this.executionService.authenticateMachineAcp(message, options);
    if (
      message.action === 'start' &&
      response.success &&
      response.disposition === 'authenticated'
    ) {
      try {
        // Re-read and probe the durable task's own config. Never publish based
        // on caller-supplied launch fields from this unauthenticated RPC.
        await this.providerSetupManager.resumeAfterAuthentication(message.configId);
      } catch (error) {
        this.logger.debug(
          `[provider-setup] Failed to resume ${message.configId} after authentication: ${formatErrorMessage(
            error
          )}`
        );
      }
    }
    return response;
  }

  private async handleMachineAcpBinaryStatus(
    message: MachineAcpBinaryStatusRequestValidated,
    dispatchContext: MessageDispatchContext = this.createRuntimeDispatchContext()
  ): Promise<void> {
    const response = await this.executionService.getMachineAcpBinaryStatus(message);
    dispatchContext.send(response);
  }

  private async handleMachineAcpBinaryInstall(
    message: MachineAcpBinaryInstallRequestValidated,
    dispatchContext: MessageDispatchContext = this.createRuntimeDispatchContext()
  ): Promise<void> {
    const response = await this.executionService.installMachineAcpBinary(message, {
      onAcpBinaryProgress: (progress) => dispatchContext.send(progress),
    });
    dispatchContext.send(response);
  }

  private async fetchAcpCapabilities(
    cliType: AgentConfigCliType,
    agentType: string,
    env?: Record<string, string>,
    customAcp?: CustomAcpLaunchSpec,
    runtimeOverrides?: BuiltinRuntimeOverrides,
    options?: FetchAcpCapabilitiesOptions
  ): Promise<{
    modes: NonNullable<MachineAcpCapabilitiesRefreshResponse['modes']>;
    models: NonNullable<MachineAcpCapabilitiesRefreshResponse['models']>;
    configOptions?: AcpConfigOptionSummary[];
    availableCommands?: NonNullable<MachineAcpCapabilitiesRefreshResponse['availableCommands']>;
    sessionFork: boolean;
    acknowledgedSteer: boolean;
    modelReasoningEfforts?: Record<string, string[]>;
    capabilitySourceVersion?: string;
  }> {
    return fetchAcpCapabilities(
      cliType,
      agentType,
      this.logger,
      env,
      customAcp,
      runtimeOverrides,
      options
    );
  }

  private async collectMachineResources(): Promise<MachineResourceInfo> {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const cpus = os.cpus();
    const totalCpus = cpus.length;
    const loadAverage = os.loadavg()[0] ?? 0;

    return {
      totalMemoryGB: totalMemory / 1024 ** 3,
      usedMemoryGB: (totalMemory - freeMemory) / 1024 ** 3,
      freeMemoryGB: freeMemory / 1024 ** 3,
      totalCpus,
      cpuUsagePercent: totalCpus > 0 ? Math.min(100, (loadAverage / totalCpus) * 100) : 0,
    };
  }

  /**
   * Handle permission request from ACP agent.
   *
   * This method writes the permission request to LoroDoc and subscribes to wait for a Web client outcome.
   * Includes a timeout mechanism to prevent indefinite waiting.
   *
   * Flow:
   * 1. Machine writes permissionRequest to LoroDoc history
   * 2. Machine subscribes to LoroDoc for outcome changes
   * 3. Any client can see the request via LoroDoc subscription
   * 4. Client writes outcome directly to LoroDoc
   * 5. Machine detects outcome change via subscription, resolves Promise
   */
  private async handleAgentPermissionRequest(
    sessionId: SessionId,
    requestId: string,
    request: RequestPermissionRequest,
    model?: ModelInfo
  ): Promise<RequestPermissionResponse> {
    const isAskUserQuestionRequest = isAskUserQuestionPermissionRequest(request);
    const askUserQuestionMeta = isAskUserQuestionRequest
      ? parseAskUserQuestionPermissionMeta(request._meta)
      : null;
    const permissionTimeoutMs =
      typeof askUserQuestionMeta?.autoResolveAt === 'number'
        ? Math.min(
            PERMISSION_REQUEST_TIMEOUT_MS,
            Math.max(0, askUserQuestionMeta.autoResolveAt - getServerNow())
          )
        : PERMISSION_REQUEST_TIMEOUT_MS;
    const usesProviderAutoResolution = permissionTimeoutMs < PERMISSION_REQUEST_TIMEOUT_MS;
    const requestKind = isAskUserQuestionRequest ? 'ask_user_question' : 'permission';
    const questionTitle = isAskUserQuestionRequest
      ? getAskUserQuestionPermissionDisplayTitle(request)
      : undefined;
    const toolTitle =
      typeof request.toolCall.title === 'string' ? request.toolCall.title.trim() : undefined;
    const toolKind =
      typeof request.toolCall.kind === 'string' ? request.toolCall.kind.trim() : undefined;
    const displayTitle = questionTitle || toolTitle || undefined;
    const permissionLabel = displayTitle || toolKind || request.toolCall.toolCallId;
    this.logger.info(`Permission requested for session ${sessionId}: ${permissionLabel}`);
    this.logger.debug(
      `[${sessionId}] Processing permission request ${requestId} for tool call ${request.toolCall.toolCallId}`
    );

    const permissionRequestedAt = Date.now();
    // acp/permission_requested (spec §8c, P0). Non-PII: only request/tool kinds.
    captureCli(
      'acp/permission_requested',
      {
        session_id: sessionId,
        workspace_id: this.workspaceId,
        request_kind: requestKind,
        ...(toolKind ? { tool_kind: toolKind } : {}),
      },
      { tier: 'A' }
    );
    const capturePermissionResolved = (
      outcome: 'allow' | 'deny' | 'cancelled' | 'timeout',
      opts: { resolutionSource: string }
    ): void => {
      captureCli(
        'acp/permission_resolved',
        {
          session_id: sessionId,
          workspace_id: this.workspaceId,
          request_kind: requestKind,
          ...(toolKind ? { tool_kind: toolKind } : {}),
          outcome,
          wait_ms: Date.now() - permissionRequestedAt,
          was_timeout: outcome === 'timeout',
          resolution_source: opts.resolutionSource,
        },
        { tier: 'A' }
      );
    };

    const doc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
    let sessionTitle: string | undefined;
    let metaUserId: string | undefined;
    let historyUserId: string | undefined;
    let permissionRequestPersisted = false;

    try {
      permissionRequestPersisted = await ensurePermissionRequestOnToolCall(
        doc,
        requestId,
        request,
        model
      );
      await doc.setLastMessageAt();
      const meta = await doc.getMetaState();
      sessionTitle = meta?.title;
      metaUserId = meta?.userId;

      const history = await doc.getHistory();
      for (let i = history.length - 1; i >= 0; i -= 1) {
        const entry = history[i];
        if (!entry || entry.role !== 'user') continue;
        const userId = entry.userId;
        if (typeof userId === 'string' && userId.trim()) {
          historyUserId = userId;
          break;
        }
      }
    } catch (error) {
      this.logger.error(
        `[${sessionId}] Failed to append permission request to history: ${formatErrorMessage(
          error
        )}`
      );
    }

    if (!permissionRequestPersisted) {
      this.logger.warn(
        `[${sessionId}] Permission request ${requestId} for tool call ${request.toolCall.toolCallId} could not be attached to an active assistant entry; cancelling to avoid waiting for an unobservable permission outcome`
      );
      capturePermissionResolved('cancelled', {
        resolutionSource: 'unobservable',
      });
      return { outcome: { outcome: 'cancelled' } };
    }

    try {
      // The durable marker rides the same meta write as the status. Status is
      // repaired to idle by the heartbeat TTL; this is not, because an offline
      // machine mid-question is still waiting on the user.
      await doc.setStatus(SessionStatusFactory.requestPermission(), {
        awaitingUserSince: getServerNow(),
      });
      this.setSessionActivePresencePhase(sessionId, 'requestPermission');
    } catch (error) {
      this.logger.error(
        `[${sessionId}] Failed to mark session as waiting for permission: ${formatErrorMessage(
          error
        )}`
      );
    }

    const permissionUserId = historyUserId ?? metaUserId ?? this.userId;

    const notificationService = this.notificationService;
    const workspaceSlug = this.workspaceSlug?.trim() || this.workspaceId;
    const notificationInput: PermissionRequestNotificationInput = {
      sessionId,
      sessionTitle,
      workspaceId: this.workspaceId,
      workspaceSlug,
      userId: permissionUserId,
      requestId,
      toolCallId: request.toolCall.toolCallId,
      toolTitle: displayTitle ?? undefined,
      toolKind: request.toolCall.kind ?? undefined,
      requestKind: requestKind === 'ask_user_question' ? requestKind : undefined,
    };
    const permissionInboxRecordPromise = notificationService
      ? notificationService.recordPermissionRequested(notificationInput)
      : Promise.resolve();
    if (notificationService) {
      void this.runTurnCloudSideEffect(
        sessionId,
        'permission inbox record',
        () => permissionInboxRecordPromise
      );
    }

    if (notificationService) {
      if (requestKind === 'permission') {
        void (async () => {
          const historySynced = await doc.waitUntilSynced();
          if (!historySynced) {
            this.logger.debug(
              `[${sessionId}] Permission request history was not confirmed before Live Activity sync; sending notification fallback`
            );
            await notificationService.notifyPermissionRequested(notificationInput);
            return;
          }

          const liveActivityResult = await this.syncLiveActivitySummary(permissionUserId, {
            permissionAlert: true,
          });
          if (liveActivityResult.sent && !liveActivityResult.ended) {
            return;
          }

          await notificationService.notifyPermissionRequested(notificationInput);
        })().catch((error: unknown) => {
          this.logger.debug(
            `[${sessionId}] Failed to send permission notification fallback: ${formatErrorMessage(
              error
            )}`
          );
        });
      } else {
        void notificationService.notifyPermissionRequested(notificationInput);
        void this.syncLiveActivitySummary(permissionUserId);
      }
    }

    // Track when permission was requested for duration calculation
    this.permissionRequestStartTimes.set(requestId, Date.now());

    // Subscribe to LoroDoc and wait for outcome
    return new Promise<RequestPermissionResponse>((resolve) => {
      let resolved = false;
      let timedOutResolution = false;
      let unsubscribe: (() => void) | null = null;
      let timeoutId: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      const resolveWithOutcome = async (
        outcome: RequestPermissionResponse['outcome'],
        resolutionSource: string = 'client'
      ) => {
        if (resolved) return;
        resolved = true;
        cleanup();

        // Accumulate permission wait time for this session
        const requestStartTime = this.permissionRequestStartTimes.get(requestId);
        if (requestStartTime) {
          const waitMs = Date.now() - requestStartTime;
          const state = this.store.get(sessionId);
          state.permissionWaitMs += waitMs;
          this.permissionRequestStartTimes.delete(requestId);
          this.logger.debug(
            `[${sessionId}] Permission wait time: ${waitMs}ms (total: ${state.permissionWaitMs}ms)`
          );
        }

        // Single funnel for client answers, cancels, and timeouts, so clearing
        // here cannot leave a stale "waiting on you" behind.
        try {
          await doc.clearAwaitingUser();
        } catch (error) {
          this.logger.debug(
            `[${sessionId}] Failed to clear awaitingUserSince: ${formatErrorMessage(error)}`
          );
        }

        this.logger.info(`Permission resolved for session ${sessionId}: ${outcome.outcome}`);
        this.logger.debug(
          `[${sessionId}] Permission request ${requestId} resolved with outcome: ${outcome.outcome}`
        );

        if (!timedOutResolution) {
          capturePermissionResolved(outcome.outcome === 'selected' ? 'allow' : 'cancelled', {
            resolutionSource,
          });
        }
        if (notificationService) {
          void permissionInboxRecordPromise.then(async () => {
            await this.runTurnCloudSideEffect(
              sessionId,
              'permission inbox resolution',
              async () => {
                await notificationService.resolvePermissionRequested(notificationInput);
              }
            );
          });
        }

        try {
          const maybeGetStatus = (
            doc as unknown as {
              getStatus?: () => Promise<SessionStatus | undefined>;
            }
          ).getStatus;
          const currentStatus =
            typeof maybeGetStatus === 'function'
              ? await maybeGetStatus.call(doc)
              : ('unknown' as const);

          // This callback fires from a mirror subscription and can run after
          // the visible active scope ended; only restore `running` while active
          // presence is still owned locally.
          if (
            shouldRestoreRunningAfterPermission({
              hasActivePresence: this.hasSessionActivePresence(sessionId),
              status: currentStatus,
            })
          ) {
            await doc.setStatus(SessionStatusFactory.running());
            this.setSessionActivePresencePhase(sessionId, 'thinking');
            void this.syncLiveActivitySummary(permissionUserId);
          }
        } catch (error) {
          this.logger.debug(
            `[${sessionId}] Failed to restore running status after permission resolution: ${formatErrorMessage(
              error
            )}`
          );
        }

        resolve({ outcome });
      };

      // Check if outcome already exists (e.g., from a previous device)
      const checkForOutcome = () => {
        if (resolved || !doc.mirror) return;
        const history = (doc.mirror.getState().history as SessionHistoryInput[]) ?? [];
        const outcome = findPermissionOutcomeInHistory(history, requestId);
        if (outcome) {
          void resolveWithOutcome(outcome);
        }
      };

      // Subscribe to history changes
      if (doc.mirror) {
        unsubscribe = doc.mirror.subscribe(() => {
          checkForOutcome();
        });
      }

      // Check immediately in case outcome was already written
      checkForOutcome();

      // Setup timeout
      timeoutId = setTimeout(() => {
        void (async () => {
          if (resolved) return;

          if (usesProviderAutoResolution) {
            this.logger.debug(
              `[${sessionId}] Provider auto-resolved permission request ${requestId}`
            );
          } else {
            this.logger.warn(`Permission request timed out for session ${sessionId}`);
          }
          this.logger.debug(
            `[${sessionId}] Permission request ${requestId} timed out after ${permissionTimeoutMs}ms`
          );

          timedOutResolution = true;
          capturePermissionResolved('timeout', {
            resolutionSource: usesProviderAutoResolution ? 'provider_auto_resolution' : 'timeout',
          });

          // Update history to mark as cancelled due to timeout
          try {
            await updatePermissionOutcomeInHistory(
              doc,
              requestId,
              { outcome: 'cancelled' },
              this.logger
            );
          } catch (error) {
            this.logger.error(
              `[${sessionId}] Failed to update permission timeout in history: ${formatErrorMessage(
                error
              )}`
            );
          }

          void resolveWithOutcome({ outcome: 'cancelled' });
        })();
      }, permissionTimeoutMs);
    });
  }

  // The session-create trigger (session-execution-service deps) doesn't know about
  // agent configs, so the per-agent titleGeneration overrides (model/mode config
  // options) are resolved here from the session meta's agentConfigId.
  private async resolveTitleConfig(
    sessionId: SessionId,
    agentConfigId: AgentConfigId | undefined
  ): Promise<TitleGenerationConfig | undefined> {
    if (!agentConfigId) {
      return undefined;
    }
    try {
      const agentConfigMeta = await this.workspaceDocument.getAgentConfigById(agentConfigId);
      return agentConfigMeta?.titleGeneration;
    } catch (error) {
      this.logger.debug(
        `[${sessionId}] Failed to load agent config ${agentConfigId} for title generation: ${formatErrorMessage(error)}`
      );
      return undefined;
    }
  }

  /**
   * Stores a session title pushed by the agent via ACP session_info_update
   * Builtin Claude skips the isolated local generator, so the pushed title is
   * its only generated source. Never overwrites a user-set title; the conditional
   * write guards against renames racing in via sync.
   */
  private async maybeStoreAgentSessionTitle(sessionId: SessionId, title: string): Promise<void> {
    try {
      const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
      const sanitized = sanitizeTitle(sanitizeLodyInternalInstructions(title));
      if (!sanitized) {
        return;
      }
      const meta = await sessionDoc.getMetaState();
      if (meta?.title?.trim() === sanitized) {
        return;
      }
      const applied = await sessionDoc.setTitleIfSourceIn(sanitized, 'generated', [
        'draft',
        'generated',
      ]);
      if (applied) {
        this.logger.debug(`[${sessionId}] Session title updated from agent: ${sanitized}`);
      }
    } catch (error) {
      this.logger.debug(
        `[${sessionId}] Failed to store agent-provided session title: ${formatErrorMessage(error)}`
      );
    }
  }

  /**
   * Persists an agent-issued warning (e.g. Codex app-server `warning`/`configWarning`
   * notifications, forwarded structured via ACP session_info_update `_meta`) as a
   * system_notice history item. Kept out of agent text so it renders as a warning
   * and never pollutes titles or replay prompts. Runs on the per-session notice
   * queue; dedupe happens inside the atomic updateHistory call because some
   * runtime warnings fire once per turn.
   */
  private async recordAgentWarning(
    sessionId: SessionId,
    warning: AgentSessionWarning
  ): Promise<void> {
    try {
      const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
      // Order the notice after the user turn that triggered it (RPC fast-path turns).
      await this.awaitTurnHistoryGate(sessionId);
      type SessionHistoryItemInput = NonNullable<SessionHistoryInput['items']>[number];
      const noticeItem: SessionHistoryItemInput = {
        type: 'system_notice',
        text: undefined,
        name: 'agent_warning',
        meta: {
          message: warning.message,
          ...(warning.source ? { source: warning.source } : {}),
        },
      };
      const systemNotice: SessionHistoryInput = {
        id: `agent-warning-${uuidV4()}`,
        role: 'system',
        timestamp: new Date(getServerNow()).toISOString(),
        read: undefined,
        userId: undefined,
        fileDiff: [],
        items: [noticeItem],
      };
      await sessionDoc.updateHistory((prevHistory) => {
        const alreadyRecorded = prevHistory.some((entry) =>
          entry.items?.some(
            (item) =>
              item?.type === 'system_notice' &&
              item.name === 'agent_warning' &&
              (item.meta as AgentWarningMeta | undefined)?.message === warning.message
          )
        );
        return alreadyRecorded ? prevHistory : [...prevHistory, systemNotice];
      });
    } catch (error) {
      this.logger.debug(
        `[${sessionId}] Failed to record agent warning: ${formatErrorMessage(error)}`
      );
    }
  }

  private async maybeGenerateAndStoreSessionTitle(
    sessionId: SessionId,
    cliType: AgentConfigCliType,
    agentType: string,
    taskPrompt: string,
    env?: Record<string, string>,
    customAcp?: CustomAcpLaunchSpec,
    runtimeOverrides?: BuiltinRuntimeOverrides,
    titleConfig?: TitleGenerationConfig
  ): Promise<void> {
    // Builtin Claude publishes a generated session_info_update title.
    if (usesAcpProvidedSessionTitle(cliType, agentType)) {
      return;
    }
    const existingGeneration = this.titleGenerationInFlight.get(sessionId);
    if (existingGeneration) {
      try {
        await existingGeneration;
      } catch (error) {
        this.logger.debug(
          `[${sessionId}] Existing session title generation failed: ${formatErrorMessage(error)}`
        );
      }
      return;
    }

    const generation = (async (): Promise<string | null> => {
      const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
      const meta = await sessionDoc.getMetaState();
      const existingTitle = meta?.title?.trim();
      const canOverwriteExistingTitle = meta?.titleSource === 'draft';
      if (existingTitle && !canOverwriteExistingTitle) {
        this.logger.debug(
          `[${sessionId}] Skipping session title generation because title already set: ${existingTitle}`
        );
        return meta?.titleSource === 'generated' ? existingTitle : null;
      }

      this.logger.debug(`[${sessionId}] Generating session title because title is missing`);
      const resolvedTitleConfig =
        titleConfig ?? (await this.resolveTitleConfig(sessionId, meta?.agentConfigId));
      const title = await generateTitleIsolated({
        cliType,
        agentType,
        customAcp,
        runtimeOverrides,
        taskPrompt,
        logger: this.logger,
        env,
        titleConfig: resolvedTitleConfig,
      });
      if (!title) {
        this.logger.debug(`[${sessionId}] Session title generation returned empty result`);
        return null;
      }
      // Conditional write: a title may have landed while generation was in flight
      // (agent-pushed title, user rename); only a draft may still be replaced.
      const applied = await sessionDoc.setTitleIfSourceIn(title, 'generated', ['draft']);
      if (!applied) {
        this.logger.debug(
          `[${sessionId}] Skipping generated title because title changed while generation was in flight`
        );
      } else {
        this.logger.debug(`[${sessionId}] Session title stored in metadata: ${title}`);
      }
      // The generated value is still safe to reuse for a branch name even when a
      // concurrent user rename prevented it from being written as the session title.
      return title;
    })();
    this.titleGenerationInFlight.set(sessionId, generation);
    try {
      await generation;
    } catch (error) {
      this.logger.debug(
        `[${sessionId}] Failed to generate/store session title: ${formatErrorMessage(error)}`
      );
    } finally {
      if (this.titleGenerationInFlight.get(sessionId) === generation) {
        this.titleGenerationInFlight.delete(sessionId);
      }
    }
  }

  async startSessionDispatchWatcher(): Promise<void> {
    await this.sessionDispatchWatcher.start();
    this.operationCoordinator.start();
  }

  startMachineRpcServer(): void {
    if (!this.machineRpcServer) {
      this.logger.debug(
        'Loro Streams machine RPC request listener not started: server unavailable'
      );
      return;
    }
    this.startMachineRpcServerAttempt();
  }

  async activateRemoteServices(): Promise<void> {
    this.startMachineRpcServer();
    await this.attemptMachineAccessRegistration();
  }

  private startMachineRpcServerAttempt(): void {
    if (
      this.cleanedUp ||
      !this.machineRpcServer ||
      this.machineRpcServerStartPromise ||
      this.machineRpcServerRetryTimer
    ) {
      return;
    }

    const server = this.machineRpcServer;
    const tokenProvider = this.machineRpcTokenProvider;
    if (!tokenProvider) {
      this.logger.error('Loro Streams machine RPC server has no platform token provider');
      return;
    }

    const attempt = this.machineRpcServerStartAttempt + 1;
    const startedAt = Date.now();
    const startPromise = prepareCliStreamsGatewayBaseUrl(tokenProvider)
      .then(async (gatewayBaseUrl) => {
        this.machineRpcGatewayBaseUrl = gatewayBaseUrl;
        if (!this.cleanedUp) {
          await server.start();
        }
      })
      .then(() => {
        if (this.cleanedUp) {
          return;
        }
        this.machineRpcServerStartAttempt = 0;
        this.logger.debug(
          `[startup] Machine RPC listener ready durationMs=${Date.now() - startedAt} attempt=${attempt}`
        );
      })
      .catch((error: unknown) => {
        if (this.cleanedUp) {
          return;
        }
        this.machineRpcServerStartAttempt = attempt;
        const delayMs = Math.min(1_000 * 2 ** Math.min(attempt - 1, 5), 30_000);
        this.logger.warn(
          `[startup] Machine RPC listener start failed durationMs=${
            Date.now() - startedAt
          } attempt=${attempt}; retrying in ${delayMs}ms: ${formatErrorMessage(error)}`
        );
        this.machineRpcServerRetryTimer = setTimeout(() => {
          this.machineRpcServerRetryTimer = null;
          this.startMachineRpcServerAttempt();
        }, delayMs);
        this.machineRpcServerRetryTimer.unref?.();
      })
      .finally(() => {
        if (this.machineRpcServerStartPromise === startPromise) {
          this.machineRpcServerStartPromise = null;
        }
      });
    this.machineRpcServerStartPromise = startPromise;
  }

  private toLocalProjectControlError(
    type: LocalProjectControlRequest['type'],
    error: LocalProjectControlErrorCode,
    message: string,
    data?: unknown
  ): LocalProjectControlResponse {
    return {
      ok: false,
      type,
      error,
      message,
      data,
    };
  }

  private async dispatchOwnerOnlyLocalProjectControlViaRpc(
    request: LocalProjectOwnerOnlyRpcRequest
  ): Promise<LocalProjectControlResponse> {
    const requestType = request.type;
    if (request.machineId !== this.machineId) {
      return this.toLocalProjectControlError(
        requestType,
        'machine_mismatch',
        `Machine mismatch: expected ${this.machineId}`
      );
    }

    try {
      if (request.type === 'local-project/list-roots') {
        return {
          ok: true,
          type: 'local-project/list-roots',
          result: await this.localProjectControlService.listBrowseRoots(),
        };
      }

      if (request.type === 'local-project/browse-dir') {
        return {
          ok: true,
          type: 'local-project/browse-dir',
          result: await this.localProjectControlService.browseDirectory({
            absolutePath: request.absolutePath,
            showHidden: request.showHidden,
            limit: request.limit,
            cursor: request.cursor,
            registeredProjects: await this.listRegisteredLocalProjectRootPathsForCurrentWorkspace(),
          }),
        };
      }

      if (request.type === 'local-project/prepare-add') {
        if (request.workspaceId !== this.workspaceId) {
          return this.toLocalProjectControlError(
            requestType,
            'workspace_not_found',
            `Workspace mismatch: expected ${this.workspaceId}`
          );
        }
        const preparedProject = this.localProjectControlService.prepareProject(request.rootPath);
        const existingProject = await resolveWorkspaceLocalProjectWithSyncOnMiss(
          this.workspaceDocument.repo,
          this.workspaceId,
          this.machineId,
          preparedProject.localProjectId,
          {
            requestSync: () =>
              this.workspaceDocument.syncMachineFlockDoc(this.machineId, {
                reason: 'local-project-prepare-add-resolve',
                timeoutMs: readTimeoutEnv('LODY_LOCAL_PROJECT_RESOLVE_SYNC_TIMEOUT_MS', 1_500),
              }),
          }
        );
        return {
          ok: true,
          type: 'local-project/prepare-add',
          result: {
            localProjectId: preparedProject.localProjectId,
            name: existingProject?.name ?? preparedProject.name,
            rootPath: existingProject?.rootPath ?? preparedProject.rootPath,
            alreadyRegistered: existingProject !== null,
          },
        };
      }

      const addedProject = this.localProjectControlService.prepareProject(request.rootPath);
      await this.upsertLocalProjectMetaInCurrentWorkspace({
        localProjectId: addedProject.localProjectId,
        name: addedProject.name,
        rootPath: addedProject.rootPath,
      });

      return {
        ok: true,
        type: 'local-project/add',
        result: {
          localProjectId: addedProject.localProjectId,
          name: addedProject.name,
          rootPath: addedProject.rootPath,
          workspaceIds: [this.workspaceId],
        },
      };
    } catch (error) {
      return this.toLocalProjectControlError(
        requestType,
        'execution_failed',
        formatErrorMessage(error)
      );
    }
  }

  private async listRegisteredLocalProjectRootPathsForCurrentWorkspace(): Promise<
    Record<LocalProjectId, string>
  > {
    const projects = await readMachineLocalProjects(
      this.workspaceDocument.repo,
      this.workspaceId,
      this.machineId
    );
    return Object.fromEntries(
      Object.entries(projects).map(([localProjectId, project]) => [
        localProjectId as LocalProjectId,
        project.rootPath,
      ])
    ) as Record<LocalProjectId, string>;
  }

  private async upsertLocalProjectMetaInCurrentWorkspace(entry: {
    localProjectId: LocalProjectId;
    name: string;
    rootPath: string;
  }): Promise<void> {
    const existing = await readMachineLocalProjects(
      this.workspaceDocument.repo,
      this.workspaceId,
      this.machineId
    );
    const previous = existing[entry.localProjectId];
    const nowMs = getServerNow();

    await upsertMachineLocalProject(
      this.workspaceDocument.repo,
      this.workspaceId,
      this.machineId,
      {
        ...(previous ?? {}),
        id: entry.localProjectId,
        name: entry.name,
        rootPath: entry.rootPath,
        createdAtMs: previous?.createdAtMs ?? nowMs,
        lastOpenedAtMs: nowMs,
      },
      nowMs,
      { sync: this.workspaceDocument, reason: 'local-project-add' }
    );
  }

  /**
   * Shared async authorization for local-project RPC dispatch: confirm the CLI
   * token may act for the requesting user on this project, then resolve its root
   * path. Returns either the resolved root or a ready-to-send error response so
   * the file and history dispatchers stay in lockstep on access/not-found errors.
   */
  private async authorizeLocalProjectRoot(args: {
    requestType: LocalProjectControlRequest['type'];
    requesterUserId: string;
    localProjectId: LocalProjectId;
  }): Promise<
    { ok: true; rootPath: string } | { ok: false; response: LocalProjectControlResponse }
  > {
    const access = await this.cloudPort.access.verifyMachineAccess({
      workspaceId: this.workspaceId,
      machineId: this.machineId,
      requesterUserId: args.requesterUserId,
      localProjectId: args.localProjectId,
    });
    if (!access.allowed) {
      return {
        ok: false,
        response: this.toLocalProjectControlError(
          args.requestType,
          'access_denied',
          `Machine access denied: ${access.reason}`
        ),
      };
    }

    const rootPath = await resolveWorkspaceLocalProjectRootPath(
      this.workspaceDocument.repo,
      this.workspaceId,
      this.machineId,
      args.localProjectId
    );
    if (!rootPath) {
      return {
        ok: false,
        response: this.toLocalProjectControlError(
          args.requestType,
          'local_project_not_found',
          `Local project not found in workspace: ${args.localProjectId}`
        ),
      };
    }

    return { ok: true, rootPath };
  }

  /**
   * Shared synchronous prechecks for the file + global-skills RPC dispatchers:
   * machine, workspace, then requesterUserId, in that precedence order. Returns
   * the validated requester id or a ready-to-return error response. (History /
   * setup requests use `precheckLocalProjectHistoryRequest`, which interleaves a
   * request-type check and so keeps its own order.)
   */
  private precheckLocalProjectControlRequester(
    request: LocalProjectFileRpcRequest | LocalProjectGlobalSkillsRpcRequest,
    missingRequesterMessage: string
  ): { ok: true; requesterUserId: string } | { ok: false; response: LocalProjectControlResponse } {
    const requestType = request.type;
    if (request.machineId !== this.machineId) {
      return {
        ok: false,
        response: this.toLocalProjectControlError(
          requestType,
          'machine_mismatch',
          `Machine mismatch: expected ${this.machineId}`
        ),
      };
    }

    if (request.workspaceId !== this.workspaceId) {
      return {
        ok: false,
        response: this.toLocalProjectControlError(
          requestType,
          'workspace_not_found',
          `Workspace mismatch: expected ${this.workspaceId}`
        ),
      };
    }

    const requesterUserId = request.requestedByUserId?.trim();
    if (!requesterUserId) {
      return {
        ok: false,
        response: this.toLocalProjectControlError(
          requestType,
          'invalid_request',
          missingRequesterMessage
        ),
      };
    }

    return { ok: true, requesterUserId };
  }

  private async dispatchLocalProjectFileControlViaRpc(
    request: LocalProjectFileRpcRequest
  ): Promise<LocalProjectControlResponse> {
    const requestType = request.type;
    const precheck = this.precheckLocalProjectControlRequester(
      request,
      'Local project file requests require requestedByUserId'
    );
    if (!precheck.ok) {
      return precheck.response;
    }
    const { requesterUserId } = precheck;

    try {
      const authorized = await this.authorizeLocalProjectRoot({
        requestType,
        requesterUserId,
        localProjectId: request.localProjectId,
      });
      if (!authorized.ok) {
        return authorized.response;
      }
      const { rootPath } = authorized;

      if (request.type === 'local-project/list-files') {
        return {
          ok: true,
          type: 'local-project/list-files',
          result: await this.localProjectControlService.listProjectFiles(rootPath, {
            maxFiles: request.maxFiles,
          }),
        };
      }

      if (request.type === 'local-project/list-dir') {
        return {
          ok: true,
          type: 'local-project/list-dir',
          result: await this.localProjectControlService.listProjectDirectory(
            rootPath,
            request.relativePath,
            { limit: request.limit }
          ),
        };
      }

      if (request.type === 'local-project/list-skills') {
        return {
          ok: true,
          type: 'local-project/list-skills',
          result: await this.localProjectControlService.listProjectSkills(
            rootPath,
            request.skillDirs
          ),
        };
      }

      return {
        ok: true,
        type: 'local-project/read-file',
        result: this.localProjectControlService.readProjectFile(rootPath, request.relativePath, {
          maxBytes: request.maxBytes,
        }),
      };
    } catch (error) {
      return this.toLocalProjectControlError(
        requestType,
        'execution_failed',
        formatErrorMessage(error)
      );
    }
  }

  private async dispatchLocalProjectGlobalSkillsControlViaRpc(
    request: LocalProjectGlobalSkillsRpcRequest
  ): Promise<LocalProjectControlResponse> {
    const requestType = request.type;
    const precheck = this.precheckLocalProjectControlRequester(
      request,
      'Global skill requests require requestedByUserId'
    );
    if (!precheck.ok) {
      return precheck.response;
    }
    const { requesterUserId } = precheck;

    try {
      const access = await this.cloudPort.access.verifyMachineAccess({
        workspaceId: this.workspaceId,
        machineId: this.machineId,
        requesterUserId,
      });
      if (!access.allowed) {
        return this.toLocalProjectControlError(
          requestType,
          'access_denied',
          `Machine access denied: ${access.reason}`
        );
      }

      return {
        ok: true,
        type: 'local-project/list-global-skills',
        result: await this.localProjectControlService.listGlobalSkills(),
      };
    } catch (error) {
      return this.toLocalProjectControlError(
        requestType,
        'execution_failed',
        formatErrorMessage(error)
      );
    }
  }

  private async dispatchLocalProjectControlViaRpc(
    message: LocalProjectControlRequest
  ): Promise<LocalProjectControlResponse> {
    const requestType = message.type;
    if (isLocalProjectOwnerOnlyRpcRequest(message)) {
      return await this.dispatchOwnerOnlyLocalProjectControlViaRpc(message);
    }

    if (isLocalProjectFileRpcRequest(message)) {
      return await this.dispatchLocalProjectFileControlViaRpc(message);
    }

    if (isLocalProjectGlobalSkillsRpcRequest(message)) {
      return await this.dispatchLocalProjectGlobalSkillsControlViaRpc(message);
    }

    const precheck = precheckLocalProjectHistoryRequest({
      request: message,
      expectedMachineId: this.machineId,
      expectedWorkspaceId: this.workspaceId,
    });
    if (!precheck.ok) {
      return this.toLocalProjectControlError(requestType, precheck.error, precheck.message);
    }
    const { requesterUserId, request } = precheck;

    try {
      const authorized = await this.authorizeLocalProjectRoot({
        requestType,
        requesterUserId,
        localProjectId: request.localProjectId,
      });
      if (!authorized.ok) {
        return authorized.response;
      }
      const { rootPath } = authorized;

      if (request.type === 'local-project/removal-preflight') {
        const sessions = (await listAliveSessionMetas(this.workspaceDocument)).map(
          ({ meta }) => meta
        );
        return {
          ok: true,
          type: 'local-project/removal-preflight',
          result: await preflightLocalProjectWorktreeRemoval({
            machineId: this.machineId,
            localProjectId: request.localProjectId,
            originalRootPath: rootPath,
            sessions,
            logger: this.logger,
          }),
        };
      }

      if (isLocalProjectWorktreeConfigRequest(request)) {
        return await handleLocalProjectWorktreeConfigRequest(request);
      }

      const service = new LocalProjectHistorySyncService(
        this.workspaceDocument,
        this.logger,
        {
          workspaceId: this.workspaceId,
          machineId: this.machineId,
          userId: this.userId,
        },
        request.provider
      );

      if (request.type === 'local-project/sync-history') {
        const result = await service.syncLocalProject({
          localProjectId: request.localProjectId,
          rootPath,
        });
        return {
          ok: true,
          type: 'local-project/sync-history',
          result,
        };
      }

      if (request.type === 'local-project/import-history') {
        const result = await service.importLocalProjectSessions({
          localProjectId: request.localProjectId,
          rootPath,
          acpSessionIds: request.acpSessionIds,
        });
        return {
          ok: true,
          type: 'local-project/import-history',
          result,
        };
      }

      const result = await service.resolveHistoryConflict({
        localProjectId: request.localProjectId,
        rootPath,
        sessionId: request.sessionId,
        acpSessionId: request.acpSessionId,
      });
      return {
        ok: true,
        type: 'local-project/resolve-history-conflict',
        result,
      };
    } catch (error) {
      return this.toLocalProjectControlError(
        requestType,
        'execution_failed',
        formatErrorMessage(error)
      );
    }
  }

  cancelPendingPermissionRequests(): void {
    this.permissionRequestStartTimes.clear();
  }

  /**
   * Flush pending ACP updates and tear down session resources.
   */
  async cleanup(): Promise<void> {
    this.logger.debug('Cleaning up message handler resources');
    this.cleanedUp = true;
    this.cancelAllCodeCollabTurnRetryTimers();
    if (this.machineRpcServerRetryTimer) {
      clearTimeout(this.machineRpcServerRetryTimer);
      this.machineRpcServerRetryTimer = null;
    }
    // Stop scheduling/retrying local-file backfill; in-flight uploads finish but
    // no new attempts start. Pending blobs are recovered on next startup scan.
    this.sessionFileBackfillStopped = true;
    this.cancelPendingPermissionRequests();
    this.machineRpcServer?.stop();
    this.operationCoordinator.stop();
    this.sessionDispatchWatcher.stop();
    this.codeCollabV2Service.dispose();
    this.archiveWatchHandle?.unsubscribe();
    this.archiveWatchHandle = null;
    this.deleteWatchHandle?.unsubscribe();
    this.deleteWatchHandle = null;
    this.machineFlockCommandWatcher.stop();
    this.providerSetupManager.stop();
    this.sessionActivePresence.clearAll();
    // Terminating sessions is the producer barrier: agent callbacks may still
    // enqueue their final ACP notifications while termination is in progress,
    // but none can arrive after this await. Keep the document manager open so
    // those callbacks can be flushed below.
    await this.sessionManager.cleanUp({ keepWorkspaceDocumentOpen: true });
    await this.flushAllACPUpdates();
    // Wait for any in-flight flushes to complete
    const inFlightPromises = this.store
      .sessionIds()
      .map((id) => this.store.get(id).acpFlushInFlight)
      .filter((p): p is Promise<void> => p !== null);
    await Promise.all(inFlightPromises);
    await this.drainCodeCollabTurnPersistenceForCleanup();
    await this.codeCollabV2DiffStore.close();
    await this.previewService.closeAllActiveTunnelsForCleanup('Message handler cleanup');
    await this.sessionManager.cleanUp();
  }

  private async maybeRenameSessionBranchFromPrompt(
    sessionId: SessionId,
    session: ISession,
    cliType: AgentConfigCliType,
    agentType: string,
    taskPrompt: string,
    env?: Record<string, string>,
    titleConfig?: TitleGenerationConfig
  ): Promise<void> {
    const trimmedPrompt = taskPrompt.trim();
    if (!trimmedPrompt) {
      return;
    }

    let metaBranchName: string | null = null;
    let metaCustomAcp: CustomAcpLaunchSpec | undefined;
    let metaRuntimeOverrides: BuiltinRuntimeOverrides | undefined;
    let metaAgentConfigId: AgentConfigId | undefined;
    let reusableTitlePromise: Promise<string | null> | undefined;
    try {
      const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
      const meta = await sessionDoc.getMetaState();
      metaBranchName = meta?.branchName?.trim() || null;
      metaAgentConfigId = meta?.agentConfigId;
      const generatedMetaTitle = meta?.titleSource === 'generated' ? meta.title?.trim() : '';
      reusableTitlePromise = generatedMetaTitle
        ? Promise.resolve(generatedMetaTitle)
        : this.titleGenerationInFlight.get(sessionId);
      const agentConfig = metaAgentConfigId
        ? await this.workspaceDocument.getAgentConfigById(metaAgentConfigId)
        : null;
      const legacyLaunchConfig = await readLegacySessionLaunchConfig({
        repo: this.workspaceDocument.repo,
        workspaceId: this.workspaceId,
        machineId: this.machineId,
        sessionId,
        sessionMeta: meta,
        logger: this.logger,
      });
      metaCustomAcp = agentConfig?.customAcp ?? legacyLaunchConfig?.customAcp;
      metaRuntimeOverrides = agentConfig?.runtimeOverrides ?? legacyLaunchConfig?.runtimeOverrides;
      if (metaBranchName && !isManagedWorktreeBranchName(metaBranchName)) {
        return;
      }
    } catch (error) {
      this.logger.debug(
        `[${sessionId}] Failed to read session meta before branch rename: ${formatErrorMessage(error)}`
      );
    }

    const resolvedTitleConfig =
      titleConfig ?? (await this.resolveTitleConfig(sessionId, metaAgentConfigId));
    const branchName = await this.generateBranchNameWithTimeout(
      cliType,
      agentType,
      trimmedPrompt,
      env,
      20_000,
      resolvedTitleConfig,
      metaCustomAcp,
      metaRuntimeOverrides,
      reusableTitlePromise
    );
    if (!branchName) {
      this.logger.debug(`[${sessionId}] Skipping branch rename: name generation timed out`);
      return;
    }

    const workdir = session.getWorkdir();
    const currentBranch = await resolveGitBranchName(session.exec.bind(session), workdir);
    if (!currentBranch || currentBranch === branchName) {
      return;
    }
    if (!isManagedWorktreeBranchName(currentBranch)) {
      this.logger.debug(
        `[${sessionId}] Skipping branch rename: not on a managed worktree branch (currentBranch=${currentBranch})`
      );
      return;
    }
    if (metaBranchName && metaBranchName !== currentBranch) {
      this.logger.debug(
        `[${sessionId}] Skipping branch rename: branch changed before rename (metaBranchName=${metaBranchName} currentBranch=${currentBranch})`
      );
      return;
    }

    try {
      const renamedBranch = await renameBranchWithAvailableSuffix({
        exec: session.exec.bind(session),
        workdir,
        currentBranch,
        desiredBranchName: branchName,
        maxLength: 50,
      });
      if (!renamedBranch) {
        this.logger.debug(
          `[${sessionId}] Skipping branch rename: branch changed or git rejected the rename`
        );
        return;
      }
      await this.turnPostProcessingService.syncSessionBranchName(sessionId, session);
    } catch (error) {
      this.logger.debug(`[${sessionId}] Failed to rename branch: ${formatErrorMessage(error)}`);
    }
  }

  private async generateBranchNameWithTimeout(
    cliType: AgentConfigCliType,
    agentType: string,
    taskPrompt: string,
    env: Record<string, string> | undefined,
    timeoutMs: number,
    titleConfig?: TitleGenerationConfig,
    customAcp?: CustomAcpLaunchSpec,
    runtimeOverrides?: BuiltinRuntimeOverrides,
    reusableTitlePromise?: Promise<string | null>
  ): Promise<string | null> {
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(null), timeoutMs);
    });

    const namePromise = (async (): Promise<string> => {
      const title = reusableTitlePromise
        ? await reusableTitlePromise
        : await generateTitleIsolated({
            cliType,
            agentType,
            customAcp,
            runtimeOverrides,
            taskPrompt,
            logger: this.logger,
            env,
            titleConfig,
          });
      const base = title ?? taskPrompt;
      return ensureValidBranchName(base, 'task');
    })();

    try {
      const result = await Promise.race([namePromise, timeoutPromise]);
      return result ?? null;
    } catch (error) {
      this.logger.debug(
        `[branch-name] Failed to generate branch name: ${formatErrorMessage(error)}`
      );
      return null;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async notifySessionCompleted(
    sessionId: SessionId,
    userId: string,
    occurrenceId: string
  ): Promise<void> {
    if (!this.notificationService) {
      return;
    }
    const notificationService = this.notificationService;
    await this.runTurnCloudSideEffect(sessionId, 'completion notification', async () => {
      const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
      const meta = await sessionDoc.getMetaState();
      const workspaceSlug = this.workspaceSlug?.trim() || this.workspaceId;
      await notificationService.notifySessionCompleted({
        sessionId,
        occurrenceId,
        sessionTitle: meta?.title,
        pullRequests: meta?.pullRequests,
        workspaceId: this.workspaceId,
        workspaceSlug,
        userId,
      });
      await this.syncLiveActivitySummary(userId);
    });
  }

  private async buildLiveActivitySummary(
    userId: string,
    options: { permissionAlert?: boolean } = {}
  ): Promise<LiveActivitySummary> {
    const sessionMetas = (
      await Promise.all(
        [...this.workspaceDocument.sessions.values()].map(async (sessionDoc) => {
          try {
            return await sessionDoc.getMetaState();
          } catch {
            return undefined;
          }
        })
      )
    ).filter((meta): meta is SessionMeta => meta !== undefined);
    const nowMs = getServerNow();
    const items = buildLiveActivityConversationItems({
      sessions: sessionMetas,
      currentUserId: userId,
      defaultTitle: 'New Task',
      statusLabels: {
        permission: 'Permission',
        question: 'Question',
        running: 'Running',
        unread: 'Completed',
      },
      formatUpdatedAt: (updatedAt) => formatLiveActivityUpdatedAt(updatedAt, nowMs),
    });
    const permissionAlertCandidate = options.permissionAlert
      ? findLiveActivityPermissionAlertCandidate({
          sessions: sessionMetas,
          currentUserId: userId,
          defaultTitle: 'New Task',
        })
      : null;

    const summary: LiveActivitySummary = {
      activityId: buildLodyConversationsLiveActivityId({
        workspaceId: this.workspaceId,
        userId,
        schemaVersion: LODY_CONVERSATIONS_LIVE_ACTIVITY_SCHEMA_VERSION,
      }),
      totalCount: countLiveActivityConversationCandidates({
        sessions: sessionMetas,
        currentUserId: userId,
      }),
      statusCounts: countLiveActivityConversationStatuses({
        sessions: sessionMetas,
        currentUserId: userId,
      }),
      items,
      updatedAt: nowMs,
    };
    if (permissionAlertCandidate) {
      summary.permissionAlert = {
        title: 'Permission Required',
        body: permissionAlertCandidate.sessionTitle,
      };
    }
    return summary;
  }

  private async syncLiveActivitySummary(
    userId: string,
    options: { permissionAlert?: boolean } = {}
  ): Promise<LiveActivitySummarySyncResult> {
    if (!this.notificationService) {
      return { sent: false, reason: 'notifications_disabled' };
    }

    try {
      const summary = await this.buildLiveActivitySummary(userId, options);
      return await this.notificationService.syncLiveActivitySummary({
        workspaceId: this.workspaceId,
        userId,
        ...summary,
      });
    } catch (error) {
      this.logger.debug(
        `[live-activity] Failed to sync summary for user ${userId}: ${formatErrorMessage(error)}`
      );
      return { sent: false, reason: 'summary_build_failed' };
    }
  }

  /**
   * Process queued messages after a conversation round completes naturally.
   * This is NOT called when the session is cancelled - cancellation means the user
   * wants to pause, so we should not automatically process the next message.
   */
  private async processMessageQueue(sessionId: SessionId): Promise<void> {
    void this.sessionDispatchWatcher.enqueueSessionCheck(sessionId);
  }

  // ============================================================================
  // GC-related public methods
  // ============================================================================

  /**
   * Check if a session has pending ACP updates that haven't been flushed yet.
   */
  hasPendingUpdates(sessionId: SessionId): boolean {
    return this.store.has(sessionId) && this.store.get(sessionId).acpUpdateBuffer.length > 0;
  }

  /**
   * Conservative guard for prompt replay: any buffered or already-flushed ACP
   * update means the adapter may have acted on the user prompt, so execution
   * recovery must stop and surface the failure instead of retrying.
   */
  private hasPromptOutputForTurn(sessionId: SessionId, turnId: string): boolean {
    if (!this.store.has(sessionId)) {
      return false;
    }
    const state = this.store.get(sessionId);
    const hasBufferedOutput = state.acpUpdateBuffer.some((item) => item.target.turnId === turnId);
    const hasFlushedOutput =
      state.acpFlushCountInTurn > 0 && this.store.getTurnId(sessionId) === turnId;
    return hasBufferedOutput || hasFlushedOutput;
  }

  /**
   * Same observation as `hasPromptOutputForTurn`, but it distinguishes "this turn
   * emitted nothing" from "we cannot tell". The two callers need opposite
   * conservative answers on a missing session: prompt replay must refuse to
   * retry, while the no-output guard must not accuse a turn it could not observe.
   * `undefined` means unobservable — the transient state is gone.
   */
  observePromptOutputForTurn(sessionId: SessionId, turnId: string): boolean | undefined {
    if (!this.store.has(sessionId)) {
      return undefined;
    }
    return this.hasPromptOutputForTurn(sessionId, turnId);
  }

  /**
   * Check if a session still has user work pending in metadata.
   * This protects sessions that are waiting for history CRDT sync from being
   * evicted under memory pressure.
   */
  async hasPendingUserWork(sessionId: SessionId): Promise<boolean> {
    const meta = (await this.workspaceDocument.repo.getDocMeta(getSessionRoomId(sessionId)))
      ?.meta as SessionMeta | undefined;
    if (!meta) {
      return false;
    }

    // Same predicate the dispatch watcher uses: a retired activation leaves the
    // pointers unequal on purpose, and a raw comparison would pin the session
    // in memory forever.
    return hasPendingUserTurnActivation(meta);
  }

  /**
   * Persistent active goals may drive a later autonomous ACP cycle even while
   * no prompt is running. They are not a live-presence signal, but evicting the
   * ACP process would discard that resumable session state.
   */
  async hasActiveGoal(sessionId: SessionId): Promise<boolean> {
    const sessionDoc = await this.workspaceDocument.getOrCreateSessionDoc(sessionId);
    const meta = await sessionDoc.getMetaState();
    const legacyMeta = meta as SessionLegacyMetaFields | null | undefined;
    const historyGoal = resolveLatestSessionGoalFromHistory(await sessionDoc.getHistory());
    return isSessionGoalActive(historyGoal ?? legacyMeta?.latestGoal);
  }

  /**
   * Check if a session is currently being archived.
   */
  isArchiveInFlight(sessionId: SessionId): boolean {
    return this.archiveInFlight.has(sessionId);
  }

  /**
   * Get the last activity timestamp for a session.
   */
  getLastActivity(sessionId: SessionId): number | undefined {
    if (!this.store.has(sessionId)) return undefined;
    return this.store.get(sessionId).lastActivityMs;
  }

  getSessionMonitorState(sessionId: SessionId): {
    status: import('@lody/shared').MachineMonitorSessionStatus;
    lastActivityAtMs: number | null;
  } {
    const activeStatus = this.sessionActivePresence.getStatus(sessionId);
    let status: import('@lody/shared').MachineMonitorSessionStatus = 'idle';
    if (activeStatus?.type === 'requestPermission') {
      status = 'waiting_permission';
    } else if (activeStatus?.type === 'initializing') {
      status = 'initializing';
    } else if (activeStatus?.type === 'running') {
      status = 'running';
    } else {
      const turnPhase = this.store.getTurnPhase(sessionId);
      if (turnPhase === 'prompting') status = 'running';
      if (turnPhase === 'finalizing') status = 'finalizing';
    }
    return {
      status,
      lastActivityAtMs: this.getLastActivity(sessionId) ?? null,
    };
  }

  /**
   * Get all session IDs that have activity tracking.
   */
  getTrackedSessionIds(): SessionId[] {
    return this.store.sessionIds();
  }

  /**
   * Check if a session has an active turn (prompting or finalizing).
   */
  hasActiveTurn(sessionId: SessionId): boolean {
    if (!this.store.has(sessionId)) return false;
    const state = this.store.get(sessionId);
    return state.turn.phase !== 'idle' || this.hasSessionActivePresence(sessionId);
  }

  /**
   * Set the memory pressure eviction callback.
   * Called by MachineRuntime after GC manager is initialized.
   */
  setEvictForMemoryPressure(
    fn: (excludeSessionId?: SessionId) => Promise<MemoryPressureEvictionResult>
  ): void {
    this.evictForMemoryPressureFn = fn;
  }

  /**
   * Returns the number of sessions that are actively executing.
   * Uses active presence count rather than turnId count to include sessions
   * still initializing (container/worktree setup) before a turn ID is assigned.
   */
  getActiveTurnCount(): number {
    return this.sessionActivePresence.activeSessionCount();
  }

  private logCodeCollabDebug(message: string): void {
    this.logger.debug(message);
  }

  /**
   * Clean all transient state for a session.
   * Called by GC manager when a session has been idle or evicted under memory pressure.
   */
  async cleanSessionForGC(sessionId: SessionId): Promise<void> {
    this.logger.debug(`[GC] Cleaning session ${sessionId}`);

    // 1. Clear active presence
    this.clearSessionActivePresence(sessionId);

    await this.previewService.closeSessionPreviewForCleanup(sessionId, 'Session cleaned by GC');

    // 2. Terminate session process first — if later steps throw, the process
    //    is already gone and the session stays tracked for retry/cleanup.
    if (this.sessionManager.hasSession(sessionId)) {
      await this.sessionManager.terminateSession(sessionId, true);
    }

    // 3. Clean Loro documents (main memory savings)
    await this.workspaceDocument.cleanSessionDoc(sessionId);

    // 4. Drop transient tracking last — only after all cleanup succeeded,
    //    so getTrackedSessionIds() can still see it for retry if steps above throw.
    this.store.deleteSession(sessionId);

    this.logger.debug(`[GC] Session ${sessionId} cleaned`);
  }
}
