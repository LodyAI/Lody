import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CloudSyncReconnectGate, computeCloudSyncReconnectDelayMs } from './cloud-sync-reconnect';

type FakeSocket = {
  url: string;
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send: (data: unknown) => void;
  close: (code?: number, reason?: string) => void;
  closeCalls: number;
  open: () => void;
  fail: () => void;
};

type GatedSocket = {
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: unknown) => void) | null;
  readyState: number;
  send: (data: unknown) => void;
  close: (code?: number, reason?: string) => void;
};

/** How long a doomed connection takes to report failure. */
const CONNECT_FAILURE_LATENCY_MS = 1_000;

/**
 * Drives a gate the way the Convex client does: one socket at a time, a new one
 * constructed only after the previous closed, each connection attempt recorded
 * with the (fake) time it actually reached the network.
 */
const createHarness = (
  gateOverrides: Partial<ConstructorParameters<typeof CloudSyncReconnectGate>[0]> = {}
) => {
  // Flipped off by tests that drive a connection's outcome by hand.
  const behavior = { autoFail: true };
  const attempts: { url: string; atMs: number }[] = [];
  const sockets: FakeSocket[] = [];

  const createSocket = (url: string): FakeSocket => {
    attempts.push({ url, atMs: Date.now() });
    const socket: FakeSocket = {
      url,
      onopen: null,
      onerror: null,
      onmessage: null,
      onclose: null,
      closeCalls: 0,
      send: () => {},
      close: () => {
        socket.closeCalls += 1;
        socket.onclose?.({ code: 1000, reason: 'client close', wasClean: true });
      },
      open: () => socket.onopen?.({ type: 'open' }),
      fail: () => socket.onclose?.({ code: 1006, reason: 'network down', wasClean: false }),
    };
    sockets.push(socket);
    if (behavior.autoFail) {
      // A real failing connection reports its failure some time after the
      // attempt starts, which is what keeps the gate's "time since the last
      // attempt" honest.
      setTimeout(() => socket.fail(), CONNECT_FAILURE_LATENCY_MS);
    }
    return socket;
  };

  const gate = new CloudSyncReconnectGate({
    // Midpoint jitter keeps the asserted sequence exact while still going
    // through the jitter path.
    random: () => 0.5,
    createSocket,
    ...gateOverrides,
  });
  const Ctor = gate.createWebSocketConstructor() as unknown as new (url: string) => GatedSocket;

  return { gate, attempts, sockets, Ctor, createSocket, behavior };
};

/** Fake-timer wait: advance one second at a time until `done` or the budget ends. */
const advanceUntil = async (done: () => boolean, budgetMs: number): Promise<void> => {
  for (let elapsed = 0; elapsed < budgetMs && !done(); elapsed += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
};

/** One Convex-style connect cycle that fails, including its own capped backoff. */
const runFailedCycle = async (
  harness: ReturnType<typeof createHarness>,
  options: { convexBackoffMs?: number } = {}
): Promise<void> => {
  const socket = new harness.Ctor('wss://convex.example/api/sync');
  let closed = false;
  socket.onclose = () => {
    closed = true;
  };
  await advanceUntil(() => closed, 30 * 60_000);
  expect(closed).toBe(true);
  // The Convex client waits out its own capped backoff before reconnecting.
  await vi.advanceTimersByTimeAsync(options.convexBackoffMs ?? 16_000);
};

describe('computeCloudSyncReconnectDelayMs', () => {
  it('leaves the early failures to the Convex client and then grows to a five-minute ceiling', () => {
    const delays = Array.from({ length: 14 }, (_unused, index) =>
      computeCloudSyncReconnectDelayMs(index, { random: () => 0.5 })
    );
    expect(delays).toEqual([
      0, 0, 0, 0, 0, 0, 0, 15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
    ]);
  });

  it('keeps jitter inside ±20% of the ceiling and never exceeds it', () => {
    const low = computeCloudSyncReconnectDelayMs(40, { random: () => 0 });
    const high = computeCloudSyncReconnectDelayMs(40, { random: () => 1 });
    expect(low).toBe(240_000);
    expect(high).toBe(300_000);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      expect(
        computeCloudSyncReconnectDelayMs(attempt, { random: Math.random })
      ).toBeLessThanOrEqual(300_000);
    }
  });
});

