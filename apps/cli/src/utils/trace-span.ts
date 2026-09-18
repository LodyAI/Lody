import { performance } from 'perf_hooks';
import { formatErrorMessage } from './format-error';
import type { Logger } from './logger';

type TraceField = string | number | boolean | null | undefined;
type TraceFields = Record<string, TraceField>;

const formatTraceValue = (value: Exclude<TraceField, null | undefined>): string => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(Math.round(value)) : String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : JSON.stringify(value);
};

const formatTraceFields = (fields?: TraceFields): string => {
  if (!fields) {
    return '';
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) {
      continue;
    }
    parts.push(`${key}=${formatTraceValue(value)}`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
};

export type TraceSpan = {
  end: (fields?: TraceFields) => void;
  fail: (error: unknown, fields?: TraceFields) => void;
};

/**
 * Spans that run per streamed token batch produce more log volume than every
 * other span combined, so they are marked `hot`: their start/end records go to
 * `trace` and stay out of the default file sink. Diagnosability is preserved on
 * the paths that matter — a hot span that fails, or that takes at least
 * `slowMs`, still reports at `debug`, so a stall or an error is visible without
 * turning tracing on.
 */
export type TraceSpanOptions = {
  hot?: boolean;
  slowMs?: number;
};

const DEFAULT_HOT_SPAN_SLOW_MS = 1_000;

export const startTraceSpan = (
  logger: Logger,
  name: string,
  fields?: TraceFields,
  options?: TraceSpanOptions
): TraceSpan => {
  const hot = options?.hot === true;
  const slowMs = options?.slowMs ?? (hot ? DEFAULT_HOT_SPAN_SLOW_MS : undefined);
  const startedAtMs = performance.now();
  let closed = false;
  const write = (quiet: boolean, line: string): void => {
    if (quiet) {
      logger.trace(line);
      return;
    }
    logger.debug(line);
  };

  write(hot, `[trace-span] start name=${name}${formatTraceFields(fields)}`);

  return {
    end: (endFields) => {
      if (closed) {
        return;
      }
      closed = true;
      const durationMs = Math.round(performance.now() - startedAtMs);
      const slow = slowMs !== undefined && durationMs >= slowMs;
      write(
        hot && !slow,
        `[trace-span] end name=${name} status=ok durationMs=${durationMs}${formatTraceFields({
          ...fields,
          ...endFields,
        })}`
      );
    },
    fail: (error, endFields) => {
      if (closed) {
        return;
      }
      closed = true;
      // Failures always report at debug: a hot path that breaks is exactly the
      // case the log has to explain without tracing enabled after the fact.
      logger.debug(
        `[trace-span] end name=${name} status=error durationMs=${Math.round(
          performance.now() - startedAtMs
        )}${formatTraceFields({
          ...fields,
          ...endFields,
          error: formatErrorMessage(error),
        })}`
      );
    },
  };
};

export const traceAsync = async <T>(
  logger: Logger,
  name: string,
  fields: TraceFields | undefined,
  run: () => Promise<T>,
  options?: TraceSpanOptions
): Promise<T> => {
  const span = startTraceSpan(logger, name, fields, options);
  try {
    const result = await run();
    span.end();
    return result;
  } catch (error) {
    span.fail(error);
    throw error;
  }
};
