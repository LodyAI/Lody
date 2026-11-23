import { describe, expect, it } from 'vitest';
import { buildScrollEdgeFadeMask } from '../src/lib/scroll-edge-fade';

describe('buildScrollEdgeFadeMask', () => {
  it('skips the mask when nothing overflows', () => {
    expect(buildScrollEdgeFadeMask({ top: false, bottom: false }, 20)).toBeUndefined();
  });

  it('does not put a zero-length transparent stop on a list parked at the top', () => {
    const mask = buildScrollEdgeFadeMask({ top: false, bottom: true }, 20);
    expect(mask).toBe(
      'linear-gradient(to bottom, #000 0, #000 calc(100% - 20px), transparent 100%)'
    );
    expect(mask).not.toContain('transparent 0, #000 0');
  });

  it('fades only the top when the strip is scrolled to the end', () => {
    expect(buildScrollEdgeFadeMask({ top: true, bottom: false }, 20)).toBe(
      'linear-gradient(to bottom, transparent 0, #000 20px, #000 100%)'
    );
  });

  it('fades both edges when the strip overflows each way', () => {
    expect(buildScrollEdgeFadeMask({ top: true, bottom: true }, 24)).toBe(
      'linear-gradient(to bottom, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%)'
    );
  });
});
