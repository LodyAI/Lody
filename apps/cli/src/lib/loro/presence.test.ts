import { EphemeralStore } from 'loro-crdt';
import { describe, expect, it, vi } from 'vitest';
import {
  LODY_PRESENCE_HEARTBEAT_MS,
  LODY_PRESENCE_TTL_MS,
  parseLodyPresenceStates,
  SessionStatusFactory,
  getServerNow,
  getServerTimeOffset,
  resetTimeSync,
  maintainTimeSync,
  findFreshMachinePresenceState,
  type LodyPresenceInstanceId,
  type LodyPresenceStateMap,
  type MachineId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';

import type { Logger } from '@/utils/logger';
import { PresenceReplica } from './presence-replica';
import { presencePlatformLayer } from '@/platform/presence';
import {
  makeLoroStreamsTokenProvider,
  makeLoroStreamsTokenWebPorts,
  LoroStreamsTokenPorts,
} from '@lody/shared';

const SESSION_ID = '01020304-1111-4222-8333-010203040501' as SessionId;
const MACHINE_ID = '01020304-1111-4222-8333-010203040502' as MachineId;
const REMOTE_SESSION_ID = '01020304-1111-4222-8333-010203040503' as SessionId;
const REMOTE_MACHINE_ID = '01020304-1111-4222-8333-010203040504' as MachineId;
const REMOTE_INSTANCE_ID = '01020304-1111-4222-8333-010203040505' as LodyPresenceInstanceId;
/** Synthetic transport, real CRDT/adaptor/queue. Every pending request has an
 * explicit gate; no network, polling, sleeps or private transport fields. */
const controlledTransport = (autoAck = false) => {
  const encoder = new TextEncoder();
  const empty = new EphemeralStore(LODY_PRESENCE_TTL_MS);
  const bootstrap = empty.encodeAll();
  empty.destroy();
  const toEvent = (event: string, bytes: Uint8Array) =>
    encoder.encode(`event: ${event}\ndata: ${Buffer.from(bytes).toString('base64')}\n\n`);
  let sse: ReadableStreamDefaultController<Uint8Array> | undefined;
  let endRead = () => {};
  const requests: Array<{
    bytes: Uint8Array;
    url: string;
    signal: AbortSignal | null | undefined;
    response: ReturnType<typeof Promise.withResolvers<Response>>;
    finished: ReturnType<typeof Promise.withResolvers<void>>;
  }> = [];
  const arrivals = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.method !== 'POST') {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            sse = controller;
            let open = true;
            endRead = () => {
              if (open) {
                open = false;
                controller.close();
              }
            };
            const endThisRead = endRead;
            controller.enqueue(toEvent('bootstrap', bootstrap));
            init?.signal?.addEventListener('abort', endThisRead, { once: true });
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream', 'Stream-SSE-Data-Encoding': 'base64' } }
      );
    }
    const request = {
      bytes: new Uint8Array(init.body as Uint8Array),
      url: String(input),
      signal: init.signal,
      response: Promise.withResolvers<Response>(),
      finished: Promise.withResolvers<void>(),
    };
    requests.push(request);
    if (autoAck) request.response.resolve(new Response(null, { status: 204 }));
    arrivals.get(requests.length - 1)?.resolve();
    try {
      return await request.response.promise;
    } finally {
      request.finished.resolve();
    }
  };
  return {
    fetch,
    requests,
    endRead: () => endRead(),
    nextPost: async (index: number) => {
      if (!requests[index]) {
        const gate = Promise.withResolvers<void>();
        arrivals.set(index, gate);
        await gate.promise;
      }
      const request = requests[index];
      if (!request) throw new Error('POST gate resolved without request');
      return request;
    },
    receive: (bytes: Uint8Array) => {
      if (!sse) throw new Error('SSE not open');
      sse.enqueue(toEvent('data', bytes));
    },
    releaseAll: async () => {
      for (const request of requests) request.response.resolve(new Response(null, { status: 204 }));
      await Promise.all(requests.map((request) => request.finished.promise));
    },
  };
};

const diagnosticLogger = () => {
  const records: Array<{ level: string; fields: Record<string, unknown> }> = [];
  const joined = Promise.withResolvers<void>();
  const listeners: Array<{ stage: string; gate: ReturnType<typeof Promise.withResolvers<void>> }> =
    [];
  const sink =
    (level: string) =>
    (...args: unknown[]) => {
      const text = String(args[0]);
      if (text.includes('subscription established')) joined.resolve();
      const marker = text.indexOf(' {');
      if (marker < 0) return;
      const fields: Record<string, unknown> = JSON.parse(text.slice(marker + 1));
      records.push({ level, fields });
      for (const listener of listeners)
        if (fields.stage === listener.stage) listener.gate.resolve();
    };
  const logger: Logger = {
    trace: sink('trace'),
    debug: sink('debug'),
    info: sink('info'),
    warn: sink('warn'),
    error: sink('error'),
    success: sink('info'),
    child: () => logger,
    setLevel() {},
    setDebug() {},
    close: async () => {},
  };
  return {
    logger,
    records,
    joined: joined.promise,
    stage: (stage: string) => {
      const gate = Promise.withResolvers<void>();
      if (records.some((record) => record.fields.stage === stage)) gate.resolve();
      else listeners.push({ stage, gate });
      return gate.promise;
    },
  };
};

