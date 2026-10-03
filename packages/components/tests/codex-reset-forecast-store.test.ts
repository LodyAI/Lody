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
  it('starts idle and does not fetch until asked', () => {
    const { fetchStatus } = deferredFetcher();
    const store = createCodexResetForecastStore({ fetchStatus, now: () => 0 });

    expect(store.getState()).toEqual({ status: 'idle', data: null, error: null });
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  // Every surface a user opens calls `revalidate`, and several can open at once
  // (a popover in one tab, the settings list in another window).
  it('coalesces concurrent loads into one request and notifies subscribers', async () => {
    const { fetchStatus, pending } = deferredFetcher();
    const store = createCodexResetForecastStore({ fetchStatus, now: () => 0 });
    const listener = vi.fn();
    store.subscribe(listener);

    const waves = Array.from({ length: 12 }, () => store.revalidate());
    waves.push(store.refresh());

    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe('loading');

    pending[0].resolve({ status: status('6 hours'), etag: 'W/"1"', maxAgeMs: FOUR_HOURS_MS });
    await Promise.all(waves);

    expect(store.getState()).toEqual({ status: 'ready', data: status('6 hours'), error: null });
    expect(listener).toHaveBeenCalled();
  });

  // The endpoint serves a CDN-shaped 4h max-age. A user who opens the panel is
  // asking for the current forecast, so the store caps its own reuse well below
  // that; the request it then makes is conditional and normally answered 304.
  it('caps reuse of a served max-age far longer than a user would expect', async () => {
    const { fetchStatus, pending } = deferredFetcher();
    let nowMs = 1_000;
    const store = createCodexResetForecastStore({ fetchStatus, now: () => nowMs });

    const loaded = store.revalidate();
    pending[0].resolve({ status: status('6 hours'), etag: null, maxAgeMs: FOUR_HOURS_MS });
    await loaded;

    nowMs = 1_000 + FIVE_MINUTES_MS - 1;
    void store.revalidate();
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    nowMs = 1_000 + FIVE_MINUTES_MS;
    void store.revalidate();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  // A missing, absurd, or aggressive max-age must not turn into a poll loop or
  // a value that never refreshes.
  it.each([
    { maxAgeMs: null, expectedTtlMs: FIVE_MINUTES_MS, label: 'absent' },
    { maxAgeMs: 0, expectedTtlMs: 60 * 1000, label: 'zero' },
    { maxAgeMs: 2 * 60 * 1000, expectedTtlMs: 2 * 60 * 1000, label: 'a shorter one' },
    { maxAgeMs: 30 * 24 * 60 * 60 * 1000, expectedTtlMs: FIVE_MINUTES_MS, label: 'a month' },
  ])('clamps $label max-age', async ({ maxAgeMs, expectedTtlMs }) => {
    const { fetchStatus, pending } = deferredFetcher();
    let nowMs = 0;
    const store = createCodexResetForecastStore({ fetchStatus, now: () => nowMs });

    const loaded = store.revalidate();
    pending[0].resolve({ status: status('6 hours'), etag: null, maxAgeMs });
    await loaded;

    nowMs = expectedTtlMs - 1;
    void store.revalidate();
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    nowMs = expectedTtlMs;
    void store.revalidate();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it('revalidates with the last ETag and keeps the forecast on a 304', async () => {
    const { fetchStatus, pending, calls } = deferredFetcher();
    let nowMs = 0;
    const store = createCodexResetForecastStore({ fetchStatus, now: () => nowMs });

    const loaded = store.revalidate();
    pending[0].resolve({ status: status('6 hours'), etag: 'W/"abc"', maxAgeMs: 60_000 });
    await loaded;
    expect(calls[0]).toEqual({ etag: null });

    nowMs = 60_000;
    const revalidated = store.revalidate();
    expect(calls[1]).toEqual({ etag: 'W/"abc"' });
    pending[1].resolve({ status: null, etag: 'W/"abc"', maxAgeMs: 60_000 });
    await revalidated;

    expect(store.getState()).toEqual({ status: 'ready', data: status('6 hours'), error: null });

    // The 304 refreshed freshness, so nothing refetches until the TTL lapses again.
    nowMs = 60_000 + 59_999;
    void store.revalidate();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it('reports an error if a 304 arrives with nothing cached', async () => {
    const { fetchStatus, pending } = deferredFetcher();
    const store = createCodexResetForecastStore({ fetchStatus, now: () => 0 });

    const loaded = store.revalidate();
    pending[0].resolve({ status: null, etag: null, maxAgeMs: null });
    await loaded;

    expect(store.getState().status).toBe('error');
    expect(store.getState().data).toBeNull();
  });

  it('refresh ignores the TTL', async () => {
    const { fetchStatus, pending } = deferredFetcher();
    const store = createCodexResetForecastStore({ fetchStatus, now: () => 0 });

    const loaded = store.revalidate();
    pending[0].resolve({ status: status('6 hours'), etag: null, maxAgeMs: FOUR_HOURS_MS });
    await loaded;

    void store.refresh();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

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

  it('stops notifying an unsubscribed listener', async () => {
    const { fetchStatus, pending } = deferredFetcher();
    const store = createCodexResetForecastStore({ fetchStatus, now: () => 0 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    const loaded = store.revalidate();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    pending[0].resolve({ status: status('6 hours'), etag: null, maxAgeMs: null });
    await loaded;

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
