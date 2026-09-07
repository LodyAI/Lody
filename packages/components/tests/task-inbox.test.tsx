// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskIndexRow } from '@lody/shared';
import { userAtom } from '../src/atoms';
import { taskIndexRowsAtom, taskInboxAtom, taskThreadReadAtAtom } from '../src/atoms/tasks';
import { TaskInboxPanel } from '../src/components/tasks/task-inbox-panel';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ME = 'user_me';
const OTHER = 'user_other';

// Typed as the real row so a wrong field name is a compile error rather than a
// test that quietly asserts nothing — `deleted` vs `deletedAt` was exactly that
// mistake when this file was written.
function row(overrides: {
  taskId: string;
  order: string;
  lastCommentAt?: number;
  mentionedUserIds?: string[];
  deletedAt?: number;
}): TaskIndexRow {
  return {
    taskId: overrides.taskId,
    title: `Task ${overrides.taskId}`,
    status: 'backlog' as const,
    ownerId: ME,
    order: overrides.order,
    createdAt: 1,
    updatedAt: 1,
    ...(overrides.lastCommentAt !== undefined ? { lastCommentAt: overrides.lastCommentAt } : {}),
    ...(overrides.mentionedUserIds ? { mentionedUserIds: overrides.mentionedUserIds } : {}),
    ...(overrides.deletedAt !== undefined ? { deletedAt: overrides.deletedAt } : {}),
  } as TaskIndexRow;
}

function storeWith(rows: TaskIndexRow[], readAt: Record<string, number> = {}) {
  const store = createStore();
  store.set(userAtom, { id: ME, name: 'Me', email: 'me@example.com', image: null } as never);
  store.set(taskIndexRowsAtom, Object.fromEntries(rows.map((r) => [r.taskId, r])));
  store.set(taskThreadReadAtAtom, readAt);
  return store;
}

describe('taskInboxAtom', () => {
  it('collects only unread mentions of me', () => {
    const store = storeWith([
      row({ taskId: 'a', order: 'a0', lastCommentAt: 100, mentionedUserIds: [ME] }),
      // mentions someone else
      row({ taskId: 'b', order: 'a1', lastCommentAt: 100, mentionedUserIds: [OTHER] }),
      // a comment, but nobody mentioned
      row({ taskId: 'c', order: 'a2', lastCommentAt: 100 }),
      // no comments at all
      row({ taskId: 'd', order: 'a3', mentionedUserIds: [ME] }),
    ]);

    expect(store.get(taskInboxAtom).map((task) => task.taskId)).toEqual(['a']);
  });

  it('drops a mention once the thread has been read past it', () => {
    const rows = [row({ taskId: 'a', order: 'a0', lastCommentAt: 100, mentionedUserIds: [ME] })];

    expect(store_get(storeWith(rows, { a: 99 }))).toEqual(['a']);
    // Read position at or after the comment clears it.
    expect(store_get(storeWith(rows, { a: 100 }))).toEqual([]);
    expect(store_get(storeWith(rows, { a: 101 }))).toEqual([]);
  });

  it('orders newest mention first, regardless of manual task order', () => {
    const store = storeWith([
      row({ taskId: 'old', order: 'a0', lastCommentAt: 100, mentionedUserIds: [ME] }),
      row({ taskId: 'new', order: 'a1', lastCommentAt: 300, mentionedUserIds: [ME] }),
      row({ taskId: 'mid', order: 'a2', lastCommentAt: 200, mentionedUserIds: [ME] }),
    ]);

    expect(store.get(taskInboxAtom).map((task) => task.taskId)).toEqual(['new', 'mid', 'old']);
  });

  it('excludes deleted tasks', () => {
    const store = storeWith([
      row({ taskId: 'a', order: 'a0', lastCommentAt: 100, mentionedUserIds: [ME], deletedAt: 5 }),
    ]);
    expect(store.get(taskInboxAtom)).toEqual([]);
  });

  it('is empty when signed out rather than showing everyone else s mentions', () => {
    const store = storeWith([
      row({ taskId: 'a', order: 'a0', lastCommentAt: 100, mentionedUserIds: [ME] }),
    ]);
    store.set(userAtom, null);
    expect(store.get(taskInboxAtom)).toEqual([]);
  });
});

function store_get(store: ReturnType<typeof storeWith>): string[] {
  return store.get(taskInboxAtom).map((task) => task.taskId);
}

describe('TaskInboxPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    localStorage.clear();
    await initI18n('en');
    Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (node: React.ReactNode) => {
    act(() => {
      root.render(<Provider store={createStore()}>{node}</Provider>);
    });
  };

  it('renders nothing at all when there is nothing unread', () => {
    render(<TaskInboxPanel items={[]} onOpenTask={vi.fn()} />);
    // Not "an empty panel" — no panel. An always-present empty inbox is noise.
    expect(container.textContent).toBe('');
    expect(container.querySelector('section')).toBeNull();
  });

  it('opens the task it was clicked on', () => {
    const onOpenTask = vi.fn();
    render(
      <TaskInboxPanel
        items={[{ taskId: 'task_42', title: 'Review the plan', lastCommentAt: 1 }]}
        onOpenTask={onOpenTask}
      />
    );

    const button = container.querySelector('button');
    act(() => button?.click());

    expect(onOpenTask).toHaveBeenCalledWith('task_42');
  });

  it('still shows a readable row for a task with no title', () => {
    render(<TaskInboxPanel items={[{ taskId: 'task_1', title: '   ' }]} onOpenTask={vi.fn()} />);
    expect(container.textContent).toContain('Untitled task');
  });

  it('moves focus between inbox rows with the shared list navigation', () => {
    render(
      <TaskInboxPanel
        items={[
          { taskId: 'task_1', title: 'First' },
          { taskId: 'task_2', title: 'Second' },
        ]}
        onOpenTask={vi.fn()}
      />
    );
    const first = container.querySelector<HTMLElement>('[data-id="task-inbox:task_1"]')!;
    const second = container.querySelector<HTMLElement>('[data-id="task-inbox:task_2"]')!;

    act(() => first.focus());
    act(() => {
      first.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' })
      );
    });

    expect(document.activeElement).toBe(second);
  });
});
