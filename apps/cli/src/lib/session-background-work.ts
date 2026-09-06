import {
  collectPendingScheduledTasksFromHistory,
  isRecord,
  SubagentTaskPayloadSchema,
  type SubagentTaskStatus,
} from '@lody/shared';

/** Persisted task state and schedules; elapsed fire times never prove completion. */
export function hasBackgroundWorkFromHistory(
  history: readonly { items?: readonly unknown[] }[]
): boolean {
  const latest = new Map<string, SubagentTaskStatus>();
  for (const entry of history) {
    for (const item of entry.items ?? []) {
      if (!isRecord(item) || item.type !== 'subagent_task') continue;
      const parsed = SubagentTaskPayloadSchema.safeParse(item);
      if (parsed.success) latest.set(parsed.data.taskId, parsed.data.status);
    }
  }
  return (
    [...latest.values()].some((status) => status === 'pending' || status === 'in_progress') ||
    collectPendingScheduledTasksFromHistory(history).length > 0
  );
}
