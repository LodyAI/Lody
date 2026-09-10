import { describe, expect, it } from 'vitest';
import { formatUsdCompact } from '../src/lib/format-compact-number';

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
});
