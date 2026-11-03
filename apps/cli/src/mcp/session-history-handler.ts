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
  const entries: SessionHistoryPageEntry[] = [];
  page.turns.forEach((turn, offset) => {
    const formatted = toSessionTranscriptEntry(page.positions[offset] ?? 0, turn);
    if (formatted) entries.push(capEntryText(formatted, params.maxChars));
  });
  return buildSessionHistoryPage({
    sessionId: params.sessionId,
    entries,
    hasOlder: page.hasMore,
    maxBytes: params.maxBytes,
    ...(forward ? { forward: { nextPosition: Number(page.nextCursor ?? position) } } : {}),
  });
}
