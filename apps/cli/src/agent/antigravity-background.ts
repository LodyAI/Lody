import type * as acp from '@agentclientprotocol/sdk';
import type { AgentConfigCliType } from '@lody/shared';

export const ANTIGRAVITY_ACP_SERVER_NAME = 'Antigravity ACP Server';

export interface AntigravityServerIdentityInput {
  agentConfig?: {
    cliType: AgentConfigCliType;
    agentType?: string;
  } | null;
  agentInfo?: {
    name?: string | null;
  } | null;
}

/**
 * Identify builtin or custom Antigravity ACP v1 servers while excluding legacy `antigravity-acp`.
 */
export function isAntigravityServer({
  agentConfig,
  agentInfo,
}: AntigravityServerIdentityInput): boolean {
  if (agentConfig?.cliType === 'builtin' && agentConfig.agentType === 'antigravity') {
    return true;
  }
  return agentInfo?.name === ANTIGRAVITY_ACP_SERVER_NAME;
}

export const ORPHANED_POST_TURN_PERMISSION_MESSAGE =
  'Antigravity ACP Server did not forward a permission request after end_turn; tool call was cancelled so the session does not hang.';

export interface AntigravityPollTimings {
  listPollIntervalMs: number;
  loadFallbackPollIntervalMs: number;
  sameSecondLoadCheckMs: number;
  settleQuietMs: number;
  failedWakeupToolGraceMs: number;
  orphanedPendingToolGraceMs: number;
  wakeupPlannerGraceMs: number;
  promptHoldMaxMs: number;
  detachedMaxDurationMs: number;
  rpcTimeoutMs: number;
  maxConsecutiveFailures: number;
}

export const DEFAULT_ANTIGRAVITY_POLL_TIMINGS: AntigravityPollTimings = {
  listPollIntervalMs: 2_000,
  loadFallbackPollIntervalMs: 10_000,
  sameSecondLoadCheckMs: 6_000,
  settleQuietMs: 25_000,
  failedWakeupToolGraceMs: 25_000,
  orphanedPendingToolGraceMs: 4_000,
  wakeupPlannerGraceMs: 90_000,
  promptHoldMaxMs: 30 * 60_000,
  detachedMaxDurationMs: 24 * 60 * 60_000,
  rpcTimeoutMs: 15_000,
  maxConsecutiveFailures: 5,
};

export type AntigravityTurnEndClassification =
  | { mode: 'none'; backgroundTaskCount: 0 }
  | { mode: 'hold'; backgroundTaskCount: number }
  | { mode: 'background'; backgroundTaskCount: number };

export type AntigravityHoldEvaluation = 'waiting' | 'settled' | 'handoff_to_background';

export interface AntigravityBackgroundEvaluation {
  settled: boolean;
  state: 'idle' | 'running';
  backgroundTaskCount: number;
}

export type PostTurnSchedule =
  | { kind: 'timer'; expectedFireAtMs: number }
  | { kind: 'cron'; remainingRuns: number | null }
  | { kind: 'swarm' };

interface KnownToolCallEntry {
  status: string;
  hasOutput: boolean;
  hasBgPlaceholder: boolean;
  name?: string;
  isDaemon: boolean;
}

const IGNORED_REPLAY_UPDATES = new Set([
  'user_message_chunk',
  'available_commands_update',
  'config_option_update',
  'session_info_update',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRawUpdate(update: acp.SessionUpdate): Record<string, unknown> {
  return update as unknown as Record<string, unknown>;
}

function isToolUpdateKind(kind: unknown): kind is 'tool_call' | 'tool_call_update' {
  return kind === 'tool_call' || kind === 'tool_call_update';
}

function extractToolName(update: Record<string, unknown>): string | undefined {
  const meta = update._meta;
  if (isRecord(meta) && isRecord(meta.lody) && typeof meta.lody.toolName === 'string') {
    const lodyName = meta.lody.toolName.trim();
    if (lodyName.length > 0) return lodyName;
  }
  if (typeof update.name === 'string') {
    const rawName = update.name.trim();
    if (rawName.length > 0) return rawName;
  }
  return undefined;
}

function extractToolArgs(update: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(update.rawInput)) return update.rawInput;
  if (isRecord(update.args)) return update.args;
  return undefined;
}

function hasNonEmptyRawOutput(rawOutput: unknown): boolean {
  if (typeof rawOutput === 'string') return rawOutput.length > 0;
  if (Array.isArray(rawOutput)) return rawOutput.length > 0;
  if (isRecord(rawOutput)) return Object.keys(rawOutput).length > 0;
  return rawOutput !== undefined && rawOutput !== null;
}

function extractToolHasOutput(update: Record<string, unknown>): boolean {
  if (hasNonEmptyRawOutput(update.rawOutput)) return true;
  return Array.isArray(update.content) && update.content.length > 0;
}

const BG_TASK_PLACEHOLDER_PATTERN = /Tool is running as a background task with task id:\s*\S+/i;

function hasBackgroundTaskPlaceholderOutput(raw: Record<string, unknown>): boolean {
  const rawOutput = raw.rawOutput;
  if (typeof rawOutput === 'string' && BG_TASK_PLACEHOLDER_PATTERN.test(rawOutput)) {
    return true;
  }
  if (
    isRecord(rawOutput) &&
    typeof rawOutput.output === 'string' &&
    BG_TASK_PLACEHOLDER_PATTERN.test(rawOutput.output)
  ) {
    return true;
  }
  if (Array.isArray(raw.content)) {
    for (const item of raw.content) {
      if (!isRecord(item)) continue;
      if (typeof item.text === 'string' && BG_TASK_PLACEHOLDER_PATTERN.test(item.text)) {
        return true;
      }
      if (
        isRecord(item.content) &&
        typeof item.content.text === 'string' &&
        BG_TASK_PLACEHOLDER_PATTERN.test(item.content.text)
      ) {
        return true;
      }
    }
  }
  return false;
}

function isActiveToolStatus(status: string): boolean {
  return status === 'pending' || status === 'in_progress';
}

function isTier2DetachedToolName(name: string | undefined): boolean {
  return name === 'schedule' || name === 'swarm';
}

function isToolRunningOrBackgrounded(entry: KnownToolCallEntry): boolean {
  if (entry.isDaemon || entry.status === 'failed' || isTier2DetachedToolName(entry.name)) {
    return false;
  }
  if (isActiveToolStatus(entry.status)) return true;
  return entry.hasBgPlaceholder && (entry.name === 'run_command' || entry.name === 'run_workflow');
}

function extractUsageKey(update: Record<string, unknown>): string | null {
  if (update.sessionUpdate !== 'usage_update') return null;
  const used = update.used;
  const size = update.size;
  if (typeof used !== 'number' || typeof size !== 'number') return null;
  if (!Number.isFinite(used) || !Number.isFinite(size)) return null;
  return `${used}:${size}`;
}

function cloneTextChunkWithPrefix(
  params: acp.SessionNotification,
  text: string
): acp.SessionNotification {
  if (
    params.update.sessionUpdate !== 'agent_message_chunk' &&
    params.update.sessionUpdate !== 'agent_thought_chunk'
  ) {
    return params;
  }
  const update = params.update;
  if (update.content.type !== 'text') {
    return params;
  }
  return {
    ...params,
    update: {
      ...update,
      content: {
        ...update.content,
        text,
      },
    },
  };
}

function cloneToolNotification(
  params: acp.SessionNotification,
  sessionUpdate: 'tool_call' | 'tool_call_update'
): acp.SessionNotification {
  return {
    ...params,
    update: {
      ...params.update,
      sessionUpdate,
    } as acp.SessionUpdate,
  };
}

function findLastUserChunkIndex(notifications: readonly acp.SessionNotification[]): number {
  for (let i = notifications.length - 1; i >= 0; i -= 1) {
    if (notifications[i]?.update.sessionUpdate === 'user_message_chunk') {
      return i;
    }
  }
  return -1;
}

function extractTextContent(update: acp.SessionUpdate): string | null {
  if (
    update.sessionUpdate !== 'agent_message_chunk' &&
    update.sessionUpdate !== 'agent_thought_chunk'
  ) {
    return null;
  }
  const content = (update as { content?: unknown }).content;
  if (!isRecord(content) || content.type !== 'text' || typeof content.text !== 'string') {
    return null;
  }
  return content.text;
}

export function isMethodNotFoundError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.code === -32601) return true;
  if (typeof error.message === 'string' && /method not found|-32601/i.test(error.message)) {
    return true;
  }
  return false;
}

