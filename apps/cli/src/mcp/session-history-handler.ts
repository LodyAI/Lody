import { pageVisibleTranscript, type SessionHistoryReader } from '@lody/shared/session-data';
import { isVisibleTranscriptTurn, toSessionTranscriptEntry } from '@/commands/session';
import {
  buildSessionHistoryPage,
  parseSessionHistoryCursor,
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
export async function buildSessionHistoryForReader(params: {
  sessionId: string;
  history: SessionHistoryReader;
  limit: number;
  cursor?: string;
  maxBytes: number;
}): Promise<SessionHistoryPageResponse> {
  const beforeIndex = parseSessionHistoryCursor(
    params.cursor,
    params.sessionId,
    Number.MAX_SAFE_INTEGER
  );
  const page = await pageVisibleTranscript(params.history, {
    limit: params.limit,
    ...(beforeIndex < Number.MAX_SAFE_INTEGER ? { cursor: String(beforeIndex) } : {}),
    isVisible: isVisibleTranscriptTurn,
  });
  const entries: SessionHistoryPageEntry[] = [];
  page.turns.forEach((turn, offset) => {
    const formatted = toSessionTranscriptEntry(page.positions[offset] ?? 0, turn);
    if (formatted) entries.push(formatted);
  });
  return buildSessionHistoryPage({
    sessionId: params.sessionId,
    entries,
    hasOlder: page.hasMore,
    maxBytes: params.maxBytes,
  });
}
