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

export interface AntigravityPollTimings {
  /** `session/list` interval while background work may be pending. */
  listPollIntervalMs: number;
  /** Transcript activity followed by this much stillness counts as one wakeup finished. */
  wakeupQuietMs: number;
  /** Activity within this window reports `running` instead of `background`. */
  runningGraceMs: number;
  /** Hard bound for one monitor, matching the Core `background` protection cap. */
  maxDurationMs: number;
  rpcTimeoutMs: number;
  maxConsecutiveFailures: number;
}

export const DEFAULT_ANTIGRAVITY_POLL_TIMINGS: AntigravityPollTimings = {
  listPollIntervalMs: 2_000,
  wakeupQuietMs: 30_000,
  runningGraceMs: 10_000,
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
 * the model.
 */
const ASYNC_DISPATCH_TOOL_NAMES = new Set(['invoke_subagent', 'send_message', 'swarm']);

const BG_TASK_PLACEHOLDER_PATTERN = /Tool is running as a background task with task id:\s*(\S+)/i;
const SYSTEM_MESSAGE_SENDER_PATTERN = /<SYSTEM_MESSAGE>[\s\S]*?\bsender=(\S+)/i;

interface KnownTool {
  status: string;
  name?: string;
  daemon: boolean;
  hasOutput: boolean;
  placeholder: boolean;
  taskId?: string;
  resolved: boolean;
}

type TurnStreamPhase = 'idle' | 'thought' | 'message' | 'tool';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolName(raw: Record<string, unknown>): string | undefined {
  const meta = raw._meta;
  if (isRecord(meta) && isRecord(meta.lody) && typeof meta.lody.toolName === 'string') {
    return meta.lody.toolName;
  }
  return typeof raw.name === 'string' ? raw.name : undefined;
}

function isDaemonTool(raw: Record<string, unknown>): boolean {
  const input = isRecord(raw.rawInput) ? raw.rawInput : isRecord(raw.args) ? raw.args : undefined;
  return input?.IsDaemon === true;
}

function outputTexts(raw: Record<string, unknown>): unknown[] {
  const texts: unknown[] = [raw.rawOutput];
  if (isRecord(raw.rawOutput)) texts.push(raw.rawOutput.output);
  if (Array.isArray(raw.content)) {
    for (const item of raw.content) {
      if (!isRecord(item)) continue;
      texts.push(item.text);
      if (isRecord(item.content)) texts.push(item.content.text);
    }
  }
  return texts;
}

function extractPlaceholderTaskId(raw: Record<string, unknown>): string | undefined {
  for (const text of outputTexts(raw)) {
    if (typeof text !== 'string') continue;
    const match = BG_TASK_PLACEHOLDER_PATTERN.exec(text);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function chunkText(raw: Record<string, unknown>): string {
  const content = raw.content;
  if (typeof content === 'string') return content;
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!isRecord(item)) return '';
        if (typeof item.text === 'string') return item.text;
        if (isRecord(item.content) && typeof item.content.text === 'string') {
          return item.content.text;
        }
        return '';
      })
      .join('');
  }
  return '';
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

/**
 * Counts the background work an Antigravity ACP v1 turn leaves behind at `end_turn`, and
 * decides from `session/list` activity when it has woken the model and finished.
 *
 * agy reports nothing on stdout after `end_turn`, and its only side-effect-free signal is
 * `updatedAt`. Each burst of activity followed by {@link AntigravityPollTimings.wakeupQuietMs}
 * of stillness is taken as one pending item finishing. Errors lean towards protecting longer:
 * wakeups agy merges into one burst keep the session protected until the 24-hour cap.
 */
export class AntigravitySessionTracker {
  private readonly timings: AntigravityPollTimings;
  private readonly tools = new Map<string, KnownTool>();
  private turnToolIds = new Set<string>();
  private pending = 0;
  private turnEndedAtMs: number | null = null;
  private lastActivityAtMs = 0;
  private inWakeup = false;
  private expiredPendingWork = false;
  private turnStreamPhase: TurnStreamPhase = 'idle';

  constructor(timings?: Partial<AntigravityPollTimings>) {
    this.timings = { ...DEFAULT_ANTIGRAVITY_POLL_TIMINGS, ...timings };
  }

  getTimings(): AntigravityPollTimings {
    return this.timings;
  }

