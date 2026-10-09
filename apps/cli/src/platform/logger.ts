import { Cause, Layer, Logger, References } from 'effect';

import type { Logger as LodyLogger } from '@/utils/logger';

const formatLogMessage = (message: unknown): string =>
  Array.isArray(message) ? message.map((part) => String(part)).join(' ') : String(message);

/**
 * Route Effect's `Effect.log*` calls into the daemon's Lody logger.
 *
 * The minimum level is lowered to `Debug` because the Lody logger applies its
 * own level and file-sink policy; filtering here too would silently drop debug
 * diagnostics the daemon file log is required to keep.
 */
export const lodyLoggerLayer = (logger: LodyLogger, prefix?: string): Layer.Layer<never> =>
  Layer.merge(
    Logger.layer([
      Logger.make(({ logLevel, message, cause }) => {
        const head = prefix === undefined ? '' : `${prefix} `;
        const body =
          cause.reasons.length === 0
            ? formatLogMessage(message)
            : `${formatLogMessage(message)} ${Cause.pretty(cause)}`;
        const text = `${head}${body}`;
        switch (logLevel) {
          case 'Fatal':
          case 'Error':
            logger.error(text);
            return;
          case 'Warn':
            logger.warn(text);
            return;
          case 'Info':
            logger.info(text);
            return;
          case 'Trace':
            logger.trace(text);
            return;
          default:
            logger.debug(text);
        }
      }),
      Logger.tracerLogger,
    ]),
    Layer.succeed(References.MinimumLogLevel, 'Debug')
  );
