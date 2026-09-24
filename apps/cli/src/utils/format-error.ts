import { inspect } from 'node:util';

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

export const formatErrorMessage = (error: unknown, options: FormatErrorOptions = {}): string => {
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

const formatErrorWithCausesInternal = (error: unknown, seen: ReadonlySet<unknown>): string => {
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
