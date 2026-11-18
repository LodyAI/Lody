import { EphemeralStore } from 'loro-crdt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LORO_STREAMS_BASE_URL,
  LODY_PRESENCE_CHANNEL,
  LODY_PRESENCE_TTL_MS,
  type LodyPresenceStateMap,
  LODY_PRESENCE_HEARTBEAT_MS,
  parseLodyPresenceStates,
  type SessionId,
  type WorkspaceId,
  SessionStatusFactory,
  getLodyMachinePresenceKey,
  getLodySessionPresenceKey,
  type LodyPresenceInstanceId,
  type MachineId,
} from '@lody/shared';
import {
  WorkspacePresenceTransport,
  type PresenceStoreLike,
  type PresenceTransportLike,
} from '../src/providers/workspace-presence-transport';
import { mergePresenceSnapshots } from '../src/providers/presence-snapshot-merge';
import type { EphemeralRoomAuthCallback } from '../src/providers/ephemeral-room-transport';
import {
  resolveSessionDetailPresenceState,
  type SessionDetailPresenceState,
} from '../src/lib/session-detail-presence';

describe('workspace-presence-transport', () => {
  type JoinResult = Awaited<ReturnType<PresenceTransportLike['join']>>;

  class FakePresenceStore implements PresenceStoreLike {
    private states: Record<string, unknown> = {};
    private readonly listeners = new Set<() => void>();
    readonly destroy = vi.fn();

    getAllStates(): Record<string, unknown> {
      return this.states;
    }

    subscribe(listener: () => void): () => void {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    }

    set(key: string, value: unknown): void {
      this.states = { ...this.states, [key]: value };
      for (const listener of this.listeners) {
        listener();
      }
    }

    delete(key: string): void {
      if (!(key in this.states)) return;
      const next = { ...this.states };
      delete next[key];
      this.states = next;
      for (const listener of this.listeners) {
        listener();
      }
    }

    setStates(states: Record<string, unknown>): void {
      this.states = states;
      for (const listener of this.listeners) {
        listener();
      }
    }
  }

  type JoinParams = Parameters<PresenceTransportLike['join']>[0];

  class FakePresenceTransport implements PresenceTransportLike {
    readonly close = vi.fn(async () => {});
    joinParams: JoinParams | undefined;
    readonly join = vi.fn(
      (params: JoinParams) =>
        new Promise<JoinResult>((resolve) => {
          this.joinParams = params;
          this.resolveJoin = resolve;
        })
    );
    private resolveJoin: ((result: JoinResult) => void) | null = null;

    resolve(result: JoinResult): void {
      this.resolveJoin?.(result);
    }

    emitStatus(status: 'connecting' | 'joined' | 'reconnecting' | 'disconnected' | 'error'): void {
      this.joinParams?.onStatusChange?.(status);
    }
  }

  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const installTestWindow = (): {
    target: Window & typeof globalThis;
    restore: () => void;
  } => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const target = {} as Window & typeof globalThis;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: target,
    });
    return {
      target,
      restore: () => {
        if (originalDescriptor) {
          Object.defineProperty(globalThis, 'window', originalDescriptor);
          return;
        }
        delete (globalThis as { window?: unknown }).window;
      },
    };
  };

  describe('WorkspacePresenceTransport', () => {
    it.each([false, true])(
      'drops invalid viewing routes without throwing or retaining a heartbeat (started=%s)',
      async (started) => {
        vi.useFakeTimers();
        vi.setSystemTime(1_790_000_000_000);
        const store = new EphemeralStore(LODY_PRESENCE_TTL_MS);
        const server = new EphemeralStore(LODY_PRESENCE_TTL_MS);
        const emitted: Uint8Array[] = [];
        const detach = store.subscribeLocalUpdates((bytes) => {
          emitted.push(bytes);
          server.apply(bytes);
        });
        const presence = new WorkspacePresenceTransport({
          workspaceId: 'workspace-1' as WorkspaceId,
          minimal: true,
          createStore: () => store,
          createTransport: () => new FakePresenceTransport(),
        });
        const start = () =>
          presence.start({ baseUrl: 'https://synthetic.invalid', auth: async () => undefined });
        try {
          if (started) start();
          for (const sessionId of [
            'Private roadmap: /Users/example/project',
            'TitleWithoutSpaces',
            '1790000000000-privateroadmap',
            '1790000000000-k5zmz7k',
            'a'.repeat(1024),
          ]) {
            expect(() =>
              presence.publishSessionViewing({
                sessionId: sessionId as SessionId,
                userId: 'Abcdef0123456789Abcdef0123456789',
              })
            ).not.toThrow();
          }
          expect(() =>
            presence.publishSessionViewing({
              sessionId: '01020304-1111-4222-8333-010203040508' as SessionId,
              userId: 'User name /private/path',
            })
          ).not.toThrow();
          // An unstarted room must not retain this route for its first publication either.
          presence.publishSessionViewing({
            sessionId: '1790000000000-privateroadmap' as SessionId,
            userId: 'Abcdef0123456789Abcdef0123456789',
          });
          if (!started) start();
          vi.advanceTimersByTime(LODY_PRESENCE_HEARTBEAT_MS);
          expect(server.getAllStates()).toEqual({});
          expect(emitted).toEqual([]);
          expect(presence.getSyncState()).toBe('connecting');
        } finally {
          detach();
          await presence.stop();
          server.destroy();
          vi.useRealTimers();
        }
      }
    );

    it('clears a valid viewing entry when the next route is invalid, without leaking the route on heartbeat', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_790_000_000_000);
      const store = new EphemeralStore(LODY_PRESENCE_TTL_MS);
      const server = new EphemeralStore(LODY_PRESENCE_TTL_MS);
      const detach = store.subscribeLocalUpdates((bytes) => server.apply(bytes));
      const presence = new WorkspacePresenceTransport({
        workspaceId: 'workspace-1' as WorkspaceId,
        minimal: true,
        createStore: () => store,
        createTransport: () => new FakePresenceTransport(),
      });
      try {
        presence.start({ baseUrl: 'https://synthetic.invalid', auth: async () => undefined });
        presence.publishSessionViewing({
          sessionId: '01020304-1111-4222-8333-010203040508' as SessionId,
          userId: 'Abcdef0123456789Abcdef0123456789',
        });
        expect(Object.values(server.getAllStates())).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(() =>
          presence.publishSessionViewing({
            sessionId: '/private/invalid route' as SessionId,
            userId: 'Abcdef0123456789Abcdef0123456789',
          })
        ).not.toThrow();
        vi.advanceTimersByTime(LODY_PRESENCE_HEARTBEAT_MS);
        expect(server.getAllStates()).toEqual({});
        expect(store.getAllStates()).toEqual({});
      } finally {
        detach();
        await presence.stop();
        server.destroy();
        vi.useRealTimers();
      }
    });

    it.each([false, true])(
      'projects received fields and publishes viewing through real Loro (minimal=%s)',
      async (minimal) => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const store = new EphemeralStore(LODY_PRESENCE_TTL_MS);
        const transport = new FakePresenceTransport();
        let snapshot: LodyPresenceStateMap = {};
        let streamUrl = '';
        const presence = new WorkspacePresenceTransport({
          workspaceId: 'workspace-1' as WorkspaceId,
          minimal,
          presenceShardId: 0,
          createStore: () => store,
          onSnapshot: (states) => {
            snapshot = states;
          },
          createTransport: (args) => {
            streamUrl = args.streamUrl;
            return transport;
          },
        });
        const peer = new EphemeralStore(LODY_PRESENCE_TTL_MS);
        const wire = new EphemeralStore(LODY_PRESENCE_TTL_MS);
        try {
          presence.start({
            baseUrl: 'https://synthetic.invalid',
            bucketId: 'protected-bucket',
            auth: async () => 'token',
          });
          expect(streamUrl).toContain('/protected-bucket/');
          presence.publishSessionViewing({
            sessionId: '01020304-1111-4222-8333-010203040501' as SessionId,
            userId: 'Abcdef0123456789Abcdef0123456789',
            detail: 'must be ignored',
          } as never);
          wire.apply(store.encodeAll());
          expect(Object.values(wire.getAllStates())).toEqual([
            {
              kind: 'session-viewing',
              userId: 'Abcdef0123456789Abcdef0123456789',
              instanceId: expect.any(String),
              sessionId: '01020304-1111-4222-8333-010203040501',
              since: 10_000,
              updatedAt: 10_000,
            },
          ]);
          peer.set('remote', {
            kind: 'session',
            sessionId: '01020304-1111-4222-8333-010203040502',
            machineId: '01020304-1111-4222-8333-010203040503',
            instanceId: '01020304-1111-4222-8333-010203040504',
            updatedAt: 10_000,
            status: { type: 'initializing', stage: 'acp', detail: 'secret' },
            unknownText: 'ignored',
          });
          store.apply(peer.encodeAll());
          expect(snapshot.remote).toEqual({
            kind: 'session',
            sessionId: '01020304-1111-4222-8333-010203040502',
            machineId: '01020304-1111-4222-8333-010203040503',
            instanceId: '01020304-1111-4222-8333-010203040504',
            updatedAt: 10_000,
            status: minimal
              ? { type: 'initializing', stage: 'acp' }
              : { type: 'initializing', stage: 'acp', detail: 'secret' },
          });
          transport.emitStatus('joined');
          expect(presence.getDisplaySyncState()).toBe('synced');
          const deleted = Promise.withResolvers<void>();
          const unsubscribeWire = store.subscribeLocalUpdates((bytes) => {
            wire.apply(bytes);
            deleted.resolve();
          });
          vi.advanceTimersByTime(1);
          presence.publishSessionViewing(null);
          await deleted.promise;
          unsubscribeWire();
          expect(
            Object.values(wire.getAllStates()).some(
              (entry) =>
                typeof entry === 'object' &&
                entry !== null &&
                'kind' in entry &&
                entry.kind === 'session-viewing'
            )
          ).toBe(false);
        } finally {
          await presence.stop();
          peer.destroy();
          wire.destroy();
          vi.useRealTimers();
        }
      }
    );

    afterEach(() => {
      if (typeof window !== 'undefined') {
        delete window.lodyPresence;
      }
    });

    it('ignores status events from a stale generation after restart', async () => {
      const transports: FakePresenceTransport[] = [];
      const presence = new WorkspacePresenceTransport({
        workspaceId: 'workspace-1' as WorkspaceId,
        createStore: () => new FakePresenceStore(),
        createTransport: () => {
          const transport = new FakePresenceTransport();
          transports.push(transport);
          return transport;
        },
      });

      presence.start({ baseUrl: 'https://streams.example.test', auth: async () => 'token-1' });
      transports[0]?.resolve({ ok: true, value: { unsubscribe: vi.fn() } } as JoinResult);
      await flush();

      presence.start({ baseUrl: 'https://streams.example.test', auth: async () => 'token-2' });
      expect(presence.getSyncState()).toBe('connecting');

      // Old generation's read loop dying must not poison the new generation.
      transports[0]?.emitStatus('error');
      expect(presence.getSyncState()).toBe('connecting');
      expect(presence.needsReconnect()).toBe(false);

      transports[1]?.resolve({ ok: true, value: { unsubscribe: vi.fn() } } as JoinResult);
      await flush();
      transports[1]?.emitStatus('joined');
      expect(presence.getSyncState()).toBe('synced');
      await presence.stop();
    });

    it('routes default production presence traffic to the tab presence shard host', () => {
      const streamUrls: string[] = [];
      const presence = new WorkspacePresenceTransport({
        workspaceId: 'workspace-1' as WorkspaceId,
        presenceShardId: '07',
        createStore: () => new FakePresenceStore(),
        createTransport: ({ streamUrl }) => {
          streamUrls.push(streamUrl);
          return new FakePresenceTransport();
        },
      });

      presence.start({ baseUrl: DEFAULT_LORO_STREAMS_BASE_URL, auth: async () => 'token' });

      const url = new URL(streamUrls[0] ?? '');
      expect(url.origin).toBe('https://presence-07.streams.invalid');
      expect(url.pathname).toBe('/ds/lody/workspace-1%3Ameta');
      expect(url.searchParams.get('ephemeral')).toBe(LODY_PRESENCE_CHANNEL);
    });

    it('restarts a stalled initial join and re-asserts local viewing state', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const stores: FakePresenceStore[] = [];
      const warnings: string[] = [];
      const viewingEntries = (store: FakePresenceStore) =>
        Object.values(parseLodyPresenceStates(store.getAllStates())).filter(
          (state) => state.kind === 'session-viewing'
        );
      const presence = new WorkspacePresenceTransport({
        workspaceId: 'workspace-1' as WorkspaceId,
        presenceShardId: '03',
        onWarning: (message) => warnings.push(message),
        createStore: () => {
          const store = new FakePresenceStore();
          stores.push(store);
          return store;
        },
        createTransport: () => new FakePresenceTransport(),
      });

      try {
        presence.start({ baseUrl: 'https://streams.example.test', auth: async () => 'token' });
        presence.publishSessionViewing({ sessionId: 'session-1' as SessionId, userId: 'user-1' });
        expect(stores).toHaveLength(1);
        expect(viewingEntries(stores[0]!)).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(20_000);

        expect(stores).toHaveLength(2);
        expect(viewingEntries(stores[0]!)).toEqual([]);
        expect(viewingEntries(stores[1]!)).toHaveLength(1);
        expect(
          warnings.some((message) => message.includes('restarting stalled presence room'))
        ).toBe(true);
      } finally {
        await presence.stop();
        vi.useRealTimers();
      }
    });

    describe('snapshot continuity across store replacement', () => {
      const remoteHeartbeat = {
        kind: 'machine',
        machineId: 'machine-remote',
        instanceId: 'instance-remote',
        since: 1,
        updatedAt: 1,
      };

      const setup = () => {
        const stores: FakePresenceStore[] = [];
        const transports: FakePresenceTransport[] = [];
        const snapshots: LodyPresenceStateMap[] = [];
        const presence = new WorkspacePresenceTransport({
          workspaceId: 'workspace-1' as WorkspaceId,
          presenceShardId: '03',
          createStore: () => {
            const store = new FakePresenceStore();
            stores.push(store);
            return store;
          },
          createTransport: () => {
            const transport = new FakePresenceTransport();
            transports.push(transport);
            return transport;
          },
          onSnapshot: (states) => snapshots.push(states),
        });
        const start = () =>
          presence.start({ baseUrl: 'https://streams.example.test', auth: async () => 'token' });
        start();
        transports[0]?.emitStatus('joined');
        stores[0]?.setStates({ 'machine:remote': remoteHeartbeat });
        return { presence, stores, transports, snapshots, start };
      };

      it('keeps the last room state through a stalled-room restart until the new room joins', async () => {
        vi.useFakeTimers();
        const { presence, stores, transports, snapshots } = setup();
        try {
          const delivered = snapshots.length;
          transports[0]?.emitStatus('reconnecting');
          await vi.advanceTimersByTimeAsync(20_000);

          expect(transports).toHaveLength(2);
          expect(snapshots.slice(delivered).filter((states) => !states['machine:remote'])).toEqual(
            []
          );

          stores[1]?.setStates({
            'machine:other': { ...remoteHeartbeat, machineId: 'machine-other' },
          });
          transports[1]?.emitStatus('joined');
          expect(Object.keys(snapshots.at(-1) ?? {})).toEqual(['machine:other']);
        } finally {
          await presence.stop();
          vi.useRealTimers();
        }
      });

      it('keeps the last room state through a reconnect-loop stop and start', async () => {
        const { presence, transports, snapshots, start } = setup();
        transports[0]?.emitStatus('error');
        const delivered = snapshots.length;

        await presence.stop({ retainSnapshot: true });
        start();

        expect(snapshots.slice(delivered).filter((states) => !states['machine:remote'])).toEqual(
          []
        );
        await presence.stop();
      });

      it('still clears the room state on a terminal stop', async () => {
        const { presence, snapshots } = setup();

        await presence.stop();

        expect(snapshots.at(-1)).toEqual({});
      });
    });

    describe('publishSessionViewing', () => {
      const viewingEntriesOf = (store: FakePresenceStore) =>
        Object.values(parseLodyPresenceStates(store.getAllStates())).filter(
          (state) => state.kind === 'session-viewing'
        );

      const setup = () => {
        const stores: FakePresenceStore[] = [];
        const transports: FakePresenceTransport[] = [];
        const presence = new WorkspacePresenceTransport({
          workspaceId: 'workspace-1' as WorkspaceId,
          createStore: () => {
            const store = new FakePresenceStore();
            stores.push(store);
            return store;
          },
          createTransport: () => {
            const transport = new FakePresenceTransport();
            transports.push(transport);
            return transport;
          },
        });
        presence.start({ baseUrl: 'https://streams.example.test', auth: async () => 'token' });
        return { presence, stores, transports };
      };

      it('publishes, heartbeats, replaces in place, and clears', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        try {
          const { presence, stores, transports } = setup();
          const store = stores[0]!;
          transports[0]?.resolve({ ok: true, value: { unsubscribe: vi.fn() } } as JoinResult);
          await flush();
          transports[0]?.emitStatus('joined');

          presence.publishSessionViewing({ sessionId: 'session-1' as SessionId, userId: 'user-1' });
          expect(viewingEntriesOf(store)).toEqual([
            {
              kind: 'session-viewing',
              userId: 'user-1',
              instanceId: expect.any(String),
              sessionId: 'session-1',
              since: 10_000,
              updatedAt: 10_000,
            },
          ]);

          // Heartbeat refreshes updatedAt but keeps the original `since`.
          vi.setSystemTime(10_000 + LODY_PRESENCE_HEARTBEAT_MS);
          vi.advanceTimersByTime(LODY_PRESENCE_HEARTBEAT_MS);
          const afterHeartbeat = viewingEntriesOf(store);
          expect(afterHeartbeat).toHaveLength(1);
          expect(afterHeartbeat[0]).toMatchObject({ sessionId: 'session-1', since: 10_000 });
          expect(afterHeartbeat[0]!.updatedAt).toBeGreaterThan(10_000);

          // Switching sessions replaces the single per-instance entry in place.
          presence.publishSessionViewing({ sessionId: 'session-2' as SessionId, userId: 'user-1' });
          const afterSwitch = viewingEntriesOf(store);
          expect(afterSwitch).toHaveLength(1);
          expect(afterSwitch[0]).toMatchObject({ sessionId: 'session-2' });

          // Clearing deletes the entry actively (TTL is only the crash fallback).
          presence.publishSessionViewing(null);
          expect(viewingEntriesOf(store)).toEqual([]);

          await presence.stop();
        } finally {
          vi.useRealTimers();
        }
      });
    });
  });
});

