// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createIrohDaily,
  observeIrohDaily,
  IROH_DAY_MS,
  IROH_STATS_KEY,
  installIrohDailyRecorder,
  recordIrohObservation,
} from '../src/lib/iroh-daily';

function device() {
  let time = 1_000;
  let online = true;
  let accepted = true;
  let sequence = 0;
  const saved = new Map<string, string>();
  const events: Record<string, unknown>[] = [];
  const ids: string[] = [];
  let tail = Promise.resolve();
  const options = {
    now: () => time,
    storage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value);
      },
    },
    exclusive: <T>(run: () => Promise<T>): Promise<T> => {
      const next = tail.then(run);
      tail = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    },
    digest: async (text: string) => createHash('sha256').update(text).digest('hex'),
    random: () => `random-${sequence++}`,
    online: () => online,
    enqueue: (properties: Record<string, unknown>, eventId: string) => {
      if (!accepted) return false;
      events.push(properties);
      ids.push(eventId);
      return true;
    },
    platform: 'desktop' as const,
    version: () => '1.2.3',
  };
  return {
    options,
    events,
    ids,
    saved,
    advance: (ms: number) => {
      time += ms;
    },
    offline: () => {
      online = false;
    },
    reconnect: () => {
      online = true;
    },
    refuse: () => {
      accepted = false;
    },
    accept: () => {
      accepted = true;
    },
  };
}
const success = {
  kind: 'dispatch',
  outcome: 'iroh_ok',
  target: 'private-machine',
  elapsedMs: 199,
  path: 'direct',
} as const;

