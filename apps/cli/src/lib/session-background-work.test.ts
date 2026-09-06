import { expect, it } from 'vitest';
import { hasBackgroundWorkFromHistory } from './session-background-work';

const task = (taskId: string, status: string, taskKind?: string) => ({
  type: 'subagent_task',
  taskId,
  status,
  ...(taskKind ? { taskKind } : {}),
});

it.each(['subagent', 'background', 'scheduled', undefined])('protects active %s tasks', (kind) => {
  for (const status of ['pending', 'in_progress']) {
    expect(hasBackgroundWorkFromHistory([{ items: [task('a', status, kind)] }])).toBe(true);
  }
});

it.each(['completed', 'failed'])('does not pin terminal task state %s', (status) => {
  expect(hasBackgroundWorkFromHistory([{ items: [task('a', status)] }])).toBe(false);
});

it('uses the latest snapshot per task and supports resumed agents', () => {
  const history = [{ items: [task('a', 'in_progress')] }, { items: [task('a', 'completed')] }];
  expect(hasBackgroundWorkFromHistory(history)).toBe(false);
  expect(hasBackgroundWorkFromHistory([...history, { items: [task('a', 'pending')] }])).toBe(true);
  expect(hasBackgroundWorkFromHistory([...history, { items: [task('b', 'in_progress')] }])).toBe(
    true
  );
});

it('ignores malformed cron and generic tool calls', () => {
  expect(
    hasBackgroundWorkFromHistory([
      {
        items: [
          { type: 'tool_call', toolName: 'CronCreate', status: 'completed' },
          { type: 'tool_call', status: 'in_progress' },
          null,
          { type: 'subagent_task' },
        ],
      },
    ])
  ).toBe(false);
});

it('protects a completed scheduling call until explicit cron deletion', () => {
  const create = {
    type: 'tool_call',
    toolName: 'CronCreate',
    status: 'completed',
    toolCallId: 'create-1',
    rawInput: { cron: '* * * * *', recurring: true },
    rawOutput: 'id: job-123',
  };
  const remove = {
    type: 'tool_call',
    toolName: 'CronDelete',
    status: 'completed',
    rawInput: { id: 'job-123' },
  };
  expect(hasBackgroundWorkFromHistory([{ items: [create] }])).toBe(true);
  expect(hasBackgroundWorkFromHistory([{ items: [create, remove] }])).toBe(false);
  expect(hasBackgroundWorkFromHistory([{ items: [create, { ...remove, status: 'failed' }] }])).toBe(
    true
  );
});

it('protects wakeups and one-shot schedules even after their expected fire time', () => {
  const schedules = [
    {
      type: 'tool_call',
      toolName: 'ScheduleWakeup',
      status: 'completed',
      recordedAtMs: 1,
      rawInput: { delaySeconds: 1 },
    },
    {
      type: 'tool_call',
      toolName: 'CronCreate',
      status: 'completed',
      toolCallId: 'old-cron',
      recordedAtMs: 1,
      rawInput: { cron: '0 0 * * *', recurring: false },
      rawOutput: 'id: old-job\nnextFireAt: 2000-01-01T00:00:00Z',
    },
  ];
  for (const schedule of schedules) {
    expect(hasBackgroundWorkFromHistory([{ items: [schedule] }])).toBe(true);
    expect(hasBackgroundWorkFromHistory([{ items: [{ ...schedule, status: 'failed' }] }])).toBe(
      false
    );
  }
});

it('keeps scheduled pending tasks protected regardless of historical timestamps', () => {
  expect(
    hasBackgroundWorkFromHistory([
      { items: [{ ...task('a', 'pending', 'scheduled'), startedAtEpochSeconds: 1 }] },
    ])
  ).toBe(true);
});
