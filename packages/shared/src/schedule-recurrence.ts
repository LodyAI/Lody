import type { ScheduleProposalRule } from './ai';
import { validateScheduleTrigger } from './schedule-time';
import type { ScheduleTrigger } from './schedule-types';

/**
 * The human-facing shape of a time rule.
 *
 * The persisted protocol stays `once | interval | cron` — cron already
 * expresses everything the picker offers, and widening the stored union would
 * force every reader (CLI engine, ledger, MCP) to learn a second calendar.
 * This module is the single, tested translation between what a person picks
 * and what the machine executes, in both directions.
 *
 * The picker deliberately offers only the rules people actually set. A stored
 * trigger it cannot name is surfaced as `unsupported`, shown read-only with the
 * trigger kept verbatim — it is never rewritten, and it can be replaced with a
 * named rule but not edited as cron.
 */
export type ScheduleWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type ScheduleTimeOfDay = {
  /** 0–23, in `timeZone`. */
  hour: number;
  /** 0–59, in `timeZone`. */
  minute: number;
  /** IANA zone the wall time is authored in. */
  timeZone: string;
};

export type ScheduleRecurrence =
  /** Zone matters for alignment: `0 *​/6` at Shanghai and at UTC differ. */
  | { kind: 'minutes'; every: number; timeZone: string }
  | { kind: 'hours'; every: number; timeZone: string }
  | ({ kind: 'daily' } & ScheduleTimeOfDay)
  | ({ kind: 'weekdays' } & ScheduleTimeOfDay)
  | ({ kind: 'weekly'; weekdays: ScheduleWeekday[] } & ScheduleTimeOfDay)
  | ({ kind: 'monthly'; days: number[] } & ScheduleTimeOfDay)
  | { kind: 'once'; at: string }
  | { kind: 'unsupported'; trigger: TimedScheduleTrigger };

export type ScheduleRecurrenceKind = ScheduleRecurrence['kind'];
export type TimedScheduleTrigger = Exclude<ScheduleTrigger, { kind: 'manual' }>;

/** Menu order: the common answers first. `unsupported` is never offered. */
export const SCHEDULE_RECURRENCE_KINDS = [
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'hours',
  'minutes',
  'once',
] as const satisfies readonly Exclude<ScheduleRecurrenceKind, 'unsupported'>[];

export const SCHEDULE_WEEKDAYS: readonly ScheduleWeekday[] = [0, 1, 2, 3, 4, 5, 6];

/** Minute steps offered for "every N minutes"; all divide the hour evenly. */
export const SCHEDULE_MINUTE_STEPS = [5, 10, 15, 20, 30] as const;
/** Hour steps offered for "every N hours"; all divide the day evenly. */
export const SCHEDULE_HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;

const CRON_DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const WORKWEEK: readonly ScheduleWeekday[] = [1, 2, 3, 4, 5];

