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
  /** `session/list` interval while monitoring. */
  listPollIntervalMs: number;
  /** `session/load` interval when the server lacks `session/list`. */
  loadFallbackPollIntervalMs: number;
  /**
   * Forced `session/load` interval while output changed recently: `updatedAt` is the
   * second the latest step started, so a slow reply can finish without changing it.
   */
  activeLoadIntervalMs: number;
  /** How long "recently" lasts for {@link activeLoadIntervalMs}. */
  activeWindowMs: number;
  /** Quiet time, with no tool still running, before the monitor releases. */
  settleQuietMs: number;
  /** Quiet time used instead when the turn dispatched work that reports only by waking the model. */
  asyncDispatchQuietMs: number;
  /** A snapshot change within this window reports `running` instead of `background`. */
  runningGraceMs: number;
  /** A post-turn tool stuck in `pending` without a forwarded permission request is failed after this. */
  orphanedPendingToolGraceMs: number;
  /** Hard bound for one monitor, matching the Core `background` protection cap. */
  maxDurationMs: number;
  rpcTimeoutMs: number;
  maxConsecutiveFailures: number;
}

export const DEFAULT_ANTIGRAVITY_POLL_TIMINGS: AntigravityPollTimings = {
  listPollIntervalMs: 2_000,
  loadFallbackPollIntervalMs: 10_000,
  activeLoadIntervalMs: 6_000,
  activeWindowMs: 90_000,
  settleQuietMs: 30_000,
  asyncDispatchQuietMs: 10 * 60_000,
  runningGraceMs: 10_000,
  orphanedPendingToolGraceMs: 4_000,
  maxDurationMs: 24 * 60 * 60_000,
  rpcTimeoutMs: 15_000,
  maxConsecutiveFailures: 5,
};

export interface AntigravityMonitorState {
  settled: boolean;
  state: 'idle' | 'running';
  backgroundTaskCount: number;
}

/**
 * Tools whose completion only acknowledges dispatch; their result arrives later by waking
 * the model, so there is no tool status to wait on.
 */
const ASYNC_DISPATCH_TOOL_NAMES = new Set(['invoke_subagent', 'send_message', 'swarm']);

const IGNORED_REPLAY_UPDATES = new Set([
  'user_message_chunk',
  'available_commands_update',
  'config_option_update',
  'session_info_update',
  'current_mode_update',
]);

const BG_TASK_PLACEHOLDER_PATTERN = /Tool is running as a background task with task id:\s*\S+/i;

interface KnownTool {
  /** Merged raw update fields, newest last. */
  raw: Record<string, unknown>;
  fingerprint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRaw(update: acp.SessionUpdate): Record<string, unknown> {
  return update as unknown as Record<string, unknown>;
}

function toolCallIdOf(raw: Record<string, unknown>): string | null {
  return (raw.sessionUpdate === 'tool_call' || raw.sessionUpdate === 'tool_call_update') &&
    typeof raw.toolCallId === 'string'
    ? raw.toolCallId
    : null;
}

function mergeToolRaw(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...prev };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  return merged;
}

function fingerprintOf(raw: Record<string, unknown>): string {
  return JSON.stringify([raw.status ?? null, raw.rawOutput ?? null, raw.content ?? null]);
}

function toolName(raw: Record<string, unknown>): string | undefined {
  const meta = raw._meta;
  if (isRecord(meta) && isRecord(meta.lody) && typeof meta.lody.toolName === 'string') {
    return meta.lody.toolName;
  }
  return typeof raw.name === 'string' ? raw.name : undefined;
}

function toolStatus(raw: Record<string, unknown>): string {
  return typeof raw.status === 'string' ? raw.status : '';
}

function isActiveStatus(status: string): boolean {
  return status === 'pending' || status === 'in_progress';
}

function isDaemonTool(raw: Record<string, unknown>): boolean {
  const input = isRecord(raw.rawInput) ? raw.rawInput : isRecord(raw.args) ? raw.args : undefined;
  return input?.IsDaemon === true;
}