describe('presence replica and local-origin contracts', () => {
  it('discards invalid IDs throughout publish, heartbeat and clear without wire bytes', () => {
    for (const instance of [
      REMOTE_INSTANCE_ID,
      'private instance /path' as LodyPresenceInstanceId,
    ]) {
      const replica = new PresenceReplica(instance, { minimal: true });
      const wire: Uint8Array[] = [];
      const detach = replica.store.subscribeLocalUpdates((bytes) => wire.push(bytes));
      try {
        replica.setMachineOnline('private machine /path' as MachineId, 100);
        for (const sessionId of [
          'private session /path',
          '1790000000000-privateroadmap',
          '1790000000000-k5zmz7k',
        ]) {
          replica.setSessionPresence(
            {
              sessionId: sessionId as SessionId,
              machineId: MACHINE_ID,
              status: { type: 'running' },
            },
            100
          );
          replica.republish(150);
          replica.clearSessionPresence(sessionId as SessionId);
        }
        replica.republish(200);
        replica.clear();
        expect(replica.getPresenceStates()).toEqual({});
        expect([...replica.encodeLocalOriginPresence()]).toEqual([0]);
        expect(wire).toEqual([]);
      } finally {
        detach();
        replica.destroy();
      }
    }
  });

  it.each([false, true])(
    'filters encrypted presence before both wire exports (minimal=%s)',
    (minimal) => {
      const replica = new PresenceReplica(
        '01020304-1111-4222-8333-010203040506' as LodyPresenceInstanceId,
        { minimal }
      );
      const decoded = new EphemeralStore(LODY_PRESENCE_TTL_MS);
      try {
        replica.setMachineOnline(MACHINE_ID, 100);
        replica.setSessionPresence(
          {
            sessionId: SESSION_ID,
            machineId: MACHINE_ID,
            status: {
              type: 'initializing',
              stage: 'acp',
              detail: 'synthetic private path',
              futureText: 'future secret',
            } as never,
          },
          100
        );
        replica.republish(200);
        decoded.apply(replica.encodeLocalOriginPresence());
        const session = Object.values(decoded.getAllStates()).find(
          (state) =>
            typeof state === 'object' &&
            state !== null &&
            'kind' in state &&
            state.kind === 'session'
        );
        expect(session).toEqual({
          kind: 'session',
          sessionId: SESSION_ID,
          machineId: MACHINE_ID,
          instanceId: '01020304-1111-4222-8333-010203040506',
          updatedAt: 200,
          status: minimal
            ? { type: 'initializing', stage: 'acp' }
            : {
                type: 'initializing',
                stage: 'acp',
                detail: 'synthetic private path',
                futureText: 'future secret',
              },
        });
        expect(replica.store.getAllStates()).toEqual(decoded.getAllStates());
        const peer = new EphemeralStore(LODY_PRESENCE_TTL_MS);
        try {
          peer.set('remote', {
            kind: 'session',
            sessionId: REMOTE_SESSION_ID,
            machineId: REMOTE_MACHINE_ID,
            instanceId: REMOTE_INSTANCE_ID,
            updatedAt: 200,
            status: { type: 'initializing', stage: 'acp', detail: 'remote secret' },
            extraText: 'ignored',
          });
          replica.store.apply(peer.encodeAll());
          expect(replica.getPresenceStates().remote?.kind).toBe('session');
          expect(replica.getPresenceStates().remote).toMatchObject({
            status: minimal
              ? { type: 'initializing', stage: 'acp' }
              : { type: 'initializing', stage: 'acp', detail: 'remote secret' },
          });
          if (minimal)
            expect(replica.getPresenceStates().remote).not.toHaveProperty('status.detail');
        } finally {
          peer.destroy();
        }
      } finally {
        replica.destroy();
        decoded.destroy();
      }
    }
  );

  it('uses machine fallback, excludes remote origins and preserves final session clear', () => {
    const replica = new PresenceReplica('local-replica' as LodyPresenceInstanceId);
    const peer = new PresenceReplica(REMOTE_INSTANCE_ID);
    const snapshots: LodyPresenceStateMap[] = [];
    const detach = replica.subscribeLocalOriginPresence(() => {
      const decoded = new EphemeralStore(LODY_PRESENCE_TTL_MS);
      decoded.apply(replica.encodeLocalOriginPresence());
      snapshots.push(parseLodyPresenceStates(decoded.getAllStates()));
      decoded.destroy();
    });
    try {
      replica.setSessionPresence(
        { sessionId: SESSION_ID, machineId: undefined, status: SessionStatusFactory.running() },
        0
      );
      expect(replica.getPresenceStates()).toEqual({});
      replica.setMachineOnline(MACHINE_ID, 1);
      replica.setSessionPresence(
        { sessionId: SESSION_ID, machineId: undefined, status: SessionStatusFactory.running() },
        2
      );
      peer.setSessionPresence(
        {
          sessionId: REMOTE_SESSION_ID,
          machineId: REMOTE_MACHINE_ID,
          status: SessionStatusFactory.running(),
        },
        2
      );
      const beforePeer = snapshots.length;
      replica.store.apply(peer.store.encodeAll());
      expect(snapshots.length).toBe(beforePeer);
      expect(
        Object.values(replica.getPresenceStates()).some(
          (state) => state.kind === 'session' && state.sessionId === REMOTE_SESSION_ID
        )
      ).toBe(true);
      expect(
        Object.values(snapshots.at(-1) ?? {}).some(
          (state) => state.kind === 'session' && state.sessionId === REMOTE_SESSION_ID
        )
      ).toBe(false);
      replica.setSessionPresence(
        { sessionId: SESSION_ID, machineId: undefined, status: SessionStatusFactory.idle() },
        3
      );
      const cleared = snapshots.at(-1) ?? {};
      expect(
        Object.values(cleared).some(
          (state) => state.kind === 'session' && state.sessionId === SESSION_ID
        )
      ).toBe(false);
      expect(
        Object.values(cleared).some(
          (state) => state.kind === 'machine' && state.machineId === MACHINE_ID
        )
      ).toBe(true);
      replica.setSessionPresence(
        { sessionId: SESSION_ID, machineId: undefined, status: SessionStatusFactory.running() },
        4
      );
      replica.republish(100);
      expect(
        Object.values(replica.getPresenceStates()).find(
          (state) => state.kind === 'session' && state.sessionId === SESSION_ID
        )?.updatedAt
      ).toBe(100);
    } finally {
      detach();
      replica.destroy();
      peer.destroy();
    }
  });
});
// Native owner cases inject capabilities; the integration cases below use the published SDK fetch boundary.
import { it as effectIt } from '@effect/vitest';
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import {
  PresenceHost,
  PresenceTransport,
  PresenceReleaseFailed,
  PresenceUnavailable,
  makeWorkspacePresence,
  type PresenceStream,
  type PresenceStats,
  PresenceDeliveryStalled,
  WorkspacePresenceOwners,
  WorkspacePresenceOwnersLive,
  recoverWorkspacePresenceShutdown,
} from './workspace-presence';

const nativeFixture = Effect.fnUntraced(function* (
  releaseTimeoutMs = 100,
  holdJoinCleanup = false,
  serverOffsetMs: () => number = () => 0
) {
  const clock = yield* Clock.Clock;
  const events: Array<{ stage: string; generation: number; code?: string; ageMs?: number }> = [];
  const rooms: Array<{
    readonly started: Deferred.Deferred<void>;
    readonly bootstrap: Deferred.Deferred<void>;
    readonly closing: Deferred.Deferred<void>;
    readonly released: Deferred.Deferred<void>;
    readonly ack: Deferred.Deferred<void>;
    readonly joinCleanup: Deferred.Deferred<void>;
    readonly cancellingJoin: Deferred.Deferred<void>;
    readonly receiver: EphemeralStore;
    readonly store: EphemeralStore;
    readonly status: (status: string) => void;
    readonly stats: PresenceStats;
    live: boolean;
    joinFailure?: Cause.Cause<unknown>;
    rejoinFailure?: Cause.Cause<unknown>;
    releaseFailure?: Cause.Cause<unknown>;
    retryRelease?: Effect.Effect<void>;
  }> = [];
  const io = Layer.succeed(PresenceTransport, {
    isReleaseFailure: (cause) =>
      cause.reasons.some(
        (reason) => Cause.isFailReason(reason) && reason.error instanceof PresenceReleaseFailed
      ),
    create: (_workspaceId, store) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const bootstrap = yield* Deferred.make<void>();
        const closing = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const ack = yield* Deferred.make<void>();
        const joinCleanup = yield* Deferred.make<void>();
        const cancellingJoin = yield* Deferred.make<void>();
        const receiver = new EphemeralStore(LODY_PRESENCE_TTL_MS);
        let notify: (status: string) => void = () => {};
        const stats = {
          status: 'connecting',
          pendingLocalCount: 1,
          physicalEntries: 1,
          queuedBytes: 64,
          releasePending: 0,
        };
        const room = {
          started,
          bootstrap,
          closing,
          released,
          ack,
          joinCleanup,
          cancellingJoin,
          receiver,
          store,
          stats,
          live: true,
          joinFailure: undefined as Cause.Cause<unknown> | undefined,
          rejoinFailure: undefined as Cause.Cause<unknown> | undefined,
          releaseFailure: undefined as Cause.Cause<unknown> | undefined,
          retryRelease: undefined as Effect.Effect<void> | undefined,
          status: (status: string) => {
            stats.status = status;
            notify(status);
          },
        };
        rooms.push(room);
        yield* Effect.addFinalizer(() => Effect.sync(() => receiver.destroy()));
        const close = Effect.uninterruptible(
          Effect.gen(function* () {
            yield* Deferred.succeed(closing, undefined);
            yield* Deferred.await(released);
            if (room.releaseFailure) return yield* Effect.failCause(room.releaseFailure);
            room.live = false;

            return undefined;
          })
        );
        const stream: PresenceStream = {
          stats,
          close,
          retryRelease: Effect.suspend(() => room.retryRelease ?? close),
          rejoin: Effect.suspend(() =>
            room.rejoinFailure
              ? Effect.failCause(room.rejoinFailure)
              : Effect.sync(() => room.status('joined'))
          ),
          join: ({ onStatusChange }) =>
            Effect.gen(function* () {
              notify = onStatusChange;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(bootstrap).pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit) && holdJoinCleanup
                    ? Effect.uninterruptible(
                        Deferred.succeed(cancellingJoin, undefined).pipe(
                          Effect.andThen(Deferred.await(joinCleanup)),
                          Effect.andThen(
                            Effect.suspend(() =>
                              room.releaseFailure
                                ? Effect.failCause(room.releaseFailure)
                                : Effect.void
                            )
                          )
                        )
                      )
                    : Effect.void
                )
              );
              if (room.joinFailure) return yield* Effect.failCause(room.joinFailure);
              room.status('joined');
              return {
                syncBarrier: () =>
                  Effect.gen(function* () {
                    yield* Deferred.await(ack);
                    receiver.apply(store.encodeAll());
                    stats.pendingLocalCount = 0;

                    return undefined;
                  }),
              };
            }),
        };
        return stream;
      }),
  });
  const host = Layer.succeed(PresenceHost, {
    instanceId: () => REMOTE_INSTANCE_ID,
    serverOffsetMs,
    report: (_workspaceId, event) => {
      events.push(event);
    },
  });
  const owner = yield* makeWorkspacePresence('workspace-native' as WorkspaceId, {
    releaseTimeoutMs,
  }).pipe(Effect.provide(Layer.merge(io, host)));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const room of rooms) {
        room.releaseFailure = undefined;
        Deferred.doneUnsafe(room.released, Effect.void);
        Deferred.doneUnsafe(room.joinCleanup, Effect.void);
      }
    })
  );
  const attachEffect = owner.attach({
    streamsBaseUrl: 'https://synthetic.invalid',
    auth: () => Effect.succeed('synthetic-token'),
  });
  return { owner, attach: attachEffect, rooms, events, io, host, clock };
});

