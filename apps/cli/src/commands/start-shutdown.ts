import type { Logger } from '@/utils/logger';

export const START_SHUTDOWN_TIMEOUT_MS = 15_000;
export const START_FORCE_SHUTDOWN_TIMEOUT_MS = 15_000;
export const START_TELEMETRY_SHUTDOWN_TIMEOUT_MS = 2_000;

type ShutdownExit = (code: number) => void;
export type StartShutdownRequest =
  | NodeJS.Signals
  | {
      signal?: NodeJS.Signals;
      exitCode?: number;
      reason?: string;
    };

export interface StartShutdownController {
  register(): void;
  unregister(): void;
  shutdown(request?: StartShutdownRequest): Promise<void>;
}

export interface StartShutdownControllerOptions {
  signals: NodeJS.Signals[];
  logger: Logger;
  shutdown: () => Promise<void>;
  /** Bypass graceful drains and start owned process cleanup concurrently. */
  forceShutdown?: () => Promise<void>;
  flushTelemetry: () => Promise<void>;
  exit: ShutdownExit;
  timeoutMs?: number;
  forceTimeoutMs?: number;
  telemetryTimeoutMs?: number;
}

const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGTERM: 143,
  SIGBREAK: 130,
};

export function getExitCodeForSignal(signal?: NodeJS.Signals): number {
  return signal ? (SIGNAL_EXIT_CODES[signal] ?? 1) : 0;
}

const normalizeShutdownRequest = (
  request?: StartShutdownRequest
): { signal?: NodeJS.Signals; exitCode: number; reason?: string } => {
  if (typeof request === 'string') {
    return { signal: request, exitCode: 0 };
  }
  return {
    signal: request?.signal,
    exitCode: request?.exitCode ?? 0,
    reason: request?.reason,
  };
};

export function createStartShutdownController(
  options: StartShutdownControllerOptions
): StartShutdownController {
  const shutdownHandlers = new Map<NodeJS.Signals, () => void>();
  const timeoutMs = options.timeoutMs ?? START_SHUTDOWN_TIMEOUT_MS;

  let isShuttingDown = false;
  let exitRequested = false;
  let shutdownTimeout: NodeJS.Timeout | null = null;
  let forcedShutdown: Promise<void> | null = null;
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  const withinDeadline = async (action: () => Promise<void>, milliseconds: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Shutdown phase deadline exceeded')),
            milliseconds
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const clearShutdownTimeout = () => {
    if (!shutdownTimeout) {
      return;
    }
    clearTimeout(shutdownTimeout);
    shutdownTimeout = null;
  };

  const unregister = () => {
    for (const [signal, handler] of shutdownHandlers.entries()) {
      process.off(signal, handler);
    }
    shutdownHandlers.clear();
  };

  const exitAfterTelemetry = async (code: number) => {
    if (exitRequested) {
      return;
    }

    exitRequested = true;
    clearShutdownTimeout();
    unregister();

    try {
      await withinDeadline(
        options.flushTelemetry,
        options.telemetryTimeoutMs ?? START_TELEMETRY_SHUTDOWN_TIMEOUT_MS
      );
    } catch (error) {
      options.logger.debug(
        `Telemetry shutdown failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      options.exit(code);
      resolveFinished();
    }
  };

  const forceExit = async (
    request: { signal?: NodeJS.Signals; exitCode: number },
    reason: string
  ) => {
    if (forcedShutdown) return forcedShutdown;
    options.logger.warn(reason);
    clearShutdownTimeout();
    forcedShutdown = Promise.resolve().then(async () => {
      if (options.forceShutdown) {
        try {
          await withinDeadline(
            options.forceShutdown,
            options.forceTimeoutMs ?? START_FORCE_SHUTDOWN_TIMEOUT_MS
          );
        } catch {
          options.logger.warn('Forced process cleanup did not complete successfully before exit');
        }
      }
      await exitAfterTelemetry(request.exitCode || getExitCodeForSignal(request.signal) || 1);
    });
    return forcedShutdown;
  };

  const shutdown = async (request?: StartShutdownRequest) => {
    if (exitRequested) return finished;
    const normalized = normalizeShutdownRequest(request);
    if (isShuttingDown) {
      await forceExit(
        normalized,
        normalized.signal
          ? `Received ${normalized.signal} while shutdown is still in progress; forcing exit...`
          : 'Shutdown is still in progress; forcing exit...'
      );
      return;
    }

    isShuttingDown = true;
    const reason = normalized.reason ? ` (${normalized.reason})` : '';
    options.logger.info(
      normalized.signal
        ? `\nReceived ${normalized.signal}, shutting down gracefully${reason}...`
        : `\nShutting down gracefully${reason}...`
    );

    shutdownTimeout = setTimeout(() => {
      void forceExit(
        normalized,
        `Graceful shutdown did not finish within ${timeoutMs}ms; forcing exit...`
      );
    }, timeoutMs);

    const graceful = Promise.resolve().then(async () => {
      try {
        await options.shutdown();
      } catch (error) {
        options.logger.error(
          `Shutdown error: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
        await forceExit(
          normalized,
          'Graceful shutdown failed; attempting forced process cleanup...'
        );
      } finally {
        if (forcedShutdown) await forcedShutdown;
        else await exitAfterTelemetry(normalized.exitCode);
      }
    });
    await Promise.race([graceful, finished]);
  };

  return {
    register() {
      if (shutdownHandlers.size > 0) {
        return;
      }

      for (const signal of options.signals) {
        const handler = () => {
          void shutdown(signal);
        };
        shutdownHandlers.set(signal, handler);
        process.on(signal, handler);
      }
    },
    unregister,
    shutdown,
  };
}
