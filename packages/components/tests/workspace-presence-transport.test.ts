import { EphemeralStore } from 'loro-crdt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLoroStreamsTokenProviderLegacy,
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
import { WorkspaceMachineMonitorTransport } from '../src/providers/workspace-machine-monitor-transport';
import { mergePresenceSnapshots } from '../src/providers/presence-snapshot-merge';
import type { ElectronPowerState } from '@lody/shared/electron-ipc';
import {
  DESKTOP_FOREGROUND_DEBOUNCE_MS,
  DESKTOP_FOREGROUND_IDLE_MS,
  startDesktopForegroundPublisher,
} from '../src/lib/desktop-foreground-presence';
import type { EphemeralRoomAuthCallback } from '../src/providers/ephemeral-room-transport';
import {
  resolveSessionDetailPresenceState,
  type SessionDetailPresenceState,
} from '../src/lib/session-detail-presence';

const sdkEphemeralOptions = vi.hoisted(() => [] as unknown[]);
vi.mock('@loro-dev/streams-crdt/loro', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@loro-dev/streams-crdt/loro')>();
  return {
    ...sdk,
    EphemeralStreamCrdt: class extends sdk.EphemeralStreamCrdt {
      constructor(options: ConstructorParameters<typeof sdk.EphemeralStreamCrdt>[0]) {
        sdkEphemeralOptions.push(options);
        super(options);
      }
    },
  };
});

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
    readonly joinStarted = Promise.withResolvers<void>();
    joinParams: JoinParams | undefined;
    readonly join = vi.fn(
      (params: JoinParams) =>
        new Promise<JoinResult>((resolve) => {
          this.joinParams = params;
          this.joinStarted.resolve();
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
    it.each([undefined, false, true])(
      'retains sharded HTTP presence with WS opt-in %s',
      async (enabled) => {
        let selected: unknown;
        const presence = new WorkspacePresenceTransport({
          workspaceId: 'workspace-ws' as WorkspaceId,
          presenceShardId: '07',
          createStore: () => new FakePresenceStore(),
          createTransport: (args) => {
            selected = args;
            return new FakePresenceTransport();
          },
        });
        try {
          presence.start({
            baseUrl: 'https://api.streams.test',
            shardHostSuffix: 'streams.test',
            auth: async () => 'token',
            webSocketEnabled: enabled,
          });
          expect(selected).toMatchObject({
            streamUrl: expect.stringContaining('https://presence-07.streams.test/'),
          });
          if (enabled)
            expect(selected).toMatchObject({
              webSocket: {
                enabled: true,
                url: 'https://api.streams.test',
                authPoolKey: 'workspace-ws',
              },
            });
          else expect(selected).not.toHaveProperty('webSocket');
        } finally {
          await presence.stop();
        }
      }
    );
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
          await transport.joinStarted.promise;
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

    describe('publishDesktopForeground', () => {
      const desktopEntriesOf = (store: FakePresenceStore) =>
        Object.values(parseLodyPresenceStates(store.getAllStates())).filter(
          (state) => state.kind === 'desktop-foreground'
        );

      it('keeps a focused desktop fresh for remote Hosts and removes it on blur or teardown', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
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
        try {
          presence.start({ baseUrl: 'https://streams.example.test', auth: async () => 'token' });
          transports[0]?.resolve({ ok: true, value: { unsubscribe: vi.fn() } } as JoinResult);
          await flush();
          transports[0]?.emitStatus('joined');

          presence.publishDesktopForeground('user-1');
          expect(desktopEntriesOf(stores[0]!)).toEqual([
            {
              kind: 'desktop-foreground',
              userId: 'user-1',
              instanceId: expect.any(String),
              updatedAt: 10_000,
            },
          ]);

          // The shared heartbeat keeps it within the freshness window Hosts read.
          vi.advanceTimersByTime(LODY_PRESENCE_HEARTBEAT_MS);
          expect(desktopEntriesOf(stores[0]!)[0]?.updatedAt).toBe(
            10_000 + LODY_PRESENCE_HEARTBEAT_MS
          );

          // Blur deletes it actively instead of waiting for the TTL.
          presence.publishDesktopForeground(null);
          expect(desktopEntriesOf(stores[0]!)).toEqual([]);

          presence.publishDesktopForeground('user-1');
          await presence.stop();
          expect(desktopEntriesOf(stores[0]!)).toEqual([]);
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
        streamUrl:
          'https://presence-07.streams.example.com/ds/lody/workspace-test%3Ameta?ephemeral=presence',
        webSocket: {
          enabled: true,
          url: 'https://api.streams.example.com',
          authPoolKey: 'workspace-test',
        },
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
    it.each(['presence', 'monitor'] as const)(
      '%s fails closed without gateway traffic and reconnects after login rotation',
      async (room) => {
        let login: string | null = null;
        const issuerCredentials: string[] = [];
        const gatewayCredentials: Array<string | null> = [];
        const provider = createLoroStreamsTokenProviderLegacy({
          endpoint: 'https://convex.example.com/api/loro-streams/token',
          workspaceId: 'workspace-test',
          authToken: () => login,
          storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
          fetchImpl: async (_input, init) => {
            const credential = new Headers(init?.headers).get('Authorization')!;
            issuerCredentials.push(credential);
            return credential === 'Bearer denied'
              ? new Response(null, { status: 403 })
              : new Response(JSON.stringify({ token: 'valid-jwt', expiresIn: 900 }));
          },
        });
        vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
          gatewayCredentials.push(new Headers(init?.headers).get('Authorization'));
          return bootstrapResponse(init?.signal);
        });
        const options = {
          workspaceId: 'workspace-test' as WorkspaceId,
          presenceShardId: 7 as const,
        };
        const transport =
          room === 'presence'
            ? new WorkspacePresenceTransport(options)
            : new WorkspaceMachineMonitorTransport(options);
        const detach =
          transport instanceof WorkspaceMachineMonitorTransport
            ? transport.subscribeMachine('machine-test' as MachineId, () => {})
            : () => {};
        const args = {
          baseUrl: 'https://streams.example.com',
          auth: provider.createAuthCallback(),
        };
        const startAndWait = (expected: 'error' | 'synced') => {
          const done = Promise.withResolvers<void>();
          let unsubscribe = () => {};
          transport.start(args);
          unsubscribe = transport.subscribeSyncState((state) => {
            if (state === expected) done.resolve();
          });
          return done.promise.finally(() => unsubscribe());
        };
        try {
          await startAndWait('error');
          expect(transport.needsReconnect()).toBe(true);
          expect(issuerCredentials).toEqual([]);
          expect(gatewayCredentials).toEqual([]);
          login = 'denied';
          await startAndWait('error');
          await startAndWait('error');
          expect(issuerCredentials).toEqual(['Bearer denied']);
          expect(gatewayCredentials).toEqual([]);
          login = 'valid';
          await startAndWait('synced');
          expect(issuerCredentials).toEqual(['Bearer denied', 'Bearer valid']);
          expect(gatewayCredentials.length).toBeGreaterThan(0);
          expect(gatewayCredentials.every((value) => value === 'Bearer valid-jwt')).toBe(true);
        } finally {
          detach();
          await transport.stop();
          await provider.close();
        }
      }
    );

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
        expect(sdkEphemeralOptions.at(-1)).toMatchObject({
          webSocket: {
            enabled: true,
            url: 'https://api.streams.example.com',
            authPoolKey: 'workspace-test',
          },
          streamUrl: expect.stringContaining('https://presence-07.streams.example.com/'),
        });
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

describe('desktop-foreground-presence', () => {
  const createEnv = (start: number) => {
    let foreground = true;
    let now = start;
    const listeners: {
      onFocusChange: () => void;
      onInput: () => void;
      onPowerState: (state: ElectronPowerState) => void;
    } = { onFocusChange: () => {}, onInput: () => {}, onPowerState: () => {} };
    return {
      env: {
        isForeground: () => foreground,
        now: () => now,
        subscribe: (next: typeof listeners) => {
          Object.assign(listeners, next);
          return () => {};
        },
      },
      setForeground(value: boolean) {
        foreground = value;
        listeners.onFocusChange();
      },
      input() {
        listeners.onInput();
      },
      power(state: ElectronPowerState) {
        listeners.onPowerState(state);
      },
      advance(ms: number) {
        now += ms;
        vi.advanceTimersByTime(ms);
      },
    };
  };

  it('suppresses mobile pushes only while this desktop is focused, collapsing focus flapping', () => {
    vi.useFakeTimers();
    try {
      const harness = createEnv(0);
      const published: (string | null)[] = [];
      const stop = startDesktopForegroundPublisher({
        userId: 'user-1',
        publish: (value) => published.push(value),
        env: harness.env,
      });
      expect(published).toEqual(['user-1']);

      // Rapid alt-tab produces no presence write until focus settles.
      harness.setForeground(false);
      harness.setForeground(true);
      harness.setForeground(false);
      harness.advance(DESKTOP_FOREGROUND_DEBOUNCE_MS);
      expect(published).toEqual(['user-1', null]);

      harness.setForeground(true);
      harness.advance(DESKTOP_FOREGROUND_DEBOUNCE_MS);
      expect(published).toEqual(['user-1', null, 'user-1']);

      stop();
      expect(published).toEqual(['user-1', null, 'user-1', null]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the phone ring again when a focused desktop has had no input (locked or abandoned)', () => {
    vi.useFakeTimers();
    try {
      const harness = createEnv(0);
      const published: (string | null)[] = [];
      const stop = startDesktopForegroundPublisher({
        userId: 'user-1',
        publish: (value) => published.push(value),
        env: harness.env,
      });
      harness.advance(DESKTOP_FOREGROUND_IDLE_MS + 15_000);
      expect(published).toEqual(['user-1', null]);

      // Returning to the keyboard restores suppression.
      harness.input();
      harness.advance(DESKTOP_FOREGROUND_DEBOUNCE_MS);
      expect(published).toEqual(['user-1', null, 'user-1']);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the phone ring immediately when the computer sleeps or locks, and only after unlock resumes suppression', () => {
    vi.useFakeTimers();
    try {
      const harness = createEnv(0);
      const published: (string | null)[] = [];
      const stop = startDesktopForegroundPublisher({
        userId: 'user-1',
        publish: (value) => published.push(value),
        env: harness.env,
      });
      // Withdrawn without waiting for the debounce or the presence TTL.
      harness.power('lock-screen');
      expect(published).toEqual(['user-1', null]);
      harness.power('suspend');
      // Waking from sleep while the screen is still locked does not suppress again.
      harness.power('resume');
      harness.advance(DESKTOP_FOREGROUND_DEBOUNCE_MS);
      expect(published).toEqual(['user-1', null]);
      harness.power('unlock-screen');
      harness.input();
      harness.advance(DESKTOP_FOREGROUND_DEBOUNCE_MS);
      expect(published).toEqual(['user-1', null, 'user-1']);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