/**
 * Tracks Antigravity ACP v1 session tool calls, streamed character offsets, and wakeup schedules
 * so post-`end_turn` `session/load` snapshots emit strictly deduplicated deltas.
 */
export class AntigravitySessionTracker {
  private readonly timings: AntigravityPollTimings;
  private readonly knownToolCalls = new Map<string, KnownToolCallEntry>();

  private activeTurnToolIds = new Set<string>();
  private inProgressHoldToolIds = new Set<string>();
  private preTurnEndPendingToolIds = new Set<string>();
  private livePermissionToolIds = new Set<string>();
  private postTurnPendingSinceMs = new Map<string, number>();
  private orphanedPendingToolIds = new Set<string>();
  private lastToolNotificationById = new Map<string, acp.SessionNotification>();
  private registeredSubagentToolIds = new Set<string>();
  private registeredSendMessageToolIds = new Set<string>();
  private registeredSubagentCancelToolIds = new Set<string>();
  private registeredWorkflowToolIds = new Set<string>();
  private registeredScheduleToolIds = new Set<string>();
  private registeredManageTaskToolIds = new Set<string>();

  private emittedAssistantChars = 0;
  private emittedThoughtChars = 0;
  private lastEmittedContentKind: 'text' | 'tool' | 'other' = 'other';
  private lastEmittedTextEndsWithNewline = true;
  private needsBreakBeforeNextWakeupText = false;

  private pendingSubagents = 0;
  private pendingAsyncWorkflows = 0;
  private postTurnSchedules: PostTurnSchedule[] = [];

  private endedPromptAtMs: number | null = null;
  private holdStartedAtMs: number | null = null;
  private allHoldToolsTerminalAtMs: number | null = null;
  private sawWakeupPlannerActivity = false;
  private sawWakeupFailedTool = false;
  private wakeupStepAccountedSinceIdle = false;
  private abortedOrphanedPendingWakeup = false;
  private lastWakeupChangeAtMs: number | null = null;
  private backgroundMonitorStartedAtMs: number | null = null;
  private lastBackgroundDeltaAtMs: number | null = null;
  private wakeupToolsDuringBackground = new Set<string>();
  private lastUsageKey: string | null = null;

  constructor(timings?: Partial<AntigravityPollTimings>) {
    this.timings = { ...DEFAULT_ANTIGRAVITY_POLL_TIMINGS, ...timings };
  }

  getTimings(): AntigravityPollTimings {
    return this.timings;
  }

  /**
   * Seed session-lifetime known tool calls from `session/load` replay during initial resume so
   * historical turns never emit duplicate updates or trigger holds on later polls.
   */
  seedBaseline(notifications: readonly acp.SessionNotification[]): void {
    for (const notification of notifications) {
      const raw = asRawUpdate(notification.update);
      if (isToolUpdateKind(raw.sessionUpdate) && typeof raw.toolCallId === 'string') {
        const prev = this.knownToolCalls.get(raw.toolCallId);
        const name = extractToolName(raw) ?? prev?.name;
        const args = extractToolArgs(raw);
        const isDaemon = prev ? prev.isDaemon || args?.IsDaemon === true : args?.IsDaemon === true;
        const status = typeof raw.status === 'string' ? raw.status : (prev?.status ?? '');
        const hasOutputInUpdate = extractToolHasOutput(raw);
        const hasOutput = Boolean(prev?.hasOutput || hasOutputInUpdate);
        const hasBgPlaceholder = hasOutputInUpdate
          ? hasBackgroundTaskPlaceholderOutput(raw)
          : Boolean(prev?.hasBgPlaceholder);
        this.knownToolCalls.set(raw.toolCallId, {
          status,
          hasOutput,
          hasBgPlaceholder,
          name,
          isDaemon,
        });
        continue;
      }
      const usageKey = extractUsageKey(raw);
      if (usageKey) {
        this.lastUsageKey = usageKey;
      }
    }
  }

