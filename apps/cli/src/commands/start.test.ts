import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliType, SUPPORTED_CLI_TYPES } from '@lody/shared';
import { resolveCliTypesSelection } from './start-options';
import { createStartShutdownController } from './start-shutdown';
import type { Logger } from '@/utils/logger';

function createTestLogger(): Logger {
  let logger: Logger;
  logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    setLevel: vi.fn(),
    setDebug: vi.fn(),
    child: vi.fn(() => logger),
    close: vi.fn(async () => {}),
  };
  return logger;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: () => {
      resolvePromise?.();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('start command cli type selection', () => {
  it('defaults to all supported CLI types when none are requested', () => {
    const result = resolveCliTypesSelection({
      requestedCliTypes: undefined,
      availability: {
        kimi: 'managed-runtime',
        grok: 'managed-runtime',
        claude: '1.0.0',
        codex: '1.0.0',
      },
    });

    expect(result).toEqual({
      configuredCliTypes: SUPPORTED_CLI_TYPES,
      cliTypes: SUPPORTED_CLI_TYPES,
      missing: [],
      invalid: [],
      isDefaultSelection: true,
    });
  });

  it('defaults to installed CLI types only when a subset is available', () => {
    const result = resolveCliTypesSelection({
      requestedCliTypes: undefined,
      availability: {
        kimi: false,
        grok: false,
        claude: '1.0.0',
        codex: false,
      },
    });

    expect(result).toEqual({
      configuredCliTypes: ['claude'],
      cliTypes: ['claude'],
      missing: [],
      invalid: [],
      isDefaultSelection: true,
    });
  });

  it('uses requested CLI types and reports missing ones in native mode', () => {
    const result = resolveCliTypesSelection({
      requestedCliTypes: ['codex'],
      availability: {
        kimi: false,
        grok: false,
        claude: false,
        codex: false,
      },
    });

    expect(result).toEqual({
      configuredCliTypes: ['codex'],
      cliTypes: [],
      missing: ['codex'],
      invalid: [],
      isDefaultSelection: false,
    });
  });

  it('keeps available requested CLI types and skips missing ones', () => {
    const result = resolveCliTypesSelection({
      requestedCliTypes: ['codex', 'claude'],
      availability: {
        kimi: false,
        grok: false,
        claude: '1.0.0',
        codex: false,
      },
    });

    expect(result).toEqual({
      configuredCliTypes: ['codex', 'claude'],
      cliTypes: ['claude'],
      missing: ['codex'],
      invalid: [],
      isDefaultSelection: false,
    });
  });

  it('returns empty cliTypes when all explicitly requested types are missing', () => {
    const result = resolveCliTypesSelection({
      requestedCliTypes: ['codex'],
      availability: {
        kimi: false,
        grok: false,
        claude: false,
        codex: false,
      },
    });

    expect(result).toEqual({
      configuredCliTypes: ['codex'],
      cliTypes: [],
      missing: ['codex'],
      invalid: [],
      isDefaultSelection: false,
    });
  });

  it('marks unknown requested cli types as invalid', () => {
    const result = resolveCliTypesSelection({
      requestedCliTypes: ['claude', 'codxe' as CliType],
      availability: {
        kimi: false,
        grok: false,
        claude: '1.0.0',
        codex: false,
      },
    });

    expect(result).toEqual({
      configuredCliTypes: ['claude'],
      cliTypes: ['claude'],
      missing: [],
      invalid: ['codxe'],
      isDefaultSelection: false,
    });
  });

  it('creates no builtin defaults when no local CLI is installed', () => {
    const result = resolveCliTypesSelection({
      requestedCliTypes: undefined,
      availability: {
        kimi: false,
        grok: false,
        claude: false,
        codex: false,
      },
    });

    expect(result).toEqual({
      configuredCliTypes: [],
      cliTypes: [],
      missing: [],
      invalid: [],
      isDefaultSelection: true,
    });
  });
});

describe('start shutdown controller', () => {
  it('exits with 0 after graceful shutdown completes', async () => {
    const logger = createTestLogger();
    const exits: number[] = [];
    let cleanedUp = false;
    let telemetryFlushed = false;

    const controller = createStartShutdownController({
      signals: ['SIGINT'],
      logger,
      shutdown: async () => {
        cleanedUp = true;
      },
      flushTelemetry: async () => {
        telemetryFlushed = true;
      },
      exit: (code) => {
        exits.push(code);
      },
      timeoutMs: 1_000,
    });

    await controller.shutdown('SIGINT');

    expect(cleanedUp).toBe(true);
    expect(telemetryFlushed).toBe(true);
    expect(exits).toEqual([0]);
    expect(logger.info).toHaveBeenCalledWith('\nReceived SIGINT, shutting down gracefully...');
  });

  it('preserves explicit lifecycle exit code after graceful shutdown', async () => {
    const logger = createTestLogger();
    const exits: number[] = [];

    const controller = createStartShutdownController({
      signals: ['SIGINT'],
      logger,
      shutdown: async () => {},
      flushTelemetry: async () => {},
      exit: (code) => {
        exits.push(code);
      },
      timeoutMs: 1_000,
    });

    await controller.shutdown({ exitCode: 43, reason: 'machine upgrade requested' });

    expect(exits).toEqual([43]);
    expect(logger.info).toHaveBeenCalledWith(
      '\nShutting down gracefully (machine upgrade requested)...'
    );
  });

  it('forces exit on a repeated signal while shutdown is still pending', async () => {
    const logger = createTestLogger();
    const exits: number[] = [];
    const cleanup = createDeferred();

    const controller = createStartShutdownController({
      signals: ['SIGINT'],
      logger,
      shutdown: () => cleanup.promise,
      flushTelemetry: async () => {},
      exit: (code) => {
        exits.push(code);
      },
      timeoutMs: 1_000,
    });

    const firstShutdown = controller.shutdown('SIGINT');
    await Promise.resolve();

    await controller.shutdown('SIGINT');

    expect(exits).toEqual([130]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Received SIGINT while shutdown is still in progress; forcing exit...'
    );

    cleanup.resolve();
    await firstShutdown;

    expect(exits).toEqual([130]);
  });

  it('forces exit when graceful shutdown exceeds the timeout', async () => {
    vi.useFakeTimers();

    const logger = createTestLogger();
    const exits: number[] = [];
    const cleanup = createDeferred();

    const controller = createStartShutdownController({
      signals: ['SIGINT'],
      logger,
      shutdown: () => cleanup.promise,
      flushTelemetry: async () => {},
      exit: (code) => {
        exits.push(code);
      },
      timeoutMs: 1_000,
    });

    const shutdownPromise = controller.shutdown('SIGINT');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(exits).toEqual([130]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Graceful shutdown did not finish within 1000ms; forcing exit...'
    );

    cleanup.resolve();
    await shutdownPromise;

    expect(exits).toEqual([130]);
  });
});