const readyNative = Effect.fnUntraced(function* (
  fixture: Effect.Success<ReturnType<typeof nativeFixture>>
) {
  yield* fixture.attach;
  const room = fixture.rooms[0];
  if (!room) return yield* Effect.die('No native room');
  yield* Deferred.await(room.started);
  yield* Deferred.succeed(room.bootstrap, undefined);
  yield* fixture.owner.waitUntilJoined(1000);
  return room;
});

describe('native workspace presence ownership', () => {
  effectIt.effect(
    'native heartbeats adopt refreshed calibration without replacing the workspace',
    () =>
      Effect.gen(function* () {
        const testClock = yield* TestClock.testClockWith(Effect.succeed);
        const clock = yield* Clock.Clock;
        const epoch = 2_000_000_000_000;
        let error = 120_000;
        const serverNow = () => epoch + clock.currentTimeMillisUnsafe();
        const wall = () => serverNow() + error;
        vi.spyOn(Date, 'now').mockImplementation(wall);
        vi.spyOn(performance, 'now').mockImplementation(
          () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            vi.restoreAllMocks();
            resetTimeSync();
          })
        );
        yield* Effect.gen(function* () {
          const ready = Deferred.makeUnsafe<void>();
          const maintenance = yield* Effect.forkChild(
            maintainTimeSync(async () => serverNow(), {
              onFirstAttempt: Deferred.succeed(ready, undefined),
            })
          );
          yield* Deferred.await(ready);
          const fixture = yield* nativeFixture(100, false, getServerTimeOffset);
          fixture.owner.replica.setMachineOnline(MACHINE_ID, getServerNow());
          error = 0;
          yield* testClock.adjust(LODY_PRESENCE_HEARTBEAT_MS * 2);
          const state = findFreshMachinePresenceState(
            fixture.owner.replica.getPresenceStates(),
            MACHINE_ID,
            serverNow()
          );
          expect(state?.updatedAt).toBe(serverNow());
          yield* Fiber.interrupt(maintenance);
          yield* fixture.owner.stop;
        }).pipe(
          Effect.provideService(Clock.Clock, {
            currentTimeMillisUnsafe: wall,
            currentTimeMillis: Effect.sync(wall),
            currentTimeNanosUnsafe: () => BigInt(wall()) * 1_000_000n,
            currentTimeNanos: Effect.sync(() => BigInt(wall()) * 1_000_000n),
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            monotonicTimeNanos: clock.monotonicTimeNanos,
            sleep: (duration) => clock.sleep(duration),
          })
        );
      })
  );

  effectIt.effect(
    'workspace stop retains token I/O ownership and recovers after actual settlement',
    () =>
      Effect.gen(function* () {
        const fixture = yield* nativeFixture(500);
        const response = Promise.withResolvers<Response>();
        const started = Deferred.makeUnsafe<void>();
        const aborted = Deferred.makeUnsafe<void>();
        const provider = yield* fixture.owner.createTokenProvider(
          makeLoroStreamsTokenProvider({
            endpoint: 'https://synthetic.invalid/token',
            workspaceId: 'workspace-native',
            cleanupTimeoutMs: 50,
          }).pipe(
            Effect.provideService(
              LoroStreamsTokenPorts,
              makeLoroStreamsTokenWebPorts({
                credential: Effect.succeed('synthetic-credential'),
                cleanupTimeoutMs: 50,
                fetchImpl: (_url, init) => {
                  init?.signal?.addEventListener(
                    'abort',
                    () => Deferred.doneUnsafe(aborted, Effect.void),
                    { once: true }
                  );
                  Deferred.doneUnsafe(started, Effect.void);
                  return response.promise;
                },
              })
            )
          )
        );
        const reader = yield* Effect.forkChild(provider.getToken().pipe(Effect.exit));
        yield* Deferred.await(started);
        const stopping = yield* Effect.forkChild(fixture.owner.stop.pipe(Effect.exit));
        yield* Deferred.await(aborted);
        yield* TestClock.adjust(500);
        expect(Exit.isFailure(yield* Fiber.join(stopping))).toBe(true);
        expect(fixture.owner.isReleased()).toBe(false);
        expect((yield* provider.health).pendingRawWork).toBe(true);
        response.resolve(new Response(JSON.stringify({ token: 'late-token', expiresIn: 900 })));
        yield* fixture.owner.retryCleanup;
        expect(fixture.owner.isReleased()).toBe(true);
        expect((yield* provider.health).pendingRawWork).toBe(false);
        expect(Exit.isFailure(yield* Fiber.join(reader))).toBe(true);
      })
  );

  effectIt.effect('keeps origin partition and local heartbeat after cloud revoke', () =>
    Effect.gen(function* () {
      const fixture = yield* nativeFixture();
      const room = yield* readyNative(fixture);
      const { owner } = fixture;
      owner.replica.setMachineOnline(MACHINE_ID, 10);
      const peer = new EphemeralStore(LODY_PRESENCE_TTL_MS);
      peer.set('synthetic-peer', {
        kind: 'machine',
        machineId: REMOTE_MACHINE_ID,
        instanceId: REMOTE_INSTANCE_ID,
        updatedAt: 10,
      });
      room.store.apply(peer.encodeAll());
      peer.destroy();
      const local = new EphemeralStore(LODY_PRESENCE_TTL_MS);
      local.apply(owner.replica.encodeLocalOriginPresence());
      expect(
        Object.values(parseLodyPresenceStates(local.getAllStates())).some(
          (s) => s.kind === 'machine' && s.machineId === REMOTE_MACHINE_ID
        )
      ).toBe(false);
      local.destroy();
      expect(
        Object.values(owner.replica.getPresenceStates()).some(
          (s) => s.kind === 'machine' && s.machineId === REMOTE_MACHINE_ID
        )
      ).toBe(true);
      yield* Deferred.succeed(room.released, undefined);
      yield* owner.detach;
      yield* TestClock.adjust(LODY_PRESENCE_HEARTBEAT_MS);
      const state = Object.values(owner.replica.getPresenceStates()).find(
        (s) => s.kind === 'machine' && s.machineId === MACHINE_ID
      );
      expect(state?.updatedAt).toBe(LODY_PRESENCE_HEARTBEAT_MS);
      expect(room.live).toBe(false);
      yield* owner.stop;

      return undefined;
    })
  );

  effectIt.effect('cancelled/timed-out readiness waiters leave the shared join usable', () =>
    Effect.gen(function* () {
      const fixture = yield* nativeFixture();
      yield* fixture.attach;
      const room = fixture.rooms[0];
      if (!room) return yield* Effect.die('No room');
      yield* Deferred.await(room.started);
      const cancelled = yield* Effect.forkChild(fixture.owner.waitUntilJoined(1000));
      const timed = yield* Effect.forkChild(fixture.owner.waitUntilJoined(10).pipe(Effect.exit));
      yield* Fiber.interrupt(cancelled);
      yield* TestClock.adjust(10);
      const expired = yield* Fiber.join(timed);
      expect(Exit.isFailure(expired)).toBe(true);
      expect(room.live).toBe(true);
      yield* Deferred.succeed(room.bootstrap, undefined);
      yield* fixture.owner.waitUntilJoined(1000);
      yield* Deferred.succeed(room.released, undefined);
      yield* fixture.owner.stop;

      return undefined;
    })
  );

  effectIt.effect(
    'concurrent stop joins cleanup and rejects replacement until actual completion',
    () =>
      Effect.gen(function* () {
        const fixture = yield* nativeFixture();
        const room = yield* readyNative(fixture);
        const first = yield* Effect.forkChild(fixture.owner.stop.pipe(Effect.exit));
        yield* Deferred.await(room.closing);
        const secondEntered = yield* Deferred.make<void>();
        const second = yield* Effect.forkChild(
          Deferred.succeed(secondEntered, undefined).pipe(
            Effect.andThen(fixture.owner.stop.pipe(Effect.exit))
          )
        );
        yield* Deferred.await(secondEntered);
        yield* Effect.yieldNow;
        expect(second.pollUnsafe()).toBeUndefined();
        const replacement = yield* fixture.attach.pipe(Effect.exit);
        expect(Exit.isFailure(replacement)).toBe(true);
        yield* Deferred.succeed(room.released, undefined);
        expect(Exit.isSuccess(yield* Fiber.join(first))).toBe(true);
        expect(Exit.isSuccess(yield* Fiber.join(second))).toBe(true);
        expect(fixture.owner.isReleased()).toBe(true);
        expect(room.live).toBe(false);

        return undefined;
      })
  );

  effectIt.effect(
    'bounded cleanup retains owner, blocks a new generation, and permits awaited recovery',
    () =>
      Effect.gen(function* () {
        const fixture = yield* nativeFixture();
        const room = yield* readyNative(fixture);
        const close = yield* Effect.forkChild(fixture.owner.detach.pipe(Effect.exit));
        yield* Deferred.await(room.closing);
        yield* TestClock.adjust(100);
        const failed = yield* Fiber.join(close);
        expect(Exit.isFailure(failed)).toBe(true);
        if (Exit.isFailure(failed)) {
          const error = failed.cause.reasons.find(Cause.isFailReason)?.error;
          expect(error).toBeInstanceOf(PresenceReleaseFailed);
          expect(error instanceof PresenceReleaseFailed && error.owner).toBe(fixture.owner);
        }
        expect(room.live).toBe(true);
        expect(Exit.isFailure(yield* fixture.attach.pipe(Effect.exit))).toBe(true);
        yield* Deferred.succeed(room.released, undefined);
        yield* fixture.owner.retryCleanup;
        expect(room.live).toBe(false);
        yield* fixture.attach;
        const next = fixture.rooms[1];
        if (!next) return yield* Effect.die('No replacement');
        yield* Deferred.succeed(next.released, undefined);
        yield* fixture.owner.stop;

        return undefined;
      })
  );

  effectIt.effect('retains simultaneous typed and release defect Causes', () =>
    Effect.gen(function* () {
      const fixture = yield* nativeFixture();
      const room = yield* readyNative(fixture);
      const body = new Error('synthetic-body');
      const release = new Error('synthetic-release');
      room.releaseFailure = Cause.combine(Cause.fail(body), Cause.die(release));
      yield* Deferred.succeed(room.released, undefined);
      const stopped = yield* fixture.owner.stop.pipe(Effect.exit);
      expect(Exit.isFailure(stopped)).toBe(true);
      expect(
        fixture.owner.failure().reasons.some((r) => Cause.isFailReason(r) && r.error === body)
      ).toBe(true);
      expect(
        fixture.owner.failure().reasons.some((r) => Cause.isDieReason(r) && r.defect === release)
      ).toBe(true);
      expect(fixture.owner.isReleased()).toBe(false);
      room.releaseFailure = undefined;
      yield* fixture.owner.retryCleanup;
      expect(fixture.owner.isReleased()).toBe(true);

      return undefined;
    })
  );

  effectIt.effect(
    'ignores old generation callbacks and republishes current local state on rejoin',
    () =>
      Effect.gen(function* () {
        const fixture = yield* nativeFixture();
        const room = yield* readyNative(fixture);
        fixture.owner.replica.setMachineOnline(MACHINE_ID, 10);
        yield* Deferred.succeed(room.released, undefined);
        yield* fixture.owner.detach;
        yield* fixture.attach;
        const next = fixture.rooms[1];
        if (!next) return yield* Effect.die('No replacement');
        room.status('joined');
        const before = yield* Effect.forkChild(fixture.owner.waitUntilJoined(1).pipe(Effect.exit));
        yield* TestClock.adjust(1);
        expect(Exit.isFailure(yield* Fiber.join(before))).toBe(true);
        fixture.owner.replica.setSessionPresence(
          {
            sessionId: SESSION_ID,
            machineId: MACHINE_ID,
            status: SessionStatusFactory.initializing(),
          },
          1
        );
        yield* Deferred.succeed(next.bootstrap, undefined);
        yield* fixture.owner.waitUntilJoined(1000);
        yield* TestClock.adjust(LODY_PRESENCE_HEARTBEAT_MS);
        yield* Deferred.succeed(next.ack, undefined);
        // Observing a receiver is stronger than asserting the transport was called.
        yield* Effect.yieldNow;
        const received = parseLodyPresenceStates(next.receiver.getAllStates());
        expect(
          Object.values(received).some((s) => s.kind === 'session' && s.sessionId === SESSION_ID)
        ).toBe(true);
        yield* Deferred.succeed(next.released, undefined);
        yield* fixture.owner.stop;

        return undefined;
      })
  );

  effectIt.effect(
    'healthy reads with a held upload report bounded no-progress health without a reconnect storm',
    () =>
      Effect.gen(function* () {
        const fixture = yield* nativeFixture();
        const room = yield* readyNative(fixture);
        fixture.owner.replica.setMachineOnline(MACHINE_ID, 0);
        yield* TestClock.adjust(LODY_PRESENCE_TTL_MS * 2);
        expect(room.stats.status).toBe('joined');
        expect(room.receiver.getAllStates()).toEqual({});
        expect(fixture.events.filter((e) => e.stage === 'stall').map((e) => e.code)).toEqual([
          'upload_no_progress',
        ]);
        expect(fixture.events.filter((e) => e.stage === 'retry')).toEqual([]);
        expect(fixture.owner.deliveryHealth()).toBeInstanceOf(PresenceDeliveryStalled);
        yield* Deferred.succeed(room.ack, undefined);
        yield* TestClock.adjust(LODY_PRESENCE_HEARTBEAT_MS);
        expect(fixture.owner.deliveryHealth()).toBe('idle');
        expect(
          Object.values(parseLodyPresenceStates(room.receiver.getAllStates())).some(
            (state) => state.kind === 'machine' && state.machineId === MACHINE_ID
          )
        ).toBe(true);
        yield* Deferred.succeed(room.released, undefined);
        yield* fixture.owner.stop;

        return undefined;
      })
  );
});

