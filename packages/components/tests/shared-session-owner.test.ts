import { LoroDoc } from 'loro-crdt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDirectWorkspaceWriter } from '../src/providers/workspace-writer-impl';
import { createSharedSessionOwner } from '../src/providers/shared-session-owner';
import {
  createSharedSessionClientStore,
  type SessionOwnerTransport,
} from '../src/providers/shared-session-client';
import { createConversationSession } from '../src/lib/conversation-view/create-conversation-session';
import {
  buildSessionDoc,
  buildFixtureHistory,
  FIXTURE_SESSION_ID,
} from './conversation-view-fixtures';
import { getSessionRoomId, type SessionId } from '@lody/shared';
import type { WorkspaceRuntime, SessionDocStore } from '../src/atoms/runtime';
import type { SessionOwnerEvent } from '@lody/shared/session-owner-protocol';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  vi.useRealTimers();
});
function fixture() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const stores = new Map<string, SessionDocStore>();
  const persisted = new Map<string, Uint8Array>();
  let persistenceError = false;
  let acquisitions = 0;
  const runtime = {
    workspaceId: 'workspace-test',
    repo: {
      upsertDocMeta: async () => {},
      persistMetaNow: async () => {},
      persistDocNow: async (room: string, doc: ReturnType<typeof buildSessionDoc>) => {
        if (persistenceError) throw new Error('storage unavailable; outcome unknown');
        persisted.set(room, doc.export({ mode: 'snapshot' }));
      },
    },
    async acquireSessionStore(id: SessionId, seed?: Uint8Array) {
      let store = stores.get(id);
      if (!store) {
        acquisitions++;
        const doc = persisted.has(getSessionRoomId(id))
          ? new LoroDoc()
          : buildSessionDoc(id === FIXTURE_SESSION_ID ? buildFixtureHistory(4) : []);
        if (persisted.has(getSessionRoomId(id))) {
          doc.import(persisted.get(getSessionRoomId(id))!);
        }
        if (seed) doc.import(seed);
        const conversation = createConversationSession(doc, { sessionId: id });
        store = {
          sessionId: id,
          roomId: getSessionRoomId(id),
          historyBackend: 'loro',
          doc,
          history: conversation.history,
          sessionData: conversation.sessionData,
          getState: () => conversation.mirror.getState(),
          setState: (updater) => conversation.mirror.setState(updater as never),
          subscribe: (listener) => conversation.mirror.subscribe(listener),
          acquireSync: () => () => {},
          getSyncState: () => 'synced',
          subscribeSyncState: () => () => {},
          firstSynced: Promise.resolve(),
          waitUntilSynced: async () => {},
          dispose: () => {
            conversation.dispose();
            doc.free();
          },
        } as SessionDocStore;
        stores.set(id, store);
        await vi.runAllTimersAsync();
      }
      return store;
    },
    releaseSessionStoreRef: () => {},
    async withSessionStore<T>(id: SessionId, fn: (store: SessionDocStore) => Promise<T>) {
      return fn(await this.acquireSessionStore(id));
    },
    async dispose() {
      for (const store of stores.values()) store.dispose();
      stores.clear();
    },
  } as unknown as WorkspaceRuntime;
  Object.assign(runtime, { writer: createDirectWorkspaceWriter(runtime as never) });
  const listeners = new Map<string, Set<(event: SessionOwnerEvent) => void>>();
  const emit = (event: SessionOwnerEvent) => {
    for (const listener of listeners.get(event.clientId) ?? []) listener(structuredClone(event));
  };
  let owner = createSharedSessionOwner(runtime, emit);
  const leases = new Map<string, Set<string>>();
  cleanup.push(() => owner.dispose());
  const connect = (id: string): SessionOwnerTransport => {
    const subscriptions = new Set<(event: SessionOwnerEvent) => void>();
    listeners.set(id, subscriptions);
    return {
      request: async (request) => {
        if (request.method === 'open') {
          const set = leases.get(id) ?? new Set();
          set.add(request.leaseId);
          leases.set(id, set);
        }
        if (request.method === 'close') leases.get(id)?.delete(request.leaseId);
        return structuredClone(await owner.request(id, structuredClone(request)));
      },
      subscribe: (listener) => {
        subscriptions.add(listener);
        return () => subscriptions.delete(listener);
      },
    };
  };
  const open = async (
    transport: SessionOwnerTransport,
    id = FIXTURE_SESSION_ID,
    seed?: Uint8Array
  ) => {
    const store = await createSharedSessionClientStore(transport, 'workspace-test', id, seed);
    cleanup.push(() => store.dispose());
    await vi.runAllTimersAsync();
    await store.history.ready;
    return store;
  };
  return {
    open,
    connect,
    get owner() {
      return owner;
    },
    stores,
    persisted,
    async restart() {
      const previous = [...leases].flatMap(([clientId, ids]) =>
        [...ids].map((leaseId) => ({ clientId, leaseId }))
      );
      leases.clear();
      await owner.dispose();
      owner = createSharedSessionOwner(runtime, emit);
      for (const lease of previous)
        emit({ ...lease, generation: '', sequence: 0, kind: 'lost', error: 'Owner terminated' });
      await vi.runAllTimersAsync();
    },
    acquisitions: () => acquisitions,
    failPersistence: () => {
      persistenceError = true;
    },
  };
}

