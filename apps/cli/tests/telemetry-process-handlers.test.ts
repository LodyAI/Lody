import { describe, expect, it, vi } from 'vitest';

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
});