effectIt.effect(
  'cancellation waits for join finalizers and preserves their late complete Cause',
  () =>
    Effect.gen(function* () {
      const fixture = yield* nativeFixture(100, true);
      yield* fixture.attach;
      const room = fixture.rooms[0];
      if (!room) return yield* Effect.die('No room');
      yield* Deferred.await(room.started);
      const closing = yield* Effect.forkChild(fixture.owner.detach.pipe(Effect.exit));
      yield* Deferred.await(room.closing);
      yield* Deferred.await(room.cancellingJoin);
      yield* Deferred.succeed(room.released, undefined);
      yield* TestClock.adjust(100);
      expect(Exit.isFailure(yield* Fiber.join(closing))).toBe(true);
      expect(Exit.isFailure(yield* fixture.attach.pipe(Effect.exit))).toBe(true);
      const body = new Error('synthetic-late-body');
      const defect = new Error('synthetic-late-release');
      room.releaseFailure = Cause.combine(Cause.fail(body), Cause.die(defect));
      yield* Deferred.succeed(room.joinCleanup, undefined);
      yield* fixture.owner.retryCleanup;
      expect(
        fixture.owner.failure().reasons.some((r) => Cause.isFailReason(r) && r.error === body)
      ).toBe(true);
      expect(
        fixture.owner.failure().reasons.some((r) => Cause.isDieReason(r) && r.defect === defect)
      ).toBe(true);
      yield* fixture.owner.stop;

      return undefined;
    })
);

