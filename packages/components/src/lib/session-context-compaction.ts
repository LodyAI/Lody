import type { SessionHistory } from '@lody/shared';

export const isSessionContextCompacting = (
  history: readonly Pick<SessionHistory, 'items'>[]
): boolean => {
  for (let entryIndex = history.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const items = history[entryIndex]?.items ?? [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (item?.type !== 'tool_call' || item.activityKind !== 'context_compaction') continue;
      return item.status === 'pending' || item.status === 'in_progress';
    }
  }
  return false;
};

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
