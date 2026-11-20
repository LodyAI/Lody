import type { TodayDate } from '@lody/shared';

/**
 * Which days the Today stream shows, top to bottom.
 * Behavior: specs/today-outline.md (Page stream and dates).
 *
 * The top day is the calendar anchor, or today. It always shows, even when
 * empty or unregistered. Below it come earlier registered days, newest first;
 * a registered day found empty after loading is skipped. Future days appear
 * only when the anchor is later than them.
 */
export function buildDayStream(input: {
  today: TodayDate;
  anchor?: TodayDate;
  registered: readonly TodayDate[];
  empty: ReadonlySet<TodayDate>;
}): TodayDate[] {
  const top = input.anchor ?? input.today;
  const earlier = [...new Set(input.registered)]
    .filter((date) => date < top && !input.empty.has(date))
    .sort()
    .reverse();
  return [top, ...earlier];
}

const pad = (value: number) => String(value).padStart(2, '0');

/** The viewer's local calendar day. */
export function localTodayDate(now: Date): TodayDate {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` as TodayDate;
}

export function msUntilNextLocalMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** `YYYY-MM-DD` of a local Date, shifted by whole days. */
export function shiftTodayDate(date: TodayDate, days: number): TodayDate {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return localTodayDate(new Date(year, month - 1, day + days));
}

export function todayDateToLocalDate(date: TodayDate): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day);
}