describe('CloudSyncReconnectGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T04:50:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('paces a sustained outage into minute-scale attempts instead of a 8-24s storm', async () => {
    const harness = createHarness();

    // Two hours of continuous failure, driven the way the Convex client drives
    // it: reconnect as soon as its own (capped) backoff elapses.
    const startedAtMs = Date.now();
    while (Date.now() - startedAtMs < 2 * 60 * 60_000) {
      await runFailedCycle(harness);
    }

    // The unmitigated client makes ~450 attempts across this window.
    expect(harness.attempts.length).toBeLessThan(45);

    const gaps = harness.attempts
      .slice(1)
      .map((attempt, index) => attempt.atMs - harness.attempts[index]!.atMs);
    // Once the grace attempts are spent, no two attempts sit 24s apart again.
    expect(Math.max(...gaps.slice(8))).toBeGreaterThanOrEqual(300_000);
    expect(Math.min(...gaps.slice(8))).toBeGreaterThan(60_000);
    harness.gate.dispose();
  });

  it('reconnects immediately when an online signal arrives mid-backoff', async () => {
    const harness = createHarness();
    for (let cycle = 0; cycle < 9; cycle += 1) {
      await runFailedCycle(harness);
    }
    const attemptsBeforeHold = harness.attempts.length;

    // A fresh connect now waits out a minute-scale hold.
    harness.behavior.autoFail = false;
    const socket = new harness.Ctor('wss://convex.example/api/sync');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.attempts.length).toBe(attemptsBeforeHold);

    expect(harness.gate.notifyOnline('streams-online')).toBe(true);
    expect(harness.attempts.length).toBe(attemptsBeforeHold + 1);

    // And it is a real connection: opening it settles the wrapper Convex holds.
    let opened = false;
    socket.onopen = () => {
      opened = true;
    };
    harness.sockets.at(-1)?.open();
    expect(opened).toBe(true);
    harness.gate.dispose();
  });

  it('caps a flapping online signal at one forced reconnect per minute', async () => {
    const harness = createHarness();
    for (let cycle = 0; cycle < 9; cycle += 1) {
      await runFailedCycle(harness);
    }
    harness.behavior.autoFail = false;
    const attemptsBeforeHold = harness.attempts.length;
    const held = new harness.Ctor('wss://convex.example/api/sync');
    expect(held.readyState).toBe(0);

    // The first signal carries the actual recovery and is honoured at once.
    expect(harness.gate.notifyOnline('streams-online')).toBe(true);
    expect(harness.attempts.length).toBe(attemptsBeforeHold + 1);

    // A transport that then flaps once a second must not become the new storm.
    let honoured = 0;
    for (let signal = 0; signal < 300; signal += 1) {
      if (harness.gate.notifyOnline('flapping')) {
        honoured += 1;
      }
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(honoured).toBeLessThanOrEqual(5);
    harness.gate.dispose();
  });

  it('resets the backoff only after a connection holds, not on the rising edge', async () => {
    const harness = createHarness();
    for (let cycle = 0; cycle < 9; cycle += 1) {
      await runFailedCycle(harness);
    }
    const failuresAfterOutage = harness.gate.state.consecutiveFailures;
    expect(failuresAfterOutage).toBe(9);

    // A connection that opens and dies within the stability window is a failed
    // recovery: the streak grows instead of resetting.
    harness.behavior.autoFail = false;
    let attemptsBefore = harness.attempts.length;
    const flappingWrapper = new harness.Ctor('wss://convex.example/api/sync');
    await advanceUntil(() => harness.attempts.length > attemptsBefore, 10 * 60_000);
    expect(flappingWrapper.readyState).toBe(0);
    const flapping = harness.sockets.at(-1);
    flapping?.open();
    await vi.advanceTimersByTimeAsync(1_000);
    flapping?.fail();
    expect(harness.gate.state.consecutiveFailures).toBe(failuresAfterOutage + 1);

    // A connection that survives the window clears the hold entirely.
    await vi.advanceTimersByTimeAsync(16_000);
    attemptsBefore = harness.attempts.length;
    const holding = new harness.Ctor('wss://convex.example/api/sync');
    await advanceUntil(() => harness.attempts.length > attemptsBefore, 10 * 60_000);
    harness.sockets.at(-1)?.open();
    expect(holding.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.gate.state).toEqual({ consecutiveFailures: 0, nextAllowedConnectAtMs: 0 });

    // So the next connect is immediate again.
    const attemptsBeforeReconnect = harness.attempts.length;
    const reconnected = new harness.Ctor('wss://convex.example/api/sync');
    expect(harness.attempts.length).toBe(attemptsBeforeReconnect + 1);
    expect(reconnected.readyState).toBe(0);
    harness.gate.dispose();
  });

  it('connects without delay while the client is healthy', () => {
    const harness = createHarness();
    harness.behavior.autoFail = false;
    const socket = new harness.Ctor('wss://convex.example/api/sync');
    expect(socket.readyState).toBe(0);
    expect(harness.attempts.length).toBe(1);
    expect(harness.gate.notifyOnline('streams-online')).toBe(false);
    harness.gate.dispose();
  });

  it('keeps only one held connection alive when the client abandons sockets', async () => {
    const harness = createHarness();
    for (let cycle = 0; cycle < 9; cycle += 1) {
      await runFailedCycle(harness);
    }
    const attemptsBeforeHold = harness.attempts.length;

    // The client abandons a held socket (its 60s server-inactivity timeout) and
    // constructs a new one; only the newest may ever reach the network.
    harness.behavior.autoFail = false;
    const abandonedFirst = new harness.Ctor('wss://convex.example/api/sync');
    await vi.advanceTimersByTimeAsync(20_000);
    const abandonedSecond = new harness.Ctor('wss://convex.example/api/sync');
    await vi.advanceTimersByTimeAsync(20_000);
    const live = new harness.Ctor('wss://convex.example/api/sync');
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(harness.attempts.length).toBe(attemptsBeforeHold + 1);
    // The superseded wrappers are closed out; only the newest is still live.
    expect(abandonedFirst.readyState).toBe(3);
    expect(abandonedSecond.readyState).toBe(3);
    expect(live.readyState).toBe(0);
    harness.gate.dispose();
  });

  it('closes a held connection instead of stranding the client on shutdown', async () => {
    const harness = createHarness();
    for (let cycle = 0; cycle < 9; cycle += 1) {
      await runFailedCycle(harness);
    }
    const attemptsBeforeHold = harness.attempts.length;
    const socket = new harness.Ctor('wss://convex.example/api/sync');
    let closed = false;
    socket.onclose = () => {
      closed = true;
    };

    harness.gate.dispose();
    expect(closed).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(harness.attempts.length).toBe(attemptsBeforeHold);
  });

  it('cancels a held connection when the client closes it', async () => {
    const harness = createHarness();
    for (let cycle = 0; cycle < 9; cycle += 1) {
      await runFailedCycle(harness);
    }
    const attemptsBeforeHold = harness.attempts.length;
    const socket = new harness.Ctor('wss://convex.example/api/sync');
    let closed = false;
    socket.onclose = () => {
      closed = true;
    };

    socket.close();
    expect(closed).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(harness.attempts.length).toBe(attemptsBeforeHold);
    harness.gate.dispose();
  });

  it('forwards messages and closes of a live connection', () => {
    const harness = createHarness();
    harness.behavior.autoFail = false;
    const socket = new harness.Ctor('wss://convex.example/api/sync');
    const received: unknown[] = [];
    socket.onmessage = (event) => received.push(event);
    const inner = harness.sockets.at(-1);
    inner?.open();
    expect(socket.readyState).toBe(1);

    const sent: unknown[] = [];
    if (inner) {
      inner.send = (data) => sent.push(data);
    }
    socket.send('ping');
    expect(sent).toEqual(['ping']);

    inner?.onmessage?.({ data: 'pong' });
    expect(received).toEqual([{ data: 'pong' }]);

    socket.close();
    expect(inner?.closeCalls).toBe(1);
    expect(socket.readyState).toBe(3);
    harness.gate.dispose();
  });
});
