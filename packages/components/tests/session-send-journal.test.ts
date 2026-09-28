import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { createHistoryWriter, type SessionHistory, type SessionId } from '@lody/shared';
import {
  createSessionSendResources,
  type SessionSendResources,
} from '../src/lib/session-send-resources';
import {
  createSessionSendJournal,
  type SessionSendJournalPorts,
  type SessionSendJournalStorage,
  type SessionSendRecord,
} from '../src/lib/session-send-journal';

const owners: SessionSendResources[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.dispose()));
});
const record = (id: string, sessionId = 'session') => ({
  id,
  sessionId: sessionId as SessionId,
  accountId: 'account',
  workspaceId: 'workspace',
  sourceReplica: 'original',
  entry: {
    id,
    role: 'user',
    timestamp: '2026-01-01T00:00:00Z',
    items: [{ type: 'text', text: id }],
    fileDiff: [],
  } as SessionHistory,
  delivery: { kind: 'dispatch' as const },
});
function memoryStorage() {
  const records = new Map<string, SessionSendRecord>();
  const storage: SessionSendJournalStorage = {
    list: async () => structuredClone([...records.values()]),
    insert: async (input) => {
      const value = { ...input, sequence: records.size + 1 };
      records.set(value.id, structuredClone(value));
      return value;
    },
    put: async (value) => {
      records.set(value.id, structuredClone(value));
    },
    requestCancel: async (id) => {
      const current = records.get(id);
      if (!current) return undefined;
      if (current.stage !== 'saved') throw new Error('Submission may already be accepted');
      const next = { ...current, cancelRequested: true };
      records.set(id, next);
      return next;
    },
    remove: async (id) => {
      records.delete(id);
    },
    close: async () => {},
  };
  return storage;
}
function fixture(overrides: Partial<SessionSendJournalPorts> = {}) {
  const doc = new LoroDoc();
  const writer = createHistoryWriter(doc);
  const resources = createSessionSendResources({
    acquire: async () => {
      throw new Error('Unexpected borrow');
    },
    releaseRef: () => {},
  });
  owners.push(resources);
  const storage = memoryStorage();
  const ports: SessionSendJournalPorts = {
    resources,
    storage,
    lock: async (_key, _signal, execute) => execute(),
    prepare: async () => {},
    commit: async (value, _signal, { resumed }) => {
      if (resumed && writer.read(value.id)) return;
      writer.append(value.entry);
    },
    deliver: async () => {},
    ...overrides,
  };
  return { doc, writer, ports, journal: createSessionSendJournal(ports) };
}

