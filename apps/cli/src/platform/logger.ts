import { Layer, Logger, References } from 'effect';

import type { Logger as LodyLogger } from '@/utils/logger';

const formatLogMessage = (message: unknown): string =>
  Array.isArray(message)
    ? message.map(formatLogMessage).join(' ')
    : typeof message === 'string' || typeof message === 'number' || typeof message === 'boolean'
      ? String(message)
      : '[structured value omitted]';

const numericFields: ReadonlySet<string> = new Set([
  'generation',
  'attempt',
  'seq',
  'elapsedMs',
  'pendingLocalCount',
  'authPending',
  'postPending',
  'authAgeMs',
  'postAgeMs',
  'sincePostResponseMs',
  'failures',
  'httpStatus',
  'barrierAgeMs',
  'barrierPendingMs',
  'ageMs',
  'physicalEntries',
  'queuedBytes',
  'releasePending',
]);
const enumFields: Readonly<Record<string, readonly string[]>> = {
  stage: [
    'local_update',
    'auth_start',
    'auth_ready',
    'auth_failed',
    'post_start',
    'post_response',
    'post_failed',
    'read_response',
    'read_failed',
    'barrier_complete',
    'barrier_failed',
    'health',
    'close_returned',
    'join_failed',
    'auth',
    'bootstrap',
    'queue',
    'post',
    'ack',
    'retry',
    'stall',
    'release',
    'heartbeat',
    'joined',
    'barrier',
  ],
  outcome: ['ok', 'http_failure', 'aborted', 'rejected', 'unavailable'],
  room: [
    'connecting',
    'joined',
    'reconnecting',
    'disconnected',
    'error',
    'detached',
    'unavailable',
  ],
  queueAgeMs: ['unavailable'],
  retryAttempt: ['unavailable'],
  peerReceipt: ['unavailable'],
  code: [
    'stream_not_found',
    'auth_failed',
    'auth_provider_error',
    'protocol_error',
    'payload_too_large',
    'network_error',
    'timeout',
    'initial_sync_timeout',
    'gone',
    'apply_incomplete',
    'server_error',
    'internal_error',
    'unknown',
    'payload_protection_error',
    'first_join_no_bootstrap',
    'join_failed',
    'terminal_room',
    'rejoin_failed',
    'upload_no_progress',
  ],
};

/** Content-free projection; unknown keys and arbitrary strings/objects never reach the sink. */
export const formatSafeLogFields = (fields: Readonly<Record<string, unknown>>): string => {
  const safe: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (
      numericFields.has(key) &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0
    ) {
      safe[key] = value;
    } else if (
      typeof value === 'string' &&
      Object.hasOwn(enumFields, key) &&
      enumFields[key]?.includes(value)
    ) {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length === 0 ? '' : ` ${JSON.stringify(safe)}`;
};

/**
 * Route Effect's `Effect.log*` calls into the daemon's Lody logger.
 *
 * The minimum level is lowered to `Trace` because the Lody logger applies its
 * own level and file-sink policy; filtering here too would silently drop debug
 * diagnostics the daemon file log is required to keep.
 */
export const lodyLoggerLayer = (logger: LodyLogger, prefix?: string): Layer.Layer<never> =>
  Layer.merge(
    Logger.layer([
      Logger.make(({ logLevel, message, cause, fiber }) => {
        const head = prefix === undefined ? '' : `${prefix} `;
        const body =
          cause.reasons.length === 0
            ? formatLogMessage(message)
            : `${formatLogMessage(message)} ${JSON.stringify({
                cause: cause.reasons.map((reason) => reason._tag),
              })}`;
        const text = `${head}${body}${formatSafeLogFields(fiber.getRef(References.CurrentLogAnnotations))}`;
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
    Layer.succeed(References.MinimumLogLevel, 'Trace')
  );
