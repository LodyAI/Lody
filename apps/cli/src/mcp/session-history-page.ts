import { LodyOperationStoreError } from '@/orchestration/operation-store';

/**
 * Pure response builder for the MCP `session_history` tool.
 *
 * `limit` is applied by the caller (displayable turns); this builder only owns
 * the 128 KiB byte cap and the cursor. A trimmed page must still advertise the
 * older entries it dropped, otherwise they become unreachable: `hasOlder` is
 * recomputed after every trim, not frozen from the pre-trim page.
 */

/** Backward pages end before `beforeIndex`; forward pages start at `fromIndex`. */
export type SessionHistoryCursor =
  | { v: 1; sessionId: string; beforeIndex: number }
  | { v: 1; sessionId: string; fromIndex: number };

export type SessionHistoryPageEntry = {
  index: number;
  id: string;
  role: string;
  timestamp: string;
  text: string;
  /** Set when a caller's per-entry `maxChars` cut the text. */
  truncated?: true;
  originalChars?: number;
};

export type SessionHistoryPageRequest = {
  sessionId: string;
  /** Displayable entries in ascending raw-position order. */
  entries: readonly SessionHistoryPageEntry[];
  /** The store still has raw rows older than this page. */
  hasOlder: boolean;
  maxBytes: number;
  /**
   * Forward pages read oldest-first from a start position. `nextPosition` is the
   * raw position after this page, so a caller resumes there even at the end.
   */
  forward?: { nextPosition: number };
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

const decodeSessionHistoryCursor = (
  cursor: string,
  sessionId: string,
  key: 'beforeIndex' | 'fromIndex'
): number => {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const position = value[key];
    if (
      value.v !== 1 ||
      value.sessionId !== sessionId ||
      typeof position !== 'number' ||
      !Number.isInteger(position) ||
      position < 0
    ) {
      throw new Error('cursor mismatch');
    }
    return position;
  } catch {
    throw new LodyOperationStoreError(
      'CURSOR_INVALID',
      'History cursor is malformed, belongs to a different Session, or was issued for the other direction.',
      false
    );
  }
};

export const parseSessionHistoryCursor = (
  cursor: string | undefined,
  sessionId: string,
  newestBeforeIndex: number
): number =>
  cursor ? decodeSessionHistoryCursor(cursor, sessionId, 'beforeIndex') : newestBeforeIndex;

/** Forward cursors start at a raw position; omitted means the oldest entry. */
export const parseSessionHistoryForwardCursor = (
  cursor: string | undefined,
  sessionId: string
): number => (cursor ? decodeSessionHistoryCursor(cursor, sessionId, 'fromIndex') : 0);

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
  const forward = request.forward;
  const makeResponse = (): SessionHistoryPageResponse => {
    if (forward) {
      const lastIndex = items.at(-1)?.index;
      // A trimmed forward page resumes at the first dropped entry.
      const fromIndex =
        trimmed && typeof lastIndex === 'number' ? lastIndex + 1 : forward.nextPosition;
      return {
        sessionId: request.sessionId,
        items,
        nextCursor: encodeSessionHistoryCursor({ v: 1, sessionId: request.sessionId, fromIndex }),
      };
    }
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
    if (forward) {
      items.pop();
      trimmed = true;
      continue;
    }
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
