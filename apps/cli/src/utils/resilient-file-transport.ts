import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logform } from 'winston';
import TransportStream from 'winston-transport';
import { formatErrorMessage } from './format-error';

/**
 * A file log transport that a failing disk cannot turn into a crash.
 *
 * winston-daily-rotate-file forwards its `fs.WriteStream` errors to an emitter
 * nobody listens to, so the first `ENOSPC` became an `uncaughtException` and
 * the daemon exited. The stream is also destroyed by that error and never
 * writes again, even after space is freed. This transport owns the rotating
 * sink instead of letting winston pipe to it: a sink error drops the sink, the
 * lines logged meanwhile are counted and dropped (the console transport keeps
 * carrying info and above), and once `probeWritable` proves the directory takes
 * writes again a fresh sink is opened with a line recording the gap. Stderr
 * gets one rate-limited notice per failure episode and one when it ends.
 */

const MESSAGE = Symbol.for('message');
const LEVEL = Symbol.for('level');

export const FILE_LOG_RETRY_INTERVAL_MS = 30_000;
export const FILE_LOG_FAILURE_REPORT_INTERVAL_MS = 10 * 60_000;

/**
 * The rotating file sink this transport wraps; a `DailyRotateFile` in production.
 * `logStream` is the emitter its file stream errors reach.
 */
export type FileLogSink = EventEmitter & {
  readonly logStream: EventEmitter;
  log?(info: unknown, next: () => void): unknown;
  close?(): void;
};

export type ResilientFileTransportOptions = TransportStream.TransportStreamOptions & {
  /** Names the log directory in stderr notices. */
  dirname: string;
  /** Opens a rotating sink. May throw, e.g. when the directory cannot be created. */
  openSink: () => FileLogSink;
  /** Throws unless the log directory currently accepts writes. */
  probeWritable: () => void;
  now?: () => number;
  writeStderr?: (text: string) => void;
  retryIntervalMs?: number;
  failureReportIntervalMs?: number;
};

type FailureEpisode = {
  sinceMs: number;
  error: unknown;
  droppedLines: number;
  reported: boolean;
};

/** `ENOSPC: no space left on device, write`; Node's fs messages already lead with the code. */
const describeError = (error: unknown): string => {
  const message = formatErrorMessage(error);
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '';
  return code && !message.startsWith(code) ? `${code}: ${message}` : message;
};

const writeProcessStderr = (text: string): void => {
  try {
    process.stderr.write(text);
  } catch {
    // Stderr is the last resort; there is nowhere left to report to.
  }
};