describe('presence-snapshot-merge', () => {
  const LOCAL_INSTANCE = 'local-instance' as LodyPresenceInstanceId;
  const REMOTE_INSTANCE = 'remote-instance' as LodyPresenceInstanceId;
  const LOCAL_MACHINE = 'local-machine' as MachineId;
  const REMOTE_MACHINE = 'remote-machine' as MachineId;
  const SESSION = 'session-1' as SessionId;

  describe('mergePresenceSnapshots', () => {
    it('does not resurrect locally-cleared session presence from a stale cloud replica', () => {
      const localMachineKey = getLodyMachinePresenceKey(LOCAL_MACHINE, LOCAL_INSTANCE);
      const localSessionKey = getLodySessionPresenceKey(SESSION, LOCAL_INSTANCE);
      const localStates: LodyPresenceStateMap = {
        [localMachineKey]: {
          kind: 'machine',
          machineId: LOCAL_MACHINE,
          instanceId: LOCAL_INSTANCE,
          updatedAt: 200,
        },
      };
      const cloudStates: LodyPresenceStateMap = {
        [localMachineKey]: {
          kind: 'machine',
          machineId: LOCAL_MACHINE,
          instanceId: LOCAL_INSTANCE,
          updatedAt: 100,
        },
        [localSessionKey]: {
          kind: 'session',
          sessionId: SESSION,
          machineId: LOCAL_MACHINE,
          instanceId: LOCAL_INSTANCE,
          status: SessionStatusFactory.initializing(),
          updatedAt: 100,
        },
      };

      expect(mergePresenceSnapshots(localStates, cloudStates)).toEqual(localStates);
    });

    it('preserves cloud presence from remote CLI instances', () => {
      // The scenario the origin split exists for: a turn running on ANOTHER
      // machine. Its presence reaches the cloud replica on every phase change,
      // while the local plane only speaks for the local CLI — so if the local
      // snapshot ever claimed authority over the remote instance, that session
      // would go statusless between local writes.
      const localMachineKey = getLodyMachinePresenceKey(LOCAL_MACHINE, LOCAL_INSTANCE);
      const remoteMachineKey = getLodyMachinePresenceKey(REMOTE_MACHINE, REMOTE_INSTANCE);
      const remoteSessionKey = getLodySessionPresenceKey(SESSION, REMOTE_INSTANCE);
      const localOriginStates: LodyPresenceStateMap = {
        [localMachineKey]: {
          kind: 'machine',
          machineId: LOCAL_MACHINE,
          instanceId: LOCAL_INSTANCE,
          updatedAt: 200,
        },
      };
      const cloudStates: LodyPresenceStateMap = {
        [remoteMachineKey]: {
          kind: 'machine',
          machineId: REMOTE_MACHINE,
          instanceId: REMOTE_INSTANCE,
          updatedAt: 100,
        },
        [remoteSessionKey]: {
          kind: 'session',
          sessionId: SESSION,
          machineId: REMOTE_MACHINE,
          instanceId: REMOTE_INSTANCE,
          status: SessionStatusFactory.initializing(),
          updatedAt: 100,
        },
      };

      expect(mergePresenceSnapshots(localOriginStates, cloudStates)).toEqual({
        ...cloudStates,
        ...localOriginStates,
      });
    });
  });
});

