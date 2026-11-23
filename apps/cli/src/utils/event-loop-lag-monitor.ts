import v8 from 'node:v8';
import type { Logger } from './logger';

export type EventLoopLagMonitor = {
  stop: () => void;
};

/**
 * Heap-use fractions of V8's `heap_size_limit` that each leave one warning per
 * process. A V8 out-of-memory abort writes nothing through this logger, so
 * these are the only record of how the heap approached its limit beforehand.
 */
const HEAP_PRESSURE_THRESHOLDS = [0.7, 0.85, 0.95] as const;

type HeapReading = { usedBytes: number; limitBytes: number };

export type EventLoopLagMonitorDeps = {
  now: () => number;
  cpuUsage: () => NodeJS.CpuUsage;
  memoryUsage: () => NodeJS.MemoryUsage;
  heap: () => HeapReading;
  setInterval: (callback: () => void, ms: number) => { unref?: () => unknown };
  clearInterval: (timer: { unref?: () => unknown }) => void;
};

const defaultDeps: EventLoopLagMonitorDeps = {
  now: () => Date.now(),
  cpuUsage: () => process.cpuUsage(),
  memoryUsage: () => process.memoryUsage(),
  heap: () => {
    const stats = v8.getHeapStatistics();
    return { usedBytes: stats.used_heap_size, limitBytes: stats.heap_size_limit };
  },
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

const toMiB = (bytes: number): number => Math.round(bytes / 1024 / 1024);

export function startEventLoopLagMonitor(
  logger: Logger,
  options: {
    label: string;
    intervalMs?: number;
    warnThresholdMs?: number;
  },
  deps: EventLoopLagMonitorDeps = defaultDeps
): EventLoopLagMonitor {
  const intervalMs = Math.max(100, options.intervalMs ?? 1_000);
  const warnThresholdMs = Math.max(intervalMs, options.warnThresholdMs ?? 5_000);
  let expectedAt = deps.now() + intervalMs;
  let previousTickAt = deps.now();
  let previousCpuUsage = deps.cpuUsage();
  let heapPressureLevel = 0;

  const timer = deps.setInterval(() => {
    const now = deps.now();
    const elapsedMs = Math.max(0, now - previousTickAt);
    const lagMs = now - expectedAt;
    const cpuUsage = deps.cpuUsage();
    const cpuMs =
      (cpuUsage.user - previousCpuUsage.user + cpuUsage.system - previousCpuUsage.system) / 1000;
    const cpuRatio = elapsedMs > 0 ? cpuMs / elapsedMs : 0;

    previousTickAt = now;
    previousCpuUsage = cpuUsage;
    expectedAt = now + intervalMs;

    const heap = deps.heap();
    const heapRatio = heap.limitBytes > 0 ? heap.usedBytes / heap.limitBytes : 0;
    const heapSummary = `heapUsed=${toMiB(heap.usedBytes)}MiB heapLimit=${toMiB(
      heap.limitBytes
    )}MiB heapUsedPct=${(heapRatio * 100).toFixed(1)}`;

    if (lagMs >= warnThresholdMs) {
      const memoryUsage = deps.memoryUsage();
      logger.warn(
        `[event-loop] ${options.label} timer lag detected: fired ${Math.round(
          lagMs
        )}ms late (threshold=${warnThresholdMs}ms interval=${intervalMs}ms elapsed=${Math.round(
          elapsedMs
        )}ms cpu=${Math.round(cpuMs)}ms cpuRatio=${cpuRatio.toFixed(2)} rss=${toMiB(
          memoryUsage.rss
        )}MiB ${heapSummary} external=${toMiB(memoryUsage.external)}MiB arrayBuffers=${toMiB(
          memoryUsage.arrayBuffers
        )}MiB)`
      );
    }

    const nextLevel = HEAP_PRESSURE_THRESHOLDS.filter((threshold) => heapRatio >= threshold).length;
    if (nextLevel > heapPressureLevel) {
      heapPressureLevel = nextLevel;
      const threshold = HEAP_PRESSURE_THRESHOLDS[nextLevel - 1] ?? 0;
      logger.warn(
        `[event-loop] ${options.label} heap pressure crossed ${Math.round(
          threshold * 100
        )}% of the V8 heap limit (${heapSummary} rss=${toMiB(deps.memoryUsage().rss)}MiB)`
      );
    }
  }, intervalMs);
  timer.unref?.();

  return {
    stop: () => deps.clearInterval(timer),
  };
}
