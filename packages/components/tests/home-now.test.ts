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
  HOME_NOW_LISTS,
  HOME_NOW_ROW_BUDGET,
  HOME_NOW_ROW_CAP,
  allocateHomeNowRows,
  homeNowBlockHeight,
  layoutHomeNow,
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

  it('keeps the two columns level instead of pairing a long list with a short one', () => {
    // Needs you (9 tall with its "Show all") on the left; usage (4) then running (7) on the right;
    // the short lists then go to whichever side is lower. The left ends two rows short (13 of
    // 15), so just finished shows two more of its own rows rather than leaving a band.
    expect(shape(layoutHomeNow(totals(30, 10, 8, 6), true))).toEqual([
      ['attention:6', 'finished:3'],
      ['usage', 'running:4', 'next:1'],
    ]);
    expect(shape(layoutHomeNow(totals(1, 1, 0, 0), true))).toEqual([
      ['attention:1', 'running:1'],
      ['usage'],
    ]);
  });

  it('lets a lone list take the whole board, and two lists share it', () => {
    expect(shape(layoutHomeNow(totals(0, 0, 0, 12), false))).toEqual([['next:3']]);
    expect(shape(layoutHomeNow(totals(20, 0, 0, 1), false))).toEqual([['attention:6'], ['next:1']]);
  });

  it('gives way to a short window, lower lists first, and says when one row each is too tall', () => {
    // Twelve rows per column: the budget shrinks until the taller column fits.
    const short = layoutHomeNow(totals(30, 10, 8, 6), true, 12);
    expect(short.fits).toBe(true);
    expect(shape(short)).toEqual([
      ['attention:5', 'finished:1'],
      ['usage', 'running:1', 'next:1'],
    ]);
    // One row each is twelve tall too; eleven has no room for it.
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
                expect(block != null).toBe(given[key] > 0);
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

  it('is one calm tile when nothing is going on', () => {
    expect(shape(layoutHomeNow(totals(0, 0, 0, 0), true))).toEqual([['quiet'], ['usage']]);
    expect(shape(layoutHomeNow(totals(0, 0, 0, 0), false))).toEqual([['quiet']]);
  });
});