describe('session-viewing-presence-bridge', () => {
  // Expose the production factory; do not inject a fake transport or adaptor.
  class ProductionPresenceTransport extends WorkspacePresenceTransport {
    open(store: EphemeralStore, auth: EphemeralRoomAuthCallback = async () => 'test-token') {
      return this.createTransport({
        streamUrl: 'https://streams.example.com/v1/streams/presence?ephemeral=presence',
        store,
        auth,
      });
    }
  }

  function bootstrapResponse(signal?: AbortSignal | null): Response {
    let detachAbort = () => {};
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: bootstrap\ndata: AA==\n\n'));
          const onAbort = () => controller.close();
          signal?.addEventListener('abort', onAbort, { once: true });
          detachAbort = () => signal?.removeEventListener('abort', onAbort);
        },
        cancel() {
          // Reader cancellation already closes the stream. The HTTP client's
          // later abort must not close that same controller a second time.
          detachAbort();
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream', 'Stream-SSE-Data-Encoding': 'base64' } }
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('production presence transport with the published Streams runtime', () => {
    it.each(['set', 'delete'] as const)(
      'coalesces unsent values through a final %s, preserving in-flight bytes and the sync barrier',
      async (operation) => {
        // Loro timestamps are part of the wire value: explicitly order mutations.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000_000);
        const store = new EphemeralStore(90_000);
        const peer = new EphemeralStore(90_000);
        const posts: Uint8Array[] = [];
        const firstStarted = Promise.withResolvers<void>();
        const lastStarted = Promise.withResolvers<void>();
        const releaseFirst = Promise.withResolvers<void>();
        const releaseLast = Promise.withResolvers<void>();
        vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
          if (init?.method !== 'POST') return bootstrapResponse(init?.signal);
          const bytes = new Uint8Array(init.body as Uint8Array);
          posts.push(bytes);
          if (posts.length === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
          } else if (posts.length === 3) {
            lastStarted.resolve();
            await releaseLast.promise;
          }
          peer.apply(bytes);
          return new Response(null, { status: 204 });
        });
        const factory = new ProductionPresenceTransport({
          workspaceId: 'workspace-test' as WorkspaceId,
        });
        const transport = factory.open(store);
        try {
          const result = await transport.join({});
          if (!result.ok) throw new Error(JSON.stringify(result.error));
          store.set('viewing', { sessionId: 'first' });
          await firstStarted.promise;
          for (let i = 0; i < 100; i += 1) {
            vi.setSystemTime(1_000_001 + i);
            store.set('viewing', { sessionId: `session-${i}` });
          }
          let synced = false;
          const barrier = result.value.waitUntilSynced().then(() => {
            synced = true;
          });
          store.set('heartbeat', { updatedAt: 123 });
          vi.setSystemTime(1_000_101);
          if (operation === 'delete') store.delete('viewing');
          else store.set('viewing', { sessionId: 'latest' });
          releaseFirst.resolve();
          await lastStarted.promise;
          // Only the original in-flight write and the independent heartbeat arrived.
          expect(peer.getAllStates()).toEqual({
            viewing: { sessionId: 'first' },
            heartbeat: { updatedAt: 123 },
          });
          expect(synced).toBe(false);
          releaseLast.resolve();
          await barrier;
          expect(posts).toHaveLength(3);
          expect(peer.getAllStates()).toEqual(
            operation === 'delete'
              ? { heartbeat: { updatedAt: 123 } }
              : { viewing: { sessionId: 'latest' }, heartbeat: { updatedAt: 123 } }
          );
          expect(result.value.pendingLocalCount).toBe(0);
        } finally {
          releaseFirst.resolve();
          releaseLast.resolve();
          await transport.close();
          store.destroy();
          peer.destroy();
        }
      }
    );

    it.each(['request', 'unauthorized'] as const)(
      'recovers after a stalled %s token callback reaches the default deadline',
      async (reason) => {
        vi.useFakeTimers({
          toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        });
        const store = new EphemeralStore(90_000);
        const tokenStalled = Promise.withResolvers<void>();
        const tokenCancelled = Promise.withResolvers<void>();
        const recovering = Promise.withResolvers<void>();
        const appended = Promise.withResolvers<void>();
        let stall = true;
        let rejectPost = reason === 'unauthorized';
        let allowStall = false;
        vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
          if (init?.method !== 'POST') return bootstrapResponse(init?.signal);
          if (rejectPost) {
            rejectPost = false;
            return new Response(null, { status: 401 });
          }
          appended.resolve();
          return new Response(null, { status: 204 });
        });
        const factory = new ProductionPresenceTransport({
          workspaceId: 'workspace-test' as WorkspaceId,
        });
        const transport = factory.open(store, async (context, signal) => {
          if (allowStall && stall && context?.reason === reason) {
            tokenStalled.resolve();
            return new Promise<string>((_resolve, reject) => {
              const abort = () => {
                tokenCancelled.resolve();
                reject(new DOMException('synthetic auth canceled', 'AbortError'));
              };
              if (signal?.aborted) abort();
              else signal?.addEventListener('abort', abort, { once: true });
            });
          }
          return 'test-token';
        });
        try {
          const result = await transport.join({
            onStatusChange: (status) => {
              if (status === 'reconnecting') recovering.resolve();
            },
          });
          if (!result.ok) throw new Error(JSON.stringify(result.error));
          allowStall = true;
          store.set('viewing', { sessionId: 'latest' });
          const barrier = result.value.waitUntilSynced();
          await tokenStalled.promise;
          stall = false;
          await vi.advanceTimersByTimeAsync(10_001);
          await tokenCancelled.promise;
          await recovering.promise;
          // The published native owner retries only after actual callback cleanup.
          // Its first default backoff, including jitter, is below this clock advance.
          await vi.advanceTimersByTimeAsync(2_000);
          await appended.promise;
          await barrier;
          expect(result.value.pendingLocalCount).toBe(0);
          expect(result.value.status).toBe('joined');
        } finally {
          await transport.close();
          store.destroy();
        }
      }
    );
  });
});