import { makeApplicationRuntime } from '@lody/shared/node/application-runtime';
import {
  bindWorkspacePresenceApplicationLegacy,
  createCliPresenceRuntimeLegacy,
  WorkspacePresenceLegacyFailure,
  recoverCliPresenceApplicationShutdown,
} from './presence-legacy';

effectIt.effect(
  'the explicit Legacy consumer uses the application owner and awaits its shared stop',
  () =>
    Effect.gen(function* () {
      const fixture = yield* nativeFixture();
      const application = makeApplicationRuntime(
        WorkspacePresenceOwnersLive.pipe(EffectLayerDependencies(fixture)),
        {
          recover: (cause) => Effect.failCause(cause),
          project: (cause) => new WorkspacePresenceLegacyFailure(cause),
        }
      );
      bindWorkspacePresenceApplicationLegacy(application);
      const consumer = yield* Effect.promise(() =>
        createCliPresenceRuntimeLegacy('workspace-legacy' as WorkspaceId)
      );
      consumer.setMachineOnline(MACHINE_ID);
      yield* Effect.promise(() =>
        consumer.attachStreams({
          streamsBaseUrl: 'https://synthetic.invalid',
          auth: () => Effect.succeed('synthetic-token'),
        })
      );
      const room = fixture.rooms[0];
      if (!room) return yield* Effect.die('No Legacy room');
      yield* Deferred.await(room.started);
      yield* Deferred.succeed(room.bootstrap, undefined);
      expect(yield* Effect.promise(() => consumer.waitUntilJoined(1000))).toBe(true);
      consumer.setMachineOnline(MACHINE_ID);
      yield* TestClock.adjust(LODY_PRESENCE_HEARTBEAT_MS);
      expect(
        Object.values(consumer.getPresenceStates()).find((state) => state.kind === 'machine')
          ?.updatedAt
      ).toBe(LODY_PRESENCE_HEARTBEAT_MS);
      const first = yield* Effect.forkChild(Effect.promise(() => consumer.stop()));
      yield* Deferred.await(room.closing);
      const second = yield* Effect.forkChild(Effect.promise(() => consumer.stop()));
      expect(second.pollUnsafe()).toBeUndefined();
      consumer.setMachineOnline(REMOTE_MACHINE_ID);
      expect(
        Object.values(consumer.getPresenceStates()).some(
          (s) => s.kind === 'machine' && s.machineId === REMOTE_MACHINE_ID
        )
      ).toBe(false);
      yield* Deferred.succeed(room.released, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(room.live).toBe(false);
      yield* Effect.promise(() => application.closeLegacy());
      expect(application.isReleased()).toBe(true);

      return undefined;
    })
);

function EffectLayerDependencies(fixture: Effect.Success<ReturnType<typeof nativeFixture>>) {
  const clock = Layer.succeed(Clock.Clock, fixture.clock);
  return (layer: typeof WorkspacePresenceOwnersLive) =>
    Layer.merge(layer.pipe(Layer.provide(Layer.mergeAll(fixture.io, fixture.host, clock))), clock);
}

effectIt.effect('application disposal stops active workspaces before reporting release', () =>
  Effect.gen(function* () {
    const fixture = yield* nativeFixture();
    const application = makeApplicationRuntime(
      WorkspacePresenceOwnersLive.pipe(EffectLayerDependencies(fixture)),
      {
        recover: (cause) => Effect.failCause(cause),
        project: (cause) => new WorkspacePresenceLegacyFailure(cause),
      }
    );
    bindWorkspacePresenceApplicationLegacy(application);
    const consumer = yield* Effect.promise(() =>
      createCliPresenceRuntimeLegacy('workspace-application-close' as WorkspaceId)
    );
    yield* Effect.promise(() =>
      consumer.attachStreams({
        streamsBaseUrl: 'https://synthetic.invalid',
        auth: () => Effect.succeed('synthetic-token'),
      })
    );
    const room = fixture.rooms[0];
    if (!room) return yield* Effect.die('No application room');
    yield* Deferred.await(room.started);
    yield* Deferred.succeed(room.bootstrap, undefined);
    expect(yield* Effect.promise(() => consumer.waitUntilJoined(1000))).toBe(true);
    const closing = yield* Effect.forkChild(Effect.promise(() => application.closeLegacy()));
    yield* Deferred.await(room.closing);
    expect(application.isClosing()).toBe(true);
    expect(application.isReleased()).toBe(false);
    const refused = yield* Effect.tryPromise(() =>
      createCliPresenceRuntimeLegacy('new-workspace' as WorkspaceId)
    ).pipe(Effect.exit);
    expect(Exit.isFailure(refused)).toBe(true);
    yield* Deferred.succeed(room.released, undefined);
    yield* Fiber.join(closing);
    expect(room.live).toBe(false);
    expect(application.isReleased()).toBe(true);
    return undefined;
  })
);

effectIt.effect(
  'failed application disposal keeps workspace recovery owners after the runtime closes',
  () =>
    Effect.gen(function* () {
      const fixture = yield* nativeFixture();
      const application = makeApplicationRuntime(
        WorkspacePresenceOwnersLive.pipe(EffectLayerDependencies(fixture)),
        {
          recover: recoverWorkspacePresenceShutdown,
          project: (cause) => new WorkspacePresenceLegacyFailure(cause),
        }
      );
      bindWorkspacePresenceApplicationLegacy(application);
      const consumer = yield* Effect.promise(() =>
        createCliPresenceRuntimeLegacy('workspace-failed-application-close' as WorkspaceId)
      );
      yield* Effect.promise(() =>
        consumer.attachStreams({
          streamsBaseUrl: 'https://synthetic.invalid',
          auth: () => Effect.succeed('synthetic-token'),
        })
      );
      const room = fixture.rooms[0];
      if (!room) return yield* Effect.die('No recovery room');
      yield* Deferred.await(room.started);
      yield* Deferred.succeed(room.bootstrap, undefined);
      expect(yield* Effect.promise(() => consumer.waitUntilJoined(1000))).toBe(true);
      const releaseFailure = new Error('synthetic-application-release');
      room.releaseFailure = Cause.die(releaseFailure);
      yield* Deferred.succeed(room.released, undefined);
      const failed = yield* Effect.tryPromise(() => application.closeLegacy()).pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      expect(room.live).toBe(true);
      expect(application.isReleased()).toBe(false);
      const again = yield* Effect.tryPromise(() => application.closeLegacy()).pipe(Effect.exit);
      expect(Exit.isFailure(again)).toBe(true);
      room.releaseFailure = undefined;
      yield* Effect.promise(() => application.closeLegacy());
      expect(room.live).toBe(false);
      expect(application.isReleased()).toBe(true);
      return undefined;
    })
);

effectIt.effect('a failed release never blocks its workspace; a live duplicate stays refused', () =>
  Effect.gen(function* () {
    const fixture = yield* nativeFixture();
    const clock = Layer.succeed(Clock.Clock, fixture.clock);
    const owners = Context.get(
      yield* Layer.build(
        WorkspacePresenceOwnersLive.pipe(
          Layer.provide(Layer.mergeAll(fixture.io, fixture.host, clock))
        )
      ),
      WorkspacePresenceOwners
    );
    const workspaceId = 'workspace-replaced' as WorkspaceId;
    const first = yield* owners.create(workspaceId);
    yield* first.attach({
      streamsBaseUrl: 'https://synthetic.invalid',
      auth: () => Effect.succeed('synthetic-token'),
    });
    const room = fixture.rooms[0];
    if (!room) return yield* Effect.die('No registry room');
    yield* Deferred.await(room.started);
    yield* Deferred.succeed(room.bootstrap, undefined);
    yield* first.waitUntilJoined(1000);
    const duplicate = yield* owners.create(workspaceId).pipe(Effect.exit);
    expect(Exit.isFailure(duplicate)).toBe(true);

    room.releaseFailure = Cause.die(new Error('synthetic-release-timeout'));
    yield* Deferred.succeed(room.released, undefined);
    expect(Exit.isFailure(yield* first.stop.pipe(Effect.exit))).toBe(true);
    expect(first.isReleased()).toBe(false);

    const firstRetry = yield* Deferred.make<void>();
    room.releaseFailure = undefined;
    room.retryRelease = Deferred.succeed(firstRetry, undefined).pipe(
      Effect.andThen(Effect.die(new Error('synthetic-retry-timeout')))
    );
    const replacement = yield* owners.create(workspaceId);
    expect(replacement).not.toBe(first);
    // The retired owner is recovered in the background, not by blocking the workspace.
    yield* Deferred.await(firstRetry);
    expect(Exit.isFailure(yield* first.stop.pipe(Effect.exit))).toBe(true);
    expect(first.isReleased()).toBe(false);

    const secondRetry = yield* Deferred.make<void>();
    room.retryRelease = Deferred.succeed(secondRetry, undefined).pipe(
      Effect.andThen(Effect.sync(() => (room.live = false)))
    );
    // A failed retry is not the last one: a later acquisition retries again.
    yield* owners.create('workspace-other' as WorkspaceId);
    yield* Deferred.await(secondRetry);
    yield* first.stop;
    expect(first.isReleased()).toBe(true);
    expect(room.live).toBe(false);
    return undefined;
  })
);

effectIt.effect('a replacement waits for an in-flight release instead of overlapping it', () =>
  Effect.gen(function* () {
    const fixture = yield* nativeFixture();
    const clock = Layer.succeed(Clock.Clock, fixture.clock);
    const owners = Context.get(
      yield* Layer.build(
        WorkspacePresenceOwnersLive.pipe(
          Layer.provide(Layer.mergeAll(fixture.io, fixture.host, clock))
        )
      ),
      WorkspacePresenceOwners
    );
    const workspaceId = 'workspace-handoff' as WorkspaceId;
    const first = yield* owners.create(workspaceId);
    yield* first.attach({
      streamsBaseUrl: 'https://synthetic.invalid',
      auth: () => Effect.succeed('synthetic-token'),
    });
    const room = fixture.rooms[0];
    if (!room) return yield* Effect.die('No handoff room');
    yield* Deferred.await(room.started);
    yield* Deferred.succeed(room.bootstrap, undefined);
    yield* first.waitUntilJoined(1000);
    const stopping = yield* Effect.forkChild(first.stop);
    yield* Deferred.await(room.closing);
    const replacing = yield* Effect.forkChild(
      owners.create(workspaceId).pipe(Effect.map(() => room.live))
    );
    yield* Deferred.succeed(room.released, undefined);
    // The old stream had finished releasing when the replacement was admitted.
    expect(yield* Fiber.join(replacing)).toBe(false);
    yield* Fiber.join(stopping);
    expect(first.isReleased()).toBe(true);
    return undefined;
  })
);

effectIt.effect('bootstrap readiness becomes unknown during recovery and flap backoff grows', () =>
  Effect.gen(function* () {
    const fixture = yield* nativeFixture();
    const room = yield* readyNative(fixture);
    fixture.owner.replica.setMachineOnline(MACHINE_ID, 0);
    room.status('disconnected');
    const firstUnknown = yield* Effect.forkChild(
      fixture.owner.waitUntilJoined(1000).pipe(Effect.exit)
    );
    yield* TestClock.adjust(1000);
    expect(Exit.isFailure(yield* Fiber.join(firstUnknown))).toBe(true);
    yield* TestClock.adjust(1000);
    yield* fixture.owner.waitUntilJoined(1000);
    const first = Object.values(fixture.owner.replica.getPresenceStates()).find(
      (s) => s.kind === 'machine'
    );
    expect(first?.updatedAt).toBe(2000);
    room.status('disconnected');
    const secondUnknown = yield* Effect.forkChild(
      fixture.owner.waitUntilJoined(4000).pipe(Effect.exit)
    );
    yield* TestClock.adjust(4000);
    expect(Exit.isFailure(yield* Fiber.join(secondUnknown))).toBe(true);
    yield* TestClock.adjust(1000);
    yield* fixture.owner.waitUntilJoined(1000);
    const latest = Object.values(fixture.owner.replica.getPresenceStates()).find(
      (s) => s.kind === 'machine'
    );
    expect(latest?.updatedAt).toBe(7000);
    yield* Deferred.succeed(room.released, undefined);
    yield* fixture.owner.stop;
    return undefined;
  })
);

effectIt.effect(
  'hung first bootstrap gives unknown readiness and one bounded diagnostic without overlapping joins',
  () =>
    Effect.gen(function* () {
      const fixture = yield* nativeFixture();
      yield* fixture.attach;
      const room = fixture.rooms[0];
      if (!room) return yield* Effect.die('No bootstrap room');
      yield* Deferred.await(room.started);
      const reader = yield* Effect.forkChild(
        fixture.owner.waitUntilJoined(10_000).pipe(Effect.exit)
      );
      yield* TestClock.adjust(10_000);
      const unknown = yield* Fiber.join(reader);
      expect(Exit.isFailure(unknown)).toBe(true);
      expect(
        fixture.owner
          .failure()
          .reasons.some(
            (reason) =>
              Cause.isFailReason(reason) &&
              reason.error instanceof PresenceUnavailable &&
              reason.error.stage === 'bootstrap'
          )
      ).toBe(true);
      yield* TestClock.adjust(20_000);
      expect(
        fixture.events.filter((event) => event.code === 'first_join_no_bootstrap')
      ).toHaveLength(1);
      expect(fixture.rooms).toHaveLength(1);
      expect(room.live).toBe(true);
      yield* Deferred.succeed(room.bootstrap, undefined);
      yield* fixture.owner.waitUntilJoined(1000);
      yield* Deferred.succeed(room.released, undefined);
      yield* fixture.owner.stop;
      return undefined;
    })
);

effectIt.effect('typed transport release failure blocks rejoin even with no pending raw I/O', () =>
  Effect.gen(function* () {
    const fixture = yield* nativeFixture();
    yield* fixture.attach;
    const room = fixture.rooms[0];
    if (!room) return yield* Effect.die('No typed release room');
    yield* Deferred.await(room.started);
    const cause = Cause.fail(new Error('synthetic-release-failure'));
    room.joinFailure = Cause.fail(
      new PresenceReleaseFailed({ cause, owner: fixture.owner, generation: 1 })
    );
    expect(room.stats.releasePending).toBe(0);
    yield* Deferred.succeed(room.bootstrap, undefined);
    const unavailable = yield* fixture.owner.waitUntilJoined(1000).pipe(Effect.exit);
    expect(Exit.isFailure(unavailable)).toBe(true);
    yield* TestClock.adjust(60_000);
    const refused = yield* fixture.attach.pipe(Effect.exit);
    expect(Exit.isFailure(refused)).toBe(true);
    expect(
      fixture.owner
        .failure()
        .reasons.some(
          (reason) => Cause.isFailReason(reason) && reason.error instanceof PresenceReleaseFailed
        )
    ).toBe(true);
    expect(fixture.events.some((event) => event.stage === 'joined')).toBe(false);
    yield* Deferred.succeed(room.released, undefined);
    yield* fixture.owner.stop;
    return undefined;
  })
);

effectIt.effect('failed rejoin retains a release owner and stops retry admission', () =>
  Effect.gen(function* () {
    const fixture = yield* nativeFixture();
    const room = yield* readyNative(fixture);
    room.rejoinFailure = Cause.fail(
      new PresenceReleaseFailed({
        cause: Cause.fail(new Error('synthetic-rejoin-release')),
        owner: fixture.owner,
        generation: 1,
      })
    );
    room.status('disconnected');
    yield* TestClock.adjust(2000);
    const unavailable = yield* fixture.owner.waitUntilJoined(1000).pipe(Effect.exit);
    expect(Exit.isFailure(unavailable)).toBe(true);
    expect(
      fixture.owner
        .failure()
        .reasons.some(
          (reason) => Cause.isFailReason(reason) && reason.error instanceof PresenceReleaseFailed
        )
    ).toBe(true);
    yield* TestClock.adjust(60_000);
    expect(room.stats.status).toBe('disconnected');
    expect(fixture.events.some((event) => event.code === 'rejoin_failed')).toBe(false);
    const refused = yield* fixture.attach.pipe(Effect.exit);
    expect(Exit.isFailure(refused)).toBe(true);
    yield* Deferred.succeed(room.released, undefined);
    yield* fixture.owner.stop;
    return undefined;
  })
);

effectIt.effect(
  'retirement callback failure fences writes, closes I/O and transfers a recoverable full Cause',
  () =>
    Effect.gen(function* () {
      const fixture = yield* nativeFixture();
      const room = yield* readyNative(fixture);
      fixture.owner.replica.setMachineOnline(MACHINE_ID, 0);
      fixture.owner.replica.setSessionPresence(
        {
          sessionId: SESSION_ID,
          machineId: MACHINE_ID,
          status: SessionStatusFactory.initializing(),
        },
        0
      );
      const defect = new Error('synthetic-retirement-callback');
      const unsubscribe = fixture.owner.replica.subscribeLocalOriginPresence(() => {
        throw defect;
      });
      yield* Deferred.succeed(room.released, undefined);
      const failed = yield* fixture.owner.stop.pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      if (Exit.isFailure(failed)) {
        const error = failed.cause.reasons.find(Cause.isFailReason)?.error;
        expect(error instanceof PresenceReleaseFailed && error.owner).toBe(fixture.owner);
      }
      expect(room.live).toBe(false);
      expect(fixture.owner.isReleased()).toBe(false);
      fixture.owner.replica.setMachineOnline(REMOTE_MACHINE_ID, 1);
      expect(
        Object.values(fixture.owner.replica.getPresenceStates()).some(
          (state) => state.kind === 'machine' && state.machineId === REMOTE_MACHINE_ID
        )
      ).toBe(false);
      unsubscribe();
      yield* fixture.owner.retryCleanup;
      expect(fixture.owner.isReleased()).toBe(true);
      expect(fixture.owner.replica.getPresenceStates()).toEqual({});
      expect(
        fixture.owner
          .failure()
          .reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect)
      ).toBe(true);
      return undefined;
    })
);

