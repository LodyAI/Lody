import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatLocalLogDate, resolveDailyLogAppendPath } from '@lody/shared/node/daily-log-file';
import {
  startEventLoopStallProfiler,
  type EventLoopStallProfiler,
} from './event-loop-stall-profiler';
import type { Logger } from './logger';

function createRecordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push(`${level} ${args.map(String).join(' ')}`);
    };
  const logger = {
    lines,
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    success: record('success'),
    debug: record('debug'),
    setLevel: () => {},
    setDebug: () => {},
    child: () => logger,
    close: async () => {},
  };
  return logger;
}

/**
 * Holds the main thread the way a runaway synchronous job does. It ends on an
 * explicit signal — the watchdog's profile reaching the log — not on a timer.
 */
function blockMainThreadUntilProfileWritten(logFiles: readonly string[]): string {
  const deadline = Date.now() + 30_000;
  let accumulator = 0;
  for (;;) {
    for (let index = 0; index < 200_000; index += 1) {
      accumulator += Math.sqrt(index + accumulator) % 7;
    }
    const written = logFiles.find(
      (file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('hottest stack')
    );
    if (written) return written;
    if (Date.now() > deadline) {
      throw new Error(`stall profile was never written (spin=${accumulator})`);
    }
  }
}

describe('startEventLoopStallProfiler', () => {
  let profiler: EventLoopStallProfiler | null = null;
  let logDir: string | null = null;

  afterEach(() => {
    profiler?.stop();
    profiler = null;
    if (logDir) fs.rmSync(logDir, { recursive: true, force: true });
    logDir = null;
  });

  it('names the function holding a blocked main thread in the live daily log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-stall-profiler-'));
    logDir = dir;
    // The CLI has already size-rotated today: the watchdog must append to the
    // live rotation, the same file the shared resolver picks. The worker reads
    // the real clock, so seed tomorrow's rotation too in case the run crosses
    // midnight.
    const today = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 12);
    const liveRotations = [today, tomorrow].map((day) => {
      const file = path.join(dir, `${formatLocalLogDate(day)}.log.2`);
      fs.writeFileSync(file, 'existing cli line\n');
      expect(resolveDailyLogAppendPath(dir, day)).toBe(file);
      return file;
    });

    const logger = createRecordingLogger();
    profiler = startEventLoopStallProfiler({
      logger,
      logDir: dir,
      label: 'test-start',
      stallThresholdMs: 200,
      sampleWindowMs: 300,
      heartbeatIntervalMs: 50,
      minProfileGapMs: 0,
      env: {},
    });

    const liveRotation = blockMainThreadUntilProfileWritten(liveRotations);

    const text = fs.readFileSync(liveRotation, 'utf8');
    expect(text.startsWith('existing cli line\n')).toBe(true);
    const stallLines = text.split('\n').filter((line) => line.includes('[event-loop-stall]'));
    expect(stallLines.find((line) => line.includes('main thread blocked for'))).toMatch(
      /\[WARN\] \[event-loop-stall\] test-start main thread blocked for \d+ms; sampled 300ms \(samples=\d+/
    );
    // TurboFan may inline the blocking helper into its caller, so assert on the
    // source location every blocked sample shares rather than a function name.
    expect(stallLines.find((line) => line.includes('inclusive time:'))).toContain(
      'utils/event-loop-stall-profiler.test.ts:'
    );
    expect(stallLines.find((line) => line.includes('hottest stack'))).toContain(
      'utils/event-loop-stall-profiler.test.ts:'
    );
    expect(logger.lines.some((line) => line.startsWith('warn'))).toBe(false);
  });

  it('stays off when disabled by environment', () => {
    const logger = createRecordingLogger();
    profiler = startEventLoopStallProfiler({
      logger,
      logDir: path.join(os.tmpdir(), 'lody-stall-profiler-disabled-never-created'),
      label: 'test-start',
      env: { LODY_EVENT_LOOP_STALL_PROFILER: '0' },
    });
    expect(logger.lines).toEqual([
      'debug [event-loop-stall] test-start profiler disabled via LODY_EVENT_LOOP_STALL_PROFILER=0',
    ]);
  });
});
