import { describe, expect, it } from 'vitest';

import {
  HOME_NOW_RECENT_MS,
  buildHomeNow,
  homeNowReason,
  type HomeNowPr,
  type HomeNowRow,
} from '../src/lib/home-now';

import {
  HOME_NOW_LISTS,
  homeNowBlockHeight,
  layoutHomeNow,
  type HomeNowLayout,
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

  it('never moves a list to another column, whatever the others hold', () => {
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
              expect(columnOf(layout)).toEqual({ attention: 0, finished: 0, running: 1, next: 1 });
            }
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
