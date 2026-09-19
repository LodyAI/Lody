// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  const render = (tasks: SubagentTask[]) =>
    act(() => root.render(createElement(SubagentTaskPanel, { tasks })));

  it('states background once in the header and drops per-row badges and status words', () => {
    render([
      task({ taskId: 'a', isBackgrounded: true, status: 'completed' }),
      task({ taskId: 'b', isBackgrounded: true, status: 'in_progress' }),
      task({ taskId: 'c', isBackgrounded: true, status: 'failed' }),
    ]);

    const text = container.textContent ?? '';
    expect(text).toContain('Waiting on 1 background task');
    expect(text).not.toMatch(/\bBackground\b/);
    expect(text).not.toMatch(/Done|Failed|Working…/);
  });

  it('keeps trailing text that carries information beyond the status icon', () => {
    render([
      task({ taskId: 'a', status: 'failed', error: 'exit code 1' }),
      task({ taskId: 'b', status: 'in_progress', lastToolName: 'Bash' }),
    ]);

    const text = container.textContent ?? '';
    expect(text).toContain('exit code 1');
    expect(text).toContain('Running Bash');
  });

  it('notes the background share when only some tasks are backgrounded', () => {
    render([
      task({ taskId: 'a', status: 'completed', isBackgrounded: true }),
      task({ taskId: 'b', status: 'completed' }),
    ]);

    expect(container.textContent).toContain('2 tasks · 1 in background');
  });
});
