import { describe, expect, it } from 'vitest';

import type { TaskSnapshot } from '@/lib/task-doc';
import { buildTaskIndexExportEntry, formatTaskMarkdown, sortTasksByCreatedAt } from './task-export';

const baseSnapshot = (overrides: Partial<TaskSnapshot> = {}): TaskSnapshot =>
  ({
    meta: {
      taskId: 'task-1',
      title: 'Ship the exporter',
      status: 'in_progress',
      ownerId: 'user-1',
      order: 'a0',
      createdAt: 10,
      updatedAt: 20,
    },
    body: 'Body line one.\n\nBody line two.',
    links: [],
    timeline: [],
    ...overrides,
  }) as TaskSnapshot;

describe('formatTaskMarkdown', () => {
  it('keeps the authored body verbatim', () => {
    const markdown = formatTaskMarkdown(baseSnapshot());

    // The body is already the authored source format, so an export must not
    // reflow or re-escape it.
    expect(markdown).toContain('Body line one.\n\nBody line two.');
    expect(markdown.startsWith('# Ship the exporter\n')).toBe(true);
    expect(markdown).toContain('- Status: in_progress');
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('renders comments but not activity entries', () => {
    const markdown = formatTaskMarkdown(
      baseSnapshot({
        timeline: [
          {
            id: 'c1',
            kind: 'comment',
            actorKind: 'human',
            actorName: 'Ada',
            createdAt: 30,
            body: 'Looks good to me.',
          },
          {
            id: 'a1',
            kind: 'activity',
            actorKind: 'human',
            actorId: 'user-1',
            createdAt: 31,
          },
        ],
      } as Partial<TaskSnapshot>)
    );

    expect(markdown).toContain('## Thread');
    expect(markdown).toContain('### Ada');
    expect(markdown).toContain('Looks good to me.');
    // Activity entries are bookkeeping, not thread content.
    expect(markdown).not.toContain('a1');
  });

  it('omits removed links', () => {
    const markdown = formatTaskMarkdown(
      baseSnapshot({
        links: [
          { kind: 'session', sessionId: 'session-live', origin: 'run', createdAt: 1 },
          { kind: 'session', sessionId: 'session-gone', createdAt: 1, removedAt: 2 },
        ],
      } as Partial<TaskSnapshot>)
    );

    expect(markdown).toContain('session-live');
    expect(markdown).not.toContain('session-gone');
  });

  it('states when a task has no description instead of emitting an empty section', () => {
    expect(formatTaskMarkdown(baseSnapshot({ body: '   ' }))).toContain('_No description._');
  });
});

describe('task export index', () => {
  it('orders tasks by creation time with a stable id tiebreak', () => {
    const later = baseSnapshot({ meta: { ...baseSnapshot().meta, taskId: 'b', createdAt: 5 } });
    const earlier = baseSnapshot({ meta: { ...baseSnapshot().meta, taskId: 'a', createdAt: 1 } });
    const tie = baseSnapshot({ meta: { ...baseSnapshot().meta, taskId: 'c', createdAt: 1 } });

    expect(sortTasksByCreatedAt([later, tie, earlier]).map((s) => s.meta.taskId)).toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('points each index entry at its exported directory', () => {
    expect(buildTaskIndexExportEntry(baseSnapshot())).toEqual({
      taskId: 'task-1',
      title: 'Ship the exporter',
      status: 'in_progress',
      createdAt: 10,
      updatedAt: 20,
      relativePath: 'tasks/task-1',
    });
  });
});