  /** Reset per-turn tracking right before dispatching `connection.prompt`. */
  beginTurn(): void {
    this.activeTurnToolIds = new Set();
    this.inProgressHoldToolIds = new Set();
    this.preTurnEndPendingToolIds = new Set();
    this.livePermissionToolIds = new Set();
    this.postTurnPendingSinceMs = new Map();
    this.orphanedPendingToolIds = new Set();
    this.lastToolNotificationById = new Map();
    this.registeredSubagentToolIds = new Set();
    this.registeredSendMessageToolIds = new Set();
    this.registeredSubagentCancelToolIds = new Set();
    this.registeredWorkflowToolIds = new Set();
    this.registeredScheduleToolIds = new Set();
    this.registeredManageTaskToolIds = new Set();

    this.emittedAssistantChars = 0;
    this.emittedThoughtChars = 0;
    this.lastEmittedContentKind = 'other';
    this.lastEmittedTextEndsWithNewline = true;
    this.needsBreakBeforeNextWakeupText = false;

    this.pendingSubagents = 0;
    this.pendingAsyncWorkflows = 0;
    this.postTurnSchedules = [];

    this.endedPromptAtMs = null;
    this.holdStartedAtMs = null;
    this.allHoldToolsTerminalAtMs = null;
    this.sawWakeupPlannerActivity = false;
    this.sawWakeupFailedTool = false;
    this.wakeupStepAccountedSinceIdle = false;
    this.abortedOrphanedPendingWakeup = false;
    this.lastWakeupChangeAtMs = null;
    this.backgroundMonitorStartedAtMs = null;
    this.lastBackgroundDeltaAtMs = null;
    this.wakeupToolsDuringBackground = new Set();
  }

  /** Record that the agent delivered a live permission request for `toolCallId`. */
  notifyLivePermissionRequest(toolCallId: string): void {
    this.livePermissionToolIds.add(toolCallId);
    this.postTurnPendingSinceMs.delete(toolCallId);
  }

  /** Record a live `session/update` notification streamed by ACP stdout. */
  observeLiveNotification(params: acp.SessionNotification, nowMs: number): void {
    const update = params.update;
    const raw = asRawUpdate(update);
    const isAfterPromptEnd = this.endedPromptAtMs !== null;

    if (isToolUpdateKind(raw.sessionUpdate) && typeof raw.toolCallId === 'string') {
      this.lastToolNotificationById.set(raw.toolCallId, params);
      const entry = this.recordToolObservation(raw, nowMs);
      this.lastEmittedContentKind = 'tool';
      this.needsBreakBeforeNextWakeupText = false;
      if (isAfterPromptEnd) {
        this.sawWakeupPlannerActivity = true;
        this.lastWakeupChangeAtMs = nowMs;
        if (entry.status === 'failed') {
          this.sawWakeupFailedTool = true;
        }
        if (this.backgroundMonitorStartedAtMs !== null) {
          this.lastBackgroundDeltaAtMs = nowMs;
        }
      }
      return;
    }

    if (update.sessionUpdate === 'agent_thought_chunk') {
      const text = extractTextContent(update);
      if (text !== null) {
        this.emittedThoughtChars += text.length;
        if (isAfterPromptEnd && text.length > 0) {
          this.markWakeupTextObserved(nowMs, false);
        }
      }
      return;
    }

    if (update.sessionUpdate === 'agent_message_chunk') {
      const text = extractTextContent(update);
      if (text !== null) {
        this.emittedAssistantChars += text.length;
        this.lastEmittedContentKind = 'text';
        if (text.length > 0) {
          this.lastEmittedTextEndsWithNewline = text.endsWith('\n');
        }
        if (isAfterPromptEnd && text.length > 0) {
          this.markWakeupTextObserved(nowMs, true);
        }
      }
      return;
    }

    const usageKey = extractUsageKey(raw);
    if (usageKey) {
      this.lastUsageKey = usageKey;
    }
  }

  classifyTurnEnd(stopReason: string | undefined, nowMs: number): AntigravityTurnEndClassification {
    if (stopReason !== 'end_turn') {
      return { mode: 'none', backgroundTaskCount: 0 };
    }

    this.endedPromptAtMs = nowMs;
    this.wakeupStepAccountedSinceIdle = false;
    this.abortedOrphanedPendingWakeup = false;
    this.preTurnEndPendingToolIds = new Set();
    for (const toolCallId of this.activeTurnToolIds) {
      if (this.knownToolCalls.get(toolCallId)?.status === 'pending') {
        this.preTurnEndPendingToolIds.add(toolCallId);
      }
    }
    if (this.inProgressHoldToolIds.size === 0) {
      this.allHoldToolsTerminalAtMs = nowMs;
    }

    const holdableCount =
      this.inProgressHoldToolIds.size + this.pendingSubagents + this.pendingAsyncWorkflows;
    if (holdableCount > 0) {
      this.holdStartedAtMs = nowMs;
      this.needsBreakBeforeNextWakeupText =
        this.lastEmittedContentKind === 'text' && !this.lastEmittedTextEndsWithNewline;
      return {
        mode: 'hold',
        backgroundTaskCount: holdableCount + this.postTurnSchedules.length,
      };
    }

    if (this.postTurnSchedules.length > 0) {
      this.backgroundMonitorStartedAtMs = nowMs;
      this.needsBreakBeforeNextWakeupText =
        this.lastEmittedContentKind === 'text' && !this.lastEmittedTextEndsWithNewline;
      return {
        mode: 'background',
        backgroundTaskCount: this.postTurnSchedules.length,
      };
    }

    return { mode: 'none', backgroundTaskCount: 0 };
  }

