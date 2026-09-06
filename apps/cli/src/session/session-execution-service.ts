import {
  type ACPSessionId,
  type AgentConfigId,
  type AgentConfigCliType,
  type AgentConfigMeta,
  type ChatFailedCode,
  type ChatFailedReason,
  type IssuePRMention,
  type LocalProjectId,
  type MachineAcpBinaryInstallRequestValidated,
  type MachineAcpBinaryInstallResponse,
  type MachineAcpBinaryProgressMessage,
  type MachineAcpBinaryStatusRequestValidated,
  type MachineAcpBinaryStatusResponse,
  type MachineAcpCapabilitiesRefreshRequestValidated,
  type MachineAcpCapabilitiesRefreshResponse,
  type MachineAcpAuthMethodSummary,
  type MachineAcpAuthenticateRequestValidated,
  type MachineAcpAuthenticateResponse,
  type MachineAcpAuthenticationProgressMessage,
  type MachineId,
  type MachinePingRequestValidated,
  type MachinePingResponse,
  type MachineLifecycleCapability,
  REGISTRY_ACP_AGENTS,
  type RegistryAcpAgent,
  type MachineStatusRequestValidated,
  type MachineStatusResponse,
  type MachineResourceInfo,
  type ProjectRef,
  resolveBaseBranchPreference,
  resolveProjectGitHubRepo,
  getSessionRoomId,
  getServerNow,
  SessionCreateRequestValidated,
  SessionHistoryInput,
  type SessionId,
  type SessionInputBlock,
  type SessionTurnInputConfig,
  type SessionMeta,
  SessionStatusFactory,
  SessionChatRequestValidated,
  SessionCancelRequestValidated,
  type SessionSteerResponse,
  type WorkspaceId,
  hasRecentResumeNotice,
  buildReplayPromptFromHistory,
  type ReplayPromptResult,
  getLegacyReadForSessionHistoryStatus,
  type AcpCommandSummary,
  type AcpConfigOptionSummary,
  type AcpConfigOptionValue,
  type BuiltinRuntimeOverrides,
  type CustomAcpLaunchSpec,
  hasBuiltinRuntimeOverrideValues,
  getManagedBuiltinRuntimeByAgentType,
  getManagedBuiltinRuntimeByRuntimeName,
  serializeCustomAcpLaunchSpec,
} from '@lody/shared';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { ModelInfo } from '@lody/shared';
import { Cause, Data, Effect, Exit, Fiber, type Scope } from 'effect';
import {
  captureGitWorkingTreeDiffBaseline,
  getCurrentCommitHash,
  type GitRunner,
  type GitWorkingTreeDiffBaseline,
} from '@/lib/git/git-diff-stats';
import { resolveWorkspaceLocalProjectRootPathWithRetry } from '@/lib/local-project-meta';
import { readTimeoutEnv } from '@/lib/loro/timeout-utils';
import { ConcurrentQueue } from '@/lib/concurrent-queue';
import {
  checkoutLocalProjectBranchAtRootPath,
  createLocalProjectBranchSelector,
  getLocalProjectGitStateAtRootPath,
  resolveLocalProjectBranchAtRootPath,
} from '@lody/shared/node/local-project';
import { getAcpCapabilitySourceVersion, resolveACPProcessLaunch } from '@/agent/setting';
import { type AcpLauncher, resolveAcpLauncher } from '@/agent/acp-analytics';
import { AcpBinaryUnsupportedPlatformError, getAcpBinaryManager } from '@/agent/acp-binary-manager';
import {
  classifyManagedRuntimeFailureReason,
  formatManagedRuntimeFailureMessage,
  getManagedAgentRuntimeManager,
  ManagedRuntimeUnsupportedPlatformError,
  type ManagedRuntimeProgressEvent,
  type ManagedRuntimeName,
} from '@/agent/managed-agent-runtime';
import type { FetchAcpCapabilitiesOptions } from '@/agent/acp-capabilities';
import { AcpAuthenticationRequiredError, AgentSteerNotDeliveredError } from '@/agent/agent-client';
import {
  AcpAuthenticationManager,
  type AcpAuthenticationProgressEvent,
} from '@/agent/acp-authentication';
import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';
import { startTraceSpan, traceAsync } from '@/utils/trace-span';
import { captureCli } from '@/lib/analytics/posthog';
import type { SessionActivePresencePhase } from '@/lib/loro/session-active-presence';
import type { SessionConfig } from './types';
import type { ISession, SessionManager } from './session-manager';
import type { LoroDocumentManager, SessionDocument } from '@/lib/loro/doc';
import { buildPrompt, normalizeSessionInputBlocks } from './session-execution-helpers';
import type { MemoryPressureEvictionResult } from '@/lib/session-gc-manager';
import { resolveResumableAcpSessionId } from './session-dispatch-logic';
import { resolveSessionLaunchConfig } from './session-launch-config-resolver';
import type { MachineAccessVerification } from './session-access-retry';
import {
  GIT_EXECUTABLE_NOT_FOUND_CODE,
  isGitExecutableNotFoundError,
} from './worktree/git-process-error';
import {
  getACPErrorUserMessage,
  isAgentDisconnectedError,
  mapACPErrorToFailureReason,
  parseACPError,
  shouldRecoverStaleACPConnectionPrompt,
  shouldTerminateOnACPError,
} from './acp-error-classification';

type FinalizeTurnContext = {
  sessionId: SessionId;
  session: ISession;
  sessionDoc: SessionDocument;
  turnId: string;
  baseCommitHash: string | null;
  turnStartWorkingTreeDiff?: GitWorkingTreeDiffBaseline | null;
  userId: string;
  project?: ProjectRef;
  isTurnCancelled?: () => boolean;
  abortSignal?: AbortSignal;
  onAutoPromptStart?: () => void | Promise<void>;
  onAutoPromptEnd?: () => void | Promise<void>;
  /**
   * False when the prompt returned without the agent ever emitting output. The
   * turn is still finalized (diff stats, PR detection, auto-commit all stay
   * correct), but it must not be announced as a completed answer.
   */
  producedOutput?: boolean;
};

const TURN_FINALIZATION_STAGE_WARN_MS = 5_000;
// Renderer, local IPC, and Machine RPC wait at most 300s for the complete
// authentication workflow. Keep the post-login capability proof inside that
// envelope and leave a small delivery margin for the final response.
const ACP_AUTHENTICATION_WORKFLOW_DEADLINE_MS = 295_000;
const ACP_POST_AUTH_REFRESH_MAX_MS = 60_000;

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
  syncSessionBranchName: (sessionId: SessionId, session: ISession) => Promise<string | null>;
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
  autoCommitAndPushForPR: (ctx: {
    sessionId: SessionId;
    session: ISession;
    sessionDoc: SessionDocument;
    project?: ProjectRef;
    preferredBaseBranch?: string;
    userId: string;
    isTurnCancelled?: () => boolean;
    abortSignal?: AbortSignal;
    onAutoPromptStart?: () => void | Promise<void>;
    onAutoPromptEnd?: () => void | Promise<void>;
  }) => Promise<void>;
  refreshCodeCollabSharedState?: (sessionId: SessionId) => Promise<void>;
  notifySessionCompleted: (
    sessionId: SessionId,
    userId: string,
    occurrenceId: string
  ) => Promise<void>;
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

type TurnInvocation = {
  /** Causal input Turn for authorization and durable provenance. */
  sourceTurnId: string;
  requesterUserId?: string;
  inputConfig: SessionTurnInputConfig;
};

