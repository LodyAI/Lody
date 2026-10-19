import { describe, expect, it, vi } from 'vitest';
import { TestClock } from 'effect/testing';
import { it as effectIt } from '@effect/vitest';
import { Effect, Fiber, Layer, Stream, SubscriptionRef } from 'effect';
import { LoroDoc } from 'loro-crdt';
import { make as makeWorkspaceRepo } from 'loro-repo/effect';
import { WorkspaceRepoLegacy } from '../src/workspace-data/repo-legacy';
import {
  makeLocalWorkspaceTransport,
  localWorkspaceTransport,
} from '../src/workspace-data/local-transport';
import {
  LocalLoroDataPlaneServerLegacy,
  type LocalLoroFlockLike,
} from '../src/local-loro-data-plane-server';
import { makeLocalLoroWriterLegacy } from '../src/local-loro-writer/legacy';
import { LocalLoroWriterTurn } from '../src/local-loro-writer';
import {
  LocalLoroDataPlaneServerMessageSchema,
  bytesToBase64,
  type LocalLoroDataPlaneServerMessage,
  type LocalLoroDataPlaneClientMessage,
} from '../src/local-loro-data-plane';

function wire(
  serverDoc: LoroDoc,
  options: {
    dropFirstUpdate?: boolean;
    maxPayloadBytes?: number;
    serverFlock?: LocalLoroFlockLike;
  } = {}
) {
  const writer = makeLocalLoroWriterLegacy(
    Layer.succeed(LocalLoroWriterTurn, { next: Effect.yieldNow })
  );
  const listeners = new Set<(message: LocalLoroDataPlaneServerMessage) => void>();
  const statuses = new Set<(online: boolean) => void>();
  const server = new LocalLoroDataPlaneServerLegacy({
    writerLegacy: writer,
    workspaceId: 'ws',
    maxPayloadBytes: options.maxPayloadBytes,
    resolveDoc: async () => serverDoc,
    resolveFlockDoc: async () => {
      if (options.serverFlock) return options.serverFlock;
      throw new Error('Unexpected Flock room');
    },
  });
  let dropped = false;
  let connected = true;
  const pending = new Set<Promise<void>>();
  const peer = {
    id: 'connection-a',
    send: (message: LocalLoroDataPlaneServerMessage) => {
      for (const listener of listeners) listener(message);
    },
  };
  return {
    server,
    listeners,
    statuses,
    setConnected: (value: boolean) => {
      connected = value;
      for (const listener of statuses) listener(value);
    },
    connection: {
      send: (message: LocalLoroDataPlaneClientMessage) => {
        if (message.type === 'ping' || message.type === 'machine-monitor') return;
        if (message.type === 'update' && options.dropFirstUpdate && !dropped) {
          dropped = true;
          return;
        }
        const job = server.handleMessage(peer, message);
        pending.add(job);
        void job.finally(() => pending.delete(job));
      },
      onMessage: (listener: (message: LocalLoroDataPlaneServerMessage) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      onStatusChange: (listener: (online: boolean) => void) => {
        statuses.add(listener);
        return () => {
          statuses.delete(listener);
        };
      },
      isConnected: () => connected,
    },
    close: async () => {
      await Promise.all([...pending]);
      await server.disposeLegacy();
      await writer.closeLegacy();
    },
  };
}

describe('native local v7 transport', () => {
  it('drains an accepted Flock import before restarting its overflowing worker', async () => {
    const remote = new LoroDoc();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* makeWorkspaceRepo();
            const hostMeta = yield* host.acquireRoom({ kind: 'meta' });
            if (hostMeta.replica.kind !== 'meta') throw new Error('Expected Meta replica');
            const remoteMeta = hostMeta.replica.lease.flock;
            remoteMeta.set(['remote'], 'accepted import');
            remoteMeta.commit();
            const harness = yield* Effect.acquireRelease(
              Effect.sync(() => wire(remote, { serverFlock: remoteMeta })),
              (owned) => Effect.promise(owned.close)
            );
            const repo = yield* makeWorkspaceRepo();
            const room = yield* repo.acquireRoom({ kind: 'meta' });
            if (room.replica.kind !== 'meta') throw new Error('Expected Meta replica');
            const flock = room.replica.lease.flock;
            const importJson = flock.importJson.bind(flock);
            let importing = false;
            let firstImport = true;
            const spy = vi.spyOn(flock, 'importJson').mockImplementation(async (bundle) => {
              if (!firstImport) return importJson(bundle);
              firstImport = false;
              importing = true;
              entered.resolve();
              await release.promise;
              try {
                return await importJson(bundle);
              } finally {
                importing = false;
              }
            });
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                release.resolve();
                spy.mockRestore();
              })
            );
            const attachment = yield* repo.attachTransport(
              yield* makeLocalWorkspaceTransport('local', {
                workspaceId: 'ws',
                peerId: 'peer-a',
                connection: harness.connection,
              })
            );
            yield* Effect.promise(() => entered.promise);
            const sibling = yield* repo.acquireRoom({ kind: 'doc', id: 'sibling' });
            yield* sibling.sync('local');
            const siblingEpoch = (yield* sibling.stateSnapshot('local')).epoch;
            const burst = LocalLoroDataPlaneServerMessageSchema.parse({
              type: 'room-status',
              protocolVersion: 7,
              workspaceId: 'ws',
              peerId: 'peer-a',
              room: { scope: 'meta' },
              status: 'joined',
            });
            yield* Effect.sync(() => {
              for (let index = 0; index < 1100; index++)
                for (const listener of harness.listeners) listener(burst);
            });
            const recovery = yield* attachment.reconnect.pipe(
              Effect.forkScoped({ startImmediately: true })
            );
            try {
              yield* sibling.state('local').pipe(
                Stream.filter((state) => state.epoch > siblingEpoch && state.current),
                Stream.runHead
              );
              expect(importing).toBe(true);
              expect(recovery.pollUnsafe()).toBeUndefined();
            } finally {
              release.resolve();
            }
            yield* Fiber.join(recovery);
            expect(importing).toBe(false);
            expect((yield* room.sync('local')).outcome).toBe('confirmed');
            expect(flock.get(['remote'])).toBe('accepted import');
          })
        )
      );
    } finally {
      release.resolve();
      remote.free();
    }
  });
  effectIt.effect('delivers later connection edges while another room drains', () =>
    Effect.gen(function* () {
      const remote = new LoroDoc();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const host = yield* makeWorkspaceRepo();
            const hostMeta = yield* host.acquireRoom({ kind: 'meta' });
            if (hostMeta.replica.kind !== 'meta') throw new Error('Expected Meta replica');
            const remoteMeta = hostMeta.replica.lease.flock;
            remoteMeta.set(['remote'], 'accepted import');
            remoteMeta.commit();
            const harness = yield* Effect.acquireRelease(
              Effect.sync(() => wire(remote, { serverFlock: remoteMeta })),
              (owned) => Effect.promise(owned.close)
            );
            const repo = yield* makeWorkspaceRepo();
            const room = yield* repo.acquireRoom({ kind: 'meta' });
            if (room.replica.kind !== 'meta') throw new Error('Expected Meta replica');
            const flock = room.replica.lease.flock;
            const importJson = flock.importJson.bind(flock);
            let importing = false;
            let firstImport = true;
            const spy = vi.spyOn(flock, 'importJson').mockImplementation(async (bundle) => {
              if (!firstImport) return importJson(bundle);
              firstImport = false;
              importing = true;
              entered.resolve();
              await release.promise;
              try {
                return await importJson(bundle);
              } finally {
                importing = false;
              }
            });
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                release.resolve();
                spy.mockRestore();
              })
            );
            const transport = yield* makeLocalWorkspaceTransport('local', {
              workspaceId: 'ws',
              peerId: 'peer-a',
              connection: harness.connection,
            });
            const attachment = yield* repo.attachTransport(transport);
            yield* Effect.promise(() => entered.promise);
            const sibling = yield* repo.acquireRoom({ kind: 'doc', id: 'sibling' });
            yield* sibling.sync('local');
            const siblingEpoch = (yield* sibling.stateSnapshot('local')).epoch;
            const burst = LocalLoroDataPlaneServerMessageSchema.parse({
              type: 'room-status',
              protocolVersion: 7,
              workspaceId: 'ws',
              peerId: 'peer-a',
              room: { scope: 'meta' },
              status: 'joined',
            });
            yield* Effect.sync(() => {
              for (let index = 0; index < 1100; index++)
                for (const listener of harness.listeners) listener(burst);
            });
            harness.setConnected(true);
            try {
              yield* sibling.state('local').pipe(
                Stream.filter((state) => state.epoch > siblingEpoch && state.current),
                Stream.runHead
              );
              expect(importing).toBe(true);
              harness.setConnected(false);
              // Advance only the injected clock; the slow room remains explicitly held.
              yield* TestClock.adjust(1000);
              expect(yield* SubscriptionRef.get(transport.status)).toBe('offline');
              expect((yield* sibling.stateSnapshot('local')).connection).toBe('offline');
              for (let edge = 0; edge < 2; edge++) {
                const previous = (yield* sibling.stateSnapshot('local')).epoch;
                harness.setConnected(true);
                yield* sibling.state('local').pipe(
                  Stream.filter((state) => state.epoch > previous && state.current),
                  Stream.runHead
                );
                expect(importing).toBe(true);
                harness.setConnected(false);
                yield* sibling.state('local').pipe(
                  Stream.filter((state) => state.connection === 'offline'),
                  Stream.runHead
                );
                expect(yield* SubscriptionRef.get(transport.status)).toBe('offline');
              }
            } finally {
              harness.setConnected(true);
              release.resolve();
            }

            yield* attachment.reconnect;
            expect(importing).toBe(false);
            expect((yield* room.sync('local')).outcome).toBe('confirmed');
            expect(flock.get(['remote'])).toBe('accepted import');
            yield* transport.disconnect;
            harness.setConnected(true);
            yield* TestClock.adjust(1000);
            expect(yield* SubscriptionRef.get(transport.status)).toBe('closed');
          })
        );
      } finally {
        release.resolve();
        remote.free();
      }
    })
  );
  it.each([
    { kind: 'doc', limit: 'events', recovery: 'reconnect' },
    { kind: 'doc', limit: 'bytes', recovery: 'reconnect' },
    { kind: 'doc', limit: 'default-bytes', recovery: 'reconnect' },
    { kind: 'meta', limit: 'events', recovery: 'online' },
  ] as const)(
    'recovers $kind queue $limit overflow via $recovery without replacing the replica',
    async ({ kind, limit, recovery }) => {
      const remote = new LoroDoc();
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const host = yield* makeWorkspaceRepo();
              const hostMeta = yield* host.acquireRoom({ kind: 'meta' });
              if (hostMeta.replica.kind !== 'meta') throw new Error('Expected Meta replica');
              const remoteMeta = hostMeta.replica.lease.flock;
              const harness = yield* Effect.acquireRelease(
                Effect.sync(() => wire(remote, { serverFlock: remoteMeta })),
                (owned) => Effect.promise(owned.close)
              );
              const repo = yield* makeWorkspaceRepo();
              const attachment = yield* repo.attachTransport(
                yield* makeLocalWorkspaceTransport('local', {
                  workspaceId: 'ws',
                  peerId: 'peer-a',
                  connection: harness.connection,
                  ...(limit === 'bytes' ? { maxQueuedBytes: 4096 } : {}),
                })
              );
              const target =
                kind === 'meta' ? ({ kind } as const) : ({ kind, id: 'session-a' } as const);
              const room = yield* repo.acquireRoom(target);
              yield* room.sync('local');
              const originalReplica = room.replica.lease;
              const sibling = yield* repo.acquireRoom({ kind: 'doc', id: 'sibling' });
              yield* sibling.sync('local');
              if (limit === 'default-bytes') {
                let seed = 1;
                const content = Array.from({ length: 128 * 1024 }, () => {
                  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                  return String.fromCharCode(32 + ((seed >>> 16) % 95));
                }).join('');
                remote.getText('burst').insert(0, content);
                remote.commit();
              }
              const burstMessage = LocalLoroDataPlaneServerMessageSchema.parse(
                limit === 'default-bytes'
                  ? {
                      type: 'update',
                      protocolVersion: 7,
                      workspaceId: 'ws',
                      peerId: 'peer-a',
                      room: { scope: 'doc', docId: 'session-a' },
                      payload: {
                        kind: 'doc-update',
                        dataBase64: bytesToBase64(remote.export({ mode: 'update' })),
                      },
                    }
                  : {
                      type: 'room-status',
                      protocolVersion: 7,
                      workspaceId: 'ws',
                      peerId: 'peer-a',
                      room:
                        kind === 'meta' ? { scope: 'meta' } : { scope: 'doc', docId: 'session-a' },
                      status: 'joined',
                    }
              );
              const burstCount =
                limit === 'default-bytes'
                  ? Math.floor((64 * 1024 * 1024) / (JSON.stringify(burstMessage).length * 2)) + 2
                  : 1100;
              // The default byte-budget case must overflow before the event-count cap.
              if (limit === 'default-bytes') expect(burstCount).toBeLessThan(1024);
              for (let cycle = 1; cycle <= 2; cycle++) {
                const epoch = (yield* room.stateSnapshot('local')).epoch;
                // Enqueue a barrier immediately before the synchronous burst. Even a
                // sync event the consumer has not reached must fail rather than hang.
                const waiting = yield* room
                  .sync('local')
                  .pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }));
                yield* Effect.sync(() => {
                  for (let index = 0; index < burstCount; index++)
                    for (const listener of harness.listeners) listener(burstMessage);
                });
                yield* room.state('local').pipe(
                  Stream.filter((state) => state.connection === 'failed'),
                  Stream.runHead
                );
                expect((yield* Fiber.join(waiting))._tag).toBe('Failure');
                expect((yield* room.stateSnapshot('local')).current).toBe(false);
                expect((yield* sibling.sync('local')).outcome).toBe('confirmed');
                if (room.replica.kind === 'doc') {
                  room.replica.lease.doc.getMap('local').set(`cycle-${cycle}`, cycle);
                  room.replica.lease.doc.commit();
                  remote.getMap('remote').set(`cycle-${cycle}`, cycle);
                  remote.commit();
                } else {
                  room.replica.lease.flock.set(['local', `cycle-${cycle}`], cycle);
                  room.replica.lease.flock.commit();
                  remoteMeta.set(['remote', `cycle-${cycle}`], cycle);
                  remoteMeta.commit();
                }
                if (recovery === 'online') {
                  for (const listener of harness.statuses) listener(true);
                } else yield* attachment.reconnect;
                yield* room.state('local').pipe(
                  Stream.filter((state) => state.epoch > epoch && state.current),
                  Stream.runHead
                );
                expect((yield* room.sync('local')).outcome).toBe('confirmed');
                expect(room.replica.lease).toBe(originalReplica);
                if (room.replica.kind === 'doc') {
                  expect(remote.getMap('local').get(`cycle-${cycle}`)).toBe(cycle);
                  expect(room.replica.lease.doc.getMap('remote').get(`cycle-${cycle}`)).toBe(cycle);
                } else {
                  expect(remoteMeta.get(['local', `cycle-${cycle}`])).toBe(cycle);
                  expect(room.replica.lease.flock.get(['remote', `cycle-${cycle}`])).toBe(cycle);
                }
              }
            })
          )
        );
      } finally {
        remote.free();
      }
    }
  );
  it('automatically rejoins an invalidated host room and resumes incoming edits', async () => {
    const remote = new LoroDoc();
    remote.getText('body').insert(0, 'baseline');
    remote.commit();
    const harness = wire(remote);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const repo = yield* makeWorkspaceRepo();
            yield* repo.attachTransport(
              yield* makeLocalWorkspaceTransport('local', {
                workspaceId: 'ws',
                peerId: 'peer-a',
                connection: harness.connection,
              })
            );
            const lease = yield* repo.acquireDoc('session-a');
            const room = yield* repo.acquireRoom({ kind: 'doc', id: 'session-a' });
            yield* room.sync('local');
            const epoch = (yield* room.stateSnapshot('local')).epoch;
            harness.server.invalidateDocRoom('session-a');
            yield* room.state('local').pipe(
              Stream.filter((state) => state.epoch > epoch && state.current),
              Stream.runHead
            );
            const imported = Promise.withResolvers<void>();
            yield* Effect.acquireRelease(
              Effect.sync(() =>
                lease.doc.subscribe(() => {
                  if (lease.doc.getText('body').toString() === 'baseline after') imported.resolve();
                })
              ),
              (unsubscribe) => Effect.sync(unsubscribe)
            );
            remote.getText('body').insert(8, ' after');
            remote.commit();
            yield* Effect.promise(() => imported.promise);
            expect(lease.doc.getText('body').toString()).toBe('baseline after');
          })
        )
      );
    } finally {
      await harness.close();
      remote.free();
    }
  });

  it('confirms a Machine Flock write only after the real peer has imported its configuration', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeWorkspaceRepo();
          const remote = yield* host.acquireFlockDoc('machine');
          const harness = yield* Effect.acquireRelease(
            Effect.sync(() => wire(new LoroDoc(), { serverFlock: remote.flock })),
            (owned) => Effect.promise(owned.close)
          );
          const repo = yield* Effect.acquireRelease(
            Effect.promise(() => WorkspaceRepoLegacy.create({})),
            (owned) => Effect.promise(() => owned.destroy())
          );
          yield* Effect.promise(() =>
            repo.addTransport(
              'local',
              localWorkspaceTransport({
                workspaceId: 'ws',
                peerId: 'peer-a',
                connection: harness.connection,
              })
            )
          );
          const local = yield* Effect.promise(() => repo.openFlockDoc('machine'));
          const sync = () => repo.syncRoomLegacy({ kind: 'flock', id: 'machine' }, 'local');
          yield* Effect.promise(sync);
          local.flock.set(['agentConfig', 'synthetic'], { command: 'synthetic-agent' });
          local.flock.commit();
          expect((yield* Effect.promise(sync)).outcome).toBe('confirmed');
          expect(remote.flock.get(['agentConfig', 'synthetic'])).toEqual({
            command: 'synthetic-agent',
          });
        })
      )
    );
  });

  it('fails oversized queued input and releases its observers instead of hanging a sync waiter', async () => {
    const remote = new LoroDoc();
    remote.getText('body').insert(0, 'remote state');
    remote.commit();
    const harness = wire(remote);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const repo = yield* makeWorkspaceRepo();
            yield* repo.attachTransport(
              yield* makeLocalWorkspaceTransport('local', {
                workspaceId: 'ws',
                peerId: 'peer-a',
                connection: harness.connection,
                maxQueuedBytes: 16,
              })
            );
            const room = yield* repo.acquireRoom({ kind: 'doc', id: 'session-a' });
            const error = yield* room.sync('local').pipe(Effect.flip);
            expect(error._tag).toBe('RepoSyncFailed');
            expect((yield* room.stateSnapshot('local')).current).toBe(false);
          })
        )
      );
      expect(harness.listeners.size).toBe(0);
      expect(harness.statuses.size).toBe(0);
    } finally {
      await harness.close();
    }
  });
  it('catches up the real document and releases connection observers with its Scope', async () => {
    const remote = new LoroDoc();
    remote.getText('body').insert(0, 'remote');
    remote.commit();
    const harness = wire(remote);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const repo = yield* makeWorkspaceRepo();
            const transport = yield* makeLocalWorkspaceTransport('local', {
              workspaceId: 'ws',
              peerId: 'peer-a',
              connection: harness.connection,
            });
            yield* repo.attachTransport(transport);
            const room = yield* repo.acquireRoom({ kind: 'doc', id: 'session-a' });
            const report = yield* room.sync('local');
            expect(report.outcome).toBe('confirmed');
            expect(report.authority).toBe('peer');
            const lease = yield* repo.acquireDoc('session-a');
            expect(lease.doc.getText('body').toString()).toBe('remote');
            expect((yield* room.stateSnapshot('local')).baseline).toBe(true);
          })
        )
      );
      expect(harness.listeners.size).toBe(0);
      expect(harness.statuses.size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('reconciles a dropped upload before confirming and keeps epoch stable across local edits', async () => {
    const remote = new LoroDoc();
    const harness = wire(remote, { dropFirstUpdate: true });
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const repo = yield* makeWorkspaceRepo();
            const transport = yield* makeLocalWorkspaceTransport('local', {
              workspaceId: 'ws',
              peerId: 'peer-a',
              connection: harness.connection,
            });
            yield* repo.attachTransport(transport);
            const lease = yield* repo.acquireDoc('session-a');
            lease.doc.getText('body').insert(0, 'local');
            lease.doc.commit();
            const room = yield* repo.acquireRoom({ kind: 'doc', id: 'session-a' });
            yield* room.sync('local');
            expect(remote.getText('body').toString()).toBe('local');
            const epoch = (yield* room.stateSnapshot('local')).epoch;
            lease.doc.getText('body').insert(5, ' edit');
            lease.doc.commit();
            // Wait for peer coverage without interpreting a local edit as a reconnect.
            yield* room.sync('local');
            expect(remote.getText('body').toString()).toBe('local edit');
            expect((yield* room.stateSnapshot('local')).epoch).toBe(epoch);
          })
        )
      );
    } finally {
      await harness.close();
    }
  });

  it('does not mistake peer synchronization for required server confirmation', async () => {
    const remote = new LoroDoc();
    const harness = wire(remote);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const repo = yield* makeWorkspaceRepo();
            yield* repo.attachTransport(
              yield* makeLocalWorkspaceTransport('local', {
                workspaceId: 'ws',
                peerId: 'peer-a',
                connection: harness.connection,
              })
            );
            const report = yield* repo.sync({
              scope: 'doc',
              docIds: ['session-a'],
              requireTransports: ['local'],
            });
            expect(report.outcome).toBe('failed');
          })
        )
      );
    } finally {
      await harness.close();
    }
  });
});