  /** Reset per-turn state before `session/prompt`; unfinished work carries into the new turn. */
  beginTurn(): void {
    // If a post-turn wakeup had already started before the user sent a new prompt,
    // settle that pending item rather than dropping `inWakeup` and leaking its count.
    if (this.inWakeup) {
      this.pending = Math.max(0, this.pending - 1);
    }
    this.turnToolIds = new Set();
    this.turnEndedAtMs = null;
    this.inWakeup = false;
    this.expiredPendingWork = false;
    this.turnStreamPhase = 'idle';
  }

  /** Clear all tracked background work after an explicit user cancel. */
  reset(): void {
    this.turnToolIds = new Set();
    this.pending = 0;
    this.turnEndedAtMs = null;
    this.lastActivityAtMs = 0;
    this.inWakeup = false;
    this.expiredPendingWork = false;
    this.turnStreamPhase = 'idle';
  }

  /** Record a live notification Lody received on stdout during a turn. */
  observeLive(notification: acp.SessionNotification): void {
    const raw = notification.update as unknown as Record<string, unknown>;
    const updateType = raw.sessionUpdate;
    if (updateType === 'tool_call' || updateType === 'tool_call_update') {
      if (typeof raw.toolCallId !== 'string') return;
      const prev = this.tools.get(raw.toolCallId);
      const outputChanged = raw.rawOutput !== undefined || raw.content !== undefined;
      const placeholderTaskId = outputChanged ? extractPlaceholderTaskId(raw) : prev?.taskId;
      const placeholder = outputChanged
        ? placeholderTaskId !== undefined
        : (prev?.placeholder ?? false);
      this.tools.set(raw.toolCallId, {
        status: typeof raw.status === 'string' ? raw.status : (prev?.status ?? ''),
        name: toolName(raw) ?? prev?.name,
        daemon: (prev?.daemon ?? false) || isDaemonTool(raw),
        hasOutput: (prev?.hasOutput ?? false) || hasOutput(raw),
        placeholder,
        taskId: placeholder ? placeholderTaskId : undefined,
        resolved: prev?.resolved ?? false,
      });
      this.turnToolIds.add(raw.toolCallId);
      this.turnStreamPhase = 'tool';
      return;
    }

    if (updateType === 'user_message_chunk') {
      const text = chunkText(raw);
      const match = SYSTEM_MESSAGE_SENDER_PATTERN.exec(text);
      const sender = match?.[1];
      if (sender && sender !== 'system') {
        if (!this.resolveTurnBackgroundToolByTaskId(sender)) {
          this.consumeOldestUnresolvedTurnBackgroundWork();
        }
        this.turnStreamPhase = 'idle';
      }
      return;
    }

    if (updateType === 'agent_message_chunk') {
      if (chunkText(raw).length > 0) {
        this.turnStreamPhase = 'message';
      }
      return;
    }

    if (updateType === 'agent_thought_chunk') {
      // Within a single planner response, thought chunks precede message chunks.
      // A thought chunk arriving after visible message text with no intervening tool call
      // means agy woke the model for a completed background task inside the same turn.
      if (this.turnStreamPhase === 'message') {
        this.consumeOldestUnresolvedTurnBackgroundWork();
      }
      this.turnStreamPhase = 'thought';
    }
  }

  /**
   * Called when `session/prompt` resolves. Returns whether background work may still be
   * pending, in which case the caller starts a monitor.
   */
  turnEnded(stopReason: string | undefined, nowMs: number): boolean {
    if (stopReason === 'end_turn') this.pending += this.countTurnBackgroundWork();
    this.turnEndedAtMs = nowMs;
    this.lastActivityAtMs = nowMs;
    return this.pending > 0;
  }

  /** `session/list` reported a new `updatedAt`. */
  noteActivity(nowMs: number): void {
    this.lastActivityAtMs = nowMs;
    this.inWakeup = true;
  }

