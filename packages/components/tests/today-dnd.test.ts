import { describe, expect, it } from 'vitest';
import { projectTodayDrop, type TodayDropRow } from '../src/components/today/today-dnd';

const INDENT = 20;
// a
//   a1
// b (collapsed, has children)
const rows: TodayDropRow[] = [
  { id: 'a', parentId: null, depth: 0, top: 0, bottom: 20, collapsed: false },
  { id: 'a1', parentId: 'a', depth: 1, top: 20, bottom: 40, collapsed: false },
  { id: 'b', parentId: null, depth: 0, top: 40, bottom: 60, collapsed: true },
];

describe('Today drop projection', () => {
  it('lands at the depth the pointer points to, between the rows it is between', () => {
    expect(projectTodayDrop(rows, { x: 25, y: 38 }, 0, INDENT, new Set())).toMatchObject({
      parentId: 'a',
      after: 'a1',
      depth: 1,
      lineTop: 40,
    });
    expect(projectTodayDrop(rows, { x: 0, y: 38 }, 0, INDENT, new Set())).toMatchObject({
      parentId: null,
      after: 'a',
      depth: 0,
    });
  });

  it('cannot go deeper than one level under the row above', () => {
    expect(projectTodayDrop(rows, { x: 200, y: 38 }, 0, INDENT, new Set())?.depth).toBe(2);
    expect(projectTodayDrop(rows, { x: 200, y: 38 }, 0, INDENT, new Set())).toMatchObject({
      parentId: 'a1',
      after: null,
    });
  });

  it('appends inside a folded row and asks to expand it', () => {
    expect(projectTodayDrop(rows, { x: 30, y: 70 }, 0, INDENT, new Set())).toMatchObject({
      parentId: 'b',
      after: 'end',
      expandParent: true,
    });
  });

  it('skips the dragged subtree so a node is never dropped into itself', () => {
    const drop = projectTodayDrop(rows, { x: 60, y: 38 }, 0, INDENT, new Set(['a', 'a1']));
    expect(drop).toMatchObject({ parentId: null, after: null, depth: 0 });
  });
});
