import { Cause, HashMap, Layer, Logger, LogLevel, Option } from 'effect';

import type { Logger as LodyLogger } from '@/utils/logger';

const formatLogMessage = (message: unknown): string =>
  Array.isArray(message) ? message.map((part) => String(part)).join(' ') : String(message);

/**
 * Annotate an Effect's logs with the owner label Lody log lines start with,
 * e.g. `[session-id]`, so process-layer diagnostics stay attributable.
 */
export const LOG_PREFIX_ANNOTATION = 'lody.logPrefix';

/**
 * Route Effect's `Effect.log*` calls into the daemon's Lody logger.
 *
 * The minimum level is lowered to `Debug` because the Lody logger applies its
 * own level and file-sink policy; filtering here too would silently drop debug
 * diagnostics the daemon file log is required to keep.
 */
export const lodyLoggerLayer = (logger: LodyLogger, defaultPrefix?: string): Layer.Layer<never> =>
  Layer.merge(
    Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ logLevel, message, cause, annotations }) => {
        const prefix = Option.match(HashMap.get(annotations, LOG_PREFIX_ANNOTATION), {
          onNone: () => (defaultPrefix === undefined ? '' : `${defaultPrefix} `),
          onSome: (value) => `${String(value)} `,
        });
        const body = Cause.isEmpty(cause)
          ? formatLogMessage(message)
          : `${formatLogMessage(message)} ${Cause.pretty(cause)}`;
        const text = `${prefix}${body}`;
        switch (logLevel._tag) {
          case 'Fatal':
          case 'Error':
            logger.error(text);
            return;
          case 'Warning':
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
      })
    ),
    Logger.minimumLogLevel(LogLevel.Debug)
  );
