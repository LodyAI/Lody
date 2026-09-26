import { Worker } from 'node:worker_threads';
import {
  formatDailyLogLine,
  formatLocalLogDate,
  pickDailyLogAppendName,
} from '@lody/shared/node/daily-log-file';
import { formatErrorMessage } from './format-error';
import type { Logger } from './logger';

/**
 * Names the JavaScript that holds the main thread during a long event-loop
 * stall.
 *
 * `event-loop-lag-monitor.ts` can only report a stall after it ends, and by then
 * nothing says what ran. A watchdog thread watches a heartbeat the main thread
 * bumps from a timer; once the heartbeat is older than the threshold it attaches
 * to the main isolate through `inspector.Session.connectToMainThread()`, samples
 * the CPU for a bounded window WHILE the stall is in progress, and appends the
 * hottest functions and stack to the daily log itself, synchronously. It never
 * waits for the blocked main thread, so the evidence survives even when the
 * stall ends in a kill.
 */

export type EventLoopStallProfiler = {
  stop: () => void;
};

export type EventLoopStallProfilerOptions = {
  logger: Logger;
  logDir: string;
  label: string;
  /** Heartbeat age that counts as a stall. */
  stallThresholdMs?: number;
  /** How long the CPU profile samples the blocked main thread. */
  sampleWindowMs?: number;
  heartbeatIntervalMs?: number;
  /** Minimum gap between two profiles, so a busy process is not profiled continuously. */
  minProfileGapMs?: number;
  maxProfilesPerProcess?: number;
  /** How long attaching may wait for a JavaScript interrupt point before the stall is reported as native. */
  attachWarnMs?: number;
  env?: NodeJS.ProcessEnv;
};

export const EVENT_LOOP_STALL_PROFILER_DISABLE_ENV = 'LODY_EVENT_LOOP_STALL_PROFILER';

const DEFAULT_STALL_THRESHOLD_MS = 4_000;
const DEFAULT_SAMPLE_WINDOW_MS = 3_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 1_000;
const DEFAULT_ATTACH_WARN_MS = 2_000;
const DEFAULT_MIN_PROFILE_GAP_MS = 60_000;
const DEFAULT_MAX_PROFILES_PER_PROCESS = 20;
const SAMPLING_INTERVAL_US = 1_000;
const WORKER_MAX_OLD_GENERATION_MB = 128;

export type StallProfilerWorkerData = {
  heartbeat: BigInt64Array;
  logDir: string;
  label: string;
  stallThresholdMs: number;
  sampleWindowMs: number;
  pollIntervalMs: number;
  minProfileGapMs: number;
  maxProfiles: number;
  samplingIntervalUs: number;
  attachWarnMs: number;
};

/**
 * Worker source. It runs in a plain CommonJS eval worker, so the daily-log
 * naming helpers are inlined from their shared implementation rather than
 * re-implemented: the watchdog must land in the same file as the CLI's logger.
 */
