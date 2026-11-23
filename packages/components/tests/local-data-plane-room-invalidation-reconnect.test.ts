/**
 * `LocalLoroDataPlaneServerLegacy.invalidateDocRoom` drops the room whose cached
 * `LoroDoc` the repo just evicted. Inbound sync repairs itself (the next
 * `update`/`join` rebuilds the room), but OUTBOUND sync does not: once the entry
 * is gone there is no subscriber left to mark dirty, so a renderer that is only
 * READING a session gets nothing more until it re-joins.
 *
 * Recovery therefore hinges entirely on the room status the server publishes,
 * and this file pins both halves of that contract:
 *
 *  - the status must be TERMINAL (`disconnected`/`error`). The first version of
 *    this fix published `reconnecting`, which reads as "already recovering":
 *    `createRoomSyncTracker.needsReconnect()` stays false, so the workspace
 *    reconnect loop never fires and outbound sync stays dead. That defect was
 *    invisible to the data-plane regression suite because those tests called
 *    `adapter.reconnect()` by hand, standing in for the loop instead of
 *    exercising what decides whether the loop runs at all.
 *  - the repair must be ROOM-SCOPED. `LocalLoroTransportAdapter` re-joins that
 *    one room itself, so a routine session GC does not drag the workspace loop
 *    in — which would release every idle document store, rejoin every local
 *    room, and charge a backoff step forgiven only after 30s of health.
 *
 * The chain under test is the real one: engine -> `room-status` frame ->
 * `LocalLoroTransportAdapter` -> real `createRoomSyncTracker` -> real
 * `createRoomSyncRegistry` -> the exact predicate the loop gates on.
 */
/**
 * `LocalLoroDataPlaneServerLegacy.invalidateDocRoom` drops the room whose cached
 * `LoroDoc` the repo just evicted. Inbound sync repairs itself (the next
 * `update`/`join` rebuilds the room), but OUTBOUND sync does not: once the entry
 * is gone there is no subscriber left to mark dirty, so a renderer that is only
 * READING a session gets nothing more until it re-joins.
 *
 * Recovery therefore hinges entirely on the room status the server publishes,
 * and this file pins both halves of that contract:
 *
 *  - the status must be TERMINAL (`disconnected`/`error`). The first version of
 *    this fix published `reconnecting`, which reads as "already recovering":
 *    `createRoomSyncTracker.needsReconnect()` stays false, so the workspace
 *    reconnect loop never fires and outbound sync stays dead. That defect was
 *    invisible to the data-plane regression suite because those tests called
 *    `adapter.reconnect()` by hand, standing in for the loop instead of
 *    exercising what decides whether the loop runs at all.
 *  - the repair must be ROOM-SCOPED. `LocalLoroTransportAdapter` re-joins that
 *    one room itself, so a routine session GC does not drag the workspace loop
 *    in — which would release every idle document store, rejoin every local
 *    room, and charge a backoff step forgiven only after 30s of health.
 *
 * The chain under test is the real one: engine -> `room-status` frame ->
 * `LocalLoroTransportAdapter` -> real `createRoomSyncTracker` -> real
 * `createRoomSyncRegistry` -> the exact predicate the loop gates on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoTransportRoomEntry } from 'loro-repo';
import { createCloudRoomRecovery } from '../src/providers/cloud-room-recovery';
import { createLocalReconnectLoop } from '../src/providers/local-reconnect-loop';
import { Effect, Layer } from 'effect';
import { LocalLoroWriterTurn } from '@lody/shared/local-loro-writer';
import { makeLocalLoroWriterLegacy } from '@lody/shared/local-loro-writer/legacy';
import { LoroDoc } from 'loro-crdt';
import {
  type LocalLoroDataPlaneClientMessage,
  type LocalLoroDataPlaneServerMessage,
} from '@lody/shared/local-loro-data-plane';
import { LocalLoroDataPlaneServerLegacy } from '@lody/shared/local-loro-data-plane-server';
import { LocalLoroTransportAdapter } from '@lody/shared/local-loro-transport';

import { createRoomSyncTracker } from '../src/providers/room-sync-tracker';
import { createRoomSyncRegistry } from '../src/providers/room-sync-registry';

const DOC_ID = 'session-doc-1';
const WORKSPACE_ID = 'ws-1';
const harnesses = new Set<Harness>();
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  try {
    await Promise.all([...harnesses].map((harness) => harness.close()));
  } finally {
    harnesses.clear();
    vi.useRealTimers();
  }
});

/**
 * Renderer adapter <-> CLI engine over one connection, with a drain queue that
 * stands in for the relay's async delivery. Host turns use the fake clock.
 */
