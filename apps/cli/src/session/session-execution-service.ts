import type { EncryptedAgentExecution } from '@/lib/e2ee/agent-execution';
import type { RealtimeStartPermit } from '@/lib/e2ee/realtime-journal';
import { publishTurnCompletionLegacy } from './turn-completion-legacy';
import { resolveProjectFileRoots } from './worktree/project-member-access';
import { type AcpLauncher, resolveAcpLauncher } from '@/agent/acp-analytics';
import type { LodyRateLimitsCapability } from 'acp-extension-core';
import { queryLocalAcpRateLimits, AcpQuotaCleanupError } from '@/agent/acp-runner';
import {
  isSubscriptionQuotaEligible,
  type MachineProviderRateLimitsRefreshResponse,
} from '@lody/shared';
import { ProviderQuotaRefreshCache } from './provider-quota-refresh-cache';
import type { TurnOutcome, TurnOutcomeFact, TurnResultAudience } from '@lody/shared/notifications';
import {
  AcpAuthenticationManager,
  type AcpAuthenticationProgressEvent,
} from '@/agent/acp-authentication';
import { AcpBinaryUnsupportedPlatformError, getAcpBinaryManager } from '@/agent/acp-binary-manager';
import type { FetchAcpCapabilitiesOptions } from '@/agent/acp-capabilities';
import { AcpAuthenticationRequiredError, type SteerOutcomeResult } from '@/agent/agent-client';
import type { GoalPromptControl } from '@/agent/goal-control';
import {
  classifyManagedRuntimeFailureReason,
  formatManagedRuntimeFailureMessage,
  getManagedAgentRuntimeManager,
  type ManagedRuntimeName,
  type ManagedRuntimeProgressEvent,
  ManagedRuntimeUnsupportedPlatformError,
} from '@/agent/managed-agent-runtime';
import { discoverManagedPiExtensions } from '@/agent/pi-extensions';
import { getAcpCapabilitySourceVersion, resolveACPProcessLaunch } from '@/agent/setting';
import { captureCli } from '@/lib/analytics/posthog';
import { ConcurrentQueue } from '@/lib/concurrent-queue';
import {
  captureGitWorkingTreeDiffBaseline,
  getCurrentCommitHash,
  type GitRunner,
  type GitWorkingTreeDiffBaseline,
} from '@/lib/git/git-diff-stats';
import {
  resolveWorkspaceLocalProjectRootPathWithRetry,
  readLocalProjectRootResolveSyncTimeoutMs,
} from '@/lib/local-project-meta';
import type { LoroDocumentManager, SessionDocument } from '@/lib/loro/doc';
import { subscribeSessionChanges } from '@/lib/loro/doc';
import type {
  SessionActivePresenceLease,
  SessionActivePresencePhase,
  SessionInitializationStall,
} from '@/lib/loro/session-active-presence';
import { SYNC_CONFIRMATION_TIMEOUT_MS, withTimeout } from '@/lib/loro/timeout-utils';
import type { MemoryPressureEvictionResult } from '@/lib/session-gc-manager';
import type { OperationInboxLegacy } from '@/orchestration/inbox/legacy';
import {
  blockedInboxRecoveryMessage,
  InboxExecutionBlocked,
  InboxExecutionRejected,
} from '@/orchestration/inbox/admission-failure';
import {
  batchHistoryMembers,
  batchPreview,
  type InboxBatch,
  type InboxInput,
  type InboxScope,
} from '@/orchestration/inbox/model';
import { sessionExecutionResource } from '@/orchestration/platform/session-resources';
import { formatErrorMessage, formatReportedError } from '@/utils/format-error';
import {
  describeSessionStartFailure,
  hadIncompleteStartCleanup,
  isTransientSessionStartError,
  jitterSessionStartRetryDelay,
  SESSION_START_RETRY_DELAYS_MS,
  sessionStartRetryMode,
  takeSessionStartRetry,
  type SessionStartStage,
} from './session-start-stage';
import type { Logger } from '@/utils/logger';
import { startTraceSpan, traceAsync } from '@/utils/trace-span';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { ModelInfo } from '@lody/shared';
import {
  type AcpCapabilityCacheEntry,
  type AcpCommandSummary,
  type AcpConfigOptionSummary,
  type AcpConfigOptionValue,
  type AcpModelControls,
  acpOwnsSessionTitleGeneration,
  type ACPSessionId,
  type AgentConfigCliType,
  type AgentConfigId,
  type AgentConfigMeta,
  assertManagedCodexProfileConfig,
  buildReplayPromptFromHistory,
  type BuiltinRuntimeOverrides,
  type ChatFailedCode,
  type ChatFailedReason,
  type CustomAcpLaunchSpec,
  decideAcpCapabilityRefreshCache,
  getManagedBuiltinRuntimeByAgentType,
  getManagedBuiltinRuntimeByRuntimeName,
  getServerNow,
  getSessionRoomId,
  hasBuiltinRuntimeOverrideValues,
  hasRecentResumeNotice,
  isSessionCollaborationStopped,
  type IssuePRMention,
  type LocalProjectId,
  type MachineAcpAuthenticateRequestValidated,
  type MachineAcpAuthenticateResponse,
  type MachineAcpAuthenticationProgressMessage,
  type MachineAcpAuthMethodSummary,
  type MachineAcpBinaryInstallRequestValidated,
  type MachineAcpBinaryInstallResponse,
  type MachineAcpBinaryProgressMessage,
  type MachineAcpBinaryStatusRequestValidated,
  type MachineAcpBinaryStatusResponse,
  type MachineAcpCapabilitiesRefreshRequestValidated,
  type MachineAcpCapabilitiesRefreshResponse,
  type MachineId,
  type MachineLifecycleCapability,
  type MachinePiExtensionsResponse,
  type MachinePingRequestValidated,
  type MachinePingResponse,
  type MachineResourceInfo,
  type MachineStatusRequestValidated,
  type MachineStatusResponse,
  type ProjectRef,
  REGISTRY_ACP_AGENTS,
  type RegistryAcpAgent,
  type ReplayPromptResult,
  resolveActiveAssistantTurnId,
  resolveBaseBranchPreference,
  resolveProjectGitHubRepo,
  resolveSessionAuthoredText,
  resolveSessionExecutionInputBlocks,
  serializeCustomAcpLaunchSpec,
  SessionCancelRequestValidated,
  SessionChatRequestValidated,
  SessionCreateRequestValidated,
  type SessionGoalAction,
  type SessionGoalResponse,
  SessionHistoryInput,
  type SessionId,
  type SessionInputBlock,
  type SessionMeta,
  SessionStatusFactory,
  type SessionSteerOperationRecord,
  type SessionSteerResponse,
  type SessionTurnInputConfig,
  type WorkspaceId,
} from '@lody/shared';
import {
  createLocalProjectBranchSelector,
  localProjectsLegacy,
} from '@lody/shared/node/local-project';
import { findProgressMessageId } from '@lody/shared/session-data';
import { Cause, Clock, Data, Effect, Exit, Fiber, Option, Random, Scope } from 'effect';
import { createHash, randomUUID } from 'node:crypto';
import { getCodexProfileStore, type ResolvedCodexProfile } from '../agent/codex-profile-store';
import {
  getACPErrorUserMessage,
  isAgentDisconnectedError,
  isAuthenticationRequiredACPError,
  mapACPErrorToFailureReason,
  parseACPError,
  shouldRecoverStaleACPConnectionPrompt,
  shouldTerminateOnACPError,
} from './acp-error-classification';
import type { MachineAccessVerification } from './session-access-retry';
import { createSessionBackend, getSteerOperationId, type SessionBackend } from './session-backend';
import {
  findLastHistoryEntry,
  isActivationAwaitingHistory,
  resolveDispatchAcpSessionId,
  resolveResumableAcpSessionId,
} from './session-dispatch-logic';
import { buildPrompt } from './session-execution-helpers';
import { resolveSessionLaunchConfig } from './session-launch-config-resolver';
import type { ISession, SessionManager } from './session-manager';
import type { SessionConfig } from './types';
import { isAllocatedSessionBranchName } from './worktree/branch-name-allocation';
import {
  GIT_EXECUTABLE_NOT_FOUND_CODE,
  isGitExecutableNotFoundError,
} from './worktree/git-process-error';

type FinalizeTurnContext = {
  sessionId: SessionId;
  session: ISession;
  sessionDoc: SessionDocument;
  turnId: string;
  baseCommitHash: string | null;
  turnStartWorkingTreeDiff?: GitWorkingTreeDiffBaseline | null;
  project?: ProjectRef;
  isTurnCancelled?: () => boolean;
  abortSignal?: AbortSignal;
  /**
   * False when the prompt returned without the agent ever emitting output. The
   * turn is still finalized (diff stats, dirty-worktree probe, and PR detection
   * all stay correct), but it must not be announced as a completed answer.
   */
  producedOutput?: boolean;
};

const TURN_FINALIZATION_STAGE_WARN_MS = 5_000;
/** Trailing history rows searched for the last assistant turn and its user input. */
const DEAD_TURN_SCAN_ROWS = 64;
/** Log, never fail, a yielded turn's finalization that is still running at release. */
const YIELDED_FINALIZATION_SLOW_WARNING = '5 seconds';
// Renderer, local IPC, and Machine RPC wait at most 300s for the complete
// authentication workflow. Keep the post-login capability proof inside that
// envelope and leave a small delivery margin for the final response.
const ACP_AUTHENTICATION_WORKFLOW_DEADLINE_MS = 295_000;
const ACP_POST_AUTH_REFRESH_MAX_MS = 60_000;

/**
 * How long a fallback restore waits for the history CRDT to carry the prior
 * conversation before it gives up on replaying it. Long enough to cover a room
 * re-join after a daemon restart, short enough that a genuinely broken uplink
 * fails the turn instead of holding the user's message.
 */
const REPLAYABLE_HISTORY_SYNC_TIMEOUT_MS = SYNC_CONFIRMATION_TIMEOUT_MS;

/**
 * Shown when the agent's own session could not be resumed AND this machine has
 * no conversation history to rebuild the context from. Starting a fresh agent
 * anyway would silently answer as if the conversation never happened, so the
 * turn is failed instead and the user keeps their message.
 */
const CONTEXT_FREE_RESTORE_MESSAGE =
  'The agent session could not be resumed, and this machine has not synced the earlier ' +
  'conversation yet, so there was nothing to restore the context from. The turn was not ' +
  'started — retry once the session finishes syncing so the agent keeps its history.';

/**
 * Shown in chat when a turn ends with no agent output at all. It names the most
 * common upstream cause without asserting it, because the adapter discarded the
 * real error before we could classify it.
 */
const SILENT_TURN_FAILURE_MESSAGE =
  'The agent ended the turn without producing any output. The model call most likely failed ' +
  'upstream (a context-length or rate-limit rejection is the usual cause) and the agent ' +
  'reported it as a normal completion instead of an error. Retry your message, or start a ' +
  'new session if this conversation has grown too long.';

type TurnFinalizationEffects = {
  finalizeACPState: (sessionId: SessionId, turnId?: string) => Promise<void>;
  persistCodeCollabTurnDiffs?: (sessionId: SessionId, turnId: string) => Promise<boolean>;
  flushSessionUsage: (sessionId: SessionId) => Promise<void>;
  updateSessionDiffStats: (
    sessionId: SessionId,
    session: ISession,
    options: {
      turnId: string;
      baseCommitHash?: string;
      turnStartWorkingTreeDiff?: GitWorkingTreeDiffBaseline | null;
      preferredBaseBranch?: string;
      skipHistoryFileDiff?: boolean;
    }
  ) => Promise<SessionHistoryInput['fileDiff']>;
  detectAndAssociatePR: (ctx: {
    sessionId: SessionId;
    session: ISession;
    sessionDoc: SessionDocument;
    project?: ProjectRef;
    branchName?: string | null;
  }) => Promise<{ readonly baseBranch: string } | null>;
  /** Publish the workspace dirty/unpushed flags alone, for paths that skip diff stats. */
  syncWorkspaceGitState: (sessionId: SessionId, session: ISession) => Promise<void>;
  refreshCodeCollabSharedState?: (sessionId: SessionId) => Promise<void>;
  onTurnOutcome?: (fact: TurnOutcomeFact) => Promise<void>;
};

type ApplyModeAndModelConfig = SessionTurnInputConfig & {
  configOptionValues?: Record<string, AcpConfigOptionValue>;
};

type PromptHandoffRun = {
  turnId: string;
  promptOutcome: Promise<{ status: 'fulfilled' } | { status: 'rejected'; error: unknown }>;
  successor?: PromptHandoffRun;
  successorReady: Promise<void>;
  signalSuccessor: () => void;
};

class SteerWaitEnded extends Error {}

/** Cancels only the local wait; the caller retains ownership of any submitted work. */
async function waitForSteer<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new SteerWaitEnded('The target turn is no longer accepting steer'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

type SessionGoalTurnRequest = {
  sessionId: SessionId;
  control: GoalPromptControl;
  userId: string;
  userName: string;
  userEmail: string;
};

type TurnInvocation = {
  /** Causal input Turn for authorization and durable provenance. */
  sourceTurnId: string;
  requesterUserId?: string;
  inputConfig: SessionTurnInputConfig;
  notificationAudience?: TurnResultAudience;
};

type TurnRuntimeState = {
  sessionId: SessionId;
  /** Logical chain tail exposed to Web, cancel, and optimistic steer validation. */
  turnId: string;
  userTurnId?: string;
  invocation?: TurnInvocation;
  inboxNotificationWork?: { userId: string; originTurnIds: string[] };
  goalControl?: GoalPromptControl;
  session?: ISession;
  project?: ProjectRef;
  baseCommitHash?: string | null;
  turnStartWorkingTreeDiff?: GitWorkingTreeDiffBaseline | null;
  promptStarted: boolean;
  promptInFlight: boolean;
  promptFailed: boolean;
  finalizeStarted: boolean;
  finalizeCompleted: boolean;
  notificationOutcome?: TurnOutcome;
  /** Publish-once latch for the workspace git-state flags; both cancel routes read it. */
  workspaceGitStateSynced: boolean;
  prePromptFailureRecorded: boolean;
  /** Start step in progress; cleared once a Session is bound, so later failures name none. */
  startStage?: SessionStartStage;
  cancelRequested: boolean;
  pendingInputOnCancel: PendingInputCancellationPolicy;
  releaseFailure?: unknown;
  rawPromptCompletion?: Promise<void>;
  disconnectedTransport?: boolean;
  inboxOwner?: Awaited<ReturnType<OperationInboxLegacy['openExecution']>>;
  /** Withdraw rather than release the unsubmitted Inbox execution at turn end. */
  withdrawInboxExecution?: boolean;
  cancelFinalized: boolean;
  /** One drain deadline shared by Stop and the cancellation finalizer. */
  cancellationDrain?: Promise<void>;
  steerWaitController?: AbortController;
  /** Submitted handoff steer whose verdict may trail the yielded prompt's answer. */
  pendingHandoffSteerOutcome?: Promise<SteerOutcomeResult>;
  pendingSteerConfig?: Set<Promise<void>>;
  interruptRequested: boolean;
  terminateSessionOnCancel: boolean;
  /** Logical prompt tail currently owned by the one session-owner fiber. */
  activePromptRun?: PromptHandoffRun;
  /** Serialized ancillary finalization for yielded logical turns. */
  yieldedFinalization: Promise<void>;
  pendingSession?: Promise<ISession>;
  /**
   * Latched when the initialization stall watchdog halted this turn. The halt is
   * a FAILURE, not a cancellation, so the scope finalizer takes
   * `finalizeStalledInitializationEffect` instead of
   * `finalizeCancelledTurnEffect` — the race interrupts the losing body fiber,
   * which would otherwise read as a user cancellation.
   */
  initializationStalled: boolean;
  fiber?: Fiber.Fiber<unknown, unknown>;
};

export type PendingInputCancellationPolicy = 'promote' | 'preserve';

export type SessionExecutionSnapshot = {
  /** Assistant turn currently owned by this service, if any. */
  activeTurnId?: string;
  /** True only while a turn runtime is registered and still owns cleanup. */
  hasActiveTurn: boolean;
  /**
   * True when the active turn is waiting for session creation/restoration.
   * Stale SessionManager pending promises without a registered turn must not
   * block dispatch of newer messages after cancellation.
   */
  hasBlockingPendingCreate: boolean;
  /** True when an existing ACP/session resource can be reused by a follow-up turn. */
  hasReusableSession: boolean;
  /** True while edit-and-resend owns the durable history tail. */
  hasRewriteBarrier: boolean;
  /**
   * Set when the active turn ended but could not confirm releasing its execution
   * resources (in-flight ACP requests, the Inbox execution record). Successors
   * stay blocked, since an unconfirmed release may still be running, until
   * `requestReleaseRecovery` proves release. This is not "the agent process
   * should have exited": a normally released turn keeps its process for reuse.
   */
  releaseBlocked?: { reason: string };
};

const describeReleaseFailure = (failure: unknown): string =>
  Cause.isCause(failure)
    ? (Cause.pretty(failure).split('\n')[0] ?? 'Unknown release failure')
    : formatErrorMessage(failure);

type TurnCancellationFinalizerOptions = {
  sessionId: SessionId;
  sessionDoc: SessionDocument;
  turnId: string;
  userTurnId?: string;
  session?: ISession | null;
  pendingSession?: Promise<ISession>;
  terminateSession?: boolean;
  reportTurnError?: boolean;
};

type VisibleSessionTurnContext = {
  turnId: string;
  runtime: TurnRuntimeState;
  setUnhandledErrorContext: (context: VisibleSessionTurnUnhandledErrorContext) => void;
  bindSession: (session: ISession) => void;
  trackPendingSession: (
    pendingSession: Promise<ISession> | (() => Promise<ISession>),
    options?: { terminateOnCancel?: boolean }
  ) => Effect.Effect<ISession, unknown, never>;
  abortIfCancelled: (options?: {
    terminateSession?: boolean;
  }) => Effect.Effect<void, unknown, never>;
  openAssistantEntry: (options?: {
    analytics?: VisibleSessionTurnAnalytics;
    unhandledErrorContext?: VisibleSessionTurnUnhandledErrorContext;
  }) => Effect.Effect<void, unknown, never>;
  prompt: (promptBlocks: ContentBlock[]) => Effect.Effect<void, unknown, never>;
  claimExecution: () => Effect.Effect<void, unknown, never>;
};

type VisibleSessionTurnAnalytics = {
  dispatchMode: 'start' | 'continue';
  inputBlockCount: number;
  cliType?: AgentConfigCliType;
  agentType?: string;
  dispatchSource?: SessionDispatchSource;
};

type VisibleSessionTurnUnhandledErrorContext = {
  code: string;
  describe: (error: unknown) => string;
  onUnhandledError?: (error: unknown) => Promise<void>;
};

type VisibleSessionTurnOptions = {
  inboxBatch?: InboxBatch;
  sessionId: SessionId;
  sessionDoc: SessionDocument;
  session?: ISession;
  userTurnId?: string;
  invocation?: TurnInvocation;
  /**
   * Turn that deterministically owns the assistant history entry. Inbox
   * uses its system Turn here while leaving userTurnId absent so it cannot
   * mutate user dispatch status or pointers.
   */
  assistantEntryParentTurnId?: string;
  /** Goal action this turn runs; the agent receives it as prompt metadata. */
  goalControl?: GoalPromptControl;
  onTurnStarted?: () => Promise<boolean>;
  /**
   * How the turn payload reached this machine. 'rpc' turns can start before the
   * user's history entry syncs locally, so their turn-scoped history writes go
   * through a TurnHistoryGate (created in beginConversationTurn).
   */
  dispatchSource?: SessionDispatchSource;
  unhandledErrorCode: string;
  describeUnhandledError: (error: unknown) => string;
  onUnhandledError?: (error: unknown) => Promise<void>;
};

type VisibleSessionTurnPlan = {
  options: VisibleSessionTurnOptions;
  body: (ctx: VisibleSessionTurnContext) => Effect.Effect<void, unknown, Scope.Scope>;
};

/** How the turn payload reached this machine (RPC fast path vs CRDT history vs queue promotion). */
export type SessionDispatchSource = 'rpc' | 'crdt' | 'queue' | 'inbox' | 'goal';

type SessionDispatchOptions = {
  inboxBatch?: InboxBatch;
  notificationAudience?: TurnResultAudience;
  dispatchSource?: SessionDispatchSource;
  /** Goal action this turn exists to run; travels to the agent as prompt metadata. */
  goalControl?: GoalPromptControl;
  /**
   * Runs only after this process has synchronously claimed the per-Session
   * visible-turn owner. Goal uses this to append its system cause without
   * racing a user dispatch between the idle check and the history write. False
   * means an external durable claim lost contention; the turn is released
   * without history, ACP, failure, or settlement side effects.
   */
  onTurnClaimed?: () => Promise<boolean>;
  /** Runs immediately before the request can cross into the ACP provider. */
  onTurnStarted?: () => Promise<boolean>;
};

export type PreparedSessionDispatchRequest =
  | { mode: 'create'; request: SessionCreateRequestValidated }
  | { mode: 'continue'; request: SessionChatRequestValidated };

export type PreparedSessionDispatchOptions = {
  sessionId: SessionId;
  sessionDoc: SessionDocument;
  userTurnId: string;
  invocation: TurnInvocation;
  dispatchSource: SessionDispatchSource;
  accessPromise: Promise<MachineAccessVerification>;
  requestPromise: Promise<PreparedSessionDispatchRequest>;
  onExecutionDeferred?: () => void | Promise<void>;
  onAccessAllowed: () => void | Promise<void>;
  onAccessDenied: (
    reason: MachineAccessVerification & { outcome: 'denied' }
  ) => void | Promise<void>;
  onAccessIndeterminate: (
    result: MachineAccessVerification & { outcome: 'indeterminate' }
  ) => void | Promise<void>;
};

class SessionTurnCancelled extends Data.TaggedError('SessionTurnCancelled')<{
  sessionId: SessionId;
  turnId: string;
}> {}

/**
 * User-visible copy for a turn stopped by the initialization stall watchdog.
 * Names the stage that went silent and how long it was given, so the message is
 * actionable rather than a bare "initialization failed".
 */
const formatInitializationStallMessage = (stall: SessionInitializationStall): string => {
  const seconds = (ms: number) => Math.round(ms / 1000);
  return (
    `Session initialization stopped making progress while ${stall.description}: ` +
    `no change for ${seconds(stall.stalledMs)}s (limit ${seconds(stall.budgetMs)}s). ` +
    'The turn was stopped instead of waiting indefinitely; send it again to retry.'
  );
};

class SessionTurnHalted extends Data.TaggedError('SessionTurnHalted')<{
  sessionId: SessionId;
  reason: ChatFailedReason;
}> {}

class SessionTurnExecutionDeferred extends Data.TaggedError('SessionTurnExecutionDeferred')<{}> {}

class SessionTurnClaimContended extends Data.TaggedError('SessionTurnClaimContended')<{
  sessionId: SessionId;
  turnId: string;
}> {}

class SessionTurnStartFenceFailed extends Data.TaggedError('SessionTurnStartFenceFailed')<{
  sessionId: SessionId;
  turnId: string;
  cause: unknown;
}> {}

const isSessionTurnCancelled = (error: unknown): error is SessionTurnCancelled => {
  return (
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    error._tag === 'SessionTurnCancelled'
  );
};

const isSessionTurnHalted = (error: unknown): error is SessionTurnHalted => {
  return (
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    error._tag === 'SessionTurnHalted'
  );
};

const isSessionTurnClaimContended = (error: unknown): error is SessionTurnClaimContended => {
  return (
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    error._tag === 'SessionTurnClaimContended'
  );
};

const isSessionTurnStartFenceFailed = (error: unknown): error is SessionTurnStartFenceFailed => {
  return (
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    error._tag === 'SessionTurnStartFenceFailed'
  );
};

function truncateAnalyticsString(value: string, maxLength = 1_000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export type SessionExecutionServiceDeps = {
  /** Only encrypted workspace composition installs this shared execution gate. */
  encryptedExecution?: EncryptedAgentExecution;
  encryptedWorkspace?: boolean;
  logger: Logger;
  sessionManager: SessionManager;
  workspaceDocument: LoroDocumentManager;
  machineId: MachineId;
  userId: string;
  workspaceId: WorkspaceId;
  preferredBaseBranch: string;
  touchSession: (sessionId: SessionId) => void;
  holdSessionActivePresence: (
    sessionId: SessionId,
    phase?: SessionActivePresencePhase | null
  ) => Effect.Effect<SessionActivePresenceLease, unknown, Scope.Scope>;
  clearSessionActivePresence: (sessionId: SessionId) => void;
  setSessionActivePresencePhase: (
    sessionId: SessionId,
    phase: SessionActivePresencePhase | null,
    detail?: string
  ) => void;
  beginACPReplaySuppression: (sessionId: SessionId) => void;
  endACPReplaySuppression: (sessionId: SessionId) => void;
  beginConversationTurn: (
    sessionId: SessionId,
    userTurnId?: string,
    gateContext?: {
      dispatchSource?: SessionDispatchSource;
      sessionDoc: SessionDocument;
      deferACPUpdateTarget?: boolean;
    }
  ) => string;
  activateConversationTurnForACPUpdates: (sessionId: SessionId, turnId: string) => void;
  clearConversationTurn: (sessionId: SessionId, turnId: string) => void;
  getActiveTurnId: (sessionId: SessionId) => string | undefined;
  clearActiveTurnId: (sessionId: SessionId, turnId: string) => void;
  buildAcpPromptBlocks: (args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    inputBlocks: SessionInputBlock[];
    issuePRMentions?: IssuePRMention[];
    replayPromptText?: string;
  }) => Promise<ContentBlock[]>;
  applyAcpModeAndModel: (
    session: {
      sessionId: SessionId;
      acpSessionId: ACPSessionId | null;
      agentClient: unknown;
    },
    config: ApplyModeAndModelConfig,
    context: {
      sessionDoc: SessionDocument;
      basedOnUserTurnId?: string;
      signal?: AbortSignal;
    }
  ) => Promise<void>;
  createAssistantEntryForTurn: (
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    turnId: string,
    modelInfo: ModelInfo | undefined,
    userTurnId?: string
  ) => Promise<void>;
  syncSessionBranchName: (sessionId: SessionId, session: ISession) => Promise<string | null>;
  turnFinalization: TurnFinalizationEffects;
  recordChatFailure: (
    sessionDoc: SessionDocument,
    reason: ChatFailedReason,
    message?: string,
    code?: ChatFailedCode
  ) => Promise<void>;
  maybeGenerateAndStoreSessionTitle: (
    sessionId: SessionId,
    cliType: AgentConfigCliType,
    agentType: string,
    prompt: string,
    env?: Record<string, string>,
    customAcp?: CustomAcpLaunchSpec,
    runtimeOverrides?: BuiltinRuntimeOverrides
  ) => Promise<void>;
  processMessageQueue: (sessionId: SessionId) => Promise<void>;
  syncLiveActivitySummary?: (userId: string) => Promise<void>;
  collectMachineResources: () => Promise<MachineResourceInfo>;
  getMachineLifecycleCapability: () => MachineLifecycleCapability;
  /**
   * Returns true once any ACP or image lifecycle event belongs to the current
   * assistant turn. Prompt recovery must not replay the same user turn after
   * any event, because the adapter may already have acted on it. Missing state
   * must also refuse replay.
   */
  hasPromptEventsForTurn?: (sessionId: SessionId, turnId: string) => boolean;
  /**
   * Whether the turn emitted content, independently of replay safety. Metadata,
   * usage, checklist plans and lifecycle status do not establish a reply.
   * Drain pending image uploads before reading; successful image writes are content.
   * `undefined` means the turn is unobservable; the no-output guard fails open.
   */
  observePromptContentForTurn?: (
    sessionId: SessionId,
    turnId: string
  ) => boolean | undefined | Promise<boolean | undefined>;
  fetchAcpCapabilities: (
    cliType: AgentConfigCliType,
    agentType: string,
    env?: Record<string, string>,
    customAcp?: CustomAcpLaunchSpec,
    runtimeOverrides?: BuiltinRuntimeOverrides,
    options?: FetchAcpCapabilitiesOptions
  ) => Promise<{
    modes: NonNullable<MachineAcpCapabilitiesRefreshResponse['modes']>;
    models: NonNullable<MachineAcpCapabilitiesRefreshResponse['models']>;
    configOptions?: AcpConfigOptionSummary[];
    availableCommands?: AcpCommandSummary[];
    sessionFork: boolean;
    acknowledgedSteer: boolean;
    sessionTitle?: boolean;
    rateLimits?: LodyRateLimitsCapability;
    goalActions?: SessionGoalAction[];
    modelReasoningEfforts?: Record<string, string[]>;
    modelCapabilities?: Record<string, AcpModelControls>;
    capabilitySourceVersion?: string;
  }>;
  /**
   * The `capabilitySourceVersion` a probe would stamp right now, resolved without
   * starting an agent. `undefined` when it cannot be known without that work, in
   * which case the persisted entry is never reused.
   */
  resolveAcpCapabilitySourceVersion: (input: {
    cliType: AgentConfigCliType;
    agentType: string;
    customAcp?: CustomAcpLaunchSpec;
    runtimeOverrides?: BuiltinRuntimeOverrides;
    magpieGatewayUrl?: string;
    env?: Record<string, string>;
  }) => Promise<string | undefined>;
  /** Evict idle sessions if system memory is under pressure */
  evictForMemoryPressure: (excludeSessionId?: SessionId) => Promise<MemoryPressureEvictionResult>;
};

const shouldRedactEnvKey = (key: string): boolean => /token|secret|password|passwd|key/i.test(key);

const redactEnvForLog = (env?: Record<string, string>): Record<string, string> | undefined => {
  if (!env) {
    return undefined;
  }

  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = shouldRedactEnvKey(key) ? '***' : value;
  }

  return redacted;
};

const summarizeEnvForLog = (
  env?: Record<string, string>
):
  | {
      count: number;
      keys: string[];
      truncatedKeyCount?: number;
      redactedKeyCount: number;
    }
  | undefined => {
  const redacted = redactEnvForLog(env);
  if (!redacted) {
    return undefined;
  }

  const keys = Object.keys(redacted).sort();
  const previewKeys = keys.slice(0, 20);
  const redactedKeyCount = keys.filter((key) => shouldRedactEnvKey(key)).length;

  return {
    count: keys.length,
    keys: previewKeys,
    redactedKeyCount,
    ...(keys.length > previewKeys.length
      ? { truncatedKeyCount: keys.length - previewKeys.length }
      : {}),
  };
};

type AcpBinaryProgressSink = (message: MachineAcpBinaryProgressMessage) => void;

type AcpBinaryProgressOptions = {
  onAcpBinaryProgress?: AcpBinaryProgressSink;
  signal?: AbortSignal;
};

type InFlightAcpRefreshEntry = {
  consumers: Map<object, AcpBinaryProgressSink | undefined>;
  controller: AbortController;
  promise: Promise<MachineAcpCapabilitiesRefreshResponse>;
  settled: boolean;
};

type InFlightAcpBinaryInstallEntry = {
  consumers: Map<object, AcpBinaryProgressSink | undefined>;
  promise: Promise<MachineAcpBinaryInstallResponse>;
};

function createAcpRefreshAbortError(): DOMException {
  return new DOMException('ACP capability refresh was cancelled', 'AbortError');
}

type AcpAuthenticationOptions = {
  onProgress?: (message: MachineAcpAuthenticationProgressMessage) => void;
};

type ResolvedMachineAcpCapabilitiesRefreshRequest = MachineAcpCapabilitiesRefreshRequestValidated &
  Pick<
    AgentConfigMeta,
    | 'cliType'
    | 'agentType'
    | 'customAcp'
    | 'runtimeOverrides'
    | 'magpieGatewayUrl'
    | 'env'
    | 'codexAuth'
  >;

