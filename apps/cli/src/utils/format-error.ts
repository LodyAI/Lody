import { inspect } from 'node:util';
let formatLoroSyncError: (error: unknown) => string | undefined = () => undefined;

/** The Streams composition binds its typed formatter; standalone workers stay lightweight. */
export const registerLoroSyncErrorFormatter = (formatter: typeof formatLoroSyncError): void => {
  formatLoroSyncError = formatter;
};

type FormatErrorOptions = {
  includeStack?: boolean;
};

const readStructuredErrorDetail = (error: Error): string | undefined => {
  const data = (error as { data?: unknown }).data;
  if (typeof data === 'string' && data.length > 0) {
    return data;
  }
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const rawDetail = (data as { details?: unknown; message?: unknown }).details;
  if (typeof rawDetail === 'string' && rawDetail.length > 0) {
    return rawDetail;
  }
  const rawMessage = (data as { message?: unknown }).message;
  return typeof rawMessage === 'string' && rawMessage.length > 0 ? rawMessage : undefined;
};

/**
 * A tagged error without a message (Effect's `Data.TaggedError` default) still
 * names its type and cause, so a reported failure is never an empty string.
 */
const describeMessagelessError = (error: Error, seen: ReadonlySet<unknown>): string => {
  const tag = (error as { _tag?: unknown })._tag;
  const label = typeof tag === 'string' && tag.length > 0 ? tag : error.name || 'Error';
  const cause = (error as { cause?: unknown }).cause;
  if (cause === undefined || cause === null || seen.has(cause)) return label;
  // Only an Error or a string cause is described: these messages reach synced chat
  // history, so an arbitrary object (headers, env, options) is never dumped into it.
  const detail =
    cause instanceof Error
      ? cause.message
        ? formatErrorMessage(cause)
        : describeMessagelessError(cause, new Set([...seen, cause]))
      : typeof cause === 'string'
        ? cause
        : '';
  return detail ? `${label}: ${detail}` : label;
};

export const formatErrorMessage = (error: unknown, options: FormatErrorOptions = {}): string => {
  const syncError = formatLoroSyncError(error);
  if (syncError) return syncError;
  if (error instanceof Error) {
    const base = options.includeStack ? (error.stack ?? error.message) : error.message;
    const detail = readStructuredErrorDetail(error);
    if (!detail || base.includes(detail)) {
      return base;
    }
    return `${base}: ${detail}`;
  }

  if (typeof error === 'string') {
    return error;
  }

  return inspect(error, {
    depth: 5,
    maxArrayLength: 50,
    breakLength: 120,
  });
};

/**
 * Failure text for people (chat notices, error logs). Unlike `formatErrorMessage`,
 * which classifiers substring-match and which therefore keeps its exact output,
 * this never returns an empty string for a message-less error.
 */
export const formatReportedError = (error: unknown): string =>
  error instanceof Error && !error.message && !readStructuredErrorDetail(error)
    ? describeMessagelessError(error, new Set([error]))
    : formatErrorMessage(error);

const formatErrorWithCausesInternal = (error: unknown, seen: ReadonlySet<unknown>): string => {
  const syncError = formatLoroSyncError(error);
  if (syncError) return syncError;
  if (seen.has(error)) {
    return '[circular cause]';
  }
  const nextSeen = new Set(seen);
  nextSeen.add(error);

  if (error instanceof Error) {
    const parts = [error.message || error.name];
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      parts.push(`code=${code}`);
    }
    if (error instanceof AggregateError && error.errors.length > 0) {
      const nested = error.errors
        .slice(0, 3)
        .map((entry) => formatErrorWithCausesInternal(entry, nextSeen));
      parts.push(`errors=[${nested.join('; ')}]`);
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined) {
      parts.push(`cause=${formatErrorWithCausesInternal(cause, nextSeen)}`);
    }
    return parts.join('; ');
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
};

/** Preserve nested network error causes and errno-style codes in diagnostics. */
export const formatErrorWithCauses = (error: unknown): string =>
  formatErrorWithCausesInternal(error, new Set());
