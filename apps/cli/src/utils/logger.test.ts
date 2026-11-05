import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import winston from 'winston';
import { Effect } from 'effect';
import { lodyLoggerLayer } from '@/platform/logger';
import type { Logger } from './logger';
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import {
  createFileLogger,
  createFileTransport,
  createLogger,
  getLogger,
  routeLoggerToStderr,
} from './logger';
import { FILE_LOG_RETRY_INTERVAL_MS } from './resilient-file-transport';

describe('WinstonLogger', () => {
  it('routes root and child diagnostics to stderr while preserving structured stdout', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const stdout = new Writable({
      write(chunk, _encoding, done) {
        out.push(String(chunk));
        done();
      },
    });
    const stderr = new Writable({
      write(chunk, _encoding, done) {
        err.push(String(chunk));
        done();
      },
    });
    vi.stubGlobal('console', new Console({ stdout, stderr }));
    const logger = createLogger({ level: 'debug' });
    const restore = routeLoggerToStderr(logger);
    try {
      logger.info('root diagnostic');
      logger.child({ scope: 'child' }).debug('child diagnostic');
      expect(out.join('')).toBe('');
      expect(err.join('')).toContain('root diagnostic');
      expect(err.join('')).toContain('child diagnostic');
      restore();
      logger.info('normal console');
      expect(out.join('')).toContain('normal console');
    } finally {
      restore();
      vi.unstubAllGlobals();
      await logger.close();
    }
  });
});

describe('file sink level', () => {
  const opened: Array<ReturnType<typeof createFileTransport>> = [];
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-log-level-'));

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

  it.each([false, true])(
    'writes safe Effect annotations to the actual file sink (trace=%s)',
    async (trace) => {
      if (trace) process.env.LODY_LOG_TRACE = '1';
      const dirname = fs.mkdtempSync(path.join(logRoot, 'effect-'));
      const transport = createFileTransport({ file: { dirname } });
      opened.push(transport);
      await once(transport, 'new');
      const sink = winston.createLogger({
        levels: { error: 0, warn: 1, info: 2, debug: 3, trace: 4 },
        level: 'trace',
        transports: [transport],
      });
      const forward =
        (level: string) =>
        (...args: unknown[]) => {
          sink.log(level, args.join(' '));
        };
      const logger: Logger = {
        trace: forward('trace'),
        debug: forward('debug'),
        info: forward('info'),
        warn: forward('warn'),
        error: forward('error'),
        success: forward('info'),
        child: () => logger,
        setLevel() {},
        setDebug() {},
        close: async () => {},
      };
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.logTrace('individual-success');
          yield* Effect.logWarning('health-summary');
        }).pipe(
          Effect.annotateLogs({
            stage: 'health',
            postPending: 1,
            token: 'secret-token',
            url: 'https://secret.invalid',
          }),
          Effect.provide(lodyLoggerLayer(logger))
        )
      );
      await closeTransport(transport);
      opened.splice(opened.indexOf(transport), 1);
      sink.close();
      const logFile = fs.readdirSync(dirname).find((file) => file.endsWith('.log'));
      expect(logFile).toBeDefined();
      const content = fs.readFileSync(path.join(dirname, logFile ?? ''), 'utf8');
      expect(content).toContain('health-summary {"stage":"health","postPending":1}');
      expect(content.includes('individual-success')).toBe(trace);
      expect(content).not.toMatch(/secret|token|url/);
    }
  );
});

describe('scoped loggers created before the process sink', () => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-log-early-'));

  afterAll(() => {
    fs.rmSync(logRoot, { recursive: true, force: true });
  });

  // The CLI entry creates module-level scoped loggers (presence diagnostics among
  // them) before `lody start` installs the daemon file sink. Bound to the startup
  // console logger, every such line was discarded with the Worker's stdout.
  it('writes through the file sink installed after the logger was obtained', async () => {
    const early = getLogger('early-scope');
    const nested = early.child({ scope: 'nested' });
    const dirname = fs.mkdtempSync(path.join(logRoot, 'sink-'));
    const fileLogger = createFileLogger('early-%DATE%.log', dirname);
    const sink = Reflect.get(fileLogger, 'winston') as winston.Logger;
    const transport = sink.transports[0];
    if (!transport) throw new Error('file logger has no transport');
    await once(transport, 'new');
    early.debug('presence diagnostic from an early logger');
    nested.warn('nested diagnostic from an early logger');
    await closeTransport(transport);
    const logFile = fs.readdirSync(dirname).find((file) => file.endsWith('.log'));
    const content = fs.readFileSync(path.join(dirname, logFile ?? ''), 'utf8');
    expect(content).toContain('presence diagnostic from an early logger');
    expect(content).toContain('nested diagnostic from an early logger');
  });
});

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
});
