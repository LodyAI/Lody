import { describe, expect, it } from 'vitest';
import { formatConversationTimestamp } from '../src/lib/format-conversation-timestamp';

const now = new Date(2026, 6, 14, 12, 0);
const options = { locale: 'zh-CN', now } as const;

describe('formatConversationTimestamp', () => {
  it('shows only the time for today', () => {
    expect(formatConversationTimestamp(new Date(2026, 6, 14, 9, 30), options)).toBe('09:30');
  });

  it('shows the weekday and time for the previous six calendar days', () => {
    expect(formatConversationTimestamp(new Date(2026, 6, 13, 9, 30), options)).toBe('星期一 09:30');
    expect(formatConversationTimestamp(new Date(2026, 6, 8, 9, 30), options)).toBe('星期三 09:30');
  });

  it('shows month, day, and time after the recent-week window', () => {
    expect(formatConversationTimestamp(new Date(2026, 6, 7, 9, 30), options)).toBe('7/7 09:30');
    expect(formatConversationTimestamp(new Date(2025, 11, 31, 9, 30), options)).toBe('12/31 09:30');
    expect(formatConversationTimestamp(new Date(2025, 6, 15, 9, 30), options)).toBe('7/15 09:30');
  });

  it('adds the year starting from the same date in the previous year', () => {
    expect(formatConversationTimestamp(new Date(2025, 6, 14, 9, 30), options)).toBe(
      '2025/7/14 09:30'
    );
    expect(formatConversationTimestamp(new Date(2024, 11, 31, 9, 30), options)).toBe(
      '2024/12/31 09:30'
    );
  });

  it('clamps the previous-year cutoff for leap day and ignores invalid input', () => {
    expect(
      formatConversationTimestamp(new Date(2023, 1, 28, 9, 30), {
        locale: 'zh-CN',
        now: new Date(2024, 1, 29, 12, 0),
      })
    ).toBe('2023/2/28 09:30');
    expect(formatConversationTimestamp('not-a-date', options)).toBe('');
  });
});
