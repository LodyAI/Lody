// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { SubagentTaskPanel, type SubagentTask } from '../src/components/ai-gui/subagent-task-panel';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const task = (overrides: Partial<SubagentTask>): SubagentTask => ({
  type: 'subagent_task',
  taskId: overrides.taskId ?? 'task-1',
  status: 'completed',
  actor: 'Claude task',
  description: 'find skills',
  ...overrides,
});

describe('SubagentTaskPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (tasks: SubagentTask[], onCancel?: (taskId: string) => Promise<void>) =>
    act(() => root.render(createElement(SubagentTaskPanel, { tasks, onCancel })));

  const peek = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const rowNamed = (name: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

  it('states background once in the summary and gives each row the word its state needs', () => {
    render([
      task({
        taskId: 'a',
        isBackgrounded: true,
        status: 'completed',
        startedAtEpochSeconds: 100,
        endedAtEpochSeconds: 145,
      }),
      task({ taskId: 'b', isBackgrounded: true, status: 'in_progress', lastToolName: 'Bash' }),
      task({ taskId: 'c', isBackgrounded: true, status: 'failed', error: 'exit code 1' }),
    ]);

    const text = container.textContent ?? '';
    expect(text).toContain('Waiting on 1 background task');
    expect(text).not.toMatch(/\bBackground\b/);
    // Done says how long it took; running says what it is doing; failed says so.
    expect(text).toContain('45s');
    expect(text).toContain('Running Bash');
    expect(text).toContain('Failed');
    // The error itself is detail: it is in the peek, not on the row.
    expect(text).not.toContain('exit code 1');
  });

  it('notes the background share when only some tasks are backgrounded', () => {
    render([
      task({ taskId: 'a', status: 'completed', isBackgrounded: true }),
      task({ taskId: 'b', status: 'completed' }),
    ]);

    expect(container.textContent).toContain('2 tasks · 1 in background');
  });

  it('peeks at the full multi-line command of a background task from its row', async () => {
    const command = 'pnpm install\npnpm run build --filter @lody/components 2>&1';
    render([
      task({
        taskId: 'bash',
        actor: undefined,
        taskType: 'local_bash',
        isBackgrounded: true,
        status: 'completed',
        description: command,
        summary: command,
      }),
    ]);
    // The settled group folds; open it to reach the row.
    act(() => container.querySelector<HTMLButtonElement>('[aria-expanded]')?.click());
    expect(peek()).toBeNull();

    // The group's summary is the first button, the task's row the second.
    await act(async () => container.querySelectorAll<HTMLButtonElement>('button')[1]?.click());

    expect(peek()?.querySelector('pre')?.textContent).toBe(command);
    expect(peek()?.querySelector('pre')?.getAttribute('aria-label')).toBe('Command');
    expect(peek()?.textContent).toContain('Completed');
  });

  it("shows a failed task's error in its peek", async () => {
    render([task({ taskId: 'x', status: 'failed', error: 'exit code 1' })]);
    act(() => container.querySelector<HTMLButtonElement>('[aria-expanded]')?.click());

    await act(async () => rowNamed('Claude task · find skills')?.click());

    expect(peek()?.textContent).toContain('exit code 1');
  });

  it('cancels a running subagent from its peek', async () => {
    const onCancel = vi.fn(async () => undefined);
    render([task({ taskId: 'sub', taskKind: 'subagent', status: 'in_progress' })], onCancel);

    await act(async () => rowNamed('Claude task · find skills')?.click());
    const cancel = Array.from(peek()?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Cancel find skills'
    );
    await act(async () => cancel?.click());

    expect(onCancel).toHaveBeenCalledWith('sub');
  });
});
