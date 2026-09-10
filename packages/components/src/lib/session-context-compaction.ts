import type { MessageContent, SessionHistory } from '@lody/shared';

type ToolCallStatus = Extract<MessageContent, { type: 'tool_call' }>['status'];

export const resolveContextCompactionDisplayStatus = (
  status: ToolCallStatus,
  isTurnFinished: boolean
): ToolCallStatus => {
  if (isTurnFinished && (status === 'pending' || status === 'in_progress')) {
    return 'failed';
  }
  return status;
};

export const isSessionContextCompacting = (
  history: readonly Pick<SessionHistory, 'finished' | 'items'>[]
): boolean => {
  for (let entryIndex = history.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = history[entryIndex];
    const items = entry?.items ?? [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (item?.type !== 'tool_call' || item.activityKind !== 'context_compaction') continue;
      const status = resolveContextCompactionDisplayStatus(item.status, entry?.finished === true);
      return status === 'pending' || status === 'in_progress';
    }
  }
  return false;
};
