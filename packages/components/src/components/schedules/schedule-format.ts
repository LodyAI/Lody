import type { TFunction } from 'i18next';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import {
  getDeviceTimeZone,
  normalizeScheduleWeekdays,
  scheduleRecurrenceTimeZone,
  triggerToRecurrence,
  type ScheduleDestination,
  type ScheduleRecurrence,
  type ScheduleTrigger,
  type ScheduleWeekday,
} from '@lody/shared';

/**
 * One vocabulary for every schedule surface.
 *
 * The list, the editor summary and the run history all describe the same rule,
 * so they read it through the same functions. Nothing here formats a raw cron
 * expression at a person: an expression only appears when they chose Custom.
 *
 * Every entry point normalizes its `locale` argument first. Callers pass the
 * PRODUCT language (`i18n.language`), and Lody spells Chinese `zh_CN` — a value
 * every `Intl` constructor rejects with a RangeError. Normalizing here rather
 * than at each call site is deliberate: these are the only functions that
 * construct an `Intl` formatter, so one missed caller cannot crash a page.
 */
const intl = toIntlLocaleOrEn;

/** Locale weekday names, narrow for toggles and short for summaries. */
export function weekdayNames(
  locale: string | undefined,
  width: 'narrow' | 'short' | 'long'
): string[] {
  const format = new Intl.DateTimeFormat(intl(locale), { weekday: width, timeZone: 'UTC' });
  // 2023-01-01 was a Sunday, which is index 0 in the cron convention.
  return Array.from({ length: 7 }, (_, day) => format.format(new Date(Date.UTC(2023, 0, 1 + day))));
}

export function formatTimeOfDay(hour: number, minute: number, locale?: string): string {
  return new Intl.DateTimeFormat(intl(locale), {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2023, 0, 1, hour, minute)));
}

function formatWeekdayList(weekdays: readonly ScheduleWeekday[], locale?: string): string {
  const names = weekdayNames(locale, 'short');
  const list = normalizeScheduleWeekdays(weekdays).map((day) => names[day] ?? String(day));
  const conjunction = new Intl.ListFormat(intl(locale), { style: 'short', type: 'conjunction' });
  return conjunction.format(list);
}

/** Plain-language sentence for a rule, without its time zone. */
export function describeRecurrence(
  recurrence: ScheduleRecurrence,
  t: TFunction,
  locale?: string
): string {
  switch (recurrence.kind) {
    case 'minutes':
      return t('schedules.summary.interval', 'Every {{duration}}', {
        duration: t('schedules.everyMinutes', {
          count: recurrence.every,
          defaultValue: '{{count}} minutes',
        }),
      });
    case 'hours':
      return t('schedules.summary.interval', 'Every {{duration}}', {
        duration: t('schedules.everyHours', {
          count: recurrence.every,
          defaultValue: '{{count}} hours',
        }),
      });
    case 'daily':
      return t('schedules.summary.daily', 'Every day at {{time}}', {
        time: formatTimeOfDay(recurrence.hour, recurrence.minute, locale),
      });
    case 'weekdays':
      return t('schedules.summary.weekdays', 'Every weekday at {{time}}', {
        time: formatTimeOfDay(recurrence.hour, recurrence.minute, locale),
      });
    case 'weekly':
      return recurrence.weekdays.length
        ? t('schedules.summary.weekly', 'Every {{days}} at {{time}}', {
            days: formatWeekdayList(recurrence.weekdays, locale),
            time: formatTimeOfDay(recurrence.hour, recurrence.minute, locale),
          })
        : t('schedules.requireWeekday', 'Choose at least one day of the week.');
    case 'monthly':
      return recurrence.days.length
        ? t('schedules.summary.monthly', 'Day {{days}} of every month at {{time}}', {
            days: new Intl.ListFormat(intl(locale), { style: 'short', type: 'conjunction' }).format(
              recurrence.days.map(String)
            ),
            time: formatTimeOfDay(recurrence.hour, recurrence.minute, locale),
          })
        : t('schedules.requireMonthDay', 'Choose at least one day of the month.');
    case 'once':
      return t('schedules.summary.once', 'Once, on {{time}}', {
        time: formatInstant(Date.parse(recurrence.at), getDeviceTimeZone(), locale),
      });
    case 'unsupported':
      return t('schedules.summary.unsupported', 'Advanced rule ({{rule}})', {
        rule:
          recurrence.trigger.kind === 'cron'
            ? recurrence.trigger.expression
            : recurrence.trigger.kind === 'interval'
              ? t('schedules.everyMinutes', {
                  count: Math.round(recurrence.trigger.everyMs / 60_000),
                  defaultValue: '{{count}} minutes',
                })
              : recurrence.trigger.at,
      });
    default: {
      const unknown: never = recurrence;
      return unknown;
    }
  }
}

