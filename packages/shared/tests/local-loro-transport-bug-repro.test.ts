/**
 * Regression tests for the 2026-07-04 adversarial review of the local Loro data
 * plane (P4 protocol + R3/R4 remediation). Each test originally REPRODUCED a
 * protocol-v2 bug; protocol v3 (peer-scoped addressing, peer lifecycle, join
 * reconciliation) fixes them and these now pin the correct behavior:
 *
 *   F1  multi-window sync: per-peer subscriber state on the server means one
 *       window's upload is still pushed to sibling windows sharing the relay
 *       socket (v2 keyed subscribers by connection id and starved siblings)
 *   F2  `joined` responses are peer-addressed and room-checked, so one
 *       adapter's join payload can never be imported into another adapter's doc
 *   F3  every server message carries workspaceId, so one workspace's metaFlock
 *       broadcast is never imported into another workspace's metaFlock
 *   F5a join is a reconciliation point: client-ahead ops present at join time
 *       (offline writes + app restart; in-memory dirty flag lost) are up-synced
 *   F5b an update silently dropped by the relay (send swallowed while the
 *       async status channel still reports connected) is re-sent by the rejoin
 *       reconciliation, not dependent on the cleared dirty flag
 *   F5c superseded joins on one connection cannot advance a frontier for a
 *       reply the client discards
 *   F5d Flock rejoin reports the server's real frontier, so client-ahead meta
 *       such as lastCanceledTurn is uploaded after a silently dropped frame
 *   F5e an async Flock export from an old connection generation cannot restore
 *       the optimistic frontier after rejoin reconciliation replaced it
 *   F5f an async Flock import from an old join generation cannot publish a
 *       false joined status after its replacement join was lost
 *   F8  `detach` (sent by adapter.close(), synthesized by the relay for
 *       destroyed/navigated windows) withdraws the peer server-side, so rooms
 *       are released and nothing is pushed to departed clients
 *
 * The RelayHarness faithfully models the production transport chain:
 *  - ONE server-side connection object per socket, shared by every renderer
 *    window (apps/cli/src/lib/local-loro-data-plane-server.ts creates one
 *    connection per net socket; the Electron relay holds a single long-lived
 *    socket for the whole app, loro-data-plane-relay.ts).
 *  - Client messages are routed to the per-workspace engine by
 *    message.workspaceId (as the CLI socket server does).
 *  - Every server→client message is fanned out to ALL renderer listeners
 *    (relay.publish broadcasts each event to every attached webContents;
 *    adapters filter by workspaceId + peerId).
 */
import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { LocalLoroTransportAdapter } from '../src/local-loro-transport';
import { LocalLoroDataPlaneServer } from '../src/local-loro-data-plane-server';
import {
  base64ToBytes,
  bytesToBase64,
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
  type LocalLoroDataPlaneClientMessage,
  type LocalLoroDataPlaneServerMessage,
} from '../src/local-loro-data-plane';
import { MemoryFlock } from './helpers/memory-flock';

/**
 * Models the production chain renderer-adapter ↔ Electron relay ↔ CLI socket
 * server: one shared server-side connection id for all adapters, per-workspace
 * engines, and broadcast fan-out of every server push to every adapter.
 */
class RelayHarness {
  private readonly tasks: Array<() => void | Promise<void>> = [];
  private readonly scheduler = {
    scheduleDataWork: (work: () => void | Promise<void>) => {
      const scheduled = { cancelled: false };
      this.tasks.push(async () => {
        if (!scheduled.cancelled) {
          await work();
        }
      });
      return () => {
        scheduled.cancelled = true;
      };
    },
  };
  private readonly engines = new Map<string, LocalLoroDataPlaneServer>();
  private readonly serverDocs = new Map<string, LoroDoc>();
  private readonly serverMetaFlocks = new Map<string, MemoryFlock>();
  private readonly rendererListeners = new Set<(m: LocalLoroDataPlaneServerMessage) => void>();
  private readonly statusListeners = new Set<(connected: boolean) => void>();
  private connected = true;
  /**
   * Models the relay's silent-drop window: `relay.send()` swallows write
   * failures while the renderer's tracked status is still `connected` because
   * the status channel event has not been delivered yet.
   */
  dropSends = false;
  /** Every server→client push, in order (the relay broadcast stream). */
  readonly pushed: LocalLoroDataPlaneServerMessage[] = [];

