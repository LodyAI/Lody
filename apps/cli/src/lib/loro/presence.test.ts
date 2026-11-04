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
// Native owner cases inject capabilities; the integration cases below use the published SDK fetch boundary.
import { it as effectIt } from '@effect/vitest';
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import {
  PresenceHost,
  PresenceTransport,
  PresenceReleaseFailed,
  makeWorkspacePresence,
  type PresenceStream,
  type PresenceStats,
  WorkspacePresenceOwnersLive,
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
});

import { makeApplicationRuntime } from '@lody/shared/node/application-runtime';
import {
  bindWorkspacePresenceApplicationLegacy,
  createCliPresenceRuntimeLegacy,
  WorkspacePresenceLegacyFailure,
  recoverCliPresenceApplicationShutdown,
} from './presence-legacy';

function EffectLayerDependencies(fixture: Effect.Success<ReturnType<typeof nativeFixture>>) {
  const clock = Layer.succeed(Clock.Clock, fixture.clock);
  return (layer: typeof WorkspacePresenceOwnersLive) =>
    Layer.merge(layer.pipe(Layer.provide(Layer.mergeAll(fixture.io, fixture.host, clock))), clock);
}

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
