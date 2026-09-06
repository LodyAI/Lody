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

it('ignores raw scheduling and generic tool calls rather than inferring scheduler state', () => {
  expect(
    hasBackgroundWorkFromHistory([
      {
        items: [
          { type: 'tool_call', toolName: 'CronCreate', status: 'completed' },
          { type: 'tool_call', toolName: 'ScheduleWakeup', status: 'completed' },
          { type: 'tool_call', status: 'in_progress' },
          null,
          { type: 'subagent_task' },
        ],
      },
    ])
  ).toBe(false);
});

it('keeps scheduled pending tasks protected regardless of historical timestamps', () => {
  expect(
    hasBackgroundWorkFromHistory([
      { items: [{ ...task('a', 'pending', 'scheduled'), startedAtEpochSeconds: 1 }] },
    ])
  ).toBe(true);
});