describe('device iroh daily product diagnostics', () => {
  it('a device with no completed encrypted RPC never starts report checks or emits daily events', async () => {
    vi.useFakeTimers();
    const fixture = device();
    const daily = createIrohDaily(fixture.options);
    const reporting = observeIrohDaily(daily, window, document);
    try {
      await daily.hasActivity();
      expect(vi.getTimerCount()).toBe(0);
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
      fixture.advance(4 * IROH_DAY_MS);
      await vi.advanceTimersByTimeAsync(4 * IROH_DAY_MS);
      await daily.check();
      expect(fixture.events).toEqual([]);
      expect(fixture.saved.size).toBe(0);
      await daily.record(success);
      reporting.activate();
      await daily.hasActivity();
      expect(vi.getTimerCount()).toBe(1);
      reporting.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      reporting.dispose();
      vi.useRealTimers();
    }
  });

  it('completed E2EE routes keep attempts/success pairs and the fallback subset in the same daily window', async () => {
    const fixture = device();
    const daily = createIrohDaily(fixture.options);
    await daily.record(success);
    for (const outcome of [
      'fallback_not_ready',
      'fallback_call_failed',
      'fallback_unverified',
      'unavailable',
      'chunked',
    ] as const)
      for (const success of [true, false])
        await daily.record({
          kind: 'feature',
          outcome,
          connected: outcome === 'fallback_call_failed' || outcome === 'fallback_unverified',
          target: 'local-only',
          streams: { success },
        });
    fixture.advance(IROH_DAY_MS);
    await daily.check();
    const event = fixture.events[0]!;
    expect(event).toMatchObject({
      iroh_attempts: 7,
      iroh_ready: 5,
      iroh_success: 1,
      streams_attempts: 10,
      streams_success: 5,
      fallback_streams_attempts: 6,
      fallback_streams_success: 3,
      dispatch_iroh_attempts: 1,
      dispatch_iroh_ready: 1,
      dispatch_iroh_success: 1,
      feature_iroh_attempts: 6,
      feature_iroh_ready: 4,
      feature_iroh_success: 0,
      feature_streams_attempts: 10,
      feature_streams_success: 5,
      feature_fallback_streams_attempts: 6,
      feature_fallback_streams_success: 3,
    });
    for (const kind of ['dispatch', 'feature']) {
      const n = (key: string) => event[`${kind}_${key}`] as number;
      expect(n('iroh_success')).toBeLessThanOrEqual(n('iroh_ready'));
      expect(n('iroh_ready')).toBeLessThanOrEqual(n('iroh_attempts'));
      expect(n('fallback_streams_attempts')).toBe(n('iroh_attempts') - n('iroh_success'));
      expect(n('fallback_streams_attempts')).toBeLessThanOrEqual(n('streams_attempts'));
      expect(n('fallback_streams_success')).toBeLessThanOrEqual(n('streams_success'));
    }
  });

  it('not-ready remembers connectivity at route selection even while an earlier route is unfinished', async () => {
    const fixture = device();
    const daily = createIrohDaily(fixture.options);
    const cold = daily.wasConnected('target');
    await daily.rememberConnection('target');
    expect(await daily.hasActivity()).toBe(false);
    fixture.advance(2 * IROH_DAY_MS);
    const warm = daily.wasConnected('target');
    await daily.record({
      kind: 'feature',
      outcome: 'fallback_not_ready',
      target: 'target',
      knownAtFallback: warm,
      streams: { success: true },
    });
    // This earlier cold decision must not be rewritten by the later connection.
    await daily.record({
      kind: 'dispatch',
      outcome: 'fallback_not_ready',
      target: 'target',
      knownAtFallback: cold,
      streams: { success: true },
    });
    await daily.check();
    expect(fixture.events).toEqual([]);
    fixture.advance(IROH_DAY_MS);
    await daily.check();
    expect(fixture.events[0]).toMatchObject({
      feature_fallback_not_ready_known: 1,
      feature_fallback_not_ready_never: 0,
      dispatch_fallback_not_ready_never: 1,
    });
    expect(JSON.stringify([...fixture.saved.values()])).not.toContain('target');
  });

  it('accumulates across windows, waits 24h, enqueues one aggregate and clears only its counters', async () => {
    const fixture = device();
    const a = createIrohDaily(fixture.options);
    const b = createIrohDaily(fixture.options);
    await Promise.all(
      Array.from({ length: 100 }, (_, index) => (index % 2 ? a : b).record(success))
    );
    fixture.advance(IROH_DAY_MS - 1);
    await a.check();
    expect(fixture.events).toEqual([]);
    fixture.advance(1);
    await Promise.all([
      a.check(),
      b.check(),
      a.record({
        kind: 'feature',
        outcome: 'chunked',
        target: 'other',
        streams: { success: true },
      }),
    ]);
    expect(fixture.events).toHaveLength(1);
    expect(fixture.events[0]).toMatchObject({
      dispatch_iroh_ok: 100,
      dispatch_lt200: 100,
      dispatch_direct: 100,
      feature_chunked: 0,
      platform: 'desktop',
      app_version: '1.2.3',
      window_start: 1000,
      window_end: 1000 + IROH_DAY_MS,
    });
    const state = JSON.parse(fixture.saved.get(IROH_STATS_KEY)!);
    expect(state.counts).toMatchObject({ feature_chunked: 1, dispatch_iroh_ok: 0 });
    await b.record({
      kind: 'feature',
      outcome: 'fallback_not_ready',
      target: 'private-machine',
      streams: { success: true },
    });
    fixture.advance(IROH_DAY_MS);
    await b.check();
    expect(fixture.events[1]).toMatchObject({
      dispatch_iroh_ok: 0,
      feature_chunked: 1,
      feature_fallback_not_ready_known: 1,
    });
    expect(JSON.stringify([...fixture.saved.values(), fixture.events])).not.toContain(
      'private-machine'
    );
    expect(fixture.events[0]).not.toHaveProperty('known');
    expect(fixture.events[0]).not.toHaveProperty('salt');
  });

  it('keeps several offline days in one window and retains counters when enqueue refuses', async () => {
    const fixture = device();
    const daily = createIrohDaily(fixture.options);
    await daily.record(success);
    fixture.offline();
    fixture.advance(4 * IROH_DAY_MS);
    await daily.check();
    await daily.record(success);
    fixture.reconnect();
    fixture.refuse();
    await daily.check();
    expect(fixture.events).toEqual([]);
    fixture.accept();
    await daily.check();
    await daily.check();
    expect(fixture.events).toHaveLength(1);
    expect(fixture.events[0]).toMatchObject({
      dispatch_iroh_ok: 2,
      window_start: 1000,
      window_end: 1000 + 4 * IROH_DAY_MS,
    });
  });

  it('keeps fallback reasons, kinds, selected paths and latency boundaries distinct and caps integers', async () => {
    const fixture = device();
    const daily = createIrohDaily(fixture.options);
    for (const outcome of [
      'fallback_not_ready',
      'fallback_call_failed',
      'fallback_unverified',
      'unavailable',
      'chunked',
    ] as const)
      await daily.record({
        kind: 'feature',
        outcome,
        target: 'never-seen',
        streams: { success: false },
      });
    await daily.record(success);
    await daily.record({ ...success, elapsedMs: 200, path: 'relay' });
    await daily.record({ ...success, elapsedMs: 800, path: 'unknown' });
    await daily.record({
      kind: 'dispatch',
      outcome: 'fallback_not_ready',
      target: success.target,
      streams: { success: true },
    });
    const state = JSON.parse(fixture.saved.get(IROH_STATS_KEY)!);
    state.counts.dispatch_iroh_ok = 1_000_000;
    state.counts.dispatch_iroh_attempts = 1_000_000;
    state.counts.workspaceId = 'must-not-leave';
    fixture.saved.set(IROH_STATS_KEY, JSON.stringify(state));
    await daily.record(success);
    fixture.advance(IROH_DAY_MS);
    await daily.check();
    expect(fixture.events[0]).toMatchObject({
      dispatch_iroh_ok: 1_000_000,
      dispatch_lt200: 1,
      dispatch_lt800: 1,
      dispatch_ge800: 1,
      dispatch_direct: 1,
      dispatch_relay: 1,
      dispatch_unknown: 1,
      dispatch_fallback_not_ready_known: 1,
      dispatch_fallback_not_ready: 1,
      feature_fallback_not_ready_never: 1,
      feature_fallback_not_ready: 1,
      feature_fallback_call_failed: 1,
      feature_fallback_unverified: 1,
      feature_unavailable: 1,
      feature_chunked: 1,
    });
    expect(fixture.events[0]).not.toHaveProperty('workspaceId');
  });

  it('does no storage or reporting work without an installed telemetry capability', () => {
    const fixture = device();
    const remove = installIrohDailyRecorder(createIrohDaily(fixture.options).record);
    remove();
    recordIrohObservation(success);
    expect(fixture.saved.size).toBe(0);
    expect(fixture.events).toEqual([]);
  });
  it('freezes a pending window before enqueue and preserves new counts after a lost local receipt', async () => {
    const fixture = device();
    const daily = createIrohDaily(fixture.options);
    await daily.record(success);
    fixture.advance(IROH_DAY_MS);
    const save = fixture.options.storage.setItem;
    let writes = 0;
    fixture.options.storage.setItem = (key, value) => {
      if (++writes === 2) throw new Error('quota');
      save(key, value);
    };
    await expect(daily.check()).rejects.toThrow('quota');
    fixture.options.storage.setItem = save;
    await daily.record(success);
    fixture.advance(1000);
    await daily.check();
    expect(fixture.events[1]).toEqual(fixture.events[0]);
    expect(fixture.ids[1]).toBe(fixture.ids[0]);
    fixture.advance(IROH_DAY_MS);
    await daily.check();
    expect(fixture.events[2]).toMatchObject({ dispatch_iroh_ok: 1 });
    expect(fixture.ids[2]).not.toBe(fixture.ids[0]);
  });

  it('does not emit or count work waiting for a lock when telemetry is retired', async () => {
    const fixture = device();
    let enabled = true;
    const daily = createIrohDaily({ ...fixture.options, enabled: () => enabled });
    await daily.record(success);
    fixture.advance(IROH_DAY_MS);
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const held = fixture.options.exclusive(async () => {
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;
    const check = daily.check();
    const record = daily.record(success);
    enabled = false;
    gate.resolve();
    await Promise.all([held, check, record]);
    expect(fixture.events).toEqual([]);
    enabled = true;
    await daily.check();
    expect(fixture.events[0]).toMatchObject({ dispatch_iroh_ok: 1 });
  });

  it('a previously connected target stays known even when its RPC failed verification or transport', async () => {
    const fixture = device();
    const daily = createIrohDaily(fixture.options);
    for (const outcome of ['fallback_call_failed', 'fallback_unverified'] as const) {
      await daily.record({
        kind: 'dispatch',
        outcome,
        connected: true,
        target: outcome,
        streams: { success: false },
      });
      await daily.record({
        kind: 'dispatch',
        outcome: 'fallback_not_ready',
        target: outcome,
        streams: { success: true },
      });
    }
    fixture.advance(IROH_DAY_MS);
    await daily.check();
    expect(fixture.events[0]).toMatchObject({
      dispatch_fallback_not_ready_known: 2,
      dispatch_fallback_not_ready_never: 0,
    });
  });
});
