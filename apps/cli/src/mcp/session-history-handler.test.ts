import { describe, expect, it } from 'vitest';
import { Loro } from 'loro-crdt';
import { createLoroSessionData, type SessionId, type SessionTurn } from '@lody/shared/session-data';
import { buildSessionHistoryForReader } from './session-history-handler';

// The production composition (`pageVisibleTranscript` + the real transcript
// formatter + `buildSessionHistoryPage`) over a real Loro page reader. Only the
// MCP auth/workspace/manager wiring is not exercised here.

const sessionId = 'synthetic-mcp-session' as SessionId;
const TURN_TEXT = 'x'.repeat(60_000);

const turn = (id: string): SessionTurn => ({
  id,
  role: 'assistant',
  timestamp: '2026-01-01T00:00:00.000Z',
  items: [{ type: 'text', text: TURN_TEXT }],
  fileDiff: [],
});

const indicesOf = (items: Array<Record<string, unknown>>): number[] =>
  items.map((item) => item.index as number);

describe('MCP session_history production composition', () => {
  it('keeps byte-cap-trimmed entries reachable through nextCursor', async () => {
    const doc = new Loro();
    const data = createLoroSessionData({ sessionId, doc });
    for (let index = 0; index < 3; index += 1) {
      await data.commands.appendTurn(turn(`a${index}`));
    }

    const page = await buildSessionHistoryForReader({
      sessionId,
      history: data.history,
      limit: 10,
      maxBytes: 128 * 1024,
    });
    // Three 60,000-char turns cannot fit the byte cap; the oldest is dropped
    // from the page and must still be advertised.
    expect(indicesOf(page.items)).toEqual([1, 2]);
    expect(typeof page.nextCursor).toBe('string');

    const older = await buildSessionHistoryForReader({
      sessionId,
      history: data.history,
      limit: 10,
      cursor: page.nextCursor,
      maxBytes: 128 * 1024,
    });
    expect(indicesOf(older.items)).toEqual([0]);
  });

  it('returns the newest displayable page without a cursor when everything fits', async () => {
    const doc = new Loro();
    const data = createLoroSessionData({ sessionId, doc });
    for (let index = 0; index < 2; index += 1) {
      await data.commands.appendTurn(turn(`b${index}`));
    }
    const page = await buildSessionHistoryForReader({
      sessionId,
      history: data.history,
      limit: 10,
      maxBytes: 128 * 1024,
    });
    expect(indicesOf(page.items)).toEqual([0, 1]);
    expect(page.nextCursor).toBeUndefined();
  });
});
