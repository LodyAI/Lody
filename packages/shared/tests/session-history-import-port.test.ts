import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { createHistoryWriter } from '../src/history-writer';
import { HistoryWriteError } from '../src/history-write-schema';
import {
  createLoroSessionData,
  hashHistoryEntry,
  hashHistoryEntryForVersion,
  hashText,
  HASH_VERSION_V1,
  HASH_VERSION_V2,
  type HistoryImportCursor,
  type HistoryImportInput,
  type HistoryImportReplay,
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
    // The fixture hashes above are computed with the frozen v1 canonical form.
    hashVersion: HASH_VERSION_V1,
  },
};

describe('history import domain boundary', () => {
  it('preserves the frozen canonical hash bytes across runtimes', () => {
    const canonical = '{"items":[{"text":"你好 🦀","type":"text"}],"plan":[],"role":"user"}';
    expect(hashes[0]).toBe(createHash('sha256').update(canonical).digest('hex'));
    // Fixed v1 fixture captured on unmodified main: v1 canonicalization must not move.
    expect(hashes[0]).toBe('cc7ec54e218e6c9570af864fa57d76ee5677fcd0897c1b4919564e969f585935');
  });
  it('rejects a missing cursor capability before writing', async () => {
    const doc = new LoroDoc();
    const data = createLoroSessionData({
      doc,
      sessionId: 'test' as SessionId,
    });
    expect(await data.commands.applyHistoryImport(input)).toMatchObject({
      status: 'rejected',
      reason: { code: 'unsupported' },
    });
    expect(await data.history.count()).toBe(0);
  });
  it('does not report a cursor failure after a write as rejected', async () => {
    const doc = new LoroDoc();
    let attempted: unknown;
    const data = createLoroSessionData({
      doc,
      sessionId: 'test' as SessionId,
      historyImportCursor: {
        read: () => undefined,
        write: (value) => {
          attempted = value;
          throw new HistoryWriteError([{ path: [], code: 'cursor_failure' }]);
        },
      },
    });
    expect(await data.commands.applyHistoryImport(input)).toMatchObject({
      status: 'indeterminate',
    });
    expect(await data.history.count()).toBe(1);
    // The failed cursor write still carried the replay's version; the outcome stays
    // indeterminate rather than rejected/retry-safe because history was written.
    expect((attempted as HistoryImportCursor).hashVersion).toBe(HASH_VERSION_V1);
    expect((attempted as HistoryImportCursor).importedTurnHashes).toEqual(hashes);
  });
  it('refuses initialize if another writer populated the target', async () => {
    const doc = new LoroDoc();
    let cursor: unknown;
    const data = createLoroSessionData({
      doc,
      sessionId: 'test' as SessionId,
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

describe('versioned history import through the real port', () => {
  const userTurn = (n: number): SessionTurn => ({
    id: `u${n}`,
    role: 'user',
    timestamp: 'synthetic',
    items: [{ type: 'text', text: `question ${n}` }],
  });
  const assistantTurn = (n: number): SessionTurn => ({
    id: `a${n}`,
    role: 'assistant',
    timestamp: 'synthetic',
    items: [
      {
        type: 'tool_call',
        toolCallId: `call-${n}`,
        status: 'completed',
        kind: 'read',
        title: `Read ${n}`,
        content: [{ type: 'terminal_output', output: `output ${n}` }],
      } as never,
    ],
  });
  const rounds = (count: number): SessionTurn[] =>
    Array.from({ length: count }, (_, i) => [userTurn(i), assistantTurn(i)]).flat();

  const replayOf = (history: readonly SessionTurn[], version: number): HistoryImportReplay => {
    const turnHashes = history.map((entry) => hashHistoryEntryForVersion(entry, version));
    return {
      history,
      turnHashes,
      replayDigest: hashText(turnHashes.join('\n')),
      droppedNotifications: 0,
      hashVersion: version,
    };
  };

  /** The exact cursor shape a pre-version client writes: no `hashVersion` field anywhere. */
  const genuineV1Cursor = (sourceHashes: readonly string[], stored: readonly SessionTurn[]) => ({
    importedTurnHashes: [...sourceHashes],
    storedHistoryBaseline: JSON.stringify({
      version: 1,
      sourceDigest: hashText(sourceHashes.join('\n')),
      turnHashes: stored.map((entry) => hashHistoryEntryForVersion(entry, HASH_VERSION_V1)),
    }),
  });

  function openPort(doc: LoroDoc) {
    let cursor: unknown;
    const data = createLoroSessionData({
      doc,
      sessionId: 'test' as SessionId,
      historyImportCursor: {
        read: () => cursor,
        write: (value) => {
          cursor = value;
        },
      },
    });
    return {
      data,
      getCursor: () => cursor as HistoryImportCursor | undefined,
      setCursor: (value: unknown) => {
        cursor = value;
      },
    };
  }

  /** Seed a doc exactly as an old client left it: v1 content, unversioned cursor/meta. */
  async function seedLegacyDoc(roundsStored: number) {
    const doc = new LoroDoc();
    const port = openPort(doc);
    const replay = replayOf(rounds(roundsStored), HASH_VERSION_V1);
    const result = await port.data.commands.applyHistoryImport({
      mode: 'initialize',
      replay,
    });
    expect(result).toMatchObject({ status: 'accepted' });
    // Downgrade the freshly written cursor to the genuine old shape: same hashes and
    // baseline, but no `hashVersion` field anywhere, exactly as an old client wrote it.
    // The baseline hashes the ACTUAL stored content, like the old createImportCursor did.
    const stored = (await port.data.history.readAll()) as SessionTurn[];
    port.setCursor(genuineV1Cursor(replay.turnHashes, stored));
    const legacyMeta = {
      importedTurnCount: replay.turnHashes.length,
      replayDigest: replay.replayDigest,
    };
    return { doc, port, replay, legacyMeta };
  }

  it('appends a v2 replay onto a genuine unversioned v1 cursor and baseline', async () => {
    const { doc, port, legacyMeta } = await seedLegacyDoc(1);
    const before = doc.getList('history').toJSON();
    const replay = replayOf(rounds(2), HASH_VERSION_V2);
    const result = await port.data.commands.applyHistoryImport({
      mode: 'refresh',
      replay,
      externalHistory: legacyMeta,
    });
    expect(result).toMatchObject({ status: 'accepted', appended: 2 });
    const after = doc.getList('history').toJSON() as unknown[];
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(4);
    // The accepted refresh upgraded the persisted cursor; the parser kept the version.
    const cursor = port.getCursor();
    expect(cursor?.hashVersion).toBe(HASH_VERSION_V2);
    expect(cursor?.importedTurnHashes).toEqual(replay.turnHashes);
    const baseline = JSON.parse(cursor!.storedHistoryBaseline!);
    expect(baseline.hashVersion).toBe(HASH_VERSION_V2);
    expect(baseline.turnHashes).toHaveLength(4);
  });

  it('skips an unchanged v2 replay without rewriting history (already synced)', async () => {
    const { doc, port, legacyMeta } = await seedLegacyDoc(1);
    const replay = replayOf(rounds(1), HASH_VERSION_V2);
    await port.data.commands.applyHistoryImport({
      mode: 'refresh',
      replay,
      externalHistory: legacyMeta,
    });
    const before = doc.getList('history').toJSON();
    const meta = {
      importedTurnCount: 2,
      replayDigest: replay.replayDigest,
      hashVersion: HASH_VERSION_V2,
    };
    const result = await port.data.commands.applyHistoryImport({
      mode: 'refresh',
      replay,
      externalHistory: meta,
    });
    expect(result).toMatchObject({ status: 'accepted', appended: 0 });
    expect(doc.getList('history').toJSON()).toEqual(before);
  });

  it('refreshes v1/v1 without recomputation and keeps the cursor at v1', async () => {
    const { port, legacyMeta } = await seedLegacyDoc(1);
    const next = replayOf(rounds(2), HASH_VERSION_V1);
    const result = await port.data.commands.applyHistoryImport({
      mode: 'refresh',
      replay: next,
      externalHistory: legacyMeta,
    });
    expect(result).toMatchObject({ status: 'accepted', appended: 2 });
    expect(port.getCursor()?.hashVersion).toBe(HASH_VERSION_V1);
    expect(port.getCursor()?.importedTurnHashes).toEqual(next.turnHashes);
  });

  it('keeps a local untracked suffix a conflict against a v1 cursor', async () => {
    const { doc, port, legacyMeta } = await seedLegacyDoc(1);
    createHistoryWriter(doc).append({ ...userTurn(9), id: 'local-only' });
    const before = doc.getList('history').toJSON();
    const result = await port.data.commands.applyHistoryImport({
      mode: 'refresh',
      replay: replayOf(rounds(2), HASH_VERSION_V2),
      externalHistory: legacyMeta,
    });
    expect(result).toMatchObject({
      status: 'rejected',
      reason: { code: 'local_history_has_untracked_suffix' },
    });
    expect(doc.getList('history').toJSON()).toEqual(before);
  });

  it('resolves a conflict when only the metadata advanced to v2', async () => {
    const { doc, port } = await seedLegacyDoc(1);
    createHistoryWriter(doc).append({ ...userTurn(9), id: 'local-only' });
    const replay = replayOf(rounds(2), HASH_VERSION_V2);
    // A conflict marker advanced only the metadata; the doc cursor is still v1.
    const markedMeta = {
      status: 'sync_conflict',
      importedTurnCount: 2,
      replayDigest: replay.replayDigest,
      hashVersion: HASH_VERSION_V2,
    };
    const result = await port.data.commands.applyHistoryImport({
      mode: 'resolve-conflict',
      replay,
      externalHistory: markedMeta,
    });
    expect(result).toMatchObject({ status: 'accepted', appended: 4 });
    const ids = (doc.getList('history').toJSON() as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toEqual(rounds(2).map((t) => t.id));
    expect(port.getCursor()?.hashVersion).toBe(HASH_VERSION_V2);
  });

  it('reports an already-resolved session instead of replacing it again', async () => {
    const { port } = await seedLegacyDoc(1);
    const replay = replayOf(rounds(1), HASH_VERSION_V2);
    // Metadata digest advanced to v2 while history already matches the replay exactly.
    const result = await port.data.commands.applyHistoryImport({
      mode: 'resolve-conflict',
      replay,
      externalHistory: {
        status: 'synced',
        importedTurnCount: 2,
        replayDigest: replay.replayDigest,
        hashVersion: HASH_VERSION_V2,
      },
    });
    expect(result).toMatchObject({ status: 'rejected', reason: { code: 'already_resolved' } });
  });

  it('refuses an unknown stored hash version before any write', async () => {
    const { doc, port, replay, legacyMeta } = await seedLegacyDoc(1);
    port.setCursor({ ...genuineV1Cursor(replay.turnHashes, rounds(1)), hashVersion: 3 });
    const before = doc.getList('history').toJSON();
    const result = await port.data.commands.applyHistoryImport({
      mode: 'refresh',
      replay: replayOf(rounds(2), HASH_VERSION_V2),
      externalHistory: legacyMeta,
    });
    expect(result).toMatchObject({ status: 'rejected' });
    expect(doc.getList('history').toJSON()).toEqual(before);
    // The unreadable cursor is left exactly as found, never "upgraded" by implication.
    expect(port.getCursor()?.hashVersion).toBe(3);
  });
});
