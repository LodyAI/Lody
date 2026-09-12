import { describe, expect, it } from 'vitest';
import {
  LODY_CLAUDE_TASK_LIFECYCLE_RAW_INPUT_KEY,
  mergeSubagentTaskPayload,
  parseLodyTaskMeta,
  parseSubagentTaskWire,
} from '../src/acp/claude-subagent-task';
import type { SubagentTaskPayload } from '../src/ai';

const wire = (payload: Record<string, unknown>) => ({
  [LODY_CLAUDE_TASK_LIFECYCLE_RAW_INPUT_KEY]: payload,
});

describe('parseSubagentTaskWire', () => {
  it('parses a well-formed wire payload and strips unknown keys', () => {
    const parsed = parseSubagentTaskWire(
      wire({
        version: 1, // not part of the payload schema → stripped
        event: 'task_started',
        taskId: 'task-1',
        status: 'in_progress',
        subagentType: 'Explore',
        description: 'Find X',
        isBackgrounded: true,
        workflowName: 'spec',
      })
    );
    expect(parsed).toMatchObject({
      event: 'task_started',
      taskId: 'task-1',
      status: 'in_progress',
      subagentType: 'Explore',
      description: 'Find X',
      isBackgrounded: true,
      workflowName: 'spec',
    });
    expect(parsed && 'version' in parsed).toBe(false);
  });

  it('returns null when the wire carrier is absent', () => {
    expect(parseSubagentTaskWire({ other: 1 })).toBeNull();
    expect(parseSubagentTaskWire(undefined)).toBeNull();
    expect(parseSubagentTaskWire('nope')).toBeNull();
  });

  it('returns null for malformed payloads (missing taskId / bad status)', () => {
    expect(
      parseSubagentTaskWire(wire({ event: 'task_started', status: 'in_progress' }))
    ).toBeNull();
    expect(parseSubagentTaskWire(wire({ taskId: 't', status: 'weird' }))).toBeNull();
  });
});

describe('parseLodyTaskMeta', () => {
  it('carries a validated lifecycle event into the task payload', () => {
    expect(
      parseLodyTaskMeta({
        lody: {
          task: {
            version: 1,
            taskId: 'task-meta',
            kind: 'subagent',
            status: 'in_progress',
            event: 'task_updated',
          },
        },
      })
    ).toMatchObject({ taskId: 'task-meta', status: 'in_progress', event: 'task_updated' });
  });

  it('rejects an unknown lifecycle event', () => {
    expect(
      parseLodyTaskMeta({
        lody: {
          task: {
            version: 1,
            taskId: 'task-meta',
            kind: 'subagent',
            status: 'in_progress',
            event: 'resume-ish',
          },
        },
      })
    ).toBeNull();
  });
});

describe('mergeSubagentTaskPayload', () => {
  it('preserves task identity and purpose while activity fields advance', () => {
    const started: SubagentTaskPayload = {
      taskId: 'task-1',
      status: 'in_progress',
      event: 'task_started',
      subagentType: 'Explore',
      actor: 'Explore',
      description: 'Find codex refresh logic',
    };
    const notification: SubagentTaskPayload = {
      taskId: 'task-1',
      status: 'completed',
      event: 'task_notification',
      summary: 'All done',
      actor: 'progress-reporter',
      description: 'Reading files',
    };

    expect(mergeSubagentTaskPayload(started, notification)).toEqual({
      taskId: 'task-1',
      status: 'completed',
      event: 'task_notification',
      summary: 'All done',
      subagentType: 'Explore',
      actor: 'Explore',
      description: 'Find codex refresh logic',
    });
  });

  it('keeps background state sticky across ordinary progress snapshots', () => {
    const backgrounded: SubagentTaskPayload = {
      taskId: 'task-bg',
      status: 'in_progress',
      taskKind: 'background',
      isBackgrounded: true,
      actor: 'Explore',
      description: 'Audit history writes',
    };

    expect(
      mergeSubagentTaskPayload(backgrounded, {
        taskId: 'task-bg',
        status: 'in_progress',
        taskKind: 'subagent',
        isBackgrounded: false,
        lastToolName: 'Read',
      })
    ).toMatchObject({
      taskKind: 'background',
      isBackgrounded: true,
      actor: 'Explore',
      description: 'Audit history writes',
      lastToolName: 'Read',
    });
  });

  it('ignores late progress after settlement but permits an explicit resume', () => {
    const completed: SubagentTaskPayload = {
      taskId: 'task-resume',
      status: 'completed',
      event: 'task_notification',
      description: 'Implement the fix',
      summary: 'First pass complete',
    };
    const lateProgress: SubagentTaskPayload = {
      taskId: 'task-resume',
      status: 'in_progress',
      event: 'task_progress',
      lastToolName: 'Read',
    };

    expect(mergeSubagentTaskPayload(completed, lateProgress)).toEqual(completed);
    expect(
      mergeSubagentTaskPayload(completed, {
        taskId: 'task-resume',
        status: 'in_progress',
        event: 'task_updated',
        summary: 'Resumed for follow-up',
      })
    ).toMatchObject({
      status: 'in_progress',
      event: 'task_updated',
      description: 'Implement the fix',
      summary: 'Resumed for follow-up',
    });
  });
});