  // One connection object per socket — exactly what the CLI socket server
  // creates. All renderer windows sit behind this single id.
  private readonly sharedConnection = {
    id: 'dp:relay:1',
    send: (message: LocalLoroDataPlaneServerMessage) => {
      this.pushed.push(message);
      this.tasks.push(() => {
        // relay.publish: fan out to every attached renderer.
        for (const listener of this.rendererListeners) listener(message);
      });
    },
  };

  engineFor(workspaceId: string): LocalLoroDataPlaneServer {
    const existing = this.engines.get(workspaceId);
    if (existing) return existing;
    const engine = new LocalLoroDataPlaneServer({
      workspaceId,
      resolveDoc: async (docId) => this.serverDoc(workspaceId, docId),
      resolveFlockDoc: async () => new MemoryFlock(),
      resolveMetaFlock: async () => this.serverMetaFlock(workspaceId),
      scheduler: this.scheduler,
    });
    this.engines.set(workspaceId, engine);
    return engine;
  }

  serverDoc(workspaceId: string, docId: string): LoroDoc {
    const key = `${workspaceId}:${docId}`;
    const existing = this.serverDocs.get(key);
    if (existing) return existing;
    const doc = new LoroDoc();
    this.serverDocs.set(key, doc);
    return doc;
  }

  /**
   * Models `repo.unloadDoc(docId)`: the doc is persisted and evicted from the
   * repo's instance cache, so the NEXT `resolveDoc` hands out a different
   * `LoroDoc` object loaded from storage. This is what CLI session GC does to an
   * idle session while a renderer is still subscribed to its room.
   */
  unloadServerDoc(workspaceId: string, docId: string): void {
    const key = `${workspaceId}:${docId}`;
    const previous = this.serverDocs.get(key);
    if (!previous) return;
    const snapshot = previous.export({ mode: 'snapshot' });
    const reloaded = new LoroDoc();
    reloaded.import(snapshot);
    this.serverDocs.set(key, reloaded);
  }

  serverMetaFlock(workspaceId: string): MemoryFlock {
    const existing = this.serverMetaFlocks.get(workspaceId);
    if (existing) return existing;
    const flock = new MemoryFlock();
    this.serverMetaFlocks.set(workspaceId, flock);
    return flock;
  }

  createAdapter(workspaceId: string, peerId: string): LocalLoroTransportAdapter {
    this.engineFor(workspaceId);
    const connection = {
      send: (message: LocalLoroDataPlaneClientMessage) => {
        if (!this.connected) throw new Error('offline');
        if (this.dropSends) return; // silent drop, see field doc above
        this.tasks.push(async () => {
          if (message.type === 'ping') return; // socket-layer concern, not the engine's
          // CLI socket server routing: engine looked up by message.workspaceId.
          const engine = this.engines.get(message.workspaceId);
          if (!engine) throw new Error(`no engine for ${message.workspaceId}`);
          await engine.handleMessage(this.sharedConnection, message);
        });
      },
      onMessage: (listener: (m: LocalLoroDataPlaneServerMessage) => void) => {
        this.rendererListeners.add(listener);
        return () => this.rendererListeners.delete(listener);
      },
      onStatusChange: (listener: (connected: boolean) => void) => {
        this.statusListeners.add(listener);
        return () => this.statusListeners.delete(listener);
      },
      isConnected: () => this.connected,
    };
    return new LocalLoroTransportAdapter({ workspaceId, peerId, connection });
  }

