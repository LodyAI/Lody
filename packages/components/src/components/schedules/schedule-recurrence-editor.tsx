import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import * as stylex from '@stylexjs/stylex';
import {
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
import { Select } from '@lody/ui/select';
import { cn } from '@/lib/utils';
import { describeRecurrence, weekdayNames } from './schedule-format';
import { PropertyRow, ghostValueClass } from './schedule-property-row';
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
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
    opacity: { default: null, ':disabled': 0.5 },
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
    ':disabled': { opacity: 0.5 },
  },
  // In Chromium the indicator also opens the picker; hiding it leaves only
  // the editable segments for both time and date-time fields.
  manualTimeInput: {
    width: 'auto',
    fontVariantNumeric: 'tabular-nums',
    '::-webkit-calendar-picker-indicator': { display: 'none' },
  },
});

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
  const stepItems =
    value.kind === 'minutes' || value.kind === 'hours'
      ? (value.kind === 'minutes' ? SCHEDULE_MINUTE_STEPS : SCHEDULE_HOUR_STEPS).map((step) => ({
          value: String(step),
          label:
            value.kind === 'minutes'
              ? t('schedules.everyMinutes', { count: step, defaultValue: '{{count}} minutes' })
              : t('schedules.everyHours', { count: step, defaultValue: '{{count}} hours' }),
        }))
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
              <Select.Root
                value={String(value.every)}
                disabled={disabled}
                items={stepItems}
                // A controlled Select can emit an empty value while its option
                // list is swapped (hours → minutes); that is not a choice.
                onValueChange={(every) => {
                  const step = Number(every);
                  if (Number.isInteger(step) && step > 0) onChange({ ...value, every: step });
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
                className={cn(ghostValueClass, stylex.props(styles.manualTimeInput).className)}
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
                className={cn(ghostValueClass, stylex.props(styles.manualTimeInput).className)}
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