effectIt.effect(
  'failed heartbeat keeps its Cause and recovery waits for actual lower cleanup',
  () =>
    Effect.gen(function* () {
      const fixture = yield* nativeFixture();
      const room = yield* readyNative(fixture);
      fixture.owner.replica.setMachineOnline(MACHINE_ID, 0);
      const defect = new Error('synthetic-heartbeat-callback');
      const unsubscribe = fixture.owner.replica.subscribeLocalOriginPresence(() => {
        throw defect;
      });
      yield* TestClock.adjust(LODY_PRESENCE_HEARTBEAT_MS);
      unsubscribe();
      yield* Deferred.succeed(room.released, undefined);
      const failed = yield* fixture.owner.stop.pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      expect(room.live).toBe(false);
      expect(fixture.owner.isReleased()).toBe(false);
      yield* fixture.owner.retryCleanup;
      expect(fixture.owner.isReleased()).toBe(true);
      expect(
        fixture.owner
          .failure()
          .reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect)
      ).toBe(true);
      return undefined;
    })
);

effectIt.effect('uses the existing SDK wire and authorized bucket for minimal presence', () =>
  Effect.gen(function* () {
    const wire = controlledTransport(true);
    const owner = yield* makeWorkspacePresence('integration-workspace' as WorkspaceId, {
      minimal: true,
    }).pipe(Effect.provide(presencePlatformLayer(diagnosticLogger().logger, wire.fetch)));
    yield* owner.attach({
      streamsBaseUrl: 'https://synthetic.invalid',
      bucketId: 'protected-bucket',
      auth: () => Effect.succeed(undefined),
    });
    yield* owner.waitUntilJoined(1000);
    owner.replica.setSessionPresence(
      {
        sessionId: SESSION_ID,
        machineId: MACHINE_ID,
        status: { type: 'initializing', stage: 'acp', detail: 'synthetic private detail' },
      },
      100
    );
    const post = yield* Effect.promise(() => wire.nextPost(0));
    expect(post.url).toContain('/protected-bucket/');
    expect(new URL(post.url).searchParams.get('ephemeral')).toBe('presence');
    const server = new EphemeralStore(LODY_PRESENCE_TTL_MS);
    const lateJoin = new EphemeralStore(LODY_PRESENCE_TTL_MS);
    try {
      server.apply(post.bytes);
      lateJoin.apply(server.encodeAll());
      expect(Object.values(lateJoin.getAllStates())).toEqual([
        {
          kind: 'session',
          sessionId: SESSION_ID,
          machineId: MACHINE_ID,
          instanceId: expect.any(String),
          updatedAt: 100,
          status: { type: 'initializing', stage: 'acp' },
        },
      ]);
      const received = Promise.withResolvers<void>();
      const unsubscribe = owner.replica.subscribe((states) => {
        if (states.remote) received.resolve();
      });
      server.set('remote', {
        kind: 'session',
        sessionId: REMOTE_SESSION_ID,
        machineId: REMOTE_MACHINE_ID,
        instanceId: REMOTE_INSTANCE_ID,
        updatedAt: 100,
        status: { type: 'initializing', stage: 'acp', detail: 'remote secret' },
        unknownText: 'ignored',
      });
      wire.receive(server.encode('remote'));
      yield* Effect.promise(() => received.promise);
      unsubscribe();
      expect(owner.replica.getPresenceStates().remote).toEqual({
        kind: 'session',
        sessionId: REMOTE_SESSION_ID,
        machineId: REMOTE_MACHINE_ID,
        instanceId: REMOTE_INSTANCE_ID,
        updatedAt: 100,
        status: { type: 'initializing', stage: 'acp' },
      });
    } finally {
      server.destroy();
      lateJoin.destroy();
    }
    yield* owner.stop;
  })
);

