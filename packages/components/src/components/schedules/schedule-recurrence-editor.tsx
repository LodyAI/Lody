import { control } from '@lody/ui/tokens/scales.stylex';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import * as stylex from '@stylexjs/stylex';
import {
  SCHEDULE_CUSTOM_HOURS_MAX,
  SCHEDULE_CUSTOM_MINUTES_MAX,
  SCHEDULE_HOUR_STEPS,
  SCHEDULE_MINUTE_STEPS,
  SCHEDULE_RECURRENCE_KINDS,
  SCHEDULE_WEEKDAYS,
  changeScheduleRecurrenceKind,
  instantToZonedLocalInput,
  zonedLocalInputToInstant,
  normalizeScheduleWeekdays,
  type ScheduleRecurrence,
  type ScheduleRecurrenceKind,
  type ScheduleWeekday,
} from '@lody/shared';
import { NumberField } from '@lody/ui/number-field';
import { Select } from '@lody/ui/select';
import { describeRecurrence, weekdayNames } from './schedule-format';
import { PropertyRow, ghostValueStyles } from './schedule-property-row';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeFontWeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const DARK_SCOPE =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';

const styles = stylex.create({
  stepRow: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: themeSpace[2],
  },
  stepField: { width: 'calc(var(--spacing) * 20)', flexShrink: 0 },
  numeric: { fontVariantNumeric: 'tabular-nums' },
  stepUnit: { flexShrink: 0, fontSize: '0.9em', color: 'hsl(var(--muted-foreground))' },
  days: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: themeSpace[1] },
  dateGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
    justifyItems: 'end',
  },
  day: {
    width: themeSpace[7],
    height: themeSpace[7],
    borderRadius: themeRadius.md,
    fontSize: '0.8em',
    fontWeight: themeFontWeight.normal,
    fontVariantNumeric: 'tabular-nums',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
    opacity: { default: null, ':disabled': control.disabledOpacity },
  },
  selectedDay: { backgroundColor: themeColors.primary, color: themeColors.primaryForeground },
  unselectedDay: {
    backgroundColor: {
      default: 'hsl(var(--foreground) / 0.04)',
      '@media (hover: hover)': { ':hover': 'hsl(var(--foreground) / 0.08)' },
      [DARK_SCOPE]: {
        default: '#ffffff0d',
        '@supports (color: color-mix(in lab, red, red))':
          'color-mix(in oklab, var(--color-white) 5%, transparent)',
        ':hover': {
          default: '#ffffff0d',
          '@supports (color: color-mix(in lab, red, red))':
            'color-mix(in oklab, var(--color-white) 5%, transparent)',
          '@media (hover: hover)': {
            default: '#ffffff1a',
            '@supports (color: color-mix(in lab, red, red))':
              'color-mix(in oklab, var(--color-white) 10%, transparent)',
          },
        },
      },
    },
    color: {
      default: themeColors.mutedForeground,
      '@media (hover: hover)': { ':hover': themeColors.foreground },
    },
  },
  reveal: { overflow: 'hidden' },
  unsupported: { display: 'flex', alignItems: 'center', gap: themeSpace[2] },
  unsupportedSummary: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.9em',
    color: themeColors.foreground,
  },
  replace: {
    flexShrink: 0,
    fontSize: '0.9em',
    color: themeColors.primary,
    textUnderlineOffset: '2px',
    '@media (hover: hover)': { ':hover': { textDecorationLine: 'underline' } },
    ':disabled': { opacity: control.disabledOpacity },
  },
  // In Chromium the indicator also opens the picker; hiding it leaves only
  // the editable segments for both time and date-time fields.
  manualTimeInput: {
    width: 'auto',
    fontVariantNumeric: 'tabular-nums',
    '::-webkit-calendar-picker-indicator': { display: 'none' },
  },
});

/** The "Every" menu's last entry; selecting it reveals a typed number. */
const CUSTOM_STEP = 'custom';