function hasBackgroundPlaceholder(raw: Record<string, unknown>): boolean {
  const texts: unknown[] = [raw.rawOutput];
  if (isRecord(raw.rawOutput)) texts.push(raw.rawOutput.output);
  if (Array.isArray(raw.content)) {
    for (const item of raw.content) {
      if (!isRecord(item)) continue;
      texts.push(item.text);
      if (isRecord(item.content)) texts.push(item.content.text);
    }
  }
  return texts.some((text) => typeof text === 'string' && BG_TASK_PLACEHOLDER_PATTERN.test(text));
}

function textOf(update: acp.SessionUpdate): string | null {
  if (
    update.sessionUpdate !== 'agent_message_chunk' &&
    update.sessionUpdate !== 'agent_thought_chunk'
  ) {
    return null;
  }
  const content = (update as { content?: unknown }).content;
  return isRecord(content) && content.type === 'text' && typeof content.text === 'string'
    ? content.text
    : null;
}

function withText(notification: acp.SessionNotification, text: string): acp.SessionNotification {
  const update = asRaw(notification.update);
  const content = isRecord(update.content) ? update.content : {};
  return {
    ...notification,
    update: { ...update, content: { ...content, text } } as unknown as acp.SessionUpdate,
  };
}

function hasOutput(raw: Record<string, unknown>): boolean {
  const output = raw.rawOutput;
  const hasRaw =
    typeof output === 'string' || Array.isArray(output)
      ? output.length > 0
      : isRecord(output)
        ? Object.keys(output).length > 0
        : output !== undefined && output !== null;
  return hasRaw || (Array.isArray(raw.content) && raw.content.length > 0);
}

function toolNotification(
  sessionId: acp.SessionId,
  raw: Record<string, unknown>,
  sessionUpdate: 'tool_call' | 'tool_call_update'
): acp.SessionNotification {
  return { sessionId, update: { ...raw, sessionUpdate } as unknown as acp.SessionUpdate };
}

export function isMethodNotFoundError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.code === -32601) return true;
  return typeof error.message === 'string' && /method not found|-32601/i.test(error.message);
}

/**
 * Tracks what Lody has already shown for one Antigravity ACP v1 session so post-`end_turn`
 * `session/load` snapshots yield only unseen deltas, and decides whether background work
 * is still pending.
 */
export class AntigravitySessionTracker {
  private readonly timings: AntigravityPollTimings;
  private readonly tools = new Map<string, KnownTool>();
  /** Tools first seen in the current turn or its wakeups; only these may emit snapshot deltas. */
  private turnToolIds = new Set<string>();
  /** Unsettled tools inherited from an earlier turn; their items live in that turn's entry. */
  private carriedToolIds = new Set<string>();
  private pendingAtTurnEnd = new Set<string>();
  private livePermissionToolIds = new Set<string>();
  private postTurnPendingSinceMs = new Map<string, number>();
  private orphanedToolIds = new Set<string>();

  private emittedAssistantChars = 0;
  private emittedThoughtChars = 0;
  private lastEmittedKind: 'text' | 'tool' | 'other' = 'other';
  private lastTextEndsWithNewline = true;
  private needsBreakBeforeText = false;
  private lastUsageKey: string | null = null;

  private turnEndedAtMs: number | null = null;
  private lastChangeAtMs = 0;
  private lastOutputAtMs = 0;
  private lastTextAtMs = 0;
  private asyncDispatched = false;
  /** Set once a monitor saw this work settle; until then a new turn inherits it. */
  private released = true;

  constructor(
    private readonly sessionId: acp.SessionId,
    timings?: Partial<AntigravityPollTimings>
  ) {
    this.timings = { ...DEFAULT_ANTIGRAVITY_POLL_TIMINGS, ...timings };
  }

  getTimings(): AntigravityPollTimings {
    return this.timings;
  }

