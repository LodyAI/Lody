// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { SubagentTaskPanel, type SubagentTask } from '../src/components/ai-gui/subagent-task-panel';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Run = NonNullable<SubagentTask['run']>;
type RunItem = Run['items'][number];

const run = (
  state: Run['snapshot']['state'],
  items: RunItem[] = [],
  overrides: Partial<Run['snapshot']> = {},
  progress?: Run['progress']
): Run => ({
  sessionId: 'root-acp',
  snapshot: {
    state,
    support: {
      stream: ['text', 'thought', 'tool'],
      progress: true,
      outputRead: 'none',
      cancel: true,
    },
    ...overrides,
  },
  ...(progress ? { progress } : {}),
  items,
});

const toolStep = (toolCallId: string, title: string): RunItem => ({
  type: 'tool_call',
  toolCallId,
  title,
  status: 'in_progress',
});

/** Stands in for the conversation's renderers: one line per step, in order. */
const renderHistory = (subject: SubagentTask): ReactNode =>
  subject.run?.items.map((item, index) => (
    <p key={index} data-step="">
      {item.type === 'tool_call' ? item.title : 'text' in item ? item.text : item.type}
    </p>
  ));

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

  const render = (
    tasks: SubagentTask[],
    onCancel?: (taskId: string) => Promise<void>,
    runCancellation?: boolean
  ) =>
    act(() =>
      root.render(
        createElement(SubagentTaskPanel, { tasks, onCancel, runCancellation, renderHistory })
      )
    );
  const latestActions = () =>
    Array.from(container.querySelectorAll('[data-subagent-latest-action]')).map(
      (node) => node.textContent
    );
  const steps = () =>
    Array.from(peek()?.querySelectorAll('[data-step]') ?? []).map((node) => node.textContent);

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
      (button) => button.textContent === 'Stop task'
    );
    await act(async () => cancel?.click());

    expect(onCancel).toHaveBeenCalledWith('sub');
  });

  it("follows a streamed run's latest step on its row as steps arrive", () => {
    const first = toolStep('t1', 'Read `src/config.ts`');
    render([task({ taskId: 'r', status: 'in_progress', run: run('running', [first]) })]);
    expect(latestActions()).toEqual(['Read src/config.ts']);

    render([
      task({
        taskId: 'r',
        status: 'in_progress',
        run: run('running', [first, { type: 'text', text: 'Found it.\n\n## The config loader' }]),
      }),
    ]);
    expect(latestActions()).toEqual(['The config loader']);
  });

  it("falls back to a run's progress when it streams no steps, and keeps a legacy summary", () => {
    render([
      task({
        taskId: 'quiet',
        status: 'in_progress',
        run: run(
          'running',
          [],
          { support: { stream: [], progress: true, outputRead: 'none', cancel: false } },
          {
            lastToolName: 'Grep',
          }
        ),
      }),
      task({ taskId: 'legacy', status: 'in_progress', summary: 'Reading the lockfile' }),
    ]);
    expect(latestActions()).toEqual(['Running Grep', 'Reading the lockfile']);
  });

  it('opens every received step of a run in its dialog and keeps it current', async () => {
    const steps1 = [toolStep('t1', 'Read a.ts'), { type: 'thought', text: 'weighing' } as RunItem];
    render([task({ taskId: 'r', status: 'in_progress', run: run('running', steps1) })]);

    await act(async () => rowNamed('Claude task · find skills')?.click());
    expect(steps()).toEqual(['Read a.ts', 'weighing']);

    render([
      task({
        taskId: 'r',
        status: 'completed',
        summary: 'All done',
        run: run('completed', [...steps1, { type: 'text', text: 'All done' }]),
      }),
    ]);
    expect(steps()).toEqual(['Read a.ts', 'weighing', 'All done']);
    expect(peek()?.textContent).toContain('Completed');
  });

  it('says why a run has no steps and when some were lost', async () => {
    render([
      task({
        taskId: 'quiet',
        status: 'completed',
        run: run('completed', [], {
          support: { stream: [], progress: false, outputRead: 'none', cancel: false },
        }),
      }),
    ]);
    act(() => container.querySelector<HTMLButtonElement>('[aria-expanded]')?.click());
    await act(async () => rowNamed('Claude task · find skills')?.click());
    expect(peek()?.textContent).toContain('not its individual steps');

    act(() => root.unmount());
    root = createRoot(container);
    render([
      task({
        taskId: 'lossy',
        status: 'failed',
        run: run('failed', [toolStep('t1', 'Bash')], { outputIncomplete: true }),
      }),
    ]);
    act(() => container.querySelector<HTMLButtonElement>('[aria-expanded]')?.click());
    await act(async () => rowNamed('Claude task · find skills')?.click());
    expect(steps()).toEqual(['Bash']);
    expect(peek()?.textContent).toContain('Some steps of this run were not received.');
  });

  it('reads cancelled and unknown from the run, and never waits on an unknown run', () => {
    render([
      // The legacy status the shared mapping keeps for these two is not the truth.
      task({ taskId: 'c', status: 'failed', run: run('cancelled') }),
      task({ taskId: 'u', status: 'in_progress', run: run('unknown') }),
    ]);

    const text = container.textContent ?? '';
    expect(text).toContain('2 tasks');
    expect(text).not.toContain('Waiting');
    act(() => container.querySelector<HTMLButtonElement>('[aria-expanded]')?.click());
    expect(container.textContent).toContain('Cancelled');
    expect(container.textContent).toContain('Status unknown');
    expect(container.textContent).not.toContain('Failed');
  });

  it('offers Cancel on a run only when both the machine and the run can address it', async () => {
    const onCancel = vi.fn(async () => undefined);
    const running = task({
      taskId: 'r',
      taskKind: 'subagent',
      status: 'in_progress',
      run: run('running'),
    });
    const cancelButton = () =>
      Array.from(peek()?.querySelectorAll('button') ?? []).find(
        (button) => button.textContent === 'Stop task'
      );

    render([running], onCancel, false);
    await act(async () => rowNamed('Claude task · find skills')?.click());
    expect(cancelButton()).toBeUndefined();

    render([running], onCancel, true);
    expect(cancelButton()).toBeDefined();

    render(
      [
        {
          ...running,
          run: run('running', [], {
            support: { stream: [], progress: false, outputRead: 'none', cancel: false },
          }),
        },
      ],
      onCancel,
      true
    );
    expect(cancelButton()).toBeUndefined();
  });

  it('hangs a nested run under the run that started it', () => {
    render([
      task({ taskId: 'parent', description: 'parent', status: 'in_progress', run: run('running') }),
      task({
        taskId: 'sibling',
        description: 'sibling',
        status: 'in_progress',
        run: run('running'),
      }),
      task({
        taskId: 'child',
        description: 'child',
        parentTaskId: 'parent',
        status: 'in_progress',
        run: run('running', [], { parentRunId: 'parent' }),
      }),
      task({ taskId: 'orphan', description: 'orphan', parentTaskId: 'gone', status: 'completed' }),
    ]);
    const order = Array.from(container.querySelectorAll('[data-subagent-task-id]')).map((node) =>
      node.getAttribute('data-subagent-task-id')
    );
    expect(order).toEqual(['parent', 'child', 'sibling', 'orphan']);
  });
});
