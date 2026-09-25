import { describe, expect, it } from 'vitest';
import { startEventLoopLagMonitor, type EventLoopLagMonitorDeps } from './event-loop-lag-monitor';
import type { Logger } from './logger';

const MiB = 1024 * 1024;

function harness(heapLimitMiB = 4096) {
  const warnings: string[] = [];
  const logger = {
    info: () => {},
    warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
    error: () => {},
    success: () => {},
    debug: () => {},
    setLevel: () => {},
    setDebug: () => {},
    child: () => logger,
    close: async () => {},
  } satisfies Logger;
  const state = { now: 0, cpuMs: 0, heapUsedMiB: 100 };
  let tick: (() => void) | null = null;
  let cleared = false;
  const deps: EventLoopLagMonitorDeps = {
    now: () => state.now,
    cpuUsage: () => ({ user: state.cpuMs * 1000, system: 0 }),
    memoryUsage: () => ({
      rss: 800 * MiB,
      heapTotal: 0,
      heapUsed: state.heapUsedMiB * MiB,
      external: 10 * MiB,
      arrayBuffers: 5 * MiB,
    }),
    heap: () => ({ usedBytes: state.heapUsedMiB * MiB, limitBytes: heapLimitMiB * MiB }),
    setInterval: (callback) => {
      tick = callback;
      return {};
    },
    clearInterval: () => {
      cleared = true;
    },
  };
  const monitor = startEventLoopLagMonitor(logger, { label: 'lody start' }, deps);
  return {
    warnings,
    state,
    monitor,
    isCleared: () => cleared,
    fire: (atMs: number, cpuMs: number) => {
      state.now = atMs;
      state.cpuMs = cpuMs;
      tick?.();
    },
  };
}

describe('startEventLoopLagMonitor', () => {
  it('reports a stall with CPU share and the heap limit it ran against', () => {
    const h = harness();
    h.fire(1_000, 900);
    expect(h.warnings).toEqual([]);

    h.fire(71_000, 900 + 69_000);
    expect(h.warnings).toEqual([
      '[event-loop] lody start timer lag detected: fired 69000ms late (threshold=5000ms interval=1000ms elapsed=70000ms cpu=69000ms cpuRatio=0.99 rss=800MiB heapUsed=100MiB heapLimit=4096MiB heapUsedPct=2.4 external=10MiB arrayBuffers=5MiB)',
    ]);
  });

  it('warns once per heap-pressure threshold as the heap approaches its limit', () => {
    const h = harness(1000);
    h.state.heapUsedMiB = 690;
    h.fire(1_000, 0);
    h.state.heapUsedMiB = 720;
    h.fire(2_000, 0);
    h.state.heapUsedMiB = 730;
    h.fire(3_000, 0);
    h.state.heapUsedMiB = 960;
    h.fire(4_000, 0);
    h.state.heapUsedMiB = 500;
    h.fire(5_000, 0);

    expect(h.warnings).toEqual([
      '[event-loop] lody start heap pressure crossed 70% of the V8 heap limit (heapUsed=720MiB heapLimit=1000MiB heapUsedPct=72.0 rss=800MiB)',
      '[event-loop] lody start heap pressure crossed 95% of the V8 heap limit (heapUsed=960MiB heapLimit=1000MiB heapUsedPct=96.0 rss=800MiB)',
    ]);
    h.monitor.stop();
    expect(h.isCleared()).toBe(true);
  });
});