  /** Record a resumed session's `session/load` replay so its history never re-emits. */
  seedBaseline(notifications: readonly acp.SessionNotification[]): void {
    for (const notification of notifications) {
      const raw = asRaw(notification.update);
      const id = toolCallIdOf(raw);
      if (id) {
        this.recordTool(id, raw, 0);
      } else if (raw.sessionUpdate === 'usage_update') {
        this.lastUsageKey = JSON.stringify(raw);
      }
    }
  }

  /** Reset per-turn state right before dispatching `session/prompt`. */
  beginTurn(): void {
    // A user may keep chatting while earlier background work runs. Work that has not
    // settled carries into this turn so its completion is still tracked and replayed.
    const carried = this.released ? new Set<string>() : new Set(this.pendingToolIds());
    this.asyncDispatched = !this.released && this.asyncDispatched;
    this.released = false;
    this.turnToolIds = carried;
    this.carriedToolIds = new Set(carried);
    this.pendingAtTurnEnd = new Set();
    this.livePermissionToolIds = new Set();
    this.postTurnPendingSinceMs = new Map();
    this.orphanedToolIds = new Set();
    this.emittedAssistantChars = 0;
    this.emittedThoughtChars = 0;
    this.lastEmittedKind = 'other';
    this.lastTextEndsWithNewline = true;
    this.needsBreakBeforeText = false;
    this.turnEndedAtMs = null;
  }

  notifyLivePermissionRequest(toolCallId: string): void {
    this.livePermissionToolIds.add(toolCallId);
    this.postTurnPendingSinceMs.delete(toolCallId);
  }

  /** Record a notification Lody received live on stdout. */
  observeLive(notification: acp.SessionNotification, nowMs: number): void {
    const update = notification.update;
    const raw = asRaw(update);
    const id = toolCallIdOf(raw);
    if (id) {
      this.recordTool(id, raw, nowMs);
      this.turnToolIds.add(id);
      this.lastEmittedKind = 'tool';
      return;
    }
    const text = textOf(update);
    if (text === null) {
      if (raw.sessionUpdate === 'usage_update') this.lastUsageKey = JSON.stringify(raw);
      return;
    }
    if (update.sessionUpdate === 'agent_thought_chunk') {
      this.emittedThoughtChars += text.length;
      return;
    }
    this.emittedAssistantChars += text.length;
    if (text.length > 0) {
      this.lastEmittedKind = 'text';
      this.lastTextEndsWithNewline = text.endsWith('\n');
    }
  }

  /**
   * Called when `session/prompt` resolves. Returns whether background work may still report
   * through the session transcript, in which case the caller starts a monitor.
   */
  turnEnded(stopReason: string | undefined, nowMs: number): boolean {
    if (stopReason !== 'end_turn') return false;
    this.turnEndedAtMs = nowMs;
    this.lastChangeAtMs = nowMs;
    this.needsBreakBeforeText = true;
    for (const id of this.turnToolIds) {
      const tool = this.tools.get(id);
      if (tool && toolStatus(tool.raw) === 'pending') this.pendingAtTurnEnd.add(id);
    }
    return this.asyncDispatched || this.activeToolCount() > 0;
  }