function buildWorkerSource(): string {
  return `
'use strict';
const { workerData, parentPort } = require('node:worker_threads');
const inspector = require('node:inspector');
const fs = require('node:fs');
const path = require('node:path');
const formatLocalLogDate = (${formatLocalLogDate.toString()});
const pickDailyLogAppendName = (${pickDailyLogAppendName.toString()});
const formatDailyLogLine = (${formatDailyLogLine.toString()});
const data = workerData;
const scope = 'event-loop-stall';

function append(level, messages) {
  const time = new Date();
  const text = messages
    .map((message) => formatDailyLogLine({ time, level, scope, message }))
    .join('');
  try {
    fs.mkdirSync(data.logDir, { recursive: true });
    let names = [];
    try { names = fs.readdirSync(data.logDir); } catch {}
    const target = path.join(data.logDir, pickDailyLogAppendName(names, formatLocalLogDate(time)));
    fs.appendFileSync(target, text, { mode: 0o600 });
  } catch (error) {
    parentPort.postMessage({ type: 'write-failed', message: String(error && error.message || error) });
  }
}

function post(session, method, params) {
  return new Promise((resolve, reject) => {
    session.post(method, params || {}, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

function frameKey(frame) {
  const name = frame.functionName || '(anonymous)';
  if (!frame.url) return name;
  const parts = frame.url.split(/[\\\\/]/);
  const file = parts.slice(-2).join('/');
  return name + ' ' + file + ':' + (frame.lineNumber + 1) + ':' + (frame.columnNumber + 1);
}

const META_FRAMES = new Set(['(root)', '(program)', '(idle)', '(garbage collector)']);

function summarize(profile) {
  const byId = new Map();
  for (const node of profile.nodes) byId.set(node.id, node);
  const parent = new Map();
  for (const node of profile.nodes) {
    for (const child of node.children || []) parent.set(child, node.id);
  }
  const selfCounts = new Map();
  const totalCounts = new Map();
  const leafCounts = new Map();
  let gcSamples = 0;
  let idleSamples = 0;
  const samples = profile.samples || [];
  for (const id of samples) {
    leafCounts.set(id, (leafCounts.get(id) || 0) + 1);
    const leaf = byId.get(id);
    if (!leaf) continue;
    const leafName = leaf.callFrame.functionName;
    if (leafName === '(garbage collector)') gcSamples += 1;
    if (leafName === '(idle)') idleSamples += 1;
    if (!META_FRAMES.has(leafName)) {
      const key = frameKey(leaf.callFrame);
      selfCounts.set(key, (selfCounts.get(key) || 0) + 1);
    }
    const seen = new Set();
    for (let cursor = id; cursor !== undefined; cursor = parent.get(cursor)) {
      const node = byId.get(cursor);
      if (!node || META_FRAMES.has(node.callFrame.functionName)) continue;
      const key = frameKey(node.callFrame);
      if (seen.has(key)) continue;
      seen.add(key);
      totalCounts.set(key, (totalCounts.get(key) || 0) + 1);
    }
  }
  const pct = (count) => (samples.length ? ((count * 100) / samples.length).toFixed(1) : '0.0') + '%';
  const top = (counts) =>
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([key, count]) => pct(count) + ' ' + key)
      .join(' | ');
  let hottestLeaf;
  let hottestCount = 0;
  for (const [id, count] of leafCounts) {
    const node = byId.get(id);
    if (!node || META_FRAMES.has(node.callFrame.functionName)) continue;
    if (count > hottestCount) { hottestLeaf = id; hottestCount = count; }
  }
  const stack = [];
  for (let cursor = hottestLeaf; cursor !== undefined && stack.length < 30; cursor = parent.get(cursor)) {
    const node = byId.get(cursor);
    if (!node || META_FRAMES.has(node.callFrame.functionName)) continue;
    stack.push(frameKey(node.callFrame));
  }
  return {
    sampleCount: samples.length,
    gc: pct(gcSamples),
    idle: pct(idleSamples),
    self: top(selfCounts) || '(none)',
    total: top(totalCounts) || '(none)',
    hottestStack: stack.length ? pct(hottestCount) + ' ' + stack.join(' <- ') : '(none)',
  };
}

let profiling = false;
let stallEpisodeProfiled = false;
let lastProfileAt = -Infinity;
let profiles = 0;

// Monotonic and process-wide: suspended system time is not a stall.
const nowMs = () => Number(process.hrtime.bigint() / 1000000n);
const heartbeatAt = () => Number(Atomics.load(data.heartbeat, 0));

function withAttachWatch(promise, heartbeatAgeMs) {
  // Inspector commands run on the main thread only at a JavaScript interrupt
  // point. A stall inside native code or synchronous I/O never reaches one,
  // so say so while it is still happening instead of waiting silently.
  const timer = setTimeout(() => {
    append('WARN', [
      data.label + ' main thread blocked for ' + (heartbeatAgeMs + data.attachWarnMs) +
        'ms has not reached a JavaScript interrupt point for ' + data.attachWarnMs +
        'ms: it is blocked in native code or synchronous I/O (sync fs, execSync, Atomics.wait, ' +
        'a native addon); a profile can start only after that call returns',
    ]);
  }, data.attachWarnMs);
  return promise.finally(() => clearTimeout(timer));
}

async function profileStall(heartbeatAgeMs) {
  profiling = true;
  const session = new inspector.Session();
  const startedAt = nowMs();
  try {
    session.connectToMainThread();
    await withAttachWatch(
      (async () => {
        await post(session, 'Profiler.enable');
        await post(session, 'Profiler.setSamplingInterval', { interval: data.samplingIntervalUs });
        await post(session, 'Profiler.start');
      })(),
      heartbeatAgeMs
    );
    const attachMs = nowMs() - startedAt;
    const beatAtStart = heartbeatAt();
    await new Promise((resolve) => setTimeout(resolve, data.sampleWindowMs));
    const { profile } = await post(session, 'Profiler.stop');
    const stillBlockedMs = nowMs() - heartbeatAt();
    // A heartbeat during the window means timers ran: the stall ended mid-sample.
    const endedDuringSample = heartbeatAt() !== beatAtStart;
    const coverage =
      attachMs > data.attachWarnMs
        ? 'after-stall (attached late; samples show what ran after the blocking call returned)'
        : endedDuringSample
          ? 'partial (stall ended during the sample window)'
          : 'during-stall';
    const summary = summarize(profile);
    append('WARN', [
      data.label + ' main thread blocked for ' + heartbeatAgeMs + 'ms; sampled ' + data.sampleWindowMs +
        'ms (coverage=' + coverage + ' samples=' + summary.sampleCount + ' attachMs=' + attachMs +
        ' gc=' + summary.gc + ' idle=' + summary.idle + ' heartbeatAgeAfterMs=' + stillBlockedMs +
        ' profile=' + (profiles + 1) + '/' + data.maxProfiles + ')',
      data.label + ' self time: ' + summary.self,
      data.label + ' inclusive time: ' + summary.total,
      data.label + ' hottest stack (leaf first): ' + summary.hottestStack,
    ]);
    parentPort.postMessage({ type: 'profiled' });
  } catch (error) {
    append('WARN', [
      data.label + ' stall of ' + heartbeatAgeMs + 'ms detected but profiling failed: ' +
        String((error && error.message) || error),
    ]);
    parentPort.postMessage({ type: 'profile-failed' });
  } finally {
    try { await post(session, 'Profiler.disable'); } catch {}
    try { session.disconnect(); } catch {}
    profiles += 1;
    lastProfileAt = nowMs();
    profiling = false;
    if (profiles >= data.maxProfiles) {
      // Budget spent: stop polling so the thread can exit, and let the main
      // thread stop its heartbeat.
      clearInterval(poll);
      parentPort.postMessage({ type: 'exhausted' });
    }
  }
}

const poll = setInterval(() => {
  if (profiling) return;
  const heartbeatAgeMs = nowMs() - heartbeatAt();
  if (heartbeatAgeMs < data.stallThresholdMs) {
    stallEpisodeProfiled = false;
    return;
  }
  if (stallEpisodeProfiled) return;
  if (nowMs() - lastProfileAt < data.minProfileGapMs) return;
  stallEpisodeProfiled = true;
  void profileStall(heartbeatAgeMs);
}, data.pollIntervalMs);
`;
}

