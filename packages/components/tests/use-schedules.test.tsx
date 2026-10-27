// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import { activeWorkspaceRuntimeAtom } from '../src/atoms/runtime';
import { scheduleRegistryAtom } from '../src/atoms/schedules';
import { useScheduleRegistrySync, useSchedules } from '../src/hooks/use-schedules';

const scope = vi.hoisted(() => ({ workspaceId: 'workspace-a', enabled: true }));
vi.mock('../src/atoms/runtime', async () => {
  const { atom } = await import('jotai');
  return { activeWorkspaceRuntimeAtom: atom(null) };
});
vi.mock('../src/hooks/use-resolved-workspace-scope', () => ({
  useResolvedWorkspaceScope: () => scope,
}));
vi.mock('../src/lib/client-log', () => ({ recordClientError: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const row = {
  scheduleId: 'schedule-a',
  title: 'Saved task',
  ownerId: 'owner',
  machineId: 'machine',
  enabled: true,
  activationId: 'activation',
  activeFrom: 0,
  createdAt: 0,
  updatedAt: 0,
  trigger: { kind: 'manual' },
  destination: { kind: 'new_session' },
  elevatedPermissions: false,
  agentConfigId: 'agent',
  definitionFingerprint: '0'.repeat(64),
};

function harness(workspaceId = 'workspace-a', initialRows = [row]) {
  let rows = initialRows;
  let openFailure = false;
  let scanFailure = false;
  let pendingOpen: ReturnType<typeof deferred> | undefined;
  let pendingJoin: ReturnType<typeof deferred> | undefined;
  const listeners = new Set<() => void>();
  const rooms = new Set<object>();
  const syncs: ReturnType<typeof deferred>[] = [];
  let opens = 0;
  const runtime = {
    workspaceId,
    contentMode: 'plaintext',
    repo: {
      openFlockDoc: async () => {
        opens++;
        if (pendingOpen) await pendingOpen.promise;
        if (openFailure) throw new Error('open failed');
        return {
          flock: {
            scan: () => {
              if (scanFailure) throw new Error('scan failed');
              return rows.map((value) => ({ key: ['schedule', value.scheduleId], value }));
            },
            subscribe: (listener: () => void) => {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          },
          joinRoom: async () => {
            if (pendingJoin) await pendingJoin.promise;
            const sync = deferred();
            syncs.push(sync);
            const room = {
              transportIds: () => ['local', 'cloud'],
              subscription: (id: string) => {
                if (id !== 'local') throw new Error('wrong readiness transport');
                return { firstSyncedWithRemote: sync.promise };
              },
              get firstSyncedWithRemote(): never {
                throw new Error('ambiguous readiness');
              },
              unsubscribe: () => {
                rooms.delete(room);
              },
            };
            rooms.add(room);
            return room;
          },
        };
      },
    },
  } as unknown as WorkspaceRuntime;
  return {
    runtime,
    syncs,
    rooms,
    listeners,
    get opens() {
      return opens;
    },
    failOpen: (value: boolean) => {
      openFailure = value;
    },
    failScan: (value: boolean) => {
      scanFailure = value;
    },
    holdOpen: () => {
      pendingOpen = deferred();
      return pendingOpen;
    },
    holdJoin: () => {
      pendingJoin = deferred();
      return pendingJoin;
    },
    replaceRows: (value: typeof rows) => {
      rows = value;
      listeners.forEach((listener) => listener());
    },
  };
}

function Host() {
  useScheduleRegistrySync();
  const schedules = useSchedules();
  return <button onClick={schedules.onRetry}>Retry</button>;
}

describe('Schedule Registry recovery', () => {
  let root: Root;
  let container: HTMLDivElement;
  let store: ReturnType<typeof createStore>;
  const snapshot = () => store.get(scheduleRegistryAtom);
  const mount = async (h: ReturnType<typeof harness>) => {
    await act(async () => {
      store.set(activeWorkspaceRuntimeAtom, h.runtime);
      root.render(
        <Provider store={store}>
          <Host />
        </Provider>
      );
    });
  };
  beforeEach(() => {
    vi.useFakeTimers();
    scope.workspaceId = 'workspace-a';
    store = createStore();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('retains readable rows on sync failure and recovers without remounting', async () => {
    const h = harness();
    await mount(h);
    expect(snapshot().rows.map((item) => item.title)).toEqual(['Saved task']);
    await act(async () => h.syncs[0]!.reject(new Error('network_error')));
    expect(snapshot()).toMatchObject({ ready: true, error: 'REGISTRY_UNAVAILABLE', rows: [row] });
    expect(h.listeners.size).toBe(1);
    expect(h.rooms.size).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => {
      h.replaceRows([{ ...row, title: 'Synced task' }]);
      h.syncs[1]!.resolve();
    });
    expect(snapshot().rows[0]!.title).toBe('Synced task');
    expect(snapshot().error).toBeUndefined();
    expect(snapshot().retrying).toBe(false);
    expect(h.listeners.size).toBe(1);
    expect(h.rooms.size).toBe(1);
  });

  it('does not claim an empty registry before first sync, including after a cold open failure', async () => {
    const h = harness('workspace-a', []);
    h.failOpen(true);
    await mount(h);
    expect(snapshot().error).toBe('REGISTRY_UNAVAILABLE');
    h.failOpen(false);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(snapshot().error).toBe('REGISTRY_UNAVAILABLE');
    await act(async () => h.syncs[0]!.resolve());
    expect(snapshot()).toMatchObject({ rows: [], ready: true, retrying: false });
    expect(snapshot().error).toBeUndefined();
  });

  it('releases an unreadable local subscription and retries after the scan recovers', async () => {
    const h = harness();
    h.failScan(true);
    await mount(h);
    expect(snapshot().error).toBe('REGISTRY_UNAVAILABLE');
    expect(h.listeners.size).toBe(0);
    expect(h.rooms.size).toBe(0);
    h.failScan(false);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => h.syncs[0]!.resolve());
    expect(snapshot().rows[0]!.title).toBe('Saved task');
    expect(snapshot().error).toBeUndefined();
    expect(h.listeners.size).toBe(1);
    expect(h.rooms.size).toBe(1);
  });

  it('keeps a cold empty scan loading until first sync confirms it', async () => {
    const h = harness('workspace-a', []);
    await mount(h);
    expect(snapshot().ready).toBe(false);
    await act(async () => h.syncs[0]!.resolve());
    expect(snapshot().ready).toBe(true);
  });

  it('bounds automatic retries, then allows explicit retry to restore the list', async () => {
    const h = harness();
    h.failOpen(true);
    await mount(h);
    for (const delay of [1000, 3000, 10000, 60000]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
    }
    expect(h.opens).toBe(4);
    expect(snapshot()).toMatchObject({ error: 'REGISTRY_UNAVAILABLE', retrying: false });
    h.failOpen(false);
    await act(async () => container.querySelector('button')!.click());
    await act(async () => h.syncs[0]!.resolve());
    expect(snapshot().rows[0]!.title).toBe('Saved task');
    expect(snapshot().error).toBeUndefined();
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(h.opens).toBe(5);
  });

  it('keeps local pause, deletion and creation visible after remote retries are exhausted', async () => {
    const h = harness();
    await mount(h);
    for (let attempt = 0; attempt < 4; attempt++) {
      await act(async () => h.syncs[attempt]!.reject(new Error('network_error')));
      if (attempt < 3) {
        await act(async () => vi.advanceTimersByTimeAsync([1000, 3000, 10000][attempt]!));
      }
    }
    expect(h.rooms.size).toBe(0);
    expect(h.listeners.size).toBe(1);
    await act(async () => h.replaceRows([{ ...row, enabled: false }]));
    expect(snapshot().rows[0]!.enabled).toBe(false);
    expect(snapshot()).toMatchObject({ error: 'REGISTRY_UNAVAILABLE', retrying: false });
    await act(async () => h.replaceRows([]));
    expect(snapshot().rows).toEqual([]);
    expect(snapshot().error).toBe('REGISTRY_UNAVAILABLE');
    await act(async () => h.replaceRows([{ ...row, scheduleId: 'new-task', title: 'New task' }]));
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(snapshot().rows[0]!.title).toBe('New task');
    expect(snapshot()).toMatchObject({ error: 'REGISTRY_UNAVAILABLE', retrying: false });
    expect(h.syncs.length).toBe(4);
    await act(async () => container.querySelector('button')!.click());
    expect(snapshot().error).toBe('REGISTRY_UNAVAILABLE');
    expect(snapshot().retrying).toBe(true);
    await act(async () => h.syncs[4]!.resolve());
    expect(snapshot().error).toBeUndefined();
    expect(snapshot().retrying).toBe(false);
    expect(h.listeners.size).toBe(1);
    expect(h.rooms.size).toBe(1);
  });

  it('retries on network restoration instead of waiting for the scheduled delay', async () => {
    const h = harness();
    await mount(h);
    await act(async () => h.syncs[0]!.reject(new Error('network_error')));
    await act(async () => window.dispatchEvent(new Event('online')));
    await act(async () => h.syncs[1]!.resolve());
    expect(snapshot().error).toBeUndefined();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(h.rooms.size).toBe(1);
    expect(h.opens).toBe(1);
  });

  it.each(['open', 'join', 'sync'] as const)(
    'fences a late %s result after workspace change',
    async (stage) => {
      const old = harness();
      const pending = stage === 'open' ? old.holdOpen() : stage === 'join' ? old.holdJoin() : null;
      await mount(old);
      const next = harness('workspace-b', [{ ...row, title: 'Workspace B task' }]);
      scope.workspaceId = 'workspace-b';
      await mount(next);
      await act(async () => {
        if (pending) pending.resolve();
        else old.syncs[0]!.resolve();
        next.syncs[0]!.resolve();
      });
      expect(snapshot().workspaceId).toBe('workspace-b');
      expect(snapshot().rows[0]!.title).toBe('Workspace B task');
      expect(old.listeners.size).toBe(0);
      expect(old.rooms.size).toBe(0);
      act(() => root.unmount());
      expect(next.listeners.size).toBe(0);
      expect(next.rooms.size).toBe(0);
    }
  );
});