describe('persistent submission stages', () => {
  it('resumes an applied write that lost its acknowledgment without appending again', async () => {
    const f = fixture();
    let loseAck = true;
    const resumedCommits: boolean[] = [];
    const commit = f.ports.commit;
    f.ports.commit = async (value, signal, options) => {
      resumedCommits.push(options.resumed);
      await commit(value, signal, options);
      if (loseAck) {
        loseAck = false;
        throw new Error('Lost local receipt');
      }
    };
    await f.journal.accept(record('fixed'));
    await expect(f.journal.submit('session' as SessionId)).rejects.toThrow('Lost local receipt');
    // Older clients can only replay prepared bytes, so this format must be refused there.
    expect((await f.ports.storage.list())[0]).toMatchObject({ stage: 'prepared', version: 3 });
    expect(f.writer.readStored().map((turn) => turn.id)).toEqual(['fixed']);

    // Simulate a new service using the same persisted intent after restart.
    const recovered = createSessionSendJournal(f.ports);
    await recovered.retry('session' as SessionId);
    expect(resumedCommits).toEqual([false, true]);
    expect(f.writer.readStored().map((turn) => turn.id)).toEqual(['fixed']);
    expect((await f.ports.storage.list())[0]).toMatchObject({ stage: 'delivered', version: 2 });
  });

  it('writes the turn as a local commit that live transports observe', async () => {
    const f = fixture();
    const origins: (string | undefined)[] = [];
    const stop = f.doc.subscribe((event) => origins.push(event.by));
    await f.journal.accept(record('local'));
    await f.journal.submit('session' as SessionId);
    stop();
    expect(origins).toEqual(['local']);
    expect([...f.doc.oplogVersion().toJSON().keys()]).toEqual([f.doc.peerIdStr]);
  });

  it('publishes nothing when saving the prepared operation fails', async () => {
    const f = fixture();
    const put = f.ports.storage.put;
    f.ports.storage.put = async (value) => {
      if (value.stage === 'prepared') throw new Error('Disk full');
      await put(value);
    };
    await f.journal.accept(record('fixed'));
    await expect(f.journal.submit('session' as SessionId)).rejects.toThrow('Disk full');
    expect(f.writer.readStored()).toEqual([]);
    expect((await f.ports.storage.list())[0]?.stage).toBe('saved');
  });

  it('blocks later same-session writes behind a failed head but allows another session', async () => {
    const f = fixture();
    const prepare = f.ports.prepare;
    f.ports.prepare = async (value, signal) => {
      if (value.id === 'first') throw new Error('Preparation failed');
      return prepare(value, signal);
    };
    await f.journal.accept(record('first'));
    await f.journal.accept(record('second'));
    await f.journal.accept(record('independent', 'other'));
    await expect(f.journal.submit('session' as SessionId)).rejects.toThrow('Preparation failed');
    await f.journal.submit('other' as SessionId);
    expect(f.writer.readStored().map((turn) => turn.id)).toEqual(['independent']);
    const saved = await f.ports.storage.list();
    expect(saved.find((value) => value.id === 'second')?.stage).toBe('saved');
  });

  it('retains committed content when target delivery is uncertain', async () => {
    const f = fixture({
      deliver: async () => {
        throw new Error('Target disconnected');
      },
    });
    await f.journal.accept(record('fixed'));
    await expect(f.journal.retry('session' as SessionId)).rejects.toThrow('Target disconnected');
    expect((await f.ports.storage.list())[0]).toMatchObject({
      stage: 'committed',
      error: 'Target disconnected',
    });
    await expect(f.journal.cancel('fixed')).rejects.toThrow(/already be accepted/);
    expect(f.writer.readStored().map((turn) => turn.id)).toEqual(['fixed']);
  });

  it('promotes a delivered queue record into a history turn before guide delivery', async () => {
    const f = fixture();
    await f.journal.accept({
      ...record('queued-turn'),
      delivery: { kind: 'queue' },
      queue: { $cid: 'queue-row' },
    });
    const queued = (await f.ports.storage.list())[0]!;
    await f.ports.storage.put({ ...queued, stage: 'delivered' });
    const promoted = await f.journal.promoteQueuedTurn(
      'queued-turn',
      {
        ...record('queued-turn').entry,
        status: 'pending_apply',
      },
      { kind: 'guide', expectedTurnId: 'assistant-turn' }
    );
    expect(promoted).toMatchObject({
      stage: 'saved',
      queue: undefined,
      delivery: { kind: 'guide', expectedTurnId: 'assistant-turn' },
    });

    await f.journal.retry('session' as SessionId);
    expect(f.writer.readStored().map((turn) => turn.id)).toEqual(['queued-turn']);
    expect((await f.ports.storage.list())[0]).toMatchObject({
      stage: 'delivered',
      delivery: { kind: 'guide', expectedTurnId: 'assistant-turn' },
    });
  });

  it('lets an explicit discard remove an undeliverable committed recovery record', async () => {
    const f = fixture({
      deliver: async () => {
        throw new Error('Target unavailable');
      },
    });
    await f.journal.accept(record('stuck'));
    await expect(f.journal.retry('session' as SessionId)).rejects.toThrow('Target unavailable');
    await f.journal.discard('stuck');
    expect(await f.ports.storage.list()).toEqual([]);
  });

  it('lets an explicit discard remove a prepared record whose commit cannot recover', async () => {
    const f = fixture({
      commit: async () => {
        throw new Error('Original submission replica is unavailable');
      },
    });
    await f.journal.accept(record('prepared-stuck'));
    await expect(f.journal.submit('session' as SessionId)).rejects.toThrow(
      'Original submission replica is unavailable'
    );
    expect((await f.ports.storage.list())[0]?.stage).toBe('prepared');
    await f.journal.discard('prepared-stuck');
    expect(await f.ports.storage.list()).toEqual([]);
  });
});

