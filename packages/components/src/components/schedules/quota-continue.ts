import { v5 as uuidv5 } from 'uuid';
import { type ScheduleDraft, type SessionHistory, type SessionMeta } from '@lody/shared';
import {
  FIVE_HOUR_WINDOW_SECONDS,
  getAgentRateLimitWindows,
  resolveAgentRateLimitForModel,
  type MachineRateLimits,
} from '@/lib/session-usage';
import { SCHEDULED_MESSAGE_POLICY } from './scheduled-message-write';

/** Only provider failures, never user prose or quoted tool output. */
export function findClaudeSessionLimit(turns: readonly SessionHistory[]) {
  const userIndex = turns.findLastIndex((turn) => turn.role === 'user');
  const user = turns[userIndex];
  if (!user?.inputConfig) return null;
  for (let index = turns.length - 1; index > userIndex; index--) {
    const turn = turns[index]!;
    if (turn.role !== 'system') continue;
    const notice = turn.items?.find(
      (item) => item.type === 'system_notice' && item.name === 'chat_failed'
    );
    if (!notice || notice.type !== 'system_notice') continue;
    const message = (notice.meta as { message?: unknown } | undefined)?.message;
    // JSON-RPC errors can wrap the provider message. Never interpret the clock text.
    if (
      typeof message !== 'string' ||
      !/You've hit your session limit\s*·\s*resets\b/i.test(message) ||
      /weekly limit/i.test(message)
    )
      return null;
    const failedAt = Date.parse(turn.timestamp);
    return Number.isFinite(failedAt) ? { user, failedAt, noticeId: turn.id } : null;
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

/** One reservation per conversation and reset, shared by devices and uncertain retries. */
export function quotaContinueIdentity(workspaceId: string, sessionId: string, resetMs: number) {
  const scheduleId = uuidv5(
    JSON.stringify(['claude-quota-continue', workspaceId, sessionId, resetMs]),
    uuidv5.URL
  );
  return {
    scheduleId,
    activationId: uuidv5('activation', scheduleId),
    activityId: uuidv5('create', scheduleId),
  };
}

export function quotaContinueDraft(
  session: SessionMeta,
  user: SessionHistory,
  resetMs: number,
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
    trigger: { kind: 'once', at: new Date(resetMs + 1000).toISOString() },
    ...SCHEDULED_MESSAGE_POLICY,
  };
}