effectIt.effect(
  'published SDK adapter aborts I/O, retains ignored POST settlement, and recovers',
  () =>
    Effect.gen(function* () {
      const wire = controlledTransport(false);
      const layer = presencePlatformLayer(diagnosticLogger().logger, wire.fetch);
      const owner = yield* makeWorkspacePresence('integration-workspace' as WorkspaceId, {
        releaseTimeoutMs: 200,
      }).pipe(Effect.provide(layer));
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => wire.releaseAll()).pipe(Effect.andThen(owner.retryCleanup))
      );
      yield* owner.attach({
        streamsBaseUrl: 'https://synthetic.invalid',
        auth: () => Effect.succeed(undefined),
      });
      yield* owner.waitUntilJoined(1000);
      owner.replica.setMachineOnline('integration-machine' as MachineId, 0);
      const post = yield* Effect.promise(() => wire.nextPost(0));
      const decoded = new EphemeralStore(LODY_PRESENCE_TTL_MS);
      decoded.apply(post.bytes);
      expect(
        Object.values(parseLodyPresenceStates(decoded.getAllStates())).some(
          (s) => s.kind === 'machine'
        )
      ).toBe(true);
      decoded.destroy();
      const aborted = yield* Deferred.make<void>();
      if (post.signal?.aborted) yield* Deferred.succeed(aborted, undefined);
      else
        post.signal?.addEventListener('abort', () => Deferred.doneUnsafe(aborted, Effect.void), {
          once: true,
        });
      const closing = yield* Effect.forkChild(owner.detach.pipe(Effect.exit));
      yield* Deferred.await(aborted);
      expect(post.signal?.aborted).toBe(true);
      yield* TestClock.adjust(200);
      const failed = yield* Fiber.join(closing);
      expect(Exit.isFailure(failed)).toBe(true);
      expect(owner.failure().reasons.length).toBeGreaterThan(0);
      const refused = yield* owner
        .attach({
          streamsBaseUrl: 'https://synthetic.invalid',
          auth: () => Effect.succeed(undefined),
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(refused)).toBe(true);
      yield* Effect.promise(() => wire.releaseAll());
      yield* owner.retryCleanup;
      yield* owner.stop;
      expect(owner.isReleased()).toBe(true);
      return undefined;
    })
);

