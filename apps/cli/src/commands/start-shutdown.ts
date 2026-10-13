import type { Logger } from '@/utils/logger';

export const START_SHUTDOWN_TIMEOUT_MS = 15_000;

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
  flushTelemetry: () => Promise<void>;
  exit: ShutdownExit;
  timeoutMs?: number;
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
      await options.flushTelemetry();
    } catch (error) {
      options.logger.debug(
        `Telemetry shutdown failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      options.exit(code);
    }
  };

  const forceExit = async (
    request: { signal?: NodeJS.Signals; exitCode: number },
    reason: string
  ) => {
    options.logger.warn(reason);
    await exitAfterTelemetry(request.exitCode || getExitCodeForSignal(request.signal) || 1);
  };

  const shutdown = async (request?: StartShutdownRequest) => {
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

    let exitCode = normalized.exitCode;
    try {
      await options.shutdown();
    } catch (error) {
      exitCode ||= 1;
      options.logger.error(
        `Shutdown error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      await exitAfterTelemetry(exitCode);
    }
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
