import { describe, expect, it } from 'vitest';
import type { TaskId, WorkspaceId } from '../src/ids';
import {
  getTaskIndexFlockDocId,
  getTaskIndexScanPrefix,
  isTaskIndexFlockDocId,
} from '../src/task-index';
import {
  getLoroTaskStreamId,
  getTaskIdFromRoomId,
  getTaskRoomId,
  isTaskDocRoomId,
  TASK_DOC_PREFIX,
} from '../src/task-types';
import { getLoroStreamIdForDocId } from '../src/index';

describe('legacy task document ids', () => {
  it('maps leftover task rooms onto the task stream id', () => {
    const taskId = 'abc' as TaskId;
    const workspaceId = 'ws1' as WorkspaceId;
    const roomId = getTaskRoomId(taskId);
    expect(roomId).toBe(`${TASK_DOC_PREFIX}${taskId}`);
    expect(isTaskDocRoomId(roomId)).toBe(true);
    expect(getTaskIdFromRoomId(roomId)).toBe(taskId);
    expect(getLoroStreamIdForDocId(workspaceId, roomId)).toBe(
      getLoroTaskStreamId(workspaceId, taskId)
    );
  });

  it('identifies leftover task-index flock documents', () => {
    const workspaceId = 'ws1' as WorkspaceId;
    const docId = getTaskIndexFlockDocId(workspaceId);
    expect(isTaskIndexFlockDocId(docId)).toBe(true);
    expect(isTaskIndexFlockDocId('ws1:other')).toBe(false);
    expect(getTaskIndexScanPrefix()).toEqual(['task']);
  });
});