effectIt.effect(
  'product application borrows one provider for durable Legacy and native SDK presence',
  () =>
    Effect.gen(function* () {
      const tokenResponse = Promise.withResolvers<Response>();
      const tokenStarted = yield* Deferred.make<void>();
      const reused = yield* Deferred.make<void>();
      let tokenSignal: AbortSignal | null | undefined;
      const wire = controlledTransport(true);
      const clock = Layer.succeed(Clock.Clock, yield* Clock.Clock);
      const platform = presencePlatformLayer(diagnosticLogger().logger, wire.fetch);
      const application = makeApplicationRuntime(
        Layer.merge(
          WorkspacePresenceOwnersLive.pipe(Layer.provide(Layer.merge(platform, clock))),
          clock
        ),
        {
          recover: recoverCliPresenceApplicationShutdown,
          project: (cause) => new WorkspacePresenceLegacyFailure(cause),
        }
      );
      bindWorkspacePresenceApplicationLegacy(application);
      const consumer = yield* Effect.promise(() =>
        createCliPresenceRuntimeLegacy('shared-token-workspace' as WorkspaceId)
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          tokenResponse.resolve(
            new Response(JSON.stringify({ token: 'synthetic-shared-token', expiresIn: 900 }))
          )
        ).pipe(
          Effect.andThen(Effect.promise(() => wire.releaseAll())),
          Effect.andThen(Effect.promise(() => application.closeLegacy()))
        )
      );
      const tokens = yield* Effect.promise(() =>
        consumer.createStreamsTokens(
          makeLoroStreamsTokenProvider({
            endpoint: 'https://synthetic.invalid/token',
            workspaceId: 'shared-token-workspace',
            cleanupTimeoutMs: 100,
            onEvent: (event) => {
              if (event.type === 'in-flight-reuse') Deferred.doneUnsafe(reused, Effect.void);
            },
          }).pipe(
            Effect.provideService(
              LoroStreamsTokenPorts,
              makeLoroStreamsTokenWebPorts({
                credential: Effect.succeed('synthetic-credential'),
                cleanupTimeoutMs: 100,
                fetchImpl: (_url, init) => {
                  tokenSignal = init?.signal;
                  Deferred.doneUnsafe(tokenStarted, Effect.void);
                  return tokenResponse.promise;
                },
              })
            )
          )
        )
      );
      const durable = yield* Effect.forkChild(Effect.promise(() => tokens.legacy.getToken()));
      yield* Deferred.await(tokenStarted);
      yield* Effect.promise(() =>
        consumer.attachStreams({
          streamsBaseUrl: 'https://synthetic.invalid',
          auth: tokens.native.createAuthCallback(),
        })
      );
      yield* Deferred.await(reused);
      yield* Effect.promise(() => consumer.detachStreams());
      expect(tokenSignal?.aborted).toBe(false);
      expect(durable.pollUnsafe()).toBeUndefined();
      tokenResponse.resolve(
        new Response(JSON.stringify({ token: 'synthetic-shared-token', expiresIn: 900 }))
      );
      expect(yield* Fiber.join(durable)).toBe('synthetic-shared-token');
      yield* Effect.promise(() =>
        consumer.attachStreams({
          streamsBaseUrl: 'https://synthetic.invalid',
          auth: tokens.native.createAuthCallback(),
        })
      );
      expect(yield* Effect.promise(() => consumer.waitUntilJoined(1000))).toBe(true);
      consumer.setMachineOnline('shared-token-machine' as MachineId);
      const post = yield* Effect.promise(() => wire.nextPost(0));
      const receiver = new EphemeralStore(LODY_PRESENCE_TTL_MS);
      receiver.apply(post.bytes);
      expect(
        Object.values(parseLodyPresenceStates(receiver.getAllStates())).some(
          (state) => state.kind === 'machine'
        )
      ).toBe(true);
      receiver.destroy();
      yield* Effect.promise(() => consumer.detachStreams());
      expect(yield* tokens.native.getToken()).toBe('synthetic-shared-token');
      yield* Effect.promise(() => application.closeLegacy());
      expect(application.isReleased()).toBe(true);
      expect((yield* tokens.native.health).state).toBe('closed');
      return undefined;
    })
);