  /** Switch a long-running hold into non-blocking Tier 2 background monitoring. */
  promoteHoldToBackground(nowMs: number): number {
    if (this.backgroundMonitorStartedAtMs === null) {
      this.backgroundMonitorStartedAtMs = nowMs;
    }
    this.lastBackgroundDeltaAtMs = null;
    this.wakeupStepAccountedSinceIdle = false;
    this.abortedOrphanedPendingWakeup = false;
    this.needsBreakBeforeNextWakeupText =
      this.lastEmittedContentKind === 'text' && !this.lastEmittedTextEndsWithNewline;
    this.wakeupToolsDuringBackground.clear();
    return this.getActiveBackgroundCount();
  }

  getActiveBackgroundCount(): number {
    return (
      this.inProgressHoldToolIds.size +
      this.pendingSubagents +
      this.pendingAsyncWorkflows +
      this.postTurnSchedules.length
    );
  }

  /** Extract strictly unseen delta notifications from a `session/load` snapshot replay. */
  consumeSnapshot(
    notifications: readonly acp.SessionNotification[],
    nowMs: number
  ): { deltas: acp.SessionNotification[]; hasChanges: boolean } {
    const lastUserChunkIndex = findLastUserChunkIndex(notifications);
    const deltas: acp.SessionNotification[] = [];
    let seenAssistantChars = 0;
    let seenThoughtChars = 0;
    let latestUsage: { key: string; notification: acp.SessionNotification } | null = null;
    let accountedWakeupStepInSnapshot = false;
    let hasContentChanges = false;

    for (let i = 0; i < notifications.length; i += 1) {
      const notification = notifications[i];
      if (!notification) continue;
      const update = notification.update;
      const raw = asRawUpdate(update);
      const isAfterLastUser = lastUserChunkIndex === -1 || i > lastUserChunkIndex;

      if (IGNORED_REPLAY_UPDATES.has(update.sessionUpdate)) {
        continue;
      }

      if (update.sessionUpdate === 'usage_update') {
        const key = extractUsageKey(raw);
        if (key) {
          latestUsage = { key, notification };
        }
        continue;
      }

      if (isToolUpdateKind(raw.sessionUpdate) && typeof raw.toolCallId === 'string') {
        const toolDelta = this.reconcileSnapshotTool(notification, raw, isAfterLastUser, nowMs);
        if (toolDelta) {
          deltas.push(toolDelta);
          hasContentChanges = true;
        }
        continue;
      }

      if (!isAfterLastUser) {
        continue;
      }

      if (update.sessionUpdate === 'agent_thought_chunk') {
        const text = extractTextContent(update);
        if (text === null) continue;
        const chunkStart = seenThoughtChars;
        const chunkEnd = chunkStart + text.length;
        seenThoughtChars = chunkEnd;
        if (chunkEnd <= this.emittedThoughtChars) continue;

        const slice = text.slice(Math.max(0, this.emittedThoughtChars - chunkStart));
        this.emittedThoughtChars = chunkEnd;
        if (slice.length > 0) {
          this.markWakeupTextObserved(nowMs, false);
          hasContentChanges = true;
          deltas.push(
            slice.length === text.length
              ? notification
              : cloneTextChunkWithPrefix(notification, slice)
          );
        }
        continue;
      }

      if (update.sessionUpdate === 'agent_message_chunk') {
        const text = extractTextContent(update);
        if (text === null) continue;
        const chunkStart = seenAssistantChars;
        const chunkEnd = chunkStart + text.length;
        seenAssistantChars = chunkEnd;
        if (chunkEnd <= this.emittedAssistantChars) continue;

        const rawSlice = text.slice(Math.max(0, this.emittedAssistantChars - chunkStart));
        this.emittedAssistantChars = chunkEnd;

        if (rawSlice.length > 0) {
          const needsParagraphBreak =
            this.needsBreakBeforeNextWakeupText &&
            this.lastEmittedContentKind === 'text' &&
            !this.lastEmittedTextEndsWithNewline &&
            !rawSlice.startsWith('\n');
          this.needsBreakBeforeNextWakeupText = false;
          const emittedText = needsParagraphBreak ? `\n\n${rawSlice}` : rawSlice;

          this.lastEmittedContentKind = 'text';
          this.lastEmittedTextEndsWithNewline = rawSlice.endsWith('\n');
          this.markWakeupTextObserved(nowMs, !accountedWakeupStepInSnapshot);
          accountedWakeupStepInSnapshot = true;
          hasContentChanges = true;
          deltas.push(
            emittedText === text
              ? notification
              : cloneTextChunkWithPrefix(notification, emittedText)
          );
        }
      }
    }

    if (latestUsage && latestUsage.key !== this.lastUsageKey) {
      this.lastUsageKey = latestUsage.key;
      deltas.push(latestUsage.notification);
    }

    return { deltas, hasChanges: hasContentChanges || deltas.length > 0 };
  }

  evaluateHoldState(nowMs: number): AntigravityHoldEvaluation {
    if (this.endedPromptAtMs === null) {
      return 'settled';
    }

    if (this.abortedOrphanedPendingWakeup) {
      return this.postTurnSchedules.length > 0 ? 'handoff_to_background' : 'settled';
    }

    const holdStartedAtMs = this.holdStartedAtMs ?? this.endedPromptAtMs;
    if (nowMs - holdStartedAtMs >= this.timings.promptHoldMaxMs) {
      return 'handoff_to_background';
    }

    if (this.inProgressHoldToolIds.size > 0 || this.pendingAsyncWorkflows > 0) {
      return 'waiting';
    }

    if (this.pendingSubagents > 0 && !this.sawWakeupPlannerActivity) {
      return 'waiting';
    }

    if (this.sawWakeupPlannerActivity) {
      const graceMs = this.sawWakeupFailedTool
        ? this.timings.failedWakeupToolGraceMs
        : this.timings.settleQuietMs;
      const lastChangeMs = this.lastWakeupChangeAtMs ?? holdStartedAtMs;
      if (nowMs - lastChangeMs < graceMs) {
        return 'waiting';
      }
      return this.pendingSubagents > 0 || this.postTurnSchedules.length > 0
        ? 'handoff_to_background'
        : 'settled';
    }

    const baselineMs = this.allHoldToolsTerminalAtMs ?? holdStartedAtMs;
    if (nowMs - baselineMs < this.timings.wakeupPlannerGraceMs) {
      return 'waiting';
    }
    return this.pendingSubagents > 0 || this.postTurnSchedules.length > 0
      ? 'handoff_to_background'
      : 'settled';
  }

