import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import winston from 'winston';
import { Effect } from 'effect';
import { lodyLoggerLayer } from '@/platform/logger';
import { __test__ as cliToolsTest } from './index';
import { readLatestLogTail } from './log-files';
import { cleanupExpiredLogs, LODY_LOG_RETENTION_MS } from './log-retention';
import { redactProxyUrl, sanitizeUrlForLogging } from './log-sanitize';
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

describe('cli tool detection helpers', () => {
  it('selectWindowsWhereCandidate prefers .cmd over .ps1', () => {
    const picked = cliToolsTest.selectWindowsWhereCandidate([
      'C:\\Users\\Z\\AppData\\Local\\fnm_multishells\\x\\codex.ps1',
      'C:\\Users\\Z\\AppData\\Local\\fnm_multishells\\x\\codex.cmd',
    ]);
    expect(picked).toMatch(/codex\.cmd$/i);
  });

  it('honors CODEX_HOME when computing the Codex auth path', () => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/tmp/custom-codex';
    try {
      expect(cliToolsTest.getCodexCredentialsPath('/tmp/home')).toBe('/tmp/custom-codex/auth.json');
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
    }
  });
});

describe('cleanupExpiredLogs', () => {
  const tempDirs: string[] = [];

  function createTempLogDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-log-retention-'));
    tempDirs.push(dir);
    return dir;
  }

  function touchWithMtime(filePath: string, mtimeMs: number): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'log', 'utf8');
    const mtime = new Date(mtimeMs);
    fs.utimesSync(filePath, mtime, mtime);
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes managed log files older than the retention window', () => {
    const now = Date.UTC(2026, 3, 5, 12, 0, 0);
    const logDir = createTempLogDir();

    const oldLog = path.join(logDir, '2026-03-20.log');
    const oldJsonl = path.join(logDir, 'acp', '20260320', 'session.jsonl');
    const recentLog = path.join(logDir, '2026-04-05.log');
    const oldText = path.join(logDir, 'notes.txt');

    touchWithMtime(oldLog, now - LODY_LOG_RETENTION_MS - 1);
    touchWithMtime(oldJsonl, now - LODY_LOG_RETENTION_MS - 1);
    touchWithMtime(recentLog, now - 60_000);
    touchWithMtime(oldText, now - LODY_LOG_RETENTION_MS - 1);

    const removed = cleanupExpiredLogs(logDir, { now });

    expect(removed).toBe(2);
    expect(fs.existsSync(oldLog)).toBe(false);
    expect(fs.existsSync(oldJsonl)).toBe(false);
    expect(fs.existsSync(recentLog)).toBe(true);
    expect(fs.existsSync(oldText)).toBe(true);
    expect(fs.existsSync(path.join(logDir, 'acp', '20260320'))).toBe(false);
  });
});

describe('sanitizeUrlForLogging and redactProxyUrl', () => {
  it('redacts common sensitive query params', () => {
    const raw = 'wss://example.com/ws/workspaces/abc?token=secret&machineId=xyz';
    expect(sanitizeUrlForLogging(raw)).toBe(
      'wss://example.com/ws/workspaces/abc?token=REDACTED&machineId=xyz'
    );
  });

  it('removes basic auth credentials', () => {
    const raw = 'https://user:pass@example.com/path?token=secret';
    expect(sanitizeUrlForLogging(raw)).toBe('https://example.com/path?token=REDACTED');
  });

  it('redacts credentials in proxy URLs', () => {
    const raw = 'http://user:pass@proxy.example.com:8080';
    expect(redactProxyUrl(raw)).toBe('http://[redacted]@proxy.example.com:8080');
  });
});

describe('readLatestLogTail', () => {
  const tempDirs: string[] = [];

  function createTempLogDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-log-files-'));
    tempDirs.push(dir);
    return dir;
  }

  function writeLog(dir: string, name: string, content: string, mtimeMs?: number): void {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, name.endsWith('.gz') ? zlib.gzipSync(content) : content);
    if (mtimeMs !== undefined) {
      const mtime = new Date(mtimeMs);
      fs.utimesSync(filePath, mtime, mtime);
    }
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the live rotation once the day has rolled past `<date>.log`', async () => {
    const dir = createTempLogDir();
    writeLog(dir, '2026-08-07.log.gz', 'a\nb\n');
    writeLog(dir, '2026-08-07.log.1', 'c\nd\n');

    const tail = await readLatestLogTail(dir, 2);

    expect(tail).toEqual({ files: ['2026-08-07.log.1'], text: 'c\nd' });
  });

  it('walks back through rotations when the live file is shorter than requested', async () => {
    const dir = createTempLogDir();
    writeLog(dir, '2026-08-06.log', 'old\n');
    writeLog(dir, '2026-08-07.log.gz', 'a\nb\n');
    writeLog(dir, '2026-08-07.log.1', 'c\n');

    const tail = await readLatestLogTail(dir, 3);

    expect(tail).toEqual({ files: ['2026-08-07.log.gz', '2026-08-07.log.1'], text: 'a\nb\nc' });
  });

  it('stops the walk at an unreadable archive instead of failing', async () => {
    const dir = createTempLogDir();
    fs.writeFileSync(path.join(dir, '2026-08-07.log.gz'), 'not actually gzip');
    writeLog(dir, '2026-08-07.log.1', 'live\n');

    await expect(readLatestLogTail(dir, 10)).resolves.toEqual({
      files: ['2026-08-07.log.1'],
      text: 'live',
    });
  });
});
