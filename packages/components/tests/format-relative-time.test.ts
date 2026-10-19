import { describe, expect, it } from 'vitest';
import { formatCompactRelativeTime } from '../src/lib/format-relative-time';

const now = new Date('2026-10-12T00:00:00.000Z');
const DAY_MS = 86_400_000;

function daysAgo(days: number): number {
  return now.getTime() - days * DAY_MS;
}

describe('formatCompactRelativeTime', () => {
  it('keeps whole-week labels through the end of the fourth week', () => {
    expect(formatCompactRelativeTime(daysAgo(27), now)).toBe('3w');
    expect(formatCompactRelativeTime(daysAgo(28), now)).toBe('4w');
    expect(formatCompactRelativeTime(daysAgo(29), now)).toBe('4w');
    expect(formatCompactRelativeTime(daysAgo(30), now)).toBe('1mo');
  });

  it('keeps whole-month labels through the end of the twelfth month', () => {
    expect(formatCompactRelativeTime(daysAgo(359), now)).toBe('11mo');
    expect(formatCompactRelativeTime(daysAgo(360), now)).toBe('12mo');
    expect(formatCompactRelativeTime(daysAgo(364), now)).toBe('12mo');
    expect(formatCompactRelativeTime(daysAgo(365), now)).toBe('1y');
  });
});
