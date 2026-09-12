import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { createHistoryWriter } from '../src/history-writer';
import { HistoryWriteError } from '../src/history-write-schema';
import {
  createLoroSessionData,
  hashHistoryEntry,
  hashText,
  type HistoryImportInput,
  type SessionTurn,
} from '../src/session-data';
import type { SessionId } from '../src/ids';

const turn: SessionTurn = {
  id: 'u',
  role: 'user',
  timestamp: 'synthetic',
  items: [{ type: 'text', text: '你好 🦀' }],
};
const hashes = [hashHistoryEntry(turn)];
const input: HistoryImportInput = {
  mode: 'initialize',
  replay: {
    history: [turn],
    turnHashes: hashes,
    replayDigest: hashText(hashes.join('\n')),
    droppedNotifications: 0,
  },
};

describe('history import domain boundary', () => {
  it('preserves the frozen canonical hash bytes across runtimes', () => {
    const canonical = '{"items":[{"text":"你好 🦀","type":"text"}],"plan":[],"role":"user"}';
    expect(hashes[0]).toBe(createHash('sha256').update(canonical).digest('hex'));
  });
  it('rejects a missing cursor capability before writing', async () => {
    const doc = new LoroDoc();
    const data = createLoroSessionData({
      doc,
      sessionId: 'test' as SessionId,
      durability: 'unavailable',
    });
    expect(await data.commands.applyHistoryImport(input)).toMatchObject({
      status: 'rejected',
      reason: { code: 'unsupported' },
    });
    expect(await data.history.count()).toBe(0);
  });
  it('does not report a cursor failure after a write as rejected', async () => {
    const doc = new LoroDoc();
    const data = createLoroSessionData({
      doc,
      sessionId: 'test' as SessionId,
      durability: 'unavailable',
      historyImportCursor: {
        read: () => undefined,
        write: () => {
          throw new HistoryWriteError([{ path: [], code: 'cursor_failure' }]);
        },
      },
    });
    expect(await data.commands.applyHistoryImport(input)).toMatchObject({
      status: 'indeterminate',
    });
    expect(await data.history.count()).toBe(1);
  });
  it('refuses initialize if another writer populated the target', async () => {
    const doc = new LoroDoc();
    let cursor: unknown;
    const data = createLoroSessionData({
      doc,
      sessionId: 'test' as SessionId,
      durability: 'unavailable',
      historyImportCursor: {
        read: () => cursor,
        write: (value) => {
          cursor = value;
        },
      },
    });
    createHistoryWriter(doc).append({ ...turn, id: 'peer' });
    expect(await data.commands.applyHistoryImport(input)).toMatchObject({
      status: 'rejected',
      reason: { code: 'not_empty' },
    });
    expect((await data.history.readAll()).map((t) => t.id)).toEqual(['peer']);
    expect(cursor).toBeUndefined();
  });
});
