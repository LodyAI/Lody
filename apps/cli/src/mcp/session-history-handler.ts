import { describeChatFailure, readChatFailureNotice } from '@lody/shared';
import { pageVisibleTranscript, type SessionHistoryReader } from '@lody/shared/session-data';
import { isVisibleTranscriptTurn, toSessionTranscriptEntry } from '@/commands/session';
import {
  buildSessionHistoryPage,
  parseSessionHistoryCursor,
  parseSessionHistoryForwardCursor,
  type SessionHistoryPageEntry,
  type SessionHistoryPageResponse,
} from './session-history-page';

/**
 * The production composition behind the MCP `session_history` tool: parse the
 * opaque raw cursor, page the displayable transcript through the session-data
 * reader and apply the 128 KiB byte cap. It is split from the tool handler (which
 * only resolves auth/workspace/manager) so this exact logic can be regression
 * tested against a real Loro reader without the auth/manager wiring.
 */
export type SessionHistoryReadFilters = {
  /** `backward` (default) pages newest-first; `forward` pages oldest-first. */
  direction?: 'backward' | 'forward';
  role?: 'user' | 'assistant';
  /** Only entries at or after this instant. */
  since?: string;
  /** Per-entry character cap; longer text is truncated, never dropped. */
  maxChars?: number;
};

const capEntryText = (entry: SessionHistoryPageEntry, maxChars: number | undefined) => {
  if (maxChars === undefined) return entry;
  const characters = Array.from(entry.text);
  if (characters.length <= maxChars) return entry;
  return {
    ...entry,
    text: characters.slice(0, maxChars).join(''),
    truncated: true as const,
    originalChars: characters.length,
  };
};

const FAILURE_NOTICE_SCAN_ROWS = 16;

/** Read the system-notice rows between a failed user Turn and the next input. */
const readFollowingChatFailure = async (
  history: SessionHistoryReader,
  position: number
): Promise<ReturnType<typeof readChatFailureNotice>> => {
  const total = await history.count();
  const notices: import('@lody/shared/session-data').SessionTurn[] = [];
  const end = Math.min(total, position + FAILURE_NOTICE_SCAN_ROWS);
  for (let index = position + 1; index < end; index += 1) {
    const read = await history.readAt(index);
    if (read.state !== 'ready') continue;
    if (read.turn.role === 'user') break;
    if (read.turn.role === 'system') notices.push(read.turn);
  }
  return readChatFailureNotice(notices);
};

export async function buildSessionHistoryForReader(
  params: {
    sessionId: string;
    history: SessionHistoryReader;
    limit: number;
    cursor?: string;
    maxBytes: number;
  } & SessionHistoryReadFilters
): Promise<SessionHistoryPageResponse> {
  const forward = params.direction === 'forward';
  const sinceMs = params.since === undefined ? undefined : Date.parse(params.since);
  const isVisible = (turn: Parameters<typeof isVisibleTranscriptTurn>[0]) =>
    isVisibleTranscriptTurn(turn) &&
    (params.role === undefined || turn.role === params.role) &&
    (sinceMs === undefined || Date.parse(turn.timestamp) >= sinceMs);
  const position = forward
    ? parseSessionHistoryForwardCursor(params.cursor, params.sessionId)
    : parseSessionHistoryCursor(params.cursor, params.sessionId, Number.MAX_SAFE_INTEGER);
  const page = await pageVisibleTranscript(params.history, {
    limit: params.limit,
    ...(forward ? { direction: 'forward' as const } : {}),
    ...(forward || position < Number.MAX_SAFE_INTEGER ? { cursor: String(position) } : {}),
    isVisible,
  });
  const formattedEntries: Array<{
    entry: SessionHistoryPageEntry;
    turn: (typeof page.turns)[number];
  }> = [];
  page.turns.forEach((turn, offset) => {
    const formatted = toSessionTranscriptEntry(page.positions[offset] ?? 0, turn);
    if (formatted) formattedEntries.push({ entry: capEntryText(formatted, params.maxChars), turn });
  });
  const failedTurns = new Map<string, ReturnType<typeof describeChatFailure>>();
  for (const [offset, turn] of page.turns.entries()) {
    if (turn.role !== 'user' || turn.status !== 'failed') continue;
    const notice = await readFollowingChatFailure(
      params.history,
      page.positions[offset] ?? 0
    ).catch(() => undefined);
    const noticeAt = notice?.at ? Date.parse(notice.at) : Number.NaN;
    const turnAt = Date.parse(turn.timestamp);
    failedTurns.set(
      turn.id,
      describeChatFailure(
        notice,
        Number.isFinite(noticeAt) ? noticeAt : Number.isFinite(turnAt) ? turnAt : Date.now()
      )
    );
  }
  const entries = formattedEntries.map(({ entry, turn }) => {
    const failure =
      turn.role === 'assistant' && turn.userTurnId
        ? failedTurns.get(turn.userTurnId)
        : failedTurns.get(turn.id);
    return failure ? { ...entry, isError: true as const, errorReason: failure.reason } : entry;
  });
  return buildSessionHistoryPage({
    sessionId: params.sessionId,
    entries,
    hasOlder: page.hasMore,
    maxBytes: params.maxBytes,
    ...(forward ? { forward: { nextPosition: Number(page.nextCursor ?? position) } } : {}),
  });
}