export function startEventLoopStallProfiler(
  options: EventLoopStallProfilerOptions
): EventLoopStallProfiler {
  const env = options.env ?? process.env;
  if (env[EVENT_LOOP_STALL_PROFILER_DISABLE_ENV] === '0') {
    options.logger.debug(
      `[event-loop-stall] ${options.label} profiler disabled via ${EVENT_LOOP_STALL_PROFILER_DISABLE_ENV}=0`
    );
    return { stop: () => {} };
  }

  const heartbeat = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
  // Monotonic milliseconds, readable from the worker: `process.hrtime` is one
  // process-wide clock that does not advance while the system sleeps.
  const beat = () => Atomics.store(heartbeat, 0, process.hrtime.bigint() / 1_000_000n);
  beat();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimer = setInterval(beat, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  const workerData: StallProfilerWorkerData = {
    heartbeat,
    logDir: options.logDir,
    label: options.label,
    stallThresholdMs: options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS,
    sampleWindowMs: options.sampleWindowMs ?? DEFAULT_SAMPLE_WINDOW_MS,
    pollIntervalMs: heartbeatIntervalMs,
    minProfileGapMs: options.minProfileGapMs ?? DEFAULT_MIN_PROFILE_GAP_MS,
    maxProfiles: options.maxProfilesPerProcess ?? DEFAULT_MAX_PROFILES_PER_PROCESS,
    samplingIntervalUs: SAMPLING_INTERVAL_US,
    attachWarnMs: options.attachWarnMs ?? DEFAULT_ATTACH_WARN_MS,
  };

  let worker: Worker;
  try {
    worker = new Worker(buildWorkerSource(), {
      eval: true,
      workerData,
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_GENERATION_MB },
      // The watchdog must not inherit `--inspect`-style flags or heap sizing
      // meant for the main isolate.
      execArgv: [],
    });
  } catch (error) {
    clearInterval(heartbeatTimer);
    options.logger.warn(
      `[event-loop-stall] ${options.label} profiler unavailable: ${formatErrorMessage(error)}`
    );
    return { stop: () => {} };
  }
  worker.unref();

  let stopped = false;
  worker.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return;
    if (message.type === 'exhausted') {
      clearInterval(heartbeatTimer);
      options.logger.debug(
        `[event-loop-stall] ${options.label} profiler stopped after ${workerData.maxProfiles} profiles`
      );
      return;
    }
    if (message.type === 'write-failed') {
      const detail = 'message' in message ? String(message.message) : 'unknown error';
      options.logger.warn(
        `[event-loop-stall] ${options.label} could not write a stall profile: ${detail}`
      );
    }
  });
  worker.on('error', (error) => {
    if (stopped) return;
    options.logger.warn(
      `[event-loop-stall] ${options.label} profiler stopped after an error: ${formatErrorMessage(error)}`
    );
  });

  options.logger.debug(
    `[event-loop-stall] ${options.label} profiler armed (thresholdMs=${workerData.stallThresholdMs} sampleWindowMs=${workerData.sampleWindowMs} minGapMs=${workerData.minProfileGapMs} maxProfiles=${workerData.maxProfiles})`
  );

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeatTimer);
      void worker.terminate();
    },
  };
}