  evaluateBackgroundState(nowMs: number): AntigravityBackgroundEvaluation {
    const startedAtMs = this.backgroundMonitorStartedAtMs ?? this.endedPromptAtMs ?? nowMs;
    const remainingCount = this.getActiveBackgroundCount();

    if (nowMs - startedAtMs >= this.timings.detachedMaxDurationMs) {
      return { settled: true, state: 'idle', backgroundTaskCount: 0 };
    }

    const hasActiveWakeupTool = this.wakeupToolsDuringBackground.size > 0;
    const isDrainingWakeup =
      this.lastBackgroundDeltaAtMs !== null &&
      nowMs - this.lastBackgroundDeltaAtMs < this.timings.settleQuietMs;

    if (hasActiveWakeupTool || isDrainingWakeup) {
      return {
        settled: false,
        state: 'running',
        backgroundTaskCount: Math.max(1, remainingCount),
      };
    }

    if (this.lastBackgroundDeltaAtMs !== null) {
      this.lastBackgroundDeltaAtMs = null;
      this.wakeupStepAccountedSinceIdle = false;
      this.needsBreakBeforeNextWakeupText =
        this.lastEmittedContentKind === 'text' && !this.lastEmittedTextEndsWithNewline;
    }

    if (remainingCount > 0) {
      return {
        settled: false,
        state: 'idle',
        backgroundTaskCount: remainingCount,
      };
    }

    const waitingForWakeupAfterHoldTool =
      !this.abortedOrphanedPendingWakeup &&
      !this.sawWakeupPlannerActivity &&
      this.allHoldToolsTerminalAtMs !== null &&
      nowMs - this.allHoldToolsTerminalAtMs < this.timings.wakeupPlannerGraceMs;
    if (waitingForWakeupAfterHoldTool) {
      return {
        settled: false,
        state: 'idle',
        backgroundTaskCount: 1,
      };
    }

    return {
      settled: true,
      state: 'idle',
      backgroundTaskCount: 0,
    };
  }

