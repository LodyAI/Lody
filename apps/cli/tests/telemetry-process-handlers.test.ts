import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const logDir = vi.hoisted(() => ({ current: '' }));

vi.mock('@/utils/log-retention', () => ({
  get LODY_LOG_DIR() {
    return logDir.current;
  },
}));

vi.mock('@/instrument', () => ({
  captureException: vi.fn(async () => {}),
  flushErrorReporting: vi.fn(async () => {}),
}));

vi.mock('@/utils/logger', () => {
  const createSilentLogger = () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
    debug: () => {},
    trace: () => {},
    setLevel: () => {},
    child: () => createSilentLogger(),
    close: async () => {},
  });

  const rootLogger = createSilentLogger();

  return {
    rootLogger,
    getLogger: () => rootLogger,
  };
});

describe('registerProcessErrorHandlers', () => {
  it('does not hard-exit on unhandledRejection', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    const uncaughtBefore = new Set(process.listeners('uncaughtException'));
    const rejectionBefore = new Set(process.listeners('unhandledRejection'));

    vi.resetModules();
    const telemetry = await import('@/utils/telemetry');
    const instrument = await import('@/instrument');

    telemetry.registerProcessErrorHandlers();

    const uncaughtAfter = process.listeners('uncaughtException');
    const rejectionAfter = process.listeners('unhandledRejection');

    const addedUncaught = uncaughtAfter.filter((l) => !uncaughtBefore.has(l));
    const addedRejection = rejectionAfter.filter((l) => !rejectionBefore.has(l));

    expect(addedRejection).toHaveLength(1);

    (addedRejection[0] as (reason: unknown) => void)(new Error('boom'));

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(instrument.flushErrorReporting)).not.toHaveBeenCalled();

    for (const listener of addedUncaught) {
      process.off('uncaughtException', listener);
    }
    for (const listener of addedRejection) {
      process.off('unhandledRejection', listener);
    }

    process.exitCode = previousExitCode;
  });

  it('runs the fatal path once when stdio EPIPE errors repeat during shutdown', async () => {
    logDir.current = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-telemetry-epipe-'));
    const exited = Promise.withResolvers<void>();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      exited.resolve();
      return undefined as never;
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const uncaughtBefore = new Set(process.listeners('uncaughtException'));
    const rejectionBefore = new Set(process.listeners('unhandledRejection'));

    vi.resetModules();
    const telemetry = await import('@/utils/telemetry');
    telemetry.registerProcessErrorHandlers();
    const added = process.listeners('uncaughtException').filter((l) => !uncaughtBefore.has(l));
    expect(added).toHaveLength(1);
    const onUncaught = added[0] as (error: unknown) => void;

    const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    for (let i = 0; i < 1_000; i += 1) {
      onUncaught(epipe());
    }
    await exited.promise;

    const logText = fs
      .readdirSync(logDir.current)
      .map((file) => fs.readFileSync(path.join(logDir.current, file), 'utf8'))
      .join('');
    expect(logText.match(/\[process-fatal\] uncaughtException/g)).toHaveLength(2);
    expect(logText).toContain('write EPIPE (code=EPIPE)');
    expect(logText).toContain('suppressed 999 further uncaught exception(s)');
    // Writing the broken pipe again is what re-entered the handler.
    expect(consoleSpy).not.toHaveBeenCalled();

    for (const listener of added) {
      process.off('uncaughtException', listener);
    }
    for (const listener of process.listeners('unhandledRejection')) {
      if (!rejectionBefore.has(listener)) process.off('unhandledRejection', listener);
    }
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
    fs.rmSync(logDir.current, { recursive: true, force: true });
  });
});
