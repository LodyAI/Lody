import { captureException, flushErrorReporting } from '@/instrument';
import { getLogger, rootLogger, type Logger } from './logger';
import { traceFatalErrorSync } from './process-exit-trace';

const DEFAULT_FLUSH_TIMEOUT = 2000;
const CLEANUP_TIMEOUT_MS = 5000;
let handlersRegistered = false;
let processCleanupFn: (() => Promise<void>) | null = null;

/**
 * Register a cleanup function that will be called before process.exit on
 * uncaught exceptions. Only the last registered function is kept.
 */
export function registerProcessCleanup(fn: () => Promise<void>): void {
  processCleanupFn = fn;
}

export function unregisterProcessCleanup(): void {
  processCleanupFn = null;
}

const normalizeError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

export const reportError = async (
  component: string,
  error: unknown,
  options: {
    message?: string;
    logger?: Logger;
    extra?: Record<string, unknown>;
    fatal?: boolean;
  } = {}
) => {
  const logger = options.logger ?? getLogger(component);
  if (options.message) {
    logger.error(options.message, error);
  } else {
    logger.error(error);
  }
  const err = normalizeError(error);
  await captureException(err, { component, extra: options.extra });

  if (options.fatal) {
    await flushErrorReporting(DEFAULT_FLUSH_TIMEOUT);
  }
};

export const registerProcessErrorHandlers = () => {
  if (handlersRegistered) {
    return;
  }
  handlersRegistered = true;

  process.on('uncaughtException', (error) => {
    traceFatalErrorSync('uncaughtException', error);
    console.error('Uncaught exception in CLI:', error);
    const cleanup = processCleanupFn
      ? Promise.race([
          processCleanupFn().catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, CLEANUP_TIMEOUT_MS)),
        ])
      : Promise.resolve();
    void cleanup.finally(() => {
      void reportError('uncaughtException', error, {
        message: 'Uncaught exception in CLI',
        logger: rootLogger,
        fatal: true,
      }).finally(() => process.exit(1));
    });
  });

  process.on('unhandledRejection', (reason) => {
    process.exitCode = 1;
    void reportError('unhandledRejection', reason, {
      message: 'Unhandled promise rejection in CLI',
      logger: rootLogger,
      fatal: false,
    });
  });
};