describe('shared desktop session ownership', () => {
  it('keeps one document while independent views read and close', async () => {
    const f = fixture();
    const a = await f.open(f.connect('a'));
    const b = await f.open(f.connect('b'));
    expect(f.acquisitions()).toBe(1);
    expect(a.doc).toBeUndefined();
    expect(b.doc).toBeUndefined();
    expect(a.history.turnCount).toBe(8);
    expect(b.history.turnCount).toBe(8);
    a.dispose();
    f.owner.releaseClient('a');
    const turn = { ...buildFixtureHistory(1)[0]!, id: 'from-b' };
    await b.sessionData.commands.appendTurn(turn);
    expect(await b.sessionData.history.count()).toBe(9);
    expect((await b.sessionData.history.readTurn('from-b')).state).toBe('ready');
    const durable = buildSessionDoc([]);
    durable.import(f.persisted.get(b.roomId)!);
    expect(durable.getList('history').length).toBe(9);
    durable.free();
  });

  it('delivers a write landing between the open snapshot and client observation', async () => {
    const f = fixture();
    const wire = f.connect('a');
    const transport: SessionOwnerTransport = {
      ...wire,
      request: async (request) => {
        const value = await wire.request(request);
        if (request.method === 'open') {
          await f.stores
            .get(FIXTURE_SESSION_ID)!
            .sessionData.commands.appendTurn({ ...buildFixtureHistory(1)[0]!, id: 'gap' });
          await Promise.resolve();
        }
        return value;
      },
    };
    const view = await f.open(transport);
    await vi.runAllTimersAsync();
    expect(view.history.turnCount).toBe(9);
    expect(view.history.indexOf('gap')).toBe(8);
  });

  it('merges an old window replica without discarding owner edits', async () => {
    const f = fixture();
    const a = await f.open(f.connect('a'));
    await a.sessionData.commands.appendTurn({ ...buildFixtureHistory(1)[0]!, id: 'owner-edit' });
    const legacy = buildSessionDoc([{ ...buildFixtureHistory(1)[0]!, id: 'legacy-edit' }], 2);
    const b = await f.open(f.connect('b'), FIXTURE_SESSION_ID, legacy.export({ mode: 'snapshot' }));
    legacy.free();
    expect((await b.sessionData.history.readTurn('owner-edit')).state).toBe('ready');
    expect((await b.sessionData.history.readTurn('legacy-edit')).state).toBe('ready');
  });

  it('preserves snapshot provenance across sessions on the same connection', async () => {
    const f = fixture();
    const connection = f.connect('a');
    const source = await f.open(connection);
    const target = await f.open(connection, 'session-target' as SessionId);
    const snapshot = await source.sessionData.snapshots.capture();
    await target.sessionData.snapshots.copyFrom(snapshot, snapshot.history.slice(0, 2));
    expect(await target.sessionData.history.count()).toBe(2);
    const stranger = await f.open(f.connect('b'), 'session-stranger' as SessionId);
    await expect(
      stranger.sessionData.snapshots.copyFrom(snapshot, snapshot.history)
    ).rejects.toThrow('another owner connection');
  });

  it('rejects success acknowledgement when persistence fails without retrying the write', async () => {
    const f = fixture();
    const view = await f.open(f.connect('a'));
    f.failPersistence();
    await expect(
      view.sessionData.commands.appendTurn({ ...buildFixtureHistory(1)[0]!, id: 'uncertain' })
    ).rejects.toThrow('outcome unknown');
    expect(await view.sessionData.history.count()).toBe(9);
  });

  it('preserves queue identities and applies concurrent edits in the owner', async () => {
    const f = fixture();
    const a = await f.open(f.connect('a'));
    const b = await f.open(f.connect('b'));
    await Promise.all([
      a.queueCommands!.enqueue({
        userTurnId: 'queue-a',
        inputConfig: buildFixtureHistory(1)[0]!.inputConfig,
      }),
      b.queueCommands!.enqueue({
        userTurnId: 'queue-b',
        inputConfig: buildFixtureHistory(1)[0]!.inputConfig,
      }),
    ]);
    const queue = b.getState().mq!;
    expect(queue).toHaveLength(2);
    const aId = queue.find((item) => item.userTurnId === 'queue-a')!.$cid!;
    const bId = queue.find((item) => item.userTurnId === 'queue-b')!.$cid!;
    expect(aId).toBeTruthy();
    expect(bId).toBeTruthy();
    await a.queueCommands!.remove(aId);
    expect(b.getState().mq!.map((item) => item.$cid)).toEqual([bId]);
  });

  it('reconnects views after owner replacement and recovers acknowledged data', async () => {
    const f = fixture();
    const a = await f.open(f.connect('a'));
    const b = await f.open(f.connect('b'));
    await a.sessionData.commands.appendTurn({ ...buildFixtureHistory(1)[0]!, id: 'before-crash' });
    const control = structuredClone(a.getState());
    const ready = Promise.all(
      [a, b].map(
        (store) =>
          new Promise<void>((resolve) => {
            const stop = store.subscribeSyncState((state) => {
              if (state === 'synced') {
                stop();
                resolve();
              }
            });
          })
      )
    );
    await f.restart();
    await ready;
    expect(a.getState()).toEqual(control);
    expect((await b.sessionData.history.readTurn('before-crash')).state).toBe('ready');
    await b.sessionData.commands.appendTurn({ ...buildFixtureHistory(1)[0]!, id: 'after-crash' });
    expect(await a.sessionData.history.count()).toBe(10);
  });

  it('keeps observation alive when one of two concurrent openers closes', async () => {
    const f = fixture();
    const first = f.connect('a').request({
      workspaceId: 'workspace-test',
      sessionId: FIXTURE_SESSION_ID,
      leaseId: 'opening',
      method: 'open',
      args: [],
    });
    const rejected = expect(first).rejects.toThrow('client closed');
    const second = f.open(f.connect('b'));
    f.owner.releaseClient('a');
    await rejected;
    const view = await second;
    await view.sessionData.commands.appendTurn({ ...buildFixtureHistory(1)[0]!, id: 'still-live' });
    await vi.runAllTimersAsync();
    expect(view.history.indexOf('still-live')).toBe(8);
    expect(f.acquisitions()).toBe(1);
  });

  it('reports an indeterminate tail edit when its committed reply is lost', async () => {
    const f = fixture();
    const wire = f.connect('a');
    const view = await f.open({
      ...wire,
      request: async (request) => {
        const value = await wire.request(request);
        if (request.method === 'replaceEditableTail') throw new Error('reply lost');
        return value;
      },
    });
    const result = await view.sessionData.commands.replaceEditableTail({
      expectedUserTurnId: 'u-3',
      expectedForkTurnId: 'acp-2',
      replacement: { ...buildFixtureHistory(1)[0]!, id: 'edited-u-3', status: 'pending' },
    });
    expect(result.status).toBe('indeterminate');
    expect((await view.sessionData.history.readTurn('edited-u-3')).state).toBe('ready');
    expect((await view.sessionData.history.readTurn('u-3')).state).toBe('missing');
  });

  it('starts later observers from the current directory', async () => {
    const f = fixture();
    const view = await f.open(f.connect('a'));
    await view.sessionData.commands.appendTurn({
      ...buildFixtureHistory(1)[0]!,
      id: 'later-observer',
    });
    const observation = view.sessionData.history.observe(() => {});
    expect(await observation.initial).toHaveLength(9);
    observation.unsubscribe();
  });

  it('fences workspace, session and released-client capabilities', async () => {
    const f = fixture();
    const transport = f.connect('a');
    await f.open(transport);
    await expect(
      transport.request({
        workspaceId: 'other',
        sessionId: FIXTURE_SESSION_ID,
        leaseId: 'forged',
        method: 'readAll',
        args: [],
      })
    ).rejects.toThrow('workspace mismatch');
    await expect(
      transport.request({
        workspaceId: 'workspace-test',
        sessionId: FIXTURE_SESSION_ID,
        leaseId: 'forged',
        method: 'readAll',
        args: [],
      })
    ).rejects.toThrow('Unknown session lease');
    f.owner.releaseClient('a');
    await expect(
      transport.request({
        workspaceId: 'workspace-test',
        sessionId: FIXTURE_SESSION_ID,
        leaseId: 'new',
        method: 'open',
        args: [],
      })
    ).rejects.toThrow('client closed');
  });
});
