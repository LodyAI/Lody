import { describe, expect, it } from 'vitest';
import {
  buildSessionHistoryPage,
  parseSessionHistoryCursor,
  type SessionHistoryPageEntry,
} from './session-history-page';

const entry = (index: number, text: string): SessionHistoryPageEntry => ({
  index,
  id: `turn-${index}`,
  role: 'user',
  timestamp: '2026-01-01T00:00:00.000Z',
  text,
});

const pageFor = (
  all: readonly SessionHistoryPageEntry[],
  cursor: string | undefined,
  limit: number
): { entries: SessionHistoryPageEntry[]; hasOlder: boolean } => {
  const beforeIndex = cursor
    ? parseSessionHistoryCursor(cursor, 'session-1', Number.MAX_SAFE_INTEGER)
    : Number.MAX_SAFE_INTEGER;
  const below = all.filter((candidate) => candidate.index < beforeIndex);
  const selected = below.slice(-limit);
  // The store knows whether raw rows remain below the oldest selected entry.
  const hasOlder = selected.length > 0 && below.length > selected.length;
  return { entries: selected, hasOlder };
};

describe('buildSessionHistoryPage', () => {
  it('keeps dropped entries reachable when the first page held all visible history', () => {
    const all = [
      entry(0, 'a'.repeat(50_000)),
      entry(1, 'b'.repeat(50_000)),
      entry(2, 'c'.repeat(50_000)),
    ];
    let cursor: string | undefined;
    const reached: number[] = [];
    for (let page = 0; page < 5; page += 1) {
      const input = pageFor(all, cursor, 10);
      const response = buildSessionHistoryPage({
        sessionId: 'session-1',
        entries: input.entries,
        hasOlder: input.hasOlder,
        maxBytes: 120_000,
      });
      for (const item of response.items) reached.push(item.index as number);
      if (!response.nextCursor) {
        cursor = undefined;
        break;
      }
      cursor = response.nextCursor;
    }
    expect(new Set(reached)).toEqual(new Set([0, 1, 2]));
  });

  it('advertises older rows even when byte-trimming an otherwise complete page', () => {
    const response = buildSessionHistoryPage({
      sessionId: 'session-1',
      entries: [entry(0, 'a'.repeat(60_000)), entry(1, 'b'.repeat(60_000))],
      // The caller believed this page covered all displayable history.
      hasOlder: false,
      maxBytes: 120_000,
    });
    expect(response.items).toHaveLength(1);
    expect(response.nextCursor).toBeDefined();
    expect(parseSessionHistoryCursor(response.nextCursor, 'session-1', 0)).toBe(1);
  });

  it('omits the cursor once the page fits and no older rows remain', () => {
    const response = buildSessionHistoryPage({
      sessionId: 'session-1',
      entries: [entry(0, 'short'), entry(1, 'short')],
      hasOlder: false,
      maxBytes: 128 * 1024,
    });
    expect(response.items.map((item) => item.index)).toEqual([0, 1]);
    expect(response.nextCursor).toBeUndefined();
  });

  it('truncates a single oversized entry in place without dropping older access', () => {
    const response = buildSessionHistoryPage({
      sessionId: 'session-1',
      entries: [entry(0, 'x'.repeat(200_000))],
      hasOlder: false,
      maxBytes: 60_000,
    });
    expect(response.items).toHaveLength(1);
    expect(response.items[0]?.truncated).toBe(true);
    expect(response.nextCursor).toBeUndefined();
  });

  it('rejects a malformed or cross-session cursor', () => {
    expect(() => parseSessionHistoryCursor('not-a-cursor', 'session-1', 0)).toThrow(
      'History cursor is malformed'
    );
    const other = buildSessionHistoryPage({
      sessionId: 'session-2',
      entries: [entry(0, 'a'), entry(1, 'b')],
      hasOlder: true,
      maxBytes: 128 * 1024,
    }).nextCursor;
    expect(() => parseSessionHistoryCursor(other, 'session-1', 0)).toThrow(
      'History cursor is malformed'
    );
  });
});
