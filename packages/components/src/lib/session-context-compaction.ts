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
  activeAssistantTurnId: string | null;
  isGoalActive: boolean;
  canPauseGoal: boolean;
};

/**
 * Whether the session Stop control should be exposed: exactly while the last
 * assistant turn is unfinished, or a goal can be paused.
 *
 * Live activity is not consulted. A turn whose agent process is gone (crash,
 * restart) is still unfinished, and Stop is how the user ends it: the daemon
 * closes a turn that no execution owns. A finished turn has nothing to stop,
 * even while a stale compaction marker remains in history.
 */
export const canStopAgentEnabled = ({
  activeAssistantTurnId,
  isGoalActive,
  canPauseGoal,
}: CanStopAgentOptions): boolean => activeAssistantTurnId != null || (isGoalActive && canPauseGoal);
