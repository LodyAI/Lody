export type DurationUnitLabels = {
  hour: string;
  minute: string;
  second: string;
  /** Joins unit groups, such as the minute and second parts. */
  separator?: string;
  /** Separates each number from its unit; English compact units remain attached. */
  numberUnitSeparator?: string;
};

/** Supplies the localized spacing used by every compact duration surface. */
export const getDurationUnitLabels = (
  t: (key: string, fallback: string) => string
): DurationUnitLabels => ({
  hour: t('time.unitShort.hour', 'h'),
  minute: t('time.unitShort.minute', 'm'),
  second: t('time.unitShort.second', 's'),
  separator: t('time.unitSeparator', ' '),
  numberUnitSeparator: t('time.numberUnitSeparator', ''),
});

const pad2 = (value: number): string => String(value).padStart(2, '0');

export const formatDurationCompact = (durationMs: number, units: DurationUnitLabels): string => {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '';
  }

  const sep = units.separator ?? ' ';
  const numberUnitSep = units.numberUnitSeparator ?? '';
  const withUnit = (value: number | string, unit: string): string => `${value}${numberUnitSep}${unit}`;
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return [
      withUnit(hours, units.hour),
      withUnit(pad2(minutes), units.minute),
      withUnit(pad2(seconds), units.second),
    ].join(sep);
  }

  if (minutes > 0) {
    return [withUnit(minutes, units.minute), withUnit(pad2(seconds), units.second)].join(sep);
  }

  return withUnit(seconds, units.second);
};