  /**
   * Fail and request cancellation for post-`end_turn` tool calls stuck in `pending` without
   * a forwarded `session/request_permission` request so Tier 1/Tier 2 monitoring cannot wedge.
   */
  expireOrphanedPendingTools(nowMs: number): {
    deltas: acp.SessionNotification[];
    shouldCancelSession: boolean;
  } {
    const deltas: acp.SessionNotification[] = [];

    for (const [toolCallId, sinceMs] of [...this.postTurnPendingSinceMs.entries()]) {
      if (this.livePermissionToolIds.has(toolCallId)) {
        this.postTurnPendingSinceMs.delete(toolCallId);
        continue;
      }
      if (nowMs - sinceMs < this.timings.orphanedPendingToolGraceMs) {
        continue;
      }

      this.postTurnPendingSinceMs.delete(toolCallId);
      this.orphanedPendingToolIds.add(toolCallId);
      this.inProgressHoldToolIds.delete(toolCallId);
      this.wakeupToolsDuringBackground.delete(toolCallId);

      const prev = this.knownToolCalls.get(toolCallId);
      if (prev) {
        this.knownToolCalls.set(toolCallId, {
          ...prev,
          status: 'failed',
          hasOutput: true,
          hasBgPlaceholder: false,
        });
      }

      const baseNotification = this.lastToolNotificationById.get(toolCallId);
      const baseUpdate = baseNotification ? asRawUpdate(baseNotification.update) : undefined;
      const synthesized: acp.SessionNotification = {
        sessionId: baseNotification?.sessionId ?? ('' as acp.SessionId),
        update: {
          ...(baseUpdate ?? {}),
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'failed',
          rawOutput: { error: ORPHANED_POST_TURN_PERMISSION_MESSAGE },
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: ORPHANED_POST_TURN_PERMISSION_MESSAGE,
              },
            },
          ],
        } as unknown as acp.SessionUpdate,
      };
      this.lastToolNotificationById.set(toolCallId, synthesized);
      this.lastEmittedContentKind = 'tool';
      this.needsBreakBeforeNextWakeupText = false;
      deltas.push(synthesized);
    }

    if (deltas.length === 0) {
      return { deltas: [], shouldCancelSession: false };
    }

    this.inProgressHoldToolIds.clear();
    this.wakeupToolsDuringBackground.clear();
    this.pendingSubagents = 0;
    this.pendingAsyncWorkflows = 0;
    if (!this.wakeupStepAccountedSinceIdle) {
      this.accountWakeupStep(nowMs);
      this.wakeupStepAccountedSinceIdle = true;
    }
    this.abortedOrphanedPendingWakeup = true;
    this.lastBackgroundDeltaAtMs = null;
    if (this.allHoldToolsTerminalAtMs === null) {
      this.allHoldToolsTerminalAtMs = nowMs;
    }

    return { deltas, shouldCancelSession: true };
  }

  hasAbortedOrphanedPendingWakeup(): boolean {
    return this.abortedOrphanedPendingWakeup;
  }

  private markWakeupTextObserved(nowMs: number, consumePendingWakeup: boolean): void {
    this.sawWakeupPlannerActivity = true;
    this.lastWakeupChangeAtMs = nowMs;
    if (this.backgroundMonitorStartedAtMs !== null) {
      this.lastBackgroundDeltaAtMs = nowMs;
    }
    if (consumePendingWakeup) {
      this.clearCompletedPlaceholderHoldTools(nowMs);
      this.accountWakeupStep(nowMs);
      this.wakeupStepAccountedSinceIdle = true;
    }
  }

  private clearCompletedPlaceholderHoldTools(nowMs: number): void {
    for (const id of [...this.inProgressHoldToolIds]) {
      const entry = this.knownToolCalls.get(id);
      if (entry && !isActiveToolStatus(entry.status) && entry.hasBgPlaceholder) {
        this.inProgressHoldToolIds.delete(id);
        this.wakeupToolsDuringBackground.delete(id);
      }
    }
    if (this.inProgressHoldToolIds.size === 0 && this.allHoldToolsTerminalAtMs === null) {
      this.allHoldToolsTerminalAtMs = nowMs;
    }
  }

  private accountWakeupStep(nowMs: number): void {
    if (this.pendingSubagents > 0) {
      this.pendingSubagents -= 1;
      return;
    }
    if (this.pendingAsyncWorkflows > 0) {
      this.pendingAsyncWorkflows -= 1;
      return;
    }
    if (this.postTurnSchedules.length === 0) return;

    const dueTimerIdx = this.postTurnSchedules.findIndex(
      (schedule) => schedule.kind === 'timer' && nowMs + 2_000 >= schedule.expectedFireAtMs
    );
    if (dueTimerIdx !== -1) {
      this.postTurnSchedules.splice(dueTimerIdx, 1);
      return;
    }

    const recurringOrSwarmIdx = this.postTurnSchedules.findIndex(
      (schedule) => schedule.kind === 'cron' || schedule.kind === 'swarm'
    );
    if (recurringOrSwarmIdx !== -1) {
      const target = this.postTurnSchedules[recurringOrSwarmIdx];
      if (target?.kind === 'cron') {
        if (target.remainingRuns === null) {
          return;
        }
        if (target.remainingRuns > 1) {
          this.postTurnSchedules[recurringOrSwarmIdx] = {
            kind: 'cron',
            remainingRuns: target.remainingRuns - 1,
          };
          return;
        }
      }
      this.postTurnSchedules.splice(recurringOrSwarmIdx, 1);
      return;
    }

    let earliestTimerIdx = -1;
    let earliestFireAtMs = Infinity;
    for (let i = 0; i < this.postTurnSchedules.length; i += 1) {
      const schedule = this.postTurnSchedules[i];
      if (schedule?.kind === 'timer' && schedule.expectedFireAtMs < earliestFireAtMs) {
        earliestFireAtMs = schedule.expectedFireAtMs;
        earliestTimerIdx = i;
      }
    }
    if (earliestTimerIdx !== -1) {
      this.postTurnSchedules.splice(earliestTimerIdx, 1);
    }
  }

  private reconcileSnapshotTool(
    notification: acp.SessionNotification,
    raw: Record<string, unknown>,
    isAfterLastUser: boolean,
    nowMs: number
  ): acp.SessionNotification | null {
    const toolCallId = raw.toolCallId as string;
    const prev = this.knownToolCalls.get(toolCallId);

    if (prev) {
      if (!this.activeTurnToolIds.has(toolCallId)) {
        return null;
      }
      if (this.orphanedPendingToolIds.has(toolCallId) && raw.status === 'pending') {
        return null;
      }
      const nextStatus = typeof raw.status === 'string' ? raw.status : prev.status;
      const nextHasOutput = extractToolHasOutput(raw);
      const nextHasBgPlaceholder = nextHasOutput
        ? hasBackgroundTaskPlaceholderOutput(raw)
        : prev.hasBgPlaceholder;
      const placeholderCleared = prev.hasBgPlaceholder && !nextHasBgPlaceholder;
      if (
        nextStatus === prev.status &&
        !(!prev.hasOutput && nextHasOutput) &&
        !placeholderCleared
      ) {
        return null;
      }

      this.lastToolNotificationById.set(toolCallId, notification);
      const entry = this.recordToolObservation(raw, nowMs);
      this.lastEmittedContentKind = 'tool';
      this.needsBreakBeforeNextWakeupText = false;
      this.lastWakeupChangeAtMs = nowMs;
      if (entry.status === 'failed') {
        this.sawWakeupFailedTool = true;
      }
      if (this.backgroundMonitorStartedAtMs !== null) {
        this.lastBackgroundDeltaAtMs = nowMs;
      }
      return cloneToolNotification(notification, 'tool_call_update');
    }

    const status = typeof raw.status === 'string' ? raw.status : '';
    if (!isAfterLastUser && !isActiveToolStatus(status)) {
      const name = extractToolName(raw);
      const args = extractToolArgs(raw);
      const hasOutput = extractToolHasOutput(raw);
      this.knownToolCalls.set(toolCallId, {
        status,
        hasOutput,
        hasBgPlaceholder: hasOutput ? hasBackgroundTaskPlaceholderOutput(raw) : false,
        name,
        isDaemon: args?.IsDaemon === true,
      });
      return null;
    }

    this.lastToolNotificationById.set(toolCallId, notification);
    const entry = this.recordToolObservation(raw, nowMs);
    this.lastEmittedContentKind = 'tool';
    this.needsBreakBeforeNextWakeupText = false;
    this.sawWakeupPlannerActivity = true;
    this.lastWakeupChangeAtMs = nowMs;
    if (entry.status === 'failed') {
      this.sawWakeupFailedTool = true;
    }
    if (this.backgroundMonitorStartedAtMs !== null) {
      this.lastBackgroundDeltaAtMs = nowMs;
      if (isToolRunningOrBackgrounded(entry)) {
        this.wakeupToolsDuringBackground.add(toolCallId);
      }
    }
    return cloneToolNotification(notification, 'tool_call');
  }

  private recordToolObservation(raw: Record<string, unknown>, nowMs: number): KnownToolCallEntry {
    const toolCallId = raw.toolCallId as string;
    const prev = this.knownToolCalls.get(toolCallId);
    const name = extractToolName(raw) ?? prev?.name;
    const args = extractToolArgs(raw);
    const isDaemon = prev ? prev.isDaemon || args?.IsDaemon === true : args?.IsDaemon === true;
    const status = typeof raw.status === 'string' ? raw.status : (prev?.status ?? '');
    const hasOutputInUpdate = extractToolHasOutput(raw);
    const hasOutput = Boolean(prev?.hasOutput || hasOutputInUpdate);
    const hasBgPlaceholder = hasOutputInUpdate
      ? hasBackgroundTaskPlaceholderOutput(raw)
      : Boolean(prev?.hasBgPlaceholder);
    const entry: KnownToolCallEntry = { status, hasOutput, hasBgPlaceholder, name, isDaemon };

    this.knownToolCalls.set(toolCallId, entry);
    this.activeTurnToolIds.add(toolCallId);

    if (this.endedPromptAtMs !== null) {
      if (
        entry.status === 'pending' &&
        !this.preTurnEndPendingToolIds.has(toolCallId) &&
        !this.livePermissionToolIds.has(toolCallId) &&
        !this.orphanedPendingToolIds.has(toolCallId)
      ) {
        if (!this.postTurnPendingSinceMs.has(toolCallId)) {
          this.postTurnPendingSinceMs.set(toolCallId, nowMs);
        }
      } else if (entry.status !== 'pending') {
        this.postTurnPendingSinceMs.delete(toolCallId);
      }
    }

    this.updateHoldToolSet(toolCallId, entry, nowMs);
    this.updateSideEffectTrackers(toolCallId, entry, args, nowMs);

    return entry;
  }

  private updateHoldToolSet(toolCallId: string, entry: KnownToolCallEntry, nowMs: number): void {
    if (isToolRunningOrBackgrounded(entry)) {
      this.inProgressHoldToolIds.add(toolCallId);
      this.allHoldToolsTerminalAtMs = null;
      return;
    }

    if (this.inProgressHoldToolIds.delete(toolCallId) && this.inProgressHoldToolIds.size === 0) {
      this.allHoldToolsTerminalAtMs = nowMs;
    }
    this.wakeupToolsDuringBackground.delete(toolCallId);
  }

  private updateSideEffectTrackers(
    toolCallId: string,
    entry: KnownToolCallEntry,
    args: Record<string, unknown> | undefined,
    nowMs: number
  ): void {
    const failed = entry.status === 'failed';

    if (entry.name === 'invoke_subagent') {
      if (failed) {
        if (this.registeredSubagentToolIds.delete(toolCallId)) {
          this.pendingSubagents = Math.max(0, this.pendingSubagents - 1);
        }
      } else if (!this.registeredSubagentToolIds.has(toolCallId)) {
        this.registeredSubagentToolIds.add(toolCallId);
        this.pendingSubagents += 1;
      }
      return;
    }

    if (entry.name === 'send_message' && !failed) {
      if (!this.registeredSendMessageToolIds.has(toolCallId)) {
        this.registeredSendMessageToolIds.add(toolCallId);
        this.pendingSubagents = Math.max(1, this.pendingSubagents);
      }
      return;
    }

    if (entry.name === 'manage_subagents' && !failed && args) {
      if (this.registeredSubagentCancelToolIds.has(toolCallId)) return;
      if (args.Action === 'kill_all') {
        this.registeredSubagentCancelToolIds.add(toolCallId);
        this.pendingSubagents = 0;
      } else if (args.Action === 'kill') {
        this.registeredSubagentCancelToolIds.add(toolCallId);
        const count = Array.isArray(args.ConversationIds) ? args.ConversationIds.length : 1;
        this.pendingSubagents = Math.max(0, this.pendingSubagents - count);
      }
      return;
    }

    if (entry.name === 'run_workflow') {
      if (!failed && entry.status === 'completed') {
        if (entry.hasOutput && !entry.hasBgPlaceholder) {
          if (this.registeredWorkflowToolIds.delete(toolCallId)) {
            this.pendingAsyncWorkflows = Math.max(0, this.pendingAsyncWorkflows - 1);
          }
        } else if (
          !entry.hasOutput &&
          !entry.hasBgPlaceholder &&
          (args?.WaitMsBeforeAsync === undefined || args?.WaitMsBeforeAsync === 0) &&
          !this.registeredWorkflowToolIds.has(toolCallId)
        ) {
          this.registeredWorkflowToolIds.add(toolCallId);
          this.pendingAsyncWorkflows += 1;
        }
      }
      return;
    }

    if (entry.name === 'schedule' && !failed && !entry.isDaemon && args) {
      if (this.registeredScheduleToolIds.has(toolCallId)) return;
      if (typeof args.DurationSeconds === 'number' && args.DurationSeconds > 0) {
        this.registeredScheduleToolIds.add(toolCallId);
        this.postTurnSchedules.push({
          kind: 'timer',
          expectedFireAtMs: nowMs + args.DurationSeconds * 1000,
        });
      } else if (typeof args.CronExpression === 'string' && args.CronExpression.trim().length > 0) {
        this.registeredScheduleToolIds.add(toolCallId);
        const maxRuns =
          typeof args.MaxIterations === 'number' && args.MaxIterations > 0
            ? args.MaxIterations
            : null;
        this.postTurnSchedules.push({ kind: 'cron', remainingRuns: maxRuns });
      }
      return;
    }

    if (entry.name === 'swarm' && !failed && args) {
      if (this.registeredScheduleToolIds.has(toolCallId)) return;
      if (args.action === 'add') {
        this.registeredScheduleToolIds.add(toolCallId);
        const count = Math.min(
          20,
          Array.isArray(args.tasks) && args.tasks.length > 0
            ? args.tasks.length
            : typeof args.n === 'number' && args.n > 1
              ? Math.floor(args.n)
              : 1
        );
        for (let i = 0; i < count; i += 1) {
          this.postTurnSchedules.push({ kind: 'swarm' });
        }
      } else if (args.action === 'kill') {
        this.registeredScheduleToolIds.add(toolCallId);
        const swarmIdx = this.postTurnSchedules.findIndex((s) => s.kind === 'swarm');
        if (swarmIdx !== -1) this.postTurnSchedules.splice(swarmIdx, 1);
      }
      return;
    }

    if (entry.name === 'manage_task' && !failed && args?.Action === 'kill') {
      if (this.registeredManageTaskToolIds.has(toolCallId)) return;
      this.registeredManageTaskToolIds.add(toolCallId);
      const scheduleIdx = this.postTurnSchedules.findIndex(
        (s) => s.kind === 'timer' || s.kind === 'cron'
      );
      if (scheduleIdx !== -1) {
        this.postTurnSchedules.splice(scheduleIdx, 1);
      }
    }
  }
}