describe('IndexedDB recovery receipts', () => {
  it('restores exact prepared bytes after closing and reopening storage', async () => {
    const { IDBFactory } = await import('fake-indexeddb');
    const { createSessionSendJournalStorage } =
      await import('../src/lib/session-send-journal-storage');
    const indexedDB = new IDBFactory();
    const args = { accountId: 'account', workspaceId: 'workspace', indexedDB };
    const first = createSessionSendJournalStorage(args);
    const saved = await first.insert({ ...record('fixed'), version: 1, stage: 'saved' });
    await first.put({ ...saved, stage: 'prepared', update: new Uint8Array([1, 2, 3]) });
    await first.close();
    const recovered = createSessionSendJournalStorage(args);
    expect(await recovered.list()).toEqual([
      { ...saved, stage: 'prepared', update: new Uint8Array([1, 2, 3]) },
    ]);
    await recovered.close();
  });

  it('serializes concurrent window admissions and separates account storage', async () => {
    const { IDBFactory } = await import('fake-indexeddb');
    const { createSessionSendJournalStorage } =
      await import('../src/lib/session-send-journal-storage');
    const indexedDB = new IDBFactory();
    const args = { accountId: 'account', workspaceId: 'workspace', indexedDB };
    const first = createSessionSendJournalStorage(args);
    const peer = createSessionSendJournalStorage(args);
    const other = createSessionSendJournalStorage({ ...args, accountId: 'other-account' });
    const admitted = await Promise.all([
      first.insert({ ...record('first'), version: 1, stage: 'saved' }),
      peer.insert({ ...record('second'), version: 1, stage: 'saved' }),
    ]);
    expect(new Set(admitted.map((value) => value.sequence)).size).toBe(2);
    expect((await first.list()).map((value) => value.id).sort()).toEqual(['first', 'second']);
    expect(await other.list()).toEqual([]);
    await Promise.all([first.close(), peer.close(), other.close()]);
  });
});

it('holds the session delivery lock until raw delivery settles', async () => {
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const secondWaiting = Promise.withResolvers<void>();
  const locks = new Map<string, Promise<void>>();
  const delivered: string[] = [];
  const f = fixture({
    lock: async (key, _signal, execute) => {
      const previous = locks.get(key) ?? Promise.resolve();
      const release = Promise.withResolvers<void>();
      locks.set(
        key,
        previous.then(() => release.promise)
      );
      if (key === 'delivery:session' && locks.size && delivered.includes('first'))
        secondWaiting.resolve();
      await previous;
      try {
        return await execute();
      } finally {
        release.resolve();
      }
    },
    deliver: async (value) => {
      delivered.push(value.id);
      if (value.id === 'first') {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    },
  });
  await f.journal.accept(record('first'));
  await f.journal.accept(record('second'));
  await f.journal.submit('session' as SessionId);
  const values = await f.ports.storage.list();
  const first = f.journal.deliver(values[0]!);
  await firstStarted.promise;
  const second = f.journal.deliver(values[1]!);
  await secondWaiting.promise;
  expect(delivered).toEqual(['first']);
  releaseFirst.resolve();
  await Promise.all([first, second]);
  expect(delivered).toEqual(['first', 'second']);
});

it('records the replica that actually prepared operations when another window takes over', async () => {
  const f = fixture({ preparationReplica: 'executor-replica' });
  await f.journal.accept(record('cross-window'));
  await f.journal.submit('session' as SessionId);
  expect((await f.ports.storage.list())[0]?.sourceReplica).toBe('executor-replica');
  expect(f.writer.readStored().map((turn) => turn.id)).toEqual(['cross-window']);
});

it.each(['seen', undefined] as const)(
  'durably wakes an idle imported conversation past legacy status %s',
  async (status) => {
    const { IDBFactory } = await import('fake-indexeddb');
    const { createWorkspaceSessionSendJournal } =
      await import('../src/providers/workspace-session-send-journal');
    const { createConversationSession } = await import('../src/lib/conversation-view');
    const { shouldWatchSession, findNextDispatchableUserTurn } =
      await import('../../../apps/cli/src/session/session-dispatch-logic');
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_key: string, _options: unknown, run: () => Promise<unknown>) => run(),
      },
    });
    const doc = new LoroDoc();
    const session = createConversationSession(doc, { sessionId: 'session' as SessionId });
    session.historyWriter.append({
      ...record('builtin:codex:imported:turn:0:old').entry,
      status,
      read: true,
    });
    session.historyWriter.append({ ...record('answer').entry, role: 'assistant', finished: true });
    const meta = {
      id: 'session',
      machineId: 'machine',
      userId: 'account',
      status: { type: 'idle' },
      externalHistory: {
        provider: { cliType: 'builtin', agentType: 'codex' },
        source: 'local-acp-history',
        sourceAcpSessionId: 'imported',
      },
    } as import('@lody/shared').SessionMeta;
    const store = {
      doc,
      sessionData: session.sessionData,
      history: session.history,
      getState: () => session.mirror.getState(),
    };
    const resources = createSessionSendResources({
      acquire: async () => store as never,
      releaseRef: () => {},
    });
    let synchronizedMeta: typeof meta | undefined;
    const journal = createWorkspaceSessionSendJournal({
      accountId: 'account',
      sourceReplica: 'original',
      token: () => null,
      localMachineId: () => null,
      runtime: {
        workspaceId: 'workspace',
        sendResources: resources,
        repo: { getDocMeta: async () => ({ meta }), flush: async () => {} },
        writer: {
          upsertDocMeta: async (_room: string, patch: object) => Object.assign(meta, patch),
        },
        requestSessionDispatchTurn: async () => {
          throw new Error('Must use durable activation behind legacy history');
        },
      } as never,
      waitForTargetSync: async () => {
        synchronizedMeta = structuredClone(meta);
      },
    });
    try {
      await journal.accept({
        ...record('next'),
        entry: {
          ...record('next').entry,
          userId: 'account',
          status: 'pending',
          inputConfig: {
            cliType: 'builtin',
            agentType: 'codex',
            inputBlocks: [{ type: 'text', text: 'follow up' }],
          },
        },
      });
      await journal.retry('session' as SessionId);
      expect((await journal.read('next'))?.stage).toBe('delivered');
      expect(synchronizedMeta?.latestUserMsgId).toBe('next');
      expect(
        shouldWatchSession({
          meta: synchronizedMeta!,
          hasUnprocessedCancelRequest: false,
          hasRpcTurnOffer: false,
          hasAccessRetry: false,
        })
      ).toBe(true);
      expect(
        findNextDispatchableUserTurn(session.historyWriter.readStored(), synchronizedMeta!)?.id
      ).toBe('next');
    } finally {
      await resources.dispose();
      await journal.close();
      session.dispose();
      doc.free();
      vi.unstubAllGlobals();
    }
  }
);