class Harness {
  private readonly tasks: Array<() => void | Promise<void>> = [];
  private readonly writerLegacy = makeLocalLoroWriterLegacy(
    Layer.succeed(LocalLoroWriterTurn, {
      next: Effect.callback<void>((resume) => {
        const handle = setTimeout(() => resume(Effect.void), 0);
        return Effect.sync(() => clearTimeout(handle));
      }),
    })
  );
  private readonly adapters = new Set<LocalLoroTransportAdapter>();
  constructor() {
    harnesses.add(this);
  }
  async close(): Promise<void> {
    await Promise.all([...this.adapters].map((adapter) => adapter.close()));
    await this.engine.disposeLegacy();
    await this.writerLegacy.closeLegacy();
    this.tasks.length = 0;
  }
  private readonly rendererListeners = new Set<(m: LocalLoroDataPlaneServerMessage) => void>();
  readonly serverDocs = new Map<string, LoroDoc>();
  /**
   * The Electron relay swallows client frames when its socket is down while the
   * renderer still reports connected (`loro-data-plane-relay.ts`).
   */
  dropClientFrames = false;

  private readonly pushed: LocalLoroDataPlaneServerMessage[] = [];

  private readonly connection = {
    id: 'dp:test:1',
    send: (message: LocalLoroDataPlaneServerMessage) => {
      this.pushed.push(message);
      this.tasks.push(() => {
        for (const listener of this.rendererListeners) listener(message);
      });
    },
  };

  /** Statuses of every `room-status` frame written, in order. */
  framesOfType(type: 'room-status'): string[] {
    return this.pushed.filter((m) => m.type === type).map((m) => m.status);
  }

  readonly engine = new LocalLoroDataPlaneServerLegacy({
    workspaceId: WORKSPACE_ID,
    resolveDoc: async (docId) => this.serverDoc(docId),
    resolveFlockDoc: async () => {
      throw new Error('no flock rooms in this test');
    },
    writerLegacy: this.writerLegacy,
  });

  serverDoc(docId: string): LoroDoc {
    const existing = this.serverDocs.get(docId);
    if (existing) return existing;
    const doc = new LoroDoc();
    this.serverDocs.set(docId, doc);
    return doc;
  }

  /** Models `repo.unloadDoc`: persist, then hand out a different instance. */
  unloadServerDoc(docId: string): void {
    const previous = this.serverDocs.get(docId);
    if (!previous) return;
    const reloaded = new LoroDoc();
    reloaded.import(previous.export({ mode: 'snapshot' }));
    this.serverDocs.set(docId, reloaded);
  }

  createAdapter(peerId: string): LocalLoroTransportAdapter {
    const adapter = new LocalLoroTransportAdapter({
      workspaceId: WORKSPACE_ID,
      peerId,
      connection: {
        send: (message: LocalLoroDataPlaneClientMessage) => {
          if (this.dropClientFrames) return;
          this.tasks.push(async () => {
            if (message.type === 'ping') return;
            await this.engine.handleMessage(this.connection, message);
          });
        },
        onMessage: (listener: (m: LocalLoroDataPlaneServerMessage) => void) => {
          this.rendererListeners.add(listener);
          return () => this.rendererListeners.delete(listener);
        },
        onStatusChange: () => () => {},
        isConnected: () => true,
      },
    });
    this.adapters.add(adapter);
    return adapter;
  }

  async settle(): Promise<void> {
    for (let round = 0; round < 200; round += 1) {
      if (this.tasks.length === 0) {
        await vi.advanceTimersByTimeAsync(1);
        if (this.tasks.length === 0) return;
      }
      for (const task of this.tasks.splice(0)) await task();
      await vi.advanceTimersByTimeAsync(1);
    }
    throw new Error('settle_did_not_converge');
  }
}