describe('session-detail-presence', () => {
  const expectState = (
    state: SessionDetailPresenceState,
    expected: SessionDetailPresenceState
  ): void => {
    expect(state).toBe(expected);
  };

  describe('resolveSessionDetailPresenceState', () => {
    it('returns resolved from local cache even when offline', () => {
      expectState(
        resolveSessionDetailPresenceState({
          hasActiveSession: true,
          docMetaCacheReady: true,
          runtimeInitializing: false,
          runtimeWorkspaceId: 'workspace-1' as WorkspaceId,
          currentWorkspaceId: 'workspace-1' as WorkspaceId,
          controlConnectionState: 'idle',
        }),
        'resolved'
      );
    });

    it('keeps loading while the doc meta cache is still bootstrapping', () => {
      expectState(
        resolveSessionDetailPresenceState({
          hasActiveSession: false,
          docMetaCacheReady: false,
          runtimeInitializing: false,
          runtimeWorkspaceId: 'workspace-1' as WorkspaceId,
          currentWorkspaceId: 'workspace-1' as WorkspaceId,
          controlConnectionState: 'online',
        }),
        'loading'
      );
    });

    it('keeps loading while runtime is still pointed at another workspace', () => {
      expectState(
        resolveSessionDetailPresenceState({
          hasActiveSession: false,
          docMetaCacheReady: true,
          runtimeInitializing: false,
          runtimeWorkspaceId: 'workspace-1' as WorkspaceId,
          currentWorkspaceId: 'workspace-2' as WorkspaceId,
          controlConnectionState: 'online',
        }),
        'loading'
      );
    });

    it('keeps loading when session not in cache and remote sync not yet completed', () => {
      expectState(
        resolveSessionDetailPresenceState({
          hasActiveSession: false,
          docMetaCacheReady: true,
          runtimeInitializing: false,
          runtimeWorkspaceId: 'workspace-1' as WorkspaceId,
          currentWorkspaceId: 'workspace-1' as WorkspaceId,
          controlConnectionState: 'connecting',
        }),
        'loading'
      );
    });

    it('returns not-found after remote sync has completed and session is absent', () => {
      expectState(
        resolveSessionDetailPresenceState({
          hasActiveSession: false,
          docMetaCacheReady: true,
          runtimeInitializing: false,
          runtimeWorkspaceId: 'workspace-1' as WorkspaceId,
          currentWorkspaceId: 'workspace-1' as WorkspaceId,
          controlConnectionState: 'online',
        }),
        'not-found'
      );
    });

    it('returns not-found when reconnecting (initial sync was completed before)', () => {
      expectState(
        resolveSessionDetailPresenceState({
          hasActiveSession: false,
          docMetaCacheReady: true,
          runtimeInitializing: false,
          runtimeWorkspaceId: 'workspace-1' as WorkspaceId,
          currentWorkspaceId: 'workspace-1' as WorkspaceId,
          controlConnectionState: 'reconnecting',
        }),
        'not-found'
      );
    });
  });
});

