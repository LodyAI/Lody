import { describe, expect, it } from 'vitest';

import {
  HOME_WEEK_DAYS,
  HOME_WEEK_WALL_ROWS,
  HOME_WEEK_WALL_WEEKS,
  buildHomeWeek,
  homeWeekDayKey,
  homeWeekInputEqual,
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

  it('counts a merged pull request with the session it belongs to', () => {
    const model = buildHomeWeek(
      makeWeekInput([row({ mergedPrs: 2 }), row({ lastAt: at(10), mergedPrs: 5 })]),
      NOW
    );
    expect(model.mergedPrs).toBe(2);
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

  it('names the two agents that did most of the work, most first', () => {
    const model = buildHomeWeek(
      makeWeekInput([
        row({ agentType: 'codex' }),
        row({ agentType: 'claude' }),
        row({ agentType: 'claude' }),
        row({ agentType: 'gemini' }),
      ]),
      NOW
    );
    expect(model.agents.map((agent) => [agent.agentType, agent.count])).toEqual([
      ['claude', 2],
      ['codex', 1],
    ]);
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

  it('breaks a repository tie alphabetically', () => {
    const model = buildHomeWeek(
      makeWeekInput([row({ repo: 'b/zeta' }), row({ repo: 'a/alpha' })]),
      NOW
    );
    expect(model.topRepo?.repo).toBe('a/alpha');
  });
});

describe('buildHomeWeek in a quiet week', () => {
  it('is all zeros, with nothing to compare', () => {
    const model = buildHomeWeek(
      makeWeekInput([row({ createdAt: at(20), lastAt: at(20), add: 50 })]),
      NOW
    );
    expect(model).toMatchObject({
      lines: 0,
      delta: null,
      mergedPrs: 0,
      sessions: 0,
      agents: [],
      topRepo: null,
    });
    expect(model.daily).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('counts a session created earlier that changed lines in the window', () => {
    const model = buildHomeWeek(
      makeWeekInput([row({ createdAt: at(30), lastAt: at(1), add: 5 })]),
      NOW
    );
    expect(model.lines).toBe(5);
    expect(model.sessions).toBe(0);
  });
});

describe('homeWeekInputEqual', () => {
  it('compares by value', () => {
    expect(homeWeekInputEqual(makeWeekInput([row()], ['a']), makeWeekInput([row()], ['a']))).toBe(
      true
    );
    expect(homeWeekInputEqual(makeWeekInput([row()]), makeWeekInput([row({ add: 1 })]))).toBe(
      false
    );
    expect(homeWeekInputEqual(makeWeekInput([], ['a']), makeWeekInput([], ['b']))).toBe(false);
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

  it('places a day by its week and weekday', () => {
    const wall = wallOf({ activeDays: [key(0), key(4), key(7)] });
    // Today (Friday) is the last cell; four days back is Monday of the same week.
    expect(wall.at(-1)![4]!.level).toBeGreaterThan(0);
    expect(wall.at(-1)![0]!.level).toBeGreaterThan(0);
    // A week back is the Friday of the week before.
    expect(wall.at(-2)![4]!.level).toBeGreaterThan(0);
    expect(wall.at(-1)![1]!.level).toBe(0);
  });

  it('shades by how much happened, against the busiest day', () => {
    const wall = wallOf({
      activeDays: [key(0), key(1), key(2), key(3)],
      activity: [
        [key(3), 1],
        [key(2), 4],
        [key(1), 6],
        [key(0), 8],
      ],
    });
    const last = wall.at(-1)!;
    // Today is Friday (index 4); Thursday is 3, Wednesday 2, Tuesday 1.
    expect([last[1], last[2], last[3], last[4]].map((cell) => cell!.level)).toEqual([1, 2, 3, 4]);
  });

  it('counts each active day once when no counts are given', () => {
    const wall = wallOf({ activeDays: [key(0), key(2)] });
    const last = wall.at(-1)!;
    expect([last[2], last[4]].map((cell) => cell!.level)).toEqual([4, 4]);
    expect(last[3]!.level).toBe(0);
  });

  it("names every cell by its local day and carries the day's event count", () => {
    const wall = wallOf({ activeDays: [key(0), key(2)], activity: [[key(0), 8]] });
    const last = wall.at(-1)!;
    // Today is Friday: the cells run Monday to Friday, each named by its own date.
    expect(last.map((cell) => cell.day)).toEqual([key(4), key(3), key(2), key(1), key(0)]);
    expect(last[4]).toMatchObject({ day: key(0), count: 8 });
    // A day with no counts given counts once; a quiet one is zero.
    expect(last[2]).toMatchObject({ day: key(2), count: 1 });
    expect(last[3]!.count).toBe(0);
  });

  it('is all empty for a quiet history, never dividing by zero', () => {
    expect(
      wallOf({})
        .flat()
        .every((cell) => cell.level === 0)
    ).toBe(true);
  });

  it('is compared by value, counts included', () => {
    const base = { rows: [], activeDays: ['a'] };
    expect(
      homeWeekInputEqual({ ...base, activity: [['a', 1]] }, { ...base, activity: [['a', 1]] })
    ).toBe(true);
    expect(
      homeWeekInputEqual({ ...base, activity: [['a', 1]] }, { ...base, activity: [['a', 2]] })
    ).toBe(false);
  });
});

describe('lines added and removed', () => {
  it('splits the lines changed in the window into what was added and what was removed', () => {
    const model = buildHomeWeek(
      makeWeekInput([
        row({ lastAt: at(1), add: 2000, del: 418 }),
        row({ lastAt: at(3), add: 100, del: 30 }),
        row({ lastAt: at(9), add: 5000, del: 900 }),
      ]),
      NOW
    );
    expect(model.added).toBe(2100);
    expect(model.removed).toBe(448);
    expect(model.lines).toBe(model.added + model.removed);
  });

  it('is zero for a quiet week', () => {
    const model = buildHomeWeek(makeWeekInput([]), NOW);
    expect([model.added, model.removed, model.lines]).toEqual([0, 0, 0]);
  });
});
