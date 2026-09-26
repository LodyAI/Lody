import { describe, expect, it } from 'vitest';
import {
  instantToZonedLocalInput,
  withScheduleRecurrenceTimeZone,
  zonedLocalInputToInstant,
} from '../src/schedule-recurrence';

describe('reading a one-off time on the target machine clock', () => {
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
