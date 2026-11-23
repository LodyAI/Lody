/**
 * The new-chat page's last seven days, as numbers. This module is the arithmetic only;
 * the tiles and their copy live in `components/chat/home/week-bento.tsx`.
 *
 * Everything comes from session metadata the client already holds, on the LOCAL
 * calendar. The metadata keeps two moments per session (created, last active) and the
 * lines changed so far, so a session's lines count on the day it was last active, and a
 * pull request counts when its session was. Both are close, not exact, and the page
 * never claims otherwise.
 */

export const HOME_WEEK_DAYS = 7;

/** The activity wall: at most this many weeks, oldest first, the last one ending today. The tile
 *  shows as many of the newest as fit its width. */
export const HOME_WEEK_WALL_WEEKS = 30;
/** Rows of the wall: Monday to Friday. Weekends are left out, which keeps the wall short. */
export const HOME_WEEK_WALL_ROWS = 5;

/** What the page needs of one session. */
export type HomeWeekRow = {
  createdAt: number;
  lastAt: number;
  /** Lines added and removed so far in the session. */
  add: number;
  del: number;
  /** Pull requests of the session that are merged. */
  mergedPrs: number;
  cliType: string;
  agentType: string;
  /** `owner/repo` when the session is bound to a repository. */
  repo: string | null;
};

export type HomeWeekInput = {
  /** Sessions active recently enough to matter to the last two weeks. */
  rows: readonly HomeWeekRow[];
  /** Every local `yyyy-mm-dd` on which any session was created or last active. */
  activeDays: readonly string[];
  /**
   * How many session events (a session created, a session last active) fell on each of those
   * days, as `[yyyy-mm-dd, count]`. Gives the wall its shades; without it every active day
   * counts once.
   */
  activity?: readonly (readonly [string, number])[];
};

/** 0 is a day with nothing; 1 to 4 are quarters of the busiest day. */
export type HomeWeekWallLevel = 0 | 1 | 2 | 3 | 4;

/** One day of the wall: its local `yyyy-mm-dd`, how many session events fell on it, and its shade. */
export type HomeWeekWallCell = { day: string; count: number; level: HomeWeekWallLevel };

export type HomeWeekAgent = { cliType: string; agentType: string; count: number };

export type HomeWeekRepo = { repo: string; count: number; percent: number };

export type HomeWeekModel = {
  /** Lines changed in sessions last active in the window: `added` plus `removed`. */
  lines: number;
  added: number;
  removed: number;
  /** Lines per day, oldest first, always `HOME_WEEK_DAYS` long. */
  daily: number[];
  /**
   * The activity wall, like a contribution graph: `HOME_WEEK_WALL_WEEKS` weeks, oldest first,
   * each a run of workdays from Monday (`HOME_WEEK_WALL_ROWS` of them). The last week stops at
   * today, so it can be shorter.
   */
  wall: HomeWeekWallCell[][];
  /** Whole percent against the seven days before, or null when there is nothing to compare. */
  delta: number | null;
  mergedPrs: number;
  /** Sessions created in the window. */
  sessions: number;
  /** Agents of those sessions, most used first, at most two. */
  agents: HomeWeekAgent[];
  /** The repository most of those sessions were in, when any session had one. */
  topRepo: HomeWeekRepo | null;
};

const pad = (value: number): string => String(value).padStart(2, '0');

/** `yyyy-mm-dd` in the local calendar. */
export function homeWeekDayKey(value: Date | number): string {
  const date = typeof value === 'number' ? new Date(value) : value;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Built from calendar parts, so a daylight-saving change cannot shift the day. */
function localDayStart(now: Date, daysBack: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack).getTime();
}

