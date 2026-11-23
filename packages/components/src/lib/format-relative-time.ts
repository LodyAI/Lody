/**
 * Compact "time ago" label (1m / 2h / 3d / 1w / 2mo / 1y) for relative timestamps.
 *
 * Shared by the sidebar lists, the task list, and the ⌘K command palette so every
 * surface renders last-activity times identically. Pass a stable `now` (e.g.
 * `useStableNow()`) so labels don't recompute on every render.
 */
export type RelativeTimeValue = string | number | Date | null | undefined;

function toDate(value: RelativeTimeValue): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function formatCompactRelativeTime(
  value: RelativeTimeValue,
  now: Date = new Date()
): string {
  const date = toDate(value);
  if (!date) return '--';

  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;

  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w`;

  const months = Math.floor(days / 30);
  if (days < 365) return `${months}mo`;

  const years = Math.floor(days / 365);
  return `${years}y`;
}

type TranslateCount = (key: string, fallback: string, options: { count: number }) => string;

/**
 * "2m ago" / "2 分钟前": how long ago, in the product language's own units.
 *
 * `formatCompactRelativeTime` is Latin shorthand for a narrow column of
 * timestamps; inside a sentence of Chinese copy its "2m" reads as English, so
 * prose that says when something happened takes this one. English keeps the
 * compact units ("2m ago"); Chinese spells them ("2 分钟前"). The steps are
 * the compact formatter's, so a row never disagrees with the list beside it.
 */
export function formatLocalizedRelativeTime(
  value: RelativeTimeValue,
  t: TranslateCount,
  now: Date = new Date()
): string {
  const date = toDate(value);
  if (!date) return '--';

  const minutes = Math.floor(Math.max(0, now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return t('time.ago.justNow', 'just now', { count: 0 });
  if (minutes < 60) return t('time.ago.minutes', '{{count}}m ago', { count: minutes });

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.ago.hours', '{{count}}h ago', { count: hours });

  const days = Math.floor(hours / 24);
  if (days < 7) return t('time.ago.days', '{{count}}d ago', { count: days });

  const weeks = Math.floor(days / 7);
  if (days < 30) return t('time.ago.weeks', '{{count}}w ago', { count: weeks });

  const months = Math.floor(days / 30);
  if (days < 365) return t('time.ago.months', '{{count}}mo ago', { count: months });

  return t('time.ago.years', '{{count}}y ago', { count: Math.floor(days / 365) });
}

/**
 * Compact absolute month + year ("Aug 2025"), for dates where *when it was
 * created* matters more than how long ago that was.
 *
 * Deliberately not `formatCompactRelativeTime`: a creation date rendered as
 * "7mo" tells you the age but loses the calendar position, and task lists are
 * scanned for "which quarter did this come from". Locale-aware, so zh renders
 * 2025年8月.
 */
export function formatShortMonthYear(value: RelativeTimeValue): string {
  const date = toDate(value);
  if (!date) return '--';
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
