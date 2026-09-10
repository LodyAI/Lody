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
