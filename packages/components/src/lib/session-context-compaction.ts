import type { SessionHistory } from '@lody/shared';

export type ActiveSessionContextCompaction = {
  turnId: string;
  toolCallId: string;
  status: 'pending' | 'in_progress';
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
        status: item.status,
        turnFinished: entry.finished === true,
      };
    }
  }
  return null;
};

export const isSessionContextCompacting = (
  history: readonly Pick<SessionHistory, 'id' | 'role' | 'items' | 'finished'>[]
): boolean => findActiveSessionContextCompaction(history) !== null;
