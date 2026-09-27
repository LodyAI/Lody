import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import winston from 'winston';
import { createFileTransport, createLogger, resolveFileLogLevel } from './logger';
import {
  FILE_LOG_FAILURE_REPORT_INTERVAL_MS,
  FILE_LOG_RETRY_INTERVAL_MS,
  ResilientFileTransport,
} from './resilient-file-transport';

describe('WinstonLogger', () => {
  it('keeps nested child logger methods bound when passed as callbacks', () => {
    const rootLogger = createLogger({ transports: 'console', level: 'silent' });
    const createChild = rootLogger.child;
    const workspaceLogger = createChild({ workspaceName: 'workspace' });
    const sessionLogger = workspaceLogger.child({ sessionId: 'session' });
    const debug = sessionLogger.debug;

    expect(() => debug('bound logger method')).not.toThrow();
  });

  it('accepts trace records, so the level is registered with winston', () => {
    const logger = createLogger({ transports: 'console', level: 'silent' });

    expect(() => logger.trace('hot path record')).not.toThrow();
  });
});

describe('file sink level', () => {
  const opened: Array<ReturnType<typeof createFileTransport>> = [];
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-log-level-'));

  /** Resolves once the rotator has chosen its file; `new` precedes the async open. */
  const openFileTransport = async (): Promise<ReturnType<typeof createFileTransport>> => {
    const dirname = fs.mkdtempSync(path.join(logRoot, 'sink-'));
    const transport = createFileTransport({ file: { dirname } });
    opened.push(transport);
    await new Promise<void>((resolve) => transport.once('new', () => resolve()));
    return transport;
  };

  afterEach(async () => {
    delete process.env.LODY_LOG_TRACE;
    // `finish` waits for the pending open, so removing the directory cannot
    // fail that open with an uncaught ENOENT.
    await Promise.all(
      opened.splice(0).map(
        (transport) =>
          new Promise<void>((resolve) => {
            transport.once('finish', () => resolve());
            transport.close();
          })
      )
    );
  });

  afterAll(() => {
    fs.rmSync(logRoot, { recursive: true, force: true });
  });

  it('captures debug but not trace by default', async () => {
    expect(resolveFileLogLevel({})).toBe('debug');
    expect((await openFileTransport()).level).toBe('debug');
  });

  it('descends to trace only when LODY_LOG_TRACE is switched on', async () => {
    expect(resolveFileLogLevel({ LODY_LOG_TRACE: '1' })).toBe('trace');
    expect(resolveFileLogLevel({ LODY_LOG_TRACE: ' TRUE ' })).toBe('trace');
    expect(resolveFileLogLevel({ LODY_LOG_TRACE: 'on' })).toBe('trace');

    process.env.LODY_LOG_TRACE = '1';
    expect((await openFileTransport()).level).toBe('trace');
  });

  it('ignores values that do not read as switched on', () => {
    expect(resolveFileLogLevel({ LODY_LOG_TRACE: '0' })).toBe('debug');
    expect(resolveFileLogLevel({ LODY_LOG_TRACE: 'false' })).toBe('debug');
    expect(resolveFileLogLevel({ LODY_LOG_TRACE: '' })).toBe('debug');
    expect(resolveFileLogLevel({})).toBe('debug');
  });
});

const MESSAGE = Symbol.for('message');

const enospc = (): NodeJS.ErrnoException =>
  Object.assign(new Error('ENOSPC: no space left on device, write'), {
    code: 'ENOSPC',
    errno: -28,
    syscall: 'write',
  });

/** Collects stderr notices and lets a test await the next one. */
const createStderr = () => {
  const lines: string[] = [];
  const events = new EventEmitter();
  return {
    lines,
    write: (text: string) => {
      lines.push(text);
      events.emit('line');
    },
    next: () => once(events, 'line'),
  };
};

const closeTransport = async (transport: winston.transport): Promise<void> => {
  const finished = once(transport, 'finish');
  transport.close?.();
  await finished;
};

