import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { LoroDoc } from 'loro-crdt';
import {
  getSessionRoomId,
  type MachineId,
  type SessionHistory,
  type SessionId,
} from '@lody/shared';
import { createConversationSession } from '../src/lib/conversation-view';
import { createSessionSendResources } from '../src/lib/session-send-resources';
import {
  LEGACY_SESSION_SEND_DATABASE,
  migrateLegacySessionSends,
} from '../src/lib/legacy-session-send-migration';
import type { SessionSendRuntime } from '../src/lib/session-send-delivery';

const SESSION = 'session' as SessionId;
const BROKEN = 'broken' as SessionId;
const MACHINE = 'machine' as MachineId;
const STORE = 'submissions';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Create the retired database exactly as the old journal storage did. */
async function seed(factory: IDBFactory, rows: Record<string, unknown>[]) {
  const open = factory.open(LEGACY_SESSION_SEND_DATABASE, 1);
  open.onupgradeneeded = () => {
    const store = open.result.createObjectStore(STORE, {
      keyPath: ['accountId', 'workspaceId', 'id'],
    });
    store.createIndex('scope', ['accountId', 'workspaceId']);
    store.createIndex('stage', 'stage');
  };
  const db = await request(open);
  const transaction = db.transaction(STORE, 'readwrite');
  for (const row of rows) transaction.objectStore(STORE).put(row);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function databaseNames(factory: IDBFactory) {
  return (await factory.databases()).map((database) => database.name);
}

async function remainingIds(factory: IDBFactory) {
  const db = await request(factory.open(LEGACY_SESSION_SEND_DATABASE));
  try {
    const rows = await request(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
    return (rows as Array<{ id: string }>).map((row) => row.id);
  } finally {
    db.close();
  }
}

/** A runtime whose session documents are real Loro docs and whose repo meta is a map. */
function fixture() {
  const sessions = new Map<SessionId, ReturnType<typeof createConversationSession>>();
  const docs: LoroDoc[] = [];
  const open = (sessionId: SessionId) => {
    let session = sessions.get(sessionId);
    if (!session) {
      const doc = new LoroDoc();
      docs.push(doc);
      session = createConversationSession(doc, { sessionId });
      sessions.set(sessionId, session);
    }
    return session;
  };
  const metas = new Map<string, Record<string, unknown>>([
    [getSessionRoomId(SESSION), { id: SESSION, machineId: MACHINE }],
    [getSessionRoomId(BROKEN), { id: BROKEN, machineId: MACHINE }],
  ]);
  const resources = createSessionSendResources({
    acquire: async (sessionId) => {
      const session = open(sessionId);
      return {
        sessionData: session.sessionData,
        getState: () => session.mirror.getState(),
        waitUntilSynced: async () => {},
      } as never;
    },
    releaseRef: () => {},
  });
  const runtime = {
    sendResources: resources,
    repo: {
      getDocMeta: async (roomId: string) =>
        metas.has(roomId) ? { meta: metas.get(roomId) } : undefined,
      flush: async () => {},
    },
    writer: {
      upsertDocMeta: async (roomId: string, patch: Record<string, unknown>) => {
        metas.set(roomId, { ...metas.get(roomId), ...patch });
      },
      appendSessionTurn: async (sessionId: SessionId, entry: SessionHistory) => {
        if (sessionId === BROKEN) throw new Error('Session document unavailable');
        await open(sessionId).sessionData.commands.appendTurn(entry);
      },
    },
    requestSessionDispatchTurn: async () => ({ accepted: true }),
  } as unknown as SessionSendRuntime;
  cleanup.push(async () => {
    await resources.dispose();
    for (const session of sessions.values()) session.dispose();
    for (const doc of docs) doc.free();
  });
  const factory = new IDBFactory();
  return {
    factory,
    metas,
    turns: (sessionId = SESSION) => open(sessionId).historyWriter.readStored(),
    append: (entry: SessionHistory) => open(SESSION).sessionData.commands.appendTurn(entry),
    migrate: (scope: { accountId?: string; workspaceId?: string } = {}) =>
      migrateLegacySessionSends({
        accountId: scope.accountId ?? 'account',
        workspaceId: scope.workspaceId ?? 'workspace',
        runtime,
        indexedDB: factory,
      }),
  };
}

let sequence = 0;
const entry = (id: string, status = 'pending') =>
  ({
    id,
    role: 'user',
    userId: 'account',
    timestamp: '2026-01-01T00:00:00Z',
    status,
    items: [{ type: 'text', text: `keep ${id}` }],
    fileDiff: [],
    inputConfig: {
      cliType: 'builtin',
      agentType: 'codex',
      inputBlocks: [{ type: 'text', text: `keep ${id}` }],
    },
  }) as unknown as SessionHistory;
const record = (id: string, overrides: Record<string, unknown> = {}) => ({
  version: 4,
  id,
  sessionId: SESSION,
  accountId: 'account',
  workspaceId: 'workspace',
  sourceReplica: 'replica',
  sequence: ++sequence,
  entry: entry(id),
  delivery: { kind: 'dispatch' },
  stage: 'saved',
  ...overrides,
});

it('does not create the database when it is absent', async () => {
  const f = fixture();
  await f.migrate();
  expect(await databaseNames(f.factory)).toEqual([]);
});

it('appends a saved dispatch record whose turn is absent, activates it and deletes the database', async () => {
  const f = fixture();
  await seed(f.factory, [record('saved')]);
  await f.migrate();
  expect(f.turns().map((turn) => [turn.id, JSON.stringify(turn.items)])).toEqual([
    ['saved', expect.stringContaining('keep saved')],
  ]);
  expect(f.metas.get(getSessionRoomId(SESSION))?.latestUserMsgId).toBe('saved');
  expect(await databaseNames(f.factory)).toEqual([]);
});

it('writes a turn with finished attachments using their final references', async () => {
  const f = fixture();
  await seed(f.factory, [
    record('with-image', {
      entry: { ...entry('with-image'), items: [] },
      attachments: [
        {
          id: 'image',
          kind: 'image',
          name: 'image.png',
          mimeType: 'image/png',
          lastModified: 1,
          ready: {
            type: 'image',
            imageId: 'image',
            mimeType: 'image/png',
            fileName: 'image.png',
            sizeBytes: 5,
          },
        },
      ],
    }),
  ]);
  await f.migrate();
  expect(f.turns()[0]?.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'image', imageId: 'image' }),
      expect.objectContaining({ type: 'text', text: 'keep with-image' }),
    ])
  );
});

