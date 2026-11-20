import { describe, expect, it } from 'vitest';
import {
  getLoroStreamIdForDocId,
  getTodayDocId,
  getTodayDocIdPrefix,
  isTodayDocOfUser,
  parseTodayDate,
  parseTodayDocId,
  type TodayDate,
  type WorkspaceId,
} from '../src';

const ws = 'ws1' as WorkspaceId;
const date = (value: string) => {
  const parsed = parseTodayDate(value);
  if (!parsed) throw new Error(`invalid test date ${value}`);
  return parsed;
};

describe('Today page identity', () => {
  it('round-trips a local user id whose colon would split the stream id', () => {
    const docId = getTodayDocId('local:abc-1', date('2026-11-20'));
    expect(docId).toBe('today-local%3Aabc-1-2026-11-20');
    expect(parseTodayDocId(docId)).toEqual({ userId: 'local:abc-1', date: '2026-11-20' });
    expect(getLoroStreamIdForDocId(ws, docId)).toBe('ws1:td:local%3Aabc-1:2026-11-20');
  });

  it('does not let a shorter user id claim pages of a user id it prefixes', () => {
    const other = getTodayDocId('abc-def', date('2026-11-20'));
    expect(other.startsWith(getTodayDocIdPrefix('abc'))).toBe(true);
    expect(isTodayDocOfUser(other, 'abc')).toBe(false);
    expect(isTodayDocOfUser(other, 'abc-def')).toBe(true);
  });

  it('rejects impossible dates and non-canonical encodings', () => {
    expect(parseTodayDate('2026-02-30')).toBeNull();
    expect(parseTodayDate('2026-1-05')).toBeNull();
    expect(parseTodayDocId('today-local%3aabc-2026-11-20')).toBeNull();
    expect(parseTodayDocId('today--2026-11-20')).toBeNull();
    expect(parseTodayDocId('today-abc-2026-11-2x')).toBeNull();
  });

  it('refuses to build a page id for an empty user', () => {
    expect(() => getTodayDocId('', date('2026-11-20') as TodayDate)).toThrow();
  });
});
