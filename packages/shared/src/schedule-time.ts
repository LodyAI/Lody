import { Cron } from 'croner';

import {
  SCHEDULE_MISFIRE_GRACE_MS,
  ScheduleTriggerSchema,
  type ScheduleDefinition,
  type ScheduleTrigger,
} from './schedule-types';

function cron(trigger: Extract<ScheduleTrigger, { kind: 'cron' }>): Cron {
  // Croner also accepts seconds, years and extensions. Our persisted protocol
  // deliberately accepts only portable, standard five-field expressions.
  const fields = trigger.expression.trim().split(/\s+/);
  if (
    fields.length !== 5 ||
    fields.some((field) => !/^[\d*,/\-A-Za-z]+$/.test(field)) ||
    /[LW?#@+]/i.test(
      trigger.expression.replace(
        /(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|SUN|MON|TUE|WED|THU|FRI|SAT)/gi,
        ''
      )
    )
  ) {
    throw new Error('Schedule cron must use standard five-field syntax');
  }
  new Intl.DateTimeFormat('en', { timeZone: trigger.timeZone }).format(0);
  return new Cron(trigger.expression, {
    timezone: trigger.timeZone,
    paused: true,
    domAndDow: false,
  });
}

export function validateScheduleTrigger(value: unknown): ScheduleTrigger {
  const trigger = ScheduleTriggerSchema.parse(value);
  if (trigger.kind === 'cron') cron(trigger);
  return trigger;
}

/** First slot strictly after `after`, never before this activation. */
export function nextScheduleSlot(
  trigger: ScheduleTrigger,
  activeFrom: number,
  after: number
): number | undefined {
  const lower = Math.max(activeFrom, after + 1);
  if (trigger.kind === 'once') {
    const at = Date.parse(trigger.at);
    return at >= lower ? at : undefined;
  }
  if (trigger.kind === 'interval') {
    const anchor = Date.parse(trigger.anchorAt);
    return anchor + Math.max(0, Math.ceil((lower - anchor) / trigger.everyMs)) * trigger.everyMs;
  }
  const schedule = cron(trigger);
  let candidate = schedule.nextRun(new Date(lower - 1));
  // Croner shifts nonexistent wall times forward. Reject those candidates
  // using its matcher so the persisted policy is skip, not shift-to-03:30.
  while (candidate && !schedule.match(candidate)) candidate = schedule.nextRun(candidate);
  return candidate?.getTime();
}

/** Latest due slot in one calculation, without walking every missed minute. */
export function latestScheduleSlot(
  trigger: ScheduleTrigger,
  activeFrom: number,
  now: number
): number | undefined {
  let latest: number | undefined;
  if (trigger.kind === 'once') latest = Date.parse(trigger.at);
  else if (trigger.kind === 'interval') {
    const anchor = Date.parse(trigger.anchorAt);
    if (now >= anchor)
      latest = anchor + Math.floor((now - anchor) / trigger.everyMs) * trigger.everyMs;
  } else {
    const schedule = cron(trigger);
    let candidate = schedule.previousRuns(1, new Date(Math.floor(now / 1000) * 1000 + 1000))[0];
    while (candidate && !schedule.match(candidate))
      candidate = schedule.previousRuns(1, candidate)[0];
    latest = candidate?.getTime();
  }
  return latest !== undefined && latest >= activeFrom && latest <= now ? latest : undefined;
}

export function previewSchedule(
  trigger: ScheduleTrigger,
  activeFrom: number,
  now: number,
  count = 5
): number[] {
  if (!Number.isInteger(count) || count < 0 || count > 100)
    throw new Error('Invalid preview limit');
  const result: number[] = [];
  let after = now;
  for (let i = 0; i < count; i++) {
    const next = nextScheduleSlot(trigger, activeFrom, after);
    if (next === undefined) break;
    result.push(next);
    after = next;
  }
  return result;
}

export type ScheduleEvaluation = {
  evaluatedThrough?: number;
  nextScheduledAt?: number;
  due?: { scheduledFor: number; disposition: 'run' | 'skip' };
};

/** One fixed evaluation horizon; the ledger commits this cursor and intent atomically. */
export function evaluateSchedule(
  definition: ScheduleDefinition,
  lastSlot: number | undefined,
  now: number
): ScheduleEvaluation {
  const latest = latestScheduleSlot(definition.trigger, definition.activeFrom, now);
  const nextScheduledAt = nextScheduleSlot(definition.trigger, definition.activeFrom, now);
  if (
    !definition.enabled ||
    latest === undefined ||
    (lastSlot !== undefined && latest <= lastSlot)
  ) {
    return { evaluatedThrough: lastSlot, nextScheduledAt };
  }
  return {
    evaluatedThrough: latest,
    nextScheduledAt,
    due: {
      scheduledFor: latest,
      disposition:
        definition.misfirePolicy.kind === 'run_once' || now - latest <= SCHEDULE_MISFIRE_GRACE_MS
          ? 'run'
          : 'skip',
    },
  };
}