  evaluate(nowMs: number): AntigravityMonitorState {
    if (this.inWakeup && nowMs - this.lastActivityAtMs >= this.timings.wakeupQuietMs) {
      this.inWakeup = false;
      this.pending = Math.max(0, this.pending - 1);
    }
    const endedAtMs = this.turnEndedAtMs;
    if (endedAtMs === null || (this.pending === 0 && !this.inWakeup)) {
      this.pending = 0;
      this.inWakeup = false;
      this.expiredPendingWork = false;
      return { settled: true, state: 'idle', backgroundTaskCount: 0 };
    }
    if (nowMs - endedAtMs >= this.timings.maxDurationMs) {
      this.pending = 0;
      this.inWakeup = false;
      this.expiredPendingWork = true;
      return { settled: true, state: 'idle', backgroundTaskCount: 0 };
    }
    return {
      settled: false,
      state:
        this.inWakeup && nowMs - this.lastActivityAtMs < this.timings.runningGraceMs
          ? 'running'
          : 'idle',
      backgroundTaskCount: Math.max(1, this.pending),
    };
  }

  /** True when the monitor reached its protection cap with unconfirmed background work left. */
  hasExpiredPendingWork(): boolean {
    return this.expiredPendingWork;
  }

  private isUnresolvedBackgroundTool(tool: KnownTool): boolean {
    if (tool.daemon || tool.resolved || tool.status === 'failed' || tool.status === 'cancelled') {
      return false;
    }
    const silentWorkflow =
      tool.name === 'run_workflow' && tool.status === 'completed' && !tool.hasOutput;
    return (
      tool.status === 'pending' ||
      tool.status === 'in_progress' ||
      tool.placeholder ||
      silentWorkflow ||
      (tool.name !== undefined && ASYNC_DISPATCH_TOOL_NAMES.has(tool.name))
    );
  }

  private resolveTurnBackgroundToolByTaskId(taskId: string): boolean {
    for (const id of this.turnToolIds) {
      const tool = this.tools.get(id);
      if (tool && !tool.resolved && tool.taskId === taskId) {
        tool.resolved = true;
        return true;
      }
    }
    return false;
  }

  private consumeOldestUnresolvedTurnBackgroundWork(): void {
    for (const id of this.turnToolIds) {
      const tool = this.tools.get(id);
      if (tool && this.isUnresolvedBackgroundTool(tool)) {
        tool.resolved = true;
        return;
      }
    }
  }

  private countTurnBackgroundWork(): number {
    let count = 0;
    for (const id of this.turnToolIds) {
      const tool = this.tools.get(id);
      if (tool && this.isUnresolvedBackgroundTool(tool)) {
        count += 1;
      }
    }
    return count;
  }
}

export function isMethodNotFoundError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.code === -32601) return true;
  return typeof error.message === 'string' && /method not found|-32601/i.test(error.message);
}

export interface AntigravityPollLoopOptions {
  /** Returns the session's `updatedAt`; omitted when the server lacks `session/list`. */
  listSessionUpdatedAt?: (signal: AbortSignal) => Promise<string | null | undefined>;
  onActivity: (nowMs: number) => void;
  /** Runs after every tick; returns true to stop. */
  step: (nowMs: number) => boolean;
  signal: AbortSignal;
  timings: AntigravityPollTimings;
  onError?: (error: unknown) => void;
}

async function withRpcTimeout<T>(
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
 * Polls side-effect-free `session/list` for `updatedAt` changes. `session/load` is never used:
 * agy restarts the session's MCP servers on every load, which interrupts tool calls in progress.
 * Without a working `session/list` the monitor sees no activity and protects until its cap.
 */
export async function runAntigravityPollLoop(options: AntigravityPollLoopOptions): Promise<void> {
  const { signal, timings } = options;
  let list = options.listSessionUpdatedAt;
  let lastUpdatedAt: string | null | undefined;
  let baselineCaptured = false;
  let failures = 0;

  while (!signal.aborted) {
    await sleep(timings.listPollIntervalMs, signal);
    if (signal.aborted) break;
    const listFn = list;
    if (listFn) {
      try {
        const updatedAt = await withRpcTimeout(listFn, timings.rpcTimeoutMs, signal);
        if (baselineCaptured && updatedAt != null && updatedAt !== lastUpdatedAt) {
          options.onActivity(Date.now());
        }
        baselineCaptured = true;
        lastUpdatedAt = updatedAt;
        failures = 0;
      } catch (error) {
        if (signal.aborted) break;
        if (isMethodNotFoundError(error)) {
          list = undefined;
        } else {
          options.onError?.(error);
          failures += 1;
          if (failures >= timings.maxConsecutiveFailures) list = undefined;
        }
      }
    }
    if (options.step(Date.now())) break;
  }
}
