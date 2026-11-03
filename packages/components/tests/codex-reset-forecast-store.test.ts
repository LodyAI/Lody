import { describe, expect, it, vi } from 'vitest';

import type {
  CodexResetStatus,
  CodexResetStatusFetchResult,
} from '../src/lib/codex-reset-forecast';
import { createCodexResetForecastStore } from '../src/lib/codex-reset-forecast-store';

const status = (windowText: string): CodexResetStatus => ({
  watch: {
    level: 'elevated',
    chancePercent: 40,
    windowText,
    observedAtIso: '2026-08-20T05:00:00.000Z',
    observedAtMs: Date.parse('2026-08-20T05:00:00.000Z'),
    expiresAtIso: '2026-08-20T11:00:00.000Z',
    expiresAtMs: Date.parse('2026-08-20T11:00:00.000Z'),
    text: 'text',
    source: null,
  },
  scheduledReset: null,
  latestReset: null,
});

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
/** The store's own cap on how stale a user-initiated read may be. */
const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** A fetcher whose promises are resolved by the test, not by a timer. */
const deferredFetcher = () => {
  const pending: Array<{
    resolve: (value: CodexResetStatusFetchResult) => void;
    reject: (error: Error) => void;
  }> = [];
  const calls: Array<{ etag: string | null }> = [];
  const fetchStatus = vi.fn((options: { etag: string | null }) => {
    calls.push({ etag: options.etag });
    return new Promise<CodexResetStatusFetchResult>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  });
  return { fetchStatus, pending, calls };
};

describe('createCodexResetForecastStore', () => {
  // A failed refresh must not blank a forecast the user is already looking at.
  it('keeps the last forecast when a refresh fails, then recovers', async () => {
    const { fetchStatus, pending } = deferredFetcher();
    const store = createCodexResetForecastStore({ fetchStatus, now: () => 0 });

    const loaded = store.revalidate();
    pending[0].resolve({ status: status('6 hours'), etag: null, maxAgeMs: 60_000 });
    await loaded;

    const failing = store.refresh();
    pending[1].reject(new Error('offline'));
    await failing;

    expect(store.getState()).toEqual({
      status: 'error',
      data: status('6 hours'),
      error: 'offline',
    });

    const recovered = store.refresh();
    pending[2].resolve({ status: status('2 days'), etag: null, maxAgeMs: 60_000 });
    await recovered;

    expect(store.getState()).toEqual({ status: 'ready', data: status('2 days'), error: null });
  });
});
