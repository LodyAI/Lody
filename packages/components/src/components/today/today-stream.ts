import { parseTodayDate, type TodayDate } from '@lody/shared';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';

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

export function todayDateToLocalDate(date: TodayDate): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day);
}

/**
 * What the full-page route does. While Today is pinned beside the sidebar the
 * route hands its member/date to the column instead of showing Today twice;
 * where the column cannot appear (compact layout) the page shows as usual.
 */
export function todayRouteOutcome(input: {
  enabled: boolean;
  pinned: boolean;
  compact: boolean;
}): 'redirect' | 'to-column' | 'page' {
  if (!input.enabled) return 'redirect';
  return input.pinned && !input.compact ? 'to-column' : 'page';
}

/** `focus`: `'day'` for the day alone, or a node id to zoom into. */
export type TodaySearch = { member?: string; date?: string; focus?: string };

const FOCUS_PATTERN = /^(day|\d+@\d+)$/;

/** The member/date search shared by the Today page and the Today window routes. */
export function validateTodaySearch(search: Record<string, unknown>): TodaySearch {
  return {
    ...(typeof search.member === 'string' && search.member ? { member: search.member } : {}),
    ...(typeof search.date === 'string' && parseTodayDate(search.date)
      ? { date: search.date }
      : {}),
    ...(typeof search.focus === 'string' && FOCUS_PATTERN.test(search.focus)
      ? { focus: search.focus }
      : {}),
  };
}

/**
 * A day heading in the product language (`zh_CN` etc. go through
 * `toIntlLocaleOrEn`; raw i18n codes are not valid Intl tags). Today reads
 * "Today" with the full date beside it; other days read the date with the
 * weekday beside it.
 */
export function formatTodayHeading(
  date: TodayDate,
  today: TodayDate,
  language: string | null | undefined
): { date: string; meta: string; isToday: boolean } {
  const locale = toIntlLocaleOrEn(language);
  const value = todayDateToLocalDate(date);
  const isToday = date === today;
  const day = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(value);
  const meta = isToday
    ? new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric' }).format(
        value
      )
    : new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(value);
  return { date: day, meta, isToday };
}