  /** Extract unseen deltas from a full `session/load` replay. */
  consumeSnapshot(
    notifications: readonly acp.SessionNotification[],
    nowMs: number
  ): acp.SessionNotification[] {
    if (nowMs - this.lastTextAtMs >= this.timings.runningGraceMs) {
      // A pause this long separates wakeups; consecutive chunks of one reply stay joined.
      this.needsBreakBeforeText = true;
    }
    let lastUserIndex = -1;
    const finalToolState = new Map<string, { raw: Record<string, unknown>; lastIndex: number }>();
    notifications.forEach((notification, index) => {
      const raw = asRaw(notification.update);
      if (raw.sessionUpdate === 'user_message_chunk') lastUserIndex = index;
      const id = toolCallIdOf(raw);
      if (id) {
        // Fold every replayed state first so intermediate states never re-emit.
        const prev = finalToolState.get(id);
        finalToolState.set(id, { raw: mergeToolRaw(prev?.raw, raw), lastIndex: index });
      }
    });

    const deltas: acp.SessionNotification[] = [];
    let seenAssistantChars = 0;
    let seenThoughtChars = 0;
    let latestUsage: acp.SessionNotification | null = null;

    notifications.forEach((notification, index) => {
      const update = notification.update;
      const raw = asRaw(update);
      if (IGNORED_REPLAY_UPDATES.has(update.sessionUpdate)) return;

      const id = toolCallIdOf(raw);
      if (id) {
        const folded = finalToolState.get(id);
        if (!folded || folded.lastIndex !== index) return;
        const delta = this.reconcileTool(id, folded.raw, index > lastUserIndex, nowMs);
        if (delta) deltas.push(delta);
        return;
      }
      if (update.sessionUpdate === 'usage_update') {
        latestUsage = notification;
        return;
      }
      if (index < lastUserIndex) return;

      const text = textOf(update);
      if (text === null) return;
      const isThought = update.sessionUpdate === 'agent_thought_chunk';
      const chunkStart = isThought ? seenThoughtChars : seenAssistantChars;
      const chunkEnd = chunkStart + text.length;
      const emitted = isThought ? this.emittedThoughtChars : this.emittedAssistantChars;
      if (isThought) seenThoughtChars = chunkEnd;
      else seenAssistantChars = chunkEnd;
      if (chunkEnd <= emitted) return;

      let slice = text.slice(Math.max(0, emitted - chunkStart));
      if (isThought) {
        this.emittedThoughtChars = chunkEnd;
      } else {
        this.emittedAssistantChars = chunkEnd;
        if (
          this.needsBreakBeforeText &&
          this.lastEmittedKind === 'text' &&
          !this.lastTextEndsWithNewline &&
          !slice.startsWith('\n')
        ) {
          slice = `\n\n${slice}`;
        }
        this.needsBreakBeforeText = false;
        this.lastEmittedKind = 'text';
        this.lastTextEndsWithNewline = slice.endsWith('\n');
        this.resolvePlaceholderTools();
      }
      this.lastTextAtMs = nowMs;
      this.markOutput(nowMs);
      deltas.push(slice === text ? notification : withText(notification, slice));
    });

    if (latestUsage) {
      const key = JSON.stringify(asRaw((latestUsage as acp.SessionNotification).update));
      if (key !== this.lastUsageKey) {
        this.lastUsageKey = key;
        deltas.push(latestUsage);
      }
    }
    return deltas;
  }

  /**
   * Fail post-turn tools stuck in `pending` with no forwarded permission request: `agy acp`
   * stops forwarding `session/request_permission` after `end_turn`, so they would never resolve.
   */
  expireOrphanedPendingTools(nowMs: number): {
    deltas: acp.SessionNotification[];
    shouldCancelSession: boolean;
  } {
    const deltas: acp.SessionNotification[] = [];
    for (const [id, sinceMs] of this.postTurnPendingSinceMs) {
      if (nowMs - sinceMs < this.timings.orphanedPendingToolGraceMs) continue;
      this.postTurnPendingSinceMs.delete(id);
      this.orphanedToolIds.add(id);
      const tool = this.tools.get(id);
      const raw = mergeToolRaw(tool?.raw, {
        toolCallId: id,
        status: 'failed',
        rawOutput: { error: ORPHANED_POST_TURN_PERMISSION_MESSAGE },
        content: [
          {
            type: 'content',
            content: { type: 'text', text: ORPHANED_POST_TURN_PERMISSION_MESSAGE },
          },
        ],
      });
      this.tools.set(id, { raw, fingerprint: fingerprintOf(raw) });
      deltas.push(toolNotification(this.sessionId, stripInternal(raw), 'tool_call_update'));
      this.lastEmittedKind = 'tool';
      this.markOutput(nowMs);
    }
    return { deltas, shouldCancelSession: deltas.length > 0 };
  }

