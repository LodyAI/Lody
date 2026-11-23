import { describe, expect, test } from 'vitest';

import {
  buildOpenedBySessionTree,
  hasOpenedByTreeNesting,
  placeOpenedSessionsWithOpeners,
} from '../src/lib/session-opened-by-tree';

type Row = { id: string; openedBy?: string | null };

const accessors = {
  getId: (row: Row) => row.id,
  getOpenedBySessionId: (row: Row) => row.openedBy ?? null,
};

function build(rows: Row[], options: { collapsed?: string[]; maxRoots?: number } = {}) {
  const collapsed = new Set(options.collapsed ?? []);
  return buildOpenedBySessionTree(rows, {
    ...accessors,
    isCollapsed: (openerId) => collapsed.has(openerId),
    ...(options.maxRoots === undefined ? {} : { maxRoots: options.maxRoots }),
  });
}

/** `id@depth` — compact enough to assert whole layouts in one line. */
function layout(rows: Row[], options: Parameters<typeof build>[1] = {}): string[] {
  return build(rows, options).map((node) => `${node.id}@${node.depth}`);
}

describe('buildOpenedBySessionTree', () => {
  test('nests opened sessions directly under their opener, keeping input order', () => {
    const rows: Row[] = [
      { id: 'opener' },
      { id: 'other' },
      { id: 'opened-a', openedBy: 'opener' },
      { id: 'opened-b', openedBy: 'opener' },
    ];

    expect(layout(rows)).toEqual(['opener@0', 'opened-a@1', 'opened-b@1', 'other@0']);
  });

  test('collapsing an opener hides its opened sessions but keeps the opener row', () => {
    const rows: Row[] = [
      { id: 'opener' },
      { id: 'opened-a', openedBy: 'opener' },
      { id: 'opened-b', openedBy: 'opener' },
      { id: 'other' },
    ];

    expect(layout(rows, { collapsed: ['opener'] })).toEqual(['opener@0', 'other@0']);
    const [openerNode] = build(rows, { collapsed: ['opener'] });
    expect(openerNode?.expanded).toBe(false);
    expect(openerNode?.childCount).toBe(2);
  });

  test('orphan fallback: an opener missing from this list leaves a top-level row', () => {
    const rows: Row[] = [{ id: 'visible' }, { id: 'orphan', openedBy: 'archived-elsewhere' }];

    expect(layout(rows)).toEqual(['visible@0', 'orphan@0']);
    expect(hasOpenedByTreeNesting(build(rows))).toBe(false);
  });

  test('depth is capped at one: a grandchild attaches to the topmost visible opener', () => {
    const rows: Row[] = [{ id: 'a' }, { id: 'b', openedBy: 'a' }, { id: 'c', openedBy: 'b' }];

    expect(layout(rows)).toEqual(['a@0', 'b@1', 'c@1']);
    expect(build(rows)[0]?.childCount).toBe(2);
  });

  test('a self-reference degrades to a top-level row', () => {
    expect(layout([{ id: 'loop', openedBy: 'loop' }])).toEqual(['loop@0']);
  });

  test('a cycle degrades to top-level rows instead of hiding both sessions', () => {
    const rows: Row[] = [
      { id: 'a', openedBy: 'b' },
      { id: 'b', openedBy: 'a' },
    ];

    expect(layout(rows)).toEqual(['a@0', 'b@0']);
  });

  test('maxRoots caps TOP-LEVEL rows and never splits an opener from its children', () => {
    const rows: Row[] = [
      { id: 'r1' },
      { id: 'r1-opened', openedBy: 'r1' },
      { id: 'r2' },
      { id: 'r3' },
    ];

    expect(layout(rows, { maxRoots: 2 })).toEqual(['r1@0', 'r1-opened@1', 'r2@0']);
  });
});

type RankedRow = Row & { rank: number };

function buildRanked(rows: RankedRow[], maxRoots?: number) {
  return buildOpenedBySessionTree(rows, {
    getId: (row: RankedRow) => row.id,
    getOpenedBySessionId: (row: RankedRow) => row.openedBy ?? null,
    rootRank: (row: RankedRow) => row.rank,
    ...(maxRoots === undefined ? {} : { maxRoots }),
  }).map((node) => `${node.id}@${node.depth}`);
}

describe('buildOpenedBySessionTree rootRank', () => {
  test('ranks an opener by the freshest Session it opened', () => {
    // 'stale' was touched long ago but opened a very fresh Session; without the
    // group ranking that fresh row would sink below 'fresh-standalone'.
    const rows: RankedRow[] = [
      { id: 'fresh-standalone', rank: 50 },
      { id: 'stale', rank: 1 },
      { id: 'stale-opened', rank: 99, openedBy: 'stale' },
    ];

    expect(buildRanked(rows)).toEqual(['stale@0', 'stale-opened@1', 'fresh-standalone@0']);
  });

  test('maxRoots applies after ranking, so the freshest groups survive the preview', () => {
    const rows: RankedRow[] = [
      { id: 'low', rank: 1 },
      { id: 'mid', rank: 5 },
      { id: 'high-parent', rank: 2 },
      { id: 'high-opened', rank: 90, openedBy: 'high-parent' },
    ];

    expect(buildRanked(rows, 2)).toEqual(['high-parent@0', 'high-opened@1', 'mid@0']);
  });

  test('children keep their own order regardless of rank', () => {
    const rows: RankedRow[] = [
      { id: 'root', rank: 1 },
      { id: 'first', rank: 2, openedBy: 'root' },
      { id: 'second', rank: 80, openedBy: 'root' },
    ];

    expect(buildRanked(rows)).toEqual(['root@0', 'first@1', 'second@1']);
  });
});

describe('placeOpenedSessionsWithOpeners', () => {
  const place = (rows: Array<Row & { group: string }>) => {
    const openedBy = new Map(rows.map((row) => [row.id, row.openedBy ?? null]));
    const moved = placeOpenedSessionsWithOpeners(
      new Map(rows.map((row) => [row.id, row.group])),
      (id) => openedBy.get(id)
    );
    return Object.fromEntries(moved);
  };

  test('moves an opened Session into the group of its topmost rendered ancestor', () => {
    expect(
      place([
        { id: 'opener', group: 'local:m1:p1' },
        { id: 'chat', group: 'chats', openedBy: 'opener' },
        { id: 'repo', group: 'repo:o/r', openedBy: 'chat' },
        { id: 'sibling', group: 'local:m1:p1', openedBy: 'opener' },
        { id: 'plain', group: 'chats' },
      ])
    ).toEqual({ chat: 'local:m1:p1', repo: 'local:m1:p1' });
  });

  test('keeps rows whose opener is not rendered, or that form a cycle, in their own group', () => {
    expect(
      place([
        { id: 'orphan', group: 'chats', openedBy: 'pinned-or-archived' },
        { id: 'a', group: 'chats', openedBy: 'b' },
        { id: 'b', group: 'repo:o/r', openedBy: 'a' },
      ])
    ).toEqual({});
  });
});
