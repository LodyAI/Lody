import { afterEach, describe, expect, it } from 'vitest';
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
    prepare: async (value) => writer.prepareAppend(value.entry),
    commit: async (value) => {
      writer.applyPrepared(value.update!);
    },
    deliver: async () => {},
    ...overrides,
  };
  return { doc, writer, ports, journal: createSessionSendJournal(ports) };
}

describe('persistent submission stages', () => {
  it('replays exactly the saved operations after an applied write loses its acknowledgment', async () => {
    const f = fixture();
    let loseAck = true;
    f.ports.commit = async (value) => {
      f.writer.applyPrepared(value.update!);
      if (loseAck) {
        loseAck = false;
        throw new Error('Lost local receipt');
      }
    };
    await f.journal.accept(record('fixed'));
    await expect(f.journal.submit('session' as SessionId)).rejects.toThrow('Lost local receipt');
    expect((await f.ports.storage.list())[0]?.stage).toBe('prepared');
    expect(f.writer.readStored().map((turn) => turn.id)).toEqual(['fixed']);

    // Simulate a new service using the same persisted intent after restart.
    const recovered = createSessionSendJournal(f.ports);
    await recovered.retry('session' as SessionId);
    expect(f.writer.readStored().map((turn) => turn.id)).toEqual(['fixed']);
    expect((await f.ports.storage.list())[0]?.stage).toBe('delivered');
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

it('exports imported prepared operations to the actual Streams adapter without reauthoring', async () => {
  const { createLoroDocAdapter } = await import('@loro-dev/streams-crdt/loro');
  const local = new LoroDoc();
  const remote = new LoroDoc();
  const writer = createHistoryWriter(local);
  const adapter = createLoroDocAdapter(local);
  const target = createLoroDocAdapter(remote);
  const stop = adapter.subscribeLocalUpdates((batch) => {
    void target.applyRemoteUpdates(batch.updates, target.emptyVersion());
  });
  try {
    writer.applyPrepared(writer.prepareAppend(record('prepared').entry));
    expect(createHistoryWriter(remote).readStored()).toEqual([]);
    const missing = adapter.exportUpdates(target.emptyVersion());
    expect(missing).toBeTruthy();
    if (!missing) throw new Error('Prepared operations missing from explicit synchronization');
    await target.applyRemoteUpdates(missing.updates, target.emptyVersion());
    await target.applyRemoteUpdates(missing.updates, target.emptyVersion());
    expect(
      createHistoryWriter(remote)
        .readStored()
        .map((turn) => turn.id)
    ).toEqual(['prepared']);
  } finally {
    stop();
    local.free();
    remote.free();
  }
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
