import type { WorkspaceId } from './ids';

/**
 * Legacy Task Index Flock document. The product surface is gone; these helpers
 * remain so account deletion can still enumerate leftover index docs.
 */
export const TASK_INDEX_FLOCK_STREAM_SEGMENT = 'ti';

export const getTaskIndexFlockDocId = (workspaceId: WorkspaceId): string =>
  `${workspaceId}:${TASK_INDEX_FLOCK_STREAM_SEGMENT}`;

export const isTaskIndexFlockDocId = (value: string): boolean => {
  const parts = value.split(':');
  return parts.length === 2 && parts[0] !== '' && parts[1] === TASK_INDEX_FLOCK_STREAM_SEGMENT;
};

export const TASK_INDEX_ROW_FAMILY = 'task';

export const getTaskIndexScanPrefix = (): string[] => [TASK_INDEX_ROW_FAMILY];
