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
import { dispatchUserTurn, writeUserTurn } from '../src/lib/session-send-delivery';
import { createEncryptedDispatchLegacy } from '../src/providers/encrypted-dispatch-legacy';
import { SessionInputNotSentError } from '../src/lib/session-accepted-inputs';

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
  const sessionDocs = new Map<SessionId, LoroDoc>();
  const open = (sessionId: SessionId) => {
    let session = sessions.get(sessionId);
    if (!session) {
      const doc = new LoroDoc();
      docs.push(doc);
      sessionDocs.set(sessionId, doc);
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
        setState: session.mirror.setState.bind(session.mirror),
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
    runtime,
    sessionDocs,
    snapshot: () => sessionDocs.get(SESSION)!.export({ mode: 'snapshot' }),
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

it.each(['rpc-lost', 'oversized'] as const)(
  'persists human authorization independently of the %s dispatch fast path',
  async (mode) => {
    const f = fixture();
    const input = entry('new-human');
    if (mode === 'oversized') {
      input.inputConfig!.prompt = 'x'.repeat(300 * 1024);
      input.inputConfig!.inputBlocks = [{ type: 'text', text: input.inputConfig!.prompt }];
      input.items = [{ type: 'text', text: input.inputConfig!.prompt }];
    }
    f.runtime.requestSessionDispatchTurn = async () => {
      throw new Error('RPC disconnected');
    };
    await writeUserTurn(f.runtime, {
      sessionId: SESSION,
      entry: input,
      delivery: { kind: 'dispatch' },
    });
    await dispatchUserTurn(f.runtime, SESSION, input.id);
    const reopened = new LoroDoc();
    try {
      reopened.import(f.snapshot());
      const control = createConversationSession(reopened, { sessionId: SESSION });
      try {
        expect(control.mirror.getState().humanInputReceipts?.[input.id]).toMatchObject({
          userId: 'account',
        });
        expect(
          control.historyWriter!.readStored().find((turn) => turn.id === input.id)?.items
        ).toEqual(input.items);
        expect(f.metas.get(getSessionRoomId(SESSION))?.latestUserMsgId).toBe(input.id);
        await f.append(entry('agent-task'));
        expect(control.mirror.getState().humanInputReceipts?.['agent-task']).toBeUndefined();
      } finally {
        control.dispose();
      }
    } finally {
      reopened.free();
    }
  }
);

it.each(['accepted', 'transport-failed', 'prepare-failed'] as const)(
  'retains encrypted RPC originals and durable activation when acceleration is %s',
  async (mode) => {
    const f = fixture();
    const input = entry('encrypted-human');
    f.runtime.contentMode = 'e2ee';
    f.runtime.requestSessionDispatchTurn = async () => {
      throw new Error('plaintext RPC must not run');
    };
    const original = {
      requestId: '01'.repeat(16),
      targetMachineId: MACHINE,
      frameHex: '02'.repeat(300),
      requesterDevice: '03'.repeat(32),
      expiresAt: 1234,
    };
    let sawDurableOriginal = false;
    f.runtime.prepareEncryptedDispatch = async () => {
      if (mode === 'prepare-failed') throw new Error('synthetic host failure');
      return {
        original,
        send: async () => {
          sawDurableOriginal =
            f.sessionDocs.get(SESSION)?.getMap('rpcDispatchOriginals').get(input.id) ===
            original.frameHex;
          if (mode === 'transport-failed') throw new Error('synthetic transport failure');
          return {
            type: 'session/dispatch-turn_response',
            sessionId: SESSION,
            userTurnId: input.id,
            accepted: true,
            disposition: 'accepted',
          };
        },
      };
    };
    await writeUserTurn(f.runtime, {
      sessionId: SESSION,
      entry: input,
      delivery: { kind: 'history' },
    });
    await dispatchUserTurn(f.runtime, SESSION, input.id);
    expect(f.metas.get(getSessionRoomId(SESSION))?.latestUserMsgId).toBe(input.id);
    expect(f.sessionDocs.get(SESSION)?.getMap('rpcDispatchOriginals').get(input.id)).toBe(
      mode === 'prepare-failed' ? undefined : original.frameHex
    );
    expect(sawDurableOriginal).toBe(mode !== 'prepare-failed');
    const restored = new LoroDoc();
    try {
      const source = f.sessionDocs.get(SESSION);
      if (!source) throw new Error('missing fixture doc');
      restored.import(source.export({ mode: 'snapshot' }));
      expect(restored.getMap('rpcDispatchOriginals').get(input.id)).toBe(
        mode === 'prepare-failed' ? undefined : original.frameHex
      );
    } finally {
      restored.free();
    }
  }
);

it.each(['history', 'dispatch'] as const)(
  'never writes executable %s input after the host reports a known machine withdrawal',
  async (kind) => {
    const f = fixture();
    const input = entry('withdrawn-human');
    f.runtime.contentMode = 'e2ee';
    const prepared: string[] = [];
    // The real renderer boundary over a host that already verified the withdrawn policy.
    const rpc = createEncryptedDispatchLegacy({
      workspaceId: 'workspace',
      prepare: async (machineId) => {
        prepared.push(machineId);
        throw new Error(
          "Error invoking remote method 'e2ee:prepareDispatch': Error: e2ee_machine_not_shared"
        );
      },
      accept: async () => {
        throw new Error('no dispatch may be accepted');
      },
      client: async () => {
        throw new Error('no transport may open');
      },
    });
    cleanup.push(() => rpc.close());
    f.runtime.prepareEncryptedDispatch = (machineId, args) => rpc.prepare(machineId, args);
    await expect(
      writeUserTurn(f.runtime, { sessionId: SESSION, entry: input, delivery: { kind } })
    ).rejects.toBeInstanceOf(SessionInputNotSentError);
    expect(prepared).toEqual([MACHINE]);
    // Nothing a machine could discover through history or activation exists.
    expect(f.turns().some((turn) => turn.id === input.id)).toBe(false);
    expect(f.metas.get(getSessionRoomId(SESSION))?.latestUserMsgId).toBeUndefined();
    expect(f.sessionDocs.get(SESSION)?.getMap('humanInputReceipts').get(input.id)).toBeUndefined();
  }
);

/** The real renderer boundary over a scripted host: each prepare takes the next reply. */
function encryptedHost(f: ReturnType<typeof fixture>) {
  f.runtime.contentMode = 'e2ee';
  const replies: Array<() => Promise<never>> = [];
  const pending: Array<(error: Error) => void> = [];
  let entered: () => void = () => {};
  const rpc = createEncryptedDispatchLegacy({
    workspaceId: 'workspace',
    prepare: () => (replies.shift() ?? (() => new Promise<never>(() => {})))(),
    accept: async () => {
      throw new Error('no dispatch may be accepted');
    },
    client: async () => {
      throw new Error('no transport may open');
    },
  });
  cleanup.push(() => rpc.close());
  f.runtime.prepareEncryptedDispatch = (machineId, args) => rpc.prepare(machineId, args);
  const ipc = (code: string) =>
    new Error(`Error invoking remote method 'e2ee:prepareDispatch': Error: ${code}`);
  return {
    reject: (code: string) => replies.push(() => Promise.reject(ipc(code))),
    // A slow host whose answer the test releases explicitly; resolves once it is asked.
    hold: () =>
      new Promise<void>((resolve) => {
        entered = resolve;
        replies.push(
          () =>
            new Promise<never>((_resolve, reject) => {
              pending.push(reject);
              entered();
            })
        );
      }),
    release: (code: string) => pending.shift()?.(ipc(code)),
  };
}
const send = (f: ReturnType<typeof fixture>, input: SessionHistory) =>
  writeUserTurn(f.runtime, { sessionId: SESSION, entry: input, delivery: { kind: 'dispatch' } });
const turnStatus = (f: ReturnType<typeof fixture>, id: string) =>
  f.turns().find((turn) => turn.id === id)?.status;

it('keeps a verified withdrawal after a later unverifiable prepare', async () => {
  const f = fixture();
  const host = encryptedHost(f);
  host.reject('e2ee_machine_not_shared');
  await expect(send(f, entry('first'))).rejects.toBeInstanceOf(SessionInputNotSentError);
  // The host's policy refresh then fails; that unknown cannot release the withdrawal.
  host.reject('e2ee_host_operation_failed');
  await expect(send(f, entry('retry'))).rejects.toBeInstanceOf(SessionInputNotSentError);
  expect(f.turns()).toEqual([]);
  expect(f.metas.get(getSessionRoomId(SESSION))?.latestUserMsgId).toBeUndefined();
});

it('keeps a verified withdrawal when a later prepare outlasts its deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const f = fixture();
    const host = encryptedHost(f);
    host.reject('e2ee_machine_not_shared');
    await expect(send(f, entry('first'))).rejects.toBeInstanceOf(SessionInputNotSentError);
    const asked = host.hold();
    const retry = send(f, entry('retry'));
    const refused = expect(retry).rejects.toBeInstanceOf(SessionInputNotSentError);
    await asked;
    await vi.advanceTimersByTimeAsync(200);
    await refused;
    expect(f.turns()).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it('settles timed-out input that a late verified withdrawal reaches before any machine claims it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const f = fixture();
    const host = encryptedHost(f);
    const asked = host.hold();
    const written = send(f, entry('late'));
    await asked;
    await vi.advanceTimersByTimeAsync(200);
    // No withdrawal was known: the unknown outcome keeps the durable write.
    await written;
    expect(turnStatus(f, 'late')).toBe('pending');
    vi.useRealTimers();
    host.release('e2ee_machine_not_shared');
    await vi.waitFor(() => expect(turnStatus(f, 'late')).toBe('canceled'));
    expect(f.turns().find((turn) => turn.id === 'late')?.items).toEqual(entry('late').items);
  } finally {
    vi.useRealTimers();
  }
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
