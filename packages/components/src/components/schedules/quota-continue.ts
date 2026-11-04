import type { SessionHistory } from '@lody/shared';

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
 * failure must not offer recovery. `noticeId` is the row the
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