type TurnRuntimeState = {
  sessionId: SessionId;
  /** Logical chain tail exposed to Web, cancel, and optimistic steer validation. */
  turnId: string;
  userTurnId?: string;
  invocation?: TurnInvocation;
  session?: ISession;
  project?: ProjectRef;
  baseCommitHash?: string | null;
  turnStartWorkingTreeDiff?: GitWorkingTreeDiffBaseline | null;
  promptStarted: boolean;
  promptInFlight: boolean;
  autoPromptInFlight: boolean;
  promptFailed: boolean;
  finalizeStarted: boolean;
  finalizeCompleted: boolean;
  prePromptFailureRecorded: boolean;
  cancelRequested: boolean;
  cancelFinalized: boolean;
  interruptRequested: boolean;
  terminateSessionOnCancel: boolean;
  /** Logical prompt tail currently owned by the one session-owner fiber. */
  activePromptRun?: PromptHandoffRun;
  /** Serialized ancillary finalization for yielded logical turns. */
  yieldedFinalization: Promise<void>;
  pendingSession?: Promise<ISession>;
  fiber?: Fiber.RuntimeFiber<unknown, unknown>;
};

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
  /** True while post-turn automation owns an ACP prompt. */
  hasActiveAutomation: boolean;
};

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
  sessionId: SessionId;
  sessionDoc: SessionDocument;
  session?: ISession;
  userTurnId?: string;
  invocation?: TurnInvocation;
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
export type SessionDispatchSource = 'rpc' | 'crdt' | 'queue' | 'delivery';

