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