it('receives local machine presence with zero legacy rooms, updates Role availability and releases the original listener', async () => {
  const [
    { Effect, Layer },
    { LocalLoroWriterTurn },
    { makeLocalLoroWriterLegacy },
    { LocalLoroDataPlaneServerLegacy },
    { LocalLoroTransportAdapter },
    { createLocalLoroDataPlaneConnection },
    { base64ToBytes },
    { collectOnlineMachineIdsFromPresence, resolveAgentRoleAvailability, getServerNow },
  ] = await Promise.all([
    import('effect'),
    import('@lody/shared/local-loro-writer'),
    import('@lody/shared/local-loro-writer/legacy'),
    import('@lody/shared/local-loro-data-plane-server'),
    import('@lody/shared/local-loro-transport'),
    import('../src/providers/local-loro-data-plane-connection'),
    import('@lody/shared/local-loro-data-plane'),
    import('@lody/shared'),
  ]);
  vi.useRealTimers();
  const writer = makeLocalLoroWriterLegacy(
    Layer.succeed(LocalLoroWriterTurn, { next: Effect.void })
  );
  const workspaceId = 'native-zero-room' as WorkspaceId;
  const machineId = 'local-machine' as MachineId;
  const instanceId = 'local-instance' as LodyPresenceInstanceId;
  const key = getLodyMachinePresenceKey(machineId, instanceId);
  const now = getServerNow();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  const origin = new EphemeralStore(LODY_PRESENCE_TTL_MS);
  origin.set(key, { kind: 'machine', machineId, instanceId, updatedAt: now });
  const sourceListeners = new Set<() => void>();
  const ipcListeners = new Map<string, Set<(value: unknown) => void>>();
  const sent: import('@lody/shared').LocalLoroDataPlaneClientMessage[] = [];
  const tasks: Promise<void>[] = [];
  const initial = Promise.withResolvers<void>(),
    updated = Promise.withResolvers<void>(),
    cleared = Promise.withResolvers<void>();
  let receiver = new EphemeralStore(LODY_PRESENCE_TTL_MS);
  let snapshot: LodyPresenceStateMap = {};
  let initialized = false;
  const receive = (value: unknown) => {
    for (const listener of ipcListeners.get('loro.event') ?? []) listener(value);
  };
  const connection = { id: 'actual-local-socket', send: receive };
  const server = new LocalLoroDataPlaneServerLegacy({
    writerLegacy: writer,
    workspaceId,
    resolveDoc: async () => {
      throw new Error('Native presence must not open a legacy body');
    },
    resolveFlockDoc: async () => {
      throw new Error('Native presence must not open Meta/MF/WF/SR');
    },
    presenceSource: {
      encodeLocalOrigin: () => origin.encodeAll(),
      subscribeLocalOrigin(listener) {
        sourceListeners.add(listener);
        return () => sourceListeners.delete(listener);
      },
    },
  });
  vi.stubGlobal('window', {
    ipc: {
      invoke: async (channel: string) => channel === 'loro.isConnected',
      on(channel: string, listener: (value: unknown) => void) {
        const listeners = ipcListeners.get(channel) ?? new Set();
        listeners.add(listener);
        ipcListeners.set(channel, listeners);
        return () => listeners.delete(listener);
      },
      send(channel: string, message: import('@lody/shared').LocalLoroDataPlaneClientMessage) {
        if (channel !== 'loro.send') return;
        sent.push(message);
        if (message.type === 'ping') {
          if (!message.workspaceId || !message.peerId) return;
          tasks.push(
            server.handleMessage(connection, {
              ...message,
              workspaceId: message.workspaceId,
              peerId: message.peerId,
            })
          );
        } else tasks.push(server.handleMessage(connection, message));
      },
    },
  });
  const local = createLocalLoroDataPlaneConnection({
    presence: {
      workspaceId,
      peerId: 'zero-room-view',
      onMessage(message) {
        receiver.apply(base64ToBytes(message.dataBase64));
        snapshot = parseLodyPresenceStates(receiver.getAllStates() as Record<string, unknown>);
        const machine = Object.values(snapshot).find((state) => state.kind === 'machine');
        if (!initialized && machine) {
          initialized = true;
          initial.resolve();
        }
        if (machine?.updatedAt === now + 1) updated.resolve();
        if (initialized && !machine) cleared.resolve();
      },
      onDisconnect() {
        receiver = new EphemeralStore(LODY_PRESENCE_TTL_MS);
        snapshot = {};
      },
    },
  });
  if (!local) throw new Error('Missing Electron local data-plane connection');
  const transport = new LocalLoroTransportAdapter({
    workspaceId,
    peerId: 'zero-room-view',
    connection: local.connection,
  });
  const role = {
    v: 1 as const,
    id: 'role' as import('@lody/shared').AgentRoleId,
    ownerUserId: 'owner',
    visibility: 'private' as const,
    name: 'Native role',
    machineId,
    agentConfigId: 'agent' as import('@lody/shared').AgentConfigId,
    runConfig: {},
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const availability = () =>
    resolveAgentRoleAvailability(role, {
      authorizedMachineIds: new Set([machineId]),
      loadedAgentConfigMachineIds: new Set([machineId]),
      agentConfigMachineIds: new Map([[role.agentConfigId, machineId]]),
      onlineMachineIds: collectOnlineMachineIdsFromPresence(snapshot, now + 1),
    });
  try {
    await transport.connect();
    await initial.promise;
    expect(Object.values(snapshot)).toMatchObject([{ kind: 'machine', machineId, updatedAt: now }]);
    expect(availability()).toEqual({ kind: 'available' });
    expect(sent.every((message) => message.type === 'ping')).toBe(true);
    vi.setSystemTime(now + 1);
    origin.set(key, { kind: 'machine', machineId, instanceId, updatedAt: now + 1 });
    for (const listener of sourceListeners) listener();
    await updated.promise;
    expect(Object.values(snapshot)).toMatchObject([{ updatedAt: now + 1 }]);
    const current = snapshot;
    receive({
      type: 'presence',
      protocolVersion: 7,
      workspaceId: 'different-workspace',
      dataBase64: '',
    });
    expect(snapshot).toBe(current);
    vi.setSystemTime(now + 2);
    origin.delete(key);
    for (const listener of sourceListeners) listener();
    await cleared.promise;
    expect(snapshot).toEqual({});
    expect(availability()).toEqual({ kind: 'unavailable', reason: 'machine_offline' });
    local.dispose();
    origin.set(key, { kind: 'machine', machineId, instanceId, updatedAt: now + 2 });
    for (const listener of sourceListeners) listener();
    await Promise.all(tasks);
    expect(snapshot).toEqual({});
    await transport.close();
    expect([...ipcListeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  } finally {
    local.dispose();
    await transport.close();
    await server.handleDisconnectLegacy(connection.id);
    await server.disposeLegacy();
    await writer.closeLegacy();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
  expect(sourceListeners.size).toBe(0);
});