type SessionDispatchOptions = {
  dispatchSource?: SessionDispatchSource;
  /**
   * Runs only after this process has synchronously claimed the per-Session
   * visible-turn owner. Delivery uses this to append its system cause without
   * racing a user dispatch between the idle check and the history write.
   */
  onTurnClaimed?: () => Promise<void>;
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

class SessionTurnHalted extends Data.TaggedError('SessionTurnHalted')<{
  sessionId: SessionId;
  reason: ChatFailedReason;
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

function truncateAnalyticsString(value: string, maxLength = 1_000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export type SessionExecutionServiceDeps = {
  logger: Logger;
  sessionManager: SessionManager;
  workspaceDocument: LoroDocumentManager;
  machineId: MachineId;
  userId: string;
  workspaceId: WorkspaceId;
  preferredBaseBranch: string;
  touchSession: (sessionId: SessionId) => void;
  startSessionActivePresence: (
    sessionId: SessionId,
    phase?: SessionActivePresencePhase | null
  ) => void;
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
    }
  ) => Promise<void>;
  createAssistantEntryForTurn: (
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    turnId: string,
    modelInfo: ModelInfo | undefined,
    userTurnId?: string
  ) => Promise<void>;
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
  maybeRenameSessionBranchFromPrompt: (
    sessionId: SessionId,
    session: ISession,
    cliType: AgentConfigCliType,
    agentType: string,
    prompt: string,
    env?: Record<string, string>
  ) => Promise<void>;
  processMessageQueue: (sessionId: SessionId) => Promise<void>;
  syncLiveActivitySummary?: (userId: string) => Promise<void>;
  collectMachineResources: () => Promise<MachineResourceInfo>;
  getMachineLifecycleCapability: () => MachineLifecycleCapability;
  /**
   * Returns true once any ACP update for the current assistant turn has been
   * buffered or flushed. Prompt recovery must not replay the same user turn after
   * visible agent output, because the adapter may already have acted on it.
   */
  hasPromptOutputForTurn?: (sessionId: SessionId, turnId: string) => boolean;
  /**
   * Same observation, but `undefined` when the session's transient state is gone
   * and the answer is unknowable. The no-output guard needs that distinction:
   * "emitted nothing" fails the turn, "cannot tell" must not.
   */
  observePromptOutputForTurn?: (sessionId: SessionId, turnId: string) => boolean | undefined;
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
    modelReasoningEfforts?: Record<string, string[]>;
    capabilitySourceVersion?: string;
  }>;
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
  Pick<AgentConfigMeta, 'cliType' | 'agentType' | 'customAcp' | 'runtimeOverrides' | 'env'>;

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
  private readonly canceledTurnBySession = new Map<SessionId, string>();
  private readonly currentTurnBySession = new Map<SessionId, string>();
  private readonly turnRuntimeBySession = new Map<SessionId, TurnRuntimeState>();
  private readonly rewriteBarrierSessions = new Set<SessionId>();
  private readonly rewriteConflictLeaseSessions = new Set<SessionId>();
  private readonly turnReleaseWaiters = new Map<SessionId, Map<string, Set<() => void>>>();
  // Serializes ownership mutations per session so prompt completion and steer
  // application never race the boundary. No global concurrency cap (Infinity):
  // this is pure per-session serialization, matching the old hand-rolled lock.
  private readonly steerMutationQueue = new ConcurrentQueue<SessionId>(Number.POSITIVE_INFINITY);
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
  private readonly inFlightAcpRefresh = new Map<string, InFlightAcpRefreshEntry>();

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

  private async markPromptWorkingStarted(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    userId: string,
    triggerReason: string
  ): Promise<void> {
    try {
      this.deps.setSessionActivePresencePhase(sessionId, 'thinking');
      await sessionDoc.setStatus(SessionStatusFactory.running());
      this.captureStatusChanged(sessionId, 'running', undefined, triggerReason);
    } catch (error) {
      this.deps.logger.warn(
        `[${sessionId}] Failed to mark prompt working: ${formatErrorMessage(error)}`
      );
      return;
    }
    this.scheduleLiveActivitySummarySync(userId, {
      sessionId,
      triggerReason,
      status: 'running',
    });
  }

  private async markPromptWorkingEnded(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    userId: string,
    triggerReason: string
  ): Promise<void> {
    try {
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
        const latestAssistant = sessionDoc.getLatestAssistantHistory?.();
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
      hasActiveAutomation: Boolean(runtime?.autoPromptInFlight),
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

  async steerSession(options: {
    sessionId: SessionId;
    expectedTurnId: string;
    userTurnId: string;
    userId: string;
    timestamp: string;
    inputConfig: SessionTurnInputConfig;
  }): Promise<SessionSteerResponse> {
    return await this.steerMutationQueue.enqueue(options.sessionId, async () => {
      const releaseConflict = this.tryAcquireSessionRewriteConflictLease(options.sessionId);
      if (!releaseConflict) {
        // Nothing was submitted, so this guide is still ours to run. Only the
        // dispatch pointer is written: the history flip needs the lease we just
        // failed to take, and dispatch honors the pointer on its own.
        await this.requeueUndeliveredSteer(options.sessionId, options.userTurnId, {
          canWriteHistory: false,
        });
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
  }

  private async steerSessionLocked(options: {
    sessionId: SessionId;
    expectedTurnId: string;
    userTurnId: string;
    userId: string;
    timestamp: string;
    inputConfig: SessionTurnInputConfig;
  }): Promise<SessionSteerResponse> {
    const reject = (
      disposition: Exclude<SessionSteerResponse['disposition'], 'applied'>,
      error?: string
    ): SessionSteerResponse => ({
      type: 'session/steer_response',
      sessionId: options.sessionId,
      userTurnId: options.userTurnId,
      applied: false,
      disposition,
      ...(error ? { error } : {}),
    });
    /**
     * The agent never took this prompt, so the user turn is still ours to run.
     * Only for rejections that provably happened before (or instead of) provider
     * submission — after submission the provider may already have committed the
     * steer, and re-sending would duplicate it.
     */
    const rejectUndelivered = async (
      disposition: Exclude<SessionSteerResponse['disposition'], 'applied'>,
      error?: string
    ): Promise<SessionSteerResponse> => {
      await this.requeueUndeliveredSteer(options.sessionId, options.userTurnId, {
        canWriteHistory: true,
      });
      return reject(disposition, error);
    };
    const runtime = this.turnRuntimeBySession.get(options.sessionId);
    if (!runtime || !runtime.session) {
      return await rejectUndelivered('no-active-turn');
    }
    if (runtime.turnId !== options.expectedTurnId) {
      return await rejectUndelivered('stale-turn');
    }
    if (!runtime.promptInFlight) {
      return await rejectUndelivered('no-active-turn');
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
    const { agentClient, acpSessionId } = runtime.session;
    const steerCapability = agentClient?.getAcknowledgedSteerCapability();
    if (!agentClient || !acpSessionId || !steerCapability) {
      return await rejectUndelivered('unsupported');
    }
    if (steerCapability.configPolicy === 'active') {
      const mismatch = agentClient.findSteerConfigMismatch(options.inputConfig);
      if (mismatch) {
        return await rejectUndelivered(
          'unsupported',
          `Active turn configuration differs: ${mismatch}`
        );
      }
    }
    const rejectBeforeProviderSubmission = async (): Promise<SessionSteerResponse | null> => {
      if (
        this.turnRuntimeBySession.get(options.sessionId) !== runtime ||
        runtime.turnId !== options.expectedTurnId
      ) {
        return await rejectUndelivered('stale-turn');
      }
      // No provider request has been submitted yet, so this guide is still
      // ours to run as an ordinary follow-up turn.
      if (!runtime.promptInFlight) {
        return await rejectUndelivered('no-active-turn');
      }
      return null;
    };

    // Everything up to `steerPrompt` returning is provably undelivered; after
    // that only the agent's own inject-or-refuse verdict can say so.
    let submittedToAgent = false;
    try {
      const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(options.sessionId);
      const inputBlocks = normalizeSessionInputBlocks(
        options.inputConfig.inputBlocks,
        options.inputConfig.prompt ?? ''
      );
      const promptBlocks = await this.deps.buildAcpPromptBlocks({
        workspaceId: this.deps.workspaceId,
        sessionId: options.sessionId,
        inputBlocks,
        issuePRMentions: options.inputConfig.issuePRMentions,
      });
      const preConfigRejection = await rejectBeforeProviderSubmission();
      if (preConfigRejection) {
        return preConfigRejection;
      }
      if (steerCapability.configPolicy === 'apply') {
        await this.deps.applyAcpModeAndModel(runtime.session, options.inputConfig, {
          sessionDoc,
          basedOnUserTurnId: options.userTurnId,
        });
      }

      const preSubmitRejection = await rejectBeforeProviderSubmission();
      if (preSubmitRejection) {
        return preSubmitRejection;
      }
      const ownedPromptRun = runtime.activePromptRun;
      if (!ownedPromptRun || ownedPromptRun.turnId !== runtime.turnId) {
        return await rejectUndelivered(
          'busy',
          'Prompt owner was transitioning between logical turns'
        );
      }

      const previousTurnId = runtime.turnId;
      const previousUserTurnId = runtime.userTurnId;
      const steerRun = agentClient.steerPrompt(acpSessionId, promptBlocks);
      submittedToAgent = true;
      const application = await steerRun.applied;
      try {
        if (
          this.turnRuntimeBySession.get(options.sessionId) !== runtime ||
          !runtime.promptInFlight ||
          runtime.turnId !== previousTurnId ||
          runtime.activePromptRun !== ownedPromptRun
        ) {
          return reject('stale-turn', 'Steer application arrived after ownership changed');
        }

        // The provider has accepted this steer and may execute tools before
        // history/finalization catches up. Switch causal identity first.
        runtime.invocation = {
          sourceTurnId: options.userTurnId,
          requesterUserId: options.userId,
          inputConfig: options.inputConfig,
        };

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
      const notDelivered = !submittedToAgent || error instanceof AgentSteerNotDeliveredError;
      if (!notDelivered) {
        return reject('error', formatErrorMessage(error));
      }
      // `no-active-turn` for the agent's own refusal: it is the disposition
      // steer-aware clients already treat as "re-send this turn normally", so
      // an older client recovers the message too.
      return await rejectUndelivered(
        error instanceof AgentSteerNotDeliveredError ? 'no-active-turn' : 'error',
        formatErrorMessage(error)
      );
    }
  }

  /**
   * Re-route a steer the agent never accepted into ordinary dispatch, so it runs
   * as the next message once the active turn ends — the same treatment a queued
   * message gets. Without this it would sit in `pending_apply`, which dispatch
   * skips, and never run at all.
   *
   * The `latestUserMsgId` pointer is the load-bearing half, not the entry status:
   * `SessionDispatchWatcher.sessionNeedsActiveWatch` reads META only, so a turn
   * visible solely in history is dropped the moment the session goes idle (the
   * watcher unsubscribes) and is never reconsidered, including after a daemon
   * restart. The pointer is also what survives a cancel. It is the same pointer a
   * Web send writes, so this is the ordinary dispatch signal, not a second path.
   */
  private async requeueUndeliveredSteer(
    sessionId: SessionId,
    userTurnId: string,
    { canWriteHistory }: { canWriteHistory: boolean }
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
      if (canWriteHistory) {
        const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
        if (!(await this.markSteerTurnPending(sessionDoc, userTurnId))) {
          return;
        }
      }
      await this.upsertSessionMeta(sessionId, {
        latestUserMsgId: userTurnId,
        lastMissingHistoryUserMsgId: undefined,
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
    let queueable = true;
    await sessionDoc.updateHistory((history) =>
      history.map((entry) => {
        if (entry.id !== userTurnId || entry.role !== 'user') {
          return entry;
        }
        queueable =
          entry.status === 'pending_apply' || entry.status === 'pending' || entry.status === 'seen';
        return entry.status === 'pending_apply'
          ? {
              ...entry,
              status: 'pending' as const,
              read: getLegacyReadForSessionHistoryStatus('pending'),
            }
          : entry;
      })
    );
    return queueable;
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
      'sessionId' | 'session' | 'userTurnId' | 'invocation'
    > & { turnId: string }
  ): TurnRuntimeState {
    return {
      sessionId: options.sessionId,
      turnId: options.turnId,
      userTurnId: options.userTurnId,
      invocation: options.invocation,
      session: options.session,
      promptStarted: false,
      promptInFlight: false,
      autoPromptInFlight: false,
      promptFailed: false,
      finalizeStarted: false,
      finalizeCompleted: false,
      prePromptFailureRecorded: false,
      cancelRequested: false,
      cancelFinalized: false,
      interruptRequested: false,
      terminateSessionOnCancel: false,
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
      Effect.catchAll((error) =>
        Effect.sync(() => {
          this.deps.logger.warn(`[${sessionId}] ${description}: ${formatErrorMessage(error)}`);
        })
      )
    );
  }

  private async awaitTurnFiber<T>(
    fiber: Fiber.RuntimeFiber<T, unknown>,
    sessionId: SessionId,
    turnId: string
  ): Promise<T> {
    const exit = await Effect.runPromise(Fiber.await(fiber));
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === 'Some') {
      throw failure.value;
    }
    if (Cause.isInterrupted(exit.cause)) {
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

  private acquireSessionActivePresence(
    sessionId: SessionId,
    phase: SessionActivePresencePhase | null
  ): Effect.Effect<void, unknown, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => {
        this.deps.startSessionActivePresence(sessionId, phase);
      }),
      () =>
        Effect.sync(() => {
          this.deps.clearSessionActivePresence(sessionId);
        })
    );
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
          self.tryPromise(() => self.refreshCodeCollabSharedStateAfterTurn(options.sessionId))
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
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          self.clearTurnCancellation(options.sessionId, options.turnId);
          self.clearCurrentTurn(options.sessionId, options.turnId);
        })
      ),
      Effect.catchAll((error) =>
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
    runtime.prePromptFailureRecorded = true;
    const message = formatErrorMessage(error);
    // A first turn on a brand-new session establishes the ACP session here, so
    // an agent that requires sign-in fails before the prompt. Keep the specific
    // reason: it is what lets the client offer the authentication flow instead
    // of a generic "failed before the agent could start".
    if (error instanceof AcpAuthenticationRequiredError) {
      await this.deps.recordChatFailure(sessionDoc, 'acp_auth_required', message);
    } else if (isGitExecutableNotFoundError(error)) {
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

    const gitState = await getLocalProjectGitStateAtRootPath(workdir);
    if (!gitState.git) {
      throw new Error(`Local project is not a git repository: ${project.localProjectId}`);
    }

    const resolvedBranch = await resolveLocalProjectBranchAtRootPath(workdir, branch, {
      preferLocalOnCollision: true,
    });

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
        await checkoutLocalProjectBranchAtRootPath(
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
            timeoutMs: readTimeoutEnv('LODY_LOCAL_PROJECT_RESOLVE_SYNC_TIMEOUT_MS', 1_500),
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
    await this.deps.turnFinalization.finalizeACPState(sessionId);
    await this.persistCodeCollabTurnDiffsAfterACPFinalization(
      sessionId,
      this.currentTurnBySession.get(sessionId)
    );
    await this.deps.turnFinalization.flushSessionUsage(sessionId);

    if (error) {
      const acpError = parseACPError(error);

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
          this.deps.logger.debug(
            `[${sessionId}] Terminating session due to ACP error (code=${acpError.code})`
          );
          try {
            await this.deps.sessionManager.terminateSession(sessionId, true);
          } catch (terminateError) {
            this.deps.logger.debug(
              `[${sessionId}] Failed to terminate session after ACP error: ${formatErrorMessage(terminateError)}`
            );
          }
        }
      } else if (isAgentDisconnectedError(error)) {
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

    await this.refreshCodeCollabSharedStateAfterTurn(sessionId);
    await sessionDoc.waitUntilSynced();
    await sessionDoc.setStatus(SessionStatusFactory.idle());
  }

  private async refreshCodeCollabSharedStateAfterTurn(sessionId: SessionId): Promise<void> {
    const refresh = this.deps.turnFinalization.refreshCodeCollabSharedState;
    if (!refresh) {
      return;
    }
    try {
      await refresh(sessionId);
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] Failed to refresh Code Collab v2 shared state after turn: ${formatErrorMessage(error)}`
      );
    }
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
      userId,
      project,
    } = ctx;
    const isTurnCancelled = ctx.isTurnCancelled ?? (() => false);
    const stopIfTurnCancelled = async (stage: string): Promise<boolean> => {
      if (!isTurnCancelled() && !ctx.abortSignal?.aborted) {
        return false;
      }
      this.deps.logger.debug(
        `[${sessionId}] Turn ${turnId} was cancelled during ${stage}; skipping remaining completion post-processing`
      );
      await sessionDoc.setStatus(SessionStatusFactory.idle());
      this.deps.touchSession(sessionId);
      return true;
    };

    const codeCollabHistoryFileDiffPersisted = await this.finalizeTurnOutput(sessionId, turnId);

    if (await stopIfTurnCancelled('ACP finalization')) {
      return;
    }

    const githubProject = resolveProjectGitHubRepo(project);
    let branchName: string | null = null;
    let preferredStatsBaseBranch = project?.branch;
    if (project?.kind === 'local') {
      preferredStatsBaseBranch =
        (await sessionDoc.getMetaState())?.baseBranch?.trim() || preferredStatsBaseBranch;
    }

    if (githubProject) {
      branchName = await this.runTurnFinalizationStage(
        sessionId,
        turnId,
        'syncSessionBranchName',
        async () => await this.deps.turnFinalization.syncSessionBranchName(sessionId, session)
      );

      if (await stopIfTurnCancelled('branch synchronization')) {
        return;
      }

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
      });

      if (await stopIfTurnCancelled('diff recording')) {
        return;
      }
    }

    if (githubProject) {
      try {
        await this.runTurnFinalizationStage(
          sessionId,
          turnId,
          'autoCommitAndPushForPR',
          async () => {
            await this.deps.turnFinalization.autoCommitAndPushForPR({
              sessionId,
              session,
              sessionDoc,
              project,
              preferredBaseBranch: preferredStatsBaseBranch,
              userId,
              isTurnCancelled,
              abortSignal: ctx.abortSignal,
              onAutoPromptStart: ctx.onAutoPromptStart,
              onAutoPromptEnd: ctx.onAutoPromptEnd,
            });
          }
        );
      } catch (error) {
        this.deps.logger.error(
          `[${sessionId}] auto-commit-push failed: ${formatErrorMessage(error)}`
        );
      }

      if (await stopIfTurnCancelled('auto-commit/push')) {
        return;
      }
    }

    await this.runTurnFinalizationStage(
      sessionId,
      turnId,
      'refreshCodeCollabSharedState',
      async () => {
        await this.refreshCodeCollabSharedStateAfterTurn(sessionId);
      }
    );
    await this.runTurnFinalizationStage(
      sessionId,
      turnId,
      'sessionDoc.waitUntilSynced',
      async () => {
        await sessionDoc.waitUntilSynced();
      }
    );
    await this.runTurnFinalizationStage(sessionId, turnId, 'captureTurnCompleted', async () => {
      await this.captureTurnCompleted(sessionId, sessionDoc, turnId);
    });
    this.deps.logger.info(`Session chat completed: ${sessionId}`);

    try {
      await this.runTurnFinalizationStage(
        sessionId,
        turnId,
        'sessionDoc.setLastMessageAt',
        async () => {
          await sessionDoc.setLastMessageAt();
        }
      );
    } catch (error) {
      this.deps.logger.debug(
        `[${sessionId}] Failed to persist session lastMessageAt: ${formatErrorMessage(error)}`
      );
    }
    this.deps.touchSession(sessionId);

    // A manual stop during finalization interrupts the owning fiber, but this promise is
    // orphaned and keeps running to completion. Without this guard it would reach the
    // "session completed" push below, notifying the user that the agent finished on its own
    // even though they stopped it. Re-check cancellation right before notifying so manual
    // termination never sends a completion notification.
    if (isTurnCancelled() || ctx.abortSignal?.aborted) {
      this.deps.logger.debug(
        `[${sessionId}] Turn ${turnId} was cancelled before completion notification; skipping session completion notification`
      );
      return;
    }

    // A turn that produced nothing is reported as a failure in chat, so pushing
    // "your session finished" for it would contradict what the user sees.
    if (ctx.producedOutput === false) {
      this.deps.logger.debug(
        `[${sessionId}] Turn ${turnId} produced no agent output; skipping session completion notification`
      );
      return;
    }

    await this.runTurnFinalizationStage(sessionId, turnId, 'notifySessionCompleted', async () => {
      await this.deps.turnFinalization.notifySessionCompleted(sessionId, userId, turnId);
    });
  }

  private async runVisibleSessionTurn(
    options: VisibleSessionTurnOptions,
    body: (ctx: VisibleSessionTurnContext) => Effect.Effect<void, unknown, Scope.Scope>
  ): Promise<string> {
    const { sessionId, sessionDoc, userTurnId } = options;
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

    let turnId!: string;
    let runtime!: TurnRuntimeState;
    try {
      turnId = this.deps.beginConversationTurn(sessionId, userTurnId, {
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
    const self = this;
    let assistantEntryOpened = false;
    let effectiveErrorContext: VisibleSessionTurnUnhandledErrorContext = {
      code: options.unhandledErrorCode,
      describe: options.describeUnhandledError,
      ...(options.onUnhandledError ? { onUnhandledError: options.onUnhandledError } : {}),
    };

    const program = Effect.scoped(
      Effect.acquireRelease(Effect.succeed(runtime), (turnRuntime, exit) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => turnRuntime.yieldedFinalization);
          const wasInterrupted = Exit.isFailure(exit) && Cause.isInterrupted(exit.cause);
          const wasCancelled =
            turnRuntime.cancelRequested ||
            self.isTurnCancelled(sessionId, turnRuntime.turnId) ||
            wasInterrupted;
          if (wasCancelled) {
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
          self.releaseTurnRuntime(sessionId, turnRuntime.turnId);
        })
      ).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            yield* self.acquireSessionActivePresence(sessionId, 'initializing');

            const setUnhandledErrorContext = (
              context: VisibleSessionTurnUnhandledErrorContext
            ): void => {
              effectiveErrorContext = context;
            };

            const bindSession = (nextSession: ISession): void => {
              runtime.session = nextSession;
              runtime.pendingSession = undefined;
            };

            const trackPendingSession = (
              pendingSession: Promise<ISession> | (() => Promise<ISession>),
              pendingOptions?: { terminateOnCancel?: boolean }
            ): Effect.Effect<ISession, unknown, never> =>
              Effect.gen(function* () {
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

            const abortIfCancelled = (cancelOptions?: {
              terminateSession?: boolean;
            }): Effect.Effect<void, unknown, never> =>
              Effect.gen(function* () {
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

            const openAssistantEntry = (openOptions?: {
              analytics?: VisibleSessionTurnAnalytics;
              unhandledErrorContext?: VisibleSessionTurnUnhandledErrorContext;
            }): Effect.Effect<void, unknown, never> =>
              Effect.gen(function* () {
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
                        userTurnId
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
                      async () =>
                        await self.setDispatchProcessing(sessionId, sessionDoc, userTurnId)
                    )
                  );
                }
                return undefined;
              });

            const prompt = (promptBlocks: ContentBlock[]): Effect.Effect<void, unknown, never> =>
              Effect.gen(function* () {
                const activeSession = runtime.session;
                const agentClient = activeSession?.agentClient;
                const acpSessionId = activeSession?.acpSessionId;
                if (!agentClient || !acpSessionId) {
                  yield* Effect.fail(new Error('Agent session was not ready'));
                  return undefined;
                }
                runtime.terminateSessionOnCancel = false;
                self.deps.activateConversationTurnForACPUpdates(sessionId, runtime.turnId);
                runtime.promptStarted = true;

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
                            const initialRun = self.createPromptHandoffRun({
                              turnId: runtime.turnId,
                              promptPromise: agentClient.prompt(acpSessionId, promptBlocks, {
                                signal,
                              }),
                            });
                            await self.awaitPromptHandoffTail(runtime, initialRun);
                          }
                        )
                      )
                      .pipe(
                        Effect.catchAll((error) =>
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

            yield* body({
              turnId: runtime.turnId,
              runtime,
              setUnhandledErrorContext,
              bindSession,
              trackPendingSession,
              abortIfCancelled,
              openAssistantEntry,
              prompt,
            });
          })
        )
      )
    );

    const fiber = Effect.runFork(program);
    runtime.fiber = fiber;
    try {
      await this.awaitTurnFiber(fiber, sessionId, turnId);
      if (outcome === 'unknown') {
        outcome = 'completed';
      }
    } catch (error) {
      if (isSessionTurnHalted(error)) {
        outcome = `halted-${error.reason}`;
        await this.finalizeHaltedTurn({
          sessionId,
          sessionDoc,
          turnId: runtime.turnId,
          reason: error.reason,
        });
        return outcome;
      }

      if (
        isSessionTurnCancelled(error) ||
        runtime.cancelFinalized ||
        runtime.cancelRequested ||
        this.isTurnCancelled(sessionId, runtime.turnId) ||
        (await this.isUserTurnCancelled(sessionDoc, runtime.userTurnId))
      ) {
        outcome = 'cancelled';
        return outcome;
      }

      await this.handleVisibleTurnUnhandledError({
        sessionId,
        sessionDoc,
        userTurnId: runtime.userTurnId,
        runtime,
        error,
        code: effectiveErrorContext.code,
        describe: effectiveErrorContext.describe,
        onUnhandledError: effectiveErrorContext.onUnhandledError,
      });
      outcome = 'unhandled-error-recorded';
    } finally {
      if (!runtime.promptStarted) {
        this.deps.clearConversationTurn(sessionId, runtime.turnId);
      }
      span.end({ outcome, turnId });
    }
    return outcome;
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
    sessionDoc: SessionDocument,
    userTurnId: string,
    status: 'pending' | 'seen' | 'processing' | 'handled' | 'failed' | 'canceled'
  ): Promise<boolean> {
    let matched = false;
    await sessionDoc.updateHistory((history) =>
      history.map((entry) => {
        if (entry.id !== userTurnId || entry.role !== 'user') {
          return entry;
        }
        matched = true;
        return {
          ...entry,
          status,
          read: getLegacyReadForSessionHistoryStatus(status),
        };
      })
    );
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
    const matched = await this.setUserTurnStatus(sessionDoc, userTurnId, status);
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
      }
    | undefined {
    const runtime = this.turnRuntimeBySession.get(sessionId);
    if (!runtime) {
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
    };
  }

  private async setDispatchProcessing(
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    userTurnId: string
  ): Promise<void> {
    await this.setUserTurnStatus(sessionDoc, userTurnId, 'processing');
    await this.upsertSessionMeta(sessionId, {
      // Dispatch producers own `latestUserMsgId`. Execution only claims its
      // own processing slot, so an awaited status write can never overwrite a
      // newer activation published by another peer.
      processingUserMsgId: userTurnId,
    });
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
    await options.sessionDoc.updateHistory((history) =>
      history.map((entry) => {
        if (entry.id !== options.nextUserTurnId || entry.role !== 'user') {
          return entry;
        }
        return {
          ...entry,
          status: 'processing' as const,
          read: true,
          inputConfig: {
            ...entry.inputConfig,
            _lodyDeliveryKind: 'steer',
          },
        };
      })
    );
    await this.upsertSessionMeta(options.sessionId, {
      latestUserMsgId: options.nextUserTurnId,
      ...(options.previousUserTurnId ? { lastHandledUserMsgId: options.previousUserTurnId } : {}),
      processingUserMsgId: options.nextUserTurnId,
      lastMissingHistoryUserMsgId: undefined,
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
    const getHistory = (
      sessionDoc as { getHistory?: (() => Promise<SessionHistoryInput[]>) | undefined }
    ).getHistory;
    if (!getHistory) {
      return [];
    }
    return await getHistory.call(sessionDoc);
  }

  private async isUserTurnCancelled(
    sessionDoc: SessionDocument,
    userTurnId: string | undefined
  ): Promise<boolean> {
    if (!userTurnId) {
      return false;
    }
    const history = await this.getSessionHistory(sessionDoc);
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
      existingMeta?.processingUserMsgId ?? userTurnId ?? existingMeta?.latestUserMsgId;
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
  private turnProducedVisibleOutput(sessionId: SessionId, turnId: string): boolean {
    // No observer wired, or transient state already gone: we cannot tell, and a
    // guess here would fail a turn that actually answered. Fail open.
    return this.deps.observePromptOutputForTurn?.(sessionId, turnId) ?? true;
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
    const turn = await this.prepareContinueSessionTurn(message, dispatchOptions);
    if (
      dispatchOptions?.dispatchSource !== 'delivery' &&
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
          Effect.promise(dispatchOptions.onTurnClaimed!).pipe(Effect.flatMap(() => turn.body(ctx)))
      : turn.body;
    await this.runVisibleSessionTurn(turn.options, body);
  }

  private async prepareContinueSessionTurn(
    message: SessionChatRequestValidated,
    dispatchOptions?: SessionDispatchOptions,
    prepareOptions?: { sessionDoc?: SessionDocument }
  ): Promise<VisibleSessionTurnPlan> {
    const { sessionId, acpSessionConfig, userId, userName, userEmail, userTurnId } = message;
    const executionUserTurnId =
      dispatchOptions?.dispatchSource === 'delivery' ? undefined : userTurnId;
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
      inputBlockCount: normalizeSessionInputBlocks(
        acpSessionConfig.inputBlocks,
        acpSessionConfig.prompt
      ).length,
      ...(acpSessionConfig.cliType ? { cliType: acpSessionConfig.cliType } : {}),
      ...(acpSessionConfig.agentType ? { agentType: acpSessionConfig.agentType } : {}),
      ...(dispatchOptions?.dispatchSource
        ? { dispatchSource: dispatchOptions.dispatchSource }
        : {}),
    };

    const restoreMissingSession = (
      ctx: VisibleSessionTurnContext
    ): Effect.Effect<ISession, unknown, Scope.Scope> =>
      Effect.gen(function* () {
        const meta = yield* self.tryPromise(() => sessionDoc.getMetaState());
        project = project ?? self.resolveProjectFromMeta(meta, message.project?.branch);
        const localProjectId = project?.kind === 'local' ? project.localProjectId : undefined;
        const restoreWorkdir = localProjectId
          ? ((yield* self.tryPromise(() =>
              self.resolveLocalProjectWorkdirForTurn(localProjectId)
            )) ?? undefined)
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
          (meta.cliType !== acpSessionConfig.cliType ||
            meta.agentType !== acpSessionConfig.agentType)
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
          sessionId,
          workspaceId: message.workspaceId,
          agentCliType: acpSessionConfig.cliType,
          agentType: acpSessionConfig.agentType,
          configOptionValues: acpSessionConfig.configOptionValues,
          mcpServerIds: acpSessionConfig.mcpServerIds ?? [],
          taskToolsEnabled: acpSessionConfig.taskToolsEnabled === true,
          customAcp: resumeCustomAcp,
          runtimeOverrides: resumeRuntimeOverrides,
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
          onPresencePhase: (phase, detail) =>
            self.deps.setSessionActivePresencePhase(sessionId, phase, detail),
        };

        const restoreAttempt = Effect.gen(function* () {
          if (resumeSessionId) {
            yield* acpReplaySuppression.acquire;
          }
          self.deps.logger.debug(
            `[${sessionId}] Session restore createSession started (resumeSessionId=${resumeSessionId ?? 'none'})`
          );
          const restoredSession = yield* ctx.trackPendingSession(
            () =>
              self.deps.sessionManager.createSession(restoreConfig, {
                resumeSessionId,
              }),
            { terminateOnCancel: true }
          );
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
            const history = yield* self.tryPromise(() => sessionDoc.getHistory());
            if (history.length > 0) {
              replayPromptResult = buildReplayPromptFromHistory({
                history,
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
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              yield* ctx.abortIfCancelled();
              const errMessage = formatErrorMessage(error);
              const lowerMessage = errMessage.toLowerCase();
              const isAcpResumeError =
                lowerMessage.includes('acp_resume_unsupported') ||
                lowerMessage.includes('acp_resume_failed');

              if (isAcpResumeError && resumeSessionId) {
                self.deps.logger.debug(
                  `[${sessionId}] ACP resume failed, attempting fallback with chat history replay`
                );
                yield* acpReplaySuppression.release;

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

                  const history = yield* self.tryPromise(() => sessionDoc.getHistory());
                  if (history.length > 0) {
                    replayPromptResult = buildReplayPromptFromHistory({
                      history,
                      excludeTurnId: message.userTurnId,
                    });

                    self.deps.logger.debug(
                      `[${sessionId}] Built replay prompt (chars=${replayPromptResult.stats.usedChars} messages=${replayPromptResult.stats.messagesIncluded} paths=${replayPromptResult.stats.pathsCount} truncated=${replayPromptResult.stats.truncated} terminalOmitted=${replayPromptResult.stats.terminalOmitted} thinkingOmitted=${replayPromptResult.stats.thinkingOmitted})`
                    );
                  }
                  return fallbackSession;
                });

                return yield* fallbackAttempt.pipe(
                  Effect.catchAll((fallbackError) =>
                    Effect.gen(function* () {
                      yield* ctx.abortIfCancelled();
                      const fallbackErrMessage = formatErrorMessage(fallbackError);
                      self.deps.logger.error(
                        `[${sessionId}] Fallback restore also failed: ${fallbackErrMessage}`
                      );
                      return yield* self.recordKnownChatFailureAndHaltEffect({
                        sessionId,
                        sessionDoc,
                        userTurnId: executionUserTurnId,
                        reason:
                          fallbackError instanceof AcpAuthenticationRequiredError
                            ? 'acp_auth_required'
                            : 'session_restore_failed',
                        message: fallbackErrMessage,
                      });
                    })
                  )
                );
              }

              yield* acpReplaySuppression.release;
              self.deps.logger.error(
                `[${sessionId}] Failed to restore session for chat: ${errMessage}`
              );
              return yield* self.recordKnownChatFailureAndHaltEffect({
                sessionId,
                sessionDoc,
                userTurnId: executionUserTurnId,
                reason:
                  error instanceof AcpAuthenticationRequiredError
                    ? 'acp_auth_required'
                    : 'session_restore_failed',
                message: errMessage,
              });
            })
          )
        );
      });

    const runReadySessionTurn = (
      readySession: ISession,
      ctx: VisibleSessionTurnContext
    ): Effect.Effect<void, unknown, Scope.Scope> =>
      Effect.gen(function* () {
        const { turnId, runtime, abortIfCancelled, openAssistantEntry, prompt } = ctx;
        let activeSession = readySession;
        let staleAcpPromptRecoveryAttempted = false;
        let baseCommitHash: string | null = null;
        let turnStartWorkingTreeDiff: GitWorkingTreeDiffBaseline | null = null;

        const bindReadySession = (nextSession: ISession): void => {
          activeSession = nextSession;
          session = nextSession;
          ctx.bindSession(nextSession);
          nextSession.updateGitIdentity(userName, userEmail, message.userId);
        };

        const sessionInputBlocks = normalizeSessionInputBlocks(
          acpSessionConfig.inputBlocks,
          acpSessionConfig.prompt
        );
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

        const maybeRecordHistoryReplayNotice = (): Effect.Effect<void, unknown, never> =>
          Effect.gen(function* () {
            if (!usedHistoryReplay || !replayPromptResult) {
              return undefined;
            }
            const history = yield* self.tryPromise(() => sessionDoc.getHistory());
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
            yield* self.tryPromise(() =>
              sessionDoc.updateHistory((prevHistory) => {
                let insertIndex = prevHistory.length;
                for (let i = prevHistory.length - 1; i >= 0; i--) {
                  const entry = prevHistory[i];
                  if (entry && entry.role === 'user') {
                    insertIndex = i;
                    break;
                  }
                }
                const nextHistory = [...prevHistory];
                nextHistory.splice(insertIndex, 0, systemNotice);
                return nextHistory;
              })
            );
            return undefined;
          });

        const applyPromptConfig = (
          targetSession: ISession,
          triggerReason: 'initial' | 'stale_acp_recovery'
        ): Effect.Effect<void, unknown, never> =>
          self.tryPromise(() =>
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
                  }
                )
            )
          );

        const refreshPromptGitHubToken = (
          targetSession: ISession,
          triggerReason: 'initial' | 'stale_acp_recovery'
        ): Effect.Effect<void, unknown, never> =>
          Effect.gen(function* () {
            // Refresh GH_TOKEN before the ACP turn so the agent has a fresh token for git/gh operations.
            // Installation tokens expire ~1h; refreshing at turn start avoids mid-turn auth failures.
            if (!project) {
              const meta = yield* self.tryPromise(() => sessionDoc.getMetaState());
              project = self.resolveProjectFromMeta(meta, message.project?.branch);
            }
            const githubRepo = resolveProjectGitHubRepo(project);
            if (!githubRepo) {
              return undefined;
            }
            yield* self.tryPromise(() =>
              traceAsync(
                self.deps.logger,
                'execution.refresh_gh_token',
                { sessionId, turnId, triggerReason },
                async () =>
                  await self.deps.sessionManager.refreshGhTokenForSession(
                    targetSession,
                    githubRepo,
                    userId
                  )
              )
            );
            return undefined;
          });

        const capturePromptBaseline = (
          targetSession: ISession,
          triggerReason: 'initial' | 'stale_acp_recovery'
        ): Effect.Effect<void, unknown, never> =>
          Effect.gen(function* () {
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

        // A disposed ACP JSON-RPC connection means the adapter rejected the prompt before it
        // could own the turn. Retry only once, and only while MessageHandler reports no ACP
        // output for this assistant entry, so we never replay a prompt that may have acted.
        const promptWithStaleACPRecovery = (
          promptBlocks: ContentBlock[]
        ): Effect.Effect<void, unknown, Scope.Scope> =>
          prompt(promptBlocks).pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                const hasPromptOutput =
                  self.deps.hasPromptOutputForTurn?.(sessionId, runtime.turnId) ?? false;
                if (
                  runtime.turnId !== turnId ||
                  !shouldRecoverStaleACPConnectionPrompt({
                    error,
                    alreadyAttempted: staleAcpPromptRecoveryAttempted,
                    hasPromptOutput,
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
                yield* self.ignoreWithWarning(
                  sessionId,
                  'Failed to terminate stale ACP session before prompt retry',
                  self.tryPromise(() => self.deps.sessionManager.terminateSession(sessionId, true))
                );
                session = null;
                runtime.session = undefined;
                runtime.pendingSession = undefined;

                const restoredSession = yield* restoreMissingSession(ctx);
                bindReadySession(restoredSession);
                yield* acpReplaySuppression.release;
                yield* applyPromptConfig(restoredSession, 'stale_acp_recovery');
                yield* maybeRecordHistoryReplayNotice();
                yield* refreshPromptGitHubToken(restoredSession, 'stale_acp_recovery');
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

        yield* refreshPromptGitHubToken(activeSession, 'initial');
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
        const producedOutput = self.turnProducedVisibleOutput(sessionId, completedTurnId);

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
                userId: completedRequesterUserId,
                project,
                producedOutput,
                isTurnCancelled: () => self.isTurnCancelled(sessionId, completedTurnId),
                abortSignal: signal,
                onAutoPromptStart: async () => {
                  runtime.autoPromptInFlight = true;
                  await self.markPromptWorkingStarted(
                    sessionId,
                    sessionDoc,
                    completedRequesterUserId,
                    'auto_prompt_started'
                  );
                },
                onAutoPromptEnd: async () => {
                  runtime.autoPromptInFlight = false;
                  await self.markPromptWorkingEnded(
                    sessionId,
                    sessionDoc,
                    completedRequesterUserId,
                    'auto_prompt_completed'
                  );
                },
              })
          )
        );
        runtime.finalizeCompleted = true;

        yield* abortIfCancelled();

        if (!producedOutput) {
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
            Effect.catchAll((error) =>
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
        ...(session ? { session } : {}),
        userTurnId: executionUserTurnId,
        invocation: {
          sourceTurnId: userTurnId,
          requesterUserId: userId,
          inputConfig: acpSessionConfig,
        },
        ...(dispatchOptions?.dispatchSource
          ? { dispatchSource: dispatchOptions.dispatchSource }
          : {}),
        unhandledErrorCode: turnErrorContext.code,
        describeUnhandledError: turnErrorContext.describe,
      },
      body: (ctx) =>
        Effect.gen(function* () {
          ctx.setUnhandledErrorContext(turnErrorContext);
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
            (!readySession.agentClient?.isCreated() || !readySession.acpSessionId)
          ) {
            const pending = self.deps.sessionManager.getPendingSession(sessionId);
            if (pending) {
              self.deps.logger.debug(
                `[${sessionId}] Session is still initializing; waiting for readiness`
              );
              readySession = yield* ctx.trackPendingSession(pending).pipe(
                Effect.catchAll((error: unknown) =>
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
      configOptionValues: acpSessionConfig.configOptionValues,
      mcpServerIds: acpSessionConfig.mcpServerIds ?? [],
      taskToolsEnabled: acpSessionConfig.taskToolsEnabled === true,
      agentConfigId: existingMeta?.agentConfigId,
      customAcp: acpSessionConfig.customAcp,
      runtimeOverrides: acpSessionConfig.runtimeOverrides,
      requesterUserId: message.userId,
      machineId: this.deps.machineId,
      assumeDocExisting: true,
      env,
      githubRepo: githubRepoFullName,
      branch,
      project,
      worktreeSetup: message.worktreeSetup,
      worktreeCleanup: message.worktreeCleanup,
      workdir,
      parentSessionId: message.parentSessionId,
      userName: message.userName,
      userEmail: message.userEmail,
      onPresencePhase: (phase, detail) =>
        this.deps.setSessionActivePresencePhase(sessionId, phase, detail),
    };

    // Fold the dispatch-start meta fields into the status transition so the
    // latency-critical create path performs one doc-meta upsert instead of five
    // sequential ones.
    const dispatchStartPatch: Partial<SessionMeta> = {};
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

    void this.deps.maybeGenerateAndStoreSessionTitle(
      sessionId,
      sessionConfig.agentCliType,
      sessionConfig.agentType,
      agentConfig.prompt,
      env,
      acpSessionConfig.customAcp,
      acpSessionConfig.runtimeOverrides
    );

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
      inputBlockCount: normalizeSessionInputBlocks(agentConfig.inputBlocks, agentConfig.prompt)
        .length,
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
      }) =>
        Effect.gen(function* () {
          setUnhandledErrorContext(turnErrorContext);
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

          const normalizedInputBlocks = normalizeSessionInputBlocks(
            agentConfig.inputBlocks,
            agentConfig.prompt
          );
          const nonTextInputBlocks = normalizedInputBlocks.filter(
            (block): block is Exclude<SessionInputBlock, { type: 'text' }> => block.type !== 'text'
          );
          const createPromptText = buildPrompt(
            agentConfig.prompt,
            project,
            agentConfig.issuePRMentions,
            fromFeedbackPostId
          );
          const startPromptBlocksBuild = () => {
            const promise = traceAsync(
              self.deps.logger,
              'execution.build_acp_prompt_blocks',
              {
                sessionId,
                turnId,
                inputBlocks: nonTextInputBlocks.length + 1,
              },
              async () =>
                await self.deps.buildAcpPromptBlocks({
                  workspaceId,
                  sessionId,
                  inputBlocks: [...nonTextInputBlocks, { type: 'text', text: createPromptText }],
                })
            );
            void promise.catch(() => undefined);
            return promise;
          };

          sessionConfig.worktreeScriptHistoryInsertBeforeEntryId = turnId;
          const session = yield* trackPendingSession(
            () => self.deps.sessionManager.createSession(sessionConfig),
            { terminateOnCancel: true }
          );
          bindSession(session);
          self.scheduleCreatedSessionCapabilityUpdate(session, sessionConfig);
          yield* abortIfCancelled({ terminateSession: true });
          // First-turn attachments are materialized under the session workspace.
          // Start this as soon as createSession has registered the workspace, but
          // do not start it earlier or attachments fall back to "unavailable".
          const promptBlocksPromise = startPromptBlocksBuild();

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
          if (shouldPrepareWorktree) {
            void self.deps.maybeRenameSessionBranchFromPrompt(
              sessionId,
              session,
              sessionConfig.agentCliType,
              sessionConfig.agentType,
              agentConfig.prompt ?? '',
              env
            );
          }

          yield* self.tryPromise(() =>
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
          yield* abortIfCancelled();

          yield* prompt(promptBlocks);
          yield* self.tryPromise(() => runtime.yieldedFinalization);

          const completedTurnId = runtime.turnId;
          const completedUserTurnId = runtime.userTurnId ?? userTurnId;
          const completedRequesterUserId =
            runtime.invocation?.requesterUserId ?? sessionConfig.requesterUserId;
          // Read before finalization clears the turn's ACP update state.
          const producedOutput = self.turnProducedVisibleOutput(sessionId, completedTurnId);

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
                  userId: completedRequesterUserId,
                  project,
                  producedOutput,
                  isTurnCancelled: () => self.isTurnCancelled(sessionId, completedTurnId),
                  abortSignal: signal,
                  onAutoPromptStart: async () => {
                    runtime.autoPromptInFlight = true;
                    await self.markPromptWorkingStarted(
                      sessionId,
                      sessionDoc,
                      completedRequesterUserId,
                      'auto_prompt_started'
                    );
                  },
                  onAutoPromptEnd: async () => {
                    runtime.autoPromptInFlight = false;
                    await self.markPromptWorkingEnded(
                      sessionId,
                      sessionDoc,
                      completedRequesterUserId,
                      'auto_prompt_completed'
                    );
                  },
                })
            )
          );
          runtime.finalizeCompleted = true;

          yield* abortIfCancelled();

          if (!producedOutput) {
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

  async cancelSession(message: SessionCancelRequestValidated): Promise<{
    success: boolean;
    error?: string;
  }> {
    const { sessionId, turnId } = message;
    this.deps.logger.info(`Session stop requested: ${sessionId}`);
    this.deps.logger.debug(`[${sessionId}] Received stop request for turn ${turnId}`);
    const sessionDoc = await this.deps.workspaceDocument.getOrCreateSessionDoc(sessionId);
    const activeTurnId = this.deps.getActiveTurnId(sessionId);
    const executionTurnId = this.currentTurnBySession.get(sessionId);
    const isPrompting = activeTurnId === turnId;
    const isCurrentExecutionTurn = executionTurnId === turnId;
    const currentTurnId = activeTurnId ?? this.currentTurnBySession.get(sessionId);
    // Cancel is exact-match only: a stale stop request must not interrupt a newer assistant turn.
    if (!isPrompting && !isCurrentExecutionTurn) {
      this.deps.logger.debug(
        `[${sessionId}] Ignoring stop request for stale turn ${turnId} (current=${currentTurnId ?? 'none'})`
      );
      await this.clearCancelRequest(sessionId);
      this.clearTurnCancellation(sessionId, turnId);
      return { success: true };
    }

    this.markTurnCancelled(sessionId, turnId);
    const runtime = this.getTurnRuntime(sessionId, turnId);
    if (runtime) {
      runtime.cancelRequested = true;
      if (runtime.finalizeStarted) {
        this.deps.logger.debug(
          `[${sessionId}] Stop request received while turn ${turnId} is finalizing; interrupting owner turn`
        );
        this.requestTurnInterrupt(runtime);
        if (runtime.autoPromptInFlight) {
          this.requestAgentCancelInBackground(runtime, 'finalizing');
        }
        return { success: true };
      }
      const runtimeSession = runtime.session ?? this.deps.sessionManager.getSession(sessionId);
      if (runtime.promptInFlight) {
        if (!runtimeSession?.agentClient?.isCreated() || !runtimeSession.acpSessionId) {
          this.deps.logger.debug(
            `[${sessionId}] Stop requested while prompt is in flight but ACP session is not ready; interrupting owner turn`
          );
          this.requestTurnInterrupt(runtime);
          return { success: true };
        }
        this.requestTurnInterrupt(runtime);
        this.requestAgentCancelInBackground(runtime, 'active');
        return { success: true };
      }

      this.deps.logger.debug(
        `[${sessionId}] Stop request recorded for turn ${turnId}; interrupting owner turn`
      );
      this.requestTurnInterrupt(runtime);
      return { success: true };
    }

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
        capabilities.acknowledgedSteer
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
      requestId: message.requestId,
      cliType: config.cliType,
      agentType: config.agentType,
      customAcp: config.customAcp,
      runtimeOverrides: config.runtimeOverrides,
      env: config.env,
      onProgress,
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
            env: config.env,
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
        env: config.env,
      },
      options
    );
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
      message.runtimeOverrides
    );

    this.deps.logger.debug(
      `[acp-capabilities] Refresh requested (cliType=${message.cliType} agentType=${message.agentType})`
    );
    if (options.signal?.aborted) {
      throw createAcpRefreshAbortError();
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

  private async executeAcpRefresh(
    message: ResolvedMachineAcpCapabilitiesRefreshRequest,
    options: AcpBinaryProgressOptions = {}
  ): Promise<MachineAcpCapabilitiesRefreshResponse> {
    try {
      options.signal?.throwIfAborted();
      await this.emitBuiltinRuntimeStatusForRefresh(message, options.onAcpBinaryProgress);
      options.signal?.throwIfAborted();
      const {
        modes,
        models,
        configOptions,
        availableCommands,
        sessionFork,
        acknowledgedSteer,
        modelReasoningEfforts,
        capabilitySourceVersion,
      } = await this.deps.fetchAcpCapabilities(
        message.cliType,
        message.agentType,
        message.env,
        message.customAcp,
        message.runtimeOverrides,
        {
          signal: options.signal,
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
            env: message.env,
          }),
        modelReasoningEfforts,
        acknowledgedSteer,
        { signal: options.signal }
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

const findRegistryAcpAgent = (agentType: string): RegistryAcpAgent | undefined =>
  REGISTRY_ACP_AGENTS.find((agent) => agent.id === agentType);

// NUL separates field segments and \x01 separates env pairs so equivalent
// env maps produce identical keys and ambiguous separators in values can't
// collide. Env vars on POSIX cannot contain either control character.
const computeAcpRefreshDedupeKey = (
  configId: AgentConfigId,
  cliType: AgentConfigCliType,
  agentType: string,
  env: Record<string, string> | undefined,
  customAcp?: CustomAcpLaunchSpec,
  runtimeOverrides?: BuiltinRuntimeOverrides
): string => {
  const sortedKeys = env ? Object.keys(env).sort() : [];
  const envSerialized = sortedKeys.map((k) => `${k}=${env![k]}`).join('\x01');
  const customSerialized = customAcp ? serializeCustomAcpLaunchSpec(customAcp) : '';
  const runtimeOverrideSerialized = runtimeOverrides
    ? Object.entries(runtimeOverrides)
        .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('\x01')
    : '';
  return `${configId}\x00${cliType}\x00${agentType}\x00${envSerialized}\x00${customSerialized}\x00${runtimeOverrideSerialized}`;
};
