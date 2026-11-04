import { describe, expect, it } from 'vitest';

import {
  HOME_WEEK_DAYS,
  HOME_WEEK_WALL_ROWS,
  HOME_WEEK_WALL_WEEKS,
  buildHomeWeek,
  homeWeekDayKey,
  type HomeWeekInput,
  type HomeWeekRow,
} from '../src/lib/home-week';

// Friday 16 October 2026, local time. Every date is built from local parts, so the day a
// timestamp falls on does not depend on the machine's time zone.
const NOW = new Date(2026, 9, 16, 10, 0, 0);
const at = (daysBack: number, hour = 12): number =>
  new Date(2026, 9, 16 - daysBack, hour).getTime();

function row(overrides: Partial<HomeWeekRow> = {}): HomeWeekRow {
  return {
    createdAt: at(1),
    lastAt: at(1),
    add: 0,
    del: 0,
    mergedPrs: 0,
    cliType: 'builtin',
    agentType: 'claude',
    repo: null,
    ...overrides,
  };
}

const makeWeekInput = (rows: HomeWeekRow[], activeDays: string[] = []): HomeWeekInput => ({
  rows,
  activeDays,
});

describe('buildHomeWeek lines', () => {
  it('adds the lines of sessions last active in the seven days, and spreads them over their days', () => {
    const model = buildHomeWeek(
      makeWeekInput([
        row({ lastAt: at(0), add: 100, del: 20 }),
        row({ lastAt: at(0, 1), add: 10, del: 0 }),
        row({ lastAt: at(6), add: 5, del: 5 }),
        row({ lastAt: at(7), add: 999, del: 999 }),
      ]),
      NOW
    );
    expect(model.lines).toBe(140);
    expect(model.daily).toHaveLength(HOME_WEEK_DAYS);
    expect(model.daily[HOME_WEEK_DAYS - 1]).toBe(130);
    expect(model.daily[0]).toBe(10);
  });

  it('compares with the seven days before, and says nothing when there were none', () => {
    const rows = [
      row({ lastAt: at(1), add: 150, del: 0 }),
      row({ lastAt: at(8), add: 100, del: 0 }),
    ];
    expect(buildHomeWeek(makeWeekInput(rows), NOW).delta).toBe(50);
    expect(buildHomeWeek(makeWeekInput([rows[0]!]), NOW).delta).toBeNull();
    expect(
      buildHomeWeek(
        makeWeekInput([row({ lastAt: at(1), add: 50 }), row({ lastAt: at(9), add: 100 })]),
        NOW
      ).delta
    ).toBe(-50);
  });
});

describe('buildHomeWeek sessions', () => {
  it('counts sessions created in the window', () => {
    const model = buildHomeWeek(
      makeWeekInput([
        row({ createdAt: at(0, 9) }),
        row({ createdAt: at(2, 9) }),
        row({ createdAt: at(3, 23) }),
        row({ createdAt: at(8, 9) }),
      ]),
      NOW
    );
    expect(model.sessions).toBe(3);
  });
});

describe('buildHomeWeek repository', () => {
  it('names the repository most sessions were in, with its share of all sessions', () => {
    const model = buildHomeWeek(
      makeWeekInput([
        row({ repo: 'LodyAI/lody' }),
        row({ repo: 'LodyAI/lody' }),
        row({ repo: 'LodyAI/site-docs' }),
        row({ repo: null }),
      ]),
      NOW
    );
    expect(model.topRepo).toEqual({ repo: 'LodyAI/lody', count: 2, percent: 50 });
    expect(buildHomeWeek(makeWeekInput([row({ repo: null })]), NOW).topRepo).toBeNull();
  });
});

describe('buildHomeWeek in a quiet week', () => {
  it('counts a session created earlier that changed lines in the window', () => {
    const model = buildHomeWeek(
      makeWeekInput([row({ createdAt: at(30), lastAt: at(1), add: 5 })]),
      NOW
    );
    expect(model.lines).toBe(5);
    expect(model.sessions).toBe(0);
  });
});

describe('the activity wall', () => {
  // NOW is a Friday, so the last week runs Monday to Friday and has all five workdays.
  const wallOf = (input: Partial<HomeWeekInput>) =>
    buildHomeWeek({ rows: [], activeDays: [], ...input }, NOW).wall;
  const key = (daysBack: number) => homeWeekDayKey(at(daysBack));

  it('is a run of weeks of workdays from Monday, the last of which stops at today', () => {
    const wall = wallOf({});
    expect(wall).toHaveLength(HOME_WEEK_WALL_WEEKS);
    expect(wall.slice(0, -1).every((week) => week.length === HOME_WEEK_WALL_ROWS)).toBe(true);
    expect(wall.at(-1)).toHaveLength(5);
    // Earlier in the week the last column is shorter: Wednesday has three days.
    const wednesday = buildHomeWeek({ rows: [], activeDays: [] }, new Date(2026, 9, 14, 10));
    expect(wednesday.wall.at(-1)).toHaveLength(3);
  });

  it('leaves weekends off the wall, and still ends on Friday when today is a weekend', () => {
    // Saturday 10 October: nothing to draw, so the busiest day is none and every cell is empty.
    const wall = wallOf({ activeDays: [key(6)] });
    expect(wall.flat().every((cell) => cell.level === 0)).toBe(true);
    const sunday = buildHomeWeek({ rows: [], activeDays: [] }, new Date(2026, 9, 18, 10));
    expect(sunday.wall.at(-1)).toHaveLength(HOME_WEEK_WALL_ROWS);
  });
});
