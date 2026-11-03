import { describe, expect, it } from 'vitest';

import {
  resolveLiveSessionHistoryDurationMs,
  resolveSessionHistoryDurationMs,
} from '../src/lib/session-history-duration';

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

describe('resolveLiveSessionHistoryDurationMs', () => {
  it('counts from the turn start while the turn is still running', () => {
    expect(resolveLiveSessionHistoryDurationMs({ timestamp: OPENED }, OPENED_MS + 41_000)).toBe(
      41_000
    );
  });

  it('subtracts the permission wait recorded so far, like the finished form', () => {
    // Same turn, same anchor: the number must not jump when `endedAt` lands.
    const live = resolveLiveSessionHistoryDurationMs(
      { timestamp: OPENED, permissionWaitMs: 9_000 },
      OPENED_MS + 30_000
    );
    const finished = resolveSessionHistoryDurationMs({
      timestamp: OPENED,
      endedAt: OPENED_MS + 30_000,
      permissionWaitMs: 9_000,
    });
    expect(live).toBe(21_000);
    expect(live).toBe(finished);
  });

  it('clamps a start in the future to 0 rather than blanking the slot', () => {
    // The finished form returns null on the same inversion; the live slot is
    // reserved either way, so an empty string there reads as a layout bug.
    expect(resolveLiveSessionHistoryDurationMs({ timestamp: OPENED }, OPENED_MS - 5_000)).toBe(0);
  });

  it('has nothing to show for an unparseable turn timestamp', () => {
    expect(resolveLiveSessionHistoryDurationMs({ timestamp: 'not-a-date' }, OPENED_MS)).toBeNull();
  });
});