function parseFixedNumber(field: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

/** `N` from `*​/N`, or null. */
function parseStep(field: string): number | null {
  const match = /^\*\/(\d{1,2})$/.exec(field);
  const value = match ? Number(match[1]) : NaN;
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * A day-of-week token as cron writes it: 0–7, where 0 AND 7 both mean Sunday.
 *
 * Folding 7 onto 0 here would be wrong, because a RANGE is expanded from these
 * bounds: `0-7` and `1-7` are every day, and normalizing the upper bound first
 * turned `0-7` into the empty-looking range 0-0 and read it as "Sundays only".
 * Normalization happens after expansion, in `parseWeekdayField`.
 */
function parseWeekdayToken(token: string): number | null {
  const named = CRON_DAY_NAMES.indexOf(token.toUpperCase());
  if (named >= 0) return named;
  if (!/^\d$/.test(token)) return null;
  const value = Number(token);
  return value <= 7 ? value : null;
}

/**
 * Expand a day-of-week field into a normalized Sunday=0 set.
 *
 * Deliberately conservative: step syntax and wrap-around ranges return `null`
 * so the rule stays `unsupported` rather than being approximated.
 */
function parseWeekdayField(field: string): ScheduleWeekday[] | null {
  const found = new Set<ScheduleWeekday>();
  // Sunday is 0 or 7; fold only after the range has been expanded.
  const add = (day: number) => found.add((day % 7) as ScheduleWeekday);
  for (const part of field.split(',')) {
    if (part.includes('/') || part === '') return null;
    const bounds = part.split('-');
    if (bounds.length === 1) {
      const single = parseWeekdayToken(bounds[0]!);
      if (single === null) return null;
      add(single);
      continue;
    }
    if (bounds.length !== 2) return null;
    const from = parseWeekdayToken(bounds[0]!);
    const to = parseWeekdayToken(bounds[1]!);
    if (from === null || to === null || from > to) return null;
    for (let day = from; day <= to; day++) add(day);
  }
  return found.size ? [...found].sort((a, b) => a - b) : null;
}

/** A day-of-month field as a sorted set: `1,15`, `5`, `1-3`. */
function parseDayOfMonthField(field: string): number[] | null {
  const found = new Set<number>();
  for (const part of field.split(',')) {
    if (part.includes('/') || part === '') return null;
    const bounds = part.split('-');
    if (bounds.length > 2) return null;
    const from = parseFixedNumber(bounds[0]!, 1, 31);
    const to = bounds.length === 2 ? parseFixedNumber(bounds[1]!, 1, 31) : from;
    if (from === null || to === null || from > to) return null;
    for (let day = from; day <= to; day++) found.add(day);
  }
  return found.size ? [...found].sort((a, b) => a - b) : null;
}

export function normalizeScheduleWeekdays(weekdays: readonly ScheduleWeekday[]): ScheduleWeekday[] {
  return [...new Set(weekdays)].sort((a, b) => a - b);
}

function sameNumberSet(a: readonly number[], b: readonly number[]): boolean {
  const left = [...new Set(a)].sort((x, y) => x - y);
  const right = [...new Set(b)].sort((x, y) => x - y);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function getDeviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Interpretation of a timed trigger a person can read and edit field by field. */
export function triggerToRecurrence(trigger: TimedScheduleTrigger): ScheduleRecurrence {
  if (trigger.kind === 'once') return { kind: 'once', at: trigger.at };
  const unsupported: ScheduleRecurrence = { kind: 'unsupported', trigger };
  if (trigger.kind === 'interval') {
    // Interval carries the steps that do not divide the clock evenly.
    if (trigger.everyMs % 3_600_000 === 0)
      return { kind: 'hours', every: trigger.everyMs / 3_600_000, timeZone: getDeviceTimeZone() };
    if (trigger.everyMs % 60_000 === 0)
      return { kind: 'minutes', every: trigger.everyMs / 60_000, timeZone: getDeviceTimeZone() };
    return unsupported;
  }
  const fields = trigger.expression.trim().split(/\s+/);
  if (fields.length !== 5) return unsupported;
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (monthField !== '*') return unsupported;
  const unrestrictedDays = dayField === '*' && weekdayField === '*';
  const minuteStep = parseStep(minuteField);
  if (minuteStep !== null)
    return hourField === '*' && unrestrictedDays
      ? { kind: 'minutes', every: minuteStep, timeZone: trigger.timeZone }
      : unsupported;
  const hourStep = parseStep(hourField);
  if (hourStep !== null)
    return minuteField === '0' && unrestrictedDays
      ? { kind: 'hours', every: hourStep, timeZone: trigger.timeZone }
      : unsupported;
  const minute = parseFixedNumber(minuteField, 0, 59);
  const hour = parseFixedNumber(hourField, 0, 23);
  if (minute === null || hour === null) return unsupported;
  const time: ScheduleTimeOfDay = { hour, minute, timeZone: trigger.timeZone };
  if (dayField === '*') {
    if (weekdayField === '*') return { kind: 'daily', ...time };
    const weekdays = parseWeekdayField(weekdayField);
    if (!weekdays) return unsupported;
    if (sameNumberSet(weekdays, WORKWEEK)) return { kind: 'weekdays', ...time };
    if (weekdays.length === 7) return { kind: 'daily', ...time };
    return { kind: 'weekly', weekdays, ...time };
  }
  if (weekdayField !== '*') return unsupported;
  const days = parseDayOfMonthField(dayField);
  return days ? { kind: 'monthly', days, ...time } : unsupported;
}

/**
 * The trigger a recurrence means. Throws with an actionable message when the
 * recurrence is not yet complete.
 *
 * `now` anchors an interval whose step does not divide the clock; a step that
 * does is written as cron so it stays clock-aligned (every 15 minutes means
 * :00 :15 :30 :45, not fifteen minutes after whenever it was saved).
 */
export function recurrenceToTrigger(recurrence: ScheduleRecurrence, now: number): ScheduleTrigger {
  switch (recurrence.kind) {
    case 'once':
      return validateScheduleTrigger({ kind: 'once', at: recurrence.at });
    case 'unsupported':
      return validateScheduleTrigger(recurrence.trigger);
    case 'minutes': {
      if (!Number.isInteger(recurrence.every) || recurrence.every < 1)
        throw new Error('Choose how many minutes');
      return 60 % recurrence.every === 0
        ? validateScheduleTrigger({
            kind: 'cron',
            expression: `*/${recurrence.every} * * * *`,
            timeZone: recurrence.timeZone,
          })
        : validateScheduleTrigger({
            kind: 'interval',
            everyMs: recurrence.every * 60_000,
            anchorAt: new Date(now).toISOString(),
          });
    }
    case 'hours': {
      if (!Number.isInteger(recurrence.every) || recurrence.every < 1)
        throw new Error('Choose how many hours');
      return 24 % recurrence.every === 0
        ? validateScheduleTrigger({
            kind: 'cron',
            expression: `0 */${recurrence.every} * * *`,
            timeZone: recurrence.timeZone,
          })
        : validateScheduleTrigger({
            kind: 'interval',
            everyMs: recurrence.every * 3_600_000,
            anchorAt: new Date(now).toISOString(),
          });
    }
    default: {
      const weekdayField =
        recurrence.kind === 'weekdays'
          ? '1-5'
          : recurrence.kind === 'weekly'
            ? normalizeScheduleWeekdays(recurrence.weekdays).join(',')
            : '*';
      if (!weekdayField) throw new Error('Choose at least one day of the week');
      const dayField =
        recurrence.kind === 'monthly'
          ? [...new Set(recurrence.days)].sort((a, b) => a - b).join(',')
          : '*';
      if (!dayField) throw new Error('Choose at least one day of the month');
      return validateScheduleTrigger({
        kind: 'cron',
        expression: `${recurrence.minute} ${recurrence.hour} ${dayField} * ${weekdayField}`,
        timeZone: recurrence.timeZone,
      });
    }
  }
}

export function sameScheduleRecurrence(a: ScheduleRecurrence, b: ScheduleRecurrence): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'once':
      return a.at === (b as typeof a).at;
    case 'minutes':
    case 'hours':
      return a.every === (b as typeof a).every && a.timeZone === (b as typeof a).timeZone;
    case 'unsupported':
      return JSON.stringify(a.trigger) === JSON.stringify((b as typeof a).trigger);
    default: {
      const other = b as typeof a;
      if (a.hour !== other.hour || a.minute !== other.minute || a.timeZone !== other.timeZone)
        return false;
      if (a.kind === 'weekly') return sameNumberSet(a.weekdays, (other as typeof a).weekdays);
      if (a.kind === 'monthly') return sameNumberSet(a.days, (other as typeof a).days);
      return true;
    }
  }
}

/**
 * Trigger for a saved edit.
 *
 * When the person did not touch the time rule, the previously stored trigger is
 * returned unchanged — opening a `MON-FRI` schedule and pressing Save must not
 * rewrite it to `1-5` and invalidate its fingerprint, and an unsupported rule
 * is never rewritten at all.
 */
export function applyScheduleRecurrence(
  recurrence: ScheduleRecurrence,
  now: number,
  previous?: ScheduleTrigger
): ScheduleTrigger {
  if (
    previous &&
    previous.kind !== 'manual' &&
    sameScheduleRecurrence(triggerToRecurrence(previous), recurrence)
  )
    return previous;
  return recurrenceToTrigger(recurrence, now);
}

export function defaultScheduleRecurrence(timeZone = getDeviceTimeZone()): ScheduleRecurrence {
  return { kind: 'daily', hour: 9, minute: 0, timeZone };
}

function timeOfDayOf(recurrence: ScheduleRecurrence): ScheduleTimeOfDay {
  if (recurrence.kind === 'once') {
    const at = new Date(recurrence.at);
    return { hour: at.getHours(), minute: at.getMinutes(), timeZone: getDeviceTimeZone() };
  }
  if (recurrence.kind === 'minutes' || recurrence.kind === 'hours')
    return { hour: 9, minute: 0, timeZone: recurrence.timeZone };
  if (recurrence.kind === 'unsupported')
    return {
      hour: 9,
      minute: 0,
      timeZone:
        recurrence.trigger.kind === 'cron' ? recurrence.trigger.timeZone : getDeviceTimeZone(),
    };
  return { hour: recurrence.hour, minute: recurrence.minute, timeZone: recurrence.timeZone };
}

/**
 * Switch the picker between kinds while carrying over everything the new kind
 * can still hold, so changing "Every day" to "Every week" does not reset 07:30
 * back to a default.
 */
export function changeScheduleRecurrenceKind(
  current: ScheduleRecurrence,
  kind: Exclude<ScheduleRecurrenceKind, 'unsupported'>,
  now: number
): ScheduleRecurrence {
  if (current.kind === kind) return current;
  const time = timeOfDayOf(current);
  switch (kind) {
    case 'daily':
      return { kind, ...time };
    case 'weekdays':
      return { kind, ...time };
    case 'weekly':
      return {
        kind,
        weekdays:
          current.kind === 'weekdays' ? [...WORKWEEK] : [new Date(now).getDay() as ScheduleWeekday],
        ...time,
      };
    case 'monthly':
      return { kind, days: [new Date(now).getDate()], ...time };
    case 'hours':
      return { kind, every: 1, timeZone: time.timeZone };
    case 'minutes':
      return { kind, every: 15, timeZone: time.timeZone };
    case 'once':
      return { kind, at: new Date(now + 3_600_000).toISOString() };
  }
  throw new Error('Unsupported schedule recurrence');
}

/** The zone a recurrence's wall clock is read in; instants and steps use the device. */
export function scheduleRecurrenceTimeZone(recurrence: ScheduleRecurrence): string {
  switch (recurrence.kind) {
    case 'once':
      return getDeviceTimeZone();
    case 'unsupported':
      return recurrence.trigger.kind === 'cron' ? recurrence.trigger.timeZone : getDeviceTimeZone();
    default:
      return recurrence.timeZone;
  }
}

/**
 * A proposed rule as the editor's recurrence, or `null` for `manual`.
 *
 * The proposal leaves the zone to the person's device unless the agent was told
 * one; steps take the same zone so `0 *​/6` stays aligned to that clock.
 */
export function scheduleProposalRuleToRecurrence(
  rule: ScheduleProposalRule,
  deviceTimeZone = getDeviceTimeZone()
): ScheduleRecurrence | null {
  switch (rule.kind) {
    case 'manual':
      return null;
    case 'minutes':
      return { kind: 'minutes', every: rule.every, timeZone: deviceTimeZone };
    case 'hours':
      return { kind: 'hours', every: rule.every, timeZone: deviceTimeZone };
    case 'once':
      return { kind: 'once', at: rule.at };
    case 'daily':
    case 'weekdays':
      return {
        kind: rule.kind,
        hour: rule.hour,
        minute: rule.minute,
        timeZone: rule.timeZone ?? deviceTimeZone,
      };
    case 'weekly':
      return {
        kind: 'weekly',
        weekdays: normalizeScheduleWeekdays(rule.weekdays as ScheduleWeekday[]),
        hour: rule.hour,
        minute: rule.minute,
        timeZone: rule.timeZone ?? deviceTimeZone,
      };
    case 'monthly':
      return {
        kind: 'monthly',
        days: [...new Set(rule.days)].sort((a, b) => a - b),
        hour: rule.hour,
        minute: rule.minute,
        timeZone: rule.timeZone ?? deviceTimeZone,
      };
  }
  throw new Error('Unsupported schedule proposal rule');
}

/** The trigger a proposed rule means, given the person's zone. */
export function scheduleProposalRuleToTrigger(
  rule: ScheduleProposalRule,
  now: number,
  deviceTimeZone = getDeviceTimeZone()
): ScheduleTrigger {
  const recurrence = scheduleProposalRuleToRecurrence(rule, deviceTimeZone);
  return recurrence ? recurrenceToTrigger(recurrence, now) : { kind: 'manual' };
}

/**
 * The same rule read on another machine's clock.
 *
 * Schedules run on the owning machine, so a wall-clock rule is authored in that
 * machine's zone rather than the viewer's — there is no zone picker. Steps take
 * the zone too (`0 *​/6` aligns to that clock). `once` is an instant and an
 * `unsupported` rule is kept verbatim, so neither changes.
 */
export function withScheduleRecurrenceTimeZone(
  recurrence: ScheduleRecurrence,
  timeZone: string
): ScheduleRecurrence {
  if (recurrence.kind === 'once' || recurrence.kind === 'unsupported') return recurrence;
  return recurrence.timeZone === timeZone ? recurrence : { ...recurrence, timeZone };
}

const wallClockParts = (ms: number, timeZone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(ms)
      .map((part) => [part.type, part.value])
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
};

/** `YYYY-MM-DDTHH:mm` as the wall clock in `timeZone` shows `ms`. */
export function instantToZonedLocalInput(ms: number, timeZone: string): string {
  const p = wallClockParts(ms, timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * The instant a `YYYY-MM-DDTHH:mm` wall time in `timeZone` names, or `null` for
 * malformed input. A time skipped by a DST gap resolves forward, the same as a
 * browser's local `datetime-local`.
 */
export function zonedLocalInputToInstant(value: string, timeZone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (ms: number) => {
    const p = wallClockParts(ms, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
  };
  // Two passes settle the offset on either side of a DST transition.
  let instant = asUtc - offsetAt(asUtc);
  instant = asUtc - offsetAt(instant);
  return Number.isFinite(instant) ? instant : null;
}