  evaluate(nowMs: number): AntigravityMonitorState {
    const endedAtMs = this.turnEndedAtMs;
    if (endedAtMs === null) return { settled: true, state: 'idle', backgroundTaskCount: 0 };
    const active = this.activeToolCount();
    const quietMs = this.asyncDispatched
      ? this.timings.asyncDispatchQuietMs
      : this.timings.settleQuietMs;
    if (
      nowMs - endedAtMs >= this.timings.maxDurationMs ||
      (active === 0 && nowMs - this.lastChangeAtMs >= quietMs)
    ) {
      this.released = true;
      return { settled: true, state: 'idle', backgroundTaskCount: 0 };
    }
    return {
      settled: false,
      state: nowMs - this.lastOutputAtMs < this.timings.runningGraceMs ? 'running' : 'idle',
      backgroundTaskCount: Math.max(1, active),
    };
  }

  /** Whether output changed recently enough that `updatedAt` may be frozen mid-reply. */
  isRecentlyActive(nowMs: number): boolean {
    return nowMs - this.lastChangeAtMs < this.timings.activeWindowMs;
  }

  private markOutput(nowMs: number): void {
    this.lastChangeAtMs = nowMs;
    this.lastOutputAtMs = nowMs;
  }

  private activeToolCount(): number {
    return this.pendingToolIds().length;
  }

  private pendingToolIds(): string[] {
    return [...this.turnToolIds].filter((id) => {
      const tool = this.tools.get(id);
      if (!tool || this.orphanedToolIds.has(id) || isDaemonTool(tool.raw)) return false;
      return isActiveStatus(toolStatus(tool.raw)) || tool.raw._lodyBackgroundPlaceholder === true;
    });
  }

  /**
   * `agy` may never rewrite a placeholder output once the task finishes; the wakeup reply is
   * the completion signal. The async quiet window still covers any sibling task.
   */
  private resolvePlaceholderTools(): void {
    for (const id of this.turnToolIds) {
      const tool = this.tools.get(id);
      if (tool?.raw._lodyBackgroundPlaceholder === true && !isActiveStatus(toolStatus(tool.raw))) {
        delete tool.raw._lodyBackgroundPlaceholder;
      }
    }
  }

  private recordTool(id: string, raw: Record<string, unknown>, nowMs: number): KnownTool {
    const prev = this.tools.get(id);
    const merged = mergeToolRaw(prev?.raw, raw);
    const placeholder =
      raw.rawOutput !== undefined || raw.content !== undefined
        ? hasBackgroundPlaceholder(merged)
        : prev?.raw._lodyBackgroundPlaceholder === true;
    if (placeholder) merged._lodyBackgroundPlaceholder = true;
    else delete merged._lodyBackgroundPlaceholder;
    const tool: KnownTool = { raw: merged, fingerprint: fingerprintOf(merged) };
    this.tools.set(id, tool);

    const name = toolName(merged);
    const status = toolStatus(merged);
    const silentWorkflow = name === 'run_workflow' && status === 'completed' && !hasOutput(merged);
    if (
      status !== 'failed' &&
      !isDaemonTool(merged) &&
      (placeholder || silentWorkflow || (name !== undefined && ASYNC_DISPATCH_TOOL_NAMES.has(name)))
    ) {
      this.asyncDispatched = true;
    }
    if (this.turnEndedAtMs !== null) {
      if (status !== 'pending') {
        this.postTurnPendingSinceMs.delete(id);
      } else if (
        !this.pendingAtTurnEnd.has(id) &&
        !this.livePermissionToolIds.has(id) &&
        !this.orphanedToolIds.has(id) &&
        !this.postTurnPendingSinceMs.has(id)
      ) {
        this.postTurnPendingSinceMs.set(id, nowMs);
      }
    }
    return tool;
  }

