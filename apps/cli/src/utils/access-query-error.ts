export const ACCESS_QUERY_RETRY_DELAYS_MS = [250, 1_000, 2_000] as const;

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const NETWORK_MESSAGE =
  /\b(fetch failed|failed to fetch|network error|socket hang up|connection (?:reset|refused)|timed? out|econnrefused|econnreset|enetdown|enetunreach|enotfound|eai_again|etimedout)\b/iu;

// Bounded traversal: diagnostics never stringify errors, messages, URLs, or payloads.
const errorRecords = (error: unknown): unknown[] => {
  const queue = [error];
  const seen = new Set<unknown>();
  const records: unknown[] = [];
  while (queue.length > 0 && records.length < 8) {
    const value = queue.shift();
    if (seen.has(value)) continue;
    seen.add(value);
    records.push(value);
    if (value && typeof value === 'object') {
      const record = value as { cause?: unknown; errors?: unknown };
      if (record.cause !== undefined) queue.push(record.cause);
      if (Array.isArray(record.errors)) queue.push(...record.errors.slice(0, 3));
    }
  }
  return records;
};

export function safeAccessQueryErrorDetails(error: unknown): {
  causeCodes: string[];
  httpStatuses: number[];
} {
  const causeCodes = new Set<string>();
  const httpStatuses = new Set<number>();
  for (const value of errorRecords(error)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as { code?: unknown; status?: unknown; statusCode?: unknown };
    if (typeof record.code === 'string' && NETWORK_CODES.has(record.code))
      causeCodes.add(record.code);
    for (const status of [record.status, record.statusCode]) {
      if (
        typeof status === 'number' &&
        Number.isInteger(status) &&
        status >= 100 &&
        status <= 599
      ) {
        httpStatuses.add(status);
      }
    }
  }
  return { causeCodes: [...causeCodes], httpStatuses: [...httpStatuses] };
}

/** Only for idempotent access queries; a definitive HTTP rejection wins over text. */
export function isTransientAccessQueryError(error: unknown): boolean {
  const details = safeAccessQueryErrorDetails(error);
  if (
    details.httpStatuses.some(
      (status) =>
        (status >= 400 && status < 500 && status !== 408 && status !== 429) || status === 560
    )
  )
    return false;
  if (
    details.causeCodes.length > 0 ||
    details.httpStatuses.some((status) => status === 408 || status === 429 || status >= 500)
  )
    return true;
  return errorRecords(error).some((value) => {
    if (typeof value === 'string') return NETWORK_MESSAGE.test(value);
    if (!value || typeof value !== 'object') return false;
    const message = (value as { message?: unknown }).message;
    return typeof message === 'string' && NETWORK_MESSAGE.test(message);
  });
}