const summarizeAcpAuthMethod = (method: unknown): MachineAcpAuthMethodSummary => {
  const record =
    typeof method === 'object' && method !== null
      ? (method as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const type =
    record.type === 'terminal' || record.type === 'env_var' ? record.type : ('agent' as const);
  const boundedString = (value: unknown, maxLength: number): string | undefined =>
    typeof value === 'string' ? value.slice(0, maxLength) : undefined;
  const id = boundedString(record.id, 1024);
  const name = boundedString(record.name, 4096);
  const description = boundedString(record.description, 16_384);
  return {
    type,
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(Array.isArray(record.args) && record.args.every((arg) => typeof arg === 'string')
      ? { args: record.args.slice(0, 64).map((arg) => arg.slice(0, 4096)) }
      : {}),
  };
};

const managedRuntimeAgentType = (runtimeName: ManagedRuntimeName): string =>
  getManagedBuiltinRuntimeByRuntimeName(runtimeName)?.agentType ?? runtimeName;

const managedRuntimeProgressStatus = (
  phase: ManagedRuntimeProgressEvent['phase']
): MachineAcpBinaryProgressMessage['status'] => (phase === 'complete' ? 'installed' : phase);

const toManagedRuntimeProgressMessage = (
  machineId: MachineId,
  event: ManagedRuntimeProgressEvent
): MachineAcpBinaryProgressMessage => ({
  type: 'machine/acp-binary-progress',
  machineId,
  agentType: managedRuntimeAgentType(event.runtimeName),
  status: managedRuntimeProgressStatus(event.phase),
  downloadedBytes: event.downloadedBytes,
  totalBytes: event.totalBytes,
  percent: event.percent,
  platformArch: event.platformArch,
  version: event.version,
});

type TurnAnalyticsState = {
  turnId: string;
  startedAtMs: number;
  dispatchMode: 'start' | 'continue';
  hasReplayPrompt: boolean;
};

export class SessionExecutionService {
  private readonly completionPublicationAbort = new AbortController();

  stopCompletionPublication(): void {
    this.completionPublicationAbort.abort();
  }

  private readonly ownedWork = new Set<Promise<unknown>>();
  async drainInboxExecutions(): Promise<void> {
    // Completed executions can enqueue delivery while the first snapshot drains.
    while (this.ownedWork.size) await Promise.allSettled([...this.ownedWork]);
    const failures = [...this.turnRuntimeBySession.values()].flatMap((runtime) =>
      runtime.releaseFailure ? [runtime.releaseFailure] : []
    );
    if (failures.length) throw new AggregateError(failures, 'Execution resources remain owned');
  }
  async recoverUnreleasedInboxExecutions(): Promise<void> {
    for (const runtime of this.turnRuntimeBySession.values())
      if (runtime.releaseFailure) await this.recoverInboxExecution(runtime.sessionId);
  }
  private notificationWork:
    | {
        originsForBatch: (batch: InboxBatch) => string[];
        pendingOrigins: (scope: InboxScope, origins: readonly string[]) => ReadonlySet<string>;
      }
    | undefined;
  private operationInbox: OperationInboxLegacy | undefined;
  private onInboxReleased: ((sessionId: SessionId) => void) | undefined;
  setOperationInbox(
    inbox: OperationInboxLegacy | undefined,
    onReleased?: (sessionId: SessionId) => void,
    notificationWork?: SessionExecutionService['notificationWork']
  ): void {
    this.operationInbox = inbox;
    this.onInboxReleased = onReleased;
    this.notificationWork = notificationWork;
  }
  async acceptInboxHumanInput(args: {
    sessionId: SessionId;
    inputId: string;
    userId: string;
    config: SessionTurnInputConfig;
  }): Promise<void> {
    if (this.operationInbox) {
      const doc = await this.deps.workspaceDocument.getOrCreateSessionDoc(args.sessionId);
      const meta = await doc.getMetaState();
      const read = await (await createSessionBackend(doc)).readTurn(args.inputId);
      if (
        meta?.lastHandledUserMsgId === args.inputId ||
        meta?.lastMissingHistoryUserMsgId === args.inputId ||
        (read.state === 'ready' &&
          (read.turn.role !== 'user' ||
            ['handled', 'failed', 'canceled', 'delivery_unknown'].includes(read.turn.status ?? '')))
      ) {
        await this.abandonInboxInput(args.sessionId, args.inputId);
        return;
      }
    }
    await this.operationInbox?.accept({
      workspaceId: this.deps.workspaceId,
      sessionId: args.sessionId,
      userId: args.userId,
      inputId: args.inputId,
      kind: 'human',
      config: args.config,
    });
    if (this.turnRuntimeBySession.get(args.sessionId)?.releaseFailure) {
      await this.recoverInboxExecution(args.sessionId).catch((cause) =>
        this.deps.logger.warn(`Inbox resources remain unreleased: ${formatErrorMessage(cause)}`)
      );
    }
  }
  async abandonInboxInput(sessionId: SessionId, inputId: string): Promise<void> {
    await this.operationInbox?.abandonInput(this.deps.workspaceId, sessionId, inputId);
  }
  getPreferredInboxHumanInput(sessionId: SessionId): string | undefined {
    return this.operationInbox?.preferredHumanInput(this.deps.workspaceId, sessionId);
  }
  getInboxInputCancellationReason(sessionId: SessionId, inputId: string): 'user_stop' | undefined {
    return this.operationInbox?.inputCancellationReason(this.deps.workspaceId, sessionId, inputId);
  }

  isInboxInputCanceled(sessionId: SessionId, inputId: string): boolean {
    return this.operationInbox?.inputCanceled(this.deps.workspaceId, sessionId, inputId) ?? false;
  }
  quiesceInboxExecutions(): void {
    for (const runtime of this.turnRuntimeBySession.values()) {
      runtime.cancelRequested = true;
      runtime.pendingInputOnCancel = 'preserve';
      runtime.terminateSessionOnCancel = true;
      runtime.steerWaitController?.abort();
      this.markTurnCancelled(runtime.sessionId, runtime.turnId);
      this.requestAgentCancelInBackground(runtime, 'active');
      this.requestTurnInterrupt(runtime);
    }
  }

  private readonly releaseRecoveryBySession = new Map<SessionId, Promise<boolean>>();

  /**
   * Retry proving release for a turn whose release could not be confirmed.
   *
   * Called by the next input that waits on this session (a dispatch check or an
   * Inbox readiness check), so recovery follows the fault clearing without a
   * timer. Single-flight per session; a failed attempt keeps the slot and the
   * next waiting input retries. Resolves true once the slot was released.
   *
   * Recovery may terminate the session's agent process: that is how it proves an
   * unconfirmed release ended. It runs only for a blocked release, never after a
   * normally released turn, whose process is kept for reuse.
   */
  requestReleaseRecovery(sessionId: SessionId): Promise<boolean> {
    const inFlight = this.releaseRecoveryBySession.get(sessionId);
    if (inFlight) return inFlight;
    if (this.turnRuntimeBySession.get(sessionId)?.releaseFailure === undefined) {
      return Promise.resolve(false);
    }
    const recovery = this.recoverInboxExecution(sessionId)
      .then(() => this.turnRuntimeBySession.get(sessionId)?.releaseFailure === undefined)
      .catch((cause: unknown) => {
        this.deps.logger.warn(
          `[${sessionId}] Turn resources remain unreleased; the next waiting input retries: ${formatErrorMessage(cause)}`
        );
        return false;
      })
      .finally(() => {
        this.releaseRecoveryBySession.delete(sessionId);
      });
    this.releaseRecoveryBySession.set(sessionId, recovery);
    return recovery;
  }

  async recoverInboxExecution(sessionId: SessionId): Promise<void> {
    const runtime = this.turnRuntimeBySession.get(sessionId);
    if (!runtime?.releaseFailure) return;
    if (runtime.inboxOwner) {
      await runtime.inboxOwner.recover(
        async () => {
          const session = runtime.pendingSession
            ? await withTimeout(
                runtime.pendingSession,
                5_000,
                'Execution acquisition remains owned'
              )
            : runtime.session;
          if (session) runtime.inboxOwner!.retain(sessionExecutionResource(session));
        },
        () =>
          withTimeout(
            Promise.allSettled([
              runtime.yieldedFinalization,
              ...(runtime.pendingSteerConfig ?? []),
            ]).then(() => undefined),
            5_000,
            'Execution finalization remains owned'
          )
      );
    } else if (runtime.session) await runtime.session.terminate(true);
    runtime.releaseFailure = undefined;
    this.releaseTurnRuntime(sessionId, runtime.turnId);
    await this.operationInbox?.wake();
    this.onInboxReleased?.(sessionId);
  }

  private readonly canceledTurnBySession = new Map<SessionId, string>();
  private readonly currentTurnBySession = new Map<SessionId, string>();
  private readonly turnRuntimeBySession = new Map<SessionId, TurnRuntimeState>();
  /** Start times of recent start retries, shared by every Session this service runs. */
  private readonly startRetryStartedAt: number[] = [];
  private readonly rewriteBarrierSessions = new Set<SessionId>();
  private readonly rewriteConflictLeaseSessions = new Set<SessionId>();
  private readonly turnReleaseWaiters = new Map<SessionId, Map<string, Set<() => void>>>();
  /** At most one goal action waits per session; a newer action replaces it. */
  private readonly pendingGoalTurnBySession = new Map<SessionId, SessionGoalTurnRequest>();
  private readonly goalTurnWaiterSessions = new Set<SessionId>();
  // Serializes ownership mutations per session so prompt completion and steer
  // application never race the boundary. No global concurrency cap (Infinity):
  // this is pure per-session serialization, matching the old hand-rolled lock.
  private readonly steerMutationQueue = new ConcurrentQueue<SessionId>(Number.POSITIVE_INFINITY);
  private readonly steerStatusQueue = new ConcurrentQueue<SessionId>(Number.POSITIVE_INFINITY);
  // Analytics-only state (spec §5b). Tracks per-turn timing + the last status
  // we reported so status_changed can carry from→to + dwell time. Never read by
  // product logic; kept here so capture stays side-effect-only.
  private readonly turnAnalyticsBySession = new Map<SessionId, TurnAnalyticsState>();
  private readonly lastStatusBySession = new Map<
    SessionId,
    { status: string; stage?: string; atMs: number }
  >();
  // Dedupes concurrent ACP capability refreshes for the same config and launch
  // inputs. Refreshes spawn
  // a fresh CLI subprocess and wait a few seconds; running it twice in parallel
  // doubles process cost and races the final `updateAcpCapabilities` write.
  private readonly providerQuotaRefresh = new ProviderQuotaRefreshCache(
    Date.now,
    (error) => !(error instanceof AcpQuotaCleanupError)
  );
  private readonly providerQuotaUpdates = new Map<AgentConfigId, number>();

  noteProviderRateLimitsUpdate(configId: AgentConfigId): void {
    this.providerQuotaUpdates.set(configId, (this.providerQuotaUpdates.get(configId) ?? 0) + 1);
  }

  async refreshProviderRateLimits(
    configId: AgentConfigId
  ): Promise<MachineProviderRateLimitsRefreshResponse> {
    const response = {
      type: 'machine/provider-rate-limits-refresh_response' as const,
      machineId: this.deps.machineId,
      configId,
      success: false,
    };
    const config = await this.deps.workspaceDocument.getAgentConfigForMachineLaunch(
      configId,
      this.deps.machineId
    );
    if (!config) return response;
    if (!isSubscriptionQuotaEligible(config)) return response;
    const capability = await this.deps.workspaceDocument.getAcpCapabilities(
      this.deps.machineId,
      configId
    );
    if (capability?.rateLimits?.query !== true) return response;
    const fingerprint = JSON.stringify(config);
    response.success = await this.providerQuotaRefresh.run(configId, fingerprint, async () => {
      const revision = this.providerQuotaUpdates.get(configId) ?? 0;
      const signal = AbortSignal.timeout(45_000);
      let codexProfile: ResolvedCodexProfile | undefined;
      if (config.codexAuth) {
        // API-key profiles do not have a subscription quota.
        codexProfile = await getCodexProfileStore().resolve(this.deps.workspaceId, config, true);
        if (
          !codexProfile ||
          codexProfile.profile.mode !== 'chatgpt' ||
          !(await getCodexProfileStore().isReady(codexProfile))
        )
          return false;
      }
      if (config.cliType === 'builtin' && !config.runtimeOverrides) {
        const status = await this.getMachineAcpBinaryStatus({
          type: 'machine/acp-binary-status',
          machineId: this.deps.machineId,
          workspaceId: this.deps.workspaceId,
          agentType: config.agentType,
        });
        if (status.success && status.status !== 'installed') return false;
      }
      const snapshot = await queryLocalAcpRateLimits({
        cliType: config.cliType,
        agentType: config.agentType,
        customAcp: config.customAcp,
        runtimeOverrides: config.runtimeOverrides,
        agentConfigId: config.id,
        magpieGatewayUrl: config.magpieGatewayUrl,
        codexProfile: codexProfile ? { profile: codexProfile } : undefined,
        env: { ...process.env, ...config.env },
        workdir: process.cwd(),
        signal,
        logger: this.deps.logger,
        terminalEnabled: false,
        terminalManager: {
          createTerminal: async () => {
            throw new Error('Quota query is read-only');
          },
          terminalOutput: async () => {
            throw new Error('Quota query is read-only');
          },
          releaseTerminal: async () => {},
          waitForTerminalExit: async () => ({ exitCode: null, signal: null }),
          killTerminal: async () => {},
        },
        onUpdateMessage: () => {},
        onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      });
      signal.throwIfAborted();
      // v1 adapters conflate failed reads with empty snapshots. Never clear or mark fresh.
      if (snapshot.rateLimits.length === 0) return false;
      const latest = await this.deps.workspaceDocument.getAgentConfigForMachineLaunch(
        configId,
        this.deps.machineId
      );
      if (!latest || JSON.stringify(latest) !== fingerprint) return false;
      const unchanged = () =>
        (this.providerQuotaUpdates.get(configId) ?? 0) === revision && !signal.aborted;
      for (const limit of snapshot.rateLimits) {
        await this.deps.workspaceDocument.updateRateLimits(
          this.deps.machineId,
          configId,
          config.agentType,
          limit,
          unchanged,
          config
        );
      }
      return unchanged();
    });
    return response;
  }

  private readonly inFlightAcpRefresh = new Map<string, InFlightAcpRefreshEntry>();
  /**
   * Fingerprint of the launch inputs — env included — behind each capability
   * entry this process wrote. Memory only, on purpose: the entry itself lives in
   * the Machine Flock document, which syncs to the cloud, and even a hash of a
   * token is a credential derivative a low-entropy token can be recovered from.
   * An empty map after restart just means each config probes once.
   */
  private readonly acpCapabilityLaunchInputFingerprints = new Map<AgentConfigId, string>();

  // Coalesce concurrent install requests for the same agent so the user clicking
  // "download" twice (or a refresh racing an install) triggers a single download.
  private readonly inFlightAcpBinaryInstall = new Map<string, InFlightAcpBinaryInstallEntry>();
  private readonly acpAuthenticationManager: AcpAuthenticationManager;

  constructor(private readonly deps: SessionExecutionServiceDeps) {
    this.acpAuthenticationManager = new AcpAuthenticationManager(deps.logger);
  }

  private createPromptHandoffRun(options: {
    turnId: string;
    promptPromise: Promise<unknown>;
  }): PromptHandoffRun {
    let signalSuccessor!: () => void;
    const successorReady = new Promise<void>((resolve) => {
      signalSuccessor = resolve;
    });
    return {
      turnId: options.turnId,
      promptOutcome: options.promptPromise.then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error })
      ),
      successorReady,
      signalSuccessor,
    };
  }

  private async awaitPromptHandoffTail(
    runtime: TurnRuntimeState,
    initialRun: PromptHandoffRun
  ): Promise<void> {
    let run = initialRun;
    runtime.activePromptRun = run;

    while (true) {
      const settled = await Promise.race([
        run.promptOutcome.then((outcome) => ({ type: 'prompt' as const, outcome })),
        run.successorReady.then(() => ({ type: 'successor' as const })),
      ]);
      // A handoff adapter answers the yielded prompt BEFORE it confirms the
      // steer. Keep that steer's wait alive: the decision below queues behind
      // the steer, so `applied` hands off to its successor and a refusal falls
      // through to completion. Draining here would wait on the next turn.
      const handoffVerdictPending =
        !!runtime.pendingHandoffSteerOutcome && !runtime.cancelRequested;
      if (settled.type === 'prompt' && !run.successor && !handoffVerdictPending) {
        runtime.steerWaitController?.abort();
      }
      const decision = await this.steerMutationQueue.enqueue(runtime.sessionId, async () => {
        if (
          this.turnRuntimeBySession.get(runtime.sessionId) !== runtime ||
          !runtime.promptInFlight
        ) {
          return { type: 'owner-closed' as const };
        }

        const successor = run.successor;
        if (successor) {
          run.successor = undefined;
          return { type: 'successor' as const, run: successor };
        }

        if (settled.type === 'successor') {
          throw new Error(`Prompt ${run.turnId} signalled handoff without a successor`);
        }

        runtime.promptInFlight = false;
        runtime.activePromptRun = undefined;
        return { type: 'completed' as const, outcome: settled.outcome };
      });

      if (decision.type === 'owner-closed') {
        return;
      }
      if (decision.type === 'successor') {
        run = decision.run;
        continue;
      }
      if (runtime.session) await this.drainCancelledPrompt(runtime.session, runtime);
      if (decision.outcome.status === 'rejected') {
        throw decision.outcome.error;
      }
      return;
    }
  }

  private getAssistantEntryIdForUserTurn(userTurnId: string): string {
    return `assistant:${userTurnId}`;
  }

  private async syncLiveActivitySummary(
    userId: string,
    fields?: Record<string, string | number | boolean | null | undefined>
  ): Promise<void> {
    try {
      await traceAsync(
        this.deps.logger,
        'execution.sync_live_activity_summary',
        { userId, ...fields },
        async () => {
          await this.deps.syncLiveActivitySummary?.(userId);
        }
      );
    } catch (error) {
      this.deps.logger.debug(
        `[live-activity] Failed to sync summary: ${formatErrorMessage(error)}`
      );
    }
  }

  private scheduleLiveActivitySummarySync(
    userId: string,
    fields?: Record<string, string | number | boolean | null | undefined>
  ): void {
    // Prompt hot-path invariant: notification/Live Activity sync is best-effort
    // and must not delay calling the ACP agent prompt.
    void this.syncLiveActivitySummary(userId, fields);
  }

  private async markPromptWorkingEnded(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    userId: string,
    triggerReason: string
  ): Promise<void> {
    try {
      // Prompt exit is one phase change, shared by both completion paths.
      // Do not pass detail and do not call this per token or chunk.
      this.deps.setSessionActivePresencePhase(sessionId, 'finalizing');
      await sessionDoc.setStatus(SessionStatusFactory.idle());
      this.captureStatusChanged(sessionId, 'idle', undefined, triggerReason);
    } catch (error) {
      this.deps.logger.warn(
        `[${sessionId}] Failed to mark prompt idle: ${formatErrorMessage(error)}`
      );
      return;
    }
    this.scheduleLiveActivitySummarySync(userId, {
      sessionId,
      triggerReason,
      status: 'idle',
    });
  }

  // --- Analytics helpers (spec §5b) -----------------------------------------
  // All side-effect-only: captureCli is a no-op when analytics is disabled and
  // never throws, so call sites do not need to guard.

  /**
   * Resolve the launcher family (npx/uvx/local) for analytics without spawning.
   * Best-effort: returns 'local' if the launch cannot be resolved (e.g. unknown
   * registry agent) so analytics never throws.
   */
  private resolveLauncherForAgent(
    cliType: AgentConfigCliType,
    agentType: string,
    customAcp?: CustomAcpLaunchSpec
  ): AcpLauncher | undefined {
    if (cliType === 'builtin') {
      return 'local';
    }
    try {
      const launch = resolveACPProcessLaunch({ cliType, agentType, customAcp });
      return resolveAcpLauncher(launch.command);
    } catch {
      return undefined;
    }
  }

  private baseSessionAnalyticsProps(
    sessionId: SessionId,
    extra?: { cliType?: AgentConfigCliType; agentType?: string }
  ): Record<string, unknown> {
    return {
      session_id: sessionId,
      workspace_id: this.deps.workspaceId,
      ...(extra?.cliType ? { cli_type: extra.cliType } : {}),
      ...(extra?.agentType ? { agent_type: extra.agentType } : {}),
    };
  }

  /**
   * session/status_changed (spec §5b, P0). Reports from→to with dwell time in
   * the previous state. Deduped: identical consecutive (status, stage) pairs are
   * dropped so high-frequency activity sub-states do not spam events.
   */
  private captureStatusChanged(
    sessionId: SessionId,
    toStatus: string,
    toStage: string | undefined,
    triggerReason: string
  ): void {
    const previous = this.lastStatusBySession.get(sessionId);
    if (previous && previous.status === toStatus && previous.stage === toStage) {
      return;
    }
    const nowMs = getServerNow();
    captureCli(
      'session/status_changed',
      {
        ...this.baseSessionAnalyticsProps(sessionId),
        ...(previous ? { from_status: previous.status } : {}),
        to_status: toStatus,
        ...(toStage ? { to_stage: toStage } : {}),
        trigger_reason: triggerReason,
        transition_at_ms: nowMs,
        ...(previous ? { duration_in_previous_state_ms: nowMs - previous.atMs } : {}),
      },
      { tier: 'A' }
    );
    this.lastStatusBySession.set(sessionId, { status: toStatus, stage: toStage, atMs: nowMs });
  }

  /** session/turn_started (spec §5b, P0). */
  private captureTurnStarted(
    sessionId: SessionId,
    turnId: string,
    args: {
      dispatchMode: 'start' | 'continue';
      hasReplayPrompt: boolean;
      inputBlockCount: number;
      dispatchSource?: SessionDispatchSource;
      extra?: { cliType?: AgentConfigCliType; agentType?: string };
    }
  ): void {
    this.turnAnalyticsBySession.set(sessionId, {
      turnId,
      startedAtMs: getServerNow(),
      dispatchMode: args.dispatchMode,
      hasReplayPrompt: args.hasReplayPrompt,
    });
    captureCli(
      'session/turn_started',
      {
        ...this.baseSessionAnalyticsProps(sessionId, args.extra),
        turn_id: turnId,
        dispatch_mode: args.dispatchMode,
        dispatch_source: args.dispatchSource ?? 'crdt',
        has_replay_prompt: args.hasReplayPrompt,
        input_block_count: args.inputBlockCount,
        started_at_ms: getServerNow(),
      },
      { tier: 'A' }
    );
  }

  /**
   * session/turn_completed (spec §5b, P0). Reads PR/diff aggregates from the
   * session doc after finalize so we emit one aggregated event per turn instead
   * of per-tool-call (spec §2.5).
   */
  private async captureTurnCompleted(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    turnId: string
  ): Promise<void> {
    try {
      const analytics = this.turnAnalyticsBySession.get(sessionId);
      const totalTurnMs =
        analytics && analytics.turnId === turnId
          ? getServerNow() - analytics.startedAtMs
          : undefined;

      let prDetected = false;
      let diffFileCount = 0;
      try {
        const meta = await sessionDoc.getMetaState();
        prDetected = (meta?.pullRequests ?? []).length > 0;
      } catch {
        // Best-effort: missing meta should not break turn completion.
      }
      try {
        const backend = await createSessionBackend(sessionDoc, await sessionDoc.getMetaState());
        const latestAssistant = await backend.readLatestTurn('assistant');
        diffFileCount = Array.isArray(latestAssistant?.fileDiff)
          ? latestAssistant.fileDiff.length
          : 0;
      } catch {
        // Best-effort.
      }

      captureCli(
        'session/turn_completed',
        {
          ...this.baseSessionAnalyticsProps(sessionId),
          turn_id: turnId,
          ...(typeof totalTurnMs === 'number' ? { total_turn_ms: totalTurnMs } : {}),
          // TODO(analytics): permission_wait_ms is accumulated in MessageHandler's
          // SessionTransientStore (state.permissionWaitMs); plumb it here to populate it.
          pr_detected: prDetected,
          diff_file_count: diffFileCount,
          ...(analytics?.dispatchMode ? { dispatch_mode: analytics.dispatchMode } : {}),
        },
        { tier: 'A' }
      );
    } catch {
      // Analytics must never break turn finalization.
    } finally {
      this.turnAnalyticsBySession.delete(sessionId);
    }
  }

  /** session/turn_failed (spec §5b, P0). reason = ACP ChatFailedReason. */
  private captureTurnFailed(
    sessionId: SessionId,
    turnId: string | undefined,
    reason: ChatFailedReason,
    isAcpError: boolean
  ): void {
    const analytics = turnId ? this.turnAnalyticsBySession.get(sessionId) : undefined;
    const totalTurnMs =
      analytics && analytics.turnId === turnId ? getServerNow() - analytics.startedAtMs : undefined;
    captureCli(
      'session/turn_failed',
      {
        ...this.baseSessionAnalyticsProps(sessionId),
        ...(turnId ? { turn_id: turnId } : {}),
        chat_failed_reason: reason,
        is_acp_error: isAcpError,
        ...(typeof totalTurnMs === 'number' ? { total_turn_ms: totalTurnMs } : {}),
      },
      { tier: 'A' }
    );
    if (turnId && analytics?.turnId === turnId) {
      this.turnAnalyticsBySession.delete(sessionId);
    }
  }

  private captureDuplicateDispatchPrevented(
    sessionId: SessionId,
    existingTurnId: string,
    userTurnId: string | undefined
  ): void {
    captureCli(
      'duplicate_dispatch_prevented',
      {
        ...this.baseSessionAnalyticsProps(sessionId),
        existing_turn_id: existingTurnId,
        ...(userTurnId ? { user_turn_id: userTurnId } : {}),
      },
      { tier: 'C' }
    );
  }

  getExecutionSnapshot(sessionId: SessionId): SessionExecutionSnapshot {
    const runtime = this.turnRuntimeBySession.get(sessionId);
    const currentTurnId = this.currentTurnBySession.get(sessionId);
    const activeTurnId = runtime?.turnId ?? currentTurnId;
    const hasActiveTurn = typeof activeTurnId === 'string' && activeTurnId.length > 0;
    const pendingSession = this.deps.sessionManager.getPendingSession(sessionId);

    return {
      ...(activeTurnId ? { activeTurnId } : {}),
      hasActiveTurn,
      hasBlockingPendingCreate: Boolean(runtime?.pendingSession || (runtime && pendingSession)),
      hasReusableSession: Boolean(this.deps.sessionManager.getSession(sessionId)),
      hasRewriteBarrier: this.rewriteBarrierSessions.has(sessionId),
      ...(runtime?.releaseFailure !== undefined
        ? { releaseBlocked: { reason: describeReleaseFailure(runtime.releaseFailure) } }
        : {}),
    };
  }

  tryAcquireSessionRewriteBarrier(sessionId: SessionId): (() => void) | null {
    if (
      this.rewriteBarrierSessions.has(sessionId) ||
      this.rewriteConflictLeaseSessions.has(sessionId)
    ) {
      return null;
    }
    this.rewriteBarrierSessions.add(sessionId);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.rewriteBarrierSessions.delete(sessionId);
    };
  }

  /**
   * Claims a short operation that must not overlap a durable history rewrite:
   * visible-turn ownership, acknowledged steer transfer, stale repair, or queue promotion.
   */
  tryAcquireSessionRewriteConflictLease(sessionId: SessionId): (() => void) | null {
    if (
      this.rewriteBarrierSessions.has(sessionId) ||
      this.rewriteConflictLeaseSessions.has(sessionId)
    ) {
      return null;
    }
    this.rewriteConflictLeaseSessions.add(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.rewriteConflictLeaseSessions.delete(sessionId);
    };
  }

  async waitForTurnRelease(sessionId: SessionId, turnId: string): Promise<void> {
    if (!this.isTurnOwned(sessionId, turnId)) {
      return;
    }
    await new Promise<void>((resolve) => {
      let byTurn = this.turnReleaseWaiters.get(sessionId);
      if (!byTurn) {
        byTurn = new Map();
        this.turnReleaseWaiters.set(sessionId, byTurn);
      }
      let waiters = byTurn.get(turnId);
      if (!waiters) {
        waiters = new Set();
        byTurn.set(turnId, waiters);
      }
      waiters.add(resolve);
      if (!this.isTurnOwned(sessionId, turnId)) {
        this.resolveTurnReleaseWaiters(sessionId, turnId);
      }
    });
  }

  getActiveTurnIds(): Array<{ sessionId: SessionId; turnId: string }> {
    const bySession = new Map<SessionId, string>();
    for (const [sessionId, turnId] of this.currentTurnBySession) {
      bySession.set(sessionId, turnId);
    }
    for (const [sessionId, runtime] of this.turnRuntimeBySession) {
      bySession.set(sessionId, runtime.turnId);
    }
    return Array.from(bySession, ([sessionId, turnId]) => ({ sessionId, turnId }));
  }

  /**
   * Run a goal action against a session.
   *
   * Status-only actions go out-of-band when the agent advertises that: an
   * active goal holds this session's only prompt slot open across the agent's
   * own continuations, so a pause that waited for a free slot would wait for
   * the thing it is trying to stop. Everything else runs inside a Lody-owned
   * turn, and if a turn is already running the action waits for that turn
   * instead of being dropped — the caller gets `queued`, not a dead button.
   */
  async controlSessionGoal(options: {
    sessionId: SessionId;
    action: SessionGoalAction;
    objective?: string;
    userId: string;
    userName: string;
    userEmail: string;
  }): Promise<SessionGoalResponse> {
    const { sessionId, action } = options;
    const respond = (
      disposition: SessionGoalResponse['disposition'],
      error?: string
    ): SessionGoalResponse => ({
      type: 'session/goal_response',
      sessionId,
      action,
      accepted: disposition === 'applied' || disposition === 'queued',
      disposition,
      ...(error ? { error } : {}),
    });

    const agentClient = this.deps.sessionManager.getSession(sessionId)?.agentClient;
    if (agentClient) {
      const transport = agentClient.resolveGoalActionTransport(action);
      if (transport === null) {
        return respond('unsupported', `Agent does not support goal ${action}`);
      }
      if (transport === 'request') {
        // A later Pause/Clear supersedes work that has not reached the provider.
        this.pendingGoalTurnBySession.delete(sessionId);
        try {
          await agentClient.controlGoal(action);
          return respond('applied');
        } catch (error) {
          this.deps.logger.warn(
            `[${sessionId}] Goal ${action} control request failed: ${formatErrorMessage(error)}`
          );
          return respond('error', formatErrorMessage(error));
        }
      }
    }

    // No live agent, or an action that needs a turn: the turn boots the session
    // when necessary and lets the agent client pick its transport at prompt time.
    const control: GoalPromptControl = {
      action,
      ...(options.objective ? { objective: options.objective } : {}),
    };
    const request: SessionGoalTurnRequest = {
      sessionId,
      control,
      userId: options.userId,
      userName: options.userName,
      userEmail: options.userEmail,
    };
    // Acceptance is not prompt completion (or even a claim of turn ownership).
    // The worker reports startup failures through the session's existing history.
    this.queueGoalTurn(request);
    return respond('queued');
  }

  /**
   * Hold one goal action per session until the running turn releases the prompt.
   *
   * A newer action replaces an older one: the user's latest intent is the only
   * one worth running, and running a stale pause after a resume would undo it.
   */
  private queueGoalTurn(request: SessionGoalTurnRequest): void {
    const { sessionId } = request;
    this.pendingGoalTurnBySession.set(sessionId, request);
    if (this.goalTurnWaiterSessions.has(sessionId)) {
      return;
    }
    this.goalTurnWaiterSessions.add(sessionId);
    void (async () => {
      for (;;) {
        const pending = this.pendingGoalTurnBySession.get(sessionId);
        if (!pending) return;
        const snapshot = this.getExecutionSnapshot(sessionId);
        if (snapshot.hasActiveTurn && snapshot.activeTurnId) {
          await this.waitForTurnRelease(sessionId, snapshot.activeTurnId);
          continue;
        }
        try {
          const claimed = await this.startGoalTurn(pending);
          if (this.pendingGoalTurnBySession.get(sessionId) !== pending) continue;
          // Another dispatch may win while metadata is loading. Retain the
          // accepted request and wait for its owner instead of reporting success.
          if (!claimed && this.getExecutionSnapshot(sessionId).hasActiveTurn) continue;
          if (!claimed) throw new Error('Goal turn could not acquire session ownership');
          this.pendingGoalTurnBySession.delete(sessionId);
          // A claimed turn that never submitted its prompt already records its
          // startup/cancellation outcome through the ordinary turn lifecycle.
        } catch (error) {
          if (this.pendingGoalTurnBySession.get(sessionId) !== pending) continue;
          this.pendingGoalTurnBySession.delete(sessionId);
          const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
          await this.deps.recordChatFailure(
            sessionDoc,
            'turn_pre_prompt_failed',
            `Goal ${pending.control.action} failed: ${formatErrorMessage(error)}`
          );
        }
      }
    })()
      .catch((error: unknown) => {
        this.deps.logger.error(
          `[${sessionId}] Failed to report queued goal failure: ${formatErrorMessage(error)}`
        );
      })
      .finally(() => {
        this.goalTurnWaiterSessions.delete(sessionId);
        const pending = this.pendingGoalTurnBySession.get(sessionId);
        if (pending) this.queueGoalTurn(pending);
      });
  }

  private async startGoalTurn(request: SessionGoalTurnRequest): Promise<boolean> {
    const { sessionId, control } = request;
    const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
    const meta = await sessionDoc.getMetaState();
    if (!meta) {
      throw new Error(`Session ${sessionId} has no metadata`);
    }
    if (meta.isArchived) {
      throw new Error(`Session ${sessionId} is archived`);
    }
    if (!meta.cliType || !meta.agentType) {
      throw new Error(`Session ${sessionId} has no agent configuration`);
    }
    const resumeAcpSessionId = resolveDispatchAcpSessionId(meta);
    let claimed = false;
    await this.continueSession(
      {
        type: 'session/chat',
        sessionId,
        machineId: this.deps.machineId,
        workspaceId: this.deps.workspaceId,
        ...(meta.project ? { project: meta.project } : {}),
        acpSessionConfig: {
          // Fallback blocks only: the agent replaces them when the action
          // schedules its own continuation. The run configuration is
          // deliberately absent so a goal turn cannot change model or mode.
          prompt: 'Continue working toward the active goal.',
          cliType: meta.cliType,
          agentType: meta.agentType,
          ...(resumeAcpSessionId ? { resume: resumeAcpSessionId } : {}),
        },
        // A goal turn owns an assistant entry but no user message, so this id
        // is provenance only and never becomes a dispatch pointer.
        userTurnId: `goal:${control.action}:${randomUUID()}`,
        userId: request.userId,
        userName: request.userName,
        userEmail: request.userEmail,
      },
      {
        dispatchSource: 'goal',
        notificationAudience: { kind: 'user' },
        goalControl: control,
        onTurnClaimed: async () => {
          claimed = this.pendingGoalTurnBySession.get(sessionId) === request;
          return claimed;
        },
        onTurnStarted: async () => {
          if (this.pendingGoalTurnBySession.get(sessionId) !== request) {
            await this.handleTurnError(sessionId, sessionDoc);
            return false;
          }
          this.pendingGoalTurnBySession.delete(sessionId);
          return true;
        },
      }
    );
    return claimed;
  }

  async steerSession(options: {
    sessionId: SessionId;
    expectedTurnId: string;
    userTurnId: string;
    userId: string;
    timestamp: string;
    inputConfig: SessionTurnInputConfig;
  }): Promise<SessionSteerResponse> {
    const result = await this.steerMutationQueue.enqueue<
      SessionSteerResponse | { response: Promise<SessionSteerResponse> }
    >(options.sessionId, async () => {
      const releaseConflict = this.tryAcquireSessionRewriteConflictLease(options.sessionId);
      if (!releaseConflict) {
        // A rewrite (not user Stop) owns the session. Keep the steer in
        // pending_apply; promoting it here would turn Edit & Resend or cleanup
        // cancellation into a fresh user send.
        return {
          type: 'session/steer_response',
          sessionId: options.sessionId,
          userTurnId: options.userTurnId,
          applied: false,
          disposition: 'busy',
          error: 'The session history is being replaced.',
        };
      }
      try {
        return await this.steerSessionLocked(options);
      } finally {
        releaseConflict();
      }
    });
    return 'response' in result ? await result.response : result;
  }

  private async steerSessionLocked(options: {
    sessionId: SessionId;
    expectedTurnId: string;
    userTurnId: string;
    userId: string;
    timestamp: string;
    inputConfig: SessionTurnInputConfig;
  }): Promise<SessionSteerResponse | { response: Promise<SessionSteerResponse> }> {
    let preparedDoc: SessionDocument | undefined;
    const reject = (
      disposition: Exclude<SessionSteerResponse['disposition'], 'applied'>,
      error?: string
    ): SessionSteerResponse => ({
      type: 'session/steer_response',
      sessionId: options.sessionId,
      userTurnId: options.userTurnId,
      applied: false,
      recoveryOwned: true,
      disposition,
      ...(error ? { error } : {}),
    });
    /**
     * The agent never took this prompt, so the user turn is still ours to run.
     * Only for rejections that provably happened before (or instead of) provider
     * submission — after submission the provider may already have committed the
     * steer, and re-sending would duplicate it.
     */
    const rejectAndPromote = async (
      disposition: Exclude<SessionSteerResponse['disposition'], 'applied'>,
      error?: string
    ): Promise<SessionSteerResponse> => {
      try {
        await this.requeueUndeliveredSteer(
          options.sessionId,
          options.userTurnId,
          options.expectedTurnId,
          preparedDoc
        );
      } catch (promotionError) {
        // Delivery is known even when its recovery write fails. Do not let the
        // provider-submission catch below reclassify it as delivery-unknown.
        return reject('promotion-failed', formatErrorMessage(promotionError));
      }
      return reject(disposition, error);
    };
    const preserveUndeliveredSteer = async (): Promise<void> => {
      await this.updateSteerTurnStatus(options.sessionId, options.userTurnId, undefined, {
        ...(preparedDoc ? { sessionDoc: preparedDoc } : {}),
        operation: {
          operationId: getSteerOperationId(options.userTurnId),
          userTurnId: options.userTurnId,
          expectedTurnId: options.expectedTurnId,
          cancellationPolicy: 'preserve',
          phase: 'settled',
          delivery: 'not_applied',
          status: 'pending',
          updatedAt: Date.now(),
        },
      });
    };
    const preserveAndReject = async (): Promise<SessionSteerResponse> => {
      try {
        await preserveUndeliveredSteer();
        return reject(
          'stale-turn',
          'The target turn was cancelled without promoting pending input'
        );
      } catch (error) {
        return reject('error', formatErrorMessage(error));
      }
    };
    // Resolve cancellation and ownership fences before opening the session doc.
    // A steer canceled before any provider work has started must remain
    // `pending_apply`; opening the doc here would make the recovery path rewrite
    // it to `pending` and turn a canceled steer into an ordinary follow-up.
    const runtime = this.turnRuntimeBySession.get(options.sessionId);
    if (!runtime || !runtime.session) {
      return await rejectAndPromote('no-active-turn');
    }
    if (runtime.turnId !== options.expectedTurnId) {
      return await rejectAndPromote('stale-turn');
    }
    if (runtime.cancelRequested) {
      return runtime.pendingInputOnCancel === 'promote'
        ? await rejectAndPromote('no-active-turn')
        : await preserveAndReject();
    }
    if (!runtime.promptInFlight) {
      return await rejectAndPromote('no-active-turn');
    }
    if (runtime.userTurnId === options.userTurnId) {
      return {
        type: 'session/steer_response',
        sessionId: options.sessionId,
        userTurnId: options.userTurnId,
        applied: true,
        disposition: 'applied',
      };
    }
    const waitController = (runtime.steerWaitController ??= new AbortController());
    const wait = <T>(work: Promise<T>) => waitForSteer(work, waitController.signal);
    type ProviderSubmissionRejection =
      | 'stale-turn'
      | 'no-active-turn'
      | 'preserve'
      | 'owner-transition';
    const getProviderSubmissionRejection = (
      expectedPromptRun?: PromptHandoffRun
    ): ProviderSubmissionRejection | null => {
      if (
        this.turnRuntimeBySession.get(options.sessionId) !== runtime ||
        runtime.turnId !== options.expectedTurnId
      ) {
        return 'stale-turn';
      }
      if (runtime.cancelRequested) {
        return runtime.pendingInputOnCancel === 'promote' ? 'no-active-turn' : 'preserve';
      }
      // No provider request has been submitted yet, so this guide is still
      // ours to run as an ordinary follow-up turn.
      if (!runtime.promptInFlight) {
        return 'no-active-turn';
      }
      if (expectedPromptRun !== undefined && runtime.activePromptRun !== expectedPromptRun) {
        return 'owner-transition';
      }
      return null;
    };
    const resolveProviderSubmissionRejection = async (
      rejection: ProviderSubmissionRejection
    ): Promise<SessionSteerResponse> => {
      if (rejection === 'stale-turn') {
        return await rejectAndPromote('stale-turn');
      }
      if (rejection === 'preserve') {
        return await preserveAndReject();
      }
      if (rejection === 'owner-transition') {
        return await rejectAndPromote(
          'busy',
          'Prompt owner is transitioning between logical turns'
        );
      }
      return await rejectAndPromote('no-active-turn');
    };
    const rejectBeforeProviderSubmission = async (
      expectedPromptRun?: PromptHandoffRun
    ): Promise<SessionSteerResponse | null> => {
      const rejection = getProviderSubmissionRejection(expectedPromptRun);
      if (rejection === null) return null;
      return await resolveProviderSubmissionRejection(rejection);
    };
    try {
      preparedDoc = await wait(
        this.deps.workspaceDocument.getOrCreateSessionDoc(options.sessionId)
      );
      const backend = await wait(createSessionBackend(preparedDoc));
      const previousOperation = await backend.getSteerOperationRecord(
        getSteerOperationId(options.userTurnId)
      );
      if (previousOperation && previousOperation.phase !== 'prepared') {
        if (previousOperation.delivery === 'applied') {
          return {
            type: 'session/steer_response',
            sessionId: options.sessionId,
            userTurnId: options.userTurnId,
            applied: true,
            disposition: 'applied',
          };
        }
        if (
          previousOperation.delivery === 'not_applied' ||
          previousOperation.delivery === 'not_submitted'
        ) {
          if (
            previousOperation.delivery === 'not_applied' &&
            previousOperation.status === 'pending' &&
            previousOperation.cancellationPolicy === 'promote'
          ) {
            await this.updateSteerTurnStatus(options.sessionId, options.userTurnId, 'pending', {
              sessionDoc: preparedDoc,
              expectedTurnId: previousOperation.expectedTurnId,
              cancellationPolicy: previousOperation.cancellationPolicy,
              phase: 'settled',
              delivery: 'not_applied',
            });
          }
          if (previousOperation.cancellationPolicy === 'preserve') {
            return reject(
              'stale-turn',
              'The target turn was cancelled without promoting pending input'
            );
          }
          await this.reconcileSteerHistory(options.sessionId, preparedDoc);
          return reject('no-active-turn');
        }
        return reject('delivery-unknown', 'This steer operation already has an unknown outcome.');
      }
      if (previousOperation && previousOperation.expectedTurnId !== options.expectedTurnId) {
        return reject('stale-turn', 'The steer operation id was reused for another turn.');
      }
      if (
        previousOperation &&
        (previousOperation.delivery !== 'not_submitted' ||
          previousOperation.status !== 'processing')
      ) {
        return reject(
          'delivery-unknown',
          'This steer operation has an inconsistent prepared state.'
        );
      }
    } catch (error) {
      if (error instanceof SteerWaitEnded) {
        if (runtime.cancelRequested) {
          return runtime.pendingInputOnCancel === 'promote'
            ? await rejectAndPromote('no-active-turn')
            : await preserveAndReject();
        }
        // The prompt completed while the steer was still preparing. The
        // handoff queue may not have published `promptInFlight = false` yet,
        // so this local wait ending is itself the proof that the target turn
        // is no longer accepting the steer.
        return await rejectAndPromote('no-active-turn');
      }
      return reject('error', formatErrorMessage(error));
    }
    const { agentClient, acpSessionId } = runtime.session;
    const steerCapability = agentClient?.getAcknowledgedSteerCapability();
    if (!agentClient || !acpSessionId || !steerCapability) {
      return await rejectAndPromote('unsupported');
    }
    if (steerCapability.configPolicy === 'active') {
      const mismatch = agentClient.findSteerConfigMismatch(options.inputConfig);
      if (mismatch) {
        return await rejectAndPromote(
          'unsupported',
          `Active turn configuration differs: ${mismatch}`
        );
      }
    }
    // Everything up to `steerPrompt` returning is provably undelivered; after
    // that only the agent's own inject-or-refuse verdict can say so.
    let providerSubmissionStarted = false;
    let providerApplicationConfirmed = false;
    try {
      const sessionDoc =
        preparedDoc ??
        (await wait(this.deps.workspaceDocument.getOrCreateSessionDoc(options.sessionId)));
      preparedDoc = sessionDoc;
      const queuedRejection = await rejectBeforeProviderSubmission();
      if (queuedRejection) return queuedRejection;
      const inputBlocks = resolveSessionExecutionInputBlocks(options.inputConfig);
      const promptBlocks = await wait(
        this.deps.buildAcpPromptBlocks({
          workspaceId: this.deps.workspaceId,
          sessionId: options.sessionId,
          inputBlocks,
          issuePRMentions: options.inputConfig.issuePRMentions,
        })
      );
      const preConfigRejection = await rejectBeforeProviderSubmission();
      if (preConfigRejection) {
        return preConfigRejection;
      }
      const operationId = getSteerOperationId(options.userTurnId);
      await this.updateSteerTurnStatus(options.sessionId, options.userTurnId, 'processing', {
        sessionDoc,
        expectedTurnId: options.expectedTurnId,
        projectStatus: false,
        operation: {
          operationId,
          userTurnId: options.userTurnId,
          expectedTurnId: options.expectedTurnId,
          cancellationPolicy: runtime.cancelRequested ? runtime.pendingInputOnCancel : 'promote',
          phase: 'prepared',
          delivery: 'not_submitted',
          status: 'processing',
          updatedAt: Date.now(),
        },
      });
      if (steerCapability.configPolicy === 'apply') {
        const configuring = this.deps.applyAcpModeAndModel(runtime.session, options.inputConfig, {
          sessionDoc,
          basedOnUserTurnId: options.userTurnId,
          signal: waitController.signal,
        });
        const pending = (runtime.pendingSteerConfig ??= new Set());
        pending.add(configuring);
        const release = () => {
          pending.delete(configuring);
        };
        void configuring.then(release, release);
        await wait(configuring);
      }

      await wait(
        this.deps.sessionManager.validateSessionCredentials(runtime.session, options.userId)
      );
      const preSubmitRejection = await rejectBeforeProviderSubmission();
      if (preSubmitRejection) {
        return preSubmitRejection;
      }
      const ownedPromptRun = runtime.activePromptRun;
      if (!ownedPromptRun || ownedPromptRun.turnId !== runtime.turnId) {
        return await rejectAndPromote(
          'busy',
          'Prompt owner is transitioning between logical turns'
        );
      }
      if (runtime.cancelRequested) {
        return runtime.pendingInputOnCancel === 'promote'
          ? await rejectAndPromote(
              'busy',
              'Prompt owner is cancelling or transitioning between logical turns'
            )
          : await preserveAndReject();
      }

      const previousTurnId = runtime.turnId;
      const previousUserTurnId = runtime.userTurnId;
      await this.updateSteerTurnStatus(options.sessionId, options.userTurnId, 'processing', {
        sessionDoc,
        expectedTurnId: options.expectedTurnId,
        projectStatus: false,
        phase: 'submitted',
        delivery: 'unknown',
      });
      // The durable submission marker is asynchronous. Stop can win while that
      // write is in flight, and the wait wrapper cannot abort this particular
      // operation. Re-check ownership immediately before handing the steer to
      // the provider so a canceled input is never submitted after the marker.
      // Keep this final read synchronous: once it passes there must be no
      // suspension point before `steerPrompt`, or Stop could win in between
      // the fence and the provider call.
      const postStatusRejection = getProviderSubmissionRejection(ownedPromptRun);
      if (postStatusRejection !== null) {
        return await resolveProviderSubmissionRejection(postStatusRejection);
      }
      const startSteer = () => {
        providerSubmissionStarted = true;
        return agentClient.steerPrompt(acpSessionId, promptBlocks);
      };
      const steerRun =
        runtime.inboxOwner?.input && this.operationInbox
          ? (await runtime.inboxOwner!.steer(startSteer)).value
          : startSteer();
      if (steerCapability.upstreamTurn === 'handoff') {
        const pendingOutcome = steerRun.outcome;
        runtime.pendingHandoffSteerOutcome = pendingOutcome;
        const clear = () => {
          if (runtime.pendingHandoffSteerOutcome === pendingOutcome) {
            runtime.pendingHandoffSteerOutcome = undefined;
          }
        };
        void pendingOutcome.then(clear, clear);
      }
      let steerOutcome: SteerOutcomeResult;
      try {
        steerOutcome = await wait(steerRun.outcome);
      } catch (error) {
        if (!(error instanceof SteerWaitEnded)) throw error;
        // The raw request still owns its delivery verdict. It no longer owns
        // this queue/lease, and can only settle this exact user input.
        const response = steerRun.outcome
          .then(async (outcome) => {
            providerApplicationConfirmed = outcome.outcome === 'applied';
            try {
              if (outcome.outcome === 'not-applied') {
                if (!runtime.cancelRequested || runtime.pendingInputOnCancel === 'promote') {
                  return await rejectAndPromote(
                    'no-active-turn',
                    formatErrorMessage(outcome.error)
                  );
                }
              } else {
                await this.setSteerHistoryStatus(
                  options.sessionId,
                  sessionDoc,
                  options.userTurnId,
                  outcome.outcome === 'unknown'
                    ? 'delivery_unknown'
                    : runtime.cancelRequested
                      ? 'canceled'
                      : 'handled',
                  outcome.outcome === 'applied' ? 'applied' : 'unknown'
                );
                if (outcome.outcome === 'unknown')
                  return reject('delivery-unknown', formatErrorMessage(outcome.error));
              }
              return reject(
                'stale-turn',
                'The target turn ended before steer ownership could transfer'
              );
            } finally {
              if (outcome.outcome === 'applied') outcome.application.release();
            }
          })
          .catch((failure: unknown) => {
            this.deps.logger.error(
              `[${options.sessionId}] Failed to settle stopped steer ${options.userTurnId}: ${formatErrorMessage(failure)}`
            );
            return reject(
              providerApplicationConfirmed ? 'error' : 'delivery-unknown',
              formatErrorMessage(failure)
            );
          });
        return { response };
      }
      if (steerOutcome.outcome === 'not-applied') {
        if (!runtime.cancelRequested || runtime.pendingInputOnCancel === 'promote') {
          return await rejectAndPromote('no-active-turn', formatErrorMessage(steerOutcome.error));
        }
        return await preserveAndReject();
      }
      if (steerOutcome.outcome === 'unknown') {
        await this.setSteerHistoryStatus(
          options.sessionId,
          sessionDoc,
          options.userTurnId,
          'delivery_unknown'
        );
        return reject('delivery-unknown', formatErrorMessage(steerOutcome.error));
      }
      const { application } = steerOutcome;
      providerApplicationConfirmed = true;
      try {
        await this.updateSteerTurnStatus(options.sessionId, options.userTurnId, 'processing', {
          sessionDoc,
          expectedTurnId: options.expectedTurnId,
          phase: 'submitted',
          delivery: 'applied',
        });
        if (
          runtime.cancelRequested ||
          this.turnRuntimeBySession.get(options.sessionId) !== runtime ||
          !runtime.promptInFlight ||
          runtime.turnId !== previousTurnId ||
          runtime.activePromptRun !== ownedPromptRun
        ) {
          // Provider acceptance forbids replay; Stop keeps the source cancellation owner.
          await this.setSteerHistoryStatus(
            options.sessionId,
            sessionDoc,
            options.userTurnId,
            runtime.cancelRequested ? 'canceled' : 'handled'
          );
          return reject(
            'stale-turn',
            'Steer application arrived after cancellation or ownership changed'
          );
        }

        // The provider has accepted this steer and may execute tools before
        // history/finalization catches up. Switch causal identity first.
        const switchInvocation = () => {
          runtime.notificationOutcome = undefined;
          runtime.invocation = {
            sourceTurnId: options.userTurnId,
            requesterUserId: options.userId,
            inputConfig: options.inputConfig,
          };
        };
        if (runtime.inboxOwner?.input && this.operationInbox) {
          const next: InboxInput = {
            ...runtime.inboxOwner?.input,
            userId: options.userId,
            inputId: options.userTurnId,
            kind:
              this.operationInbox?.inputKind(
                {
                  workspaceId: this.deps.workspaceId,
                  sessionId: options.sessionId,
                  userId: options.userId,
                },
                options.userTurnId
              ) ?? 'task',
            config: options.inputConfig,
          };
          try {
            await runtime.inboxOwner!.adopt(next, switchInvocation);
          } catch (cause) {
            switchInvocation();
            runtime.releaseFailure = cause;
            runtime.cancelRequested = true;
            this.requestAgentCancelInBackground(runtime, 'active');
            this.requestTurnInterrupt(runtime);
            throw cause;
          }
        } else switchInvocation();
        // Provider acceptance hands the original dispatch forward. A later
        // user-owned steer turn must not cancel or reopen that responsibility.

        try {
          await this.finalizeYieldedTurnOutput(runtime, options.sessionId, previousTurnId);
        } catch (error) {
          this.deps.logger.error(
            `[${options.sessionId}] Failed to seal applied steer source ${previousTurnId}: ${formatErrorMessage(error)}`
          );
        }
        try {
          await this.transitionDispatchOwnership({
            sessionId: options.sessionId,
            sessionDoc,
            previousUserTurnId,
            nextUserTurnId: options.userTurnId,
          });
        } catch (error) {
          this.deps.logger.error(
            `[${options.sessionId}] Failed to persist applied steer ownership for ${options.userTurnId}: ${formatErrorMessage(error)}`
          );
        }
        const nextTurnId = this.deps.beginConversationTurn(options.sessionId, options.userTurnId, {
          dispatchSource: 'rpc',
          sessionDoc,
        });
        try {
          await this.deps.createAssistantEntryForTurn(
            options.sessionId,
            sessionDoc,
            nextTurnId,
            agentClient.currentModel,
            options.userTurnId
          );
        } catch (error) {
          this.deps.logger.error(
            `[${options.sessionId}] Failed to create assistant entry for applied steer ${nextTurnId}: ${formatErrorMessage(error)}`
          );
        }
        this.deps.activateConversationTurnForACPUpdates(options.sessionId, nextTurnId);
        const nextPromptRun = this.createPromptHandoffRun({
          turnId: nextTurnId,
          promptPromise: steerRun.completion,
        });
        void ownedPromptRun.promptOutcome.then((outcome) => {
          if (outcome.status === 'rejected') {
            this.deps.logger.debug(
              `[${options.sessionId}] Yielded prompt ${ownedPromptRun.turnId} failed after ownership moved forward: ${formatErrorMessage(outcome.error)}`
            );
          }
        });
        ownedPromptRun.successor = nextPromptRun;
        runtime.activePromptRun = nextPromptRun;
        runtime.turnId = nextTurnId;
        runtime.userTurnId = options.userTurnId;
        if (!runtime.cancelRequested) runtime.steerWaitController = new AbortController();
        this.markCurrentTurn(options.sessionId, nextTurnId);
        ownedPromptRun.signalSuccessor();
        return {
          type: 'session/steer_response',
          sessionId: options.sessionId,
          userTurnId: options.userTurnId,
          applied: true,
          disposition: 'applied',
        };
      } finally {
        application.release();
      }
    } catch (error) {
      if (providerSubmissionStarted) {
        try {
          if (preparedDoc)
            await this.setSteerHistoryStatus(
              options.sessionId,
              preparedDoc,
              options.userTurnId,
              providerApplicationConfirmed
                ? runtime.cancelRequested
                  ? 'canceled'
                  : 'failed'
                : 'delivery_unknown'
            );
        } catch (projectionError) {
          this.deps.logger.error(
            `[${options.sessionId}] Failed to project steer ${options.userTurnId}: ${formatErrorMessage(projectionError)}`
          );
        }
        return reject(
          providerApplicationConfirmed ? 'error' : 'delivery-unknown',
          formatErrorMessage(error)
        );
      }
      if (runtime.cancelRequested && runtime.pendingInputOnCancel !== 'promote') {
        return await preserveAndReject();
      }
      // Failures before `steerPrompt` returns are local and therefore
      // provably unsubmitted. Provider-side ambiguity is represented only by
      // `SteerOutcome` above.
      return await rejectAndPromote('error', formatErrorMessage(error));
    }
  }

  /**
   * Re-route a steer the agent never accepted into ordinary dispatch, so it runs
   * as the next message once the active turn ends — the same treatment a queued
   * message gets. Without this it would sit in `pending_apply`, which dispatch
   * skips, and never run at all.
   *
   * Publish an execution-owned activation, never rewind the producer's pointer.
   * The watcher can project this result even when history arrives after the RPC.
   */
  private async requeueUndeliveredSteer(
    sessionId: SessionId,
    userTurnId: string,
    expectedTurnId: string,
    sessionDoc?: SessionDocument
  ): Promise<void> {
    try {
      // Guards against a late duplicate steer request resurrecting a turn that
      // already ran: it is running now, it finished here, or it finished before
      // its history entry ever synced.
      if (
        this.getActiveUserTurnId(sessionId) === userTurnId ||
        this.getTerminalUserTurnStatusWithoutEntry(sessionId, userTurnId) !== undefined
      ) {
        return;
      }
      const meta = await this.getSessionMeta(sessionId);
      if (meta?.lastHandledUserMsgId === userTurnId) {
        return;
      }
      if (sessionDoc && !(await this.markSteerTurnPending(sessionDoc, userTurnId))) {
        return;
      }
      await this.updateSteerTurnStatus(sessionId, userTurnId, 'pending', {
        sessionDoc,
        expectedTurnId,
        cancellationPolicy: 'promote',
        phase: 'settled',
        delivery: 'not_applied',
      });
      this.deps.logger.info(
        `[${sessionId}] Undelivered steer ${userTurnId} requeued as a follow-up turn`
      );
    } catch (error) {
      this.deps.logger.error(
        `[${sessionId}] Failed to requeue undelivered steer ${userTurnId}: ${formatErrorMessage(
          error
        )}`
      );
      throw error;
    }
  }

  /**
   * Flip a guide's history entry from `pending_apply` (steer intent, which
   * dispatch deliberately skips) to `pending` (dispatchable).
   *
   * Returns false when the entry has already started, finished, or been
   * canceled, so a late duplicate steer request cannot resurrect it. A missing
   * entry returns true: it has not synced here yet and the RPC offer carries the
   * payload.
   */
  private async markSteerTurnPending(
    sessionDoc: SessionDocument,
    userTurnId: string
  ): Promise<boolean> {
    const backend = await createSessionBackend(sessionDoc);
    let queueable = true;
    await backend
      .applyHistoryAction({
        kind: 'user-status',
        turnId: userTurnId,
        status: 'pending',
        requeueUndelivered: true,
      })
      .then((result) => {
        queueable = result.matched ?? false;
      });
    return queueable;
  }

  private async updateSteerTurnStatus(
    sessionId: SessionId,
    userTurnId: string,
    status: NonNullable<SessionMeta['steerTurnStatuses']>[string] | undefined,
    options: {
      sessionDoc?: SessionDocument;
      expectedTurnId?: string;
      cancellationPolicy?: SessionSteerOperationRecord['cancellationPolicy'];
      phase?: SessionSteerOperationRecord['phase'];
      delivery?: SessionSteerOperationRecord['delivery'];
      projectStatus?: boolean;
      operation?: SessionSteerOperationRecord;
    } = {}
  ): Promise<void> {
    await this.steerStatusQueue.enqueue(sessionId, async () => {
      const sessionDoc = options.sessionDoc;
      const meta = sessionDoc ? undefined : await this.getSessionMeta(sessionId);
      const backend = sessionDoc ? await createSessionBackend(sessionDoc) : undefined;
      const statuses = {
        ...(backend ? await backend.getSteerTurnStatuses() : meta?.steerTurnStatuses),
      };
      const statusChanged = statuses[userTurnId] !== status;
      if (status === undefined) delete statuses[userTurnId];
      else statuses[userTurnId] = status;

      const operationId = getSteerOperationId(userTurnId);
      const existing = backend
        ? await backend.getSteerOperationRecord(operationId)
        : meta?.steerOperationLedger?.[operationId];
      let operation = options.operation ?? existing;
      if (status === undefined) {
        operation = options.operation ?? existing;
      } else if (operation) {
        operation = {
          ...operation,
          status,
          cancellationPolicy: options.cancellationPolicy ?? operation.cancellationPolicy,
          phase:
            options.operation?.phase ??
            options.phase ??
            (status === 'processing' ? 'submitted' : 'settled'),
          delivery:
            options.operation?.delivery ??
            options.delivery ??
            (status === 'pending'
              ? 'not_applied'
              : status === 'delivery_unknown'
                ? 'unknown'
                : status === 'processing'
                  ? operation.delivery === 'applied'
                    ? 'applied'
                    : 'unknown'
                  : operation.delivery),
          updatedAt: Date.now(),
        };
      } else if (options.expectedTurnId) {
        operation = {
          operationId,
          userTurnId,
          expectedTurnId: options.expectedTurnId,
          cancellationPolicy: options.cancellationPolicy ?? 'promote',
          phase: options.phase ?? 'settled',
          delivery: options.delivery ?? (status === 'pending' ? 'not_applied' : 'unknown'),
          status,
          updatedAt: Date.now(),
        };
      }

      if (!statusChanged && !existing && !operation) return;
      if (backend) {
        await backend.setSteerOperationRecord(operationId, operation);
        if (statusChanged && options.projectStatus !== false) {
          await backend.replaceSteerTurnStatuses(statuses);
        }
        return;
      }

      // A steer can be canceled while opening the history document is stalled.
      // Keep its control-plane recovery state durable without waiting for the
      // history backend; the next reconciliation pass will project it through
      // the bound backend once the document is available.
      const operationLedger = { ...(meta?.steerOperationLedger ?? {}) };
      if (operation) operationLedger[operationId] = operation;
      else delete operationLedger[operationId];
      await this.upsertSessionMeta(sessionId, {
        ...(statusChanged && options.projectStatus !== false
          ? { steerTurnStatuses: statuses }
          : {}),
        steerOperationLedger: operationLedger,
      });
    });
  }

  /** Acknowledges an exact recovery input, without changing a producer's activation. */
  async acknowledgeSteerTurn(sessionId: SessionId, userTurnId: string): Promise<void> {
    await this.updateSteerTurnStatus(sessionId, userTurnId, undefined);
  }

  private async setSteerHistoryStatus(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    userTurnId: string,
    status: 'processing' | 'handled' | 'failed' | 'canceled' | 'delivery_unknown',
    delivery?: SessionSteerOperationRecord['delivery']
  ): Promise<void> {
    await this.updateSteerTurnStatus(sessionId, userTurnId, status, {
      sessionDoc,
      ...(delivery ? { delivery } : {}),
    });
    await this.reconcileSteerHistory(sessionId, sessionDoc);
  }

  /** Results can arrive before the producer's history; metadata retains only their identity/state. */
  async reconcileSteerHistory(sessionId: SessionId, sessionDoc: SessionDocument): Promise<void> {
    await this.steerStatusQueue.enqueue(sessionId, async () => {
      const meta = await this.getSessionMeta(sessionId);
      const backend = await createSessionBackend(sessionDoc, meta);
      const statuses = { ...(await backend.getSteerTurnStatuses()) };
      let changed = false;
      const hasActiveTurn = this.getExecutionSnapshot(sessionId).hasActiveTurn;
      const ledger = { ...((await backend.getSteerOperationLedger()) ?? {}) };
      for (const [operationId, existing] of Object.entries(ledger)) {
        if (hasActiveTurn) continue;
        if (existing.phase === 'prepared' && existing.delivery === 'not_submitted') {
          const operation: SessionSteerOperationRecord = {
            ...existing,
            phase: 'settled',
            delivery: 'not_applied',
            status: 'pending',
            updatedAt: Date.now(),
          };
          await backend.setSteerOperationRecord(operationId, operation);
          ledger[operationId] = operation;
          if (existing.cancellationPolicy === 'promote') {
            statuses[existing.userTurnId] = 'pending';
          } else {
            delete statuses[existing.userTurnId];
          }
          changed = true;
          continue;
        }
        if (existing.phase === 'submitted' && existing.delivery === 'applied') {
          const operation: SessionSteerOperationRecord = {
            ...existing,
            phase: 'settled',
            status: 'handled',
            updatedAt: Date.now(),
          };
          await backend.setSteerOperationRecord(operationId, operation);
          ledger[operationId] = operation;
          statuses[existing.userTurnId] = 'handled';
          changed = true;
          continue;
        }
        if (existing.phase === 'submitted' && existing.delivery === 'not_applied') {
          const operation: SessionSteerOperationRecord = {
            ...existing,
            phase: 'settled',
            status: existing.cancellationPolicy === 'promote' ? 'pending' : 'canceled',
            updatedAt: Date.now(),
          };
          await backend.setSteerOperationRecord(operationId, operation);
          ledger[operationId] = operation;
          if (existing.cancellationPolicy === 'promote') {
            statuses[existing.userTurnId] = 'pending';
          } else {
            delete statuses[existing.userTurnId];
          }
          changed = true;
          continue;
        }
        if (existing.phase === 'submitted' && existing.delivery === 'unknown') {
          const operation: SessionSteerOperationRecord = {
            ...existing,
            phase: 'settled',
            delivery: 'unknown',
            status: 'delivery_unknown',
            updatedAt: Date.now(),
          };
          await backend.setSteerOperationRecord(operationId, operation);
          ledger[operationId] = operation;
          statuses[existing.userTurnId] = 'delivery_unknown';
          changed = true;
        }
      }
      for (const [turnId, status] of Object.entries(statuses)) {
        const turn = await backend.readTurn(turnId);
        if (turn.state !== 'ready' || turn.turn.role !== 'user') continue;
        const operationId = getSteerOperationId(turnId);
        const operation = ledger[operationId];
        const currentStatus = turn.turn.status;
        if (
          status === 'pending' &&
          currentStatus !== 'pending_apply' &&
          currentStatus !== 'pending' &&
          currentStatus !== 'seen'
        ) {
          // The exact history row already crossed the requeue fence (for
          // example, another worker started it). Do not leave a durable
          // pending mirror that can resurrect an input after that point.
          delete statuses[turnId];
          changed = true;
          continue;
        }
        const terminal =
          !!turn.turn.status &&
          !['pending_apply', 'pending', 'seen', 'processing'].includes(turn.turn.status);
        const projectedStatus =
          status === 'processing' && !hasActiveTurn
            ? operation?.delivery === 'applied'
              ? 'handled'
              : operation?.phase === 'settled' &&
                  operation.delivery === 'not_applied' &&
                  operation.status === 'pending'
                ? 'pending'
                : 'delivery_unknown'
            : status;
        if (projectedStatus !== status) {
          statuses[turnId] = projectedStatus;
          changed = true;
        }
        if (status === 'processing' && !hasActiveTurn && operation?.delivery === 'applied') {
          const recovered: SessionSteerOperationRecord = {
            ...operation,
            phase: 'settled',
            status: 'handled',
            updatedAt: Date.now(),
          };
          await backend.setSteerOperationRecord(operationId, recovered);
          ledger[operationId] = recovered;
        }
        let matched = false;
        if (!terminal) {
          const result = await backend.applyHistoryAction({
            kind: 'user-status',
            turnId,
            status: projectedStatus,
            cancellationReason:
              projectedStatus === 'canceled'
                ? this.getInboxInputCancellationReason(sessionId, turnId)
                : undefined,
            ...(status === 'pending'
              ? { requeueUndelivered: true }
              : {
                  steerProjection: true,
                  deliveredSteer: status !== 'delivery_unknown',
                }),
          });
          matched = result.matched ?? false;
        }
        if (!matched || (projectedStatus !== 'pending' && projectedStatus !== 'processing')) {
          delete statuses[turnId];
          changed = true;
        }
      }
      if (changed) await backend.replaceSteerTurnStatuses(statuses);
    });
  }

  async dispatchPreparedSessionTurn(options: PreparedSessionDispatchOptions): Promise<void> {
    const { sessionId, userTurnId, dispatchSource } = options;
    const expectedTurnId = this.getAssistantEntryIdForUserTurn(userTurnId);
    const span = startTraceSpan(this.deps.logger, 'execution.prepared_session_turn', {
      sessionId,
      userTurnId,
      turnId: expectedTurnId,
      dispatchSource,
    });
    let outcome = 'unknown';

    const self = this;
    try {
      const visibleOutcome = await this.runVisibleSessionTurn(
        {
          sessionId,
          sessionDoc: options.sessionDoc,
          userTurnId,
          invocation: options.invocation,
          dispatchSource,
          unhandledErrorCode: 'session_chat_failed',
          describeUnhandledError: (error) =>
            `[${sessionId}] Failed to process prepared session turn: ${formatErrorMessage(error)}`,
        },
        (ctx) =>
          Effect.gen(function* () {
            const access = yield* self.tryPromise(() => options.accessPromise);
            if (access.outcome === 'denied') {
              outcome = 'access-denied';
              yield* self.tryPromise(async () => await options.onAccessDenied(access));
              return undefined;
            }
            if (access.outcome === 'indeterminate') {
              outcome = 'access-indeterminate';
              // The turn stays pending for the access retry, so its Inbox input
              // must stay pending too: releasing would finish it and the retry's
              // `begin` would be rejected forever.
              ctx.runtime.withdrawInboxExecution = true;
              yield* self.tryPromise(async () => await options.onAccessIndeterminate(access));
              return undefined;
            }

            yield* self.tryPromise(async () => await options.onAccessAllowed());
            const builtRequest = yield* self.tryPromise(() => options.requestPromise);
            const plan = yield* self.tryPromise(() =>
              builtRequest.mode === 'create'
                ? self.prepareStartSessionTurn(
                    builtRequest.request,
                    { dispatchSource },
                    { sessionDoc: options.sessionDoc }
                  )
                : self.prepareContinueSessionTurn(
                    builtRequest.request,
                    { dispatchSource },
                    { sessionDoc: options.sessionDoc }
                  )
            );
            outcome = builtRequest.mode === 'create' ? 'dispatch-create' : 'dispatch-continue';
            ctx.setUnhandledErrorContext({
              code: plan.options.unhandledErrorCode,
              describe: plan.options.describeUnhandledError,
              ...(plan.options.onUnhandledError
                ? { onUnhandledError: plan.options.onUnhandledError }
                : {}),
            });
            yield* plan.body(ctx);
            return undefined;
          })
      );
      if (visibleOutcome === 'execution-deferred') {
        await options.onExecutionDeferred?.();
      }
      if (
        outcome === 'unknown' ||
        visibleOutcome === 'duplicate' ||
        visibleOutcome === 'cancelled'
      ) {
        outcome = visibleOutcome;
      }
    } catch (error) {
      if (isSessionTurnCancelled(error)) {
        outcome = 'cancelled';
        return;
      }
      outcome = 'error';
      span.fail(error, { outcome });
      throw error;
    } finally {
      span.end({ outcome });
    }
  }

  private async evictForTurnStart(sessionId: SessionId): Promise<MemoryPressureEvictionResult> {
    return await this.deps.evictForMemoryPressure(sessionId);
  }

  private createTurnRuntime(
    options: Pick<
      VisibleSessionTurnOptions,
      'sessionId' | 'session' | 'userTurnId' | 'invocation' | 'goalControl'
    > & { turnId: string }
  ): TurnRuntimeState {
    return {
      sessionId: options.sessionId,
      turnId: options.turnId,
      userTurnId: options.userTurnId,
      invocation: options.invocation,
      goalControl: options.goalControl,
      session: options.session,
      promptStarted: false,
      promptInFlight: false,
      promptFailed: false,
      finalizeStarted: false,
      finalizeCompleted: false,
      workspaceGitStateSynced: false,
      prePromptFailureRecorded: false,
      cancelRequested: false,
      pendingInputOnCancel: 'preserve',
      cancelFinalized: false,
      interruptRequested: false,
      terminateSessionOnCancel: false,
      initializationStalled: false,
      yieldedFinalization: Promise.resolve(),
    };
  }

  private getTurnRuntime(sessionId: SessionId, turnId: string): TurnRuntimeState | undefined {
    const runtime = this.turnRuntimeBySession.get(sessionId);
    return runtime?.turnId === turnId ? runtime : undefined;
  }

  private shouldReportCancelledTurnError(runtime: TurnRuntimeState | undefined): boolean {
    if (!runtime) {
      return true;
    }
    return !runtime.finalizeCompleted;
  }

  private registerTurnRuntime(runtime: TurnRuntimeState): void {
    this.turnRuntimeBySession.set(runtime.sessionId, runtime);
  }

  private releaseTurnRuntime(sessionId: SessionId, turnId: string): void {
    const runtime = this.turnRuntimeBySession.get(sessionId);
    const releasedOwner = runtime?.turnId === turnId;
    if (releasedOwner) {
      runtime.inboxOwner?.detach();
      this.turnRuntimeBySession.delete(sessionId);
    }
    // Safety net: drop per-turn analytics state if the turn ended without a
    // completed/failed capture (e.g. cancellation), so the map cannot leak.
    if (releasedOwner || this.turnAnalyticsBySession.get(sessionId)?.turnId === turnId) {
      this.turnAnalyticsBySession.delete(sessionId);
    }
    this.clearCurrentTurn(sessionId, turnId);
    this.resolveTurnReleaseWaiters(sessionId, turnId);
  }

  private isTurnOwned(sessionId: SessionId, turnId: string): boolean {
    return (
      this.turnRuntimeBySession.get(sessionId)?.turnId === turnId ||
      this.currentTurnBySession.get(sessionId) === turnId
    );
  }

  private resolveTurnReleaseWaiters(sessionId: SessionId, turnId: string): void {
    const byTurn = this.turnReleaseWaiters.get(sessionId);
    const waiters = byTurn?.get(turnId);
    if (!waiters) {
      return;
    }
    byTurn?.delete(turnId);
    if (byTurn?.size === 0) {
      this.turnReleaseWaiters.delete(sessionId);
    }
    for (const resolve of waiters) {
      resolve();
    }
  }

  private tryPromise<T>(
    try_: (signal: AbortSignal) => Promise<T>
  ): Effect.Effect<T, unknown, never> {
    return Effect.tryPromise({
      try: try_,
      catch: (error) => error,
    });
  }

  private ignoreWithWarning(
    sessionId: SessionId,
    description: string,
    effect: Effect.Effect<unknown, unknown, never>
  ): Effect.Effect<void, never, never> {
    return effect.pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        Effect.sync(() => {
          this.deps.logger.warn(`[${sessionId}] ${description}: ${formatErrorMessage(error)}`);
        })
      )
    );
  }

  private async awaitTurnFiber<T>(
    fiber: Fiber.Fiber<T, unknown>,
    sessionId: SessionId,
    turnId: string
  ): Promise<T> {
    const exit = await Effect.runPromise(Fiber.await(fiber));
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    const failure = Cause.findErrorOption(exit.cause);
    if (failure._tag === 'Some') {
      throw failure.value;
    }
    if (Cause.hasInterrupts(exit.cause)) {
      throw new SessionTurnCancelled({ sessionId, turnId });
    }
    throw new Error(Cause.pretty(exit.cause));
  }

  private requestTurnInterrupt(runtime: TurnRuntimeState): void {
    if (runtime.interruptRequested) {
      return;
    }
    const fiber = runtime.fiber;
    if (!fiber) {
      return;
    }
    runtime.interruptRequested = true;
    void Effect.runPromise(Fiber.interrupt(fiber)).catch((error: unknown) => {
      this.deps.logger.warn(
        `[${runtime.sessionId}] Failed to interrupt turn ${runtime.turnId}: ${formatErrorMessage(error)}`
      );
    });
  }

  private requestAgentCancelInBackground(runtime: TurnRuntimeState, stage: string): void {
    const runtimeSession =
      runtime.session ?? this.deps.sessionManager.getSession(runtime.sessionId);
    if (!runtimeSession?.agentClient?.isCreated() || !runtimeSession.acpSessionId) {
      return;
    }

    void runtimeSession.agentClient
      .cancel(runtimeSession.acpSessionId)
      .then(() => {
        this.deps.logger.debug(
          `[${runtime.sessionId}] Cancel signal sent to agent for ${stage} turn ${runtime.turnId}`
        );
      })
      .catch((error: unknown) => {
        this.deps.logger.debug(
          `[${runtime.sessionId}] Failed to cancel ${stage} turn ${runtime.turnId}: ${formatErrorMessage(error)}`
        );
      });
  }

  private terminatePendingSessionWhenReady(options: {
    sessionId: SessionId;
    turnId: string;
    pendingSession: Promise<ISession>;
  }): void {
    void options.pendingSession
      .then(async (session) => {
        try {
          await session.terminate(true);
        } catch (error) {
          this.deps.logger.debug(
            `[${options.sessionId}] Failed to terminate pending session after stop request for turn ${options.turnId}: ${formatErrorMessage(error)}`
          );
        }
      })
      .catch((error: unknown) => {
        this.deps.logger.debug(
          `[${options.sessionId}] Pending session did not finish after stop request for turn ${options.turnId}: ${formatErrorMessage(error)}`
        );
      });
  }

  /**
   * Release what a stalled initialization was holding.
   *
   * The stall is a failure, not a cancellation, so it must not go through
   * `finalizeCancelledTurnEffect` — that would mark the user's turn cancelled.
   * But that finalizer also owned the pending-create cleanup, and the stall is
   * the first halt that can land WHILE `SessionManager.createSession` is still
   * in flight, so the release has to happen here instead.
   *
   * Detaching matters more than terminating: the create is cached in
   * `pendingSessionCreates` keyed by session id, so leaving it there hands the
   * user's retry the very same wedged promise and stalls it again — the
   * documented retry path would not actually recover. Nothing here awaits the
   * wedged promise; if it ever settles, the manager's reaper terminates the
   * Session it produced.
   */
  private finalizeStalledInitializationEffect(
    runtime: TurnRuntimeState
  ): Effect.Effect<void, never, never> {
    const self = this;
    return Effect.gen(function* () {
      self.deps.clearActiveTurnId(runtime.sessionId, runtime.turnId);

      // A Session that already materialized is owned by this turn and nobody
      // else will stop it.
      const session = runtime.session;
      if (session) {
        yield* self.ignoreWithWarning(
          runtime.sessionId,
          'Failed to terminate session after initialization stalled',
          self.tryPromise(() => session.terminate(true))
        );
        return;
      }

      const detached = self.deps.sessionManager.abandonPendingSessionCreate(
        runtime.sessionId,
        'initialization-stalled'
      );
      if (detached || !runtime.pendingSession) {
        return;
      }
      // The pending promise did not come from the dedupe map (nothing to
      // detach), so reap it directly rather than leaving a possible orphan.
      self.terminatePendingSessionWhenReady({
        sessionId: runtime.sessionId,
        turnId: runtime.turnId,
        pendingSession: runtime.pendingSession,
      });
    });
  }

  private drainCancelledPrompt(session: ISession, runtime?: TurnRuntimeState): Promise<void> {
    if (runtime?.cancellationDrain) return runtime.cancellationDrain;
    const requests = () =>
      [
        runtime?.rawPromptCompletion,
        session.agentClient?.pendingPromptCompletion,
        ...(runtime?.pendingSteerConfig ?? []),
      ].filter((work): work is Promise<void> => !!work);
    const pending = requests();
    if (pending.length === 0) return Promise.resolve();
    const pendingPrompt = Promise.allSettled(pending).then(() => undefined);

    const drain = withTimeout(pendingPrompt, 5_000, 'ACP prompt cancellation timed out').catch(
      async () => {
        // A terminal response may have won just after the timeout fired.
        if (requests().length === 0) return;
        if (runtime && this.getTurnRuntime(runtime.sessionId, runtime.turnId) !== runtime) return;
        this.deps.logger.warn(
          `[${session.sessionId}] ACP prompt did not finish after cancellation; terminating session before reuse`
        );
        try {
          await session.terminate(true);
        } catch (error) {
          this.deps.logger.warn(
            `[${session.sessionId}] Failed to terminate cancelled session; waiting for ACP completion: ${formatErrorMessage(error)}`
          );
          // Failed termination is not permission to reuse a busy agent.
          if (runtime) runtime.releaseFailure = error;
          throw error;
        }
      }
    );
    if (runtime) runtime.cancellationDrain = drain;
    return drain;
  }

  private createAcpReplaySuppressionResource(sessionId: SessionId): {
    acquire: Effect.Effect<void, never, Scope.Scope>;
    release: Effect.Effect<void, never, never>;
  } {
    let active = false;
    const release = Effect.sync(() => {
      if (!active) {
        return;
      }
      active = false;
      try {
        this.deps.endACPReplaySuppression(sessionId);
      } catch (error) {
        this.deps.logger.warn(
          `[${sessionId}] Failed to release ACP replay suppression: ${formatErrorMessage(error)}`
        );
      }
    });

    return {
      acquire: Effect.acquireRelease(
        Effect.sync(() => {
          if (active) {
            return;
          }
          this.deps.beginACPReplaySuppression(sessionId);
          active = true;
        }),
        () => release
      ).pipe(Effect.asVoid),
      release,
    };
  }

  /** The lease latches its native stall signal before observers can subscribe. */
  private awaitInitializationStall(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    runtime: TurnRuntimeState,
    lease: SessionActivePresenceLease
  ): Effect.Effect<never, unknown, never> {
    return lease.awaitInitializationStall.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          runtime.initializationStalled = true;
        })
      ),
      Effect.flatMap((stall) =>
        this.recordKnownChatFailureAndHaltEffect({
          sessionId,
          sessionDoc,
          userTurnId: runtime.userTurnId,
          reason: 'session_init_failed',
          message: formatInitializationStallMessage(stall),
        })
      )
    );
  }

  private acquireSessionActivePresence(
    sessionId: SessionId,
    phase: SessionActivePresencePhase | null
  ): Effect.Effect<SessionActivePresenceLease, unknown, Scope.Scope> {
    return this.deps.holdSessionActivePresence(sessionId, phase);
  }

  private async finalizeCancelledTurn(options: TurnCancellationFinalizerOptions): Promise<void> {
    await Effect.runPromise(this.finalizeCancelledTurnEffect(options));
  }

  private finalizeCancelledTurnEffect(
    options: TurnCancellationFinalizerOptions
  ): Effect.Effect<void, never, never> {
    const runtime = this.getTurnRuntime(options.sessionId, options.turnId);
    if (runtime?.cancelFinalized) {
      return Effect.void;
    }

    const self = this;
    return Effect.gen(function* () {
      if (runtime) {
        runtime.cancelFinalized = true;
        runtime.cancelRequested = true;
        runtime.steerWaitController?.abort();
      }
      self.deps.clearActiveTurnId(options.sessionId, options.turnId);

      const sessionToTerminate = options.session ?? null;
      if (options.terminateSession && !sessionToTerminate && options.pendingSession) {
        self.terminatePendingSessionWhenReady({
          sessionId: options.sessionId,
          turnId: options.turnId,
          pendingSession: options.pendingSession,
        });
      }

      if (options.terminateSession && sessionToTerminate) {
        yield* self.ignoreWithWarning(
          options.sessionId,
          'Failed to terminate session after stop request',
          self.tryPromise(() => sessionToTerminate.terminate(true))
        );
      }

      // Persist the cancellation outcome before ACP finalization can expose a
      // terminal assistant entry. Operation reconciliation treats a terminal
      // assistant as success unless the user turn already carries a stronger
      // failed/cancelled outcome, so reversing these writes creates a window
      // where a cancelled turn can be durably folded as succeeded.
      yield* self.ignoreWithWarning(
        options.sessionId,
        'Failed to mark dispatch cancelled',
        self.tryPromise(() =>
          self.markDispatchCancelled(options.sessionId, options.sessionDoc, options.userTurnId)
        )
      );

      if (options.reportTurnError) {
        yield* self.ignoreWithWarning(
          options.sessionId,
          'Failed to finalize ACP state for cancelled turn',
          self.tryPromise(() =>
            self.handleTurnError(options.sessionId, options.sessionDoc, new Error('cancelled'))
          )
        );
      } else {
        yield* self.ignoreWithWarning(
          options.sessionId,
          'Failed to refresh Code Collab v2 shared state for cancelled turn',
          Effect.sync(() => self.refreshCodeCollabSharedStateAfterTurn(options.sessionId))
        );
      }

      // A stopped turn leaves the agent's edits on disk and nothing commits them
      // or pushes on the session's behalf, so the dirty/unpushed flags that
      // raise the Info Bar's Commit & Push have to be refreshed here too. This is the
      // route a Stop during the PROMPT takes; the one in `finalizeTurn` only
      // covers a Stop that raced finalization. Publish before idle so the flag
      // has landed by the time the UI stops showing Working.
      const cancelledSession = options.session;
      if (cancelledSession) {
        yield* self.tryPromise(() =>
          self.syncWorkspaceGitStateOnce(options.sessionId, options.turnId, cancelledSession)
        );
      }

      yield* self.ignoreWithWarning(
        options.sessionId,
        'Failed to set cancelled turn status to idle',
        self.tryPromise(() => options.sessionDoc.setStatus(SessionStatusFactory.idle()))
      );
      yield* self.ignoreWithWarning(
        options.sessionId,
        'Failed to clear cancel request',
        self.tryPromise(() => self.clearCancelRequest(options.sessionId))
      );

      const sessionToDrain = options.session;
      if (sessionToDrain && !options.terminateSession) {
        // Keep the execution owner until ACP has actually finished. Otherwise
        // the next queued turn can reach the still-busy adapter after local abort.
        yield* self.tryPromise(() => self.drainCancelledPrompt(sessionToDrain, runtime));
      }

      if (runtime?.promptStarted) {
        yield* self.ignoreWithWarning(
          options.sessionId,
          'Failed to settle context compaction after cancelled ACP prompt stopped',
          self.tryPromise(async () => {
            await self.deps.turnFinalization.finalizeACPState(options.sessionId, options.turnId);
            await self.persistTurnDiffsAndFlushUsage(options.sessionId, options.turnId);
          })
        );
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          self.clearTurnCancellation(options.sessionId, options.turnId);
          self.clearCurrentTurn(options.sessionId, options.turnId);
        })
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          self.deps.logger.warn(
            `[${options.sessionId}] Failed to finalize cancelled turn ${options.turnId}: ${formatErrorMessage(error)}`
          );
        })
      )
    );
  }

  private async recordPrePromptFailure(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    runtime: TurnRuntimeState | undefined,
    error: unknown
  ): Promise<void> {
    if (
      !runtime ||
      runtime.promptStarted ||
      runtime.cancelRequested ||
      runtime.prePromptFailureRecorded
    ) {
      return;
    }
    // `handleTurnError` always runs next in this flow and owns the classified
    // notice for ACP-shaped errors (including auth-required) and agent
    // disconnects. Recording a generic pre-prompt notice here as well would
    // show the user two `chat_failed` entries for one failed turn.
    if (parseACPError(error) || isAgentDisconnectedError(error)) {
      return;
    }
    runtime.prePromptFailureRecorded = true;
    const message = describeSessionStartFailure(runtime.startStage, formatReportedError(error));
    if (isGitExecutableNotFoundError(error)) {
      await this.deps.recordChatFailure(
        sessionDoc,
        'turn_pre_prompt_failed',
        message,
        GIT_EXECUTABLE_NOT_FOUND_CODE
      );
    } else {
      await this.deps.recordChatFailure(sessionDoc, 'turn_pre_prompt_failed', message);
    }
    this.deps.logger.debug(
      `[${sessionId}] Recorded pre-prompt failure notice for turn ${runtime.turnId}`
    );
  }

  private async recordKnownChatFailure(options: {
    sessionId: SessionId;
    sessionDoc: SessionDocument;
    userTurnId?: string;
    reason: ChatFailedReason;
    code?: string;
    message: string;
  }): Promise<void> {
    const notificationRuntime = this.turnRuntimeBySession.get(options.sessionId);
    if (notificationRuntime)
      notificationRuntime.notificationOutcome = {
        kind: 'failed',
        code: options.code ?? options.reason,
      };
    // turn_failed (spec §5b, P0). These are known, pre-prompt halts — not ACP
    // protocol errors — so is_acp_error=false.
    this.captureTurnFailed(
      options.sessionId,
      this.currentTurnBySession.get(options.sessionId),
      options.reason,
      false
    );
    // session/restore_failed & session/init_failed (spec §5b, P0): the two known
    // halts that map to dedicated lifecycle events.
    if (options.reason === 'session_restore_failed') {
      captureCli(
        'session/restore_failed',
        {
          ...this.baseSessionAnalyticsProps(options.sessionId),
          reason: options.reason,
        },
        { tier: 'A' }
      );
    } else if (options.reason === 'session_init_failed') {
      captureCli(
        'session/init_failed',
        {
          ...this.baseSessionAnalyticsProps(options.sessionId),
          failure_stage: 'session_init',
          chat_failed_reason: options.reason,
        },
        { tier: 'A' }
      );
    }
    await this.deps.recordChatFailure(options.sessionDoc, options.reason, options.message);
    if (options.userTurnId) {
      await this.markTurnFailed(options.sessionId, options.sessionDoc, options.userTurnId);
    }
    await options.sessionDoc.setStatus(SessionStatusFactory.idle());
    this.captureStatusChanged(options.sessionId, 'idle', undefined, 'turn_failed');
  }

  /**
   * Fail a still-pending user turn whose Inbox input already ended in an earlier
   * execution. Lody never replays such an input, so the user resends instead.
   */
  private async retireEndedInboxInputTurn(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    userTurnId: string
  ): Promise<void> {
    const read = await (await createSessionBackend(sessionDoc)).readTurn(userTurnId);
    if (
      read.state === 'ready' &&
      (read.turn.role !== 'user' ||
        ['handled', 'failed', 'canceled', 'delivery_unknown'].includes(read.turn.status ?? ''))
    ) {
      return;
    }
    await this.recordKnownChatFailure({
      sessionId,
      sessionDoc,
      userTurnId,
      reason: 'turn_pre_prompt_failed',
      message:
        'This message was not started because an earlier attempt to run it already ended. ' +
        'Lody does not replay messages automatically; send it again to retry.',
    });
  }

  private formatMemoryPressureFailureMessage(result: MemoryPressureEvictionResult): string {
    // macOS decides from the kernel's own pressure level, not from a byte budget. Quoting
    // "N MB available / M MB required" there would state a threshold that was never applied.
    if (result.pressureReason === 'darwin_pressure_critical') {
      return (
        'The machine is at critical memory pressure — macOS is reclaiming memory and ' +
        'terminating processes to keep up. The turn was not started; free memory and retry.'
      );
    }

    const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`;

    // Windows refuses on commit only, and only once the page file can no longer grow. Quoting
    // physical availability there would name a number that was not the reason.
    if (
      result.effectiveAvailableCommitBytes !== undefined &&
      result.commitThresholdBytes !== undefined
    ) {
      return (
        'The machine has run out of committable memory: ' +
        `${mb(result.availableCommitBytes ?? 0)} below the commit limit plus ` +
        `${mb(result.commitGrowthBytes ?? 0)} the page file can still grow, against a safety ` +
        `margin of ${mb(result.commitThresholdBytes)}. The turn was not started; close some ` +
        'programs, or raise the page file maximum, and retry.'
      );
    }

    const availableMb = mb(result.availableMemoryBytes);
    // Deliberately NOT "required to start a turn": the threshold is a safety margin the machine
    // should keep free, not a measurement of what a turn costs. Quoting it as a requirement sent
    // people hunting for 2.6GB that nothing was ever going to allocate.
    const marginMb = mb(result.thresholdBytes);

    // Under a cgroup, one total explains nothing — the operator needs to see which term is
    // binding, and how much of `memory.current` is just page cache.
    const cgroup = result.cgroup;
    if (cgroup) {
      const hostText =
        result.hostAvailableBytes !== undefined
          ? `host available ${mb(result.hostAvailableBytes)}, `
          : '';
      const stallText =
        cgroup.psiSomeAvg10 !== null
          ? `stalled ${cgroup.psiSomeAvg10}% of the last 10s on reclaim`
          : 'PSI unavailable; hard headroom is below the floor';
      return (
        `The machine is under memory pressure and ${stallText}. ` +
        `cgroup ${cgroup.path}: ${mb(cgroup.currentBytes)} of ${mb(cgroup.maxBytes)} used, ` +
        `${mb(cgroup.hardHeadroomBytes)} unused plus ${mb(cgroup.reclaimableBytes)} reclaimable ` +
        `cache/slab; ${hostText}safety margin ${marginMb}. ` +
        'The turn was not started; free memory and retry.'
      );
    }

    return (
      `The machine is under memory pressure (${availableMb} available, ` +
      `safety margin ${marginMb}). The turn was not started; ` +
      'free memory and retry.'
    );
  }

  /**
   * Runs one Session start and repeats it after a temporary system failure, before
   * any agent output exists. Each repeat is a new start (the failed one already
   * released its process and credentials); a start that already finished the
   * worktree setup script repeats as a resume so the script never runs twice.
   */
  private startWithTransientRetry(options: {
    sessionId: SessionId;
    runtime: TurnRuntimeState;
    config: SessionConfig;
    abortIfCancelled: () => Effect.Effect<void, unknown, never>;
    start: () => Effect.Effect<ISession, unknown, never>;
  }): Effect.Effect<ISession, unknown, never> {
    const self = this;
    const { sessionId, runtime, config } = options;
    const attempts = SESSION_START_RETRY_DELAYS_MS.length + 1;
    const attempt = (index: number): Effect.Effect<ISession, unknown, never> =>
      Effect.suspend(() => {
        // Each attempt reports its own steps; a stale one would misname a failure
        // that happens before the next report and choose the wrong retry mode.
        runtime.startStage = undefined;
        return options.start();
      }).pipe(
        Effect.catch((error) => {
          const delayMs = SESSION_START_RETRY_DELAYS_MS[index];
          const mode = sessionStartRetryMode(runtime.startStage, config.resume === true);
          if (
            delayMs === undefined ||
            mode === 'none' ||
            runtime.cancelRequested ||
            runtime.initializationStalled ||
            !isTransientSessionStartError(error) ||
            hadIncompleteStartCleanup(error)
          ) {
            return Effect.fail(error);
          }
          return Effect.gen(function* () {
            const failure = describeSessionStartFailure(
              runtime.startStage,
              formatReportedError(error)
            );
            if (!takeSessionStartRetry(self.startRetryStartedAt, yield* Clock.currentTimeMillis)) {
              self.deps.logger.warn(
                `[${sessionId}] Session start hit a temporary system error (${failure}); not retrying because this daemon's start retry budget is spent`
              );
              return yield* Effect.fail(error);
            }
            const waitMs = jitterSessionStartRetryDelay(delayMs, yield* Random.next);
            self.deps.logger.warn(
              `[${sessionId}] Session start hit a temporary system error (${failure}); starting attempt ${index + 2} of ${attempts} in ${waitMs}ms`
            );
            if (self.turnRuntimeBySession.get(sessionId) === runtime) {
              self.deps.setSessionActivePresencePhase(
                sessionId,
                'initializing',
                'Retrying after a temporary system error'
              );
            }
            yield* Effect.sleep(waitMs);
            yield* options.abortIfCancelled();
            if (mode === 'resume') config.resume = true;
            return yield* attempt(index + 1);
          });
        })
      );
    return attempt(0);
  }

  private recordKnownChatFailureAndHaltEffect(options: {
    sessionId: SessionId;
    sessionDoc: SessionDocument;
    userTurnId?: string;
    reason: ChatFailedReason;
    code?: string;
    message: string;
  }): Effect.Effect<never, unknown, never> {
    return this.tryPromise(() => this.recordKnownChatFailure(options)).pipe(
      Effect.flatMap(() =>
        Effect.fail(new SessionTurnHalted({ sessionId: options.sessionId, reason: options.reason }))
      )
    );
  }

  private async markCancelledUserTurnBeforeOwner(options: {
    sessionId: SessionId;
    sessionDoc: SessionDocument;
    userTurnId?: string;
  }): Promise<boolean> {
    if (!(await this.isUserTurnCancelled(options.sessionDoc, options.userTurnId))) {
      return false;
    }
    await options.sessionDoc.setStatus(SessionStatusFactory.idle());
    await this.markDispatchCancelled(options.sessionId, options.sessionDoc, options.userTurnId);
    await this.clearCancelRequest(options.sessionId);
    return true;
  }

  private async handleVisibleTurnUnhandledError(options: {
    sessionId: SessionId;
    sessionDoc: SessionDocument;
    userTurnId?: string;
    runtime: TurnRuntimeState;
    error: unknown;
    code: string;
    describe: (error: unknown) => string;
    onUnhandledError?: (error: unknown) => Promise<void>;
  }): Promise<void> {
    try {
      await this.recordPrePromptFailure(
        options.sessionId,
        options.sessionDoc,
        options.runtime,
        options.error
      );
    } catch (noticeError) {
      this.deps.logger.warn(
        `[${options.sessionId}] Failed to record pre-prompt failure notice: ${formatErrorMessage(noticeError)}`
      );
    }

    if (options.runtime.session) {
      // A best-effort observation must not delay publishing the turn failure.
      void this.deps.syncSessionBranchName(options.sessionId, options.runtime.session);
    }
    this.deps.logger.error(options.describe(options.error), options.error);
    if (options.userTurnId) {
      await this.markTurnFailed(options.sessionId, options.sessionDoc, options.userTurnId);
    }
    await this.handleTurnError(options.sessionId, options.sessionDoc, options.error);
    await options.onUnhandledError?.(options.error);
  }

  private async finalizeHaltedTurn(options: {
    sessionId: SessionId;
    sessionDoc: SessionDocument;
    turnId: string;
    reason: ChatFailedReason;
  }): Promise<void> {
    try {
      await this.handleTurnError(options.sessionId, options.sessionDoc);
    } catch (error) {
      this.deps.logger.warn(
        `[${options.sessionId}] Failed to finalize halted turn ${options.turnId} (${options.reason}): ${formatErrorMessage(error)}`
      );
    }
  }

  private async prepareLocalProjectBranch(options: {
    project: Extract<ProjectRef, { kind: 'local' }>;
    workdir: string;
    branch: string;
    onBaseRefResolved?: (baseRef: string) => Promise<void>;
  }): Promise<{ executionBranch: string; baseRef: string }> {
    const { project, workdir, branch } = options;

    const gitState = await localProjectsLegacy.getLocalProjectGitStateAtRootPath(workdir);
    if (!gitState.git) {
      throw new Error(`Local project is not a git repository: ${project.localProjectId}`);
    }

    const resolvedBranch = await localProjectsLegacy.resolveLocalProjectBranchAtRootPath(
      workdir,
      branch,
      {
        preferLocalOnCollision: true,
      }
    );

    // Persist the namespace decision before checkout can create a same-named
    // local tracking branch. A process exit after checkout must not make the
    // durable metadata reinterpret the selector against a different ref set.
    await options.onBaseRefResolved?.(resolvedBranch.refName);

    if (project.useWorktree === true) {
      return {
        executionBranch: resolvedBranch.refName,
        baseRef: resolvedBranch.refName,
      };
    }
    if (resolvedBranch.kind === 'local' && gitState.currentBranch === resolvedBranch.branchName) {
      return { executionBranch: resolvedBranch.branchName, baseRef: resolvedBranch.refName };
    }

    return {
      executionBranch: (
        await localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(
          workdir,
          createLocalProjectBranchSelector(resolvedBranch)
        )
      ).currentBranch,
      baseRef: resolvedBranch.refName,
    };
  }

  /**
   * Workdir lookup for turn dispatch. A session dispatch can land before the
   * machine Flock doc's first remote sync (cold start, restarted worker), when
   * the local-project row only exists in the cloud — a single read would kill
   * the turn with a spurious "Local project not found in workspace" notice, so
   * misses pull the Flock doc and retry briefly (see
   * resolveWorkspaceLocalProjectRootPathWithRetry).
   *
   * The pull goes through the coordinator's `syncNow`, which dedupes onto any
   * in-flight sync and, on failure, marks the coordinator dirty and arms its
   * own retry loop — for a pure-reader machine that dirty flag is what keeps
   * the flock room's rejoin alive. The per-attempt wait is bounded caller-side
   * (`syncTimeoutMs` in the helper), so an inherited long sync cannot stall
   * the turn beyond ~4 × (1.5s + 400ms).
   */
  private resolveLocalProjectWorkdirForTurn(
    localProjectId: LocalProjectId
  ): Promise<string | null> {
    return resolveWorkspaceLocalProjectRootPathWithRetry(
      this.deps.workspaceDocument.repo,
      this.deps.workspaceId,
      this.deps.machineId,
      localProjectId,
      {
        requestSync: () =>
          this.deps.workspaceDocument.syncMachineFlockDoc(this.deps.machineId, {
            reason: 'session-local-project-resolve',
            timeoutMs: readLocalProjectRootResolveSyncTimeoutMs(),
          }),
        onRetry: (attempt, maxAttempts) =>
          this.deps.logger.debug(
            `Local project ${localProjectId} not visible in machine Flock yet; ` +
              `pulling machine Flock and retrying (attempt ${attempt}/${maxAttempts})`
          ),
      }
    );
  }

  private async handleTurnError(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    error?: unknown
  ): Promise<void> {
    const acpError = error ? parseACPError(error) : null;
    const providerDisconnected = error ? isAgentDisconnectedError(error) : false;
    try {
      await this.deps.turnFinalization.finalizeACPState(
        sessionId,
        this.currentTurnBySession.get(sessionId)
      );
    } catch (finalizationError) {
      // The normal path fails on unfinished history. Error settlement must still
      // run independent status, failure attention and release bookkeeping.
      this.deps.logger.warn(
        `[${sessionId}] Failed to finalize error history: ${formatErrorMessage(finalizationError)}`
      );
    }
    await this.persistCodeCollabTurnDiffsAfterACPFinalization(
      sessionId,
      this.currentTurnBySession.get(sessionId)
    );
    await this.deps.turnFinalization.flushSessionUsage(sessionId);

    if (error) {
      if (acpError) {
        const failureReason = mapACPErrorToFailureReason(acpError);
        const userMessage = getACPErrorUserMessage(acpError);
        const recordedMessage =
          failureReason === 'agent_disconnected'
            ? 'The agent process disconnected unexpectedly. Please try again.'
            : userMessage;

        this.deps.logger.warn(
          `[${sessionId}] ACP error occurred (code=${acpError.code} reason=${failureReason}): ${userMessage}`
        );

        this.captureTurnFailed(
          sessionId,
          this.currentTurnBySession.get(sessionId),
          failureReason,
          true
        );
        await this.deps.recordChatFailure(sessionDoc, failureReason, recordedMessage);

        if (shouldTerminateOnACPError(acpError, failureReason)) {
          // Expired credentials leave a healthy agent process behind, so close
          // its ACP session before killing it: adapters that flush their
          // transcript on `session/close` would otherwise lose the artifact
          // `loadSession` needs, and the next turn — after the user signs back
          // in — would have nothing left to resume into. Every other
          // terminating error means a wedged or disposed connection, where a
          // graceful close only stalls the teardown, so those stay forced.
          const force = failureReason !== 'acp_auth_required';
          this.deps.logger.debug(
            `[${sessionId}] Terminating session due to ACP error (code=${acpError.code} force=${force})`
          );
          try {
            await this.deps.sessionManager.terminateSession(sessionId, force);
          } catch (terminateError) {
            this.deps.logger.debug(
              `[${sessionId}] Failed to terminate session after ACP error: ${formatErrorMessage(terminateError)}`
            );
          }
        }
      } else if (providerDisconnected) {
        this.deps.logger.warn(
          `[${sessionId}] Agent disconnected during chat, terminating session for clean restart`
        );

        this.captureTurnFailed(
          sessionId,
          this.currentTurnBySession.get(sessionId),
          'agent_disconnected',
          true
        );
        await this.deps.recordChatFailure(
          sessionDoc,
          'agent_disconnected',
          'The agent process disconnected unexpectedly. Please try again.'
        );

        try {
          await this.deps.sessionManager.terminateSession(sessionId, true);
        } catch (terminateError) {
          this.deps.logger.debug(
            `[${sessionId}] Failed to terminate disconnected session: ${formatErrorMessage(terminateError)}`
          );
        }
      } else {
        this.deps.logger.debug(
          `[${sessionId}] Turn error was not an ACP or disconnection error, not recording to history`
        );
      }
    }

    this.refreshCodeCollabSharedStateAfterTurn(sessionId);
    await sessionDoc.waitUntilSynced();
    await sessionDoc.setStatus(SessionStatusFactory.idle());
  }

  private refreshCodeCollabSharedStateAfterTurn(sessionId: SessionId): void {
    const refresh = this.deps.turnFinalization.refreshCodeCollabSharedState;
    if (!refresh) {
      return;
    }
    // The Code Collab service owns cancellation, deadlines and publication repair.
    // Optional file-view refresh must never retain the turn's execution/presence lease.
    void Promise.resolve()
      .then(() => refresh(sessionId))
      .catch((error: unknown) => {
        this.deps.logger.debug(
          `[${sessionId}] Failed to refresh Code Collab v2 shared state after turn: ${formatErrorMessage(error)}`
        );
      });
  }

  private async persistCodeCollabTurnDiffsAfterACPFinalization(
    sessionId: SessionId,
    turnId: string | undefined
  ): Promise<boolean> {
    const persist = this.deps.turnFinalization.persistCodeCollabTurnDiffs;
    if (!persist || !turnId) {
      return false;
    }
    try {
      return await persist(sessionId, turnId);
    } catch (error) {
      this.deps.logger.error(
        `[${sessionId}] Failed to persist Code Collab v2 turn diff evidence; not falling back to git history fileDiff: ${formatErrorMessage(error)}`
      );
      return true;
    }
  }

  /**
   * Publish `workspaceDirty` / `workspaceUnpushed` at most once per turn.
   *
   * A cancelled turn reaches this from `finalizeTurn`'s bail-out AND from
   * `finalizeCancelledTurnEffect` (the `acquireRelease` handler runs for every
   * cancelled turn), so without the shared latch a single Stop spawns both git
   * probes twice and rewrites the same values. `syncWorkspaceGitState` swallows
   * its own failures, so no caller needs to guard this.
   */
  private markWorkspaceGitStateSynced(sessionId: SessionId, turnId: string): void {
    const runtime = this.getTurnRuntime(sessionId, turnId);
    if (runtime) {
      runtime.workspaceGitStateSynced = true;
    }
  }

  private async syncWorkspaceGitStateOnce(
    sessionId: SessionId,
    turnId: string,
    session: ISession
  ): Promise<void> {
    const runtime = this.getTurnRuntime(sessionId, turnId);
    if (runtime?.workspaceGitStateSynced) {
      return;
    }
    if (runtime) {
      runtime.workspaceGitStateSynced = true;
    }
    await this.runTurnFinalizationStage(sessionId, turnId, 'syncWorkspaceGitState', async () => {
      await this.deps.syncSessionBranchName(sessionId, session);
      await this.deps.turnFinalization.syncWorkspaceGitState(sessionId, session);
    });
  }

  private async runTurnFinalizationStage<T>(
    sessionId: SessionId,
    turnId: string,
    stage: string,
    run: () => Promise<T>
  ): Promise<T> {
    const span = startTraceSpan(this.deps.logger, 'execution.finalization_stage', {
      sessionId,
      turnId,
      stage,
    });
    const startedAtMs = Date.now();
    try {
      const result = await run();
      span.end();
      return result;
    } catch (error) {
      span.fail(error);
      throw error;
    } finally {
      const durationMs = Date.now() - startedAtMs;
      if (durationMs >= TURN_FINALIZATION_STAGE_WARN_MS) {
        this.deps.logger.warn(
          `[${sessionId}] Turn finalization stage slow turnId=${turnId} stage=${stage} durationMs=${durationMs}`
        );
      }
    }
  }

  private async persistTurnDiffsAndFlushUsage(
    sessionId: SessionId,
    turnId: string
  ): Promise<boolean> {
    const codeCollabHistoryFileDiffPersisted = await this.runTurnFinalizationStage(
      sessionId,
      turnId,
      'persistCodeCollabTurnDiffs',
      async () => await this.persistCodeCollabTurnDiffsAfterACPFinalization(sessionId, turnId)
    );
    await this.runTurnFinalizationStage(sessionId, turnId, 'flushSessionUsage', async () => {
      await this.deps.turnFinalization.flushSessionUsage(sessionId);
    });
    return codeCollabHistoryFileDiffPersisted;
  }

  private async finalizeTurnOutput(sessionId: SessionId, turnId: string): Promise<boolean> {
    await this.runTurnFinalizationStage(sessionId, turnId, 'finalizeACPState', async () => {
      await this.deps.turnFinalization.finalizeACPState(sessionId, turnId);
    });
    return await this.persistTurnDiffsAndFlushUsage(sessionId, turnId);
  }

  private async finalizeYieldedTurnOutput(
    runtime: TurnRuntimeState,
    sessionId: SessionId,
    turnId: string
  ): Promise<void> {
    await this.runTurnFinalizationStage(sessionId, turnId, 'finalizeACPState', async () => {
      await this.deps.turnFinalization.finalizeACPState(sessionId, turnId);
    });
    runtime.yieldedFinalization = runtime.yieldedFinalization
      .then(async () => {
        await this.persistTurnDiffsAndFlushUsage(sessionId, turnId);
      })
      .catch((error: unknown) => {
        this.deps.logger.error(
          `[${sessionId}] Yielded turn ${turnId} ancillary finalization failed: ${formatErrorMessage(error)}`
        );
      });
  }

  private async finalizeTurn(ctx: FinalizeTurnContext): Promise<void> {
    const {
      sessionId,
      session,
      sessionDoc,
      turnId,
      baseCommitHash,
      turnStartWorkingTreeDiff,
      project,
    } = ctx;
    const isTurnCancelled = ctx.isTurnCancelled ?? (() => false);
    const githubProject = resolveProjectGitHubRepo(project);
    const stopIfTurnCancelled = async (stage: string): Promise<boolean> => {
      if (!isTurnCancelled() && !ctx.abortSignal?.aborted) {
        return false;
      }
      this.deps.logger.debug(
        `[${sessionId}] Turn ${turnId} was cancelled during ${stage}; skipping remaining completion post-processing`
      );
      // The rest of finalization is skipped, but the agent's edits are still on
      // disk. The dirty/unpushed flags are what raise the Info Bar's Commit &
      // Push, and nothing commits or pushes on the session's behalf, so an
      // interrupted turn that left stale `false`s here would hide real
      // unpublished work behind a PR that looks current.
      await this.syncWorkspaceGitStateOnce(sessionId, turnId, session);
      await sessionDoc.setStatus(SessionStatusFactory.idle());
      this.deps.touchSession(sessionId);
      return true;
    };

    const codeCollabHistoryFileDiffPersisted = await this.finalizeTurnOutput(sessionId, turnId);

    if (await stopIfTurnCancelled('ACP finalization')) {
      return;
    }

    const notificationRuntime = this.getTurnRuntime(sessionId, turnId);
    if (notificationRuntime)
      notificationRuntime.notificationOutcome =
        ctx.producedOutput === false
          ? { kind: 'failed', code: 'no_agent_output' }
          : { kind: 'succeeded' };

    let preferredStatsBaseBranch = project?.branch;
    if (project?.kind === 'local') {
      preferredStatsBaseBranch =
        (await sessionDoc.getMetaState())?.baseBranch?.trim() || preferredStatsBaseBranch;
    }

    const branchName = await this.runTurnFinalizationStage(
      sessionId,
      turnId,
      'syncSessionBranchName',
      async () => await this.deps.syncSessionBranchName(sessionId, session)
    );

    if (await stopIfTurnCancelled('branch synchronization')) {
      return;
    }

    if (githubProject) {
      try {
        const detectedPr = await this.runTurnFinalizationStage(
          sessionId,
          turnId,
          'detectAndAssociatePR',
          async () =>
            await this.deps.turnFinalization.detectAndAssociatePR({
              sessionId,
              session,
              sessionDoc,
              project,
              branchName,
            })
        );
        preferredStatsBaseBranch = detectedPr?.baseBranch ?? preferredStatsBaseBranch;
      } catch (error) {
        this.deps.logger.debug(`[${sessionId}] PR detection failed: ${formatErrorMessage(error)}`);
      }

      if (await stopIfTurnCancelled('PR detection')) {
        return;
      }

      // No post-turn PR-poll hook: the reconciler's activity rule
      // (`lastMessageAt` within 10 min → high lane) already keeps this
      // session on the fast refresh cadence after a turn ends
      // (specs/pr-status-reconciler.md).

      await this.runTurnFinalizationStage(sessionId, turnId, 'updateSessionDiffStats', async () => {
        await this.deps.turnFinalization.updateSessionDiffStats(sessionId, session, {
          turnId,
          baseCommitHash: baseCommitHash ?? undefined,
          turnStartWorkingTreeDiff,
          preferredBaseBranch: preferredStatsBaseBranch,
          skipHistoryFileDiff: codeCollabHistoryFileDiffPersisted,
        });
        this.markWorkspaceGitStateSynced(sessionId, turnId);
      });

      if (await stopIfTurnCancelled('diff recording')) {
        return;
      }
    }

    this.refreshCodeCollabSharedStateAfterTurn(sessionId);
    await this.runTurnFinalizationStage(sessionId, turnId, 'captureTurnCompleted', async () => {
      await this.captureTurnCompleted(sessionId, sessionDoc, turnId);
    });
    this.deps.logger.info(`Session chat completed: ${sessionId}`);

    this.deps.touchSession(sessionId);
  }

  private async runVisibleSessionTurn(
    options: VisibleSessionTurnOptions,
    body: (ctx: VisibleSessionTurnContext) => Effect.Effect<void, unknown, Scope.Scope>
  ): Promise<string> {
    const owned = this.runVisibleSessionTurnOwned(options, body);
    this.ownedWork.add(owned);
    try {
      return await owned;
    } finally {
      this.ownedWork.delete(owned);
    }
  }

  private async runVisibleSessionTurnOwned(
    options: VisibleSessionTurnOptions,
    body: (ctx: VisibleSessionTurnContext) => Effect.Effect<void, unknown, Scope.Scope>
  ): Promise<string> {
    const { sessionId, sessionDoc, userTurnId } = options;
    const assistantEntryParentTurnId = options.assistantEntryParentTurnId ?? userTurnId;
    const span = startTraceSpan(this.deps.logger, 'execution.visible_turn', {
      sessionId,
      ...(userTurnId ? { userTurnId } : {}),
      ...(options.dispatchSource ? { dispatchSource: options.dispatchSource } : {}),
    });
    let outcome = 'unknown';
    const releaseConflict = this.tryAcquireSessionRewriteConflictLease(sessionId);
    if (!releaseConflict) {
      outcome = 'rewrite-barrier';
      span.end({ outcome });
      return outcome;
    }
    const existingRuntime = this.turnRuntimeBySession.get(sessionId);
    if (existingRuntime) {
      releaseConflict();
      this.captureDuplicateDispatchPrevented(sessionId, existingRuntime.turnId, userTurnId);
      this.deps.logger.warn(
        `[${sessionId}] Prevented duplicate visible turn dispatch while turn ${existingRuntime.turnId} is active`
      );
      span.end({ outcome: 'duplicate', activeTurnId: existingRuntime.turnId });
      // The owning runtime is responsible for advancing dispatch metadata. Mutating it here
      // can mark a newer queued user turn handled before its actual execution starts.
      return 'duplicate';
    }

    const inbox = this.operationInbox;
    const invocation = options.invocation;
    try {
      if (inbox && invocation?.requesterUserId && !options.inboxBatch) {
        const control = await sessionDoc.getDocState();
        const receipt = control?.humanInputReceipts?.[invocation.sourceTurnId];
        if (receipt?.userId === invocation.requesterUserId)
          await this.acceptInboxHumanInput({
            sessionId,
            inputId: invocation.sourceTurnId,
            userId: receipt.userId,
            config: invocation.inputConfig,
          });
      }
    } catch (cause) {
      releaseConflict();
      span.end({ outcome: 'inbox-human-receipt-failed' });
      throw cause;
    }
    const inboxInput: InboxInput | undefined =
      inbox && invocation?.requesterUserId
        ? options.inboxBatch
          ? { ...options.inboxBatch, config: invocation.inputConfig }
          : {
              workspaceId: this.deps.workspaceId,
              sessionId,
              userId: invocation.requesterUserId,
              inputId: invocation.sourceTurnId,
              kind:
                this.operationInbox?.inputKind(
                  {
                    workspaceId: this.deps.workspaceId,
                    sessionId,
                    userId: invocation.requesterUserId,
                  },
                  invocation.sourceTurnId
                ) ?? 'task',
              config: invocation.inputConfig,
            }
        : undefined;
    try {
      if (inboxInput && inboxInput.kind !== 'automatic' && !(await inbox!.accept(inboxInput))) {
        releaseConflict();
        span.end({ outcome: 'inbox-paused' });
        return 'inbox-paused';
      }
    } catch (cause) {
      releaseConflict();
      span.end({ outcome: 'inbox-accept-failed' });
      throw cause;
    }
    let turnId!: string;
    let runtime!: TurnRuntimeState;
    try {
      turnId = this.deps.beginConversationTurn(sessionId, assistantEntryParentTurnId, {
        ...(options.dispatchSource ? { dispatchSource: options.dispatchSource } : {}),
        sessionDoc,
        deferACPUpdateTarget: true,
      });
      this.markCurrentTurn(sessionId, turnId);
      runtime = this.createTurnRuntime({ ...options, turnId });
      this.registerTurnRuntime(runtime);
    } finally {
      releaseConflict();
    }
    let inboxBatch = options.inboxBatch;
    try {
      if (inboxInput) {
        runtime.inboxOwner = await inbox!.openExecution(inboxInput, turnId, inboxBatch);
        inboxBatch = runtime.inboxOwner.batch;
        if (inboxBatch) {
          try {
            runtime.inboxNotificationWork = {
              userId: inboxBatch.userId,
              originTurnIds: this.notificationWork?.originsForBatch(inboxBatch) ?? [],
            };
          } catch (error) {
            // Missing notification provenance must not prevent actual work.
            this.deps.logger.warn(
              `[${sessionId}] Cannot read notification origins: ${formatErrorMessage(error)}`
            );
          }
        }
      }
    } catch (cause) {
      // Both pre-prompt exits below settle the user input without running it,
      // so the entry a crashed run left open has no owner: close it with them.
      const closeLeftoverEntry = () =>
        this.closeDeadAssistantTurn(sessionId, { turnId, requireSettledUserTurn: true }).catch(
          (closeCause: unknown) =>
            this.deps.logger.warn(
              `[${sessionId}] Failed to close leftover turn ${turnId}: ${formatErrorMessage(closeCause)}`
            )
        );
      try {
        // A rejected begin acquired nothing. Its deterministic ID can match an
        // older blocked execution, which only the recovery owner may release.
        if (
          inboxInput &&
          !(cause instanceof InboxExecutionBlocked) &&
          !(cause instanceof InboxExecutionRejected)
        )
          await inbox!.release({ ...inboxInput, executionId: turnId, outcome: 'failed' });
        this.releaseTurnRuntime(sessionId, turnId);
      } catch (releaseCause) {
        runtime.releaseFailure = new AggregateError(
          [cause, releaseCause],
          'Inbox preparation and release failed'
        );
      }
      if (cause instanceof InboxExecutionBlocked) {
        // Inbox preparation precedes the scoped turn error handler. Persist its
        // verified diagnostic here so a rejected send is not only a daemon log.
        await this.recordKnownChatFailure({
          sessionId,
          sessionDoc,
          userTurnId,
          reason: 'turn_pre_prompt_failed',
          message: blockedInboxRecoveryMessage(
            cause,
            { machineId: this.deps.machineId, workspaceId: this.deps.workspaceId, sessionId },
            process.platform
          ),
        });
        // Keep Inbox eligibility aligned with the terminal visible failure.
        // A repeated ID must not alter the original active input's evidence;
        // unrelated queued input is also untouched.
        if (inboxInput)
          await inbox!.abandonInput(this.deps.workspaceId, sessionId, inboxInput.inputId, true);
        await closeLeftoverEntry();
        span.end({ outcome: 'inbox-blocked' });
        throw cause;
      }
      if (
        !runtime.releaseFailure &&
        userTurnId &&
        inboxInput &&
        !options.inboxBatch &&
        inbox!.inputEnded(this.deps.workspaceId, sessionId, inboxInput.inputId)
      ) {
        // An ended input is never admitted again (no replay), so leaving its user
        // turn pending would make dispatch select it ahead of every later message.
        await this.retireEndedInboxInputTurn(sessionId, sessionDoc, userTurnId).catch(
          (retireCause: unknown) =>
            this.deps.logger.warn(
              `[${sessionId}] Failed to retire ended Inbox input ${userTurnId}: ${formatErrorMessage(retireCause)}`
            )
        );
        await closeLeftoverEntry();
        span.end({ outcome: 'inbox-input-ended' });
        return 'inbox-input-ended';
      }
      span.end({ outcome: 'inbox-prepare-failed' });
      throw cause;
    }
    const self = this;
    let assistantEntryOpened = false;
    let executionPermit: RealtimeStartPermit | undefined;
    let effectiveErrorContext: VisibleSessionTurnUnhandledErrorContext = {
      code: options.unhandledErrorCode,
      describe: options.describeUnhandledError,
      ...(options.onUnhandledError ? { onUnhandledError: options.onUnhandledError } : {}),
    };

    const program = Effect.scoped(
      Effect.acquireRelease(
        Effect.flatMap(Scope.Scope, (scope) => Scope.fork(scope)),
        (presenceScope, exit) =>
          Effect.gen(function* () {
            const turnRuntime = runtime;
            // Yielded-turn finalization is Lody's own bookkeeping, and its chain
            // catches every failure, so it always settles. A slow run is waited
            // for and only logged: treating it as a release failure would block
            // the session until a recovery that terminates its agent process.
            const yieldedFinalizationSettled = yield* Effect.interruptible(
              self.tryPromise(() => turnRuntime.yieldedFinalization)
            ).pipe(
              Effect.timeoutOption(YIELDED_FINALIZATION_SLOW_WARNING),
              Effect.orElseSucceed(() => Option.some(undefined))
            );
            if (Option.isNone(yieldedFinalizationSettled)) {
              self.deps.logger.warn(
                `[${sessionId}] Yielded turn finalization is still running after ${YIELDED_FINALIZATION_SLOW_WARNING}; turn ${turnRuntime.turnId} waits for it before release`
              );
            }
            yield* self
              .tryPromise(() => turnRuntime.yieldedFinalization)
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.sync(() => {
                    turnRuntime.releaseFailure = cause;
                  }).pipe(Effect.andThen(Effect.failCause(cause)))
                ),
                Effect.orDie
              );
            const wasInterrupted = Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause);
            const wasCancelled =
              turnRuntime.cancelRequested ||
              self.isTurnCancelled(sessionId, turnRuntime.turnId) ||
              wasInterrupted;
            if (turnRuntime.initializationStalled) {
              yield* self.finalizeStalledInitializationEffect(turnRuntime);
            } else if (wasCancelled) {
              yield* self.finalizeCancelledTurnEffect({
                sessionId,
                sessionDoc,
                turnId: turnRuntime.turnId,
                userTurnId: turnRuntime.userTurnId,
                session: turnRuntime.session,
                pendingSession: turnRuntime.pendingSession,
                terminateSession: turnRuntime.terminateSessionOnCancel,
                reportTurnError: self.shouldReportCancelledTurnError(turnRuntime),
              });
            }
            if (turnRuntime.disconnectedTransport && turnRuntime.session) {
              yield* self
                .tryPromise(() =>
                  withTimeout(
                    turnRuntime.session!.terminate(true),
                    5_000,
                    'Disconnected execution release timed out'
                  )
                )
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.sync(() => {
                      turnRuntime.releaseFailure = cause;
                    }).pipe(Effect.andThen(Effect.failCause(cause)))
                  ),
                  Effect.orDie
                );
            }
            // Raw work drains before presence clears; failed cleanup retains the Inbox owner.
            yield* Scope.close(presenceScope, exit).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  turnRuntime.releaseFailure = cause;
                }).pipe(Effect.andThen(Effect.failCause(cause)))
              )
            );
            if (!turnRuntime.releaseFailure && !inboxInput)
              self.releaseTurnRuntime(sessionId, turnRuntime.turnId);
          })
      ).pipe(
        Effect.flatMap((presenceScope) =>
          Effect.gen(function* () {
            if (
              yield* self.tryPromise(() =>
                isSessionCollaborationStopped(self.deps.workspaceDocument.repo, sessionId)
              )
            ) {
              runtime.cancelRequested = true;
              runtime.pendingInputOnCancel = 'preserve';
              return undefined;
            }
            const presenceLease = yield* Scope.provide(
              self.acquireSessionActivePresence(sessionId, 'initializing'),
              presenceScope
            );

            const setUnhandledErrorContext = (
              context: VisibleSessionTurnUnhandledErrorContext
            ): void => {
              effectiveErrorContext = context;
            };

            let branchObservedSession: ISession | undefined;
            const bindSession = (nextSession: ISession): void => {
              if (branchObservedSession !== nextSession) {
                branchObservedSession = nextSession;
                // Presentation metadata never gates the first agent prompt.
                void self.deps.syncSessionBranchName(sessionId, nextSession);
              }
              runtime.session = nextSession;
              runtime.pendingSession = undefined;
              runtime.startStage = undefined;
            };

            const trackPendingSession = Effect.fnUntraced(function* (
              pendingSession: Promise<ISession> | (() => Promise<ISession>),
              pendingOptions?: { terminateOnCancel?: boolean }
            ): Effect.fn.Return<ISession, unknown, never> {
              const pending = yield* Effect.try({
                try: () =>
                  typeof pendingSession === 'function' ? pendingSession() : pendingSession,
                catch: (error) => error,
              });
              runtime.pendingSession = pending;
              if (pendingOptions?.terminateOnCancel) {
                runtime.terminateSessionOnCancel = true;
              }
              return yield* self.tryPromise(() =>
                traceAsync(
                  self.deps.logger,
                  'execution.wait_pending_session',
                  { sessionId, turnId: runtime.turnId },
                  async () => await pending
                )
              );
            });

            const abortIfCancelled = Effect.fnUntraced(function* (cancelOptions?: {
              terminateSession?: boolean;
            }): Effect.fn.Return<void, unknown, never> {
              if (cancelOptions?.terminateSession) {
                runtime.terminateSessionOnCancel = true;
              }
              const userTurnWasCancelled = yield* self.tryPromise(() =>
                self.isUserTurnCancelled(sessionDoc, runtime.userTurnId)
              );
              if (
                !runtime.cancelRequested &&
                !self.isTurnCancelled(sessionId, runtime.turnId) &&
                !userTurnWasCancelled
              ) {
                // A completed create/restore fence must not override a later
                // keep cancellation after a replacement has been prepared.
                if (cancelOptions?.terminateSession) {
                  runtime.terminateSessionOnCancel = false;
                }
                return undefined;
              }
              yield* self.finalizeCancelledTurnEffect({
                sessionId,
                sessionDoc,
                turnId: runtime.turnId,
                userTurnId: runtime.userTurnId,
                session: runtime.session,
                pendingSession: runtime.pendingSession,
                terminateSession:
                  cancelOptions?.terminateSession ?? runtime.terminateSessionOnCancel,
                reportTurnError: self.shouldReportCancelledTurnError(runtime),
              });
              yield* Effect.fail(new SessionTurnCancelled({ sessionId, turnId: runtime.turnId }));
              return undefined;
            });

            const openAssistantEntry = Effect.fnUntraced(function* (openOptions?: {
              analytics?: VisibleSessionTurnAnalytics;
              unhandledErrorContext?: VisibleSessionTurnUnhandledErrorContext;
            }): Effect.fn.Return<void, unknown, never> {
              if (openOptions?.unhandledErrorContext) {
                effectiveErrorContext = openOptions.unhandledErrorContext;
              }
              const wasOpened = assistantEntryOpened;
              yield* self.tryPromise(() =>
                traceAsync(
                  self.deps.logger,
                  'execution.open_assistant_entry',
                  {
                    sessionId,
                    turnId: runtime.turnId,
                    ...(userTurnId ? { userTurnId } : {}),
                    alreadyOpened: wasOpened,
                  },
                  async () =>
                    await self.deps.createAssistantEntryForTurn(
                      sessionId,
                      sessionDoc,
                      runtime.turnId,
                      runtime.session?.agentClient?.currentModel,
                      assistantEntryParentTurnId
                    )
                )
              );
              if (wasOpened) {
                return undefined;
              }
              assistantEntryOpened = true;

              const analytics = openOptions?.analytics;
              if (analytics) {
                self.captureTurnStarted(sessionId, runtime.turnId, {
                  dispatchMode: analytics.dispatchMode,
                  hasReplayPrompt: false,
                  inputBlockCount: analytics.inputBlockCount,
                  dispatchSource: analytics.dispatchSource,
                  extra: {
                    ...(analytics.cliType ? { cliType: analytics.cliType } : {}),
                    ...(analytics.agentType ? { agentType: analytics.agentType } : {}),
                  },
                });
              }

              if (userTurnId) {
                yield* self.tryPromise(() =>
                  traceAsync(
                    self.deps.logger,
                    'execution.set_dispatch_processing',
                    { sessionId, turnId: runtime.turnId, userTurnId },
                    async () => await self.setDispatchProcessing(sessionId, sessionDoc, userTurnId)
                  )
                );
              }
              return undefined;
            });

            const prompt = Effect.fnUntraced(function* (
              promptBlocks: ContentBlock[]
            ): Effect.fn.Return<void, unknown, never> {
              const activeSession = runtime.session;
              const agentClient = activeSession?.agentClient;
              const acpSessionId = activeSession?.acpSessionId;
              if (!agentClient || !acpSessionId) {
                yield* Effect.fail(new Error('Agent session was not ready'));
                return undefined;
              }
              if (
                yield* self.tryPromise(() =>
                  isSessionCollaborationStopped(self.deps.workspaceDocument.repo, sessionId)
                )
              ) {
                runtime.cancelRequested = true;
                runtime.pendingInputOnCancel = 'preserve';
              }
              yield* abortIfCancelled();
              if (!runtime.promptStarted && options.onTurnStarted) {
                const started = yield* self.tryPromise(options.onTurnStarted).pipe(
                  Effect.mapError(
                    (cause) =>
                      new SessionTurnStartFenceFailed({
                        sessionId,
                        turnId: runtime.turnId,
                        cause,
                      })
                  ),
                  // Finalize while this runtime still owns the session; settlement is not success.
                  Effect.tapError(() =>
                    self.ignoreWithWarning(
                      sessionId,
                      'Failed to finalize a rejected input start fence',
                      self.tryPromise(() => self.handleTurnError(sessionId, sessionDoc))
                    )
                  )
                );
                if (!started) {
                  yield* Effect.fail(
                    new SessionTurnClaimContended({
                      sessionId,
                      turnId: runtime.turnId,
                    })
                  );
                  return undefined;
                }
              }

              if (inboxBatch && !runtime.promptStarted) {
                const members = yield* self.tryPromise(() => runtime.inboxOwner!.members());
                const historyMembers = batchHistoryMembers(inboxBatch, members);
                const backend = yield* self.tryPromise(() => createSessionBackend(sessionDoc));
                for (const member of historyMembers) {
                  const progressId = `operation-progress:${inboxBatch.sessionId}:${member.operationId}`;
                  const progress = yield* self.tryPromise(async () => backend.readTurn(progressId));
                  if (progress.state === 'ready') {
                    const completion = member.completion;
                    const items =
                      completion.type === 'result'
                        ? completion.value.items
                        : completion.type === 'cancelled'
                          ? (completion.partial?.items ?? [])
                          : [];
                    const linked = findProgressMessageId([progress.turn], {
                      requesterSessionId: inboxBatch.sessionId as SessionId,
                      operationId: member.operationId,
                      kind: member.operationKind,
                      items,
                      completion,
                    });
                    if (linked) member.progressMessageId = linked;
                  }
                }

                yield* self.tryPromise(() =>
                  backend.applyHistoryAction({
                    kind: 'upsert-turn',
                    turn: {
                      id:
                        inboxBatch!.kind === 'automatic'
                          ? inboxBatch!.inputId
                          : `operation-batch:${inboxBatch!.batchId}`,
                      role: 'system',
                      author: { v: 1, kind: 'system' },
                      userId: inboxBatch!.userId,
                      timestamp: new Date(getServerNow()).toISOString(),
                      finished: true,
                      fileDiff: [],
                      items: [
                        {
                          type: 'operation_completion_batch',
                          batchId: inboxBatch!.batchId,
                          memberCount: inboxBatch!.memberCount,
                          members: historyMembers,
                          deliveryStatus: 'prepared',
                        },
                      ],
                    },
                  })
                );
                promptBlocks = [
                  ...promptBlocks,
                  { type: 'text', text: batchPreview(inboxBatch, members) },
                ];
              }
              if (runtime.inboxOwner) {
                yield* self.tryPromise(() =>
                  runtime.inboxOwner!.register(sessionExecutionResource(activeSession))
                );
              }
              runtime.terminateSessionOnCancel = false;
              self.deps.activateConversationTurnForACPUpdates(sessionId, runtime.turnId);

              yield* Effect.acquireUseRelease(
                Effect.sync(() => {
                  runtime.promptInFlight = true;
                  return activeSession;
                }),
                () =>
                  self
                    .tryPromise((signal) =>
                      traceAsync(
                        self.deps.logger,
                        'execution.agent_prompt',
                        {
                          sessionId,
                          turnId: runtime.turnId,
                          acpSessionId,
                          promptBlocks: promptBlocks.length,
                        },
                        async () => {
                          const start = () => {
                            runtime.promptStarted = true;
                            const raw = agentClient.prompt(acpSessionId, promptBlocks, {
                              signal,
                              ...(runtime.goalControl ? { goalControl: runtime.goalControl } : {}),
                            });
                            runtime.rawPromptCompletion = raw.then(
                              () => undefined,
                              (cause) => {
                                runtime.disconnectedTransport = isAgentDisconnectedError(cause);
                              }
                            );
                            runtime.inboxOwner?.track(runtime.rawPromptCompletion!);
                            return raw;
                          };
                          const submitted = inboxInput
                            ? await runtime.inboxOwner!.submit(start)
                            : { value: start() };
                          const initialRun = self.createPromptHandoffRun({
                            turnId: runtime.turnId,
                            promptPromise: submitted.value,
                          });
                          if (inboxBatch) {
                            await (
                              await createSessionBackend(sessionDoc)
                            )
                              .applyHistoryAction({
                                kind: 'operation-batch-status',
                                batchId: inboxBatch.batchId,
                                turnId:
                                  inboxBatch.kind === 'automatic'
                                    ? inboxBatch.inputId
                                    : `operation-batch:${inboxBatch.batchId}`,
                                status: 'submitted',
                              })
                              .catch((cause) =>
                                self.deps.logger.warn(
                                  `Inbox history status projection failed: ${formatErrorMessage(cause)}`
                                )
                              );
                          }
                          await self.awaitPromptHandoffTail(runtime, initialRun);
                        }
                      )
                    )
                    .pipe(
                      Effect.catch((error) =>
                        Effect.sync(() => {
                          runtime.promptFailed = true;
                        }).pipe(Effect.flatMap(() => Effect.fail(error)))
                      )
                    ),
                () =>
                  Effect.sync(() => {
                    runtime.promptInFlight = false;
                    runtime.activePromptRun = undefined;
                  })
              );
              self.deps.clearActiveTurnId(sessionId, runtime.turnId);
              return undefined;
            });

            const claimExecution = Effect.fnUntraced(function* (): Effect.fn.Return<void, unknown> {
              const gate = self.deps.encryptedExecution;
              if (!gate && !self.deps.encryptedWorkspace) return undefined;
              yield* abortIfCancelled();
              const result =
                gate && userTurnId && options.invocation?.requesterUserId
                  ? yield* gate.claim({
                      workspaceId: self.deps.workspaceId,
                      sessionId,
                      userTurnId,
                      requesterUserId: options.invocation.requesterUserId,
                      inputConfig: options.invocation.inputConfig,
                    })
                  : { state: 'denied' as const };
              if (result.state === 'pending-evidence') {
                runtime.withdrawInboxExecution = true;
                return yield* Effect.fail(new SessionTurnExecutionDeferred());
              }
              if (result.state === 'claimed') {
                executionPermit = result.permit;
                // Authorization may have yielded while Stop was requested.
                yield* abortIfCancelled();
                return undefined;
              }
              if (result.state === 'completed' && userTurnId) {
                const backend = yield* self.tryPromise(() =>
                  self.getSessionBackend(sessionDoc, sessionId)
                );
                const history = yield* self.tryPromise(() =>
                  backend.readDispatchHistory([userTurnId])
                );
                if (
                  history.some(
                    (entry) =>
                      entry.id === userTurnId &&
                      ['handled', 'failed', 'canceled', 'delivery_unknown'].includes(
                        entry.status ?? ''
                      )
                  )
                ) {
                  return yield* Effect.fail(
                    new SessionTurnClaimContended({ sessionId, turnId: runtime.turnId })
                  );
                }
              }
              return yield* self.recordKnownChatFailureAndHaltEffect({
                sessionId,
                sessionDoc,
                userTurnId,
                reason: 'turn_pre_prompt_failed',
                message:
                  result.state === 'uncertain'
                    ? 'Result unknown. This encrypted turn may already have started and will not be started again. Send a new turn to continue.'
                    : result.state === 'completed'
                      ? 'This encrypted turn already finished and will not be started again.'
                      : result.state === 'expired'
                        ? 'This encrypted turn expired before execution. Send a new turn to continue.'
                        : 'This encrypted turn is not authorized for execution.',
              });
            });

            // Bound the whole turn against the initialization stall watchdog.
            // The watchdog only ever fires while the published presence status
            // is `initializing`, so a turn that reaches `running` races against
            // an effect that never completes and pays nothing.
            yield* Effect.raceFirst(
              body({
                turnId: runtime.turnId,
                runtime,
                setUnhandledErrorContext,
                bindSession,
                trackPendingSession,
                abortIfCancelled,
                openAssistantEntry,
                prompt,
                claimExecution,
              }),
              self.awaitInitializationStall(sessionId, sessionDoc, runtime, presenceLease)
            );
            if (executionPermit && self.deps.encryptedExecution) {
              // Execution never repeats to repair a failed result write. The
              // retained start remains uncertain and the actual turn can release.
              yield* self.ignoreWithWarning(
                sessionId,
                'Encrypted execution result remains unknown',
                self.deps.encryptedExecution.complete(executionPermit)
              );
            }
            return undefined;
          })
        )
      )
    );

    const fiber = Effect.runFork(program);
    runtime.fiber = fiber;
    // Failure bookkeeping is best effort and must never skip the release below.
    // When it throws too (for example a status write on a document that stopped
    // accepting writes), skipping the release would leave this registration in
    // place: every later input for the session is then refused as
    // `active-session`, and no recovery path owns the leaked slot.
    let failureHandlingError: unknown;
    try {
      await this.awaitTurnFiber(fiber, sessionId, turnId);
      if (outcome === 'unknown') {
        outcome = 'completed';
      }
    } catch (error) {
      try {
        outcome = await this.settleVisibleTurnFailure({
          sessionId,
          sessionDoc,
          runtime,
          error,
          errorContext: effectiveErrorContext,
        });
      } catch (handlingError) {
        failureHandlingError = handlingError;
        outcome = 'failure-handling-failed';
        this.deps.logger.error(
          `[${sessionId}] Failed to finalize failed turn ${runtime.turnId}; releasing it anyway (original error: ${formatErrorMessage(error)}): ${formatErrorMessage(handlingError)}`,
          handlingError
        );
      }
    } finally {
      if (!runtime.promptStarted) {
        this.deps.clearConversationTurn(sessionId, runtime.turnId);
      }
      span.end({ outcome, turnId });
    }
    await this.releaseVisibleTurn({
      sessionId,
      sessionDoc,
      runtime,
      inbox,
      inboxInput,
      inboxBatch,
      outcome,
    });
    if (failureHandlingError !== undefined) throw failureHandlingError;
    return outcome;
  }

  /** Classify a visible turn's failure and publish its user-visible result. */
  private async settleVisibleTurnFailure(options: {
    sessionId: SessionId;
    sessionDoc: SessionDocument;
    runtime: TurnRuntimeState;
    error: unknown;
    errorContext: VisibleSessionTurnUnhandledErrorContext;
  }): Promise<string> {
    const { sessionId, sessionDoc, runtime, error, errorContext } = options;
    if (error instanceof SessionTurnExecutionDeferred) return 'execution-deferred';
    if (isSessionTurnClaimContended(error)) {
      return 'claim-contended';
    }
    if (isSessionTurnStartFenceFailed(error)) {
      this.deps.logger.warn(
        `[${sessionId}] Input start fence failed before provider execution: ${formatErrorMessage(error.cause)}`
      );
      return 'start-fence-failed';
    }
    if (isSessionTurnHalted(error)) {
      runtime.notificationOutcome = { kind: 'failed', code: error.reason };
      await this.finalizeHaltedTurn({
        sessionId,
        sessionDoc,
        turnId: runtime.turnId,
        reason: error.reason,
      });
      return `halted-${error.reason}`;
    }
    if (
      isSessionTurnCancelled(error) ||
      runtime.cancelFinalized ||
      runtime.cancelRequested ||
      this.isTurnCancelled(sessionId, runtime.turnId) ||
      (await this.isUserTurnCancelled(sessionDoc, runtime.userTurnId))
    ) {
      const explicitlyCancelled =
        runtime.cancelRequested ||
        this.isTurnCancelled(sessionId, runtime.turnId) ||
        (await this.isUserTurnCancelled(sessionDoc, runtime.userTurnId));
      runtime.notificationOutcome = explicitlyCancelled
        ? { kind: 'cancelled' }
        : { kind: 'unknown', code: 'execution_interrupted' };
      return 'cancelled';
    }
    const parsedError = parseACPError(error);
    runtime.notificationOutcome = isAgentDisconnectedError(error)
      ? { kind: 'unknown', code: 'agent_disconnected' }
      : {
          kind: 'failed',
          code: parsedError ? mapACPErrorToFailureReason(parsedError) : errorContext.code,
        };
    await this.handleVisibleTurnUnhandledError({
      sessionId,
      sessionDoc,
      userTurnId: runtime.userTurnId,
      runtime,
      error,
      code: errorContext.code,
      describe: errorContext.describe,
      onUnhandledError: errorContext.onUnhandledError,
    });
    return 'unhandled-error-recorded';
  }

  /**
   * Hand the turn's Inbox execution back and drop its registration.
   *
   * Releasing a turn returns its ownership slot: in-flight ACP requests have
   * ended and the Inbox execution record is written. It does NOT terminate the
   * agent process, which stays alive for the next turn to reuse; only idle GC
   * (`LODY_SESSION_GC_IDLE_TIMEOUT_MS`, 20 minutes by default), memory-pressure
   * eviction, archive, or an abnormal path (an agent that ignores Stop, a lost
   * connection) ends it.
   *
   * A release that cannot be confirmed keeps `releaseFailure` and the slot, so
   * successors stay blocked until `recoverInboxExecution` proves release; the
   * next input that waits on this session requests that recovery.
   */
  private async releaseVisibleTurn(options: {
    sessionId: SessionId;
    sessionDoc: SessionDocument;
    runtime: TurnRuntimeState;
    inbox: OperationInboxLegacy | undefined;
    inboxInput: InboxInput | undefined;
    inboxBatch: InboxBatch | undefined;
    outcome: string;
  }): Promise<void> {
    const { sessionId, sessionDoc, runtime, inbox, inboxInput, inboxBatch, outcome } = options;
    try {
      const withdrawn =
        inboxInput &&
        runtime.withdrawInboxExecution &&
        !runtime.promptStarted &&
        !runtime.cancelRequested &&
        !runtime.releaseFailure &&
        (await runtime.inboxOwner!.withdraw().catch((cause: unknown) => {
          this.deps.logger.warn(
            `[${sessionId}] Inbox withdraw failed; releasing instead: ${formatErrorMessage(cause)}`
          );
          return false;
        }));
      if (inboxInput && !withdrawn) {
        if (inboxBatch)
          await (
            await createSessionBackend(sessionDoc)
          )
            .applyHistoryAction({
              kind: 'operation-batch-status',
              batchId: inboxBatch.batchId,
              turnId:
                inboxBatch.kind === 'automatic'
                  ? inboxBatch.inputId
                  : `operation-batch:${inboxBatch.batchId}`,
              status: !runtime.promptStarted
                ? 'not_submitted'
                : outcome === 'completed' && !runtime.promptFailed
                  ? 'settled'
                  : 'unknown',
            })
            .catch((cause) =>
              this.deps.logger.warn(
                `Inbox history status projection failed: ${formatErrorMessage(cause)}`
              )
            );
        await runtime.inboxOwner!.finish(
          runtime.cancelRequested || outcome === 'cancelled'
            ? 'user_stop'
            : outcome === 'completed' && !runtime.promptFailed && runtime.promptStarted
              ? 'normal'
              : 'failed',
          runtime.releaseFailure
        );
        if (runtime.inboxOwner!.failure) runtime.releaseFailure = runtime.inboxOwner!.failure;
      }
    } catch (cause) {
      runtime.releaseFailure ??= cause;
      throw cause;
    } finally {
      // Freeze the outcome before waking a successor; delivery owns no prompt slot.
      const fact = this.resolveTurnOutcomeFact(runtime, !!inboxInput);
      const completedAt = getServerNow();
      try {
        if (inboxInput && !runtime.releaseFailure) {
          this.releaseTurnRuntime(sessionId, runtime.turnId);
          if (outcome !== 'execution-deferred') {
            await inbox!.wake();
            this.onInboxReleased?.(sessionId);
          }
        }
      } finally {
        const notify = async () => {
          if (fact) await this.publishTurnOutcomeFact(fact);
        };
        // Failure attention is independent of successful delivery. Never delay it on sync.
        const completion = runtime.finalizeCompleted && !runtime.releaseFailure;
        const delivery = completion
          ? publishTurnCompletionLegacy({
              signal: this.completionPublicationAbort.signal,
              completedAt,
              sessionDoc,
              workspaceDocument: this.deps.workspaceDocument,
              notify: fact?.outcome.kind === 'succeeded' ? notify : async () => {},
            }).catch((error: unknown) => {
              this.deps.logger.warn(
                `[${sessionId}] Turn completion publication incomplete (turnId=${runtime.turnId}): ${formatErrorMessage(error)}`
              );
            })
          : Promise.resolve();
        const attention = fact?.outcome.kind !== 'succeeded' ? notify() : Promise.resolve();
        const owned = Promise.allSettled([delivery, attention]);
        this.ownedWork.add(owned);
        void owned.then(() => this.ownedWork.delete(owned));
      }
    }
  }

  /** Freeze provenance once the exact input is available; never changes authorization. */
  setTurnNotificationAudience(
    sessionId: SessionId,
    sourceTurnId: string,
    audience: TurnResultAudience
  ): void {
    const invocation = this.turnRuntimeBySession.get(sessionId)?.invocation;
    if (
      invocation?.sourceTurnId === sourceTurnId &&
      (!invocation.notificationAudience || invocation.notificationAudience.kind === 'unknown')
    ) {
      invocation.notificationAudience = { ...audience };
    }
  }

  private notificationOrigins(runtime: TurnRuntimeState): string[] {
    const invocation = runtime.invocation;
    return [
      ...new Set([
        ...(invocation?.notificationAudience?.kind === 'user' ? [invocation.sourceTurnId] : []),
        ...(runtime.inboxNotificationWork?.userId === invocation?.requesterUserId
          ? (runtime.inboxNotificationWork?.originTurnIds ?? [])
          : []),
      ]),
    ];
  }

  private resolveTurnOutcomeFact(
    runtime: TurnRuntimeState,
    hasInbox: boolean
  ): TurnOutcomeFact | undefined {
    const invocation = runtime.invocation;
    if (
      !this.deps.turnFinalization.onTurnOutcome ||
      !runtime.notificationOutcome ||
      !invocation?.requesterUserId
    )
      return undefined;
    // Stop can arrive while history/Inbox settlement is awaiting I/O.
    if (runtime.cancelRequested && !runtime.initializationStalled)
      runtime.notificationOutcome = { kind: 'cancelled' };
    else if (runtime.releaseFailure && runtime.notificationOutcome.kind !== 'cancelled')
      runtime.notificationOutcome = { kind: 'unknown', code: 'execution_release_failed' };
    const scope = {
      workspaceId: this.deps.workspaceId,
      sessionId: runtime.sessionId,
      userId: invocation.requesterUserId,
    };
    const origins = this.notificationOrigins(runtime);
    let completedOrigins = origins;
    // Failures need attention now. Success requires at least one original
    // human request to have no pending Operations or unconsumed results.
    if (runtime.notificationOutcome.kind === 'succeeded' && origins.length) {
      try {
        const pending = this.notificationWork?.pendingOrigins(scope, origins);
        if (pending) completedOrigins = origins.filter((origin) => !pending.has(origin));
        if ((hasInbox && !pending) || (pending && origins.every((origin) => pending.has(origin))))
          return undefined;
      } catch (error) {
        this.deps.logger.warn(
          `[${runtime.sessionId}] Cannot establish notification completion: ${formatErrorMessage(error)}`
        );
        return undefined;
      }
    }
    return {
      scope: { workspaceId: scope.workspaceId, recipientId: scope.userId },
      sessionId: runtime.sessionId,
      turnId: invocation.sourceTurnId,
      assistantTurnId: runtime.turnId,
      audience: origins.length
        ? { kind: 'user' }
        : (invocation.notificationAudience ?? { kind: 'unknown' }),
      outcome: { ...runtime.notificationOutcome },
      originTurnIds: completedOrigins,
    };
  }

  private async publishTurnOutcomeFact(fact: TurnOutcomeFact): Promise<void> {
    // Execution ownership is already released; a slow channel cannot hold the
    // Session's prompt slot or Inbox launch. The host drain owns this delivery.
    try {
      await this.deps.turnFinalization.onTurnOutcome?.(fact);
    } catch (error) {
      this.deps.logger.error(
        `[${fact.sessionId}] Turn notification submission failed: ${formatErrorMessage(error)}`
      );
    }
  }

  private markCurrentTurn(sessionId: SessionId, turnId: string): void {
    this.currentTurnBySession.set(sessionId, turnId);
  }

  private clearCurrentTurn(sessionId: SessionId, turnId?: string): void {
    const currentTurnId = this.currentTurnBySession.get(sessionId);
    if (!turnId || currentTurnId === turnId) {
      this.currentTurnBySession.delete(sessionId);
      const releasedTurnId = turnId ?? currentTurnId;
      if (releasedTurnId && this.turnRuntimeBySession.get(sessionId)?.turnId !== releasedTurnId) {
        this.resolveTurnReleaseWaiters(sessionId, releasedTurnId);
      }
    }
  }

  private async upsertSessionMeta(
    sessionId: SessionId,
    patch: Partial<SessionMeta>
  ): Promise<void> {
    const upsertDocMeta = this.deps.workspaceDocument.repo.upsertDocMeta?.bind(
      this.deps.workspaceDocument.repo
    );
    if (!upsertDocMeta) {
      return;
    }
    await upsertDocMeta(getSessionRoomId(sessionId), patch);
  }

  /**
   * Map the user turn's history entry to `status`. Returns whether a matching
   * entry existed locally — with RPC fast-path dispatch the turn can complete
   * before the web-written entry syncs here, in which case terminal statuses
   * must be recorded via {@link recordTerminalTurnWithoutEntry} so the late
   * entry is repaired instead of re-dispatched.
   */
  private async setUserTurnStatus(
    backend: SessionBackend,
    userTurnId: string,
    status: 'pending' | 'seen' | 'processing' | 'handled' | 'failed' | 'canceled',
    cancellationReason?: 'user_stop'
  ): Promise<boolean> {
    let matched = false;
    await backend
      .applyHistoryAction({
        kind: 'user-status',
        turnId: userTurnId,
        status,
        ...(status === 'canceled' ? { cancellationReason: cancellationReason } : {}),
      })
      .then((result) => {
        matched = result.matched ?? false;
      });
    return matched;
  }

  /** Per-session record of terminal turn statuses whose history entry was absent at write time. */
  private readonly terminalTurnStatusWithoutEntry = new Map<
    SessionId,
    Map<string, 'handled' | 'failed' | 'canceled'>
  >();
  private static readonly TERMINAL_TURN_RECORD_LIMIT = 16;

  private recordTerminalTurnWithoutEntry(
    sessionId: SessionId,
    userTurnId: string,
    status: 'handled' | 'failed' | 'canceled'
  ): void {
    let records = this.terminalTurnStatusWithoutEntry.get(sessionId);
    if (!records) {
      records = new Map();
      this.terminalTurnStatusWithoutEntry.set(sessionId, records);
    }
    records.delete(userTurnId);
    records.set(userTurnId, status);
    while (records.size > SessionExecutionService.TERMINAL_TURN_RECORD_LIMIT) {
      const oldest = records.keys().next().value;
      if (oldest === undefined) break;
      records.delete(oldest);
    }
  }

  private async setTerminalUserTurnStatus(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    userTurnId: string,
    status: 'handled' | 'failed' | 'canceled'
  ): Promise<void> {
    const meta = await this.getSessionMeta(sessionId);
    const backend = await createSessionBackend(sessionDoc, meta);
    if (meta?.steerTurnStatuses?.[userTurnId] === 'processing') {
      await this.setSteerHistoryStatus(sessionId, sessionDoc, userTurnId, status);
      return;
    }
    const matched = await this.setUserTurnStatus(
      backend,
      userTurnId,
      status,
      status === 'canceled'
        ? this.getInboxInputCancellationReason(sessionId, userTurnId)
        : undefined
    );
    if (!matched) {
      this.recordTerminalTurnWithoutEntry(sessionId, userTurnId, status);
    }
  }

  /**
   * Record a terminal outcome for a turn whose history entry is not visible
   * locally (used by the dispatch watcher when it denies an RPC-stashed turn).
   */
  recordTerminalUserTurnStatusWithoutEntry(
    sessionId: SessionId,
    userTurnId: string,
    status: 'handled' | 'failed' | 'canceled'
  ): void {
    this.recordTerminalTurnWithoutEntry(sessionId, userTurnId, status);
  }

  /** Terminal status recorded for a turn whose entry had not synced when it finished. */
  getTerminalUserTurnStatusWithoutEntry(
    sessionId: SessionId,
    userTurnId: string
  ): 'handled' | 'failed' | 'canceled' | undefined {
    return this.terminalTurnStatusWithoutEntry.get(sessionId)?.get(userTurnId);
  }

  /** Forget a terminal-without-entry record after the watcher repaired the late entry. */
  clearTerminalUserTurnStatusWithoutEntry(sessionId: SessionId, userTurnId: string): void {
    const records = this.terminalTurnStatusWithoutEntry.get(sessionId);
    records?.delete(userTurnId);
    if (records && records.size === 0) {
      this.terminalTurnStatusWithoutEntry.delete(sessionId);
    }
  }

  /** The `userTurnId` owned by the session's active turn runtime, if any. */
  getActiveUserTurnId(sessionId: SessionId): string | undefined {
    return this.turnRuntimeBySession.get(sessionId)?.userTurnId;
  }

  getActiveInvocationContext(sessionId: SessionId):
    | {
        requesterUserId: string;
        sourceTurnId: string;
        inputConfig: SessionTurnInputConfig;
        notificationOriginTurnIds: string[];
        notificationProvenancePending?: boolean;
      }
    | undefined {
    const runtime = this.turnRuntimeBySession.get(sessionId);
    if (
      !runtime ||
      runtime.cancelRequested ||
      runtime.releaseFailure ||
      (runtime.inboxOwner?.input &&
        this.isInboxInputCanceled(sessionId, runtime.inboxOwner?.input.inputId))
    ) {
      return undefined;
    }
    const { invocation } = runtime;
    if (!invocation?.requesterUserId) {
      throw new Error(`Active invocation identity is unavailable for session ${sessionId}`);
    }
    return {
      requesterUserId: invocation.requesterUserId,
      sourceTurnId: invocation.sourceTurnId,
      inputConfig: invocation.inputConfig,
      notificationOriginTurnIds: this.notificationOrigins(runtime),
      ...((!invocation.notificationAudience ||
        invocation.notificationAudience.kind === 'unknown') &&
      runtime.inboxOwner?.input?.kind !== 'automatic'
        ? { notificationProvenancePending: true }
        : {}),
    };
  }

  private async setDispatchProcessing(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    userTurnId: string
  ): Promise<void> {
    const backend = await this.getSessionBackend(sessionDoc, sessionDoc.sessionId);
    await this.setUserTurnStatus(backend, userTurnId, 'processing');
    await this.upsertSessionMeta(sessionId, {
      // Dispatch producers own `latestUserMsgId`. Execution only claims its
      // own processing slot, so an awaited status write can never overwrite a
      // newer activation published by another peer.
      processingUserMsgId: userTurnId,
    });
    await this.acknowledgeSteerTurn(sessionId, userTurnId);
  }

  private async transitionDispatchOwnership(options: {
    sessionId: SessionId;
    sessionDoc: SessionDocument;
    previousUserTurnId?: string;
    nextUserTurnId: string;
  }): Promise<void> {
    if (options.previousUserTurnId) {
      await this.setTerminalUserTurnStatus(
        options.sessionId,
        options.sessionDoc,
        options.previousUserTurnId,
        'handled'
      );
    }
    await this.setSteerHistoryStatus(
      options.sessionId,
      options.sessionDoc,
      options.nextUserTurnId,
      'processing',
      'applied'
    );
    await this.upsertSessionMeta(options.sessionId, {
      ...(options.previousUserTurnId ? { lastHandledUserMsgId: options.previousUserTurnId } : {}),
      processingUserMsgId: options.nextUserTurnId,
    });
  }

  private async clearDispatchProcessing(sessionId: SessionId): Promise<void> {
    await this.upsertSessionMeta(sessionId, {
      processingUserMsgId: undefined,
    });
  }

  private async clearCancelRequest(sessionId: SessionId): Promise<void> {
    await this.upsertSessionMeta(sessionId, {
      lastCanceledTurn: undefined,
    });
  }

  private markTurnCancelled(sessionId: SessionId, turnId: string): void {
    this.canceledTurnBySession.set(sessionId, turnId);
  }

  private isTurnCancelled(sessionId: SessionId, turnId: string): boolean {
    return this.canceledTurnBySession.get(sessionId) === turnId;
  }

  private clearTurnCancellation(sessionId: SessionId, turnId?: string): void {
    if (!turnId || this.canceledTurnBySession.get(sessionId) === turnId) {
      this.canceledTurnBySession.delete(sessionId);
    }
  }

  private async getSessionHistory(sessionDoc: SessionDocument): Promise<SessionHistoryInput[]> {
    const backend = await this.getSessionBackend(sessionDoc, sessionDoc.sessionId);
    return await backend.readHistory();
  }

  private async getSessionBackend(
    sessionDoc: SessionDocument,
    sessionId: SessionId
  ): Promise<SessionBackend> {
    return await createSessionBackend(sessionDoc, await this.getSessionMeta(sessionId));
  }

  /**
   * Read session history for a replay prompt, waiting briefly while it is empty.
   *
   * `SessionDocument.getHistory` is a local mirror read and never blocks on
   * sync, so right after a daemon restart it can hold only the turn that was
   * just delivered over RPC. A caller about to trade a resumable ACP session
   * for a fresh one needs to tell "this session genuinely has nothing to
   * replay" apart from "history has not arrived on this machine yet", and the
   * dispatch watcher's own wait only covers the pending user turn, not the
   * conversation before it.
   *
   * Bounded and best-effort: with no mirror to subscribe to there is nothing to
   * wait on, so the first read is returned as-is.
   */
  private async waitForReplayableHistory(args: {
    sessionId: SessionId;
    sessionDoc: SessionDocument;
    excludeTurnId?: string;
    timeoutMs?: number;
  }): Promise<SessionHistoryInput[]> {
    // Mirrors what `buildReplayPromptFromHistory` counts: system notices are
    // skipped there, so waiting must not treat a synced failure notice as
    // proof that the conversation arrived.
    const hasReplayableEntry = (history: SessionHistoryInput[]): boolean =>
      history.some(
        (entry) =>
          entry.id !== args.excludeTurnId && (entry.role === 'user' || entry.role === 'assistant')
      );

    let latest = await this.getSessionHistory(args.sessionDoc);
    if (hasReplayableEntry(latest)) {
      return latest;
    }

    // Control fields and history both count as wakeups; each check re-reads.
    const subscribe = (listener: () => void) => subscribeSessionChanges(args.sessionDoc, listener);

    const timeoutMs = args.timeoutMs ?? REPLAYABLE_HISTORY_SYNC_TIMEOUT_MS;
    const startedAtMs = Date.now();
    return await new Promise<SessionHistoryInput[]>((resolve) => {
      let settled = false;
      let checking = false;
      let recheckRequested = false;
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (history: SessionHistoryInput[]): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        unsubscribe?.();
        resolve(history);
      };

      const check = (): void => {
        if (settled) {
          return;
        }
        if (checking) {
          recheckRequested = true;
          return;
        }
        checking = true;
        void (async () => {
          try {
            do {
              recheckRequested = false;
              const next = await this.getSessionHistory(args.sessionDoc);
              if (settled) {
                return;
              }
              latest = next;
              if (hasReplayableEntry(next)) {
                this.deps.logger.debug(
                  `[${args.sessionId}] Replayable history synced after ${Date.now() - startedAtMs}ms (entries=${next.length})`
                );
                finish(next);
                return;
              }
            } while (recheckRequested);
          } catch (error) {
            this.deps.logger.debug(
              `[${args.sessionId}] Replay history check failed: ${formatErrorMessage(error)}`
            );
          } finally {
            checking = false;
          }
        })();
      };

      unsubscribe = subscribe(check);
      timer = setTimeout(() => {
        this.deps.logger.warn(
          `[${args.sessionId}] Session history did not sync within ${timeoutMs}ms; nothing to replay into a fresh ACP session`
        );
        finish(latest);
      }, timeoutMs);
      timer.unref?.();
      check();
    });
  }

  private async isUserTurnCancelled(
    sessionDoc: SessionDocument,
    userTurnId: string | undefined
  ): Promise<boolean> {
    if (!userTurnId) {
      return false;
    }
    const backend = await this.getSessionBackend(sessionDoc, sessionDoc.sessionId);
    const history = await backend.readDispatchHistory([userTurnId]);
    return history.some(
      (entry) => entry.id === userTurnId && entry.role === 'user' && entry.status === 'canceled'
    );
  }

  private async getSessionMeta(sessionId: SessionId): Promise<SessionMeta | undefined> {
    return (await this.deps.workspaceDocument.repo.getDocMeta(getSessionRoomId(sessionId)))
      ?.meta as SessionMeta | undefined;
  }

  private async markDispatchCancelled(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    userTurnId?: string
  ): Promise<void> {
    const existingMeta = await this.getSessionMeta(sessionId);
    const cancelledUserMsgId =
      userTurnId ?? existingMeta?.processingUserMsgId ?? existingMeta?.latestUserMsgId;
    if (cancelledUserMsgId) {
      await this.setTerminalUserTurnStatus(sessionId, sessionDoc, cancelledUserMsgId, 'canceled');
      await this.upsertSessionMeta(sessionId, {
        lastHandledUserMsgId: cancelledUserMsgId,
        processingUserMsgId: undefined,
      });
      return;
    }
    await this.clearDispatchProcessing(sessionId);
  }

  private async setDispatchHandled(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    userTurnId: string
  ): Promise<void> {
    await this.setTerminalUserTurnStatus(sessionId, sessionDoc, userTurnId, 'handled');
    await this.upsertSessionMeta(sessionId, {
      lastHandledUserMsgId: userTurnId,
      processingUserMsgId: undefined,
    });
  }

  /**
   * Did this turn emit anything the user can see?
   *
   * An ACP prompt that resolves without a single `session/update` produced no
   * answer, no tool call, nothing. The protocol says an upstream failure should
   * come back as a JSON-RPC error — `handleTurnError` classifies those — but an
   * adapter is free to swallow it and resolve the prompt normally, and some do
   * (observed: an over-context request answered with HTTP 400, recorded only in
   * the agent's own session file). Without this check that turn walks the entire
   * success path: `Session chat completed`, status idle, `lastHandledUserMsgId`
   * advanced, and NOTHING in the chat — the user sees an unanswered message and
   * every retry fails the same silent way.
   *
   * Must be read while the turn still owns the ACP update state, i.e. right
   * after the prompt returns and before `finalizeTurn` clears it.
   */
  private async turnProducedVisibleOutput(sessionId: SessionId, turnId: string): Promise<boolean> {
    // No observer wired, or transient state already gone: we cannot tell, and a
    // guess here would fail a turn that actually answered. Fail open.
    return (await this.deps.observePromptContentForTurn?.(sessionId, turnId)) ?? true;
  }

  /**
   * Terminal bookkeeping for a turn that ended without output: a visible notice,
   * a `failed` user turn, and the dispatch pointer still advanced. Advancing it
   * is deliberate — the prompt was delivered and re-dispatching it would spin
   * the same silent failure forever; the notice is what makes it visible.
   */
  private async recordSilentTurnFailure(options: {
    sessionId: SessionId;
    sessionDoc: SessionDocument;
    turnId: string;
    userTurnId?: string;
  }): Promise<void> {
    this.deps.logger.warn(
      `[${options.sessionId}] Turn ${options.turnId} completed without any agent output; ` +
        'recording it as a failed turn instead of a silent completion'
    );
    this.captureTurnFailed(options.sessionId, options.turnId, 'agent_no_output', false);
    await this.deps.recordChatFailure(
      options.sessionDoc,
      'agent_no_output',
      SILENT_TURN_FAILURE_MESSAGE
    );
    if (options.userTurnId) {
      await this.markTurnFailed(options.sessionId, options.sessionDoc, options.userTurnId);
    }
  }

  private async markTurnFailed(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    userTurnId: string
  ): Promise<void> {
    await this.setTerminalUserTurnStatus(sessionId, sessionDoc, userTurnId, 'failed');
    await this.upsertSessionMeta(sessionId, {
      lastHandledUserMsgId: userTurnId,
      processingUserMsgId: undefined,
    });
  }

  private resolveGitHubProjectBranch(
    meta: SessionMeta | undefined,
    preferredBranch?: string | null
  ): string {
    return resolveBaseBranchPreference({
      preferredBranch,
      baseBranch: meta?.baseBranch,
      project: meta?.project,
      fallbackBranch: this.deps.preferredBaseBranch,
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

  async continueSession(
    message: SessionChatRequestValidated,
    dispatchOptions?: SessionDispatchOptions
  ): Promise<void> {
    if (
      dispatchOptions?.dispatchSource === 'inbox' &&
      (!dispatchOptions.inboxBatch || !this.operationInbox)
    ) {
      throw new Error('INBOX_BATCH_REQUIRED');
    }
    const turn = await this.prepareContinueSessionTurn(message, dispatchOptions);
    if (
      dispatchOptions?.dispatchSource !== 'inbox' &&
      (await this.markCancelledUserTurnBeforeOwner({
        sessionId: message.sessionId,
        sessionDoc: turn.options.sessionDoc,
        userTurnId: message.userTurnId,
      }))
    ) {
      return;
    }
    const body = dispatchOptions?.onTurnClaimed
      ? (ctx: VisibleSessionTurnContext) =>
          Effect.promise(dispatchOptions.onTurnClaimed!).pipe(
            Effect.flatMap((claimed) =>
              claimed
                ? turn.body(ctx)
                : Effect.fail(
                    new SessionTurnClaimContended({
                      sessionId: message.sessionId,
                      turnId: ctx.turnId,
                    })
                  )
            )
          )
      : turn.body;
    await this.runVisibleSessionTurn(turn.options, body);
  }

  private async prepareContinueSessionTurn(
    message: SessionChatRequestValidated,
    dispatchOptions?: SessionDispatchOptions,
    prepareOptions?: { sessionDoc?: SessionDocument }
  ): Promise<VisibleSessionTurnPlan> {
    const { sessionId, acpSessionConfig, userId, userName, userEmail, userTurnId } = message;
    // System-caused turns own an assistant entry, not a user dispatch pointer.
    const executionUserTurnId =
      dispatchOptions?.dispatchSource === 'inbox' || dispatchOptions?.dispatchSource === 'goal'
        ? undefined
        : userTurnId;
    const sessionDoc =
      prepareOptions?.sessionDoc ??
      (await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId));

    this.deps.touchSession(sessionId);
    this.deps.logger.info(`Session chat received: ${sessionId}`);
    this.deps.logger.debug(`[${sessionId}] Received chat request (userTurnId=${userTurnId})`);

    const incomingProjectBranch =
      message.project?.kind === 'local' ? undefined : message.project?.branch?.trim();
    let session = this.deps.sessionManager.getSession(sessionId);
    let project: ProjectRef | undefined = message.project;
    const acpReplaySuppression = this.createAcpReplaySuppressionResource(sessionId);

    let replayPromptResult: ReplayPromptResult | null = null;
    let usedHistoryReplay = false;
    const self = this;
    const turnErrorContext: VisibleSessionTurnUnhandledErrorContext = {
      code: 'session_chat_failed',
      describe: (error) =>
        `[${sessionId}] Failed to process chat request: ${formatErrorMessage(error)}`,
    };
    const turnAnalytics: VisibleSessionTurnAnalytics = {
      dispatchMode: 'continue',
      inputBlockCount: resolveSessionExecutionInputBlocks(acpSessionConfig).length,
      ...(acpSessionConfig.cliType ? { cliType: acpSessionConfig.cliType } : {}),
      ...(acpSessionConfig.agentType ? { agentType: acpSessionConfig.agentType } : {}),
      ...(dispatchOptions?.dispatchSource
        ? { dispatchSource: dispatchOptions.dispatchSource }
        : {}),
    };

    const restoreMissingSession = Effect.fnUntraced(function* (
      ctx: VisibleSessionTurnContext
    ): Effect.fn.Return<ISession, unknown, Scope.Scope> {
      const meta = yield* self.tryPromise(() => sessionDoc.getMetaState());
      project = project ?? self.resolveProjectFromMeta(meta, message.project?.branch);
      const localProjectId = project?.kind === 'local' ? project.localProjectId : undefined;
      const restoreWorkdir = localProjectId
        ? ((yield* self.tryPromise(() => self.resolveLocalProjectWorkdirForTurn(localProjectId))) ??
          undefined)
        : undefined;
      if (project?.kind === 'local' && !restoreWorkdir) {
        const missingMessage = `Local project not found in workspace: ${project.localProjectId}`;
        self.deps.logger.warn(`[${sessionId}] ${missingMessage}`);
        return yield* self.recordKnownChatFailureAndHaltEffect({
          sessionId,
          sessionDoc,
          userTurnId: executionUserTurnId,
          reason: 'session_init_failed',
          message: missingMessage,
        });
      }
      if (meta?.isArchived) {
        self.deps.logger.warn(`[${sessionId}] Session is archived; refusing to resume chat`);
        return yield* self.recordKnownChatFailureAndHaltEffect({
          sessionId,
          sessionDoc,
          userTurnId: executionUserTurnId,
          reason: 'session_archived',
          message: 'Session is archived',
        });
      }

      if (
        meta?.cliType &&
        meta.agentType &&
        (meta.cliType !== acpSessionConfig.cliType || meta.agentType !== acpSessionConfig.agentType)
      ) {
        const mismatchMsg = `Session was created with ${meta.cliType}/${meta.agentType} but resume requested with ${acpSessionConfig.cliType}/${acpSessionConfig.agentType}`;
        self.deps.logger.warn(`[${sessionId}] Agent type mismatch: ${mismatchMsg}`);
        return yield* self.recordKnownChatFailureAndHaltEffect({
          sessionId,
          sessionDoc,
          userTurnId: executionUserTurnId,
          reason: 'agent_type_mismatch',
          message: mismatchMsg,
        });
      }

      const storedLaunchConfig = yield* self.tryPromise(() =>
        resolveSessionLaunchConfig({
          workspaceDocument: self.deps.workspaceDocument,
          workspaceId: self.deps.workspaceId,
          machineId: self.deps.machineId,
          sessionId,
          sessionMeta: meta ?? undefined,
          logger: self.deps.logger,
        })
      );
      const agentConfigEnv = storedLaunchConfig.config?.env;
      const resumeCustomAcp =
        acpSessionConfig.customAcp ?? storedLaunchConfig.config?.customAcp ?? undefined;
      const resumeRuntimeOverrides =
        acpSessionConfig.runtimeOverrides ??
        storedLaunchConfig.config?.runtimeOverrides ??
        undefined;
      self.deps.logger.debug(
        `[${sessionId}] Resume env resolved (agentConfigId=${meta?.agentConfigId ?? 'none'} source=${storedLaunchConfig.source} keys=${agentConfigEnv ? Object.keys(agentConfigEnv).length : 0})`
      );

      const requestedResumeSessionId = acpSessionConfig.resume;
      const storedResumeSessionId = resolveResumableAcpSessionId(meta);
      const resumeSessionId = requestedResumeSessionId ?? storedResumeSessionId;
      const resumeSource = requestedResumeSessionId
        ? 'request'
        : storedResumeSessionId
          ? 'meta'
          : 'none';

      self.deps.logger.debug(
        `[${sessionId}] Session not found in memory; restoring (project=${
          project?.kind === 'github'
            ? project.repoFullName
            : project?.kind === 'local'
              ? `local:${project.localProjectId}`
              : 'none'
        } resume=${resumeSessionId ? 'yes' : 'no'} resumeSource=${resumeSource} resumeSessionId=${resumeSessionId ?? 'none'})`
      );

      self.deps.setSessionActivePresencePhase(sessionId, 'resuming');
      yield* self.tryPromise(() =>
        sessionDoc.setStatus(SessionStatusFactory.initializing('resuming'))
      );
      self.captureStatusChanged(sessionId, 'initializing', 'resuming', 'session_restore');
      self.deps.logger.debug(
        `[${sessionId}] Resuming status published; preparing session restore (resumeSource=${resumeSource} resumeSessionId=${resumeSessionId ?? 'none'})`
      );
      // Resuming an ACP process must not resolve or switch branches in a
      // local project. That is true both for the registered project directory
      // and for an existing session worktree: the user's current branch is
      // part of the workspace state being resumed.
      const restoreBranch = project?.branch?.trim() || undefined;
      const restoreConfig: SessionConfig = {
        projectRun: meta?.projectRun,
        sessionId,
        agentConfigId: meta?.agentConfigId,
        codexAuth: storedLaunchConfig.config?.codexAuth,
        workspaceId: message.workspaceId,
        agentCliType: acpSessionConfig.cliType,
        agentType: acpSessionConfig.agentType,
        modelId: acpSessionConfig.modelId,
        configOptionValues: acpSessionConfig.configOptionValues,
        memory: acpSessionConfig.memory,
        mcpServerIds: acpSessionConfig.mcpServerIds ?? [],
        customAcp: resumeCustomAcp,
        runtimeOverrides: resumeRuntimeOverrides,
        magpieGatewayUrl:
          acpSessionConfig.magpieGatewayUrl ?? storedLaunchConfig.config?.magpieGatewayUrl,
        requesterUserId: userId,
        machineId: self.deps.machineId,
        assumeDocExisting: true,
        env: agentConfigEnv,
        githubRepo: resolveProjectGitHubRepo(project),
        branch: restoreBranch,
        restoreBranchName: meta?.branchName?.trim() || undefined,
        project,
        resume: true,
        workdir: restoreWorkdir,
        parentSessionId: meta?.parentSessionId,
        userName,
        userEmail,
        onPresencePhase: (phase, detail) => {
          if (
            self.turnRuntimeBySession.get(sessionId) === ctx.runtime &&
            !ctx.runtime.initializationStalled &&
            !ctx.runtime.cancelRequested
          )
            self.deps.setSessionActivePresencePhase(sessionId, phase, detail);
        },
        onStartStage: (stage) => {
          if (self.turnRuntimeBySession.get(sessionId) === ctx.runtime)
            ctx.runtime.startStage = stage;
        },
      };

      const restoreAttempt = Effect.gen(function* () {
        if (resumeSessionId) {
          yield* acpReplaySuppression.acquire;
        }
        self.deps.logger.debug(
          `[${sessionId}] Session restore createSession started (resumeSessionId=${resumeSessionId ?? 'none'})`
        );
        const restoredSession = yield* self.startWithTransientRetry({
          sessionId,
          runtime: ctx.runtime,
          config: restoreConfig,
          abortIfCancelled: ctx.abortIfCancelled,
          start: () =>
            ctx.trackPendingSession(
              () =>
                self.deps.sessionManager.createSession(restoreConfig, {
                  resumeSessionId,
                }),
              { terminateOnCancel: true }
            ),
        });
        self.deps.logger.debug(
          `[${sessionId}] Session restore createSession returned (acpSessionId=${restoredSession.acpSessionId ?? 'null'})`
        );
        ctx.bindSession(restoredSession);
        yield* ctx.abortIfCancelled({ terminateSession: true });
        const requested = resumeSessionId;
        const actual = restoredSession.acpSessionId ?? null;
        if (requested) {
          self.deps.logger.debug(
            `[${sessionId}] Session restore result (requestedAcpSessionId=${requested} actualAcpSessionId=${actual ?? 'null'} resumed=${actual === requested ? 'yes' : 'no'})`
          );
        } else {
          self.deps.logger.debug(
            `[${sessionId}] Session restore result (requestedAcpSessionId=none actualAcpSessionId=${actual ?? 'null'})`
          );

          // An earlier turn can fail before ACP owns its prompt (for example
          // while its process is starting). There is then no ACP session id
          // to resume, even though the user turn is durable in Loro history.
          // This freshly created ACP session has no knowledge of that turn,
          // so reconstruct its context before sending the current request.
          const history = self.getSessionHistory(sessionDoc);
          const historySnapshot = yield* self.tryPromise(() => history);
          if (historySnapshot.length > 0) {
            replayPromptResult = buildReplayPromptFromHistory({
              history: historySnapshot,
              excludeTurnId: message.userTurnId,
            });
            if (replayPromptResult.stats.messagesIncluded > 0) {
              usedHistoryReplay = true;
              self.deps.logger.debug(
                `[${sessionId}] Built replay prompt for fresh ACP restore (chars=${replayPromptResult.stats.usedChars} messages=${replayPromptResult.stats.messagesIncluded} paths=${replayPromptResult.stats.pathsCount} truncated=${replayPromptResult.stats.truncated} terminalOmitted=${replayPromptResult.stats.terminalOmitted} thinkingOmitted=${replayPromptResult.stats.thinkingOmitted})`
              );
            } else {
              replayPromptResult = null;
            }
          }
        }
        return restoredSession;
      });

      return yield* restoreAttempt.pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* ctx.abortIfCancelled();
            const errMessage = formatErrorMessage(error);
            const lowerMessage = errMessage.toLowerCase();
            const isAcpResumeError =
              lowerMessage.includes('acp_resume_unsupported') ||
              lowerMessage.includes('acp_resume_failed');
            // An expired credential is recoverable and session-scoped: the
            // agent's transcript is still on disk and `loadSession` works
            // again once the user signs back in. The fallback below would
            // instead create a fresh ACP session and overwrite
            // `meta.acpSessionId`, permanently detaching this session from
            // that transcript over a failure that fixes itself. Ask for
            // sign-in and keep the resume pointer intact.
            const needsAuthentication =
              error instanceof AcpAuthenticationRequiredError ||
              isAuthenticationRequiredACPError(error);

            if (isAcpResumeError && resumeSessionId && !needsAuthentication) {
              self.deps.logger.debug(
                `[${sessionId}] ACP resume failed, attempting fallback with chat history replay`
              );
              yield* acpReplaySuppression.release;

              // Built BEFORE the replacement session exists. Creating it
              // first persists a new `acpSessionId`, so discovering only
              // afterwards that there is nothing to replay would already have
              // destroyed the last pointer back to the agent's transcript.
              const replayHistory = yield* self.tryPromise(() =>
                self.waitForReplayableHistory({
                  sessionId,
                  sessionDoc,
                  excludeTurnId: message.userTurnId,
                })
              );
              const fallbackReplay =
                replayHistory.length > 0
                  ? buildReplayPromptFromHistory({
                      history: replayHistory,
                      excludeTurnId: message.userTurnId,
                    })
                  : null;

              if (!fallbackReplay || fallbackReplay.stats.messagesIncluded === 0) {
                // A session that had a resumable ACP session necessarily had
                // prior turns, so an empty local history means this machine's
                // history CRDT has not caught up rather than that the
                // conversation is empty. Replacing the agent silently here is
                // what turns "resume failed" into "the agent forgot
                // everything", so fail the turn and keep the pointer.
                self.deps.logger.error(
                  `[${sessionId}] Refusing context-free fallback restore (resumeSessionId=${resumeSessionId} historyEntries=${replayHistory.length})`
                );
                return yield* self.recordKnownChatFailureAndHaltEffect({
                  sessionId,
                  sessionDoc,
                  userTurnId: executionUserTurnId,
                  reason: 'session_restore_failed',
                  message: CONTEXT_FREE_RESTORE_MESSAGE,
                });
              }

              const fallbackConfig: SessionConfig = {
                ...restoreConfig,
              };

              const fallbackAttempt = Effect.gen(function* () {
                self.deps.logger.debug(`[${sessionId}] Fallback restore createSession started`);
                const fallbackSession = yield* ctx.trackPendingSession(
                  () => self.deps.sessionManager.createSession(fallbackConfig),
                  { terminateOnCancel: true }
                );
                self.deps.logger.debug(
                  `[${sessionId}] Fallback restore createSession returned (acpSessionId=${fallbackSession.acpSessionId ?? 'null'})`
                );
                ctx.bindSession(fallbackSession);
                yield* ctx.abortIfCancelled({ terminateSession: true });
                usedHistoryReplay = true;
                replayPromptResult = fallbackReplay;

                self.deps.logger.debug(
                  `[${sessionId}] Built replay prompt (chars=${fallbackReplay.stats.usedChars} messages=${fallbackReplay.stats.messagesIncluded} paths=${fallbackReplay.stats.pathsCount} truncated=${fallbackReplay.stats.truncated} terminalOmitted=${fallbackReplay.stats.terminalOmitted} thinkingOmitted=${fallbackReplay.stats.thinkingOmitted})`
                );
                return fallbackSession;
              });

              return yield* fallbackAttempt.pipe(
                Effect.catch((fallbackError) =>
                  Effect.gen(function* () {
                    yield* ctx.abortIfCancelled();
                    const fallbackNeedsAuthentication =
                      fallbackError instanceof AcpAuthenticationRequiredError ||
                      isAuthenticationRequiredACPError(fallbackError);
                    const fallbackErrMessage = fallbackNeedsAuthentication
                      ? formatReportedError(fallbackError)
                      : describeSessionStartFailure(
                          ctx.runtime.startStage,
                          formatReportedError(fallbackError)
                        );
                    self.deps.logger.error(
                      `[${sessionId}] Fallback restore also failed: ${fallbackErrMessage}`,
                      fallbackError
                    );
                    return yield* self.recordKnownChatFailureAndHaltEffect({
                      sessionId,
                      sessionDoc,
                      userTurnId: executionUserTurnId,
                      reason: fallbackNeedsAuthentication
                        ? 'acp_auth_required'
                        : 'session_restore_failed',
                      message: fallbackErrMessage,
                    });
                  })
                )
              );
            }

            yield* acpReplaySuppression.release;
            const failureMessage = needsAuthentication
              ? errMessage
              : describeSessionStartFailure(ctx.runtime.startStage, formatReportedError(error));
            self.deps.logger.error(
              `[${sessionId}] Failed to restore session for chat: ${failureMessage}`,
              error
            );
            return yield* self.recordKnownChatFailureAndHaltEffect({
              sessionId,
              sessionDoc,
              userTurnId: executionUserTurnId,
              // `needsAuthentication` also covers a provider auth failure that
              // arrives wrapped as `[ACP_RESUME_FAILED] …`; without it the UI
              // reports a generic restore failure and offers no way to sign in.
              reason: needsAuthentication ? 'acp_auth_required' : 'session_restore_failed',
              message: failureMessage,
            });
          })
        )
      );
    });

    const runReadySessionTurn = Effect.fnUntraced(function* (
      readySession: ISession,
      ctx: VisibleSessionTurnContext
    ): Effect.fn.Return<void, unknown, Scope.Scope> {
      const { turnId, runtime, abortIfCancelled, openAssistantEntry, prompt } = ctx;
      let activeSession = readySession;
      let staleAcpPromptRecoveryAttempted = false;
      let baseCommitHash: string | null = null;
      let turnStartWorkingTreeDiff: GitWorkingTreeDiffBaseline | null = null;

      // A requester switch re-derives commit identity for this turn only;
      // the bounded policy lookup falls back to owner rules on failure.
      const gitIdentityOptions = yield* self.tryPromise(async (signal) => {
        try {
          return await self.deps.sessionManager.resolveGitIdentityOptions(
            message.userId,
            signal,
            sessionId
          );
        } catch {
          signal.throwIfAborted();
          return {
            preferMachineIdentity: message.userId === self.deps.userId,
            personalIdentityEnabled: false,
          };
        }
      });
      const bindReadySession = (nextSession: ISession): void => {
        activeSession = nextSession;
        session = nextSession;
        ctx.bindSession(nextSession);
        nextSession.updateGitIdentity(userName, userEmail, message.userId, gitIdentityOptions);
      };

      const sessionInputBlocks = resolveSessionExecutionInputBlocks(acpSessionConfig);
      const buildPromptBlocksForCurrentResumeState = (): Promise<ContentBlock[]> =>
        traceAsync(
          self.deps.logger,
          'execution.build_acp_prompt_blocks',
          { sessionId, turnId, inputBlocks: sessionInputBlocks.length },
          async () =>
            await self.deps.buildAcpPromptBlocks({
              workspaceId: message.workspaceId,
              sessionId,
              inputBlocks: sessionInputBlocks,
              issuePRMentions: acpSessionConfig.issuePRMentions,
              replayPromptText:
                usedHistoryReplay && replayPromptResult?.promptText
                  ? replayPromptResult.promptText
                  : undefined,
            })
        );

      const maybeRecordHistoryReplayNotice = Effect.fnUntraced(function* (): Effect.fn.Return<
        void,
        unknown,
        never
      > {
        if (!usedHistoryReplay || !replayPromptResult) {
          return undefined;
        }
        const history = yield* self.tryPromise(() => self.getSessionHistory(sessionDoc));
        if (hasRecentResumeNotice(history)) {
          return undefined;
        }

        type SessionHistoryItemInput = NonNullable<SessionHistoryInput['items']>[number];
        const noticeMeta = replayPromptResult.noticeMeta;
        const noticeItem: SessionHistoryItemInput =
          noticeMeta && Object.keys(noticeMeta).length > 0
            ? {
                type: 'system_notice',
                text: undefined,
                name: 'resume_from_external_chat_history',
                meta: noticeMeta,
              }
            : {
                type: 'system_notice',
                text: undefined,
                name: 'resume_from_external_chat_history',
              };
        const now = getServerNow();
        const systemNotice: SessionHistoryInput = {
          id: `system-notice-${now}`,
          role: 'system',
          timestamp: new Date(now).toISOString(),
          read: undefined,
          userId: undefined,
          fileDiff: [],
          items: [noticeItem],
        };
        const backend = yield* self.tryPromise(() => self.getSessionBackend(sessionDoc, sessionId));
        yield* self.tryPromise(() =>
          backend.applyHistoryAction({
            kind: 'upsert-turn',
            turn: systemNotice,
            beforeLastUser: true,
          })
        );
        return undefined;
      });

      const applyPromptConfig = (
        targetSession: ISession,
        triggerReason: 'initial' | 'stale_acp_recovery'
      ): Effect.Effect<void, unknown, never> =>
        self.tryPromise((signal) =>
          traceAsync(
            self.deps.logger,
            'execution.apply_acp_mode_model',
            { sessionId, turnId, triggerReason },
            async () =>
              await self.deps.applyAcpModeAndModel(
                targetSession,
                {
                  ...acpSessionConfig,
                  configOptionValues: acpSessionConfig.configOptionValues,
                },
                {
                  sessionDoc,
                  basedOnUserTurnId: executionUserTurnId,
                  signal,
                }
              )
          )
        );

      const validatePromptCredentials = Effect.fnUntraced(function* (
        targetSession: ISession,
        triggerReason: 'initial' | 'stale_acp_recovery'
      ): Effect.fn.Return<void, unknown, never> {
        // Validate this runtime's owner-bound authority before submitting a turn.
        yield* self.tryPromise(() =>
          traceAsync(
            self.deps.logger,
            'execution.validate_credentials',
            { sessionId, turnId, triggerReason },
            async () =>
              await self.deps.sessionManager.validateSessionCredentials(targetSession, userId)
          )
        );
        return undefined;
      });

      const capturePromptBaseline = Effect.fnUntraced(function* (
        targetSession: ISession,
        triggerReason: 'initial' | 'stale_acp_recovery'
      ): Effect.fn.Return<void, unknown, never> {
        const workdir = targetSession.getWorkdir();
        const runGit: GitRunner = (args) => targetSession.exec('git', args, workdir, false);
        baseCommitHash = yield* self.tryPromise(() =>
          traceAsync(
            self.deps.logger,
            'execution.get_base_commit_hash',
            { sessionId, turnId, triggerReason },
            async () => await getCurrentCommitHash(runGit)
          )
        );
        turnStartWorkingTreeDiff = yield* self.tryPromise(() =>
          traceAsync(
            self.deps.logger,
            'execution.capture_worktree_diff_baseline',
            { sessionId, turnId, triggerReason },
            async () => await captureGitWorkingTreeDiffBaseline(runGit)
          )
        );
        runtime.project = project;
        runtime.baseCommitHash = baseCommitHash;
        runtime.turnStartWorkingTreeDiff = turnStartWorkingTreeDiff;
        return undefined;
      });

      // Inbox has already crossed its durable start fence before prompt submission.
      // A disconnected transport with no observed output cannot prove non-consumption.
      // Encrypted turns also retain their start evidence instead of retrying an
      // uncertain submission. Ordinary turns keep their bounded recovery.
      const promptWithStaleACPRecovery = (
        promptBlocks: ContentBlock[]
      ): Effect.Effect<void, unknown, Scope.Scope> =>
        prompt(promptBlocks).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const hasPromptEvents =
                self.deps.hasPromptEventsForTurn?.(sessionId, runtime.turnId) ?? true;
              if (
                self.deps.encryptedWorkspace ||
                Boolean(self.deps.encryptedExecution) ||
                dispatchOptions?.dispatchSource === 'inbox' ||
                Boolean(dispatchOptions?.inboxBatch) ||
                Boolean(ctx.runtime.inboxOwner?.batch) ||
                runtime.turnId !== turnId ||
                !shouldRecoverStaleACPConnectionPrompt({
                  error,
                  alreadyAttempted: staleAcpPromptRecoveryAttempted,
                  hasPromptOutput: hasPromptEvents,
                })
              ) {
                return yield* Effect.fail(error);
              }

              staleAcpPromptRecoveryAttempted = true;
              const hadHistoryReplay = usedHistoryReplay;
              self.deps.logger.warn(
                `[${sessionId}] ACP prompt failed because the connection was stale; restoring session before one retry`
              );
              yield* abortIfCancelled();
              // Replacing this runtime continues the same logical turn. Ordinary
              // termination publishes agent-death events that finalize its history
              // owner before the replacement prompt can produce output. Keep the
              // old runtime bound until retirement succeeds, so failed cleanup is
              // still owned by the disconnected-execution finalizer.
              runtime.disconnectedTransport = true;
              yield* self.tryPromise(() =>
                self.deps.sessionManager.retireSessionForReconfiguration(activeSession)
              );
              runtime.disconnectedTransport = false;
              runtime.cancellationDrain = undefined;
              session = null;
              runtime.session = undefined;
              runtime.pendingSession = undefined;

              const restoredSession = yield* restoreMissingSession(ctx);
              bindReadySession(restoredSession);
              yield* acpReplaySuppression.release;
              yield* applyPromptConfig(restoredSession, 'stale_acp_recovery');
              yield* maybeRecordHistoryReplayNotice();
              yield* validatePromptCredentials(restoredSession, 'stale_acp_recovery');
              yield* capturePromptBaseline(restoredSession, 'stale_acp_recovery');

              let retryPromptBlocks = promptBlocks;
              if (usedHistoryReplay && !hadHistoryReplay && replayPromptResult?.promptText) {
                retryPromptBlocks = yield* self.tryPromise(() =>
                  buildPromptBlocksForCurrentResumeState()
                );
              }

              runtime.promptFailed = false;
              yield* abortIfCancelled();
              return yield* prompt(retryPromptBlocks);
            })
          )
        );

      bindReadySession(readySession);
      yield* acpReplaySuppression.release;
      self.deps.setSessionActivePresencePhase(sessionId, 'thinking');
      yield* self.tryPromise(() => sessionDoc.setStatus(SessionStatusFactory.running()));
      self.captureStatusChanged(sessionId, 'running', undefined, 'chat_dispatch');
      self.scheduleLiveActivitySummarySync(userId, {
        sessionId,
        triggerReason: 'chat_dispatch',
        status: 'running',
      });

      const promptBlocksPromise = buildPromptBlocksForCurrentResumeState();
      void promptBlocksPromise.catch(() => undefined);

      yield* applyPromptConfig(activeSession, 'initial');
      yield* maybeRecordHistoryReplayNotice();

      yield* abortIfCancelled();

      const promptBlocks = yield* self.tryPromise(() => promptBlocksPromise);

      yield* abortIfCancelled();

      yield* validatePromptCredentials(activeSession, 'initial');
      yield* capturePromptBaseline(activeSession, 'initial');

      yield* abortIfCancelled();

      yield* openAssistantEntry();

      yield* abortIfCancelled();

      yield* promptWithStaleACPRecovery(promptBlocks);
      yield* self.tryPromise(() => runtime.yieldedFinalization);

      const completedTurnId = runtime.turnId;
      const completedUserTurnId = runtime.userTurnId ?? executionUserTurnId;
      const completedRequesterUserId = runtime.invocation?.requesterUserId ?? userId;
      // Read before finalization clears the turn's ACP update state.
      const producedOutput = yield* self.tryPromise(() =>
        self.turnProducedVisibleOutput(sessionId, completedTurnId)
      );

      yield* self.tryPromise(() =>
        traceAsync(
          self.deps.logger,
          'execution.mark_prompt_completed',
          { sessionId, turnId: completedTurnId },
          async () =>
            await self.markPromptWorkingEnded(
              sessionId,
              sessionDoc,
              completedRequesterUserId,
              'prompt_completed'
            )
        )
      );

      yield* abortIfCancelled();

      runtime.finalizeStarted = true;
      yield* self.tryPromise((signal) =>
        traceAsync(
          self.deps.logger,
          'execution.finalize_turn',
          { sessionId, turnId: completedTurnId },
          async () =>
            await self.finalizeTurn({
              sessionId,
              session: activeSession,
              sessionDoc,
              turnId: completedTurnId,
              baseCommitHash,
              turnStartWorkingTreeDiff,
              project,
              producedOutput,
              isTurnCancelled: () => self.isTurnCancelled(sessionId, completedTurnId),
              abortSignal: signal,
            })
        )
      );
      runtime.finalizeCompleted = true;

      yield* abortIfCancelled();

      if (!producedOutput) {
        runtime.promptFailed = true;
        yield* self.tryPromise(() =>
          traceAsync(
            self.deps.logger,
            'execution.record_silent_turn_failure',
            {
              sessionId,
              turnId: completedTurnId,
              ...(completedUserTurnId ? { userTurnId: completedUserTurnId } : {}),
            },
            async () =>
              await self.recordSilentTurnFailure({
                sessionId,
                sessionDoc,
                turnId: completedTurnId,
                ...(completedUserTurnId ? { userTurnId: completedUserTurnId } : {}),
              })
          )
        );
      } else if (completedUserTurnId) {
        yield* self.tryPromise(() =>
          traceAsync(
            self.deps.logger,
            'execution.set_dispatch_handled',
            {
              sessionId,
              turnId: completedTurnId,
              userTurnId: completedUserTurnId,
            },
            async () => await self.setDispatchHandled(sessionId, sessionDoc, completedUserTurnId)
          )
        );
      }

      yield* abortIfCancelled();

      self.clearTurnCancellation(sessionId, completedTurnId);

      yield* self
        .tryPromise(() =>
          traceAsync(
            self.deps.logger,
            'execution.process_message_queue',
            { sessionId, turnId: completedTurnId },
            async () => await self.deps.processMessageQueue(sessionId)
          )
        )
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              self.deps.logger.error(
                `[${sessionId}] Failed to process message queue after chat completion: ${formatErrorMessage(error)}`
              );
            })
          )
        );
    });

    return {
      options: {
        sessionId,
        sessionDoc,
        ...(dispatchOptions?.inboxBatch ? { inboxBatch: dispatchOptions.inboxBatch } : {}),
        ...(session ? { session } : {}),
        userTurnId: executionUserTurnId,
        invocation: {
          sourceTurnId: userTurnId,
          requesterUserId: userId,
          inputConfig: acpSessionConfig,
          notificationAudience: dispatchOptions?.notificationAudience,
        },
        ...(dispatchOptions?.dispatchSource === 'inbox'
          ? { assistantEntryParentTurnId: userTurnId }
          : {}),
        ...(dispatchOptions?.goalControl ? { goalControl: dispatchOptions.goalControl } : {}),
        ...(dispatchOptions?.onTurnStarted ? { onTurnStarted: dispatchOptions.onTurnStarted } : {}),
        ...(dispatchOptions?.dispatchSource
          ? { dispatchSource: dispatchOptions.dispatchSource }
          : {}),
        unhandledErrorCode: turnErrorContext.code,
        describeUnhandledError: turnErrorContext.describe,
      },
      body: (ctx) =>
        Effect.gen(function* () {
          ctx.setUnhandledErrorContext(turnErrorContext);
          yield* ctx.claimExecution();
          const memoryPressureResult = yield* self.tryPromise(() =>
            self.evictForTurnStart(sessionId)
          );
          if (memoryPressureResult.stillUnderPressure) {
            const failureMessage = self.formatMemoryPressureFailureMessage(memoryPressureResult);
            self.deps.logger.warn(`[${sessionId}] ${failureMessage}`);
            yield* self.recordKnownChatFailureAndHaltEffect({
              sessionId,
              sessionDoc,
              userTurnId: executionUserTurnId,
              reason: 'memory_pressure',
              message: failureMessage,
            });
          }
          if (incomingProjectBranch) {
            yield* self.tryPromise(() => sessionDoc.setBaseBranch(incomingProjectBranch));
          }
          yield* ctx.openAssistantEntry({
            analytics: turnAnalytics,
            unhandledErrorContext: turnErrorContext,
          });

          self.deps.setSessionActivePresencePhase(sessionId, 'initializing');
          // Publish initializing as soon as the turn owns the session, so live UI
          // shows Working from dispatch instead of only after setStatus(running)
          // once the ACP session is ready. Runs after the duplicate-dispatch guard
          // so it can never overwrite a running turn's status.
          yield* self.tryPromise(() => sessionDoc.setStatus(SessionStatusFactory.initializing()));
          self.captureStatusChanged(sessionId, 'initializing', undefined, 'chat_dispatch');

          let readySession = session;
          if (
            readySession &&
            JSON.stringify(readySession.getMemoryBinding?.() ?? null) !==
              JSON.stringify(acpSessionConfig.memory ?? null)
          ) {
            yield* ctx.abortIfCancelled();
            const previousSession = readySession;
            yield* self.tryPromise(() =>
              self.deps.sessionManager.retireSessionForReconfiguration(previousSession)
            );
            readySession = null;
            session = null;
          }
          if (
            readySession &&
            (!readySession.agentClient?.isCreated() || !readySession.acpSessionId)
          ) {
            const pending = self.deps.sessionManager.getPendingSession(sessionId);
            if (pending) {
              self.deps.logger.debug(
                `[${sessionId}] Session is still initializing; waiting for readiness`
              );
              readySession = yield* ctx.trackPendingSession(pending).pipe(
                Effect.catch((error: unknown) =>
                  Effect.gen(function* () {
                    yield* ctx.abortIfCancelled();
                    const errMessage = formatErrorMessage(error);
                    const acpError = parseACPError(error);
                    // Pending-session startup historically owns the
                    // session/init_failed analytics bucket. Only auth-required
                    // needs a distinct reason so the UI can offer sign-in.
                    const mappedFailureReason = acpError
                      ? mapACPErrorToFailureReason(acpError)
                      : null;
                    const failureReason =
                      mappedFailureReason === 'acp_auth_required'
                        ? mappedFailureReason
                        : 'session_init_failed';
                    self.deps.logger.error(
                      `[${sessionId}] Session initialization failed while handling chat: ${errMessage}`
                    );
                    return yield* self.recordKnownChatFailureAndHaltEffect({
                      sessionId,
                      sessionDoc,
                      userTurnId: executionUserTurnId,
                      reason: failureReason,
                      message:
                        failureReason === 'acp_auth_required' && acpError
                          ? getACPErrorUserMessage(acpError)
                          : errMessage,
                    });
                  })
                )
              );
              session = readySession;
              yield* ctx.abortIfCancelled();
            }
          }

          if (!readySession) {
            readySession = yield* restoreMissingSession(ctx);
          } else {
            ctx.bindSession(readySession);
          }

          yield* ctx.abortIfCancelled();

          // After restoreMissingSession (always succeeds with ISession) or the else branch,
          // readySession is guaranteed non-null. TypeScript cannot narrow `let` through `yield*`,
          // so we assert here.
          const resolvedSession = readySession as ISession;

          if (!resolvedSession.agentClient?.isCreated() || !resolvedSession.acpSessionId) {
            yield* ctx.abortIfCancelled();
            yield* acpReplaySuppression.release;
            self.deps.logger.warn(
              `[${sessionId}] ACP session is not ready for chat; terminating broken session to allow recreation`
            );
            yield* self.ignoreWithWarning(
              sessionId,
              'Failed to terminate broken session',
              self.tryPromise(() => resolvedSession.terminate(true))
            );
            yield* self.recordKnownChatFailureAndHaltEffect({
              sessionId,
              sessionDoc,
              userTurnId: executionUserTurnId,
              reason: 'acp_not_ready',
              message: 'Agent session was not ready. Please try again.',
            });
          }

          yield* runReadySessionTurn(resolvedSession, ctx);
        }),
    };
  }

  async startSession(
    message: SessionCreateRequestValidated,
    dispatchOptions?: SessionDispatchOptions
  ): Promise<void> {
    const turn = await this.prepareStartSessionTurn(message, dispatchOptions);
    const userTurnId =
      typeof message.userTurnId === 'string' && message.userTurnId.trim()
        ? message.userTurnId.trim()
        : undefined;
    if (
      await this.markCancelledUserTurnBeforeOwner({
        sessionId: message.sessionId,
        sessionDoc: turn.options.sessionDoc,
        userTurnId,
      })
    ) {
      return;
    }
    await this.runVisibleSessionTurn(turn.options, turn.body);
  }

  private async prepareStartSessionTurn(
    message: SessionCreateRequestValidated,
    dispatchOptions?: SessionDispatchOptions,
    prepareOptions?: { sessionDoc?: SessionDocument }
  ): Promise<VisibleSessionTurnPlan> {
    const { sessionId, acpSessionConfig, workspaceId, env } = message;
    const userTurnId =
      typeof message.userTurnId === 'string' && message.userTurnId.trim()
        ? message.userTurnId.trim()
        : undefined;
    let project = message.project;
    const workdir =
      project?.kind === 'local'
        ? ((await this.resolveLocalProjectWorkdirForTurn(project.localProjectId)) ?? undefined)
        : undefined;
    this.deps.logger.info(`Session create received: ${sessionId}`);

    const agentConfig = acpSessionConfig;
    const promptText = agentConfig.prompt ?? '';
    const promptBytes = Buffer.byteLength(promptText, 'utf8');
    const promptPreview = promptText.length > 200 ? `${promptText.slice(0, 200)}…` : promptText;
    const sessionDoc =
      prepareOptions?.sessionDoc ??
      (await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId));

    const existingMeta = await sessionDoc.getMetaState();
    // A persisted ACP session id proves that this direct local Session has run
    // before. It can later be re-initialized when that ACP session is no longer
    // resumable. Its stored branch was only a snapshot from the original
    // creation, so checking it out here would rewrite the user's current
    // workspace (and fails when it has local changes). New sessions write their
    // project metadata before dispatch but do not yet have an ACP session id,
    // so they must retain an explicitly requested branch. Worktree sessions
    // still keep their explicit base branch semantics.
    const hasPriorAcpSession = Boolean(existingMeta?.acpSessionId?.trim());
    if (
      project?.kind === 'local' &&
      project.useWorktree !== true &&
      existingMeta?.project?.kind === 'local' &&
      hasPriorAcpSession
    ) {
      const { branch: _legacyBranch, ...directProject } = project;
      project = directProject;
    }
    const githubRepoFullName = resolveProjectGitHubRepo(project);
    const shouldPrepareWorktree =
      (project?.kind === 'github' && !!githubRepoFullName) ||
      (project?.kind === 'local' && project.useWorktree === true);
    // Shared child workspaces and restored ACP sessions retain their branch identity.
    const newWorktree =
      shouldPrepareWorktree &&
      !message.parentSessionId &&
      !hasPriorAcpSession &&
      !acpSessionConfig.resume;
    let branch = project?.branch?.trim() || undefined;
    const fromFeedbackPostId =
      message.meta?.fromFeedbackPostId?.trim() ||
      existingMeta?.fromFeedbackPostId?.trim() ||
      undefined;

    const configForLog = {
      sessionId,
      workspaceId,
      machineId: message.machineId,
      promptConfig: {
        cliType: agentConfig.cliType,
        agentType: agentConfig.agentType,
        promptBytes,
        promptPreview,
        modeId: agentConfig.modeId,
        modelId: agentConfig.modelId,
        resume: agentConfig.resume,
      },
      env: summarizeEnvForLog(env),
      githubRepo: githubRepoFullName,
      branch,
      project,
      projectRun: existingMeta?.projectRun ?? message.projectRun,
      worktreeSetup: message.worktreeSetup,
      worktreeCleanup: message.worktreeCleanup,
      fromFeedbackPostId,
    };
    this.deps.logger.debug(`[${sessionId}] session/create summary`, configForLog);
    const sessionConfig: SessionConfig = {
      sessionId,
      workspaceId,
      agentCliType: acpSessionConfig.cliType,
      agentType: acpSessionConfig.agentType,
      modelId: acpSessionConfig.modelId,
      configOptionValues: acpSessionConfig.configOptionValues,
      memory: acpSessionConfig.memory,
      mcpServerIds: acpSessionConfig.mcpServerIds ?? [],
      agentConfigId: existingMeta?.agentConfigId,
      customAcp: acpSessionConfig.customAcp,
      runtimeOverrides: acpSessionConfig.runtimeOverrides,
      magpieGatewayUrl: acpSessionConfig.magpieGatewayUrl,
      requesterUserId: message.userId,
      machineId: this.deps.machineId,
      assumeDocExisting: true,
      env,
      githubRepo: githubRepoFullName,
      branch,
      project,
      projectRun: existingMeta?.projectRun ?? message.projectRun,
      worktreeSetup: message.worktreeSetup,
      worktreeCleanup: message.worktreeCleanup,
      workdir,
      parentSessionId: message.parentSessionId,
      userName: message.userName,
      userEmail: message.userEmail,
    };

    // Fold the dispatch-start meta fields into the status transition so the
    // latency-critical create path performs one doc-meta upsert instead of five
    // sequential ones.
    const dispatchStartPatch: Partial<SessionMeta> = {};
    if (!existingMeta?.projectRun && message.projectRun) {
      // The creation snapshot cannot claim daemon-observed branches or status.
      const initialRun = structuredClone(message.projectRun);
      for (const member of Object.values(initialRun.members)) {
        delete member.branch;
        delete member.repoFullName;
        delete member.dirty;
        delete member.unpushed;
        delete member.diff;
      }
      sessionConfig.projectRun = initialRun;
      dispatchStartPatch.projectRun = initialRun;
    }
    if (project) {
      dispatchStartPatch.project = project;
    }
    if (userTurnId) {
      dispatchStartPatch.latestUserMsgId = userTurnId;
    }
    if (branch && project?.kind !== 'local') {
      dispatchStartPatch.baseBranch = branch;
    }
    if (fromFeedbackPostId && existingMeta?.fromFeedbackPostId !== fromFeedbackPostId) {
      dispatchStartPatch.fromFeedbackPostId = fromFeedbackPostId;
    }
    // acp/agent_config_used (spec §8c, P0): enrich session start with the agent
    // identity + launcher family. Non-PII: only cli_type/agent_type/launcher.
    captureCli(
      'acp/agent_config_used',
      {
        ...this.baseSessionAnalyticsProps(sessionId, {
          cliType: acpSessionConfig.cliType,
          agentType: acpSessionConfig.agentType,
        }),
        launcher: this.resolveLauncherForAgent(
          acpSessionConfig.cliType,
          acpSessionConfig.agentType,
          acpSessionConfig.customAcp
        ),
        ...(acpSessionConfig.modeId ? { mode_id: acpSessionConfig.modeId } : {}),
        ...(acpSessionConfig.modelId ? { model_id: acpSessionConfig.modelId } : {}),
        is_resume: !!acpSessionConfig.resume,
      },
      { tier: 'A' }
    );
    const startSessionStartedAtMs = getServerNow();

    const self = this;
    const turnErrorContext: VisibleSessionTurnUnhandledErrorContext = {
      code: 'session_create_failed',
      describe: (error) => `[${sessionId}] Failed to create session: ${formatErrorMessage(error)}`,
      onUnhandledError: async () => {
        await self.deps.sessionManager.setSessionError(sessionId, 'execution_error');
      },
    };
    const turnAnalytics: VisibleSessionTurnAnalytics = {
      dispatchMode: 'start',
      inputBlockCount: resolveSessionExecutionInputBlocks(agentConfig).length,
      ...(agentConfig.cliType ? { cliType: agentConfig.cliType } : {}),
      ...(agentConfig.agentType ? { agentType: agentConfig.agentType } : {}),
      ...(dispatchOptions?.dispatchSource
        ? { dispatchSource: dispatchOptions.dispatchSource }
        : {}),
    };
    return {
      options: {
        sessionId,
        sessionDoc,
        userTurnId,
        ...(userTurnId
          ? {
              invocation: {
                sourceTurnId: userTurnId,
                requesterUserId: message.userId,
                inputConfig: acpSessionConfig,
              },
            }
          : {}),
        ...(dispatchOptions?.dispatchSource
          ? { dispatchSource: dispatchOptions.dispatchSource }
          : {}),
        unhandledErrorCode: turnErrorContext.code,
        describeUnhandledError: turnErrorContext.describe,
        ...(turnErrorContext.onUnhandledError
          ? { onUnhandledError: turnErrorContext.onUnhandledError }
          : {}),
      },
      body: ({
        turnId,
        runtime,
        setUnhandledErrorContext,
        bindSession,
        trackPendingSession,
        abortIfCancelled,
        openAssistantEntry,
        prompt,
        claimExecution,
      }) =>
        Effect.gen(function* () {
          setUnhandledErrorContext(turnErrorContext);
          yield* claimExecution();
          const memoryPressureResult = yield* self.tryPromise(() =>
            self.evictForTurnStart(sessionId)
          );
          if (memoryPressureResult.stillUnderPressure) {
            const failureMessage = self.formatMemoryPressureFailureMessage(memoryPressureResult);
            self.deps.logger.warn(`[${sessionId}] ${failureMessage}`);
            return yield* self.recordKnownChatFailureAndHaltEffect({
              sessionId,
              sessionDoc,
              userTurnId,
              reason: 'memory_pressure',
              message: failureMessage,
            });
          }
          yield* self.tryPromise(async () => {
            await sessionDoc.setStatus(SessionStatusFactory.initializing(), dispatchStartPatch);
            self.captureStatusChanged(sessionId, 'initializing', undefined, 'session_create');
          });
          yield* openAssistantEntry({
            analytics: turnAnalytics,
            unhandledErrorContext: turnErrorContext,
          });

          yield* abortIfCancelled();
          if (project?.kind === 'local') {
            if (!workdir) {
              yield* Effect.fail(
                new Error(`Local project not found in workspace: ${project.localProjectId}`)
              );
              return undefined;
            }
            if (branch) {
              const requestedBranch = branch;
              const preparedBranch = yield* self.tryPromise(() =>
                self.prepareLocalProjectBranch({
                  project,
                  workdir,
                  branch: requestedBranch,
                  onBaseRefResolved: async (baseRef) => {
                    await self.upsertSessionMeta(sessionId, { baseBranch: baseRef });
                    await self.deps.workspaceDocument.persistPendingChanges(
                      'session-local-base-ref'
                    );
                  },
                })
              );
              branch = preparedBranch.executionBranch;
              sessionConfig.branch = branch;
            }
          }
          if (shouldPrepareWorktree) {
            self.deps.setSessionActivePresencePhase(sessionId, 'git-clone');
            yield* self.tryPromise(() =>
              sessionDoc.setStatus(SessionStatusFactory.initializing('git-clone'))
            );
            self.captureStatusChanged(sessionId, 'initializing', 'git-clone', 'session_create');
          }

          const startPromptBlocksBuild = async (session: ISession) => {
            let branchToRename: string | undefined;
            if (newWorktree) {
              try {
                // Setup may have changed the checkout, including on prepared adoption.
                const currentBranch = (
                  await session.exec(
                    'git',
                    ['branch', '--show-current'],
                    session.getWorkdir(),
                    false
                  )
                ).trim();
                if (isAllocatedSessionBranchName(currentBranch, sessionId)) {
                  branchToRename = currentBranch;
                }
              } catch (error) {
                self.deps.logger.debug(
                  `[${sessionId}] Skipping branch naming after Git probe failure: ${formatErrorMessage(error)}`
                );
              }
            }
            const projectRun =
              !hasPriorAcpSession && !message.parentSessionId
                ? (await sessionDoc.getMetaState())?.projectRun
                : undefined;
            const projectFileRoots = projectRun
              ? await resolveProjectFileRoots(
                  session.getWorkdir(),
                  projectRun,
                  self.deps.machineId,
                  (id) => self.deps.sessionManager.resolveLocalProjectRootPath(id)
                )
              : undefined;
            const sessionInputBlocks = resolveSessionExecutionInputBlocks({
              ...agentConfig,
              prompt: buildPrompt(
                agentConfig.prompt,
                project,
                agentConfig.issuePRMentions,
                fromFeedbackPostId,
                {
                  branchToRename,
                  projectRun,
                  projectFileRoots,
                }
              ),
            });
            return traceAsync(
              self.deps.logger,
              'execution.build_acp_prompt_blocks',
              { sessionId, turnId, inputBlocks: sessionInputBlocks.length },
              async () =>
                await self.deps.buildAcpPromptBlocks({
                  workspaceId,
                  sessionId,
                  inputBlocks: sessionInputBlocks,
                })
            );
          };

          // An abandoned startup may report after its successor has begun.
          // Capture the exact Turn owner, not a session-id lookup at callback time.
          sessionConfig.onPresencePhase = (phase, detail) => {
            if (
              self.turnRuntimeBySession.get(sessionId) === runtime &&
              !runtime.initializationStalled &&
              !runtime.cancelRequested
            )
              self.deps.setSessionActivePresencePhase(sessionId, phase, detail);
          };
          sessionConfig.onStartStage = (stage) => {
            if (self.turnRuntimeBySession.get(sessionId) === runtime) runtime.startStage = stage;
          };
          sessionConfig.worktreeScriptHistoryInsertBeforeEntryId = turnId;
          const session = yield* self.startWithTransientRetry({
            sessionId,
            runtime,
            config: sessionConfig,
            abortIfCancelled,
            start: () =>
              trackPendingSession(() => self.deps.sessionManager.createSession(sessionConfig), {
                terminateOnCancel: true,
              }),
          });
          bindSession(session);
          self.scheduleCreatedSessionCapabilityUpdate(session, sessionConfig);
          yield* abortIfCancelled({ terminateSession: true });
          // Use the live initialize result, including on the first uncached launch.
          if (
            !acpOwnsSessionTitleGeneration(
              sessionConfig.agentCliType,
              sessionConfig.agentType,
              acpSessionConfig.runtimeOverrides,
              session.getAcpCapabilities?.()?.sessionTitle
            )
          ) {
            void self.deps.maybeGenerateAndStoreSessionTitle(
              sessionId,
              sessionConfig.agentCliType,
              sessionConfig.agentType,
              // Name the user's task, not the composed Config/Role execution prompt.
              resolveSessionAuthoredText(agentConfig),
              env,
              acpSessionConfig.customAcp,
              acpSessionConfig.runtimeOverrides
            );
          }
          // First-turn attachments are materialized under the session workspace.
          // Start this as soon as createSession has registered the workspace, but
          // do not start it earlier or attachments fall back to "unavailable".
          const promptBlocksPromise = startPromptBlocksBuild(session);
          void promptBlocksPromise.catch(() => undefined);

          self.deps.setSessionActivePresencePhase(sessionId, 'thinking');
          yield* self.tryPromise(() => sessionDoc.setStatus(SessionStatusFactory.running()));
          self.captureStatusChanged(sessionId, 'running', undefined, 'session_create');
          self.scheduleLiveActivitySummarySync(sessionConfig.requesterUserId, {
            sessionId,
            triggerReason: 'session_create',
            status: 'running',
          });
          // session/init_completed (spec §5b, P0): the create reached a running
          // ACP session. total_init_ms covers create dispatch → process ready.
          captureCli(
            'session/init_completed',
            {
              ...self.baseSessionAnalyticsProps(sessionId, {
                cliType: sessionConfig.agentCliType,
                agentType: sessionConfig.agentType,
              }),
              total_init_ms: getServerNow() - startSessionStartedAtMs,
              git_clone_required: shouldPrepareWorktree,
              acp_resume_honored: !!session.acpSessionId,
            },
            { tier: 'A' }
          );
          // Register with the ACP idle timer so the process is recycled after inactivity.
          // continueSession() does this at its top, but startSession creates the process
          // independently and would otherwise be invisible to the idle timer.
          self.deps.touchSession(sessionId);
          self.deps.logger.debug(
            `[${sessionId}] session ready (workdir=${session.getWorkdir()} acpSessionId=${session.acpSessionId ?? 'null'})`
          );
          yield* self.tryPromise((signal) =>
            traceAsync(
              self.deps.logger,
              'execution.apply_acp_mode_model',
              { sessionId, turnId },
              async () =>
                await self.deps.applyAcpModeAndModel(
                  session,
                  {
                    ...agentConfig,
                    configOptionValues: agentConfig.configOptionValues,
                  },
                  {
                    sessionDoc,
                    basedOnUserTurnId: userTurnId,
                    signal,
                  }
                )
            )
          );

          yield* abortIfCancelled();

          const containerWorkdir = session.getWorkdir();
          const runGit: GitRunner = (args) => session.exec('git', args, containerWorkdir, false);
          const baseCommitHash = yield* self.tryPromise(() =>
            traceAsync(
              self.deps.logger,
              'execution.get_base_commit_hash',
              { sessionId, turnId },
              async () => await getCurrentCommitHash(runGit)
            )
          );
          const turnStartWorkingTreeDiff = yield* self.tryPromise(() =>
            traceAsync(
              self.deps.logger,
              'execution.capture_worktree_diff_baseline',
              { sessionId, turnId },
              async () => await captureGitWorkingTreeDiffBaseline(runGit)
            )
          );
          runtime.project = project;
          runtime.baseCommitHash = baseCommitHash;
          runtime.turnStartWorkingTreeDiff = turnStartWorkingTreeDiff;

          yield* abortIfCancelled();

          yield* openAssistantEntry();

          const promptBlocks = yield* self.tryPromise(() => promptBlocksPromise);
          yield* self.tryPromise(() =>
            self.deps.sessionManager.validateSessionCredentials(
              session,
              sessionConfig.requesterUserId
            )
          );
          yield* abortIfCancelled();

          yield* prompt(promptBlocks);
          yield* self.tryPromise(() => runtime.yieldedFinalization);

          const completedTurnId = runtime.turnId;
          const completedUserTurnId = runtime.userTurnId ?? userTurnId;
          const completedRequesterUserId =
            runtime.invocation?.requesterUserId ?? sessionConfig.requesterUserId;
          // Read before finalization clears the turn's ACP update state.
          const producedOutput = yield* self.tryPromise(() =>
            self.turnProducedVisibleOutput(sessionId, completedTurnId)
          );

          yield* self.tryPromise(() =>
            traceAsync(
              self.deps.logger,
              'execution.mark_prompt_completed',
              { sessionId, turnId: completedTurnId },
              async () =>
                await self.markPromptWorkingEnded(
                  sessionId,
                  sessionDoc,
                  completedRequesterUserId,
                  'prompt_completed'
                )
            )
          );

          yield* abortIfCancelled();

          runtime.finalizeStarted = true;
          yield* self.tryPromise((signal) =>
            traceAsync(
              self.deps.logger,
              'execution.finalize_turn',
              { sessionId, turnId: completedTurnId },
              async () =>
                await self.finalizeTurn({
                  sessionId,
                  session,
                  sessionDoc,
                  turnId: completedTurnId,
                  baseCommitHash,
                  turnStartWorkingTreeDiff,
                  project,
                  producedOutput,
                  isTurnCancelled: () => self.isTurnCancelled(sessionId, completedTurnId),
                  abortSignal: signal,
                })
            )
          );
          runtime.finalizeCompleted = true;

          yield* abortIfCancelled();

          if (!producedOutput) {
            runtime.promptFailed = true;
            yield* self.tryPromise(() =>
              traceAsync(
                self.deps.logger,
                'execution.record_silent_turn_failure',
                {
                  sessionId,
                  turnId: completedTurnId,
                  ...(completedUserTurnId ? { userTurnId: completedUserTurnId } : {}),
                },
                async () =>
                  await self.recordSilentTurnFailure({
                    sessionId,
                    sessionDoc,
                    turnId: completedTurnId,
                    ...(completedUserTurnId ? { userTurnId: completedUserTurnId } : {}),
                  })
              )
            );
          } else if (completedUserTurnId) {
            yield* self.tryPromise(() =>
              traceAsync(
                self.deps.logger,
                'execution.set_dispatch_handled',
                {
                  sessionId,
                  turnId: completedTurnId,
                  userTurnId: completedUserTurnId,
                },
                async () =>
                  await self.setDispatchHandled(sessionId, sessionDoc, completedUserTurnId)
              )
            );
          }

          yield* abortIfCancelled();

          self.clearTurnCancellation(sessionId, completedTurnId);

          yield* self.tryPromise(() =>
            traceAsync(
              self.deps.logger,
              'execution.process_message_queue',
              { sessionId, turnId: completedTurnId },
              async () => await self.deps.processMessageQueue(sessionId)
            )
          );
          return undefined;
        }),
    };
  }

  /** Metadata stop barriers also cover descendants created after the UI snapshot. */
  async reconcileCollaborationStops(): Promise<void> {
    for (const [sessionId, runtime] of this.turnRuntimeBySession) {
      if (await isSessionCollaborationStopped(this.deps.workspaceDocument.repo, sessionId)) {
        await this.cancelSession(
          {
            type: 'session/cancel',
            sessionId,
            turnId: runtime.turnId,
            machineId: this.deps.machineId,
            workspaceId: this.deps.workspaceId,
          },
          { pendingInput: 'preserve', prePromptSession: 'discard', pauseInbox: false }
        );
      }
    }
  }

  private async pendingInboxInputIds(sessionId: SessionId): Promise<string[]> {
    const doc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
    const backend = await createSessionBackend(doc);
    const [history, queued] = await Promise.all([
      backend.readDispatchHistory([]),
      backend.getMessageQueue(),
    ]);
    return [
      ...history
        .filter(
          (e) =>
            e.role === 'user' &&
            ['pending', 'seen', 'prepared', 'pending_apply'].includes(e.status ?? '')
        )
        .map((e) => e.id),
      ...queued.map((e) => e.userTurnId?.trim() || `queued-${e.$cid}`),
    ];
  }

  private liveTurnId(sessionId: SessionId): string | undefined {
    return (
      this.deps.getActiveTurnId(sessionId) ??
      this.currentTurnBySession.get(sessionId) ??
      this.turnRuntimeBySession.get(sessionId)?.turnId
    );
  }

  /**
   * Ends the last assistant turn when no execution on this daemon owns it, so it
   * cannot keep the session busy. With `requireSettledUserTurn`, a `processing`
   * input is left alone: it still owes its crash-recovery run on the same entry.
   */
  async closeDeadAssistantTurn(
    sessionId: SessionId,
    options: { turnId?: string; requireSettledUserTurn: boolean }
  ): Promise<boolean> {
    if (this.liveTurnId(sessionId) != null) return false;
    // The lease excludes turn starts; ownership is rechecked after the read.
    const releaseConflict = this.tryAcquireSessionRewriteConflictLease(sessionId);
    if (!releaseConflict) return false;
    try {
      const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
      const backend = await createSessionBackend(sessionDoc);
      const count = await backend.readHistoryCount();
      const rows = (
        await backend.readHistoryDirectory(Math.max(0, count - DEAD_TURN_SCAN_ROWS), count)
      ).flatMap((row) => (row.scalars ? [row.scalars] : []));
      const turnId = resolveActiveAssistantTurnId(rows);
      if (
        turnId === undefined ||
        (options.turnId !== undefined && options.turnId !== turnId) ||
        this.liveTurnId(sessionId) != null
      ) {
        return false;
      }
      const userTurnId = findLastHistoryEntry(rows, turnId)?.userTurnId;
      const userSettled =
        userTurnId !== undefined && !isActivationAwaitingHistory(rows, userTurnId);
      if (options.requireSettledUserTurn && !userSettled) return false;

      this.deps.logger.debug(`[${sessionId}] Closing assistant turn ${turnId}: no runtime owns it`);
      this.deps.clearSessionActivePresence(sessionId);
      // Settle the input before the entry turns terminal, as an ordinary Stop does.
      // Pointers move only when they still name this input, never a newer one.
      if (userTurnId && !userSettled) {
        await this.setTerminalUserTurnStatus(sessionId, sessionDoc, userTurnId, 'canceled');
        const meta = await this.getSessionMeta(sessionId);
        if (meta?.processingUserMsgId === userTurnId || meta?.latestUserMsgId === userTurnId) {
          await this.upsertSessionMeta(sessionId, {
            lastHandledUserMsgId: userTurnId,
            ...(meta.processingUserMsgId === userTurnId ? { processingUserMsgId: undefined } : {}),
          });
        }
      }
      await backend.applyHistoryAction({
        kind: 'finish-assistant',
        turnId,
        endedAt: getServerNow(),
        force: true,
      });
      await sessionDoc.setStatus(SessionStatusFactory.idle());
      return true;
    } finally {
      releaseConflict();
    }
  }

  async cancelSession(
    message: SessionCancelRequestValidated,
    options: {
      pendingInput?: PendingInputCancellationPolicy;
      prePromptSession?: 'discard' | 'keep';
      pauseInbox?: boolean;
    } = {}
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    const { sessionId, turnId } = message;
    const pendingInput = options.pendingInput ?? 'preserve';
    // Legacy clients cannot send trusted human receipts to resume a persistent pause.
    // Their Stop still cancels this execution, without opting into Inbox pause.
    const pauseInbox =
      options.pauseInbox !== false &&
      message.pauseInbox !== false &&
      (options.pauseInbox === true || message.pauseInbox === true || Boolean(message.cancelId));
    if (message.subagentTaskId) {
      // This control never writes lastCanceledTurn or interrupts the parent runtime.
      if (
        this.deps.getActiveTurnId(sessionId) !== turnId &&
        this.currentTurnBySession.get(sessionId) !== turnId
      )
        return { success: false, error: 'The parent turn is no longer active.' };
      const client = this.deps.sessionManager.getSession(sessionId)?.agentClient;
      if (!client?.isCreated())
        return { success: false, error: 'The agent is no longer connected.' };
      try {
        await client.cancelSubagent(message.subagentTaskId);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    this.deps.logger.info(`Session stop requested: ${sessionId}`);
    this.deps.logger.debug(`[${sessionId}] Received stop request for turn ${turnId}`);
    const activeTurnId = this.deps.getActiveTurnId(sessionId);
    const executionTurnId = this.currentTurnBySession.get(sessionId);
    const runtimeTurnId = this.turnRuntimeBySession.get(sessionId)?.turnId;
    const isPrompting = activeTurnId === turnId;
    const isCurrentExecutionTurn = executionTurnId === turnId || runtimeTurnId === turnId;
    const currentTurnId = activeTurnId ?? executionTurnId ?? runtimeTurnId;
    // Cancel is exact-match only: a stale stop request must not interrupt a newer assistant turn.
    if (!isPrompting && !isCurrentExecutionTurn) {
      const target = this.operationInbox?.pauseTarget(this.deps.workspaceId, sessionId, turnId);
      if (this.operationInbox && target && pauseInbox) {
        const pendingIds = await this.pendingInboxInputIds(sessionId);
        const paused = await this.operationInbox.pause(
          target,
          target.executionId,
          pendingIds,
          message.cancelId
        );
        if (paused) {
          const successor = this.turnRuntimeBySession.get(sessionId);
          if (successor?.inboxOwner?.input?.inputId === `inbox:${target.executionId}`)
            return this.cancelSession({ ...message, turnId: successor.turnId }, options);
          return { success: true };
        }
      }
      // Stop always ends the turn the user sees: with no execution here, the
      // unfinished entry is closed instead of ignored.
      if (await this.closeDeadAssistantTurn(sessionId, { turnId, requireSettledUserTurn: false })) {
        this.refreshCodeCollabSharedStateAfterTurn(sessionId);
      } else {
        this.deps.logger.debug(
          `[${sessionId}] Ignoring stop request for stale turn ${turnId} (current=${currentTurnId ?? 'none'})`
        );
      }
      await this.clearCancelRequest(sessionId);
      this.clearTurnCancellation(sessionId, turnId);
      return { success: true };
    }

    const stoppedRuntime = this.turnRuntimeBySession.get(sessionId);
    if (this.operationInbox && stoppedRuntime?.invocation?.requesterUserId && pauseInbox) {
      const scope = {
        workspaceId: this.deps.workspaceId,
        sessionId,
        userId: stoppedRuntime.invocation.requesterUserId,
      };
      const pendingIds = await this.pendingInboxInputIds(sessionId);
      try {
        const paused = await this.operationInbox.pause(
          scope,
          stoppedRuntime.inboxOwner?.id ?? turnId,
          pendingIds,
          message.cancelId
        );
        if (!paused) return { success: false, error: 'Execution changed before Stop.' };
        const successor = this.turnRuntimeBySession.get(sessionId);
        if (
          successor &&
          successor !== stoppedRuntime &&
          successor.inboxOwner?.input?.inputId ===
            `inbox:${stoppedRuntime.inboxOwner?.id ?? turnId}`
        )
          return this.cancelSession({ ...message, turnId: successor.turnId }, options);
      } catch (error) {
        stoppedRuntime.cancelRequested = true;
        this.markTurnCancelled(sessionId, turnId);
        this.requestAgentCancelInBackground(stoppedRuntime, 'active');
        this.requestTurnInterrupt(stoppedRuntime);
        return { success: false, error: `Stop could not be saved: ${formatErrorMessage(error)}` };
      }
    }
    if (this.operationInbox && stoppedRuntime?.inboxOwner?.input && !pauseInbox) {
      if (
        !(await this.operationInbox.cancelExecution(
          stoppedRuntime.inboxOwner!.input,
          stoppedRuntime.inboxOwner?.id ?? turnId,
          options.pauseInbox !== false && message.pauseInbox !== false ? 'user_stop' : undefined
        ))
      )
        return { success: false, error: 'Execution changed before cancellation.' };
    }
    this.pendingGoalTurnBySession.delete(sessionId);
    this.markTurnCancelled(sessionId, turnId);
    const runtime = this.getTurnRuntime(sessionId, turnId);
    if (runtime) {
      if (!runtime.cancelRequested) {
        runtime.pendingInputOnCancel = pendingInput;
        // Config calls already sent to ACP can outlive the owner interruption.
        // Stop discards that process; Edit & Resend keeps its prepared replacement.
        // Creation/restoration retain their independent terminate-on-cancel fence.
        if (!runtime.promptStarted && options.prePromptSession !== 'keep') {
          runtime.terminateSessionOnCancel = true;
        }
      }
      runtime.cancelRequested = true;
      runtime.steerWaitController?.abort();
      const runtimeSession = runtime.session ?? this.deps.sessionManager.getSession(sessionId);
      if (
        runtime.cancellationDrain &&
        (runtimeSession?.agentClient?.pendingPromptCompletion || runtime.pendingSteerConfig?.size)
      ) {
        return { success: true };
      }
      if (runtime.finalizeStarted) {
        this.deps.logger.debug(
          `[${sessionId}] Stop request received while turn ${turnId} is finalizing; interrupting owner turn`
        );
        this.requestTurnInterrupt(runtime);
        return { success: true };
      }
      if (runtime.promptInFlight) {
        if (!runtimeSession?.agentClient?.isCreated() || !runtimeSession.acpSessionId) {
          this.deps.logger.debug(
            `[${sessionId}] Stop requested while prompt is in flight but ACP session is not ready; interrupting owner turn`
          );
          this.requestTurnInterrupt(runtime);
          return { success: true };
        }
        // Keep the owner alive until ACP returns; cancel acknowledgement is not prompt completion.
        this.requestAgentCancelInBackground(runtime, 'active');
        void this.drainCancelledPrompt(runtimeSession, runtime).catch((error: unknown) => {
          this.deps.logger.warn(
            `[${sessionId}] Failed to drain cancelled prompt: ${formatErrorMessage(error)}`
          );
        });
        return { success: true };
      }

      this.deps.logger.debug(
        `[${sessionId}] Stop request recorded for turn ${turnId}; interrupting owner turn`
      );
      this.requestTurnInterrupt(runtime);
      return { success: true };
    }

    const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
    const liveTurnId =
      this.turnRuntimeBySession.get(sessionId)?.turnId ??
      this.currentTurnBySession.get(sessionId) ??
      this.deps.getActiveTurnId(sessionId);
    if (liveTurnId && liveTurnId !== turnId) return { success: true };
    if (this.getTurnRuntime(sessionId, turnId)) return this.cancelSession(message, options);
    if (isPrompting) {
      this.deps.clearActiveTurnId(sessionId, turnId);
    }
    const session = this.deps.sessionManager.getSession(sessionId);

    if (!session) {
      this.deps.logger.debug(`[${sessionId}] Current turn exists but session is missing in memory`);
      this.deps.clearSessionActivePresence(sessionId);
      await this.finalizeCancelledTurn({
        sessionId,
        sessionDoc,
        turnId,
        reportTurnError: false,
      });
      return { success: true };
    }

    if (!isPrompting) {
      this.deps.logger.debug(
        `[${sessionId}] Stop request received while turn ${turnId} is finalizing; skipping remaining post-processing`
      );
      this.deps.clearSessionActivePresence(sessionId);
      await this.finalizeCancelledTurn({
        sessionId,
        sessionDoc,
        turnId,
        session,
        reportTurnError: false,
      });
      return { success: true };
    }

    if (!session.agentClient?.isCreated() || !session.acpSessionId) {
      this.deps.logger.debug(`[${sessionId}] Cancelling active turn before ACP session is ready`);
      this.deps.clearSessionActivePresence(sessionId);
      await this.finalizeCancelledTurn({
        sessionId,
        sessionDoc,
        turnId,
        session,
        reportTurnError: true,
      });
      return { success: true };
    }

    try {
      await session.agentClient.cancel(session.acpSessionId);
      this.deps.logger.debug(`[${sessionId}] Cancel signal sent to agent for turn ${turnId}`);
      this.deps.clearSessionActivePresence(sessionId);
      await this.finalizeCancelledTurn({
        sessionId,
        sessionDoc,
        turnId,
        session,
        reportTurnError: true,
      });
      this.deps.logger.info(`Session cancelled: ${sessionId}`);
      return { success: true };
    } catch (error) {
      const errorMessage = formatErrorMessage(error);
      this.deps.logger.error(`[${sessionId}] Failed to stop session: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async getMachineStatus(_message: MachineStatusRequestValidated): Promise<MachineStatusResponse> {
    this.deps.logger.debug('Received machine status request');

    try {
      const resources = await this.deps.collectMachineResources();
      return {
        type: 'machine/status_response',
        machineId: this.deps.machineId,
        success: true,
        resources,
        lifecycle: this.deps.getMachineLifecycleCapability(),
      };
    } catch (error) {
      const errorMessage = formatErrorMessage(error);
      this.deps.logger.error(`Failed to collect machine status: ${errorMessage}`);
      return {
        type: 'machine/status_response',
        machineId: this.deps.machineId,
        success: false,
        lifecycle: this.deps.getMachineLifecycleCapability(),
        error: errorMessage,
      };
    }
  }

  async pingMachine(message: MachinePingRequestValidated): Promise<MachinePingResponse> {
    this.deps.logger.debug('Received machine ping request');

    return {
      type: 'machine/ping_response',
      machineId: this.deps.machineId,
      requestId: message.requestId,
      success: true,
      message: 'pong',
    };
  }

  private scheduleCreatedSessionCapabilityUpdate(session: ISession, config: SessionConfig): void {
    const capabilities = session.getAcpCapabilities?.();
    const agentConfigId = config.agentConfigId;
    if (!capabilities || !agentConfigId) {
      return;
    }

    void (async () => {
      const sourceVersion =
        session.getAcpCapabilitySourceVersion?.() ??
        getAcpCapabilitySourceVersion({
          cliType: config.agentCliType,
          agentType: config.agentType,
          customAcp: config.customAcp,
          runtimeOverrides: config.runtimeOverrides,
          magpieGatewayUrl: config.magpieGatewayUrl,
          env: config.env,
        });
      const existing = await this.deps.workspaceDocument.getAcpCapabilities(
        this.deps.machineId,
        agentConfigId
      );
      const availableCommands =
        capabilities.availableCommands !== undefined
          ? capabilities.availableCommands
          : existing?.sourceVersion === sourceVersion
            ? existing.availableCommands
            : undefined;
      await this.deps.workspaceDocument.updateAcpCapabilities(
        this.deps.machineId,
        agentConfigId,
        config.agentCliType,
        config.agentType,
        capabilities.modes,
        capabilities.models,
        capabilities.configOptions,
        availableCommands,
        capabilities.sessionFork,
        sourceVersion,
        capabilities.modelReasoningEfforts,
        capabilities.acknowledgedSteer,
        capabilities.goalActions,
        {
          sessionTitle: capabilities.sessionTitle,
          rateLimits: capabilities.rateLimits,
          modelCapabilities: capabilities.modelCapabilities,
        }
      );
      this.acpCapabilityLaunchInputFingerprints.set(
        agentConfigId,
        fingerprintAcpLaunchInputs({
          configId: agentConfigId,
          cliType: config.agentCliType,
          agentType: config.agentType,
          env: config.env,
          customAcp: config.customAcp,
          runtimeOverrides: config.runtimeOverrides,
          magpieGatewayUrl: config.magpieGatewayUrl,
        })
      );
    })().catch((error: unknown) => {
      this.deps.logger.debug(
        `[${session.sessionId}] Failed to update ACP capabilities from created session: ${formatErrorMessage(
          error
        )}`
      );
    });
  }

  async authenticateMachineAcp(
    message: MachineAcpAuthenticateRequestValidated,
    options: AcpAuthenticationOptions = {}
  ): Promise<MachineAcpAuthenticateResponse> {
    const workflowStartedAt = Date.now();
    const targetRequestId =
      message.action === 'start' ? message.requestId : message.authenticationRequestId;
    const activeAgentType = this.acpAuthenticationManager.getAgentType(targetRequestId);
    const base = {
      type: 'machine/acp-authenticate_response' as const,
      machineId: this.deps.machineId,
      requestId: message.requestId,
      agentType: activeAgentType ?? 'unknown',
    };
    if (message.machineId !== this.deps.machineId) {
      return {
        ...base,
        success: false,
        disposition: 'error',
        error: `Machine mismatch: expected ${this.deps.machineId}, got ${message.machineId}`,
      };
    }

    if (message.action === 'cancel') {
      return {
        ...base,
        ...this.acpAuthenticationManager.cancel(message.authenticationRequestId),
      };
    }
    if (message.action === 'submit-code') {
      return {
        ...base,
        ...this.acpAuthenticationManager.submitAuthorizationCode(
          message.authenticationRequestId,
          message.authorizationCode
        ),
      };
    }
    if (message.action === 'submit-input') {
      return {
        ...base,
        ...this.acpAuthenticationManager.submitAuthenticationInput(
          message.authenticationRequestId,
          message.interactionId,
          message.authenticationInput
        ),
      };
    }

    const config = await this.deps.workspaceDocument.getAgentConfigForMachineLaunch(
      message.configId,
      this.deps.machineId
    );
    if (!config || (config.cliType === 'custom' && !config.customAcp)) {
      return {
        ...base,
        success: false,
        disposition: 'error',
        error: `Provider config not found or invalid on this machine: ${message.configId}`,
      };
    }
    const resolvedBase = { ...base, agentType: config.agentType };
    const profileStore = getCodexProfileStore();
    const codexProfile = await profileStore.resolve(this.deps.workspaceId, config, true);

    const onProgress = (event: AcpAuthenticationProgressEvent): void => {
      if (event.status === 'auth-methods') {
        options.onProgress?.({
          type: 'machine/acp-authentication-progress',
          machineId: this.deps.machineId,
          requestId: message.requestId,
          agentType: config.agentType,
          status: event.status,
          interactionId: event.interactionId,
          authMethods: event.authMethods.map(summarizeAcpAuthMethod),
        });
        return;
      }
      options.onProgress?.({
        type: 'machine/acp-authentication-progress',
        machineId: this.deps.machineId,
        requestId: message.requestId,
        agentType: config.agentType,
        ...event,
      });
    };
    const result = await this.acpAuthenticationManager.authenticate({
      agentConfigId: config.id,
      requestId: message.requestId,
      cliType: config.cliType,
      agentType: config.agentType,
      customAcp: config.customAcp,
      runtimeOverrides: config.runtimeOverrides,
      magpieGatewayUrl: config.magpieGatewayUrl,
      env: config.env,
      onProgress,
      codexProfile,
      authenticateManagedProfile:
        codexProfile?.profile.mode === 'api-key'
          ? async ({ signal, requestInput }) => {
              const frozenBinding = JSON.stringify(config.codexAuth);
              const input = await requestInput(
                {
                  title: 'Codex API Key',
                  description: `Confirm the destination: ${codexProfile.profile.mode === 'api-key' ? codexProfile.profile.baseUrl : ''}. The key is stored only on this machine.`,
                  fields: [{ id: 'apiKey', type: 'secret', label: 'API Key', required: true }],
                },
                `Enter an API Key for ${codexProfile.profile.mode === 'api-key' ? codexProfile.profile.baseUrl : ''}`
              );
              const assertCurrent = async () => {
                signal.throwIfAborted();
                const current = await this.deps.workspaceDocument.getAgentConfigForMachineLaunch(
                  config.id,
                  this.deps.machineId
                );
                if (!current || JSON.stringify(current.codexAuth) !== frozenBinding)
                  throw new Error('Provider changed during authentication; try again');
                assertManagedCodexProfileConfig(current);
              };
              await assertCurrent();
              await profileStore.withApiKeyCandidate(
                codexProfile,
                String(input.apiKey ?? ''),
                async (candidateKey) => {
                  await this.deps.fetchAcpCapabilities(
                    config.cliType,
                    config.agentType,
                    config.env,
                    config.customAcp,
                    config.runtimeOverrides,
                    {
                      signal,
                      magpieGatewayUrl: config.magpieGatewayUrl,
                      codexProfile: { profile: codexProfile, candidateKey },
                      verifyCodexCredential: true,
                    }
                  );
                  await assertCurrent();
                },
                signal
              );
            }
          : undefined,
    });
    if (result.success && result.disposition === 'authenticated') {
      const refreshController = new AbortController();
      const refreshTimeoutMs = Math.max(
        1,
        Math.min(
          ACP_POST_AUTH_REFRESH_MAX_MS,
          ACP_AUTHENTICATION_WORKFLOW_DEADLINE_MS - (Date.now() - workflowStartedAt)
        )
      );
      const refreshTimeout = setTimeout(() => refreshController.abort(), refreshTimeoutMs);
      refreshTimeout.unref?.();
      let refresh: MachineAcpCapabilitiesRefreshResponse;
      try {
        refresh = await this.refreshMachineAcpCapabilitiesForConfig(
          {
            type: 'machine/acp-capabilities-refresh',
            machineId: message.machineId,
            workspaceId: message.workspaceId,
            configId: message.configId,
            cliType: config.cliType,
            agentType: config.agentType,
            customAcp: config.customAcp,
            runtimeOverrides: config.runtimeOverrides,
            magpieGatewayUrl: config.magpieGatewayUrl,
            env: config.env,
            codexAuth: config.codexAuth,
            // Authentication changes what the agent will advertise (models and
            // config options gated on the account), and the persisted entry was
            // stamped with the same launch inputs, so only a real probe can tell
            // the caller whether the new credentials actually work.
            force: true,
          },
          { signal: refreshController.signal }
        );
      } catch (error) {
        refresh = {
          type: 'machine/acp-capabilities-refresh_response',
          machineId: message.machineId,
          configId: message.configId,
          cliType: config.cliType,
          agentType: config.agentType,
          success: false,
          error: refreshController.signal.aborted
            ? 'Authentication succeeded, but capability verification timed out'
            : formatErrorMessage(error),
        };
      } finally {
        clearTimeout(refreshTimeout);
      }
      if (!refresh.success) {
        return {
          ...resolvedBase,
          ...result,
          capabilitiesRefreshed: false,
          authRequired: refresh.authRequired,
          authMethods: refresh.authMethods,
          error: refresh.error ?? 'Authentication succeeded, but capability refresh failed',
        };
      }
      return { ...resolvedBase, ...result, capabilitiesRefreshed: true };
    }

    return { ...resolvedBase, ...result };
  }

  async refreshMachineAcpCapabilities(
    message: MachineAcpCapabilitiesRefreshRequestValidated,
    options: AcpBinaryProgressOptions = {}
  ): Promise<MachineAcpCapabilitiesRefreshResponse> {
    if (message.machineId !== this.deps.machineId) {
      return {
        type: 'machine/acp-capabilities-refresh_response',
        machineId: this.deps.machineId,
        configId: message.configId,
        cliType: 'builtin',
        agentType: 'unknown',
        success: false,
        error: `Machine mismatch: expected ${this.deps.machineId}, got ${message.machineId}`,
      };
    }

    const config = await this.deps.workspaceDocument.getAgentConfigForMachineLaunch(
      message.configId,
      this.deps.machineId
    );
    if (!config) {
      return {
        type: 'machine/acp-capabilities-refresh_response',
        machineId: this.deps.machineId,
        configId: message.configId,
        cliType: 'builtin',
        agentType: 'unknown',
        success: false,
        error: `Provider config not found on this machine: ${message.configId}`,
      };
    }

    return await this.refreshMachineAcpCapabilitiesForConfig(
      {
        ...message,
        cliType: config.cliType,
        agentType: config.agentType,
        customAcp: config.customAcp,
        runtimeOverrides: config.runtimeOverrides,
        magpieGatewayUrl: config.magpieGatewayUrl,
        env: config.env,
        codexAuth: config.codexAuth,
      },
      options
    );
  }

  async listMachinePiExtensions(configId?: AgentConfigId): Promise<MachinePiExtensionsResponse> {
    try {
      let env: Record<string, string> | undefined;
      if (configId !== undefined) {
        const config = await this.deps.workspaceDocument.getAgentConfigForMachineLaunch(
          configId,
          this.deps.machineId
        );
        if (!config || config.cliType !== 'builtin' || config.agentType !== 'pi') {
          return {
            success: false,
            error: 'Provider config is not a builtin Pi provider on this machine.',
          };
        }
        env = config.env;
      }
      const discovery = await discoverManagedPiExtensions(env);
      return { success: true, discovery };
    } catch (error) {
      return { success: false, error: formatErrorMessage(error) };
    }
  }

  private async refreshMachineAcpCapabilitiesForConfig(
    message: ResolvedMachineAcpCapabilitiesRefreshRequest,
    options: AcpBinaryProgressOptions = {}
  ): Promise<MachineAcpCapabilitiesRefreshResponse> {
    // Config identity is part of the key because the response and cache row are
    // both config-scoped even when two configs share identical launch inputs.
    const dedupeKey = computeAcpRefreshDedupeKey(
      message.configId,
      message.cliType,
      message.agentType,
      message.env,
      message.customAcp,
      message.runtimeOverrides,
      message.magpieGatewayUrl
    );

    this.deps.logger.debug(
      `[acp-capabilities] Refresh requested (cliType=${message.cliType} agentType=${message.agentType} force=${message.force === true})`
    );
    if (options.signal?.aborted) {
      throw createAcpRefreshAbortError();
    }

    if (message.force !== true) {
      let cached: AcpCapabilityCacheEntry | undefined;
      try {
        cached = await this.readFreshAcpCapabilityCacheEntry(message);
      } catch (error) {
        // Reading the entry opens the same Machine Flock document the probe would
        // write back to, so a failure here is a failed refresh, reported the same
        // way. Probing anyway would hide a broken document behind a process spawn.
        return this.buildFailedAcpRefreshResponse(message, error);
      }
      if (cached) {
        options.signal?.throwIfAborted();
        return buildAcpCapabilitiesRefreshResponseFromCache(this.deps.machineId, message, cached);
      }
    }

    let entry = this.inFlightAcpRefresh.get(dedupeKey);
    if (entry?.controller.signal.aborted) {
      if (this.inFlightAcpRefresh.get(dedupeKey) === entry) {
        this.inFlightAcpRefresh.delete(dedupeKey);
      }
      entry = undefined;
    }
    if (!entry) {
      const controller = new AbortController();
      const consumers = new Map<object, AcpBinaryProgressSink | undefined>();
      let nextEntry!: InFlightAcpRefreshEntry;
      const promise = this.executeAcpRefresh(message, {
        signal: controller.signal,
        onAcpBinaryProgress: (progress) => {
          for (const sink of consumers.values()) {
            sink?.(progress);
          }
        },
      }).finally(() => {
        nextEntry.settled = true;
        if (this.inFlightAcpRefresh.get(dedupeKey) === nextEntry) {
          this.inFlightAcpRefresh.delete(dedupeKey);
        }
      });
      nextEntry = {
        consumers,
        controller,
        promise,
        settled: false,
      };
      this.inFlightAcpRefresh.set(dedupeKey, nextEntry);
      entry = nextEntry;
    }

    const consumer = {};
    entry.consumers.set(consumer, options.onAcpBinaryProgress);
    return await new Promise<MachineAcpCapabilitiesRefreshResponse>((resolve, reject) => {
      let finished = false;
      const release = (): void => {
        options.signal?.removeEventListener('abort', handleAbort);
        entry.consumers.delete(consumer);
        if (!entry.settled && entry.consumers.size === 0) {
          entry.controller.abort();
        }
      };
      const finish = (complete: () => void): void => {
        if (finished) return;
        finished = true;
        release();
        complete();
      };
      const handleAbort = (): void => finish(() => reject(createAcpRefreshAbortError()));

      options.signal?.addEventListener('abort', handleAbort, { once: true });
      if (options.signal?.aborted) {
        handleAbort();
        return;
      }
      void entry.promise.then(
        (response) => finish(() => resolve(response)),
        (error: unknown) => finish(() => reject(error))
      );
    });
  }

  /**
   * The persisted entry when it still describes what a probe would return.
   *
   * A hit requires the exact `capabilitySourceVersion` the current launch inputs
   * would produce, and that this process wrote the entry from the same launch
   * inputs — env included, which the source version mostly does not cover — so
   * editing a runtime override, a custom command, or any env value misses.
   * Lookup failures propagate to the
   * caller, which reports them as a failed refresh rather than probing: a broken
   * Machine Flock document would fail the probe's write-back too.
   */
  private async readFreshAcpCapabilityCacheEntry(
    message: ResolvedMachineAcpCapabilitiesRefreshRequest
  ): Promise<AcpCapabilityCacheEntry | undefined> {
    const expectedSourceVersion = await this.deps.resolveAcpCapabilitySourceVersion({
      cliType: message.cliType,
      agentType: message.agentType,
      customAcp: message.customAcp,
      runtimeOverrides: message.runtimeOverrides,
      magpieGatewayUrl: message.magpieGatewayUrl,
      env: message.env,
    });
    const recordedFingerprint = this.acpCapabilityLaunchInputFingerprints.get(message.configId);
    const decision = decideAcpCapabilityRefreshCache({
      entry: await this.deps.workspaceDocument.getAcpCapabilities(
        this.deps.machineId,
        message.configId
      ),
      expectedSourceVersion,
      launchInputs:
        recordedFingerprint === undefined
          ? 'unknown'
          : recordedFingerprint === fingerprintAcpLaunchInputs(message)
            ? 'matching'
            : 'changed',
      nowMs: getServerNow(),
    });
    if (!decision.hit) {
      this.deps.logger.debug(
        `[acp-capabilities] Cache miss (cliType=${message.cliType} agentType=${message.agentType} reason=${decision.reason})`
      );
      return undefined;
    }
    this.deps.logger.debug(
      `[acp-capabilities] Served from cache without starting the agent (cliType=${message.cliType} agentType=${message.agentType} sourceVersion=${expectedSourceVersion})`
    );
    return decision.entry;
  }

  private async executeAcpRefresh(
    message: ResolvedMachineAcpCapabilitiesRefreshRequest,
    options: AcpBinaryProgressOptions = {}
  ): Promise<MachineAcpCapabilitiesRefreshResponse> {
    try {
      options.signal?.throwIfAborted();
      let codexProfile: ResolvedCodexProfile | undefined;
      if (message.codexAuth) {
        const config = await this.deps.workspaceDocument.getAgentConfigForMachineLaunch(
          message.configId,
          this.deps.machineId
        );
        if (!config || JSON.stringify(config.codexAuth) !== JSON.stringify(message.codexAuth))
          throw new Error('Provider changed during verification');
        codexProfile = await getCodexProfileStore().resolve(this.deps.workspaceId, config, true);
        if (!codexProfile || !(await getCodexProfileStore().isReady(codexProfile)))
          throw new AcpAuthenticationRequiredError([]);
      }
      await this.emitBuiltinRuntimeStatusForRefresh(message, options.onAcpBinaryProgress);
      options.signal?.throwIfAborted();
      const {
        modes,
        models,
        configOptions,
        availableCommands,
        sessionFork,
        acknowledgedSteer,
        sessionTitle,
        rateLimits,
        goalActions,
        modelReasoningEfforts,
        modelCapabilities,
        capabilitySourceVersion,
      } = await this.deps.fetchAcpCapabilities(
        message.cliType,
        message.agentType,
        message.env,
        message.customAcp,
        message.runtimeOverrides,
        {
          agentConfigId: message.configId,
          magpieGatewayUrl: message.magpieGatewayUrl,
          signal: options.signal,
          codexProfile: codexProfile ? { profile: codexProfile } : undefined,
          onManagedRuntimeProgress: (event) => {
            if (options.signal?.aborted) return;
            options.onAcpBinaryProgress?.(
              toManagedRuntimeProgressMessage(this.deps.machineId, event)
            );
          },
        }
      );

      options.signal?.throwIfAborted();
      const capability = await this.deps.workspaceDocument.updateAcpCapabilities(
        this.deps.machineId,
        message.configId,
        message.cliType,
        message.agentType,
        modes,
        models,
        configOptions,
        availableCommands,
        sessionFork,
        capabilitySourceVersion ??
          getAcpCapabilitySourceVersion({
            cliType: message.cliType,
            agentType: message.agentType,
            customAcp: message.customAcp,
            runtimeOverrides: message.runtimeOverrides,
            magpieGatewayUrl: message.magpieGatewayUrl,
            env: message.env,
          }),
        modelReasoningEfforts,
        acknowledgedSteer,
        goalActions,
        { signal: options.signal, sessionTitle, rateLimits, modelCapabilities }
      );
      this.acpCapabilityLaunchInputFingerprints.set(
        message.configId,
        fingerprintAcpLaunchInputs(message)
      );

      return {
        type: 'machine/acp-capabilities-refresh_response',
        machineId: this.deps.machineId,
        configId: message.configId,
        cliType: message.cliType,
        agentType: message.agentType,
        success: true,
        modes,
        models,
        configOptions: configOptions?.map((opt) => ({
          id: opt.id,
          name: opt.name,
          category: opt.category,
          optionCount: opt.options.length,
        })),
        capability,
        availableCommands,
      };
    } catch (error) {
      return this.buildFailedAcpRefreshResponse(message, error);
    }
  }

  private buildFailedAcpRefreshResponse(
    message: ResolvedMachineAcpCapabilitiesRefreshRequest,
    error: unknown
  ): MachineAcpCapabilitiesRefreshResponse {
    const errorMessage = formatErrorMessage(error);
    this.deps.logger.debug(
      `[acp-capabilities] Refresh failed (cliType=${message.cliType} agentType=${message.agentType}): ${errorMessage}`
    );
    return {
      type: 'machine/acp-capabilities-refresh_response',
      machineId: this.deps.machineId,
      configId: message.configId,
      cliType: message.cliType,
      agentType: message.agentType,
      success: false,
      ...(error instanceof AcpAuthenticationRequiredError
        ? {
            authRequired: true,
            authMethods: error.authMethods.map(summarizeAcpAuthMethod),
          }
        : {}),
      error: errorMessage,
    };
  }

  private async emitBuiltinRuntimeStatusForRefresh(
    message: ResolvedMachineAcpCapabilitiesRefreshRequest,
    onProgress: AcpBinaryProgressSink | undefined
  ): Promise<void> {
    if (!onProgress || message.cliType !== 'builtin') {
      return;
    }
    if (hasBuiltinRuntimeOverrideValues(message.runtimeOverrides)) {
      return;
    }

    const runtimeName = this.resolveManagedRuntimeName(message.agentType);
    if (!runtimeName) {
      return;
    }
    const status = await getManagedAgentRuntimeManager().getRuntimeStatus(runtimeName);
    onProgress({
      type: 'machine/acp-binary-progress',
      machineId: this.deps.machineId,
      agentType: message.agentType,
      status:
        status.kind === 'installed'
          ? 'installed'
          : status.kind === 'unsupported-platform'
            ? 'unsupported-platform'
            : status.kind === 'incompatible-host'
              ? 'incompatible-host'
              : 'not-installed',
      command: status.kind === 'installed' ? status.command : undefined,
      platformArch: 'platformArch' in status ? status.platformArch : undefined,
      version: 'version' in status ? status.version : undefined,
      current: status.kind === 'incompatible-host' ? status.current : undefined,
      required: status.kind === 'incompatible-host' ? status.required : undefined,
    });
  }

  private resolveManagedRuntimeName(agentType: string): ManagedRuntimeName | null {
    return getManagedBuiltinRuntimeByAgentType(agentType)?.runtimeName ?? null;
  }

  // Both binary handlers below accept a request for a specific machine + agent;
  // share the machine-mismatch and unknown-agent guards so the two response
  // shapes stay in sync. Returns the resolved agent or the error string to embed.
  private resolveAcpBinaryRequest(message: {
    machineId: string;
    agentType: string;
  }):
    | { kind: 'managed-runtime'; runtimeName: ManagedRuntimeName }
    | { kind: 'registry'; agent: RegistryAcpAgent }
    | { error: string } {
    if (message.machineId !== this.deps.machineId) {
      return {
        error: `Machine mismatch: expected ${this.deps.machineId}, got ${message.machineId}`,
      };
    }
    const managedRuntime = getManagedBuiltinRuntimeByAgentType(message.agentType);
    if (managedRuntime) {
      return { kind: 'managed-runtime', runtimeName: managedRuntime.runtimeName };
    }
    const agent = findRegistryAcpAgent(message.agentType);
    if (!agent) {
      return { error: `Unknown registry ACP agent: ${message.agentType}` };
    }
    return { kind: 'registry', agent };
  }

  async getMachineAcpBinaryStatus(
    message: MachineAcpBinaryStatusRequestValidated
  ): Promise<MachineAcpBinaryStatusResponse> {
    const base = {
      type: 'machine/acp-binary-status_response' as const,
      machineId: this.deps.machineId,
      agentType: message.agentType,
    };
    const resolved = this.resolveAcpBinaryRequest(message);
    if ('error' in resolved) {
      return { ...base, success: false, status: 'not-installed', error: resolved.error };
    }
    try {
      if (resolved.kind === 'managed-runtime') {
        const status = await getManagedAgentRuntimeManager().getRuntimeStatus(resolved.runtimeName);
        return {
          ...base,
          success: true,
          status: status.kind,
          command: status.kind === 'installed' ? status.command : undefined,
          installPath: status.kind === 'installed' ? status.command : undefined,
          platformArch: 'platformArch' in status ? status.platformArch : undefined,
          version: 'version' in status ? status.version : undefined,
          current: status.kind === 'incompatible-host' ? status.current : undefined,
          required: status.kind === 'incompatible-host' ? status.required : undefined,
        };
      }
      const status = await getAcpBinaryManager().getBinaryStatus(resolved.agent);
      return {
        ...base,
        success: true,
        status: status.kind,
        command: status.kind === 'installed' ? status.command : undefined,
        platformArch: 'platformArch' in status ? status.platformArch : undefined,
      };
    } catch (error) {
      return { ...base, success: false, status: 'not-installed', error: formatErrorMessage(error) };
    }
  }

  private async runAcpBinaryInstall(
    key: string,
    progressSink: AcpBinaryProgressSink | undefined,
    install: (emitProgress: AcpBinaryProgressSink) => Promise<MachineAcpBinaryInstallResponse>
  ): Promise<MachineAcpBinaryInstallResponse> {
    let entry = this.inFlightAcpBinaryInstall.get(key);
    if (!entry) {
      const consumers = new Map<object, AcpBinaryProgressSink | undefined>();
      let nextEntry!: InFlightAcpBinaryInstallEntry;
      const promise = install((progress) => {
        for (const sink of consumers.values()) {
          sink?.(progress);
        }
      }).finally(() => {
        if (this.inFlightAcpBinaryInstall.get(key) === nextEntry) {
          this.inFlightAcpBinaryInstall.delete(key);
        }
      });
      nextEntry = { consumers, promise };
      this.inFlightAcpBinaryInstall.set(key, nextEntry);
      entry = nextEntry;
    }

    const consumer = {};
    entry.consumers.set(consumer, progressSink);
    try {
      return await entry.promise;
    } finally {
      entry.consumers.delete(consumer);
    }
  }

  async installMachineAcpBinary(
    message: MachineAcpBinaryInstallRequestValidated,
    options: AcpBinaryProgressOptions = {}
  ): Promise<MachineAcpBinaryInstallResponse> {
    const base = {
      type: 'machine/acp-binary-install_response' as const,
      machineId: this.deps.machineId,
      agentType: message.agentType,
    };
    const resolved = this.resolveAcpBinaryRequest(message);
    if ('error' in resolved) {
      return { ...base, success: false, error: resolved.error };
    }
    if (resolved.kind === 'managed-runtime') {
      return await this.runAcpBinaryInstall(
        `managed:${resolved.runtimeName}`,
        options.onAcpBinaryProgress,
        async (emitProgress) => {
          try {
            this.deps.logger.debug(`[managed-runtime] Installing ${resolved.runtimeName}`);
            const runtimeStatus = await getManagedAgentRuntimeManager().getRuntimeStatus(
              resolved.runtimeName
            );
            emitProgress({
              type: 'machine/acp-binary-progress',
              machineId: this.deps.machineId,
              agentType: message.agentType,
              status:
                runtimeStatus.kind === 'installed'
                  ? 'installed'
                  : runtimeStatus.kind === 'unsupported-platform'
                    ? 'unsupported-platform'
                    : runtimeStatus.kind === 'incompatible-host'
                      ? 'incompatible-host'
                      : 'not-installed',
              command: runtimeStatus.kind === 'installed' ? runtimeStatus.command : undefined,
              platformArch:
                'platformArch' in runtimeStatus ? runtimeStatus.platformArch : undefined,
              version: 'version' in runtimeStatus ? runtimeStatus.version : undefined,
              current:
                runtimeStatus.kind === 'incompatible-host' ? runtimeStatus.current : undefined,
              required:
                runtimeStatus.kind === 'incompatible-host' ? runtimeStatus.required : undefined,
            });
            if (runtimeStatus.kind === 'incompatible-host') {
              const displayName =
                getManagedBuiltinRuntimeByRuntimeName(resolved.runtimeName)?.displayName ??
                resolved.runtimeName;
              return {
                ...base,
                success: false,
                error: `${displayName} requires Node >=${runtimeStatus.required}; current Node is ${runtimeStatus.current}`,
              };
            }
            const installation = await getManagedAgentRuntimeManager().ensureCurrentRuntime(
              resolved.runtimeName,
              {
                onProgress: (event) => {
                  emitProgress(toManagedRuntimeProgressMessage(this.deps.machineId, event));
                },
              }
            );
            await getManagedAgentRuntimeManager().pruneSupersededVersions(resolved.runtimeName);
            return {
              ...base,
              success: true,
              command: installation.command,
              installPath: installation.command,
              version: installation.version,
            };
          } catch (error) {
            // Managed-runtime install failures should emit sanitized PostHog
            // diagnostics with the concrete fetch/HTTP/verify reason.
            const errorMessage =
              error instanceof ManagedRuntimeUnsupportedPlatformError
                ? error.message
                : formatManagedRuntimeFailureMessage(error);
            const runtimeDiagnostics = getManagedAgentRuntimeManager().getDiagnostics(
              resolved.runtimeName
            );
            captureCli(
              'managed_runtime/install_failed',
              {
                workspace_id: this.deps.workspaceId,
                machine_id: this.deps.machineId,
                agent_type: message.agentType,
                runtime_name: resolved.runtimeName,
                runtime_version: runtimeDiagnostics.version,
                platform_arch: runtimeDiagnostics.platformArch,
                runtime_base_host: runtimeDiagnostics.runtimeBaseHost,
                proxy_env_present: runtimeDiagnostics.proxyEnvPresent,
                proxy_configured_for_runtime_url: runtimeDiagnostics.proxyConfiguredForRuntimeUrl,
                source: 'explicit_install',
                reason: classifyManagedRuntimeFailureReason(error),
                error_message: truncateAnalyticsString(errorMessage),
              },
              { tier: 'A' }
            );
            this.deps.logger.debug(
              `[managed-runtime] Install failed for ${resolved.runtimeName}: ${errorMessage}`
            );
            emitProgress({
              type: 'machine/acp-binary-progress',
              machineId: this.deps.machineId,
              agentType: message.agentType,
              status: 'error',
              error: errorMessage,
            });
            return { ...base, success: false, error: errorMessage };
          }
        }
      );
    }
    const agent = resolved.agent;
    return await this.runAcpBinaryInstall(
      `${agent.id}@${agent.version}`,
      options.onAcpBinaryProgress,
      async (emitProgress) => {
        try {
          this.deps.logger.debug(`[acp-binary] Installing ${agent.id}@${agent.version}`);
          const status = await getAcpBinaryManager().getBinaryStatus(agent);
          emitProgress({
            type: 'machine/acp-binary-progress',
            machineId: this.deps.machineId,
            agentType: message.agentType,
            status:
              status.kind === 'installed'
                ? 'installed'
                : status.kind === 'unsupported-platform'
                  ? 'unsupported-platform'
                  : status.kind === 'not-applicable'
                    ? 'installed'
                    : 'not-installed',
            command: status.kind === 'installed' ? status.command : undefined,
            platformArch: 'platformArch' in status ? status.platformArch : undefined,
          });
          if (status.kind === 'not-installed') {
            emitProgress({
              type: 'machine/acp-binary-progress',
              machineId: this.deps.machineId,
              agentType: message.agentType,
              status: 'downloading',
              platformArch: status.platformArch,
            });
          }
          const launch = await getAcpBinaryManager().ensureBinary(agent);
          emitProgress({
            type: 'machine/acp-binary-progress',
            machineId: this.deps.machineId,
            agentType: message.agentType,
            status: 'installed',
            command: launch.command,
          });
          return { ...base, success: true, command: launch.command };
        } catch (error) {
          const errorMessage =
            error instanceof AcpBinaryUnsupportedPlatformError
              ? error.message
              : formatErrorMessage(error);
          this.deps.logger.debug(`[acp-binary] Install failed for ${agent.id}: ${errorMessage}`);
          emitProgress({
            type: 'machine/acp-binary-progress',
            machineId: this.deps.machineId,
            agentType: message.agentType,
            status: 'error',
            error: errorMessage,
          });
          return { ...base, success: false, error: errorMessage };
        }
      }
    );
  }
}

/**
 * The refresh response a cache hit returns.
 *
 * It repeats the persisted entry rather than re-deriving anything, so a caller
 * cannot tell a hit from a probe except by how fast it answered: the renderer
 * writes `capability` straight into its Machine Flock rows either way.
 */
const buildAcpCapabilitiesRefreshResponseFromCache = (
  machineId: MachineId,
  message: ResolvedMachineAcpCapabilitiesRefreshRequest,
  capability: AcpCapabilityCacheEntry
): MachineAcpCapabilitiesRefreshResponse => ({
  type: 'machine/acp-capabilities-refresh_response',
  machineId,
  configId: message.configId,
  cliType: message.cliType,
  agentType: message.agentType,
  success: true,
  modes: capability.modes.map((mode) => ({
    id: mode.id,
    name: mode.name,
    description: mode.description ?? undefined,
  })),
  models: capability.models.map((model) => ({
    modelId: model.modelId,
    name: model.name ?? undefined,
    description: model.description ?? undefined,
  })),
  configOptions: capability.configOptions?.map((option) => ({
    id: option.id,
    name: option.name,
    category: option.category,
    optionCount: option.options.length,
  })),
  capability,
  availableCommands: capability.availableCommands,
});

const findRegistryAcpAgent = (agentType: string): RegistryAcpAgent | undefined =>
  REGISTRY_ACP_AGENTS.find((agent) => agent.id === agentType);

// NUL separates field segments and \x01 separates env pairs so equivalent
// env maps produce identical keys and ambiguous separators in values can't
// collide. Env vars on POSIX cannot contain either control character.
/**
 * In-memory identity of everything a capability probe is launched with. Hashed
 * only so the long-lived map does not retain another plaintext copy of the env;
 * it is never persisted, synced, or logged.
 */
const fingerprintAcpLaunchInputs = (inputs: {
  configId: AgentConfigId;
  cliType: AgentConfigCliType;
  agentType: string;
  env?: Record<string, string>;
  customAcp?: CustomAcpLaunchSpec;
  runtimeOverrides?: BuiltinRuntimeOverrides;
  magpieGatewayUrl?: string;
}): string =>
  createHash('sha256')
    .update(
      computeAcpRefreshDedupeKey(
        inputs.configId,
        inputs.cliType,
        inputs.agentType,
        inputs.env,
        inputs.customAcp,
        inputs.runtimeOverrides,
        inputs.magpieGatewayUrl
      )
    )
    .digest('hex');

const computeAcpRefreshDedupeKey = (
  configId: AgentConfigId,
  cliType: AgentConfigCliType,
  agentType: string,
  env: Record<string, string> | undefined,
  customAcp?: CustomAcpLaunchSpec,
  runtimeOverrides?: BuiltinRuntimeOverrides,
  magpieGatewayUrl?: string
): string => {
  const sortedKeys = env ? Object.keys(env).sort() : [];
  const envSerialized = sortedKeys.map((k) => `${k}=${env![k]}`).join('\x01');
  const customSerialized = customAcp ? serializeCustomAcpLaunchSpec(customAcp) : '';
  const runtimeOverrideSerialized = runtimeOverrides
    ? Object.entries(runtimeOverrides)
        .filter(([, value]) =>
          Array.isArray(value)
            ? value.length > 0
            : typeof value === 'string' && value.trim().length > 0
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${Array.isArray(value) ? JSON.stringify(value) : value}`)
        .join('\x01')
    : '';
  return `${configId}\x00${cliType}\x00${agentType}\x00${envSerialized}\x00${customSerialized}\x00${runtimeOverrideSerialized}\x00${magpieGatewayUrl ?? ''}`;
};