/** A trigger in words; a manual one has no rule to describe. */
export function describeTrigger(trigger: ScheduleTrigger, t: TFunction, locale?: string): string {
  if (trigger.kind === 'manual') return t('schedules.trigger.manual', 'Manual');
  return describeRecurrence(triggerToRecurrence(trigger), t, locale);
}

/** Where runs go, in words. */
export function describeDestination(destination: ScheduleDestination, t: TFunction): string {
  switch (destination.kind) {
    case 'new_session':
      return t('schedules.destination.newSession', 'New chat each run');
    case 'own_session':
      return t('schedules.destination.ownSession', 'One chat for this task');
    case 'existing_session':
      return t('schedules.destination.existingSession', 'An existing chat');
    default: {
      const unknown: never = destination;
      return unknown;
    }
  }
}

/** The zone a trigger's wall clock is authored in. */
export function triggerTimeZone(trigger: ScheduleTrigger): string {
  return trigger.kind === 'manual'
    ? getDeviceTimeZone()
    : scheduleRecurrenceTimeZone(triggerToRecurrence(trigger));
}

export function formatInstant(at: number, timeZone: string, locale?: string): string {
  return new Intl.DateTimeFormat(intl(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(at));
}

/** Short calendar-relative form for a next run: "Today 09:00", "Tue 09:00". */
export function formatUpcoming(at: number, timeZone: string, now: number, locale?: string): string {
  const language = intl(locale);
  // `en-CA` is a fixed ISO-shaped calendar key for comparing days, never shown.
  const day = (value: number) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(new Date(value));
  const time = new Intl.DateTimeFormat(language, {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(at));
  const today = day(now);
  const target = day(at);
  if (target === today) return time;
  const tomorrow = day(now + 86_400_000);
  const relative = new Intl.DateTimeFormat(language, {
    timeZone,
    ...(target === tomorrow
      ? {}
      : at - now < 6 * 86_400_000
        ? { weekday: 'short' }
        : { month: 'short', day: 'numeric' }),
  });
  const prefix =
    target === tomorrow
      ? new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(1, 'day')
      : relative.format(new Date(at));
  return `${prefix} ${time}`;
}

export type ScheduleStatusTone = 'active' | 'attention' | 'muted' | 'progress';
export type ScheduleStatus = { label: string; tone: ScheduleStatusTone };

/**
 * The one status a row shows. Paused wins over every queue state, because a
 * paused schedule's leftover runtime row is history, not a live plan.
 */
export function describeStatus(
  t: TFunction,
  enabled: boolean,
  queueState?: 'due' | 'waiting_for_agent' | 'retrying' | 'blocked'
): ScheduleStatus {
  if (!enabled) return { label: t('schedules.paused', 'Paused'), tone: 'muted' };
  if (queueState === 'blocked')
    return { label: t('schedules.state.blocked', 'Needs attention'), tone: 'attention' };
  if (queueState === 'retrying')
    return { label: t('schedules.state.retrying', 'Retrying dispatch'), tone: 'attention' };
  if (queueState === 'due') return { label: t('schedules.state.due', 'Due'), tone: 'progress' };
  if (queueState === 'waiting_for_agent')
    return { label: t('schedules.state.waiting_for_agent', 'Waiting for Agent'), tone: 'progress' };
  return { label: t('schedules.enabled', 'Enabled'), tone: 'active' };
}
