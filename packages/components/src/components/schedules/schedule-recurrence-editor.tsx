import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, ChevronDown, Globe } from 'lucide-react';
import {
  SCHEDULE_HOUR_STEPS,
  SCHEDULE_MINUTE_STEPS,
  SCHEDULE_RECURRENCE_KINDS,
  SCHEDULE_WEEKDAYS,
  changeScheduleRecurrenceKind,
  getDeviceTimeZone,
  normalizeScheduleWeekdays,
  type ScheduleRecurrence,
  type ScheduleRecurrenceKind,
  type ScheduleWeekday,
} from '@lody/shared';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { cn } from '@/lib/utils';
import { describeRecurrence, weekdayNames } from './schedule-format';
import { PropertyRow, ghostSelectTriggerClass, ghostValueClass } from './schedule-property-row';

/** `<input type="datetime-local">` needs a wall-clock string, not an instant. */
const toLocalInput = (iso: string): string => {
  const at = new Date(iso);
  return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function TimeZoneField({
  value,
  onChange,
  disabled,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  label: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // `supportedValuesOf` is absent on a few runtimes; the device zone plus the
  // authored zone always keeps the current value selectable.
  const zones = useMemo(() => {
    const supported =
      typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    return [...new Set([getDeviceTimeZone(), value, ...supported])].filter(Boolean);
  }, [value]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          className={cn(ghostValueClass, 'h-7 px-1.5 text-[0.8em] text-muted-foreground')}
        >
          <Globe className="size-3 shrink-0 opacity-60" />
          <span className="truncate">{value}</span>
          <ChevronDown className="size-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(20rem,calc(100vw-2rem))] p-0">
        <Command>
          <CommandInput placeholder={t('schedules.searchTimeZone', 'Search time zones')} />
          <CommandList>
            <CommandEmpty>{t('schedules.noTimeZone', 'No matching time zone')}</CommandEmpty>
            {zones.map((zone) => (
              <CommandItem
                key={zone}
                value={zone}
                onSelect={() => {
                  onChange(zone);
                  setOpen(false);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{zone}</span>
                {zone === value ? <Check className="size-4 shrink-0" /> : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

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
    <div
      className={cn(
        'flex flex-wrap justify-end gap-1',
        grid && 'grid grid-cols-7 justify-items-end'
      )}
    >
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
            className={cn(
              'size-7 rounded-md text-[0.8em] font-normal tabular-nums transition-colors disabled:opacity-50',
              on
                ? 'bg-primary text-primary-foreground'
                : 'bg-foreground/[0.04] text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground dark:bg-white/[0.05] dark:hover:bg-white/[0.10]'
            )}
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
      className="overflow-hidden"
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
  disabled,
}: {
  value: ScheduleRecurrence;
  onChange: (next: ScheduleRecurrence) => void;
  now: number;
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
        <div className="flex items-center gap-2">
          <span className="truncate text-[0.9em] text-muted-foreground">
            {describeRecurrence(value, t, i18n.language)}
          </span>
          <button
            type="button"
            disabled={disabled}
            className="shrink-0 text-[0.9em] text-primary underline-offset-2 hover:underline disabled:opacity-50"
            onClick={() => onChange(changeScheduleRecurrenceKind(value, 'daily', now))}
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
        <Select
          value={value.kind}
          disabled={disabled}
          onValueChange={(kind) => {
            if ((SCHEDULE_RECURRENCE_KINDS as readonly string[]).includes(kind))
              onChange(
                changeScheduleRecurrenceKind(
                  value,
                  kind as Exclude<ScheduleRecurrenceKind, 'unsupported'>,
                  now
                )
              );
          }}
        >
          <SelectTrigger
            aria-label={t('schedules.repeat.label', 'Repeat')}
            className={ghostSelectTriggerClass}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCHEDULE_RECURRENCE_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {kindLabels[kind]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PropertyRow>

      <AnimatePresence initial={false} mode="popLayout">
        {value.kind === 'minutes' || value.kind === 'hours' ? (
          <Reveal id="every">
            <PropertyRow label={t('schedules.repeat.every', 'Every')}>
              <Select
                value={String(value.every)}
                disabled={disabled}
                // A controlled Select can emit '' while its option list is
                // swapped (hours → minutes); that is not a choice.
                onValueChange={(every) => {
                  const step = Number(every);
                  if (Number.isInteger(step) && step > 0) onChange({ ...value, every: step });
                }}
              >
                <SelectTrigger
                  aria-label={t('schedules.repeat.every', 'Every')}
                  className={ghostSelectTriggerClass}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(value.kind === 'minutes' ? SCHEDULE_MINUTE_STEPS : SCHEDULE_HOUR_STEPS).map(
                    (step) => (
                      <SelectItem key={step} value={String(step)}>
                        {value.kind === 'minutes'
                          ? t('schedules.everyMinutes', {
                              count: step,
                              defaultValue: '{{count}} minutes',
                            })
                          : t('schedules.everyHours', {
                              count: step,
                              defaultValue: '{{count}} hours',
                            })}
                      </SelectItem>
                    )
                  )}
                </SelectContent>
              </Select>
            </PropertyRow>
          </Reveal>
        ) : null}

        {value.kind === 'weekly' ? (
          <Reveal id="weekdays">
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
          <Reveal id="days">
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
          <Reveal id="time">
            <PropertyRow label={t('schedules.repeat.at', 'At')}>
              <div className="flex items-center gap-1">
                <input
                  type="time"
                  required
                  disabled={disabled}
                  aria-label={t('schedules.repeat.at', 'At')}
                  className={cn(ghostValueClass, 'w-auto')}
                  value={timeValue}
                  onChange={(event) => {
                    const [hour, minute] = event.target.value.split(':');
                    if (hour === undefined || minute === undefined) return;
                    onChange({ ...value, hour: Number(hour), minute: Number(minute) });
                  }}
                />
                <TimeZoneField
                  value={value.timeZone}
                  disabled={disabled}
                  label={t('schedules.timeZone', 'Time zone')}
                  onChange={(timeZone) => onChange({ ...value, timeZone })}
                />
              </div>
            </PropertyRow>
          </Reveal>
        ) : null}

        {value.kind === 'once' ? (
          <Reveal id="once">
            <PropertyRow
              label={t('schedules.repeat.runAt', 'Run at')}
              hint={t('schedules.deviceZone', 'This device’s time zone ({{zone}})', {
                zone: getDeviceTimeZone(),
              })}
            >
              <input
                type="datetime-local"
                required
                disabled={disabled}
                aria-label={t('schedules.repeat.runAt', 'Run at')}
                className={cn(ghostValueClass, 'w-auto')}
                value={toLocalInput(value.at)}
                onChange={(event) => {
                  if (!event.target.value) return;
                  onChange({ ...value, at: new Date(event.target.value).toISOString() });
                }}
              />
            </PropertyRow>
          </Reveal>
        ) : null}
      </AnimatePresence>
    </>
  );
}
