import { describe, expect, it } from 'vitest';
import { nextCronFireMs } from '../src/cron-next-fire';

/** Local-timezone-safe epoch ms for a given local date/time. */
function localMs(year: number, month1: number, day: number, hour: number, minute: number): number {
  return new Date(year, month1 - 1, day, hour, minute, 0, 0).getTime();
}

describe('nextCronFireMs — timezone', () => {
  // These pass explicit UTC epochs + an explicit IANA zone, so the result is independent of
  // the machine running the test. "0 9 * * *" fires at 09:00 in the given zone.
  const utc = (y: number, mo: number, d: number, h: number, mi: number) =>
    Date.UTC(y, mo - 1, d, h, mi);

  it('resolves the cron in the given zone, not the runner local zone', () => {
    // Summer: America/New_York is EDT (UTC-4), so 09:00 local = 13:00 UTC.
    const from = utc(2026, 7, 1, 0, 0); // 2026-06-30 20:00 EDT
    expect(nextCronFireMs('0 9 * * *', from, 'America/New_York')).toBe(utc(2026, 7, 1, 13, 0));
    // Asia/Shanghai (UTC+8, no DST): 09:00 local = 01:00 UTC.
    expect(nextCronFireMs('0 9 * * *', from, 'Asia/Shanghai')).toBe(utc(2026, 7, 1, 1, 0));
  });

  it('crosses a spring-forward DST boundary correctly', () => {
    // US DST 2026 begins Sun 2026-03-08. A daily 09:00 job spanning the boundary stays at
    // 09:00 local: 2026-03-07 is EST (14:00 UTC), 2026-03-09 is EDT (13:00 UTC).
    expect(nextCronFireMs('0 9 * * *', utc(2026, 3, 7, 15, 0), 'America/New_York')).toBe(
      utc(2026, 3, 8, 13, 0) // Mar 8 09:00 EDT
    );
  });

  it('falls back to the local zone for an unusable timezone', () => {
    const from = localMs(2026, 7, 1, 8, 0);
    expect(nextCronFireMs('0 9 * * *', from, 'Not/AZone')).toBe(nextCronFireMs('0 9 * * *', from));
  });
});
