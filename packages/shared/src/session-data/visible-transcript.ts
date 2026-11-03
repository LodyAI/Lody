import type { SessionHistoryReader } from './types';
import type { SessionTurn } from './domain';

// # Shared visible-transcript paging
//
// This is session business logic, not a storage capability, so it lives once for
// every backend and is called by the CLI/MCP instead of being a method on the
// reader. `limit` counts displayable turns; the cursor is a raw position, so
// hidden/empty rows never shift the caller and a tail of hidden rows is never
// reported as an empty history.

export type VisibleTranscriptRequest = {
  readonly limit: number;
  /**
   * `backward` (default) pages newest-first: the cursor is the raw position the
   * next older page ends before. `forward` pages oldest-first: the cursor is the
   * raw position the next page starts at, and is returned even at the end so a
   * caller can resume after later turns are appended.
   */
  readonly direction?: 'backward' | 'forward';
  /** Raw position from a previous page; omit for the newest (or oldest) page. */
  readonly cursor?: string;
  /** Decides whether a raw turn is part of the displayable transcript. */
  readonly isVisible: (turn: SessionTurn) => boolean;
};

export type VisibleTranscriptPage = {
  readonly turns: readonly SessionTurn[];
  /** Raw position of each turn in `turns`, aligned by index. */
  readonly positions: readonly number[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
};

const parseCursor = (cursor: string | undefined, total: number, fallback = total): number => {
  if (cursor === undefined) return fallback;
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed)) return total;
  return Math.max(0, Math.min(total, parsed));
};

export async function pageVisibleTranscript(
  reader: SessionHistoryReader,
  request: VisibleTranscriptRequest
): Promise<VisibleTranscriptPage> {
  const limit = Math.max(0, Math.floor(request.limit));
  if (limit === 0) return { turns: [], positions: [], hasMore: false };
  const total = await reader.count();
  if (request.direction === 'forward') return pageForward(reader, request, limit, total);
  let index = parseCursor(request.cursor, total) - 1;
  const page: Array<{ index: number; turn: SessionTurn }> = [];
  let hasMore = false;
  for (; index >= 0; index -= 1) {
    const read = await reader.readAt(index);
    if (read.state !== 'ready' || !request.isVisible(read.turn)) continue;
    if (page.length >= limit) {
      hasMore = true;
      break;
    }
    page.push({ index, turn: read.turn });
  }
  const nextCursor = index + 1 > 0 ? String(index + 1) : undefined;
  const ordered = page.reverse();
  return {
    turns: ordered.map((entry) => entry.turn),
    positions: ordered.map((entry) => entry.index),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    hasMore: hasMore && nextCursor !== undefined,
  };
}

async function pageForward(
  reader: SessionHistoryReader,
  request: VisibleTranscriptRequest,
  limit: number,
  total: number
): Promise<VisibleTranscriptPage> {
  let index = parseCursor(request.cursor, total, 0);
  const turns: SessionTurn[] = [];
  const positions: number[] = [];
  let hasMore = false;
  for (; index < total; index += 1) {
    const read = await reader.readAt(index);
    if (read.state !== 'ready' || !request.isVisible(read.turn)) continue;
    if (turns.length >= limit) {
      hasMore = true;
      break;
    }
    turns.push(read.turn);
    positions.push(index);
  }
  return { turns, positions, nextCursor: String(index), hasMore };
}