function wallLevel(count: number, max: number): HomeWeekWallLevel {
  if (count <= 0 || max <= 0) return 0;
  const ratio = count / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/** Weeks start on Monday and show their workdays; days after today are left out, not drawn empty. */
function buildWall(input: HomeWeekInput, now: Date): HomeWeekWallCell[][] {
  const counts = new Map<string, number>(input.activity ?? []);
  for (const day of input.activeDays) if (!counts.has(day)) counts.set(day, 1);

  const weekday = (now.getDay() + 6) % 7;
  const weeks: { day: string; count: number }[][] = [];
  let max = 0;
  for (let week = 0; week < HOME_WEEK_WALL_WEEKS; week += 1) {
    const days: { day: string; count: number }[] = [];
    for (let row = 0; row < HOME_WEEK_WALL_ROWS; row += 1) {
      const daysBack = (HOME_WEEK_WALL_WEEKS - 1 - week) * 7 + (weekday - row);
      if (daysBack < 0) break;
      const day = homeWeekDayKey(localDayStart(now, daysBack));
      const count = counts.get(day) ?? 0;
      max = Math.max(max, count);
      days.push({ day, count });
    }
    weeks.push(days);
  }
  return weeks.map((days) =>
    days.map(({ day, count }) => ({ day, count, level: wallLevel(count, max) }))
  );
}

/** The day a moment inside the window falls on; the window's days are given by their midnights. */
function dayIndexOf(ms: number, dayStarts: readonly number[]): number {
  let day = dayStarts.length - 1;
  while (day > 0 && ms < dayStarts[day]!) day -= 1;
  return day;
}

export function buildHomeWeek(input: HomeWeekInput, now: Date): HomeWeekModel {
  const windowStart = localDayStart(now, HOME_WEEK_DAYS - 1);
  const windowEnd = localDayStart(now, -1);
  const previousStart = localDayStart(now, HOME_WEEK_DAYS * 2 - 1);
  const dayStarts = Array.from({ length: HOME_WEEK_DAYS }, (_, index) =>
    localDayStart(now, HOME_WEEK_DAYS - 1 - index)
  );

  const daily = Array<number>(HOME_WEEK_DAYS).fill(0);
  const agentCounts = new Map<string, HomeWeekAgent>();
  const repoCounts = new Map<string, number>();
  let lines = 0;
  let added = 0;
  let removed = 0;
  let previousLines = 0;
  let mergedPrs = 0;
  let sessions = 0;

  for (const row of input.rows) {
    const changed = row.add + row.del;
    if (row.lastAt >= windowStart && row.lastAt < windowEnd) {
      lines += changed;
      added += row.add;
      removed += row.del;
      mergedPrs += row.mergedPrs;
      daily[dayIndexOf(row.lastAt, dayStarts)]! += changed;
    } else if (row.lastAt >= previousStart && row.lastAt < windowStart) {
      previousLines += changed;
    }

    if (row.createdAt >= windowStart && row.createdAt < windowEnd) {
      sessions += 1;
      if (row.repo) repoCounts.set(row.repo, (repoCounts.get(row.repo) ?? 0) + 1);
      const key = `${row.cliType}\u0000${row.agentType}`;
      const agent = agentCounts.get(key);
      if (agent) agent.count += 1;
      else agentCounts.set(key, { cliType: row.cliType, agentType: row.agentType, count: 1 });
    }
  }

  let topRepo: HomeWeekRepo | null = null;
  for (const [repo, count] of repoCounts) {
    if (!topRepo || count > topRepo.count || (count === topRepo.count && repo < topRepo.repo)) {
      topRepo = { repo, count, percent: Math.round((count / sessions) * 100) };
    }
  }

  return {
    lines,
    added,
    removed,
    daily,
    wall: buildWall(input, now),
    delta: previousLines > 0 ? Math.round(((lines - previousLines) / previousLines) * 100) : null,
    mergedPrs,
    sessions,
    agents: [...agentCounts.values()]
      .sort(
        (left, right) => right.count - left.count || left.agentType.localeCompare(right.agentType)
      )
      .slice(0, 2),
    topRepo,
  };
}

export function homeWeekInputEqual(left: HomeWeekInput, right: HomeWeekInput): boolean {
  return (
    left.activeDays.length === right.activeDays.length &&
    left.activeDays.every((day, index) => day === right.activeDays[index]) &&
    (left.activity?.length ?? 0) === (right.activity?.length ?? 0) &&
    (left.activity ?? []).every(([day, count], index) => {
      const other = right.activity![index]!;
      return day === other[0] && count === other[1];
    }) &&
    left.rows.length === right.rows.length &&
    left.rows.every((row, index) => {
      const other = right.rows[index]!;
      return (
        row.createdAt === other.createdAt &&
        row.lastAt === other.lastAt &&
        row.add === other.add &&
        row.del === other.del &&
        row.mergedPrs === other.mergedPrs &&
        row.cliType === other.cliType &&
        row.agentType === other.agentType &&
        row.repo === other.repo
      );
    })
  );
}
