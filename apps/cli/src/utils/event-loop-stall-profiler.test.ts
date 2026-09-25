import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
      /\[WARN\] \[event-loop-stall\] test-start main thread blocked for \d+ms; sampled 300ms \(coverage=during-stall samples=\d+/
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

  it('reports a stall in native code while it lasts and labels the late profile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-stall-profiler-native-'));
    logDir = dir;
    profiler = startEventLoopStallProfiler({
      logger: createRecordingLogger(),
      logDir: dir,
      label: 'test-start',
      stallThresholdMs: 200,
      sampleWindowMs: 100,
      heartbeatIntervalMs: 50,
      attachWarnMs: 300,
      minProfileGapMs: 0,
      env: {},
    });

    // Block the main thread in a synchronous child-process call, which never
    // reaches a JavaScript interrupt point (Atomics.wait would: V8 services
    // interrupts inside it). The child exits only once a helper thread sees
    // the watchdog's report, so the test waits on that signal, not a timer.
    const signalFile = path.join(os.tmpdir(), `lody-stall-native-${process.pid}-${Date.now()}`);
    const helper = new Worker(
      `const { workerData } = require('node:worker_threads');
       const fs = require('node:fs');
       const path = require('node:path');
       const timer = setInterval(() => {
         for (const name of fs.readdirSync(workerData.dir)) {
           if (fs.readFileSync(path.join(workerData.dir, name), 'utf8').includes('JavaScript interrupt point')) {
             clearInterval(timer);
             fs.writeFileSync(workerData.signalFile, 'go');
           }
         }
       }, 20);`,
      { eval: true, workerData: { dir, signalFile } }
    );
    try {
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          `const fs = require('node:fs');
           const deadline = Date.now() + 30000;
           (function wait() {
             if (fs.existsSync(process.argv[1])) process.exit(0);
             if (Date.now() > deadline) process.exit(3);
             setTimeout(wait, 20);
           })();`,
          signalFile,
        ],
        { stdio: 'ignore' }
      );
      expect(child.status).toBe(0);
    } finally {
      await helper.terminate();
      fs.rmSync(signalFile, { force: true });
    }

    const readStallLines = () =>
      fs
        .readdirSync(dir)
        .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
        .join('')
        .split('\n')
        .filter((line) => line.includes('[event-loop-stall]'));
    await vi.waitFor(
      () => expect(readStallLines().some((line) => line.includes('hottest stack'))).toBe(true),
      { timeout: 20_000, interval: 20 }
    );
    const lines = readStallLines();
    expect(lines[0]).toMatch(
      /test-start main thread blocked for \d+ms has not reached a JavaScript interrupt point for 300ms: it is blocked in native code or synchronous I\/O/
    );
    expect(lines.find((line) => line.includes('sampled 100ms'))).toContain(
      'coverage=after-stall (attached late'
    );
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
