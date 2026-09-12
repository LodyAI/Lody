import type { SessionHistory } from '@lody/shared';

export type ActiveSessionContextCompaction = {
  turnId: string;
  toolCallId: string;
  turnFinished: boolean;
};

export const findActiveSessionContextCompaction = (
  history: readonly Pick<SessionHistory, 'id' | 'role' | 'items' | 'finished'>[]
): ActiveSessionContextCompaction | null => {
  for (let entryIndex = history.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = history[entryIndex];
    if (!entry || entry.role !== 'assistant') continue;
    const items = entry.items ?? [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (item?.type !== 'tool_call' || item.activityKind !== 'context_compaction') continue;
      if (item.status !== 'pending' && item.status !== 'in_progress') return null;
      return {
        turnId: entry.id,
        toolCallId: item.toolCallId,
        turnFinished: entry.finished === true,
      };
    }
  }
  return null;
};

export const isSessionContextCompacting = (
  history: readonly Pick<SessionHistory, 'id' | 'role' | 'items' | 'finished'>[]
): boolean => findActiveSessionContextCompaction(history) !== null;

export type CanStopAgentOptions = {
  isContextCompacting: boolean;
  isSessionActive: boolean;
  activeAssistantTurnId: string | null;
  isGoalActive: boolean;
  canPauseGoal: boolean;
};

/**
 * Whether the session Stop control should be exposed.
 *
 * The compaction branch is gated on a cancellable assistant turn: when a
 * pending/in-progress compaction marker remains in history but its assistant
 * entry is already finished (restart, interrupted notification stream),
 * `isContextCompacting` is true while `activeAssistantTurnId` is null. In that
 * state Stop would be shown but `handleStop` rejects the click as
 * `missing_active_turn`, leaving an idle session with a permanently
 * nonfunctional Stop button. Only expose Stop during compaction when there is
 * a turn to cancel.
 */
export const canStopAgentEnabled = ({
  isContextCompacting,
  isSessionActive,
  activeAssistantTurnId,
  isGoalActive,
  canPauseGoal,
}: CanStopAgentOptions): boolean =>
  (isContextCompacting && activeAssistantTurnId != null) ||
  (isSessionActive && activeAssistantTurnId != null) ||
  (isGoalActive && canPauseGoal);
