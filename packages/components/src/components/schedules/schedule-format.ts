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
  type ScheduleRegistryRow,
  type ScheduleRuntimeRow,
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

// Intl formatters are expensive to build and the list formats every row on
// every render; keep one per locale + options.
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const dateFormat = (locale: string, options: Intl.DateTimeFormatOptions) => {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (!format) dateFormats.set(key, (format = new Intl.DateTimeFormat(locale, options)));
  return format;
};

/** Locale weekday names, narrow for toggles and short for summaries. */
export function weekdayNames(
  locale: string | undefined,
  width: 'narrow' | 'short' | 'long'
): string[] {
  const format = dateFormat(intl(locale), { weekday: width, timeZone: 'UTC' });
  // 2023-01-01 was a Sunday, which is index 0 in the cron convention.
  return Array.from({ length: 7 }, (_, day) => format.format(new Date(Date.UTC(2023, 0, 1 + day))));
}

export function formatTimeOfDay(hour: number, minute: number, locale?: string): string {
  return dateFormat(intl(locale), {
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

/** Plain-language rule; a Once summary names the zone used to display its instant. */
export function describeRecurrence(
  recurrence: ScheduleRecurrence,
  t: TFunction,
  locale?: string,
  timeZone = scheduleRecurrenceTimeZone(recurrence)
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
        time: `${formatInstant(Date.parse(recurrence.at), timeZone, locale)} (${timeZone})`,
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
export function describeTrigger(
  trigger: ScheduleTrigger,
  t: TFunction,
  locale?: string,
  timeZone = triggerTimeZone(trigger)
): string {
  if (trigger.kind === 'manual') return t('schedules.trigger.manual', 'Manual');
  return describeRecurrence(triggerToRecurrence(trigger), t, locale, timeZone);
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

/** The display clock; calendar triggers retain their authored zone. */
export function triggerTimeZone(
  trigger: ScheduleTrigger,
  machineTimeZone = getDeviceTimeZone()
): string {
  return trigger.kind === 'cron' ? trigger.timeZone : machineTimeZone;
}

/**
 * A list row's display clock. A one-time scheduled message is personal, so its
 * instant reads on the viewer's current clock; other schedules keep the target
 * machine's clock (and calendar rules keep their authored zone).
 */
export function scheduleRowTimeZone(
  row: Pick<ScheduleRegistryRow, 'scheduledMessage' | 'trigger'>,
  machineTimeZone = getDeviceTimeZone(),
  viewerTimeZone?: string
): string {
  return row.scheduledMessage
    ? (viewerTimeZone ?? getDeviceTimeZone(machineTimeZone))
    : triggerTimeZone(row.trigger, machineTimeZone);
}

export function formatInstant(at: number, timeZone: string, locale?: string): string {
  return dateFormat(intl(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(at));
}

/** A clock time with its zone, for a compact "send at 2:31 PM UTC" action. */
export function formatClockWithZone(at: number, timeZone: string, locale?: string): string {
  const time = dateFormat(intl(locale), {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(at));
  const zone = dateFormat(intl(locale), {
    timeZone,
    timeZoneName: 'short',
  })
    .formatToParts(new Date(at))
    .find((part) => part.type === 'timeZoneName')?.value;
  return zone ? `${time} ${zone}` : time;
}

/** Short calendar-relative form for a next run: "Today 09:00", "Tue 09:00". */
export function formatUpcoming(at: number, timeZone: string, now: number, locale?: string): string {
  const language = intl(locale);
  // `en-CA` is a fixed ISO-shaped calendar key for comparing days, never shown.
  const day = (value: number) =>
    dateFormat('en-CA', { timeZone, dateStyle: 'short' }).format(new Date(value));
  const time = dateFormat(language, {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(at));
  const today = day(now);
  const target = day(at);
  if (target === today) return time;
  const tomorrow = day(now + 86_400_000);
  const relative = dateFormat(language, {
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

export type ScheduleStatusTone = 'normal' | 'muted' | 'progress' | 'attention';
/** Glyph beside a status that needs a second look; the happy path has none. */
export type ScheduleStatusIcon = 'due' | 'paused' | 'attention' | 'sent' | 'cancelled';
/**
 * What a schedule is doing, in words: a main line and an optional detail.
 * Colour and a glyph only mark states that need a look, so the list needs no
 * legend.
 */
export type ScheduleStatus = {
  label: string;
  detail?: string;
  tone: ScheduleStatusTone;
  icon?: ScheduleStatusIcon;
  /**
   * Bucket for the list's status filter. `ended` is finished for good: a sent,
   * cancelled or failed message, or a Once task that ran.
   */
  group: 'running' | 'paused' | 'attention' | 'ended';
};

/**
 * The one status every surface shows. Paused wins over every queue state,
 * because a paused schedule's leftover runtime row is history, not a live plan.
 */
export function describeScheduleState(
  t: TFunction,
  row: Pick<ScheduleRegistryRow, 'enabled' | 'trigger' | 'scheduledMessage'>,
  runtime: ScheduleRuntimeRow | undefined,
  options: { timeZone: string; now: number; locale?: string }
): ScheduleStatus {
  const { timeZone, now, locale } = options;
  const at = (value: number) => formatUpcoming(value, timeZone, now, locale);
  const blockedDetail =
    (runtime?.blockedCode && t(`schedules.errors.${runtime.blockedCode}`, '')) || undefined;
  if (row.scheduledMessage) {
    const planned = row.trigger.kind === 'once' ? Date.parse(row.trigger.at) : undefined;
    switch (runtime?.messageState ?? 'pending') {
      case 'sent':
        return {
          label: t('schedules.status.sent', 'Sent'),
          detail: runtime?.lastDispatch ? at(runtime.lastDispatch.dispatchedAt) : undefined,
          tone: 'muted',
          icon: 'sent',
          group: 'ended',
        };
      case 'cancelled':
        return {
          label: t('schedules.status.cancelled', 'Cancelled'),
          detail:
            planned !== undefined
              ? t('schedules.status.wasPlanned', 'Was due {{time}}', { time: at(planned) })
              : undefined,
          tone: 'muted',
          icon: 'cancelled',
          group: 'ended',
        };
      case 'failed':
        return {
          label: t('schedules.status.notSent', 'Not sent'),
          detail: blockedDetail,
          tone: 'attention',
          icon: 'attention',
          group: 'ended',
        };
      default:
        if (!row.enabled)
          return {
            label: t('schedules.status.cancelling', 'Cancelling…'),
            tone: 'muted',
            group: 'paused',
          };
        return {
          label:
            planned !== undefined
              ? t('schedules.status.sendsAt', 'Sends {{time}}', { time: at(planned) })
              : t('schedules.status.waiting', 'Waiting to send'),
          tone: 'normal',
          group: 'running',
        };
    }
  }
  if (!row.enabled)
    return {
      label: t('schedules.paused', 'Paused'),
      tone: 'muted',
      icon: 'paused',
      group: 'paused',
    };
  if (runtime?.queueState === 'blocked')
    return {
      label: t('schedules.state.blocked', 'Needs attention'),
      detail: blockedDetail,
      tone: 'attention',
      icon: 'attention',
      group: 'attention',
    };
  if (runtime?.queueState === 'retrying')
    return {
      label: t('schedules.state.retrying', 'Retrying dispatch'),
      tone: 'attention',
      icon: 'attention',
      group: 'attention',
    };
  const next = runtime?.nextScheduledAt;
  if (runtime?.queueState === 'due' || runtime?.queueState === 'waiting_for_agent')
    return {
      label:
        runtime.queueState === 'due'
          ? t('schedules.state.due', 'Due')
          : t('schedules.state.waiting_for_agent', 'Waiting for Agent'),
      detail: next != null ? at(next) : undefined,
      tone: 'progress',
      icon: 'due',
      group: 'running',
    };
  const last = runtime?.lastDispatch;
  if (row.trigger.kind === 'manual')
    return {
      label: t('schedules.status.manual', 'Run manually'),
      detail: last
        ? t('schedules.status.lastRan', 'Last ran {{time}}', { time: at(last.dispatchedAt) })
        : undefined,
      tone: 'muted',
      group: 'running',
    };
  if (next != null)
    return {
      label: t('schedules.status.runsAt', 'Runs {{time}}', { time: at(next) }),
      tone: 'normal',
      group: 'running',
    };
  if (row.trigger.kind === 'once' && last)
    return {
      label: t('schedules.status.done', 'Done'),
      detail: at(last.dispatchedAt),
      tone: 'muted',
      icon: 'sent',
      group: 'ended',
    };
  return {
    label: t('schedules.notScheduledYet', 'Not scheduled yet'),
    detail: t('schedules.awaitingMachine', 'Waiting for the machine to check the schedule'),
    tone: 'muted',
    group: 'running',
  };
}