it('never appends a turn that is already present or was committed by a version 2 journal', async () => {
  const f = fixture();
  await f.append(entry('present'));
  await seed(f.factory, [
    record('present'),
    record('committed', { version: 2, stage: 'committed' }),
  ]);
  await f.migrate();
  expect(f.turns().map((turn) => turn.id)).toEqual(['present']);
  expect(await databaseNames(f.factory)).toEqual([]);
});

it('leaves an offered guide alone and drops delivered and canceled rows', async () => {
  const f = fixture();
  await seed(f.factory, [
    record('offered', {
      entry: entry('offered', 'pending_apply'),
      delivery: { kind: 'guide', expectedTurnId: 'assistant' },
      guideOffer: 'offered',
    }),
    record('delivered', { stage: 'delivered' }),
    record('canceled', { cancelRequested: true }),
  ]);
  await f.migrate();
  expect(f.turns()).toEqual([]);
  expect(f.metas.get(getSessionRoomId(SESSION))?.latestUserMsgId).toBeUndefined();
  expect(await databaseNames(f.factory)).toEqual([]);
});

it('turns an unoffered guide into an ordinary pending follow-up', async () => {
  const f = fixture();
  await seed(f.factory, [
    record('guide', {
      entry: entry('guide', 'pending_apply'),
      delivery: { kind: 'guide', expectedTurnId: 'assistant' },
    }),
  ]);
  await f.migrate();
  expect(f.turns().map((turn) => [turn.id, turn.status])).toEqual([['guide', 'pending']]);
  expect(f.metas.get(getSessionRoomId(SESSION))?.latestUserMsgId).toBe('guide');
});

it('drops a record whose attachments never finished uploading', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const f = fixture();
  await seed(f.factory, [
    record('unready', {
      attachments: [
        { id: 'image', kind: 'image', name: 'image.png', mimeType: 'image/png', lastModified: 1 },
      ],
    }),
  ]);
  await f.migrate();
  expect(f.turns()).toEqual([]);
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('never finished uploading'),
    expect.objectContaining({ turnId: 'unready' })
  );
  expect(await databaseNames(f.factory)).toEqual([]);
});

it('keeps another account or workspace rows and the database that holds them', async () => {
  const f = fixture();
  await seed(f.factory, [
    record('mine'),
    record('other-account', { accountId: 'other' }),
    record('other-workspace', { workspaceId: 'other' }),
  ]);
  await f.migrate();
  expect(f.turns().map((turn) => turn.id)).toEqual(['mine']);
  expect(await databaseNames(f.factory)).toEqual([LEGACY_SESSION_SEND_DATABASE]);
  expect((await remainingIds(f.factory)).sort()).toEqual(['other-account', 'other-workspace']);
});

it('keeps a record whose write failed for the next start', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const f = fixture();
  await seed(f.factory, [record('failed', { sessionId: BROKEN }), record('written')]);
  await f.migrate();
  expect(f.turns().map((turn) => turn.id)).toEqual(['written']);
  expect(await remainingIds(f.factory)).toEqual(['failed']);
});