describe('workspace commit writes local operations', () => {
  async function workspaceFixture(
    initialMeta: Partial<import('@lody/shared').SessionMeta> = {
      id: 'session',
      machineId: 'machine',
      userId: 'account',
    }
  ) {
    const { IDBFactory } = await import('fake-indexeddb');
    const { createWorkspaceSessionSendJournal } =
      await import('../src/providers/workspace-session-send-journal');
    const { createSessionSendJournalStorage } =
      await import('../src/lib/session-send-journal-storage');
    const { createConversationSession } = await import('../src/lib/conversation-view');
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_key: string, _options: unknown, run: () => Promise<unknown>) => run(),
      },
    });
    const doc = new LoroDoc();
    const session = createConversationSession(doc, { sessionId: 'session' as SessionId });
    const meta = { ...initialMeta } as import('@lody/shared').SessionMeta;
    const store = {
      doc,
      sessionData: session.sessionData,
      history: session.history,
      getState: () => session.mirror.getState(),
      setState: (updater: never) => session.mirror.setState(updater),
    };
    const syncedMachineIds: (string | undefined)[] = [];
    const resources = createSessionSendResources({
      acquire: async () => store as never,
      releaseRef: () => {},
    });
    const events: string[] = [];
    const stop = doc.subscribe((event) => events.push(`doc:${event.by}`));
    const journal = createWorkspaceSessionSendJournal({
      accountId: 'account',
      sourceReplica: 'original',
      token: () => null,
      localMachineId: () => null,
      runtime: {
        workspaceId: 'workspace',
        sendResources: resources,
        repo: { getDocMeta: async () => ({ meta }), flush: async () => {} },
        writer: { upsertDocMeta: async (_room: string, patch: object) => Object.assign(meta, patch) },
        requestSessionDispatchTurn: async () => ({ accepted: true }),
      } as never,
      waitForTargetSync: async () => {
        events.push('sync');
        syncedMachineIds.push(meta.machineId);
      },
    });
    const storage = createSessionSendJournalStorage({
      accountId: 'account',
      workspaceId: 'workspace',
    });
    const entry = (id: string) => ({
      ...record(id).entry,
      userId: 'account',
      status: 'pending' as const,
      inputConfig: {
        cliType: 'builtin',
        agentType: 'codex',
        inputBlocks: [{ type: 'text', text: id }],
      },
    });
    const insertPrepared = (id: string, extra: Partial<SessionSendRecord> = {}) =>
      storage.insert({
        ...record(id),
        entry: entry(id),
        version: 3,
        stage: 'prepared',
        update: new Uint8Array(),
        ...extra,
      });
    return {
      doc,
      session,
      journal,
      storage,
      events,
      syncedMachineIds,
      entry,
      insertPrepared,
      async dispose() {
        stop();
        await resources.dispose();
        await journal.close();
        await storage.close();
        session.dispose();
        doc.free();
        vi.unstubAllGlobals();
      },
    };
  }

  it('enqueues a queued message with a local commit on the live replica', async () => {
    const f = await workspaceFixture();
    try {
      await f.journal.accept({
        ...record('queued'),
        entry: f.entry('queued'),
        delivery: { kind: 'queue' },
        queue: {
          userTurnId: 'queued',
          task: 'queued text',
          userId: 'account',
          timestamp: '2026-01-01T00:00:00Z',
          isEditing: false,
        },
      });
      await f.journal.retry('session' as SessionId);
      expect((await f.journal.read('queued'))?.stage).toBe('delivered');
      expect(f.session.mirror.getState().mq?.map((item) => item.userTurnId)).toEqual(['queued']);
      expect(f.events.filter((event) => event.startsWith('doc:'))).not.toContain('doc:import');
      expect([...f.doc.oplogVersion().toJSON().keys()]).toEqual([f.doc.peerIdStr]);
    } finally {
      await f.dispose();
    }
  });

  it('catches up before resuming and keeps a turn written by the interrupted attempt', async () => {
    const f = await workspaceFixture();
    try {
      f.session.historyWriter.append(f.entry('resumed'));
      const saved = await f.insertPrepared('resumed');
      f.events.length = 0;
      await f.journal.retry(saved.sessionId);
      expect((await f.journal.read('resumed'))?.stage).toBe('delivered');
      expect(f.events[0]).toBe('sync');
      expect(f.session.historyWriter.readStored().map((turn) => turn.id)).toEqual(['resumed']);
    } finally {
      await f.dispose();
    }
  });

  it('resumes a first message whose crashed window never persisted the session', async () => {
    const f = await workspaceFixture({});
    try {
      await f.insertPrepared('first', {
        sourceReplica: 'crashed-window',
        creation: { id: 'session', machineId: 'machine', userId: 'account' } as never,
      });
      await f.journal.retry('session' as SessionId);
      expect((await f.journal.read('first'))?.stage).toBe('delivered');
      // Target routing needs creation ownership before catch-up.
      expect(f.syncedMachineIds[0]).toBe('machine');
      expect(f.session.historyWriter.readStored().map((turn) => turn.id)).toEqual(['first']);
    } finally {
      await f.dispose();
    }
  });

  it('recovers a turn persisted only by the crashed window without appending it again', async () => {
    const f = await workspaceFixture();
    try {
      const { IndexedDBStorageAdaptor } = await import('loro-repo/storage/indexeddb');
      const { getSessionRoomId } = await import('@lody/shared');
      const crashed = new LoroDoc();
      crashed.import(f.doc.export({ mode: 'snapshot' }));
      createHistoryWriter(crashed).append(f.entry('first'));
      const original = new IndexedDBStorageAdaptor({ dbName: 'crashed-window' });
      await original.save({
        type: 'doc-snapshot',
        docId: getSessionRoomId('session' as SessionId),
        snapshot: crashed.export({ mode: 'snapshot' }),
      });
      await original.close();
      crashed.free();
      await f.insertPrepared('first', { sourceReplica: 'crashed-window' });
      await f.journal.retry('session' as SessionId);
      expect((await f.journal.read('first'))?.stage).toBe('delivered');
      expect(f.session.historyWriter.readStored().map((turn) => turn.id)).toEqual(['first']);
    } finally {
      await f.dispose();
    }
  });

  it('resumes an older client record from its entry instead of its prepared bytes', async () => {
    const f = await workspaceFixture();
    try {
      await f.insertPrepared('legacy', {
        sourceReplica: 'crashed-window',
        version: 2,
        update: new Uint8Array([1, 2, 3]),
      });
      await f.journal.retry('session' as SessionId);
      expect((await f.journal.read('legacy'))?.stage).toBe('delivered');
      expect(f.session.historyWriter.readStored().map((turn) => turn.id)).toEqual(['legacy']);
      expect(f.events).not.toContain('doc:import');
    } finally {
      await f.dispose();
    }
  });
});

