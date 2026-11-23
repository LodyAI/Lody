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

/** Below this the cents are the point, not noise. */
const USD_CENTS_BELOW = 1000;
/** Above this the digits stop being a boast and start being a wall. */
const USD_COMPACT_FROM = 1_000_000_000;

/**
 * A dollar figure sized for a fixed layout, shortened in two stages rather than
 * one. Someone denominating a share card in money usually wants the digits — that
 * is the point of choosing cost — so the whole figure survives up to a billion and
 * only the cents go, because on a four-figure sum they are noise. Below a thousand
 * the cents come back: there they carry the meaning and the string is short anyway.
 * A figure past a billion compacts, since by then the digits are a wall and the
 * headline shares its row with the stat cells.
 */
export function formatUsdCompact(value: number, locale: string | null | undefined): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(safeValue);
  if (abs < USD_CENTS_BELOW) return formatUsdAmount(safeValue, locale);
  return new Intl.NumberFormat(locale ?? 'en', {
    style: 'currency',
    currency: 'USD',
    ...(abs < USD_COMPACT_FROM
      ? { maximumFractionDigits: 0 }
      : { notation: 'compact' as const, maximumFractionDigits: 1 }),
  }).format(safeValue);
}

/**
 * Money for a slot too narrow to spell a figure out — a stat cell or a legend row,
 * which get a quarter of a headline's width or less. Always compact above a
 * thousand, so the string cannot outgrow its box; the alternative is `truncate`,
 * and an ellipsis on a number renders a different number than the one measured.
 */
export function formatUsdTight(value: number, locale: string | null | undefined): string {
  const safeValue = Number.isFinite(value) ? value : 0;
  if (Math.abs(safeValue) < USD_CENTS_BELOW) return formatUsdAmount(safeValue, locale);
  return new Intl.NumberFormat(locale ?? 'en', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(safeValue);
}