export interface AntigravityPollLoopOptions {
  listSessionUpdatedAt?: (signal: AbortSignal) => Promise<string | null | undefined>;
  loadSessionSnapshot: (signal: AbortSignal) => Promise<acp.SessionNotification[]>;
  consumeSnapshot: (
    notifications: readonly acp.SessionNotification[],
    nowMs: number
  ) => { deltas: acp.SessionNotification[]; hasChanges: boolean };
  onDeltas: (deltas: readonly acp.SessionNotification[]) => void;
  shouldStop: (nowMs: number) => boolean;
  onStep?: (nowMs: number) => void;
  skipPreStopVerify?: () => boolean;
  signal?: AbortSignal;
  timings?: Partial<AntigravityPollTimings>;
  onError?: (error: unknown) => void;
}

class RpcTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Antigravity RPC timed out after ${timeoutMs}ms`);
    this.name = 'RpcTimeoutError';
  }
}

async function runWithTimeoutAndAbort<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<T> {
  if (parentSignal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeParentAbort: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RpcTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  const abortPromise = parentSignal
    ? new Promise<never>((_, reject) => {
        const onParentAbort = () => {
          controller.abort();
          reject(new DOMException('Aborted', 'AbortError'));
        };
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
        removeParentAbort = () => parentSignal.removeEventListener('abort', onParentAbort);
      })
    : null;

  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  // Suppress late rejections if timeout/abort already won the race.
  operationPromise.catch(() => {});

  try {
    return await Promise.race([
      operationPromise,
      timeoutPromise,
      ...(abortPromise ? [abortPromise] : []),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeParentAbort?.();
  }
}

async function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  if (ms <= 0) return true;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Bound `session/list` + silent `session/load` polling loop for Antigravity post-`end_turn` wakeups.
 */
export async function runAntigravityPollLoop(options: AntigravityPollLoopOptions): Promise<void> {
  const timings = { ...DEFAULT_ANTIGRAVITY_POLL_TIMINGS, ...options.timings };
  const loopStartedAtMs = Date.now();

  let useList = Boolean(options.listSessionUpdatedAt);
  let lastSeenUpdatedAt: string | null | undefined = undefined;
  let baselineCaptured = false;
  let lastActivityAtMs = loopStartedAtMs;
  let lastLoadAtMs = loopStartedAtMs;
  let preStopLoadVerified = false;
  let consecutiveFailures = 0;

  const performSnapshotLoad = async (
    pendingUpdatedAt: { value: string } | null
  ): Promise<'loaded' | 'abort' | 'error'> => {
    try {
      const snapshot = await runWithTimeoutAndAbort(
        options.loadSessionSnapshot,
        timings.rpcTimeoutMs,
        options.signal
      );
      const loadDoneMs = Date.now();
      consecutiveFailures = 0;
      lastLoadAtMs = loadDoneMs;
      if (pendingUpdatedAt) {
        lastSeenUpdatedAt = pendingUpdatedAt.value;
        lastActivityAtMs = loadDoneMs;
      }

      const { deltas, hasChanges } = options.consumeSnapshot(snapshot, loadDoneMs);
      if (hasChanges) {
        lastActivityAtMs = loadDoneMs;
        preStopLoadVerified = false;
      }
      if (deltas.length > 0) {
        options.onDeltas(deltas);
      }
      return 'loaded';
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) return 'abort';
      consecutiveFailures += 1;
      options.onError?.(error);
      return 'error';
    }
  };

  while (!options.signal?.aborted && !options.shouldStop(Date.now())) {
    const nowMs = Date.now();
    let shouldLoad = !useList;
    let loadedThisTick = false;
    let pendingUpdatedAt: { value: string } | null = null;

    if (useList && options.listSessionUpdatedAt) {
      try {
        const updatedAt = await runWithTimeoutAndAbort(
          options.listSessionUpdatedAt,
          timings.rpcTimeoutMs,
          options.signal
        );

        if (!baselineCaptured) {
          baselineCaptured = true;
          lastSeenUpdatedAt = updatedAt;
        } else if (updatedAt != null && updatedAt !== lastSeenUpdatedAt) {
          pendingUpdatedAt = { value: updatedAt };
          preStopLoadVerified = false;
          shouldLoad = true;
        } else if (
          nowMs - lastActivityAtMs <= timings.wakeupPlannerGraceMs &&
          nowMs - lastLoadAtMs >= timings.sameSecondLoadCheckMs
        ) {
          shouldLoad = true;
        }

        if (!shouldLoad) {
          consecutiveFailures = 0;
        }
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) break;
        if (isMethodNotFoundError(error)) {
          useList = false;
          shouldLoad = true;
        } else {
          consecutiveFailures += 1;
          options.onError?.(error);
          if (consecutiveFailures >= timings.maxConsecutiveFailures) break;
        }
      }
    }

    if (shouldLoad && !options.signal?.aborted) {
      const outcome = await performSnapshotLoad(pendingUpdatedAt);
      if (outcome === 'abort') break;
      if (outcome === 'error' && consecutiveFailures >= timings.maxConsecutiveFailures) break;
      if (outcome === 'loaded') loadedThisTick = true;
    }

    const postStepNowMs = Date.now();
    options.onStep?.(postStepNowMs);
    if (options.signal?.aborted) {
      break;
    }
    if (options.shouldStop(postStepNowMs)) {
      if (!loadedThisTick && !preStopLoadVerified && useList && !options.skipPreStopVerify?.()) {
        preStopLoadVerified = true;
        const verifyOutcome = await performSnapshotLoad(null);
        if (verifyOutcome === 'abort' || options.signal?.aborted) {
          break;
        }
        if (verifyOutcome === 'error' && consecutiveFailures >= timings.maxConsecutiveFailures) {
          break;
        }
        const postVerifyNowMs = Date.now();
        options.onStep?.(postVerifyNowMs);
        if (options.signal?.aborted || options.shouldStop(postVerifyNowMs)) {
          break;
        }
      } else {
        break;
      }
    }

    const intervalMs = useList ? timings.listPollIntervalMs : timings.loadFallbackPollIntervalMs;
    const wokeNormally = await sleepInterruptible(intervalMs, options.signal);
    if (!wokeNormally) break;
  }
}
