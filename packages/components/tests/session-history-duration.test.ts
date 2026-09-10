import { describe, expect, it } from 'vitest';

import { resolveSessionHistoryDurationMs } from '../src/lib/session-history-duration';

const OPENED = '2026-01-01T00:00:00.000Z';
const OPENED_MS = Date.parse(OPENED);

describe('resolveSessionHistoryDurationMs', () => {
  it('returns endedAt - timestamp when no permission wait was recorded', () => {
    expect(
      resolveSessionHistoryDurationMs({
        timestamp: OPENED,
        endedAt: OPENED_MS + 29_000,
      })
    ).toBe(29_000);
  });

  it('subtracts a recorded permission wait from Worked-for', () => {
    // Live: 1 minute at the plan card (62269ms) plus ~25s of actual work.
    expect(
      resolveSessionHistoryDurationMs({
        timestamp: OPENED,
        endedAt: OPENED_MS + 87_000,
        permissionWaitMs: 62_269,
      })
    ).toBe(87_000 - 62_269);
  });

  it('clamps to 0 when the wait is longer than the span', () => {
    expect(
      resolveSessionHistoryDurationMs({
        timestamp: OPENED,
        endedAt: OPENED_MS + 10_000,
        permissionWaitMs: 12_000,
      })
    ).toBe(0);
  });
});
