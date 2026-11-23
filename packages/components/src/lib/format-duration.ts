export type DurationUnitLabels = {
  hour: string;
  minute: string;
  second: string;
  /** Joins unit groups; CJK locales ship '' ("43分32秒"), Latin ones " " ("43m 32s"). */
  separator?: string;
};

/**
 * The shared builder for the localized units `formatDurationCompact` joins.
 * Centralizing it keeps every caller on the same separator, so a zh render can
 * never leak the Latin "43m 32s" spacing as "43分 32秒".
 */
export const getDurationUnitLabels = (
  t: (key: string, fallback: string) => string
): DurationUnitLabels => ({
  hour: t('time.unitShort.hour', 'h'),
  minute: t('time.unitShort.minute', 'm'),
  second: t('time.unitShort.second', 's'),
  separator: t('time.unitSeparator', ' '),
});

const pad2 = (value: number): string => String(value).padStart(2, '0');

export const formatDurationCompact = (durationMs: number, units: DurationUnitLabels): string => {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '';
  }

  const sep = units.separator ?? ' ';
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}${units.hour}${sep}${pad2(minutes)}${units.minute}${sep}${pad2(seconds)}${units.second}`;
  }

  if (minutes > 0) {
    return `${minutes}${units.minute}${sep}${pad2(seconds)}${units.second}`;
  }

  return `${seconds}${units.second}`;
};