/** Small square toggles; one row of seven for weekdays, a 7-wide grid for dates. */
function DayToggles({
  values,
  options,
  onChange,
  disabled,
  grid,
}: {
  values: readonly number[];
  options: readonly { value: number; short: string; long: string }[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
  grid?: boolean;
}) {
  const selected = new Set(values);
  return (
    <div {...stylex.props(styles.days, grid && styles.dateGrid)}>
      {options.map((option) => {
        const on = selected.has(option.value);
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            aria-label={option.long}
            onClick={() =>
              onChange(
                on
                  ? values.filter((entry) => entry !== option.value)
                  : [...values, option.value].sort((a, b) => a - b)
              )
            }
            {...stylex.props(styles.day, on ? styles.selectedDay : styles.unselectedDay)}
          >
            {option.short}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Rows that slide in and out as the rule changes shape.
 *
 * Height animates from the row's own content, so the card grows to fit the
 * seven weekday toggles or the 31-day grid rather than jumping. Reduced motion
 * collapses to an instant switch.
 */
function Reveal({ id, children }: { id: string; children: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      key={id}
      layout
      initial={reduce ? false : { height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={reduce ? undefined : { height: 0, opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      {...stylex.props(styles.reveal)}
    >
      {children}
    </motion.div>
  );
}

/**
 * The time rule, as the few shapes people actually set.
 *
 * Every option is a named rule; the persisted trigger is derived by
 * `@lody/shared`. There is no cron here: a stored rule the picker cannot name
 * is shown read-only with a "Replace" affordance, never rewritten.
 */
export function ScheduleRecurrenceEditor({
  value,
  onChange,
  now,
  timeZone,
  disabled,
}: {
  value: ScheduleRecurrence;
  onChange: (next: ScheduleRecurrence) => void;
  now: number;
  /**
   * The target machine's clock. Every wall time here — including a one-off
   * run — is read on it; there is no zone picker.
   */
  timeZone: string;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const kindLabels: Record<Exclude<ScheduleRecurrenceKind, 'unsupported'>, string> = {
    daily: t('schedules.repeat.daily', 'Every day'),
    weekdays: t('schedules.repeat.weekdays', 'Every weekday'),
    weekly: t('schedules.repeat.weekly', 'Every week'),
    monthly: t('schedules.repeat.monthly', 'Every month'),
    hours: t('schedules.repeat.hours', 'Every few hours'),
    minutes: t('schedules.repeat.minutes', 'Every few minutes'),
    once: t('schedules.repeat.once', 'Once'),
  };
  const hasWallClock =
    value.kind === 'daily' ||
    value.kind === 'weekdays' ||
    value.kind === 'weekly' ||
    value.kind === 'monthly';
  const timeValue = hasWallClock
    ? `${String(value.hour).padStart(2, '0')}:${String(value.minute).padStart(2, '0')}`
    : '';
  const shortWeekdays = weekdayNames(i18n.language, 'narrow');
  const isStep = value.kind === 'minutes' || value.kind === 'hours';
  const presetSteps: readonly number[] = isStep
    ? value.kind === 'minutes'
      ? SCHEDULE_MINUTE_STEPS
      : SCHEDULE_HOUR_STEPS
    : [];
  // "Custom" is kept per kind: choosing it on minutes must not leave hours in
  // custom mode. A stored step that is not a preset always opens as custom.
  const [customKind, setCustomKind] = useState<'minutes' | 'hours' | null>(null);
  const isCustomStep = isStep && (customKind === value.kind || !presetSteps.includes(value.every));
  const stepItems = isStep
    ? [
        ...presetSteps.map((step) => ({
          value: String(step),
          label:
            value.kind === 'minutes'
              ? t('schedules.everyMinutes', { count: step, defaultValue: '{{count}} minutes' })
              : t('schedules.everyHours', { count: step, defaultValue: '{{count}} hours' }),
        })),
        { value: CUSTOM_STEP, label: t('schedules.repeat.custom', 'Custom') },
      ]
    : [];
  const longWeekdays = weekdayNames(i18n.language, 'long');

  if (value.kind === 'unsupported') {
    return (
      <PropertyRow
        label={t('schedules.repeat.label', 'Repeat')}
        hint={t(
          'schedules.repeat.unsupportedHint',
          'This rule was created with an older version and can no longer be edited here. Replace it to change it.'
        )}
      >
        <div {...stylex.props(styles.unsupported)}>
          <span {...stylex.props(styles.unsupportedSummary)}>
            {describeRecurrence(value, t, i18n.language)}
          </span>
          <button
            type="button"
            disabled={disabled}
            {...stylex.props(styles.replace)}
            onClick={() => onChange(changeScheduleRecurrenceKind(value, 'daily', now, timeZone))}
          >
            {t('schedules.repeat.replace', 'Replace')}
          </button>
        </div>
      </PropertyRow>
    );
  }

  return (
    <>
      <PropertyRow label={t('schedules.repeat.label', 'Repeat')}>
        <Select.Root
          value={value.kind}
          disabled={disabled}
          items={SCHEDULE_RECURRENCE_KINDS.map((kind) => ({
            value: kind,
            label: kindLabels[kind],
          }))}
          onValueChange={(kind) => {
            if (
              typeof kind === 'string' &&
              (SCHEDULE_RECURRENCE_KINDS as readonly string[]).includes(kind)
            )
              onChange(
                changeScheduleRecurrenceKind(
                  value,
                  kind as Exclude<ScheduleRecurrenceKind, 'unsupported'>,
                  now,
                  timeZone
                )
              );
          }}
        >
          <Select.Trigger size="small" aria-label={t('schedules.repeat.label', 'Repeat')}>
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {SCHEDULE_RECURRENCE_KINDS.map((kind) => (
              <Select.Item key={kind} value={kind}>
                {kindLabels[kind]}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </PropertyRow>

      <AnimatePresence initial={false} mode="popLayout">
        {value.kind === 'minutes' || value.kind === 'hours' ? (
          <Reveal key="every" id="every">
            <PropertyRow label={t('schedules.repeat.every', 'Every')}>
              <div {...stylex.props(styles.stepRow)}>
                {isCustomStep ? (
                  <>
                    <NumberField.Root
                      className={stylex.props(styles.stepField).className}
                      value={value.every}
                      min={1}
                      max={
                        value.kind === 'minutes'
                          ? SCHEDULE_CUSTOM_MINUTES_MAX
                          : SCHEDULE_CUSTOM_HOURS_MAX
                      }
                      step={1}
                      disabled={disabled}
                      // An emptied field is not a choice; the last whole number stays.
                      onValueChange={(next) => {
                        if (next === null || !Number.isFinite(next)) return;
                        const every = Math.round(next);
                        if (every >= 1 && every !== value.every) onChange({ ...value, every });
                      }}
                    >
                      <NumberField.Input
                        size="small"
                        className={stylex.props(styles.numeric).className}
                        aria-label={
                          value.kind === 'minutes'
                            ? t('schedules.repeat.customMinutes', 'Number of minutes')
                            : t('schedules.repeat.customHours', 'Number of hours')
                        }
                      />
                    </NumberField.Root>
                    <span {...stylex.props(styles.stepUnit)}>
                      {value.kind === 'minutes'
                        ? t('schedules.repeat.unitMinutes', 'minutes')
                        : t('schedules.repeat.unitHours', 'hours')}
                    </span>
                  </>
                ) : null}
                <Select.Root
                  value={isCustomStep ? CUSTOM_STEP : String(value.every)}
                  disabled={disabled}
                  items={stepItems}
                  // A controlled Select can emit an empty value while its option
                  // list is swapped (hours → minutes); that is not a choice.
                  onValueChange={(every) => {
                    if (every === CUSTOM_STEP) {
                      setCustomKind(value.kind);
                      return;
                    }
                    const step = Number(every);
                    if (Number.isInteger(step) && step > 0) {
                      setCustomKind(null);
                      onChange({ ...value, every: step });
                    }
                  }}
                >
                  <Select.Trigger size="small" aria-label={t('schedules.repeat.every', 'Every')}>
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    {stepItems.map((item) => (
                      <Select.Item key={item.value} value={item.value}>
                        {item.label}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </div>
            </PropertyRow>
          </Reveal>
        ) : null}

        {value.kind === 'weekly' ? (
          <Reveal key="weekdays" id="weekdays">
            <PropertyRow label={t('schedules.repeat.on', 'On')}>
              <DayToggles
                values={value.weekdays}
                disabled={disabled}
                options={SCHEDULE_WEEKDAYS.map((day: ScheduleWeekday) => ({
                  value: day,
                  short: shortWeekdays[day]!,
                  long: longWeekdays[day]!,
                }))}
                onChange={(weekdays) =>
                  onChange({
                    ...value,
                    weekdays: normalizeScheduleWeekdays(weekdays as ScheduleWeekday[]),
                  })
                }
              />
            </PropertyRow>
          </Reveal>
        ) : null}

        {value.kind === 'monthly' ? (
          <Reveal key="days" id="days">
            <PropertyRow label={t('schedules.repeat.onDays', 'On days')} align="start">
              <DayToggles
                grid
                values={value.days}
                disabled={disabled}
                options={Array.from({ length: 31 }, (_, index) => ({
                  value: index + 1,
                  short: String(index + 1),
                  long: t('schedules.repeat.dayOfMonthN', 'Day {{day}}', { day: index + 1 }),
                }))}
                onChange={(days) => onChange({ ...value, days })}
              />
            </PropertyRow>
          </Reveal>
        ) : null}

        {hasWallClock ? (
          <Reveal key="time" id="time">
            <PropertyRow label={t('schedules.repeat.at', 'At')}>
              <input
                type="time"
                required
                disabled={disabled}
                aria-label={t('schedules.repeat.at', 'At')}
                {...stylex.props(ghostValueStyles, styles.manualTimeInput)}
                value={timeValue}
                onChange={(event) => {
                  const [hour, minute] = event.target.value.split(':');
                  if (hour === undefined || minute === undefined) return;
                  onChange({ ...value, hour: Number(hour), minute: Number(minute) });
                }}
              />
            </PropertyRow>
          </Reveal>
        ) : null}

        {value.kind === 'once' ? (
          <Reveal key="once" id="once">
            <PropertyRow label={t('schedules.repeat.runAt', 'Run at')}>
              <input
                type="datetime-local"
                required
                disabled={disabled}
                aria-label={t('schedules.repeat.runAt', 'Run at')}
                {...stylex.props(ghostValueStyles, styles.manualTimeInput)}
                value={instantToZonedLocalInput(Date.parse(value.at), timeZone)}
                onChange={(event) => {
                  const at = zonedLocalInputToInstant(event.target.value, timeZone);
                  if (at !== null) onChange({ ...value, at: new Date(at).toISOString() });
                }}
              />
            </PropertyRow>
          </Reveal>
        ) : null}
      </AnimatePresence>
    </>
  );
}
