import { describe, expect, it } from 'vitest';
import { formatUsdCompact } from '../src/lib/format-compact-number';

describe('formatUsdCompact', () => {
  it('keeps small amounts exact, where the cents are the point', () => {
    expect(formatUsdCompact(0, 'en')).toBe('$0.00');
    expect(formatUsdCompact(0.42, 'en')).toBe('$0.42');
    expect(formatUsdCompact(12.5, 'en')).toBe('$12.50');
    expect(formatUsdCompact(999.99, 'en')).toBe('$999.99');
  });

  it('compacts from a thousand up, so the string stops growing with the number', () => {
    expect(formatUsdCompact(1000, 'en')).toBe('$1K');
    expect(formatUsdCompact(5297.05, 'en')).toBe('$5.3K');
    expect(formatUsdCompact(1_234_567.89, 'en')).toBe('$1.2M');
    expect(formatUsdCompact(1_234_567_890, 'en')).toBe('$1.2B');
  });

  it('never exceeds the width a fixed-format card budgets for a headline', () => {
    // The 16:9 card shares one row between the headline and the stat cells; an
    // uncompacted figure closed that gap to nothing at nine figures.
    for (const value of [1e3, 1e6, 1e9, 1e12]) {
      expect(formatUsdCompact(value, 'en').length).toBeLessThanOrEqual(8);
    }
  });

  it('follows the product language rather than the host locale', () => {
    expect(formatUsdCompact(120_000_000, 'zh-CN')).toContain('亿');
    expect(formatUsdCompact(120_000_000, 'en')).toBe('$120M');
  });

  it('treats a non-finite amount as zero rather than printing NaN', () => {
    expect(formatUsdCompact(Number.NaN, 'en')).toBe('$0.00');
  });
});
