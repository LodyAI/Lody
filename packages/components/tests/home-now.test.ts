import { describe, expect, it } from 'vitest';

import {
  HOME_NOW_RECENT_MS,
  buildHomeNow,
  homeNowInputEqual,
  homeNowReason,
  type HomeNowPr,
  type HomeNowRow,
} from '../src/lib/home-now';
import { parseHomeBoard, serializeHomeBoard } from '../src/lib/home-board';
import {
  HOME_NOW_ARRANGEMENTS,
  HOME_NOW_COLUMN,
  HOME_NOW_LISTS,
  HOME_NOW_ROW_BUDGET,
  HOME_NOW_ROW_CAP,
  HOME_NOW_SWITCH_MARGIN,
  HOME_NOW_TALLEST_COLUMN,
  allocateHomeNowRows,
  homeNowBlockHeight,
  layoutHomeNow,
  solveHomeNowColumn,
  type HomeNowColumn,
  type HomeNowLayout,
  type HomeNowTotals,
} from '../src/lib/home-now-layout';

const NOW = new Date(2026, 9, 16, 10, 0, 0).getTime();
const MINUTE = 60_000;

function row(id: string, overrides: Partial<HomeNowRow> = {}): HomeNowRow {
  return {
    id,
    title: id,
    cliType: 'builtin',
    agentType: 'claude',
    lastAt: NOW - 10 * MINUTE,
    working: false,
    waiting: false,
    unread: false,
    pr: null,
    ...overrides,
  };
}

const pr = (status: HomeNowPr['status'], ci: HomeNowPr['ci'] = null, ready = false): HomeNowPr => ({
  number: 812,
  status,
  ci,
  ready,
});

const ids = (list: { items: { id: string }[] }) => list.items.map((item) => item.id);

describe('why a session is on the page', () => {
  it('asks the person only when an agent waits on them, before anything else', () => {
    expect(
      homeNowReason(row('a', { waiting: true, working: true, pr: pr('open', 'fail') }), NOW)
    ).toBe('waiting');
  });

  it('leaves a running agent alone even when its CI is red: it may be fixing it', () => {
    expect(homeNowReason(row('a', { working: true, pr: pr('open', 'fail') }), NOW)).toBe('working');
    expect(homeNowReason(row('a', { pr: pr('open', 'fail') }), NOW)).toBe('ciFailed');
  });

  it('puts a failed check ahead of unread output, and unread ahead of a draft', () => {
    expect(homeNowReason(row('a', { unread: true, pr: pr('draft', 'fail') }), NOW)).toBe(
      'ciFailed'
    );
    expect(homeNowReason(row('a', { unread: true, pr: pr('draft', 'pass') }), NOW)).toBe(
      'finished'
    );
    expect(homeNowReason(row('a', { pr: pr('draft', 'pass') }), NOW)).toBe('draft');
  });

  it('tells a pull request ready to merge from one still in review', () => {
    expect(homeNowReason(row('a', { pr: pr('open', 'pass', true) }), NOW)).toBe('readyToMerge');
    expect(homeNowReason(row('a', { pr: pr('open', 'pending') }), NOW)).toBe('openPr');
  });

  it('drops what is done, and quiet sessions once they are old', () => {
    expect(homeNowReason(row('a', { pr: pr('merged', 'pass') }), NOW)).toBeNull();
    expect(homeNowReason(row('a', { pr: pr('closed') }), NOW)).toBeNull();
    expect(homeNowReason(row('a', { lastAt: NOW - HOME_NOW_RECENT_MS }), NOW)).toBe('recent');
    expect(homeNowReason(row('a', { lastAt: NOW - HOME_NOW_RECENT_MS - 1 }), NOW)).toBeNull();
  });
});