describe('file sink on a failing disk', () => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-log-disk-full-'));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    fs.rmSync(logRoot, { recursive: true, force: true });
  });

  /**
   * A disk that can be filled: while `full`, every `fs.write`/`fs.writev` — the
   * calls `fs.WriteStream` makes — completes with ENOSPC, and so does the probe.
   * `written` fires after each real write completes.
   */
  const createDisk = () => {
    const disk = { full: false, written: new EventEmitter() };
    const intercept =
      (real: typeof fs.write | typeof fs.writev) =>
      (...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback !== 'function') return Reflect.apply(real, fs, args);
        if (disk.full) {
          process.nextTick(() => callback(enospc()));
          return undefined;
        }
        return Reflect.apply(real, fs, [
          ...args.slice(0, -1),
          (...result: unknown[]) => {
            callback(...result);
            disk.written.emit('write');
          },
        ]);
      };
    const fakeWrite = intercept(fs.write);
    const fakeWritev = intercept(fs.writev);
    vi.spyOn(fs, 'write').mockImplementation(fakeWrite as unknown as typeof fs.write);
    vi.spyOn(fs, 'writev').mockImplementation(fakeWritev as unknown as typeof fs.writev);
    return {
      disk,
      probeWritable: () => {
        if (disk.full) throw enospc();
      },
    };
  };

  it('keeps logging through ENOSPC, drops lines while full, and resumes the file once space returns', async () => {
    const dirname = fs.mkdtempSync(path.join(logRoot, 'sink-'));
    const { disk, probeWritable } = createDisk();
    const stderr = createStderr();
    let nowMs = Date.parse('2026-09-27T10:00:00.000Z');
    const transport = createFileTransport(
      { file: { dirname } },
      { now: () => nowMs, probeWritable, writeStderr: stderr.write }
    );
    const logger = winston.createLogger({ level: 'debug', transports: [transport] });
    await once(transport, 'new');

    const firstWrite = once(disk.written, 'write');
    logger.info('written before the disk filled');
    await firstWrite;

    disk.full = true;
    const failureReported = stderr.next();
    logger.info('lost in the failed write');
    await failureReported;
    expect(stderr.lines[0]).toContain(`Cannot write the log file in ${dirname} (ENOSPC`);
    expect(transport.writing).toBe(false);

    expect(() => logger.error('lost while the disk is full')).not.toThrow();
    nowMs += FILE_LOG_RETRY_INTERVAL_MS;
    expect(() => logger.info('lost because the probe still fails')).not.toThrow();
    expect(transport.writing).toBe(false);

    disk.full = false;
    nowMs += FILE_LOG_RETRY_INTERVAL_MS - 1;
    logger.info('lost before the next retry is due');
    expect(transport.writing).toBe(false);

    nowMs += 1;
    const resumeReported = stderr.next();
    logger.info('written after space returned');
    await resumeReported;
    expect(transport.writing).toBe(true);
    expect(stderr.lines).toHaveLength(2);
    expect(stderr.lines[1]).toContain(
      'file logging resumed; lines from about 2026-09-27T10:00:00.000Z are missing after a write failed (ENOSPC: no space left on device, write); 3 lines logged meanwhile were dropped'
    );

    await closeTransport(transport);
    const [logFile] = fs.readdirSync(dirname).filter((name) => name.endsWith('.log'));
    const content = fs.readFileSync(path.join(dirname, logFile ?? ''), 'utf8');
    expect(content).toContain('written before the disk filled');
    expect(content).not.toContain('lost');
    expect(content).toMatch(
      /\[WARN\] \[logger\] file logging resumed; .*; 3 lines logged meanwhile were dropped/
    );
    expect(content.indexOf('file logging resumed')).toBeLessThan(
      content.indexOf('written after space returned')
    );
  });

  it('starts without a log file when the directory cannot be created, then opens it once it can', async () => {
    const root = fs.mkdtempSync(path.join(logRoot, 'blocked-'));
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'a file where the log directory should be');
    const dirname = path.join(blocker, 'logs');
    const stderr = createStderr();
    let nowMs = 0;

    const transport = createFileTransport(
      { file: { dirname } },
      { now: () => nowMs, writeStderr: stderr.write }
    );
    const logger = winston.createLogger({ level: 'debug', transports: [transport] });
    expect(stderr.lines[0]).toContain(`Cannot write the log file in ${dirname} (ENOTDIR`);
    expect(() => logger.info('dropped while the directory is blocked')).not.toThrow();

    fs.rmSync(blocker);
    nowMs += FILE_LOG_RETRY_INTERVAL_MS;
    const resumeReported = stderr.next();
    logger.info('written once the directory exists');
    await resumeReported;
    await closeTransport(transport);

    const [logFile] = fs.readdirSync(dirname).filter((name) => name.endsWith('.log'));
    const content = fs.readFileSync(path.join(dirname, logFile ?? ''), 'utf8');
    expect(content).toMatch(/file logging resumed; .*\(ENOTDIR: .*; 1 line logged meanwhile/);
    expect(content).toContain('written once the directory exists');
    expect(fs.readdirSync(dirname).filter((name) => name.includes('probe'))).toEqual([]);
  });

  it('reports repeated failures on stderr at most once per interval but records every gap in the file', () => {
    class FakeSink extends EventEmitter {
      readonly logStream = new EventEmitter();
      readonly lines: string[] = [];
      log(info: Record<symbol, unknown>, next: () => void): void {
        this.lines.push(String(info[MESSAGE]));
        next();
      }
      close(): void {
        this.emit('finish');
      }
    }
    const sinks: FakeSink[] = [];
    const stderr = createStderr();
    let nowMs = 0;
    const transport = new ResilientFileTransport({
      dirname: '/logs',
      format: winston.format.printf((info) => String(info.message)),
      openSink: () => {
        const sink = new FakeSink();
        sinks.push(sink);
        return sink;
      },
      probeWritable: () => {},
      now: () => nowMs,
      writeStderr: stderr.write,
    });
    const logger = winston.createLogger({ level: 'debug', transports: [transport] });
    const failCurrentSink = () => sinks.at(-1)?.logStream.emit('error', enospc());
    const retry = (message: string) => {
      nowMs += FILE_LOG_RETRY_INTERVAL_MS;
      logger.info(message);
    };

    expect(failCurrentSink).not.toThrow();
    retry('after the first gap');
    expect(failCurrentSink).not.toThrow();
    retry('after the second gap');
    expect(stderr.lines.map((line) => line.split(' (')[0])).toEqual([
      '[lody] Cannot write the log file in /logs',
      '[lody] file logging resumed; lines from about 1970-01-01T00:00:00.000Z are missing after a write failed',
    ]);
    expect(sinks[2]?.lines).toEqual([
      `${os.EOL}file logging resumed; lines from about 1970-01-01T00:00:30.000Z are missing after a write failed (ENOSPC: no space left on device, write); 0 lines logged meanwhile were dropped`,
      'after the second gap',
    ]);

    nowMs = FILE_LOG_FAILURE_REPORT_INTERVAL_MS;
    failCurrentSink();
    expect(stderr.lines.at(-1)).toContain('Cannot write the log file in /logs (ENOSPC');
    expect(stderr.lines).toHaveLength(3);
  });
});
