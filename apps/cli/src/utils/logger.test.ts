import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createFileTransport, createLogger, resolveFileLogLevel } from './logger';

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

  /**
   * Resolves once the rotator has opened its file, so teardown never races the
   * stream it is about to remove.
   */
  const openFileTransport = async (): Promise<ReturnType<typeof createFileTransport>> => {
    const dirname = fs.mkdtempSync(path.join(logRoot, 'sink-'));
    const transport = createFileTransport({ file: { dirname } });
    opened.push(transport);
    await new Promise<void>((resolve) => transport.once('new', () => resolve()));
    return transport;
  };

  afterEach(() => {
    delete process.env.LODY_LOG_TRACE;
    while (opened.length > 0) {
      opened.pop()?.close();
    }
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
