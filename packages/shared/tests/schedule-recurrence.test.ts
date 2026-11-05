import { describe, expect, it } from 'vitest';

import {
  applyScheduleRecurrence,
  changeScheduleRecurrenceKind,
  previewSchedule,
  recurrenceToTrigger,
  triggerToRecurrence,
  type ScheduleRecurrence,
  type ScheduleTrigger,
} from '../src';

const ZONE = 'Asia/Shanghai';
/** Fixed instant so every expectation is reproducible: 2026-09-06T12:00Z. */
const NOW = Date.parse('2026-09-06T12:00:00.000Z');

const cron = (expression: string, timeZone = ZONE): ScheduleTrigger => ({
  kind: 'cron',
  expression,
  timeZone,
});
const timed = (trigger: ScheduleTrigger) => trigger as Exclude<ScheduleTrigger, { kind: 'manual' }>;

describe('recurrence ⇄ trigger mapping', () => {
  it('keeps a rule it cannot name verbatim, read-only', () => {
    for (const expression of [
      '0 9,17 * * *',
      '0 9 1 1 *',
      '0 9 1 * 1',
      '0 9 * * MON#2',
      '0 9 * * FRI-MON',
      '*/20 9-17 * * 1-5',
      '15 */2 * * *',
    ]) {
      const trigger = cron(expression);
      const recurrence = triggerToRecurrence(trigger);
      expect(recurrence).toEqual({ kind: 'unsupported', trigger });
      // Saving without replacing it re-emits exactly what was stored.
      expect(applyScheduleRecurrence(recurrence, NOW, trigger)).toBe(trigger);
    }
  });

  it('writes steps that divide the clock as aligned cron, others as intervals', () => {
    expect(recurrenceToTrigger({ kind: 'minutes', every: 15, timeZone: ZONE }, NOW)).toEqual(
      cron('*/15 * * * *')
    );
    expect(recurrenceToTrigger({ kind: 'minutes', every: 7, timeZone: ZONE }, NOW)).toEqual({
      kind: 'interval',
      everyMs: 7 * 60_000,
      anchorAt: new Date(NOW).toISOString(),
    });
    expect(recurrenceToTrigger({ kind: 'hours', every: 6, timeZone: ZONE }, NOW)).toEqual(
      cron('0 */6 * * *')
    );
    expect(recurrenceToTrigger({ kind: 'hours', every: 5, timeZone: ZONE }, NOW)).toMatchObject({
      kind: 'interval',
      everyMs: 5 * 3_600_000,
    });
  });
});

describe('editing an existing schedule', () => {
  it('returns the stored trigger untouched when the rule was not edited', () => {
    // `MON-FRI` and `1-5` are the same rule; re-saving must not rewrite the
    // stored expression, which would invalidate the definition fingerprint.
    const stored = cron('0 9 * * MON-FRI');
    expect(applyScheduleRecurrence(triggerToRecurrence(stored), NOW, stored)).toBe(stored);
    const interval: ScheduleTrigger = {
      kind: 'interval',
      everyMs: 7 * 60_000,
      anchorAt: '2026-01-01T00:00:00.000Z',
    };
    // Same for an interval: the anchor must not move to "now" on a no-op save.
    expect(applyScheduleRecurrence(triggerToRecurrence(interval), NOW, interval)).toBe(interval);
  });

  it('replays a Sunday-7 range on the same days after a time or zone edit', () => {
    for (const expression of ['0 9 * * 0-7', '0 9 * * 1-7', '0 9 * * 5-7', '0 9 * * 7']) {
      const stored = cron(expression);
      const recurrence = triggerToRecurrence(stored);
      const laterHour = recurrenceToTrigger({ ...recurrence, hour: 18 } as ScheduleRecurrence, NOW);
      const days = (trigger: ScheduleTrigger) =>
        previewSchedule(trigger, 0, NOW, 8).map((at) => new Date(at).getUTCDay());
      expect(days(laterHour)).toEqual(days(cron(expression.replace('0 9', '0 18'))));
      expect(new Set(days(laterHour))).toEqual(new Set(days(stored)));
    }
  });
});

describe('switching between kinds', () => {
  it('carries a Once wall time and calendar defaults on the selected machine clock', () => {
    const once: ScheduleRecurrence = { kind: 'once', at: '2026-10-01T09:21:00Z' };
    const now = Date.parse('2026-10-01T00:30:00Z');
    expect(changeScheduleRecurrenceKind(once, 'daily', now, 'America/Los_Angeles')).toEqual({
      kind: 'daily',
      hour: 2,
      minute: 21,
      timeZone: 'America/Los_Angeles',
    });
    expect(changeScheduleRecurrenceKind(once, 'daily', now, 'Asia/Singapore')).toEqual({
      kind: 'daily',
      hour: 17,
      minute: 21,
      timeZone: 'Asia/Singapore',
    });
    expect(changeScheduleRecurrenceKind(once, 'weekly', now, 'America/Los_Angeles')).toMatchObject({
      weekdays: [3],
      hour: 2,
      minute: 21,
    });
    expect(changeScheduleRecurrenceKind(once, 'monthly', now, 'America/Los_Angeles')).toMatchObject(
      {
        days: [30],
      }
    );
    const daily = changeScheduleRecurrenceKind(once, 'daily', now, 'America/Los_Angeles');
    const back = changeScheduleRecurrenceKind(daily, 'once', now, 'America/Los_Angeles');
    expect(back).toEqual({ kind: 'once', at: '2026-10-01T01:30:00.000Z' });
  });

  it('promotes weekdays to a pre-filled Mon–Fri weekly rule', () => {
    expect(
      changeScheduleRecurrenceKind(
        { kind: 'weekdays', hour: 9, minute: 0, timeZone: ZONE },
        'weekly',
        NOW
      )
    ).toEqual({ kind: 'weekly', weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 0, timeZone: ZONE });
  });
});