  /** Socket drop / re-dial: server forgets the connection, adapters rejoin. */
  setConnected(next: boolean): void {
    if (this.connected === next) return;
    this.connected = next;
    if (!next) {
      for (const engine of this.engines.values()) {
        engine.handleDisconnect(this.sharedConnection.id);
      }
    }
    for (const listener of this.statusListeners) listener(next);
  }

  async settle(): Promise<void> {
    for (let round = 0; round < 200; round += 1) {
      if (this.tasks.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.tasks.length === 0) return;
      }
      const batch = this.tasks.splice(0);
      for (const task of batch) {
        await task();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('settle_did_not_converge');
  }
}

const text = (doc: LoroDoc): string => doc.getText('t').toString();
const insert = (doc: LoroDoc, at: number, value: string): void => {
  doc.getText('t').insert(at, value);
  doc.commit();
};

describe('local Loro data plane — review regression suite (F1/F2/F3/F5/F8)', () => {
  it('F1: an edit in window A must be pushed to window B on the shared relay connection', async () => {
    const harness = new RelayHarness();
    const windowA = harness.createAdapter('ws', 'renderer:window-a');
    const windowB = harness.createAdapter('ws', 'renderer:window-b');
    const docA = new LoroDoc();
    const docB = new LoroDoc();

    windowA.joinDocRoom('doc-1', docA);
    await harness.settle();
    windowB.joinDocRoom('doc-1', docB);
    await harness.settle();

    insert(docA, 0, 'hello-from-A');
    await harness.settle();

    // Sanity: the upload reached the CLI doc.
    expect(text(harness.serverDoc('ws', 'doc-1'))).toBe('hello-from-A');
    // DoD#7 (multi-window sync correct): window B converges because the server
    // keys sync state by peerId — A's upload adjusts only A's lastSentVV, and
    // B still receives its delta over the shared connection.
    expect(text(docB)).toBe('hello-from-A');
  });

  it("F2: a 'joined' response for room X must not be imported into room Y of another adapter", async () => {
    const harness = new RelayHarness();
    // Pre-existing CLI-side content in doc-x.
    insert(harness.serverDoc('ws', 'doc-x'), 0, 'SECRET-X');

    const windowA = harness.createAdapter('ws', 'renderer:window-a');
    const windowB = harness.createAdapter('ws', 'renderer:window-b');
    const docX = new LoroDoc();
    const docY = new LoroDoc();

    // Both adapters issue their first join concurrently; every 'joined' is
    // broadcast to every window. Peer-addressed responses + the sameRoom check
    // keep them apart.
    windowA.joinDocRoom('doc-x', docX);
    windowB.joinDocRoom('doc-y', docY);
    await harness.settle();

    // Window A's join correctly downloaded doc-x.
    expect(text(docX)).toBe('SECRET-X');
    // Window B's doc-y must stay empty: the broadcast 'joined' for doc-x is
    // addressed to window A's peerId and must never satisfy window B's pending
    // join for doc-y.
    expect(text(docY)).toBe('');
  });

  it("F3: workspace A's metaFlock broadcast must not be imported into workspace B's metaFlock", async () => {
    const harness = new RelayHarness();
    const rendererA = harness.createAdapter('ws-a', 'renderer:ws-a');
    const rendererB = harness.createAdapter('ws-b', 'renderer:ws-b');
    const metaFlockA = new MemoryFlock();
    const metaFlockB = new MemoryFlock();

    rendererA.joinMetaRoom(metaFlockA);
    await harness.settle();
    rendererB.joinMetaRoom(metaFlockB);
    await harness.settle();

    // CLI-side write into workspace A's internal metaFlock (e.g. a session
    // status transition). Engine A broadcasts a flock-json bundle to every
    // window; only workspace A's adapters may apply it.
    harness.serverMetaFlock('ws-a').set('poison', 'from-ws-a');
    await harness.settle();

    // Sanity: workspace A's renderer receives its own meta update.
    expect(metaFlockA.get('poison')).toBe('from-ws-a');
    // Workspace isolation: B's metaFlock must not absorb A's bundle.
    expect(metaFlockB.get('poison')).toBeUndefined();
  });

  it('F5a: client-ahead ops present at join time (offline writes + app restart) must be up-synced', async () => {
    const harness = new RelayHarness();
    const renderer = harness.createAdapter('ws', 'renderer:restarted');

    // Models the restart: the doc is restored from IndexedDB with ops the CLI
    // never received, BEFORE the transport subscribes — so the in-memory
    // `dirty` flag (which did exist in the previous app session) is gone.
    const restoredDoc = new LoroDoc();
    insert(restoredDoc, 0, 'offline-before-restart');

    const sub = renderer.joinDocRoom('doc-1', restoredDoc);
    await harness.settle();
    await sub.firstSyncedWithRemote;
    await harness.settle();

    // P4 DoD#4 / R3: join is the reconciliation point — the client compares its
    // oplog against the returned serverVersion and uploads the difference, so
    // these ops converge without any local edit.
    expect(text(harness.serverDoc('ws', 'doc-1'))).toBe('offline-before-restart');
  });

  it('F5b: an update silently dropped by the relay must be resent after rejoin', async () => {
    const harness = new RelayHarness();
    const renderer = harness.createAdapter('ws', 'renderer:racy');
    const doc = new LoroDoc();
    renderer.joinDocRoom('doc-1', doc);
    await harness.settle();

    // The relay's socket just died; the renderer has not yet received the
    // status=false event (it is delivered asynchronously), so isConnected() is
    // still true and relay.send() drops the frame silently.
    harness.dropSends = true;
    insert(doc, 0, 'dropped-edit');
    await harness.settle();
    expect(text(harness.serverDoc('ws', 'doc-1'))).toBe(''); // frame lost, as modeled

    // The disconnect notice now arrives and the connection comes back.
    harness.dropSends = false;
    harness.setConnected(false);
    await harness.settle();
    harness.setConnected(true);
    await harness.settle();

    // R3: rejoin reconciliation re-exports from the server's returned version —
    // recovery must not depend on the (already cleared) dirty flag.
    expect(text(harness.serverDoc('ws', 'doc-1'))).toBe('dropped-edit');
  });

  it('F5c: only the newest same-connection join may advance the doc send frontier', async () => {
    const harness = new RelayHarness();
    insert(harness.serverDoc('ws', 'doc-1'), 0, 'server-history');
    const renderer = harness.createAdapter('ws', 'renderer:double-rejoin');
    const doc = new LoroDoc();

    const subscription = renderer.joinDocRoom('doc-1', doc);
    void subscription.rejoin();
    void subscription.rejoin();
    await harness.settle();

    const joined = harness.pushed.filter(
      (message) => message.type === 'joined' && message.room.scope === 'doc'
    );
    expect(joined.map((message) => message.requestId)).toEqual(['join:renderer:double-rejoin:3']);
    expect(text(doc)).toBe('server-history');
  });

  it('F5d: Flock client-ahead metadata is resent after a silently dropped upload', async () => {
    const harness = new RelayHarness();
    const renderer = harness.createAdapter('ws', 'renderer:cancel-fallback');
    const metaFlock = new MemoryFlock();
    renderer.joinMetaRoom(metaFlock);
    await harness.settle();

    harness.dropSends = true;
    metaFlock.set('lastCanceledTurn', 'turn-1');
    await harness.settle();
    expect(harness.serverMetaFlock('ws').get('lastCanceledTurn')).toBeUndefined();

    harness.dropSends = false;
    harness.setConnected(false);
    await harness.settle();
    harness.setConnected(true);
    await harness.settle();

    expect(harness.serverMetaFlock('ws').get('lastCanceledTurn')).toBe('turn-1');
  });

  it('F5e: an old async Flock export cannot overwrite the rejoin frontier', async () => {
    const harness = new RelayHarness();
    const renderer = harness.createAdapter('ws', 'renderer:async-rejoin');
    const metaFlock = new MemoryFlock();
    const subscription = renderer.joinMetaRoom(metaFlock);
    await harness.settle();

    harness.dropSends = true;
    metaFlock.set('lastCanceledTurn', 'turn-1');
    await harness.settle();
    expect(harness.serverMetaFlock('ws').get('lastCanceledTurn')).toBeUndefined();
    harness.dropSends = false;

    const originalExportJson = metaFlock.exportJson.bind(metaFlock);
    let releaseExport: (() => void) | undefined;
    let signalExportStarted: (() => void) | undefined;
    const exportStarted = new Promise<void>((resolve) => {
      signalExportStarted = resolve;
    });
    const releaseExportPromise = new Promise<void>((resolve) => {
      releaseExport = resolve;
    });
    let deferNextExport = true;
    metaFlock.exportJson = async (from) => {
      if (deferNextExport) {
        deferNextExport = false;
        signalExportStarted?.();
        await releaseExportPromise;
      }
      return await originalExportJson(from);
    };

    metaFlock.set('afterDrop', 'turn-2');
    await exportStarted;

    harness.setConnected(false);
    harness.setConnected(true);
    await harness.settle();

    releaseExport?.();
    await subscription.waitUntilSynced();
    await harness.settle();

    expect(harness.serverMetaFlock('ws').get('lastCanceledTurn')).toBe('turn-1');
    expect(harness.serverMetaFlock('ws').get('afterDrop')).toBe('turn-2');
  });

  it('F5f: an old async Flock import cannot complete a superseded join', async () => {
    const harness = new RelayHarness();
    harness.serverMetaFlock('ws').set('serverOnly', 'baseline');
    const renderer = harness.createAdapter('ws', 'renderer:async-import-rejoin');
    const metaFlock = new MemoryFlock();
    const originalImportJson = metaFlock.importJson.bind(metaFlock);
    let releaseImport: (() => void) | undefined;
    let signalImportStarted: (() => void) | undefined;
    let signalImportFinished: (() => void) | undefined;
    const importStarted = new Promise<void>((resolve) => {
      signalImportStarted = resolve;
    });
    const importFinished = new Promise<void>((resolve) => {
      signalImportFinished = resolve;
    });
    const releaseImportPromise = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    let deferNextImport = true;
    const deferredImportJson = async (bundle: unknown) => {
      if (deferNextImport) {
        deferNextImport = false;
        signalImportStarted?.();
        await releaseImportPromise;
      }
      await originalImportJson(bundle);
      signalImportFinished?.();
    };
    Object.defineProperty(metaFlock, 'importJson', { value: deferredImportJson });

    const subscription = renderer.joinMetaRoom(metaFlock);
    const initialSettle = harness.settle();
    await importStarted;
    await initialSettle;

    // Supersede the blocked gen1 reconcile, then silently lose gen2's join.
    // The old import must not make the public status look joined while the
    // internal room is still waiting for gen2.
    harness.dropSends = true;
    harness.setConnected(false);
    harness.setConnected(true);
    expect(subscription.status).toBe('connecting');

    releaseImport?.();
    await importFinished;
    await Promise.resolve();
    await Promise.resolve();
    expect(subscription.status).toBe('connecting');

    metaFlock.set('lastCanceledTurn', 'turn-after-lost-rejoin');
    await Promise.resolve();
    expect(harness.serverMetaFlock('ws').get('lastCanceledTurn')).toBeUndefined();

    harness.dropSends = false;
    await subscription.rejoin();
    await harness.settle();
    await subscription.waitUntilSynced();
    expect(harness.serverMetaFlock('ws').get('lastCanceledTurn')).toBe('turn-after-lost-rejoin');
  });

  it('F8: after a client closes without an explicit unsubscribe, the server must stop pushing to it (room released)', async () => {
    const harness = new RelayHarness();
    const renderer = harness.createAdapter('ws', 'renderer:reloading');
    const doc = new LoroDoc();
    renderer.joinDocRoom('doc-1', doc);
    await harness.settle();

    // Renderer teardown that is not a per-room unsubscribe: adapter.close()
    // sends a peer `detach` (and the Electron relay synthesizes the same for a
    // window reload/crash), withdrawing every subscription this peer held even
    // though the shared relay socket stays open.
    await renderer.close();
    await harness.settle();

    const docUpdatesPushed = () =>
      harness.pushed.filter((m) => m.type === 'update' && m.payload.kind === 'doc-update').length;
    const baseline = docUpdatesPushed();

    // CLI-side write after the client is gone.
    insert(harness.serverDoc('ws', 'doc-1'), 0, 'post-close-write');
    await harness.settle();

    // R5.1: the room was released at zero subscribers; nothing is pushed to a
    // renderer that no longer exists.
    expect(docUpdatesPushed() - baseline).toBe(0);
  });

  // F9: a doc room resolves its LoroDoc once and keeps it while a renderer
  // stays subscribed, but the repo may evict that instance (session GC ->
  // `repo.unloadDoc`) and hand out a different object next time. Without
  // `invalidateDocRoom` the room keeps importing/exporting the orphan, which
  // silently severs sync in BOTH directions while the room still reports
  // `joined`. Observed in production as a user turn that never reached the CLI,
  // so `TurnHistoryGate` held the whole agent reply for its full 20s timeout.
  describe('F9: repo doc eviction must invalidate the cached data-plane room', () => {
    it('drops renderer uploads into the orphaned instance when the room is not invalidated', async () => {
      const harness = new RelayHarness();
      const renderer = harness.createAdapter('ws', 'renderer:1');
      const doc = new LoroDoc();
      renderer.joinDocRoom('doc-1', doc);
      await harness.settle();

      insert(doc, 0, 'before-unload');
      await harness.settle();
      expect(text(harness.serverDoc('ws', 'doc-1'))).toBe('before-unload');

      harness.unloadServerDoc('ws', 'doc-1');

      insert(doc, text(doc).length, '|after-unload');
      await harness.settle();

      // The upload was applied to the evicted instance, so the repo's current
      // doc — the one the CLI reads and persists — never sees it.
      expect(text(harness.serverDoc('ws', 'doc-1'))).toBe('before-unload');
    });

    it('recovers both directions once the evicted room is invalidated', async () => {
      const harness = new RelayHarness();
      const renderer = harness.createAdapter('ws', 'renderer:1');
      const doc = new LoroDoc();
      const subscription = renderer.joinDocRoom('doc-1', doc);
      await harness.settle();

      insert(doc, 0, 'before-unload');
      await harness.settle();

      harness.unloadServerDoc('ws', 'doc-1');
      harness.engineFor('ws').invalidateDocRoom('doc-1');
      // No manual reconnect: the engine publishes a terminal room status and
      // the adapter repairs that one room itself, so recovery must happen
      // without the workspace reconnect loop being involved at all.
      await harness.settle();
      expect(subscription.status).toBe('joined');

      // Up-sync: the write made before the eviction is reconciled at join, and
      // new renderer writes land in the repo's current doc.
      insert(doc, text(doc).length, '|after-invalidate');
      await harness.settle();
      expect(text(harness.serverDoc('ws', 'doc-1'))).toBe('before-unload|after-invalidate');

      // Down-sync: CLI writes on the current instance reach the renderer again.
      const current = harness.serverDoc('ws', 'doc-1');
      insert(current, text(current).length, '|cli-write');
      await harness.settle();
      expect(text(doc)).toBe('before-unload|after-invalidate|cli-write');
    });

    it('recovers an upload that landed in the window between eviction and invalidation', async () => {
      const harness = new RelayHarness();
      const renderer = harness.createAdapter('ws', 'renderer:1');
      const doc = new LoroDoc();
      renderer.joinDocRoom('doc-1', doc);
      await harness.settle();

      insert(doc, 0, 'before-unload');
      await harness.settle();

      // Invalidation is deliberately sequenced AFTER the unload, so there is a
      // window where the room still routes to the orphan. This pins the reason
      // that is acceptable: the peer reconciles against the server version on
      // (re)join and re-uploads whatever the server is missing, so a write lost
      // in the window comes back. (Sequencing it BEFORE would instead let a
      // racing join re-open the doc into the repo cache just in time to be
      // stranded again — silently, with no status published.)
      harness.unloadServerDoc('ws', 'doc-1');
      insert(doc, text(doc).length, '|written-in-window');
      await harness.settle();
      expect(text(harness.serverDoc('ws', 'doc-1'))).toBe('before-unload');

      harness.engineFor('ws').invalidateDocRoom('doc-1');
      await harness.settle();

      expect(text(harness.serverDoc('ws', 'doc-1'))).toBe('before-unload|written-in-window');
    });

    it('discards a room build that was in flight when the invalidation landed', async () => {
      // `invalidateDocRoom` looks the room up in `this.rooms`, but a build still
      // inside `ensureRoom` has not installed its entry yet — so the lookup
      // misses it, nothing is published, and the build then installs a room
      // bound to the instance the repo just evicted. That is the original bug
      // with no recovery signal at all, and it is reachable because
      // `unloadDocRoom` awaits `repo.unloadDoc` before it invalidates.
      const tasks: Array<() => void | Promise<void>> = [];
      const currentDocs = new Map<string, LoroDoc>();
      let openGate = (): void => {};
      const gate = new Promise<void>((resolve) => {
        openGate = () => resolve();
      });
      let parkNextResolve = true;

      const engine = new LocalLoroDataPlaneServer({
        workspaceId: 'ws',
        resolveDoc: async (docId) => {
          // Capture BEFORE parking: this models the real race, where
          // `openPersistedDoc` has already handed back an instance and the
          // eviction happens while the rest of the build is still running.
          // (Reading the map after the gate would silently hand out the fresh
          // instance and the race could never manifest.)
          const doc = currentDocs.get(docId);
          if (!doc) throw new Error(`no doc ${docId}`);
          if (parkNextResolve) {
            parkNextResolve = false;
            await gate;
          }
          return doc;
        },
        resolveFlockDoc: async () => new MemoryFlock(),
        scheduler: {
          scheduleDataWork: (work) => {
            tasks.push(work);
            return () => {};
          },
        },
      });

      const evicted = new LoroDoc();
      currentDocs.set('doc-1', evicted);

      const connection = { id: 'dp:1', send: () => {} };
      const joining = engine.handleMessage(connection, {
        type: 'join',
        protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
        requestId: 'join:1',
        workspaceId: 'ws',
        peerId: 'renderer:1',
        room: { scope: 'doc', docId: 'doc-1' },
      });
      await Promise.resolve();

      // The repo evicts while that join is parked inside `resolveDoc`; the next
      // `openPersistedDoc` would hand out this different instance.
      const reloaded = new LoroDoc();
      reloaded.import(evicted.export({ mode: 'snapshot' }));
      currentDocs.set('doc-1', reloaded);
      engine.invalidateDocRoom('doc-1');

      openGate();
      await joining;
      for (const task of tasks.splice(0)) await task();

      // A peer upload must reach the repo's CURRENT doc, not the orphan.
      const peer = new LoroDoc();
      insert(peer, 0, 'from-peer');
      await engine.handleMessage(connection, {
        type: 'update',
        protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
        workspaceId: 'ws',
        peerId: 'renderer:1',
        room: { scope: 'doc', docId: 'doc-1' },
        haveVersion: bytesToBase64(peer.oplogVersion().encode()),
        payload: {
          kind: 'doc-update',
          dataBase64: bytesToBase64(peer.export({ mode: 'update' })),
        },
      });

      expect(text(reloaded)).toBe('from-peer');
      expect(text(evicted)).toBe('');
    });

    // The generation check inside `ensureRoom` only covers the window BEFORE the
    // entry is installed. An invalidation landing between `rooms.set` and the
    // awaiting caller resuming would hand back an already-dead entry, which is
    // worse than the bug this class fixes: `handleJoin` registers the peer on
    // it, `buildJoinReplyFrames` then finds no room and emits nothing, and the
    // client is parked on `connecting` forever — not a terminal status, so the
    // renderer's reconnect loop never fires either.
    //
    // The install and the caller's resumption are one microtask apart, so
    // rather than guess that distance (scheduler luck, and a test that silently
    // stops covering anything when the code shifts by a hop), sweep the
    // invalidation across a fixed range of microtask depths and require the
    // invariant to hold at every one. Deterministic: same depths every run.
    for (const depth of [0, 1, 2, 3, 4, 5, 6, 7]) {
      it(`answers a join whose room is invalidated ${depth} microtask(s) into the build`, async () => {
        const tasks: Array<() => void | Promise<void>> = [];
        const currentDocs = new Map<string, LoroDoc>();
        let armed = true;
        const engine = new LocalLoroDataPlaneServer({
          workspaceId: 'ws',
          resolveDoc: async (docId) => {
            const doc = currentDocs.get(docId);
            if (!doc) throw new Error(`no doc ${docId}`);
            if (armed) {
              armed = false;
              let chain = Promise.resolve();
              for (let hop = 0; hop < depth; hop += 1) {
                chain = chain.then(() => undefined);
              }
              void chain.then(() => {
                const reloaded = new LoroDoc();
                reloaded.import(doc.export({ mode: 'snapshot' }));
                currentDocs.set(docId, reloaded);
                engine.invalidateDocRoom(docId);
              });
            }
            return doc;
          },
          resolveFlockDoc: async () => new MemoryFlock(),
          scheduler: {
            scheduleDataWork: (work) => {
              tasks.push(work);
              return () => {};
            },
          },
        });

        const seeded = new LoroDoc();
        insert(seeded, 0, 'seed');
        currentDocs.set('doc-1', seeded);

        const frames: LocalLoroDataPlaneServerMessage[] = [];
        const connection = {
          id: 'dp:1',
          send: (frame: LocalLoroDataPlaneServerMessage) => {
            frames.push(frame);
          },
        };
        await engine.handleMessage(connection, {
          type: 'join',
          protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
          requestId: 'join:1',
          workspaceId: 'ws',
          peerId: 'renderer:1',
          room: { scope: 'doc', docId: 'doc-1' },
        });
        for (const task of tasks.splice(0)) await task();

        // The invariant: the peer is never left silent. Either the join is
        // answered, or it is told the room is gone so it re-joins. Silence is
        // the unrecoverable state — the client parks on `connecting`, which is
        // not terminal, so the renderer's reconnect loop never fires.
        const joined = frames.filter((f) => f.type === 'joined' && f.requestId === 'join:1');
        const terminalStatus = frames.filter(
          (f) => f.type === 'room-status' && (f.status === 'disconnected' || f.status === 'error')
        );
        expect(joined.length + terminalStatus.length).toBeGreaterThan(0);

        if (joined.length > 0) {
          // The room it was registered on must be the live one, so a CLI write
          // on the repo's CURRENT doc still reaches the peer.
          const current = currentDocs.get('doc-1');
          if (!current) throw new Error('missing current doc');
          insert(current, text(current).length, '|after');
          for (const task of tasks.splice(0)) await task();
          const peerDoc = new LoroDoc();
          for (const frame of frames) {
            if (
              (frame.type === 'joined' || frame.type === 'update') &&
              frame.payload?.kind === 'doc-update'
            ) {
              peerDoc.import(base64ToBytes(frame.payload.dataBase64));
            }
          }
          expect(text(peerDoc)).toBe('seed|after');
        }
      });
    }
  });
});
