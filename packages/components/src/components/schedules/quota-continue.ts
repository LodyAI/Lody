import { v5 as uuidv5 } from 'uuid';
import {
  quotaReservationIdentity,
  type ScheduleDraft,
  type SessionHistory,
  type SessionMeta,
} from '@lody/shared';
import {
  FIVE_HOUR_WINDOW_SECONDS,
  getAgentRateLimitWindows,
  resolveAgentRateLimitForModel,
  type MachineRateLimits,
} from '@/lib/session-usage';
import { SCHEDULED_MESSAGE_POLICY } from './scheduled-message-write';

const CLAUDE_SESSION_LIMIT = /You've hit your session limit\s*·\s*resets\b/i;

/** Only provider failures, never user prose or quoted tool output. */
export function isClaudeSessionLimitMessage(message: unknown): message is string {
  return (
    typeof message === 'string' &&
    CLAUDE_SESSION_LIMIT.test(message) &&
    !/weekly limit/i.test(message)
  );
}

/**
 * Finds a terminal Claude session-limit failure after the latest user turn.
 * A later assistant turn means the conversation recovered, so a historical
 * failure must not offer a new scheduled message. `noticeId` is the row the
 * stream actually renders the notice in, which can be the preceding assistant
 * row when the notice is folded onto it.
 */
export function findClaudeSessionLimit(turns: readonly SessionHistory[]) {
  const userIndex = turns.findLastIndex((turn) => turn.role === 'user');
  const user = turns[userIndex];
  if (!user?.inputConfig) return null;
  for (let index = turns.length - 1; index > userIndex; index--) {
    const turn = turns[index]!;
    if (turn.role === 'assistant') return null;
    if (turn.role !== 'system') continue;
    const notice = turn.items?.find(
      (item) => item.type === 'system_notice' && item.name === 'chat_failed'
    );
    if (!notice || notice.type !== 'system_notice') continue;
    const message = (notice.meta as { message?: unknown } | undefined)?.message;
    // JSON-RPC errors can wrap the provider message. Never interpret the clock text.
    if (!isClaudeSessionLimitMessage(message)) return null;
    const failedAt = Date.parse(turn.timestamp);
    if (!Number.isFinite(failedAt)) return null;
    // The stream folds a notice-only system row onto the assistant row directly
    // before it. Name that rendered host row so the banner can prove the action
    // belongs to this failure instead of a historical one.
    const items = turn.items ?? [];
    const previous = index > userIndex + 1 ? turns[index - 1] : undefined;
    const mergedIntoPrevious =
      previous?.role === 'assistant' &&
      items.length > 0 &&
      items.every((item) => item.type === 'system_notice');
    return { user, failedAt, noticeId: mergedIntoPrevious ? previous.id : turn.id };
  }
  return null;
}

export function quotaContinueReset(args: {
  failure: NonNullable<ReturnType<typeof findClaudeSessionLimit>>;
  session: SessionMeta;
  rateLimits: MachineRateLimits | null | undefined;
  now: number;
}): number | null {
  const { failure, session, now } = args;
  if (
    session.agentType !== 'claude' ||
    !session.agentConfigId ||
    failure.user.inputConfig?.agentType !== 'claude'
  )
    return null;
  const entry = resolveAgentRateLimitForModel({
    rateLimits: args.rateLimits,
    agentType: session.agentType,
    agentConfigId: session.agentConfigId,
    modelId: failure.user.inputConfig.modelId,
  });
  if (!entry) return null;
  const windows = getAgentRateLimitWindows(entry.limits);
  const fiveHour = windows.find(
    (window) =>
      window.windowDurationSeconds === FIVE_HOUR_WINDOW_SECONDS && window.usedPercent >= 100
  );
  const reset = fiveHour?.resetsAtEpochSeconds;
  if (!reset || !Number.isFinite(reset)) return null;
  const resetMs = reset * 1000;
  // Reject stale failures paired with quota from a different billing window.
  if (
    resetMs <= now ||
    resetMs - failure.failedAt > FIVE_HOUR_WINDOW_SECONDS * 1000 ||
    failure.failedAt > now
  )
    return null;
  // A weekly/model quota that remains exhausted would make this continuation futile.
  if (
    windows.some(
      (window) =>
        window !== fiveHour &&
        window.usedPercent >= 100 &&
        (!window.resetsAtEpochSeconds || window.resetsAtEpochSeconds * 1000 > resetMs)
    )
  )
    return null;
  return resetMs;
}

/**
 * The first full minute after the provider reset. A `reset + 1 s` trigger would
 * display as the reset minute (for example 2:30:01 PM) and race the provider's
 * own boundary; the UI promises the following minute (2:31 PM).
 */
export function quotaContinueSendAt(resetMs: number): number {
  return Math.floor(resetMs / 60_000) * 60_000 + 60_000;
}

/** One reservation per conversation and reset, shared by devices and uncertain retries. */
export function quotaContinueIdentity(
  workspaceId: string,
  sessionId: string,
  resetMs: number,
  turnId: string
) {
  return quotaReservationIdentity(workspaceId, sessionId, resetMs, turnId);
}

export function legacyQuotaContinueId(
  workspaceId: string,
  sessionId: string,
  resetMs: number,
  version = 1
) {
  return uuidv5(
    JSON.stringify([
      version === 1 ? 'claude-quota-continue' : 'claude-quota-continue-v2',
      workspaceId,
      sessionId,
      resetMs,
    ]),
    uuidv5.URL
  );
}

export function quotaContinueDraft(
  session: SessionMeta,
  user: SessionHistory,
  sendAt: number,
  title: string
): ScheduleDraft {
  if (!session.agentConfigId || !session.machineId || !user.inputConfig)
    throw new Error('SCHEDULE_CONFIG_MISSING');
  const {
    modeId,
    modelId,
    configOptionValues,
    memory,
    mcpServerIds,
    agentRoleId,
    agentRoleRevision,
    agentRoleSnapshot,
  } = user.inputConfig;
  return {
    title,
    prompt: 'continue',
    message: {
      inputBlocks: [{ type: 'text', text: 'continue' }],
      mcpServerIds,
      agentRoleId,
      agentRoleRevision,
      agentRoleSnapshot,
    },
    agent: { agentConfigId: session.agentConfigId, modeId, modelId, configOptionValues, memory },
    machineId: session.machineId,
    destination: { kind: 'existing_session', sessionId: session.id },
    trigger: { kind: 'once', at: new Date(sendAt).toISOString() },
    ...SCHEDULED_MESSAGE_POLICY,
  };
}
