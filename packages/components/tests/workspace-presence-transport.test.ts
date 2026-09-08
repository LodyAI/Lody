import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LORO_STREAMS_BASE_URL,
  LODY_PRESENCE_CHANNEL,
  LODY_PRESENCE_HEARTBEAT_MS,
  getLodyMachinePresenceKey,
  parseLodyPresenceStates,
  type LodyPresenceInstanceId,
  type MachineId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import {
  WorkspacePresenceTransport,
  type PresenceStoreLike,
  type PresenceTransportLike,
} from '../src/providers/workspace-presence-transport';

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
  afterEach(() => {
    if (typeof window !== 'undefined') {
      delete window.lodyPresence;
    }
  });

  it('emits parsed snapshots from the ephemeral store and keeps them on stop', async () => {
    const stores: FakePresenceStore[] = [];
    const transports: FakePresenceTransport[] = [];
    const snapshots: unknown[] = [];
    const presence = new WorkspacePresenceTransport({
      workspaceId: 'workspace-1' as WorkspaceId,
      onSnapshot: (states) => snapshots.push(states),
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
    const machineId = 'machine-1' as MachineId;
    const instanceId = 'instance-1' as LodyPresenceInstanceId;
    const key = getLodyMachinePresenceKey(machineId, instanceId);
    stores[0]?.setStates({
      [key]: {
        kind: 'machine',
        machineId,
        instanceId,
        updatedAt: 100,
      },
      invalid: {
        kind: 'machine',
        machineId,
        instanceId,
        updatedAt: Number.NaN,
      },
    });

    expect(snapshots.at(-1)).toEqual({
      [key]: {
        kind: 'machine',
        machineId,
        instanceId,
        updatedAt: 100,
      },
    });

    await presence.stop();

    expect(snapshots.at(-1)).toEqual({
      [key]: {
        kind: 'machine',
        machineId,
        instanceId,
        updatedAt: 100,
      },
    });
    expect(presence.getSyncState()).toBe('idle');
    expect(transports[0]?.close).toHaveBeenCalledTimes(1);
    expect(stores[0]?.destroy).toHaveBeenCalledTimes(1);
  });

  it('exposes the current ephemeral store on window for debugging', async () => {
    const { target: testWindow, restore } = installTestWindow();
    const stores: FakePresenceStore[] = [];
    const transports: FakePresenceTransport[] = [];
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
    });

    try {
      presence.start({ baseUrl: DEFAULT_LORO_STREAMS_BASE_URL, auth: async () => 'token' });

      const debug = testWindow.lodyPresence;
      expect(debug?.workspaceId).toBe('workspace-1');
      expect(debug?.presenceShardId).toBe('03');
      expect(debug?.store).toBe(stores[0]);
      expect(debug?.streamUrl).toContain('ephemeral=presence');

      const machineId = 'machine-1' as MachineId;
      const instanceId = 'instance-1' as LodyPresenceInstanceId;
      const key = getLodyMachinePresenceKey(machineId, instanceId);
      const state = {
        kind: 'machine',
        machineId,
        instanceId,
        updatedAt: 100,
      };
      stores[0]?.setStates({ [key]: state });

      expect(debug?.getAllStates()).toEqual({ [key]: state });
      expect(debug?.getParsedStates()).toEqual({ [key]: state });

      await presence.stop();

      expect(debug?.store).toBeNull();
      expect(debug?.streamUrl).toBeNull();
      expect(debug?.getAllStates()).toEqual({});
      expect(transports[0]?.close).toHaveBeenCalledTimes(1);
    } finally {
      await presence.stop();
      restore();
    }
  });

  it('unsubscribes a stale join result without closing the same resources twice', async () => {
    const stores: FakePresenceStore[] = [];
    const transports: FakePresenceTransport[] = [];
    const unsubscribe = vi.fn();
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

    presence.start({ baseUrl: 'https://streams.example.test', auth: async () => 'token-1' });
    presence.start({ baseUrl: 'https://streams.example.test', auth: async () => 'token-2' });
    transports[0]?.resolve({ ok: true, value: { unsubscribe } } as JoinResult);
    await flush();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(transports[0]?.close).toHaveBeenCalledTimes(1);
    expect(stores[0]?.destroy).toHaveBeenCalledTimes(1);
  });

  it('tracks room-sync state across join, status changes, and stop', async () => {
    const transports: FakePresenceTransport[] = [];
    const states: string[] = [];
    const presence = new WorkspacePresenceTransport({
      workspaceId: 'workspace-1' as WorkspaceId,
      createStore: () => new FakePresenceStore(),
      createTransport: () => {
        const transport = new FakePresenceTransport();
        transports.push(transport);
        return transport;
      },
    });
    presence.subscribeSyncState((state) => states.push(state));
    expect(presence.getSyncState()).toBe('idle');
    expect(presence.needsReconnect()).toBe(false);

    presence.start({ baseUrl: 'https://streams.example.test', auth: async () => 'token' });
    expect(presence.getSyncState()).toBe('connecting');

    transports[0]?.resolve({ ok: true, value: { unsubscribe: vi.fn() } } as JoinResult);
    await flush();
    transports[0]?.emitStatus('joined');
    expect(presence.getSyncState()).toBe('synced');
    expect(presence.needsReconnect()).toBe(false);

    transports[0]?.emitStatus('reconnecting');
    expect(presence.getSyncState()).toBe('reconnecting');
    expect(presence.needsReconnect()).toBe(false);

    // Terminal read-loop death (e.g. 401 after sleep): must flag reconnect.
    transports[0]?.emitStatus('error');
    expect(presence.getSyncState()).toBe('error');
    expect(presence.needsReconnect()).toBe(true);

    await presence.stop();
    expect(presence.getSyncState()).toBe('idle');
    expect(presence.needsReconnect()).toBe(false);
    expect(states).toEqual(['idle', 'connecting', 'synced', 'reconnecting', 'error', 'idle']);
  });

  it('requests an external-wake restart when the synced presence stream is stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
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

    try {
      presence.start({ baseUrl: 'https://streams.example.test', auth: async () => 'token' });
      transports[0]?.resolve({ ok: true, value: { unsubscribe: vi.fn() } } as JoinResult);
      await flush();
      transports[0]?.emitStatus('joined');
      expect(presence.getSyncState()).toBe('synced');
      expect(presence.shouldRestartOnExternalWake()).toBe(false);

      vi.setSystemTime(1_000 + LODY_PRESENCE_HEARTBEAT_MS * 2);
      expect(presence.shouldRestartOnExternalWake()).toBe(true);
    } finally {
      await presence.stop();
      vi.useRealTimers();
    }
  });

  it('flags needsReconnect when the initial join fails instead of only warning', async () => {
    const transports: FakePresenceTransport[] = [];
    const warnings: string[] = [];
    const presence = new WorkspacePresenceTransport({
      workspaceId: 'workspace-1' as WorkspaceId,
      onWarning: (message) => warnings.push(message),
      createStore: () => new FakePresenceStore(),
      createTransport: () => {
        const transport = new FakePresenceTransport();
        transports.push(transport);
        return transport;
      },
    });

    presence.start({ baseUrl: 'https://streams.example.test', auth: async () => 'token' });
    transports[0]?.resolve({ ok: false, error: new Error('auth_failed') } as JoinResult);
    await flush();

    expect(presence.getSyncState()).toBe('error');
    expect(presence.needsReconnect()).toBe(true);
    expect(warnings.some((message) => message.includes('failed to join presence room'))).toBe(true);

    // Restart (what the reconnect loop does) resets to connecting and a
    // successful join recovers.
    presence.start({ baseUrl: 'https://streams.example.test', auth: async () => 'token' });
    expect(presence.getSyncState()).toBe('connecting');
    transports[1]?.resolve({ ok: true, value: { unsubscribe: vi.fn() } } as JoinResult);
    await flush();
    transports[1]?.emitStatus('joined');
    expect(presence.getSyncState()).toBe('synced');
    expect(presence.needsReconnect()).toBe(false);
    await presence.stop();
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

  it('defaults to a valid random presence shard host when none is provided', () => {
    const streamUrls: string[] = [];
    const presence = new WorkspacePresenceTransport({
      workspaceId: 'workspace-1' as WorkspaceId,
      createStore: () => new FakePresenceStore(),
      createTransport: ({ streamUrl }) => {
        streamUrls.push(streamUrl);
        return new FakePresenceTransport();
      },
    });

    presence.start({ baseUrl: DEFAULT_LORO_STREAMS_BASE_URL, auth: async () => 'token' });

    const url = new URL(streamUrls[0] ?? '');
    expect(url.origin).toMatch(/^https:\/\/presence-\d{2}\.streams\.invalid$/);
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
      expect(warnings.some((message) => message.includes('restarting stalled presence room'))).toBe(
        true
      );
    } finally {
      await presence.stop();
      vi.useRealTimers();
    }
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

    it('re-asserts the viewing entry after a room restart and deletes it on stop', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(50_000);
      try {
        const { presence, stores } = setup();
        presence.publishSessionViewing({ sessionId: 'session-1' as SessionId, userId: 'user-1' });
        expect(viewingEntriesOf(stores[0]!)).toHaveLength(1);

        // Restart creates a fresh store: local viewing state must be re-asserted.
        presence.start({ baseUrl: 'https://streams.example.test', auth: async () => 'token' });
        expect(stores).toHaveLength(2);
        const restartedEntry = viewingEntriesOf(stores[1]!);
        expect(restartedEntry).toHaveLength(1);
        expect(restartedEntry[0]).toMatchObject({ sessionId: 'session-1', since: 50_000 });

        await presence.stop();
        expect(viewingEntriesOf(stores[1]!)).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