describe('the four lists', () => {
  it('puts every session in exactly one list, ordered by reason and then by recency', () => {
    const model = buildHomeNow(
      {
        rows: [
          row('draft', { pr: pr('draft'), lastAt: NOW - MINUTE }),
          row('ci', { pr: pr('open', 'fail'), lastAt: NOW - 5 * MINUTE }),
          row('waiting-old', { waiting: true, lastAt: NOW - 50 * MINUTE }),
          row('waiting-new', { waiting: true, lastAt: NOW - 2 * MINUTE }),
          row('running', { working: true }),
          row('done', { unread: true }),
          row('ready', { pr: pr('open', 'pass', true), lastAt: NOW - 90 * MINUTE }),
          row('recent', { lastAt: NOW - 3 * MINUTE }),
        ],
      },
      NOW
    );
    expect(ids(model.attention)).toEqual(['waiting-new', 'waiting-old', 'ci', 'draft']);
    expect(ids(model.running)).toEqual(['running']);
    expect(ids(model.finished)).toEqual(['done']);
    // A pull request ready to merge comes before a session that was merely active more recently.
    expect(ids(model.next)).toEqual(['ready', 'recent']);
    expect(model.attention.items[2]).toMatchObject({ reason: 'ciFailed', prNumber: 812 });
  });

  it("keeps a whole long list, newest first; how much shows is the layout's call", () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      row(`run-${index}`, { working: true, lastAt: NOW - (6 - index) * MINUTE })
    );
    const model = buildHomeNow({ rows }, NOW);
    expect(model.running.total).toBe(7);
    expect(ids(model.running)).toEqual([
      'run-6',
      'run-5',
      'run-4',
      'run-3',
      'run-2',
      'run-1',
      'run-0',
    ]);
  });

  it('is four empty lists when nothing is going on', () => {
    const model = buildHomeNow({ rows: [] }, NOW);
    expect([model.attention, model.running, model.finished, model.next]).toEqual(
      Array.from({ length: 4 }, () => ({ items: [], total: 0 }))
    );
  });

  it('compares inputs by what the page shows', () => {
    const left = { rows: [row('a', { pr: pr('open', 'pass') })] };
    expect(homeNowInputEqual(left, { rows: [row('a', { pr: pr('open', 'pass') })] })).toBe(true);
    expect(homeNowInputEqual(left, { rows: [row('a', { pr: pr('open', 'fail') })] })).toBe(false);
    expect(homeNowInputEqual(left, { rows: [row('a', { working: true })] })).toBe(false);
  });
});

describe('the remembered board', () => {
  it('opens folded the first time, keeps a fold, and ignores what it does not know', () => {
    expect(parseHomeBoard(null)).toBeNull();
    expect(parseHomeBoard('week')).toBe('week');
    expect(parseHomeBoard(serializeHomeBoard(null))).toBeNull();
    expect(parseHomeBoard('mission-control')).toBe('now');
  });
});