describe('interrupted work observation', () => {
  it('does not start recovered messages and distinguishes another window owner', async () => {
    const external = new Set<string>();
    const f = fixture({ activeSessions: async () => external });
    await f.ports.storage.insert({ ...record('restored'), version: 1, stage: 'saved' });
    await f.journal.refresh();
    expect(f.journal.getSnapshot()[0]).toMatchObject({ activity: 'interrupted', stage: 'saved' });
    expect(f.writer.readStored()).toEqual([]);
    external.add('session');
    await f.journal.refresh();
    expect(f.journal.getSnapshot()[0]?.activity).toBe('active');
    external.clear();
    await f.journal.refresh();
    expect(f.journal.getSnapshot()[0]?.activity).toBe('interrupted');
    expect((await f.ports.storage.list())[0]).not.toHaveProperty('activity');
  });

  it('publishes live work until its completion, then offers recovery on failure', async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const f = fixture({
      prepare: async () => {
        entered.resolve();
        await finish.promise;
        throw new Error('offline');
      },
    });
    await f.journal.accept(record('retry'));
    const retry = f.journal.retry('session' as SessionId);
    const rejected = expect(retry).rejects.toThrow('offline');
    await entered.promise;
    expect(f.journal.getSnapshot()[0]?.activity).toBe('active');
    finish.resolve();
    await rejected;
    expect(f.journal.getSnapshot()[0]).toMatchObject({ activity: 'interrupted', error: 'offline' });
  });
});

