import type { TaskId, WorkspaceId } from './ids';

/**
 * Legacy workspace Task document ids. The product surface is gone; these
 * helpers remain so account deletion and stream mapping can still find leftover
 * `task-<id>` rooms.
 */
export const TASK_DOC_PREFIX = 'task-';
export const LORO_TASK_STREAM_SEGMENT = 'tk';

export const getTaskRoomId = (taskId: TaskId): string => `${TASK_DOC_PREFIX}${taskId}`;

export const isTaskDocRoomId = (roomId: string): boolean => roomId.startsWith(TASK_DOC_PREFIX);

export const getTaskIdFromRoomId = (roomId: string): TaskId | null =>
  isTaskDocRoomId(roomId) ? (roomId.slice(TASK_DOC_PREFIX.length) as TaskId) : null;

export const getLoroTaskStreamId = (workspaceId: WorkspaceId, taskId: TaskId): string =>
  `${workspaceId}:${LORO_TASK_STREAM_SEGMENT}:${taskId}`;