  private reconcileTool(
    id: string,
    replayRaw: Record<string, unknown>,
    afterLastUser: boolean,
    nowMs: number
  ): acp.SessionNotification | null {
    const prev = this.tools.get(id);
    if (!prev) {
      // Tools before the last user message belong to history Lody did not stream
      // (for example a forked session's earlier turns); record them silently.
      if (afterLastUser) this.turnToolIds.add(id);
      const tool = this.recordTool(id, replayRaw, nowMs);
      if (!afterLastUser) return null;
      this.lastEmittedKind = 'tool';
      this.markOutput(nowMs);
      return toolNotification(this.sessionId, stripInternal(tool.raw), 'tool_call');
    }
    if (this.orphanedToolIds.has(id) && isActiveStatus(toolStatus(replayRaw))) return null;
    if (fingerprintOf(mergeToolRaw(prev.raw, replayRaw)) === prev.fingerprint) return null;
    const tool = this.recordTool(id, replayRaw, nowMs);
    if (!this.turnToolIds.has(id)) return null;
    if (!this.carriedToolIds.has(id)) this.lastEmittedKind = 'tool';
    this.markOutput(nowMs);
    return toolNotification(this.sessionId, stripInternal(tool.raw), 'tool_call_update');
  }
}

function stripInternal(raw: Record<string, unknown>): Record<string, unknown> {
  const { _lodyBackgroundPlaceholder: _ignored, ...rest } = raw;
  return rest;
}

export interface AntigravityPollLoopOptions {
  /** Returns the session's `updatedAt`; omitted when the server lacks `session/list`. */
  listSessionUpdatedAt?: (signal: AbortSignal) => Promise<string | null | undefined>;
  /** Loads a full snapshot and applies its deltas; returns nothing the loop needs. */
  loadSnapshot: (signal: AbortSignal) => Promise<void>;
  /** Whether output changed recently; drives forced reloads while `updatedAt` may be frozen. */
  isRecentlyActive: (nowMs: number) => boolean;
  /** Runs after every tick; returns true to stop. */
  step: (nowMs: number) => boolean;
  signal: AbortSignal;
  timings: AntigravityPollTimings;
  onError?: (error: unknown) => void;
}

async function withRpcBounds<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  parent.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operationPromise = operation(controller.signal);
    operationPromise.catch(() => {});
    return await Promise.race([
      operationPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Antigravity RPC timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        controller.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true }
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', onAbort);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Bounded read-only poll: `session/list` detects transcript changes, `session/load` fetches them.
 * Before settling it always loads once more, so a reply finishing within the same `updatedAt`
 * second as its trigger is not lost.
 */
export async function runAntigravityPollLoop(options: AntigravityPollLoopOptions): Promise<void> {
  const { signal, timings } = options;
  let list = options.listSessionUpdatedAt;
  let lastUpdatedAt: string | null | undefined;
  let baselineCaptured = false;
  let lastLoadAtMs = Date.now();
  let failures = 0;

  const attempt = async (operation: () => Promise<void>): Promise<boolean> => {
    try {
      await operation();
      failures = 0;
      return true;
    } catch (error) {
      if (signal.aborted) return false;
      if (list && isMethodNotFoundError(error)) {
        list = undefined;
        return true;
      }
      failures += 1;
      options.onError?.(error);
      return failures < timings.maxConsecutiveFailures;
    }
  };
  const load = async () => {
    await withRpcBounds(options.loadSnapshot, timings.rpcTimeoutMs, signal);
    lastLoadAtMs = Date.now();
  };

  while (!signal.aborted) {
    await sleep(list ? timings.listPollIntervalMs : timings.loadFallbackPollIntervalMs, signal);
    if (signal.aborted) break;
    const continued = await attempt(async () => {
      const listFn = list;
      if (!listFn) {
        await load();
        return;
      }
      const updatedAt = await withRpcBounds(listFn, timings.rpcTimeoutMs, signal);
      const changed = baselineCaptured ? updatedAt != null && updatedAt !== lastUpdatedAt : true;
      baselineCaptured = true;
      const nowMs = Date.now();
      if (
        changed ||
        (options.isRecentlyActive(nowMs) && nowMs - lastLoadAtMs >= timings.activeLoadIntervalMs)
      ) {
        await load();
      }
      lastUpdatedAt = updatedAt;
    });
    if (!continued || signal.aborted) break;
    if (options.step(Date.now())) {
      if (!(await attempt(load)) || signal.aborted || options.step(Date.now())) break;
    }
  }
}