/**
 * The production wiring: each durable room gets a real tracker registered in the
 * real registry, and the local reconnect loop's `hasProblem` is
 * `anyNeedsReconnect(isLocalHealthRoom)` (create-workspace-runtime.ts).
 */
function trackRoom(subscription: ReturnType<LocalLoroTransportAdapter['joinDocRoom']>) {
  const registry = createRoomSyncRegistry({ clock: { now: () => 0 } });
  const tracker = createRoomSyncTracker(DOC_ID);
  const untrack = registry.track(tracker);
  tracker.attach(subscription);
  // A room the renderer has already synced once — the state this bug strikes in.
  tracker.markFirstSynced();
  return {
    registry,
    tracker,
    untrack,
    /** Exactly what `createLocalReconnectLoop({ hasProblem })` evaluates. */
    loopWouldFire: () => registry.anyNeedsReconnect(() => true),
  };
}

describe('invalidateDocRoom recovery is room-scoped', () => {
  it('repairs the invalidated room without leaving work for the workspace loop', async () => {
    const harness = new Harness();
    const renderer = harness.createAdapter('renderer:1');
    const doc = new LoroDoc();
    const subscription = renderer.joinDocRoom(DOC_ID, doc);
    await harness.settle();

    const tracked = trackRoom(subscription);
    expect(subscription.status).toBe('joined');
    expect(tracked.loopWouldFire()).toBe(false);

    // Session GC evicted the doc; the room is now holding an orphan.
    harness.unloadServerDoc(DOC_ID);
    harness.engine.invalidateDocRoom(DOC_ID);
    await harness.settle();

    // The adapter repaired this one room itself. Nobody called
    // `adapter.reconnect()` and no workspace-level reconcile was needed.
    expect(subscription.status).toBe('joined');
    expect(tracked.loopWouldFire()).toBe(false);

    // And the repaired room is bound to the repo's CURRENT instance.
    const current = harness.serverDoc(DOC_ID);
    current.getText('t').insert(current.getText('t').length, 'cli-write');
    current.commit();
    await harness.settle();
    expect(doc.getText('t').toString()).toBe('cli-write');

    tracked.untrack();
    tracked.tracker.dispose();
  });
});