it('persists an entire legal attachment message without charging source bytes to CRDT metadata', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { createSessionSendJournalStorage } =
    await import('../src/lib/session-send-journal-storage');
  const {
    SESSION_FILE_MAX_COUNT,
    SESSION_FILE_MAX_SIZE_BYTES,
    SESSION_IMAGE_MAX_COUNT,
    SESSION_IMAGE_MAX_SIZE_BYTES,
  } = await import('@lody/shared');
  const indexedDB = new IDBFactory();
  const args = { accountId: 'account', workspaceId: 'workspace', indexedDB };
  const storage = createSessionSendJournalStorage(args);
  // Blob parts share immutable backing bytes; model the real full 840 MiB allowance
  // without allocating a separate 100 MiB array for every file.
  const file = new Blob([new Uint8Array(SESSION_FILE_MAX_SIZE_BYTES)]);
  const attachments = [
    ...Array.from({ length: SESSION_FILE_MAX_COUNT }, (_, i) => ({
      id: `file-${i}`,
      kind: 'file' as const,
      source: file,
      name: `file-${i}`,
      mimeType: 'application/octet-stream',
      lastModified: 1,
    })),
    ...Array.from({ length: SESSION_IMAGE_MAX_COUNT }, (_, i) => ({
      id: `image-${i}`,
      kind: 'image' as const,
      source: file.slice(0, SESSION_IMAGE_MAX_SIZE_BYTES),
      name: `image-${i}`,
      mimeType: 'image/png',
      lastModified: 1,
    })),
  ];
  const saved = await storage.insert({
    ...record('large'),
    version: 2,
    stage: 'saved',
    attachments,
  });
  const update = new Uint8Array([1, 2, 3]);
  await storage.put({ ...saved, stage: 'prepared', update });
  await storage.close();
  const reopened = createSessionSendJournalStorage(args);
  const recovered = (await reopened.list())[0]!;
  expect(recovered.update).toEqual(update);
  expect(recovered.attachments?.map((attachment) => attachment.source?.size)).toEqual([
    ...Array<number>(SESSION_FILE_MAX_COUNT).fill(SESSION_FILE_MAX_SIZE_BYTES),
    ...Array<number>(SESSION_IMAGE_MAX_COUNT).fill(SESSION_IMAGE_MAX_SIZE_BYTES),
  ]);
  await reopened.close();
});