/** Creates and removes a small file, which fails with ENOSPC/EDQUOT on a full volume. */
export const probeDirectoryWritable = (dirname: string): void => {
  fs.mkdirSync(dirname, { recursive: true });
  const probePath = path.join(dirname, `.lody-log-write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probePath, 'lody log write probe\n');
  } finally {
    try {
      fs.rmSync(probePath, { force: true });
    } catch {
      // A leftover probe is harmless; the write itself answered the question.
    }
  }
};

export class ResilientFileTransport extends TransportStream {
  private readonly dirname: string;
  private readonly openSink: () => FileLogSink;
  private readonly probeWritable: () => void;
  private readonly now: () => number;
  private readonly writeStderr: (text: string) => void;
  private readonly retryIntervalMs: number;
  private readonly failureReportIntervalMs: number;

  private sink: FileLogSink | null = null;
  private failure: FailureEpisode | null = null;
  private nextRetryAtMs = 0;
  private lastFailureReportAtMs: number | null = null;
  private shutDown = false;

  constructor(options: ResilientFileTransportOptions) {
    super(options);
    this.dirname = options.dirname;
    this.openSink = options.openSink;
    this.probeWritable = options.probeWritable;
    this.now = options.now ?? Date.now;
    this.writeStderr = options.writeStderr ?? writeProcessStderr;
    this.retryIntervalMs = options.retryIntervalMs ?? FILE_LOG_RETRY_INTERVAL_MS;
    this.failureReportIntervalMs =
      options.failureReportIntervalMs ?? FILE_LOG_FAILURE_REPORT_INTERVAL_MS;
    this.tryOpenSink();
  }

  /** Whether lines currently reach a file; false while a write failure is unresolved. */
  get writing(): boolean {
    return this.sink !== null;
  }

  override log(info: unknown, next: () => void): void {
    if (!this.sink && !this.shutDown) this.retryAfterFailure();
    const sink = this.sink;
    if (sink) {
      try {
        sink.log?.(info, () => {});
      } catch (error) {
        this.handleSinkFailure(sink, error);
      }
    }
    if (!this.sink && this.failure) this.failure.droppedLines += 1;
    next();
  }

  override close(): void {
    this.shutDown = true;
    const sink = this.sink;
    this.sink = null;
    if (!sink) {
      process.nextTick(() => this.emit('finish'));
      return;
    }
    sink.once('finish', () => this.emit('finish'));
    this.disposeSink(sink);
  }

  private tryOpenSink(): boolean {
    let sink: FileLogSink;
    try {
      sink = this.openSink();
    } catch (error) {
      this.recordFailure(error);
      return false;
    }
    // Listeners stay attached after a sink is dropped: its stream can still
    // report a late error, and an emitter without one throws.
    sink.logStream.on('error', (error: unknown) => this.handleSinkFailure(sink, error));
    // The sink emits its own `error` for archive and retention failures; its
    // stream may still be healthy, so record them in the file instead.
    sink.on('error', (error: unknown) => {
      if (sink !== this.sink) return;
      this.writeNotice(sink, 'warn', `log maintenance failed: ${describeError(error)}`);
    });
    sink.on('new', (filename: unknown) => {
      if (sink === this.sink) this.emit('new', filename);
    });
    this.sink = sink;
    return true;
  }

  private handleSinkFailure(sink: FileLogSink, error: unknown): void {
    if (sink !== this.sink) return;
    this.sink = null;
    this.disposeSink(sink);
    this.recordFailure(error);
  }

  private recordFailure(error: unknown): void {
    const now = this.now();
    this.nextRetryAtMs = now + this.retryIntervalMs;
    // A reopen that fails continues the episode it was trying to end.
    if (this.failure) return;
    const reportDue =
      this.lastFailureReportAtMs === null ||
      now - this.lastFailureReportAtMs >= this.failureReportIntervalMs;
    this.failure = { sinceMs: now, error, droppedLines: 0, reported: reportDue };
    if (!reportDue) return;
    this.lastFailureReportAtMs = now;
    this.writeStderr(
      `[lody] Cannot write the log file in ${this.dirname} (${describeError(error)}); ` +
        `dropping file log lines and retrying every ${Math.round(this.retryIntervalMs / 1000)}s.${os.EOL}`
    );
  }

  private retryAfterFailure(): void {
    const failure = this.failure;
    if (!failure || this.now() < this.nextRetryAtMs) return;
    this.nextRetryAtMs = this.now() + this.retryIntervalMs;
    try {
      this.probeWritable();
    } catch {
      return;
    }
    if (!this.tryOpenSink()) return;
    this.failure = null;
    // Lines the failed stream had buffered are lost too, so the count is a floor
    // and the timestamp bounds the gap.
    const dropped = `${failure.droppedLines} line${failure.droppedLines === 1 ? '' : 's'}`;
    const summary =
      `file logging resumed; lines from about ${new Date(failure.sinceMs).toISOString()} are ` +
      `missing after a write failed (${describeError(failure.error)}); ${dropped} logged ` +
      `meanwhile were dropped`;
    // The failed write can leave a partial line behind, so start a fresh one.
    if (this.sink) this.writeNotice(this.sink, 'warn', summary, os.EOL);
    if (failure.reported) this.writeStderr(`[lody] ${summary}.${os.EOL}`);
  }

  private writeNotice(
    sink: FileLogSink,
    level: string,
    message: string,
    prefix: string = ''
  ): void {
    const info: Logform.TransformableInfo = { level, message, scope: 'logger' };
    info[LEVEL] = level;
    const formatted: unknown = this.format
      ? this.format.transform(info, this.format.options)
      : info;
    if (typeof formatted !== 'object' || formatted === null) return;
    const line: unknown = Reflect.get(formatted, MESSAGE);
    Reflect.set(formatted, MESSAGE, `${prefix}${typeof line === 'string' ? line : message}`);
    try {
      sink.log?.(formatted, () => {});
    } catch (error) {
      this.handleSinkFailure(sink, error);
    }
  }

  private disposeSink(sink: FileLogSink): void {
    try {
      sink.close?.();
    } catch {
      // A sink that failed to write may also fail to close; it is being dropped.
    }
  }
}