describe('renderer cloud room recovery', () => {
  const createFixture = () => {
    const transfers: Array<{ room: string; at: number }> = [];
    const globalResets: boolean[] = [];
    const rooms: RepoTransportRoomEntry[] = [];
    const addRoom = (id: string, kind: 'doc' | 'flock' = 'doc') => {
      const state = { status: 'error' as 'error' | 'joined' | 'disconnected', fail: true };
      const entry = {
        room: { kind, id },
        subscription: {
          get status() {
            return state.status;
          },
          async rejoin() {
            transfers.push({ room: `${kind}:${id}`, at: Date.now() });
            if (!state.fail) state.status = 'joined';
          },
        },
      } as RepoTransportRoomEntry;
      rooms.push(entry);
      return state;
    };
    const recovery = createCloudRoomRecovery({
      listRooms: () => rooms,
      reconnect: async (force) => {
        globalResets.push(force);
        // Adapter reconnect would revive ALL broken sessions, even when false.
        for (const entry of rooms) {
          if (entry.subscription.status === 'error') await entry.subscription.rejoin();
        }
      },
      rejoin: (entry) => entry.subscription.rejoin(),
      isClosing: () => false,
    });
    return { addRoom, recovery, transfers, globalResets, rooms };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('backs off persistent full-stream reads to five minutes and isolates kind:id', async () => {
    const f = createFixture();
    f.addRoom('large');
    const intervals = [30_000, 60_000, 120_000, 240_000, 300_000, 300_000];
    for (const interval of intervals) {
      await f.recovery.recover(false);
      const before = f.transfers.length;
      expect(f.recovery.getRetryDelayMs(30_000)).toBe(interval);
      vi.setSystemTime(Date.now() + interval - 1);
      await f.recovery.recover(false);
      expect(f.transfers.length).toBe(before);
      vi.setSystemTime(Date.now() + 1);
    }
    vi.setSystemTime(Date.now() - 1);
    f.addRoom('large', 'flock');
    await f.recovery.recover(false);
    expect(f.transfers.at(-1)?.room).toBe('flock:large');
    expect(f.globalResets).toEqual([]);
  });

  it('clears recovered and removed rooms while letting new failures and disconnected rooms recover', async () => {
    const f = createFixture();
    const old = f.addRoom('old');
    await f.recovery.recover(false);
    vi.setSystemTime(30_000);
    await f.recovery.recover(false);
    f.addRoom('new').fail = false;
    const disconnected = f.addRoom('disconnected');
    disconnected.status = 'disconnected';
    disconnected.fail = false;
    await f.recovery.recover(false);
    expect(f.transfers.map((entry) => entry.room)).toEqual([
      'doc:old',
      'doc:old',
      'doc:new',
      'doc:disconnected',
    ]);
    expect(f.rooms.slice(1).map((entry) => entry.subscription.status)).toEqual([
      'joined',
      'joined',
    ]);
    old.status = 'joined';
    f.recovery.update();
    old.status = 'error';
    await f.recovery.recover(false);
    expect(f.recovery.getRetryDelayMs(30_000)).toBe(30_000);
    f.rooms.splice(0, 1);
    f.recovery.update();
    f.addRoom('old');
    await f.recovery.recover(false);
    expect(f.transfers.at(-1)).toEqual({ room: 'doc:old', at: 30_000 });
  });

  it('does not charge untouched rooms when the sweep exhausts its time budget', async () => {
    const f = createFixture();
    for (let i = 0; i < 9; i++) f.addRoom(String(i));
    for (const entry of f.rooms.slice(0, 4)) {
      const rejoin = entry.subscription.rejoin;
      entry.subscription.rejoin = async () => {
        await rejoin();
        vi.setSystemTime(Date.now() + 7_500);
      };
    }
    await f.recovery.recover(false);
    expect(f.transfers.map((entry) => entry.room)).toEqual(['doc:0', 'doc:1', 'doc:2', 'doc:3']);
    expect(f.recovery.getRetryDelayMs(0)).toBe(0);
    await f.recovery.recover(false);
    expect(f.transfers.slice(4, 9).map((entry) => entry.room)).toEqual([
      'doc:4',
      'doc:5',
      'doc:6',
      'doc:7',
      'doc:8',
    ]);
  });

  it.each(['visibility-wake', 'network-online', 'token-refresh'] as const)(
    'sleeps to the room deadline, admits a new room early, and honors %s',
    async (reason) => {
      const f = createFixture();
      f.addRoom('stuck');
      let runs = 0;
      const loop = createLocalReconnectLoop({
        canRun: () => true,
        hasProblem: () => {
          f.recovery.update();
          return f.rooms.some((entry) => entry.subscription.status === 'error');
        },
        reconnect: async ({ force }) => {
          runs++;
          await f.recovery.recover(force);
        },
        getRetryDelayMs: (delay) => f.recovery.getRetryDelayMs(delay),
        computeDelayMs: () => 30_000,
        onStateChange: () => {},
      });
      try {
        loop.update();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(f.transfers.map((entry) => entry.at)).toEqual([0, 30_000]);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(runs).toBe(2); // No empty sweep at the old 30s cadence.
        await vi.advanceTimersByTimeAsync(30_000); // third attempt; next due at 210s
        await vi.advanceTimersByTimeAsync(30_000); // 120s: a new failure arrives
        f.addRoom('new').fail = false;
        loop.update();
        await vi.advanceTimersByTimeAsync(30_000); // 150s, before the old 210s wait
        expect(f.transfers.at(-1)).toEqual({ room: 'doc:new', at: 150_000 });
        expect(f.rooms[1].subscription.status).toBe('joined');
        const before = f.transfers.length;
        loop.trigger(reason);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.transfers.length).toBeGreaterThan(before);
        expect(f.globalResets).toEqual([true]);
        expect(f.recovery.getRetryDelayMs(30_000)).toBeGreaterThan(30_000);
      } finally {
        await loop.close();
      }
      const before = f.transfers.length;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(f.transfers.length).toBe(before);
    }
  );
});
