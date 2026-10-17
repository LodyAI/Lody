import { LoroDoc, LoroMap } from 'loro-crdt';
import { updateTestHistory } from './history-port-fixture';
import { describe, expect, it, vi } from 'vitest';
import { Effect, Stream, SubscriptionRef } from 'effect';
import type { RoomStatus } from 'loro-repo/effect';

import { WorkspaceRepoLegacy } from '@lody/shared/workspace-data/repo-legacy';
import { v4 as uuidv4 } from 'uuid';
import { FileSystemStorageAdaptor } from 'loro-repo/storage/filesystem';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LoroDocumentManager, SessionDocument } from '../src/lib/loro/doc';
import {
  getSessionRoomId,
  type MessageContent,
  type SessionHistoryInput,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import type { Logger } from '../src/utils/logger';

const createUserEntry = (id: string, text: string): SessionHistoryInput => ({
  id,
  role: 'user',
  items: [{ type: 'text', text }] satisfies MessageContent[],
  timestamp: new Date().toISOString(),
  status: 'pending',
  read: false,
  userId: undefined,
});

describe('SessionDocument auto read', () => {
  it.each([false, true])(
    'reopens a retired manager wrapper after save failure, storage recovered=%s',
    async (recovered) => {
      const baseDir = await mkdtemp(join(tmpdir(), 'manager-session-recovery-'));
      const adapter = new FileSystemStorageAdaptor({ baseDir });
      const save = adapter.save.bind(adapter);
      const sessionId = 'retained-session' as SessionId;
      const roomId = getSessionRoomId(sessionId);
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const saveFailure = new Error('synthetic ENOSPC');
      let blocked = false;
      adapter.save = async (payload) => {
        if (
          blocked &&
          (payload.type === 'doc-update' || payload.type === 'doc-snapshot') &&
          payload.docId === roomId
        ) {
          entered.resolve();
          await resume.promise;
          throw saveFailure;
        }
        await save(payload);
      };
      const repo = await WorkspaceRepoLegacy.create({ storageAdapter: adapter });
      const joinEntered = Promise.withResolvers<void>();
      const resumeJoin = Promise.withResolvers<void>();
      const joinRoom = repo.joinDocRoom.bind(repo);
      let oldRoom: Awaited<ReturnType<typeof repo.joinDocRoom>> | undefined;
      let oldSync: Promise<void> | undefined;
      vi.spyOn(repo, 'joinDocRoom').mockImplementationOnce(async (id) => {
        oldRoom = await joinRoom(id);
        joinEntered.resolve();
        await resumeJoin.promise;
        return oldRoom;
      });
      const noop = () => {};
      const logger: Logger = {
        info: noop,
        warn: noop,
        error: noop,
        success: noop,
        debug: noop,
        trace: noop,
        setLevel: noop,
        child: () => logger,
        close: async () => {},
      };
      const manager = new LoroDocumentManager({
        repo,
        workspaceId: 'synthetic-workspace' as WorkspaceId,
        userId: 'synthetic-user',
        metaSub: null,
        logger,
      });
      let cleanupTask: Promise<void> | undefined;
      let openingTask: Promise<SessionDocument[]> | undefined;
      try {
        const first = await manager.getOrCreateSessionDoc(sessionId, {
          historyBackend: 'loro',
          skipAutoRead: true,
        });
        oldSync = first.waitForRemoteSync();
        await joinEntered.promise;
        const replica = first.handle?.doc;
        if (!replica) throw new Error('Missing initial replica');
        replica.getText('synthetic').insert(0, 'retained bytes');
        replica.commit();
        blocked = true;
        const cleanup = manager.cleanSessionDoc(sessionId, { preserveStatus: true });
        cleanupTask = cleanup;
        const cleanupFailure = cleanup.then(
          () => {
            throw new Error('Expected failed eviction');
          },
          (error: unknown) => error
        );
        void cleanupFailure.catch(() => undefined);
        await entered.promise;
        let opened = false;
        const reopen = () => {
          openingTask = Promise.all([
            manager.getOrCreateSessionDoc(sessionId, { skipAutoRead: true }),
            manager.getOrCreateSessionDoc(sessionId, { skipAutoRead: true }),
          ]).then((sessions) => {
            opened = true;
            return sessions;
          });
          void openingTask.catch(() => undefined);
          return openingTask;
        };
        const reopening = recovered ? undefined : reopen();
        const other = await manager.getOrCreateSessionDoc('independent-session' as SessionId, {
          skipAutoRead: true,
        });
        await expect(other.getDocState()).resolves.toBeDefined();
        expect(opened).toBe(false);
        resume.resolve();
        const failure = await cleanupFailure;
        expect(failure).toBeInstanceOf(Error);
        if (recovered) blocked = false;
        const [left, right] = await (reopening ?? reopen());
        if (!left || !right) throw new Error('Missing reopened Session');
        expect(left).toBe(right);
        expect(left.isDestroyed).toBe(false);
        expect(left.handle?.doc).toBe(replica);
        await left.waitForRemoteSync();
        const currentRoom = left.docSub;
        resumeJoin.resolve();
        await oldSync;
        expect(left.docSub === currentRoom).toBe(true);
        expect(oldRoom?.signal.aborted).toBe(true);
        await expect(left.getDocState()).resolves.toBeDefined();
        await expect(cleanup).rejects.toBe(failure);
        await updateTestHistory(left, () => [createUserEntry('reopened-turn', 'usable writer')]);
        expect((await left.sessionData.history.readAll())[0]?.id).toBe('reopened-turn');
        if (!recovered) {
          await expect(
            manager.cleanSessionDoc(sessionId, { preserveStatus: true })
          ).rejects.toThrow();
          expect((await manager.getSessionHistorySnapshot(sessionId))[0]?.id).toBe('reopened-turn');
          const next = await manager.getOrCreateSessionDoc(sessionId, { skipAutoRead: true });
          expect(next.handle?.doc).toBe(replica);
          await expect(next.getDocState()).resolves.toBeDefined();
        }
        blocked = false;
        await manager.cleanSessionDoc(sessionId, { preserveStatus: true });
        expect((await adapter.loadDoc(roomId))?.getText('synthetic').toString()).toBe(
          'retained bytes'
        );
        const next = await manager.getOrCreateSessionDoc(sessionId, { skipAutoRead: true });
        expect((await next.sessionData.history.readAll())[0]?.id).toBe('reopened-turn');
      } finally {
        blocked = false;
        resume.resolve();
        resumeJoin.resolve();
        await Promise.allSettled([cleanupTask, openingTask, oldSync]);
        await manager.cleanUp({ preserveSessionStatus: true });
        await rm(baseDir, { recursive: true, force: true });
      }
    }
  );

  it('repairs pending Session rooms without taking a healthy sibling offline', async () => {
    const repo = await WorkspaceRepoLegacy.create({});
    const remote = new LoroDoc();
    remote.getText('incoming').insert(0, 'history delivery');
    remote.commit();
    const sessions = ['healthy', 'pending-a', 'pending-b'].map(
      (id) => new SessionDocument(repo, id as SessionId, async () => {})
    );
    const [healthy, ...pending] = sessions;
    if (!healthy) throw new Error('Missing healthy fixture');
    const statuses = new Map<string, SubscriptionRef.SubscriptionRef<RoomStatus>>();
    const resetting = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let attempts: Promise<void[]> | undefined;
    await repo.addTransport('streams', {
      kind: 'native-workspace-transport',
      make: (id) =>
        Effect.succeed({
          id,
          authority: 'server',
          connect: Effect.void,
          disconnect: Effect.void,
          reconnect: Effect.gen(function* () {
            for (const status of statuses.values()) yield* SubscriptionRef.set(status, 'offline');
            resetting.resolve();
            yield* Effect.promise(() => resume.promise);
            for (const status of statuses.values()) yield* SubscriptionRef.set(status, 'synced');
          }),
          join: (target, replica) =>
            Effect.gen(function* () {
              const status = yield* SubscriptionRef.make<RoomStatus>('synced');
              if (target.kind === 'doc') statuses.set(target.id, status);
              return {
                status,
                close: Effect.void,
                sync: Effect.gen(function* () {
                  if (replica.kind === 'doc') {
                    yield* replica.lease.importUpdates([remote.export({ mode: 'snapshot' })]);
                    yield* SubscriptionRef.set(status, 'synced');
                  }
                  return 'confirmed' as const;
                }),
              };
            }),
        }),
    });
    try {
      for (const session of sessions) {
        await session.initOffline(undefined, { historyBackend: 'loro' });
        const room = await repo.joinDocRoom(session.roomId);
        session.docSub = room;
        await repo.runLegacy(room.native.awaitSynced('streams'));
      }
      const room = healthy.docSub;
      if (!room) throw new Error('Missing healthy room');
      for (const session of pending) {
        const status = statuses.get(session.roomId);
        if (!status) throw new Error('Missing pending transport room');
        await repo.runLegacy(SubscriptionRef.set(status, 'offline'));
        const pendingRoom = session.docSub;
        if (!pendingRoom) throw new Error('Missing pending room');
        await repo.runLegacy(
          pendingRoom.native.status('streams').pipe(
            Stream.filter((next) => next === 'offline'),
            Stream.runHead
          )
        );
      }
      attempts = Promise.all(pending.map((session) => session.rejoinDocRoom()));
      // Both outcomes have explicit signals. Hold a connection reset long
      // enough to observe its effect on the sibling, without scheduler races.
      const first = await Promise.race([
        attempts.then(() => 'rooms' as const),
        resetting.promise.then(() => 'connection' as const),
      ]);
      if (first === 'connection')
        await repo.runLegacy(
          room.native.status('streams').pipe(
            Stream.filter((status) => status === 'offline'),
            Stream.runHead
          )
        );
      expect(await repo.runLegacy(room.native.statusSnapshot('streams'))).toBe('synced');
      await attempts;
      for (const session of pending)
        expect(session.handle?.doc.getText('incoming').toString()).toBe('history delivery');
      healthy.handle?.doc.getText('outgoing').insert(0, 'still writable');
      expect(healthy.handle?.doc.getText('outgoing').toString()).toBe('still writable');
    } finally {
      resume.resolve();
      await attempts?.catch(() => undefined);
      for (const session of sessions) await session.destroy({ preserveStatus: true });
      await repo.destroy();
      remote.free();
    }
  });
  it('rejects an explicit room rejoin without a route instead of parking readiness', async () => {
    const repo = await WorkspaceRepoLegacy.create({});
    const session = new SessionDocument(repo, uuidv4() as SessionId, async () => {});
    try {
      await session.initOffline({ history: [] });
      session.docSub = await repo.joinDocRoom(session.roomId);
      await expect(session.rejoinDocRoom()).rejects.toMatchObject({ _tag: 'RepoUnsupported' });
    } finally {
      await session.destroy({ preserveStatus: true });
      await repo.destroy();
    }
  });
  it.each(['reconcile', 'sync'] as const)(
    'retires its own room during %s while another borrower survives',
    async (phase) => {
      const repo = await WorkspaceRepoLegacy.create({});
      const session = new SessionDocument(repo, uuidv4() as SessionId, async () => {});
      const entered = Promise.withResolvers<void>();
      const reconnect = Promise.withResolvers<void>();
      await session.initOffline({ history: [] });
      await repo.addTransport('streams', {
        kind: 'native-workspace-transport',
        make: (id) =>
          Effect.succeed({
            id,
            authority: 'server',
            connect: Effect.void,
            disconnect: Effect.void,
            join: () =>
              Effect.gen(function* () {
                if (phase === 'reconcile') {
                  entered.resolve();
                  yield* Effect.promise(() => reconnect.promise);
                }
                return {
                  status: yield* SubscriptionRef.make<RoomStatus>('joining'),
                  close: Effect.void,
                  sync: Effect.gen(function* () {
                    if (phase === 'sync') {
                      entered.resolve();
                      yield* Effect.promise(() => reconnect.promise);
                    }
                    return 'confirmed' as const;
                  }),
                };
              }),
          }),
      });
      const room = await repo.joinDocRoom(session.roomId);
      const other = await repo.joinDocRoom(session.roomId);
      session.docSub = room;
      const rejoining = session.rejoinDocRoom();
      const settled = rejoining.then(
        () => undefined,
        (error: unknown) => error
      );
      try {
        await entered.promise;
        await session.destroy({ preserveStatus: true });
        reconnect.resolve();
        const result = await settled;
        expect(result).toBeInstanceOf(Error);
        expect(session.isDestroyed).toBe(true);
        expect(session.docSub).toBeNull();
        expect(room.signal.aborted).toBe(true);
        expect(other.signal.aborted).toBe(false);
        expect(other.native.replica.kind).toBe('doc');
        if (other.native.replica.kind === 'doc') {
          other.native.replica.lease.doc.getText('survivor').insert(0, 'still writable');
          expect(other.native.replica.lease.doc.getText('survivor').toString()).toBe(
            'still writable'
          );
        }
      } finally {
        reconnect.resolve();
        other.unsubscribe();
        await session.destroy({ preserveStatus: true });
        await repo.destroy();
      }
    }
  );
  it.each(['joining', 'offline'] as const)(
    'bounds a %s room attempt and permits a later retry',
    async (initialStatus) => {
      const repo = await WorkspaceRepoLegacy.create({});
      const session = new SessionDocument(repo, uuidv4() as SessionId, async () => {});
      const entered = Promise.withResolvers<void>();
      let stalled = true;
      await session.initOffline({ history: [] });
      await repo.addTransport('streams', {
        kind: 'native-workspace-transport',
        make: (id) =>
          Effect.succeed({
            id,
            authority: 'server',
            connect: Effect.void,
            disconnect: Effect.void,
            join: () =>
              Effect.gen(function* () {
                const status = yield* SubscriptionRef.make<RoomStatus>(initialStatus);
                return {
                  status,
                  close: Effect.void,
                  sync: Effect.suspend(() => {
                    if (stalled) {
                      entered.resolve();
                      return Effect.never;
                    }
                    return SubscriptionRef.set(status, 'synced').pipe(
                      Effect.as('confirmed' as const)
                    );
                  }),
                };
              }),
          }),
      });
      session.docSub = await repo.joinDocRoom(session.roomId);
      const other = await repo.joinDocRoom(session.roomId);
      vi.stubEnv('LODY_LORO_SYNC_DOC_TIMEOUT_MS', '8000');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const attempt = session.rejoinDocRoom();
        const timedOut = expect(attempt).rejects.toMatchObject({ _tag: 'TimeoutError' });
        await entered.promise;
        await vi.advanceTimersByTimeAsync(8000);
        await timedOut;
        expect(other.signal.aborted).toBe(false);
        if (other.native.replica.kind !== 'doc') throw new Error('Expected Doc');
        other.native.replica.lease.doc.getText('survivor').insert(0, 'writable after timeout');
        expect(other.native.replica.lease.doc.getText('survivor').toString()).toBe(
          'writable after timeout'
        );
        stalled = false;
        await session.rejoinDocRoom();
      } finally {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        other.unsubscribe();
        await session.destroy({ preserveStatus: true });
        await repo.destroy();
      }
    }
  );
  it.each(['destroy', 'reinitialize'] as const)(
    'retains its original local replica after a failed eviction and retries on %s',
    async (retry) => {
      const baseDir = await mkdtemp(join(tmpdir(), 'lody-session-close-'));
      const adapter = new FileSystemStorageAdaptor({ baseDir });
      const save = adapter.save.bind(adapter);
      let blocked = false;
      adapter.save = async (payload) => {
        if (blocked && (payload.type === 'doc-update' || payload.type === 'doc-snapshot'))
          throw new Error('synthetic session save failure');
        await save(payload);
      };
      const repo = await WorkspaceRepoLegacy.create({ storageAdapter: adapter });
      const boundRooms = new Set<string>();
      const session = new SessionDocument(repo, uuidv4() as SessionId, async (id) => {
        await repo.unloadDoc(id);
        boundRooms.delete(id);
      });
      try {
        await session.initOffline({ history: [] });
        boundRooms.add(session.roomId);
        session.handle!.doc.getText('synthetic').insert(0, 'kept');
        session.handle!.doc.commit();
        blocked = true;
        await expect(session.destroy({ preserveStatus: true })).rejects.toThrow();
        expect(boundRooms.size).toBe(1);
        expect(session.isDestroyed).toBe(true);
        expect(session.handle).toBeNull();
        if (retry === 'reinitialize') {
          const original = (await repo.openPersistedDoc(session.roomId)).doc;
          await session.initOffline();
          expect(session.handle?.doc).toBe(original);
          expect(session.handle?.doc.getText('synthetic').toString()).toBe('kept');
        }
        blocked = false;
        await session.destroy({ preserveStatus: true });
        const reopened = await repo.acquireDoc(session.roomId);
        expect(reopened.doc.getText('synthetic').toString()).toBe('kept');
        await reopened.release();
      } finally {
        blocked = false;
        await session.destroy({ preserveStatus: true });
        await repo.destroy();
        await rm(baseDir, { recursive: true, force: true });
      }
    }
  );

  it('acknowledges from shallow fields without reading assistant bodies on notifications', async () => {
    const repo = await WorkspaceRepoLegacy.create({});
    const session = new SessionDocument(repo, uuidv4() as SessionId);
    try {
      await session.initOffline({
        history: [
          createUserEntry('user', 'hello'),
          {
            id: 'assistant',
            role: 'assistant',
            timestamp: 'synthetic',
            items: [{ type: 'text', text: 'long body' }],
          },
        ],
      });
      const bodies: string[] = [];
      const original = LoroMap.prototype.toJSON;
      const spy = vi.spyOn(LoroMap.prototype, 'toJSON').mockImplementation(function () {
        const id = this.get('id');
        if (typeof id === 'string') bodies.push(id);
        return original.call(this);
      });
      try {
        const doc = session.handle!.doc;
        (doc.getList('history').get(1) as LoroMap).set('finished', true);
        doc.commit();
        expect(bodies).toEqual([]);
        expect(session.sessionData.history.readDirectory(0, 1)[0]?.scalars?.status).toBe('seen');
        expect(session.sessionData.history.readDirectory(1, 2)[0]?.scalars?.finished).toBe(true);
      } finally {
        spy.mockRestore();
      }
    } finally {
      await repo.destroy();
    }
  });

  it('marks latest user entry as read on history updates', async () => {
    const repo = await WorkspaceRepoLegacy.create({});
    try {
      const sessionId = uuidv4() as SessionId;
      const doc = new SessionDocument(repo, sessionId);
      await doc.initOffline({ history: [] });

      await updateTestHistory(doc, (history) => history.concat(createUserEntry('h1', 'hi')));
      // Auto-read is a background port command now: wait for the accepted write
      // instead of assuming a single microtask.
      await vi.waitFor(async () => {
        expect((await doc.sessionData.history.readAll())[0]!.status).toBe('seen');
      });

      const history = await doc.sessionData.history.readAll();
      expect(history).toHaveLength(1);
      expect(history[0]!.role).toBe('user');
      expect(history[0]!.status).toBe('seen');
      expect(history[0]!.read).toBe(true);
    } finally {
      await repo.destroy();
    }
  });

  it('only marks the latest user entry when multiple are unread', async () => {
    const repo = await WorkspaceRepoLegacy.create({});
    try {
      const sessionId = uuidv4() as SessionId;
      const doc = new SessionDocument(repo, sessionId);
      await doc.initOffline({ history: [] });

      await updateTestHistory(doc, (history) =>
        history.concat([createUserEntry('h1', 'first'), createUserEntry('h2', 'second')])
      );
      await vi.waitFor(async () => {
        const current = await doc.sessionData.history.readAll();
        expect(current.find((entry) => entry.id === 'h2')?.status).toBe('seen');
      });

      const history = await doc.sessionData.history.readAll();
      expect(history).toHaveLength(2);
      const first = history.find((entry) => entry.id === 'h1');
      const second = history.find((entry) => entry.id === 'h2');
      expect(first?.status).toBe('pending');
      expect(first?.read).not.toBe(true);
      expect(second?.status).toBe('seen');
      expect(second?.read).toBe(true);
    } finally {
      await repo.destroy();
    }
  });

  it('can mark the latest user entry as read for existing history', async () => {
    const repo = await WorkspaceRepoLegacy.create({});
    try {
      const sessionId = uuidv4() as SessionId;
      const doc = new SessionDocument(repo, sessionId);
      await doc.initOffline({ history: [] });
      await updateTestHistory(doc, () => [
        createUserEntry('h1', 'first'),
        createUserEntry('h2', 'second'),
      ]);
      await vi.waitFor(async () => {
        const current = await doc.sessionData.history.readAll();
        expect(current.find((entry) => entry.id === 'h2')?.status).toBe('seen');
      });

      const before = await doc.sessionData.history.readAll();
      expect(before).toHaveLength(2);
      const beforeFirst = before.find((entry) => entry.id === 'h1');
      const beforeSecond = before.find((entry) => entry.id === 'h2');
      expect(beforeFirst?.status).toBe('pending');
      expect(beforeFirst?.read).not.toBe(true);
      expect(beforeSecond?.status).toBe('seen');
      expect(beforeSecond?.read).toBe(true);

      await doc.markLatestUserHistoryAsSeenIfNeeded();

      const history = await doc.sessionData.history.readAll();
      expect(history).toHaveLength(2);
      const first = history.find((entry) => entry.id === 'h1');
      const second = history.find((entry) => entry.id === 'h2');
      expect(first?.status).toBe('pending');
      expect(first?.read).not.toBe(true);
      expect(second?.status).toBe('seen');
      expect(second?.read).toBe(true);
    } finally {
      await repo.destroy();
    }
  });

  it('does not pop the first queued message while it is being edited', async () => {
    const repo = await WorkspaceRepoLegacy.create({});
    try {
      const sessionId = uuidv4() as SessionId;
      const doc = new SessionDocument(repo, sessionId);
      await doc.initOffline({ history: [] });

      await doc.pushMessageQueue({
        task: 'queued draft',
        project: undefined,
        userId: 'user-1',
        timestamp: new Date().toISOString(),
        isEditing: true,
        editingStartedAt: Date.now(),
        acpSessionConfig: {
          prompt: 'queued draft',
          inputBlocks: [{ type: 'text', text: 'queued draft' }],
          cliType: 'builtin',
          agentType: 'codex',
        },
      });

      await expect(doc.popMessageQueue()).resolves.toBeNull();
      await expect(doc.getMessageQueue()).resolves.toEqual([
        expect.objectContaining({
          task: 'queued draft',
          isEditing: true,
        }),
      ]);
    } finally {
      await repo.destroy();
    }
  });

  it('pops a queued message whose editing lease has expired', async () => {
    const repo = await WorkspaceRepoLegacy.create({});
    try {
      const sessionId = uuidv4() as SessionId;
      const doc = new SessionDocument(repo, sessionId);
      await doc.initOffline({ history: [] });

      // editingStartedAt 10 minutes in the past — well past the 5-minute lease
      const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
      await doc.pushMessageQueue({
        task: 'stuck draft',
        project: undefined,
        userId: 'user-1',
        userTurnId: 'turn-stuck',
        timestamp: new Date().toISOString(),
        isEditing: true,
        editingStartedAt: tenMinutesAgo,
        acpSessionConfig: {
          prompt: 'stuck draft',
          inputBlocks: [{ type: 'text', text: 'stuck draft' }],
          cliType: 'builtin',
          agentType: 'codex',
        },
      });

      const popped = await doc.popMessageQueue();
      expect(popped?.task).toBe('stuck draft');
      expect(popped?.operationId).toBe('queue:turn-stuck');
      await expect(doc.getMessageQueue()).resolves.toEqual([]);
    } finally {
      await repo.destroy();
    }
  });

  it('treats a missing editingStartedAt as an expired lease (legacy item)', async () => {
    const repo = await WorkspaceRepoLegacy.create({});
    try {
      const sessionId = uuidv4() as SessionId;
      const doc = new SessionDocument(repo, sessionId);
      await doc.initOffline({ history: [] });

      await doc.pushMessageQueue({
        task: 'legacy draft',
        project: undefined,
        userId: 'user-1',
        timestamp: new Date().toISOString(),
        isEditing: true,
        acpSessionConfig: {
          prompt: 'legacy draft',
          inputBlocks: [{ type: 'text', text: 'legacy draft' }],
          cliType: 'builtin',
          agentType: 'codex',
        },
      });

      const popped = await doc.popMessageQueue();
      expect(popped?.task).toBe('legacy draft');
      await expect(doc.getMessageQueue()).resolves.toEqual([]);
    } finally {
      await repo.destroy();
    }
  });
});
