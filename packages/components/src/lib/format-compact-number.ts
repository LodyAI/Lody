/**
 * Locale-aware compact / currency formatting for usage surfaces.
 *
 * Compact units must follow the product language (en → K/M/B, zh → 万/亿), not the
 * host OS locale. Passing `undefined` to `Intl.NumberFormat` falls back to the
 * runtime default and is what previously leaked Chinese units into English UI.
 */

export function formatCompactNumber(
  value: number,
  locale: string | null | undefined
): string {
  if (!Number.isFinite(value)) return '0';
  return new Intl.NumberFormat(locale ?? 'en', {
    notation: 'compact',
    // Match NumberFlow on the usage KPI/rings: one fraction digit keeps
    // "1.2M" readable without turning large totals into noisy decimals.
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatUsdAmount(
  value: number,
  locale: string | null | undefined,
  options?: { maximumFractionDigits?: number; minimumFractionDigits?: number }
): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(safeValue);
  return new Intl.NumberFormat(locale ?? 'en', {
    style: 'currency',
    currency: 'USD',
    ...(options?.minimumFractionDigits !== undefined
      ? { minimumFractionDigits: options.minimumFractionDigits }
      : {}),
    maximumFractionDigits:
      options?.maximumFractionDigits ?? (abs > 0 && abs < 1 ? 3 : 2),
  }).format(safeValue);
}

/** Below this a dollar figure is both short and worth stating exactly. */
const USD_COMPACT_FROM = 1000;

/**
 * A dollar figure short enough to sit beside other numbers in a fixed layout.
 * The usage share card speaks in compact units everywhere else (`1.3B`, `42M`),
 * and a full `$1,234,567.89` beside them grows without bound — in the 16:9 card
 * it closed the gap to the headline cells to nothing and eventually overlapped
 * them. Small amounts keep their exact value, where the cents are the point and
 * the string is short anyway.
 */
export function formatUsdCompact(value: number, locale: string | null | undefined): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  if (Math.abs(safeValue) < USD_COMPACT_FROM) return formatUsdAmount(safeValue, locale);
  return new Intl.NumberFormat(locale ?? 'en', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(safeValue);
}
