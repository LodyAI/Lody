import { describe, expect, it } from 'vitest';

import {
  applyScheduleRecurrence,
  changeScheduleRecurrenceKind,
  defaultScheduleRecurrence,
  previewSchedule,
  recurrenceToTrigger,
  sameScheduleRecurrence,
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
  it('names the rules a person can pick', () => {
    expect(triggerToRecurrence(cron('0 9 * * *'))).toEqual({
      kind: 'daily',
      hour: 9,
      minute: 0,
      timeZone: ZONE,
    });
    expect(triggerToRecurrence(cron('30 7 * * 1-5'))).toEqual({
      kind: 'weekdays',
      hour: 7,
      minute: 30,
      timeZone: ZONE,
    });
    expect(triggerToRecurrence(cron('0 9 * * MON-FRI')).kind).toBe('weekdays');
    expect(triggerToRecurrence(cron('15 18 * * SUN,WED'))).toEqual({
      kind: 'weekly',
      weekdays: [0, 3],
      hour: 18,
      minute: 15,
      timeZone: ZONE,
    });
    expect(triggerToRecurrence(cron('0 9 1,15 * *'))).toEqual({
      kind: 'monthly',
      days: [1, 15],
      hour: 9,
      minute: 0,
      timeZone: ZONE,
    });
    expect(triggerToRecurrence(cron('*/15 * * * *'))).toEqual({
      kind: 'minutes',
      every: 15,
      timeZone: ZONE,
    });
    expect(triggerToRecurrence(cron('0 */2 * * *'))).toEqual({
      kind: 'hours',
      every: 2,
      timeZone: ZONE,
    });
  });

  it('reads intervals back as minute or hour steps', () => {
    expect(
      triggerToRecurrence({
        kind: 'interval',
        everyMs: 7 * 60_000,
        anchorAt: '2026-09-06T00:00:00Z',
      })
    ).toMatchObject({ kind: 'minutes', every: 7 });
    expect(
      triggerToRecurrence({
        kind: 'interval',
        everyMs: 5 * 3_600_000,
        anchorAt: '2026-09-06T00:00:00Z',
      })
    ).toMatchObject({ kind: 'hours', every: 5 });
  });

  it('expands a weekday range before folding 7 onto Sunday', () => {
    // Standard cron accepts 0 AND 7 for Sunday, so `0-7` and `1-7` are every
    // day. Normalizing the bound first collapsed `0-7` to the range 0-0 and
    // read it as "Sundays only".
    expect(triggerToRecurrence(cron('0 9 * * 0-7')).kind).toBe('daily');
    expect(triggerToRecurrence(cron('0 9 * * 1-7')).kind).toBe('daily');
    expect(triggerToRecurrence(cron('0 9 * * 5-7'))).toMatchObject({
      kind: 'weekly',
      weekdays: [0, 5, 6],
    });
    expect(triggerToRecurrence(cron('0 9 * * 7'))).toMatchObject({ kind: 'weekly', weekdays: [0] });
  });

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

  it('round-trips every named rule back to the same instants', () => {
    const triggers: ScheduleTrigger[] = [
      cron('0 9 * * *'),
      cron('30 7 * * 1-5'),
      cron('0 9 * * MON-FRI'),
      cron('0 9 * * 0-7'),
      cron('0 9 * * 5-7'),
      cron('15 18 * * SUN,WED'),
      cron('0 9 1,15 * *'),
      cron('0 9 28 * *'),
      cron('*/15 * * * *'),
      cron('0 */6 * * *'),
      { kind: 'once', at: '2026-09-07T01:00:00.000Z' },
    ];
    for (const trigger of triggers) {
      const replayed = recurrenceToTrigger(triggerToRecurrence(timed(trigger)), NOW);
      expect(previewSchedule(replayed, 0, NOW, 8)).toEqual(previewSchedule(trigger, 0, NOW, 8));
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

  it('refuses a rule with no day selected', () => {
    expect(() =>
      recurrenceToTrigger({ kind: 'weekly', weekdays: [], hour: 9, minute: 0, timeZone: ZONE }, NOW)
    ).toThrow(/at least one day/i);
    expect(() =>
      recurrenceToTrigger({ kind: 'monthly', days: [], hour: 9, minute: 0, timeZone: ZONE }, NOW)
    ).toThrow(/at least one day/i);
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

  it('rewrites only the part the person changed', () => {
    const stored = cron('0 9 * * MON-FRI');
    const edited = { ...triggerToRecurrence(stored), hour: 18 } as ScheduleRecurrence;
    expect(applyScheduleRecurrence(edited, NOW, stored)).toEqual(cron('0 18 * * 1-5'));
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

  it('never rewrites a manual trigger from a recurrence it did not come from', () => {
    const manual: ScheduleTrigger = { kind: 'manual' };
    expect(applyScheduleRecurrence(defaultScheduleRecurrence(ZONE), NOW, manual)).toMatchObject({
      kind: 'cron',
    });
  });
});

describe('switching between kinds', () => {
  it('carries the time of day across kinds that have one', () => {
    const start: ScheduleRecurrence = { kind: 'daily', hour: 7, minute: 30, timeZone: ZONE };
    expect(changeScheduleRecurrenceKind(start, 'weekly', NOW)).toEqual({
      kind: 'weekly',
      weekdays: [new Date(NOW).getDay()],
      hour: 7,
      minute: 30,
      timeZone: ZONE,
    });
    expect(changeScheduleRecurrenceKind(start, 'monthly', NOW)).toEqual({
      kind: 'monthly',
      days: [new Date(NOW).getDate()],
      hour: 7,
      minute: 30,
      timeZone: ZONE,
    });
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

  it('is a no-op for the current kind and anchors instants on the injected clock', () => {
    const current = defaultScheduleRecurrence(ZONE);
    expect(changeScheduleRecurrenceKind(current, 'daily', NOW)).toBe(current);
    expect(changeScheduleRecurrenceKind(current, 'once', NOW)).toEqual({
      kind: 'once',
      at: new Date(NOW + 3_600_000).toISOString(),
    });
    expect(changeScheduleRecurrenceKind(current, 'minutes', NOW)).toEqual({
      kind: 'minutes',
      every: 15,
      timeZone: ZONE,
    });
    expect(changeScheduleRecurrenceKind(current, 'hours', NOW)).toEqual({
      kind: 'hours',
      every: 1,
      timeZone: ZONE,
    });
  });
});

describe('recurrence equality', () => {
  it('ignores day order and duplicates', () => {
    expect(
      sameScheduleRecurrence(
        { kind: 'weekly', weekdays: [3, 1], hour: 9, minute: 0, timeZone: ZONE },
        { kind: 'weekly', weekdays: [1, 3, 3], hour: 9, minute: 0, timeZone: ZONE }
      )
    ).toBe(true);
    expect(
      sameScheduleRecurrence(
        { kind: 'monthly', days: [15, 1], hour: 9, minute: 0, timeZone: ZONE },
        { kind: 'monthly', days: [1, 15], hour: 9, minute: 0, timeZone: ZONE }
      )
    ).toBe(true);
  });

  it('separates rules that differ only by zone', () => {
    expect(
      sameScheduleRecurrence(
        { kind: 'daily', hour: 9, minute: 0, timeZone: ZONE },
        { kind: 'daily', hour: 9, minute: 0, timeZone: 'Europe/Berlin' }
      )
    ).toBe(false);
  });
});
