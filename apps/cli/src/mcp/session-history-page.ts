import { LodyOperationStoreError } from '@/orchestration/operation-store';

/**
 * Pure response builder for the MCP `session_history` tool.
 *
 * `limit` is applied by the caller (displayable turns); this builder only owns
 * the 128 KiB byte cap and the cursor. A trimmed page must still advertise the
 * older entries it dropped, otherwise they become unreachable: `hasOlder` is
 * recomputed after every trim, not frozen from the pre-trim page.
 */

export type SessionHistoryCursor = { v: 1; sessionId: string; beforeIndex: number };

export type SessionHistoryPageEntry = {
  index: number;
  id: string;
  role: string;
  timestamp: string;
  text: string;
};

export type SessionHistoryPageRequest = {
  sessionId: string;
  /** Displayable entries in ascending raw-position order. */
  entries: readonly SessionHistoryPageEntry[];
  /** The store still has raw rows older than this page. */
  hasOlder: boolean;
  maxBytes: number;
};

export type SessionHistoryPageResponse = {
  sessionId: string;
  items: Array<Record<string, unknown>>;
  nextCursor?: string;
};

export const jsonBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

export const encodeSessionHistoryCursor = (cursor: SessionHistoryCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

export const parseSessionHistoryCursor = (
  cursor: string | undefined,
  sessionId: string,
  newestBeforeIndex: number
): number => {
  if (!cursor) return newestBeforeIndex;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8')
    ) as SessionHistoryCursor;
    if (
      value.v !== 1 ||
      value.sessionId !== sessionId ||
      !Number.isInteger(value.beforeIndex) ||
      value.beforeIndex < 0
    ) {
      throw new Error('cursor mismatch');
    }
    return value.beforeIndex;
  } catch {
    throw new LodyOperationStoreError(
      'CURSOR_INVALID',
      'History cursor is malformed or belongs to a different Session.',
      false
    );
  }
};

export const truncateSessionHistoryText = (text: string, maxBytes: number) => {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= maxBytes) return { text };
  const marker = maxBytes >= 5 ? '\n…\n' : '';
  const characters = Array.from(text);
  const split = (keptCharacters: number) => {
    const headCount = Math.ceil(keptCharacters / 2);
    const tailCount = keptCharacters - headCount;
    const head = characters.slice(0, headCount).join('');
    const tail = characters.slice(characters.length - tailCount).join('');
    return { head, tail, text: `${head}${marker}${tail}` };
  };
  let low = 0;
  let high = characters.length;
  let best = split(0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = split(middle);
    if (Buffer.byteLength(candidate.text, 'utf8') <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return {
    text: best.text,
    truncated: true as const,
    omittedBytes: originalBytes - Buffer.byteLength(best.head + best.tail, 'utf8'),
  };
};

export function buildSessionHistoryPage(
  request: SessionHistoryPageRequest
): SessionHistoryPageResponse {
  let items: Array<Record<string, unknown>> = request.entries.map((entry) => ({ ...entry }));
  let trimmed = false;
  const hasOlder = () => request.hasOlder || trimmed;
  const makeResponse = (): SessionHistoryPageResponse => {
    const firstIndex = typeof items[0]?.index === 'number' ? (items[0].index as number) : undefined;
    return {
      sessionId: request.sessionId,
      items,
      ...(hasOlder() && firstIndex !== undefined
        ? {
            nextCursor: encodeSessionHistoryCursor({
              v: 1,
              sessionId: request.sessionId,
              beforeIndex: firstIndex,
            }),
          }
        : {}),
    };
  };

  while (items.length > 1 && jsonBytes(makeResponse()) > request.maxBytes) {
    items.shift();
    // The dropped entries are older than the new firstIndex; the next page must
    // be able to reach them even when the store reported no further rows.
    trimmed = true;
  }
  if (items.length === 1 && jsonBytes(makeResponse()) > request.maxBytes) {
    const entry = items[0]!;
    const originalText = typeof entry.text === 'string' ? entry.text : '';
    let low = 0;
    let high = Buffer.byteLength(originalText, 'utf8');
    let best = truncateSessionHistoryText(originalText, 0);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = truncateSessionHistoryText(originalText, middle);
      items = [{ ...entry, ...candidate }];
      if (jsonBytes(makeResponse()) <= request.maxBytes) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    items = [{ ...entry, ...best }];
  }
  return makeResponse();
}