describe("spending the board's height", () => {
  const totals = (attention: number, running: number, finished: number, next: number) => ({
    attention,
    running,
    finished,
    next,
  });
  const shape = (layout: HomeNowLayout) =>
    layout.columns.map((column) =>
      column.map((block) => (block.kind === 'list' ? `${block.key}:${block.shown}` : block.kind))
    );

  it('shows everything when it fits', () => {
    expect(allocateHomeNowRows(totals(2, 1, 1, 3))).toEqual(totals(2, 1, 1, 3));
  });

  it('gives way from the bottom when every list is long, never on what needs you', () => {
    // One row each first, then by priority up to each cap, within the budget of twelve.
    expect(allocateHomeNowRows(totals(30, 10, 8, 6))).toEqual(totals(6, 4, 1, 1));
  });

  it('never goes over the budget or a cap, and never hides a list that has something', () => {
    const sizes = [0, 1, 2, 3, 5, 9, 40];
    for (const a of sizes)
      for (const r of sizes)
        for (const f of sizes)
          for (const n of sizes) {
            const given: HomeNowTotals = totals(a, r, f, n);
            const shown = allocateHomeNowRows(given);
            const sum = HOME_NOW_LISTS.reduce((total, key) => total + shown[key], 0);
            expect(sum).toBeLessThanOrEqual(HOME_NOW_ROW_BUDGET);
            for (const key of HOME_NOW_LISTS) {
              expect(shown[key]).toBeLessThanOrEqual(Math.min(given[key], HOME_NOW_ROW_CAP[key]));
              expect(shown[key] > 0).toBe(given[key] > 0);
            }
          }
  });

  it('keeps every list in its own place, the columns level', () => {
    // Needs you over running over just finished on the left, the usage over worth continuing on
    // the right: the reached cap (running's four rows at this budget) and the fixed usage card
    // are what the other column levels against, so the left ends on the right's line.
    expect(shape(layoutHomeNow(totals(30, 10, 8, 6), true))).toEqual([
      ['attention:6', 'running:4', 'finished:1'],
      ['usage', 'next:6'],
    ]);
    // A list with nothing keeps its place as its title.
    expect(shape(layoutHomeNow(totals(1, 1, 0, 0), true))).toEqual([
      ['attention:1', 'running:1', 'finished:0'],
      ['usage', 'next:0'],
    ]);
  });

  it('draws the arrangement it is given, whatever the others hold', () => {
    expect(HOME_NOW_COLUMN).toEqual({ attention: 0, running: 0, finished: 0, next: 1 });
    const sizes = [0, 1, 3, 9, 40];
    const columnOf = (layout: ReturnType<typeof layoutHomeNow>) =>
      Object.fromEntries(
        layout.columns.flatMap((column, index) =>
          column.flatMap((block) => (block.kind === 'list' ? [[block.key, index]] : []))
        )
      );
    for (const hasUsage of [false, true])
      for (const a of sizes)
        for (const r of sizes)
          for (const f of sizes)
            for (const n of sizes) {
              const layout = layoutHomeNow(totals(a, r, f, n), hasUsage);
              // Nothing at all happening is the one case with no lists at all: the board
              // says so in a single card instead.
              if (a + r + f + n === 0) {
                expect(columnOf(layout)).toEqual({});
                continue;
              }
              expect(columnOf(layout)).toEqual(HOME_NOW_COLUMN);
            }
  });

  it('places the lists so the board levels against a ruler, the best of the eight', () => {
    // The state the page sits in: nothing waiting on the person, worth continuing over its cap
    // (so its tile is a fixed 2 + 3 + 1 rows, no matter what the backlog holds). With the usage
    // card beside it, that column is ten rows — and needs you, running and just finished, none of
    // them capped here, are all on the other side to be levelled against it one row at a time.
    const family: HomeNowTotals[] = [];
    for (let running = 0; running <= HOME_NOW_ROW_CAP.running + 1; running += 1)
      for (let finished = 0; finished <= HOME_NOW_ROW_CAP.finished + 1; finished += 1)
        for (let next = HOME_NOW_ROW_CAP.next + 1; next <= HOME_NOW_ROW_CAP.next + 5; next += 1)
          family.push(totals(0, running, finished, next));
    const gapIn = (arrangement: HomeNowColumn) => {
      const heights = family.map((given) =>
        layoutHomeNow(given, true, Infinity, arrangement).columns.map((column) =>
          column.reduce((sum, block) => sum + homeNowBlockHeight(block, given), 0)
        )
      );
      const gaps = heights.map(([left, right]) => Math.abs(left! - right!));
      return {
        mean: gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length,
        worst: Math.max(...gaps),
        ruler: new Set(heights.filter(([left]) => left! <= 10).map(([, right]) => right)),
      };
    };

    const chosen = gapIn(HOME_NOW_COLUMN);
    expect(chosen.ruler).toEqual(new Set([10]));
    expect(chosen.worst).toBe(5);
    expect(chosen.mean).toBeLessThan(1.2);

    // The other seven anchored arrangements, each measured the same way: none is even close.
    const free = ['running', 'finished', 'next'] as const;
    for (let mask = 0; mask < 8; mask += 1) {
      const arrangement: Record<string, 0 | 1> = { attention: 0 };
      free.forEach((key, index) => {
        arrangement[key] = ((mask >> index) & 1) as 0 | 1;
      });
      const same = free.every((key) => arrangement[key] === HOME_NOW_COLUMN[key]);
      if (same) continue;
      expect(gapIn(arrangement as HomeNowColumn).mean).toBeGreaterThan(chosen.mean + 1);
    }
  });

  it('speaks with the arrangement it had unless another is two rows more level', () => {
    const gapOf = (given: HomeNowTotals, column: HomeNowColumn) =>
      Math.abs(
        layoutHomeNow(given, true, Infinity, column)
          .columns.map((columnBlocks) =>
            columnBlocks.reduce((sum, block) => sum + homeNowBlockHeight(block, given), 0)
          )
          .reduce((left, right) => left - right)
      );

    // Running joining needs you on the left would leave one row less than the arrangement on
    // show: one row is rounding, not a reason for a tile to change sides.
    const nearly = totals(2, 5, 0, 5);
    expect(gapOf(nearly, HOME_NOW_COLUMN)).toBe(2);
    expect(gapOf(nearly, { attention: 0, running: 0, finished: 1, next: 1 })).toBe(1);
    expect(solveHomeNowColumn(nearly, true, Infinity, HOME_NOW_COLUMN)).toEqual(HOME_NOW_COLUMN);

    // The day the arrangement was never meant for: thirteen waiting and six just finished, one
    // worth continuing. Every list but the anchors on the left leaves ten rows; running joining
    // needs you on the left leaves none.
    const mirror = totals(10, 0, 6, 1);
    expect(gapOf(mirror, HOME_NOW_COLUMN)).toBe(10);
    expect(solveHomeNowColumn(mirror, true, Infinity, HOME_NOW_COLUMN)).toEqual({
      attention: 0,
      running: 0,
      finished: 1,
      next: 1,
    });
    expect(gapOf(mirror, { attention: 0, running: 0, finished: 1, next: 1 })).toBe(0);

    // And back again when the day turns: from the mirror's arrangement, a backlog and a couple of
    // running sessions put the level one back.
    const back = totals(0, 3, 1, 10);
    expect(
      solveHomeNowColumn(back, true, Infinity, { attention: 0, running: 0, finished: 1, next: 1 })
    ).toEqual(HOME_NOW_COLUMN);
  });

  it('never leaves more than the margin above the best arrangement of that state', () => {
    for (const a of [0, 1, 4, 7])
      for (const r of [0, 1, 3, 5])
        for (const f of [0, 1, 3, 4])
          for (const n of [0, 1, 4, 8]) {
            const given = totals(a, r, f, n);
            const gapIn = (column: HomeNowColumn) =>
              Math.abs(
                layoutHomeNow(given, true, Infinity, column)
                  .columns.map((blocks) =>
                    blocks.reduce((sum, block) => sum + homeNowBlockHeight(block, given), 0)
                  )
                  .reduce((left, right) => left - right)
              );
            const best = Math.min(...HOME_NOW_ARRANGEMENTS.map(gapIn));
            for (const previous of HOME_NOW_ARRANGEMENTS) {
              const solved = solveHomeNowColumn(given, true, Infinity, previous);
              expect(HOME_NOW_ARRANGEMENTS).toContainEqual(solved);
              expect(gapIn(solved)).toBeLessThanOrEqual(best + HOME_NOW_SWITCH_MARGIN);
            }
          }
  });

  it('keeps the tallest column any lists can make for the board', () => {
    // Needs you in one column and the usage in the other, at their tallest: the columns never
    // pass this, whatever the lists hold.
    expect(HOME_NOW_TALLEST_COLUMN).toBe(21);
    for (const hasUsage of [false, true])
      for (const a of [0, 1, 6, 40])
        for (const r of [0, 1, 4, 40])
          for (const f of [0, 1, 3, 40])
            for (const n of [0, 1, 3, 40])
              for (const column of layoutHomeNow(totals(a, r, f, n), hasUsage).columns) {
                const height = column.reduce(
                  (sum, block) => sum + homeNowBlockHeight(block, totals(a, r, f, n)),
                  0
                );
                expect(height).toBeLessThanOrEqual(HOME_NOW_TALLEST_COLUMN);
              }
  });

  it('gives way to a short window, lower lists first, and says when one row each is tall', () => {
    // Twelve rows per column: the budget shrinks until the taller column fits.
    const short = layoutHomeNow(totals(30, 10, 8, 6), true, 12);
    expect(short.fits).toBe(true);
    expect(shape(short)).toEqual([
      ['attention:1', 'running:1', 'finished:1'],
      ['usage', 'next:6'],
    ]);
    // One row each, with its "Show all", is twelve tall in the left column; eleven has no room.
    expect(layoutHomeNow(totals(30, 10, 8, 6), true, 11).fits).toBe(false);
    expect(layoutHomeNow(totals(30, 10, 8, 6), true).fits).toBe(true);
  });

  it('fits every column within the room it is given, and never hides a list to do it', () => {
    const sizes = [0, 1, 3, 9, 40];
    for (const maxRows of [4, 8, 12, 16, 24])
      for (const a of sizes)
        for (const r of sizes)
          for (const f of sizes)
            for (const n of sizes) {
              const given = totals(a, r, f, n);
              const layout = layoutHomeNow(given, true, maxRows);
              const blocks = layout.columns.flat();
              for (const key of HOME_NOW_LISTS) {
                const block = blocks.find((item) => item.kind === 'list' && item.key === key);
                expect(block?.kind === 'list' && block.shown > 0).toBe(given[key] > 0);
                if (block?.kind === 'list') expect(block.shown).toBeLessThanOrEqual(given[key]);
              }
              if (!layout.fits) continue;
              for (const column of layout.columns) {
                const height = column.reduce(
                  (sum, block) => sum + homeNowBlockHeight(block, given),
                  0
                );
                expect(height).toBeLessThanOrEqual(maxRows);
              }
            }
  });

  it('says so in one card when nothing is going on', () => {
    // Every list empty: one statement stays beside the usage instead of four empty list tiles.
    expect(shape(layoutHomeNow(totals(0, 0, 0, 0), true))).toEqual([['quiet'], ['usage']]);
    expect(shape(layoutHomeNow(totals(0, 0, 0, 0), false))).toEqual([['quiet']]);
  });
});
