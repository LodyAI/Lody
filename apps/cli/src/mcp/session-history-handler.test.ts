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

  it('resumes a byte-cap-trimmed forward page at the first dropped entry', async () => {
    const doc = new Loro();
    const data = createLoroSessionData({ sessionId, doc });
    for (let index = 0; index < 3; index += 1) {
      await data.commands.appendTurn(turn(`f${index}`));
    }
    const page = await buildSessionHistoryForReader({
      sessionId,
      history: data.history,
      limit: 10,
      direction: 'forward',
      maxBytes: 128 * 1024,
    });
    expect(indicesOf(page.items)).toEqual([0, 1]);
    const next = await buildSessionHistoryForReader({
      sessionId,
      history: data.history,
      limit: 10,
      direction: 'forward',
      cursor: page.nextCursor,
      maxBytes: 128 * 1024,
    });
    expect(indicesOf(next.items)).toEqual([2]);
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

  const conversation = async () => {
    const doc = new Loro();
    const data = createLoroSessionData({ sessionId, doc });
    const append = (id: string, role: 'user' | 'assistant', minute: number, text: string) =>
      data.commands.appendTurn({
        id,
        role,
        timestamp: `2026-01-01T00:0${minute}:00.000Z`,
        items: [{ type: 'text', text }],
        fileDiff: [],
      });
    await append('u0', 'user', 0, 'first instruction');
    await append('a0', 'assistant', 1, 'first summary');
    await append('u1', 'user', 2, 'second instruction');
    await append('a1', 'assistant', 3, 'second summary');
    return { data, append };
  };
  const read = (
    data: Awaited<ReturnType<typeof conversation>>['data'],
    options: Partial<Parameters<typeof buildSessionHistoryForReader>[0]> = {}
  ) =>
    buildSessionHistoryForReader({
      sessionId,
      history: data.history,
      limit: 10,
      maxBytes: 128 * 1024,
      ...options,
    });
  const texts = (items: Array<Record<string, unknown>>) => items.map((item) => item.text);

  it('reads forward and resumes from its cursor after later turns are appended', async () => {
    const { data, append } = await conversation();
    const first = await read(data, { direction: 'forward', limit: 3 });
    expect(texts(first.items)).toEqual([
      'first instruction',
      'first summary',
      'second instruction',
    ]);

    const second = await read(data, { direction: 'forward', cursor: first.nextCursor });
    expect(texts(second.items)).toEqual(['second summary']);

    await append('u2', 'user', 4, 'third instruction');
    const resumed = await read(data, { direction: 'forward', cursor: second.nextCursor });
    expect(texts(resumed.items)).toEqual(['third instruction']);
  });

  it('marks a failed turn and its notice reason without matching text', async () => {
    const doc = new Loro();
    const data = createLoroSessionData({ sessionId, doc });
    await data.commands.appendTurn({
      id: 'u-failed',
      role: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      status: 'failed',
      items: [{ type: 'text', text: 'do the work' }],
      fileDiff: [],
    });
    await data.commands.appendTurn({
      id: 'notice-failed',
      role: 'system',
      timestamp: '2026-01-01T00:00:01.000Z',
      items: [
        {
          type: 'system_notice',
          name: 'chat_failed',
          meta: {
            reason: 'acp_upstream_api_error',
            message: "You've hit your 5-hour limit · resets 6am (UTC)",
          },
        },
      ],
      fileDiff: [],
    });
    await data.commands.appendTurn({
      id: 'u-next',
      role: 'user',
      timestamp: '2026-01-01T00:01:00.000Z',
      items: [{ type: 'text', text: 'next instruction' }],
      fileDiff: [],
    });

    const page = await buildSessionHistoryForReader({
      sessionId,
      history: data.history,
      limit: 10,
      maxBytes: 128 * 1024,
    });
    expect(page.items).toContainEqual(
      expect.objectContaining({
        id: 'u-failed',
        text: 'do the work',
        isError: true,
        errorReason: 'usage_limit',
      })
    );
    expect(page.items).toContainEqual(expect.objectContaining({ id: 'u-next' }));
    expect(page.items.find((item) => item.id === 'u-next')).not.toHaveProperty('isError');
  });

  it('rejects a cursor issued for the other direction', async () => {
    const { data } = await conversation();
    const backward = await read(data, { limit: 1 });
    await expect(
      read(data, { direction: 'forward', cursor: backward.nextCursor })
    ).rejects.toMatchObject({ code: 'CURSOR_INVALID' });
  });

  it('filters by role and time, and truncates text without dropping entries', async () => {
    const { data } = await conversation();
    expect(texts((await read(data, { role: 'assistant', limit: 1 })).items)).toEqual([
      'second summary',
    ]);
    expect(
      texts(
        (
          await read(data, {
            role: 'user',
            since: '2026-01-01T00:02:00.000Z',
            direction: 'forward',
          })
        ).items
      )
    ).toEqual(['second instruction']);
    expect((await read(data, { role: 'user', maxChars: 5 })).items).toEqual([
      expect.objectContaining({ text: 'first', truncated: true, originalChars: 17 }),
      expect.objectContaining({ text: 'secon', truncated: true, originalChars: 18 }),
    ]);
  });
});
