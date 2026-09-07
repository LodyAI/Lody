import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSessionRenderTraceForTest,
  getSessionRenderTraceText,
  recordSessionRenderTrace,
  shortTraceId,
} from '../src/lib/session-render-trace';
import { buildErrorBoundaryReport } from '../src/lib/error-boundary-report';

afterEach(() => {
  clearSessionRenderTraceForTest();
});

describe('session render trace', () => {
  it('is absent until something records', () => {
    expect(getSessionRenderTraceText()).toBeUndefined();
  });

  it('collapses consecutive identical lines into a repeat count', () => {
    // A steady-state render storm must not flush the interesting history out
    // of the ring; a LOOP then reads as alternating lines with ×N counts.
    recordSessionRenderTrace('detail a');
    recordSessionRenderTrace('detail a');
    recordSessionRenderTrace('detail a');
    recordSessionRenderTrace('surface mount b');
    const text = getSessionRenderTraceText()!;
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('detail a ×3');
    expect(lines[1]).toContain('surface mount b');
    expect(lines[1]).not.toContain('×');
  });

  it('keeps only the newest entries when the ring overflows', () => {
    for (let i = 0; i < 200; i += 1) {
      recordSessionRenderTrace(`line ${i}`);
    }
    const lines = getSessionRenderTraceText()!.split('\n');
    expect(lines).toHaveLength(120);
    expect(lines[0]).toContain('line 80');
    expect(lines[lines.length - 1]).toContain('line 199');
  });

  it('shortens ids and spells out absent ones', () => {
    expect(shortTraceId('51e236e0-b0d0-4c47-a74b-f8cfe2e97a91')).toBe('51e236e0');
    expect(shortTraceId(null)).toBe('∅');
    expect(shortTraceId(undefined)).toBe('∅');
  });

  it('rides into the error boundary report as its own section', () => {
    recordSessionRenderTrace('surface mount a');
    const report = buildErrorBoundaryReport({
      error: new Error('Minified React error #185'),
      boundaryName: 'AppContent',
      renderTrace: getSessionRenderTraceText(),
    });
    expect(report.text).toContain('Session render trace:');
    expect(report.text).toContain('surface mount a');
  });

  it('omits the report section when nothing was recorded', () => {
    const report = buildErrorBoundaryReport({
      error: new Error('boom'),
      renderTrace: getSessionRenderTraceText(),
    });
    expect(report.text).not.toContain('Session render trace:');
  });
});
