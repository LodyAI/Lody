import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getDeviceTimeZone,
  instantToZonedLocalInput,
  scheduleProposalRuleToTrigger,
  withScheduleRecurrenceTimeZone,
  zonedLocalInputToInstant,
} from '../src/schedule-recurrence';
import { nextScheduleSlot } from '../src/schedule-time';

describe('machine timezone hints when Intl has no default zone name', () => {
  afterEach(() => vi.restoreAllMocks());

  const withDefaultZoneName = (timeZone?: string) => {
    const Original = Intl.DateTimeFormat;
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
      ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
    ) {
      const formatter = new Original(...args);
      if (!args[1]?.timeZone) {
        const resolved = formatter.resolvedOptions();
        // Node returns undefined here for otherwise usable POSIX TZ settings.
        formatter.resolvedOptions = () => ({ ...resolved, timeZone: timeZone! });
      }
      return formatter;
    } as typeof Intl.DateTimeFormat);
  };

  it.each([
    'Asia/Hong_Kong',
    'Hongkong',
    'HKT-8',
    'HKT-08:00',
    ':/usr/share/zoneinfo/Asia/Hong_Kong',
    '/usr/share/zoneinfo/posix/Asia/Hong_Kong',
  ])('keeps machine-local 10 AM at 02:00 UTC with TZ=%s', (hint) => {
    withDefaultZoneName();
    const now = Date.parse('2026-10-18T00:00:00Z');
    const zone = getDeviceTimeZone(hint);
    const trigger = scheduleProposalRuleToTrigger(
      { kind: 'daily', hour: 10, minute: 0 },
      now,
      zone
    );
    expect(nextScheduleSlot(trigger, now, now)).toBe(Date.parse('2026-10-18T02:00:00Z'));
    expect(zonedLocalInputToInstant('2026-10-18T10:00', zone)).toBe(
      Date.parse('2026-10-18T02:00:00Z')
    );
  });

  it('preserves seasonal offsets for a named zoneinfo path', () => {
    withDefaultZoneName();
    const zone = getDeviceTimeZone(':/usr/share/zoneinfo/America/New_York');
    expect(zone).toBe('America/New_York');
    expect(zonedLocalInputToInstant('2026-01-18T10:00', zone)).toBe(
      Date.parse('2026-01-18T15:00:00Z')
    );
    expect(zonedLocalInputToInstant('2026-07-18T10:00', zone)).toBe(
      Date.parse('2026-07-18T14:00:00Z')
    );
  });

  it('prefers a detected zone over a hint', () => {
    withDefaultZoneName('America/New_York');
    expect(getDeviceTimeZone('HKT-8')).toBe('America/New_York');
  });
});

describe('proposed calendar times use the execution machine clock', () => {
  const now = Date.parse('2026-10-18T00:00:00Z');

  it.each([
    ['Asia/Hong_Kong', '2026-10-18T02:00:00Z'],
    ['Asia/Shanghai', '2026-10-18T02:00:00Z'],
    ['America/Los_Angeles', '2026-10-18T17:00:00Z'],
  ])('runs at machine-local 10 AM in %s when no zone is supplied', (zone, expected) => {
    const trigger = scheduleProposalRuleToTrigger(
      { kind: 'daily', hour: 10, minute: 0 },
      now,
      zone
    );
    expect(trigger).toEqual({ kind: 'cron', expression: '0 10 * * *', timeZone: zone });
    expect(nextScheduleSlot(trigger, now, now)).toBe(Date.parse(expected));
  });

  it('preserves an explicitly requested UTC time', () => {
    const trigger = scheduleProposalRuleToTrigger(
      { kind: 'daily', hour: 10, minute: 0, timeZone: 'UTC' },
      now,
      'Asia/Shanghai'
    );
    expect(nextScheduleSlot(trigger, now, now)).toBe(Date.parse('2026-10-18T10:00:00Z'));
  });
});

describe('reading a one-off time on the target machine clock', () => {
  it('saves Hong Kong 10 AM as 02:00 UTC and displays it as 10 AM', () => {
    const at = zonedLocalInputToInstant('2026-10-18T10:00', 'Asia/Hong_Kong');
    expect(at).toBe(Date.parse('2026-10-18T02:00:00Z'));
    expect(instantToZonedLocalInput(at!, 'Asia/Hong_Kong')).toBe('2026-10-18T10:00');
    expect(
      nextScheduleSlot(
        { kind: 'once', at: new Date(at!).toISOString() },
        0,
        Date.parse('2026-10-18T00:00:00Z')
      )
    ).toBe(at);
  });

  it('round-trips a wall time in a zone other than the device', () => {
    const at = zonedLocalInputToInstant('2026-09-24T09:30', 'Asia/Shanghai');
    expect(at).toBe(Date.UTC(2026, 8, 24, 1, 30));
    expect(instantToZonedLocalInput(at!, 'Asia/Shanghai')).toBe('2026-09-24T09:30');
    expect(instantToZonedLocalInput(at!, 'America/New_York')).toBe('2026-09-23T21:30');
  });

  it('settles on the right offset on both sides of a DST change', () => {
    // New York leaves DST on 2026-11-01 at 02:00 local.
    expect(zonedLocalInputToInstant('2026-10-31T09:00', 'America/New_York')).toBe(
      Date.UTC(2026, 9, 31, 13, 0)
    );
    expect(zonedLocalInputToInstant('2026-11-02T09:00', 'America/New_York')).toBe(
      Date.UTC(2026, 10, 2, 14, 0)
    );
  });

  it('rejects malformed input instead of guessing', () => {
    expect(zonedLocalInputToInstant('', 'UTC')).toBeNull();
    expect(zonedLocalInputToInstant('2026-09-24 09:30', 'UTC')).toBeNull();
  });

  it('moves a DST gap forward and chooses the earlier instant in a fold', () => {
    const zone = 'America/Los_Angeles';
    const gap = zonedLocalInputToInstant('2026-03-08T02:30', zone)!;
    expect(gap).toBe(Date.parse('2026-03-08T10:30:00Z'));
    expect(instantToZonedLocalInput(gap, zone)).toBe('2026-03-08T03:30');
    expect(zonedLocalInputToInstant('2026-11-01T01:30', zone)).toBe(
      Date.parse('2026-11-01T08:30:00Z')
    );
  });
});

describe('moving a rule onto the machine clock', () => {
  it('re-zones wall-clock and step rules but leaves instants and legacy rules alone', () => {
    expect(
      withScheduleRecurrenceTimeZone(
        { kind: 'daily', hour: 9, minute: 0, timeZone: 'UTC' },
        'Asia/Shanghai'
      )
    ).toEqual({ kind: 'daily', hour: 9, minute: 0, timeZone: 'Asia/Shanghai' });
    expect(
      withScheduleRecurrenceTimeZone({ kind: 'hours', every: 6, timeZone: 'UTC' }, 'Asia/Tokyo')
    ).toEqual({ kind: 'hours', every: 6, timeZone: 'Asia/Tokyo' });
    const once = { kind: 'once', at: '2026-09-24T01:30:00.000Z' } as const;
    expect(withScheduleRecurrenceTimeZone(once, 'Asia/Tokyo')).toBe(once);
  });
});
