import { describe, expect, it } from 'vitest';
import {
  formatCompactNumber,
  formatUsdAmount,
  formatUsdCompact,
  formatUsdTight,
} from '../src/lib/format-compact-number';
import { formatConversationTimestamp } from '../src/lib/format-conversation-timestamp';

describe('format-compact-number', () => {
  describe('formatCompactNumber', () => {
    it('uses English compact units for English locales', () => {
      expect(formatCompactNumber(1_200, 'en')).toBe('1.2K');
      expect(formatCompactNumber(1_200_000, 'en')).toBe('1.2M');
      expect(formatCompactNumber(100_000_000, 'en')).toBe('100M');
      expect(formatCompactNumber(1_200_000_000, 'en')).toBe('1.2B');
    });

    it('uses Chinese compact units for zh-CN', () => {
      expect(formatCompactNumber(15_000, 'zh-CN')).toBe('1.5万');
      expect(formatCompactNumber(100_000_000, 'zh-CN')).toBe('1亿');
      expect(formatCompactNumber(1_200_000_000, 'zh-CN')).toBe('12亿');
    });

    it('does not fall back to the host OS locale when locale is omitted', () => {
      // Defaulting to English prevents Chinese units from leaking into English UI
      // on zh-CN systems when a caller forgets to pass the product language.
      expect(formatCompactNumber(100_000_000, undefined)).toBe('100M');
      expect(formatCompactNumber(100_000_000, null)).toBe('100M');
    });
  });

  describe('formatUsdAmount', () => {
    it('keeps sub-cent precision for tiny daily costs', () => {
      expect(formatUsdAmount(0.004, 'en')).toBe('$0.004');
    });
  });
});

describe('format-usd-compact', () => {
  describe('formatUsdCompact', () => {
    it('keeps small amounts exact, where the cents are the point', () => {
      expect(formatUsdCompact(0, 'en')).toBe('$0.00');
      expect(formatUsdCompact(0.42, 'en')).toBe('$0.42');
      expect(formatUsdCompact(12.5, 'en')).toBe('$12.50');
      expect(formatUsdCompact(999.99, 'en')).toBe('$999.99');
    });

    it('keeps every digit up to a billion, dropping only the cents', () => {
      // Choosing cost as the measure is usually about showing the digits, so the
      // figure survives; on a four-figure sum the cents are noise.
      expect(formatUsdCompact(1000, 'en')).toBe('$1,000');
      expect(formatUsdCompact(5297.05, 'en')).toBe('$5,297');
      expect(formatUsdCompact(1_234_567.89, 'en')).toBe('$1,234,568');
      expect(formatUsdCompact(999_999_999, 'en')).toBe('$999,999,999');
    });

    it('compacts past a billion, where the digits become a wall', () => {
      expect(formatUsdCompact(1_234_567_890, 'en')).toBe('$1.2B');
    });

    it('never exceeds the width a fixed-format card budgets for a headline', () => {
      // The 16:9 card shares one row between the headline and the stat cells; an
      // unbounded figure closed that gap to nothing and then overlapped it.
      for (const value of [1e3, 1e6, 999_999_999, 1e12]) {
        expect(formatUsdCompact(value, 'en').length).toBeLessThanOrEqual(12);
      }
    });

    it('follows the product language rather than the host locale', () => {
      expect(formatUsdCompact(120_000_000_000, 'zh-CN')).toContain('亿');
      expect(formatUsdCompact(1_200_000_000, 'en')).toBe('$1.2B');
    });

    it('treats a non-finite amount as zero rather than printing NaN', () => {
      expect(formatUsdCompact(Number.NaN, 'en')).toBe('$0.00');
    });

    it('gives narrow slots a form that cannot outgrow them', () => {
      // A stat cell gets a quarter of the headline's width; spelling the figure out
      // there produced "$42,040…", and an ellipsis on a number is a wrong number.
      expect(formatUsdTight(176_568, 'en')).toBe('$176.6K');
      expect(formatUsdTight(5_297_047, 'en')).toBe('$5.3M');
      // Small amounts still say exactly what they are.
      expect(formatUsdTight(36.88, 'en')).toBe('$36.88');
      for (const value of [1e3, 1e6, 1e9, 1e12]) {
        expect(formatUsdTight(value, 'en').length).toBeLessThanOrEqual(8);
      }
    });
  });
});

describe('format-conversation-timestamp', () => {
  const now = new Date(2026, 6, 14, 12, 0);
  const options = { locale: 'zh-CN', now } as const;

  describe('formatConversationTimestamp', () => {
    it('shows only the time for today', () => {
      expect(formatConversationTimestamp(new Date(2026, 6, 14, 9, 30), options)).toBe('09:30');
    });

    it('shows the weekday and time for the previous six calendar days', () => {
      expect(formatConversationTimestamp(new Date(2026, 6, 13, 9, 30), options)).toBe(
        '星期一 09:30'
      );
      expect(formatConversationTimestamp(new Date(2026, 6, 8, 9, 30), options)).toBe(
        '星期三 09:30'
      );
    });

    it('shows month, day, and time after the recent-week window', () => {
      expect(formatConversationTimestamp(new Date(2026, 6, 7, 9, 30), options)).toBe('7/7 09:30');
      expect(formatConversationTimestamp(new Date(2025, 11, 31, 9, 30), options)).toBe(
        '12/31 09:30'
      );
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
});
