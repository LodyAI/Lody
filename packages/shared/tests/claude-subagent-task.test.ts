import { describe, expect, it } from 'vitest';
import {
  LODY_CLAUDE_TASK_LIFECYCLE_RAW_INPUT_KEY,
  mergeSubagentTaskPayload,
} from '../src/acp/claude-subagent-task';
import type { SubagentTaskPayload } from '../src/ai';

const wire = (payload: Record<string, unknown>) => ({
  [LODY_CLAUDE_TASK_LIFECYCLE_RAW_INPUT_KEY]: payload,
});

describe('mergeSubagentTaskPayload', () => {
  it('preserves earlier-event fields while later events win', () => {
    const started: SubagentTaskPayload = {
      taskId: 'task-1',
      status: 'in_progress',
      event: 'task_started',
      subagentType: 'Explore',
      description: 'Find codex refresh logic',
    };
    const notification: SubagentTaskPayload = {
      taskId: 'task-1',
      status: 'completed',
      event: 'task_notification',
      summary: 'All done',
    };

    expect(mergeSubagentTaskPayload(started, notification)).toEqual({
      taskId: 'task-1',
      status: 'completed',
      event: 'task_notification',
      summary: 'All done',
      subagentType: 'Explore',
      description: 'Find codex refresh logic',
    });
  });
});
