import { describe, expect, it, vi } from 'vitest';
import { EphemeralStore, LoroDoc } from 'loro-crdt';
import { LocalLoroTransportAdapter } from '../src/local-loro-transport';
import { LocalLoroDataPlaneServer } from '../src/local-loro-data-plane-server';
import {
  base64ToBytes,
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
  type LocalLoroDataPlaneClientMessage,
  type LocalLoroDataPlaneServerMessage,
} from '../src/local-loro-data-plane';
import { MemoryFlock } from './helpers/memory-flock';

// Deterministic in-memory transport: client.send → server.handleMessage and the
// server's per-connection sends → client listeners, both via a shared task queue.
// Loro fires subscribe callbacks on its own microtask timing, so `settle()` keeps
// draining + yielding until quiescent.
class Harness {
  private readonly tasks: Array<() => void | Promise<void>> = [];
  private readonly serverDocs = new Map<string, LoroDoc>();
  private readonly serverFlocks = new Map<string, MemoryFlock>();
  readonly server: LocalLoroDataPlaneServer;
  private connSeq = 0;

  constructor(
    readonly workspaceId = 'ws',
    // When set, the meta room resolves here instead of `resolveFlockDoc('meta')`,
    // mirroring the CLI wiring where the meta room is the repo's internal
    // metaFlock (the dispatch-critical path), not a named flock doc.
    metaFlock?: MemoryFlock
  ) {
    this.server = new LocalLoroDataPlaneServer({
      workspaceId,
      resolveDoc: async (docId) => this.serverDoc(docId),
      resolveFlockDoc: async (flockDocId) => this.serverFlock(flockDocId),
      resolveMetaFlock: metaFlock ? async () => metaFlock : undefined,
    });
  }

  serverDoc(docId: string): LoroDoc {
    const existing = this.serverDocs.get(docId);
    if (existing) return existing;
    const doc = new LoroDoc();
    this.serverDocs.set(docId, doc);
    return doc;
  }

  serverFlock(flockDocId: string): MemoryFlock {
    const existing = this.serverFlocks.get(flockDocId);
    if (existing) return existing;
    const flock = new MemoryFlock();
    this.serverFlocks.set(flockDocId, flock);
    return flock;
  }

  createClient(peerId?: string) {
    const id = `conn-${++this.connSeq}`;
    const messageListeners = new Set<(m: LocalLoroDataPlaneServerMessage) => void>();
    const statusListeners = new Set<(connected: boolean) => void>();
    let connected = true;
    const received: LocalLoroDataPlaneServerMessage[] = [];
    const serverConnection = {
      id,
      send: (message: LocalLoroDataPlaneServerMessage) => {
        if (!connected) return;
        received.push(message);
        this.tasks.push(() => {
          for (const listener of messageListeners) listener(message);
        });
      },
    };
    const connection = {
      send: (message: LocalLoroDataPlaneClientMessage) => {
        if (!connected) throw new Error('offline');
        this.tasks.push(async () => {
          // Pings are answered by the socket layer, never routed to the engine.
          if (message.type === 'ping') return;
          await this.server.handleMessage(serverConnection, message);
        });
      },
      onMessage: (listener: (m: LocalLoroDataPlaneServerMessage) => void) => {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
      onStatusChange: (listener: (c: boolean) => void) => {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      isConnected: () => connected,
    };
    const adapter = new LocalLoroTransportAdapter({
      workspaceId: this.workspaceId,
      peerId,
      connection,
    });
    const setConnected = (next: boolean) => {
      if (connected === next) return;
      connected = next;
      if (!next) this.server.handleDisconnect(id);
      for (const listener of statusListeners) listener(next);
    };
    return { adapter, setConnected, received };
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

describe('LocalLoroTransportAdapter push+delta sync', () => {
  it('expires a withheld join into error, then accepts a replacement join', async () => {
    const sent: LocalLoroDataPlaneClientMessage[] = [];
    const listeners = new Set<(message: LocalLoroDataPlaneServerMessage) => void>();
    const deadlines: Array<() => void> = [];
    const adapter = new LocalLoroTransportAdapter({
      workspaceId: 'ws',
      peerId: 'deadline-peer',
      joinAttemptTimeoutMs: 120_000,
      scheduleTimeout: (callback) => {
        deadlines.push(callback);
        return callback;
      },
      cancelTimeout: () => {},
      connection: {
        send: (message) => sent.push(message),
        onMessage: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onStatusChange: () => () => {},
        isConnected: () => true,
      },
    });
    const subscription = adapter.joinDocRoom('doc-timeout', new LoroDoc());
    const firstJoin = sent[0];
    expect(firstJoin?.type).toBe('join');
    expect(subscription.status).toBe('connecting');

    // No reply arrives. This is the adapter-owned transition the workspace
    // reconnect loop needs; it must not remain an indefinitely passive
    // `connecting`/`reconnecting` room.
    deadlines[0]?.();
    expect(subscription.status).toBe('error');

    await adapter.reconnect();
    const secondJoin = sent[1];
    expect(secondJoin?.type).toBe('join');
    if (secondJoin?.type !== 'join') throw new Error('replacement_join_not_sent');
    for (const listener of listeners) {
      listener({
        type: 'joined',
        protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
        workspaceId: 'ws',
        peerId: 'deadline-peer',
        requestId: secondJoin.requestId,
        room: { scope: 'doc', docId: 'doc-timeout' },
      });
    }
    await subscription.firstSyncedWithRemote;
    expect(subscription.status).toBe('joined');
  });

  it('immediately supersedes an unanswered join after a terminal room status', () => {
    const sent: LocalLoroDataPlaneClientMessage[] = [];
    const listeners = new Set<(message: LocalLoroDataPlaneServerMessage) => void>();
    const adapter = new LocalLoroTransportAdapter({
      workspaceId: 'ws',
      peerId: 'terminal-status-peer',
      connection: {
        send: (message) => sent.push(message),
        onMessage: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onStatusChange: () => () => {},
        isConnected: () => true,
      },
    });
    adapter.joinDocRoom('doc-invalidated-before-reply', new LoroDoc());
    const firstJoin = sent[0];
    if (firstJoin?.type !== 'join') throw new Error('initial_join_not_sent');

    // The server has dropped the queued reply while invalidating the room. A
    // normal reconnect must not renew a live attempt, but this terminal status
    // proves the request is unrecoverable and must start a replacement now.
    for (const listener of listeners) {
      listener({
        type: 'room-status',
        protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
        workspaceId: 'ws',
        peerId: 'terminal-status-peer',
        room: { scope: 'doc', docId: 'doc-invalidated-before-reply' },
        status: 'disconnected',
      });
    }

    expect(sent).toHaveLength(2);
    expect(sent[1]?.type).toBe('join');
    expect(
      (sent[1] as Extract<LocalLoroDataPlaneClientMessage, { type: 'join' }>).requestId
    ).not.toBe(firstJoin.requestId);
  });

  it('turns a synchronous join send failure into a reconnectable error', () => {
    const adapter = new LocalLoroTransportAdapter({
      workspaceId: 'ws',
      connection: {
        send: () => {
          throw new Error('relay_write_failed');
        },
        onMessage: () => () => {},
        onStatusChange: () => () => {},
        isConnected: () => true,
      },
    });
    const subscription = adapter.joinDocRoom('doc-send-failure', new LoroDoc());
    expect(subscription.status).toBe('error');
  });

  it('does not publish Flock joined or first sync after a failed join import', async () => {
    const sent: LocalLoroDataPlaneClientMessage[] = [];
    const listeners = new Set<(message: LocalLoroDataPlaneServerMessage) => void>();
    let rejectImport = true;
    const adapter = new LocalLoroTransportAdapter({
      workspaceId: 'ws',
      peerId: 'flock-import-peer',
      connection: {
        send: (message) => sent.push(message),
        onMessage: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onStatusChange: () => () => {},
        isConnected: () => true,
      },
    });
    const flock = {
      exportJson: () => [],
      importJson: async () => {
        if (rejectImport) throw new Error('import_failed');
      },
      version: () => ({}),
      subscribe: () => () => {},
    };
    const subscription = adapter.joinMetaRoom(flock);
    const deliverJoin = (requestId: string) => {
      for (const listener of listeners) {
        listener({
          type: 'joined',
          protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
          workspaceId: 'ws',
          peerId: 'flock-import-peer',
          requestId,
          room: { scope: 'meta' },
          payload: { kind: 'flock-json', bundle: [] },
        });
      }
    };
    const firstJoin = sent[0];
    if (firstJoin?.type !== 'join') throw new Error('initial_join_not_sent');
    deliverJoin(firstJoin.requestId);
    // Drain the explicitly gated async import/reconciliation chain; no clock
    // advancement is involved.
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
    expect(subscription.status).toBe('error');

    rejectImport = false;
    await adapter.reconnect();
    const secondJoin = sent[1];
    if (secondJoin?.type !== 'join') throw new Error('replacement_join_not_sent');
    deliverJoin(secondJoin.requestId);
    await subscription.firstSyncedWithRemote;
    expect(subscription.status).toBe('joined');
  });

  it('ignores a stale Flock flush failure after a replacement join', async () => {
    const sent: LocalLoroDataPlaneClientMessage[] = [];
    const listeners = new Set<(message: LocalLoroDataPlaneServerMessage) => void>();
    let onLocalChange: ((batch: { source?: string }) => void) | undefined;
    let rejectOldExport: ((reason?: unknown) => void) | undefined;
    let signalOldExportStarted: (() => void) | undefined;
    const oldExportStarted = new Promise<void>((resolve) => {
      signalOldExportStarted = resolve;
    });
    let deferAndRejectNextExport = false;
    const adapter = new LocalLoroTransportAdapter({
      workspaceId: 'ws',
      peerId: 'stale-flush-peer',
      connection: {
        send: (message) => sent.push(message),
        onMessage: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onStatusChange: () => () => {},
        isConnected: () => true,
      },
    });
    const flock = {
      exportJson: () => {
        if (!deferAndRejectNextExport) return [];
        deferAndRejectNextExport = false;
        return new Promise<never>((_resolve, reject) => {
          rejectOldExport = reject;
          signalOldExportStarted?.();
        });
      },
      importJson: () => {},
      version: () => ({}),
      subscribe: (listener: (batch: { source?: string }) => void) => {
        onLocalChange = listener;
        return () => {
          onLocalChange = undefined;
        };
      },
    };
    const subscription = adapter.joinMetaRoom(flock);
    const deliverLatestJoin = () => {
      const join = sent
        .filter(
          (message): message is Extract<LocalLoroDataPlaneClientMessage, { type: 'join' }> =>
            message.type === 'join'
        )
        .at(-1);
      if (!join) throw new Error('join_not_sent');
      for (const listener of listeners) {
        listener({
          type: 'joined',
          protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
          workspaceId: 'ws',
          peerId: 'stale-flush-peer',
          requestId: join.requestId,
          room: { scope: 'meta' },
        });
      }
    };
    deliverLatestJoin();
    await subscription.firstSyncedWithRemote;

    deferAndRejectNextExport = true;
    onLocalChange?.({ source: 'local' });
    // The export is now pending under the old generation. Supersede it with a
    // fully successful join before delivering its rejection.
    await oldExportStarted;
    await subscription.rejoin();
    deliverLatestJoin();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(subscription.status).toBe('joined');

    rejectOldExport?.(new Error('old_export_failed'));
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(subscription.status).toBe('joined');
  });

  it('first-sync pulls existing server doc state to a fresh client', async () => {
    const harness = new Harness();
    insert(harness.serverDoc('doc-1'), 0, 'hello');

    const client = harness.createClient();
    const clientDoc = new LoroDoc();
    const sub = client.adapter.joinDocRoom('doc-1', clientDoc);
    await harness.settle();
    await sub.firstSyncedWithRemote;

    expect(text(clientDoc)).toBe('hello');
  });

  it('reflects server-published doc room hydrate status on the subscription', async () => {
    const harness = new Harness();
    const client = harness.createClient();
    const clientDoc = new LoroDoc();
    const sub = client.adapter.joinDocRoom('doc-1', clientDoc);
    await harness.settle();
    await sub.firstSyncedWithRemote;

    const statuses: string[] = [];
    sub.onStatusChange((status) => statuses.push(status));

    harness.server.publishRoomStatus({ scope: 'doc', docId: 'doc-1' }, 'connecting');
    await harness.settle();
    expect(sub.status).toBe('connecting');

    harness.server.publishRoomStatus({ scope: 'doc', docId: 'doc-1' }, 'joined');
    await harness.settle();
    expect(sub.status).toBe('joined');
    expect(statuses).toEqual(['joined', 'connecting', 'joined']);
  });

  it('up-syncs a client edit to the server without echoing it back', async () => {
    const harness = new Harness();
    const client = harness.createClient();
    const clientDoc = new LoroDoc();
    client.adapter.joinDocRoom('doc-1', clientDoc);
    await harness.settle();

    const serverDoc = harness.serverDoc('doc-1');
    insert(clientDoc, 0, 'abc');
    await harness.settle();

    expect(text(serverDoc)).toBe('abc');
    // The client doc must not have duplicated its own edit from an echo.
    expect(text(clientDoc)).toBe('abc');
  });

  it('pushes a CLI-side (server) edit down to the client with no polling', async () => {
    const harness = new Harness();
    const client = harness.createClient();
    const clientDoc = new LoroDoc();
    client.adapter.joinDocRoom('doc-1', clientDoc);
    await harness.settle();

    insert(harness.serverDoc('doc-1'), 0, 'agent-output');
    await harness.settle();

    expect(text(clientDoc)).toBe('agent-output');
  });

  it('converges two clients through the server', async () => {
    const harness = new Harness();
    const a = harness.createClient('peer-a');
    const b = harness.createClient('peer-b');
    const docA = new LoroDoc();
    const docB = new LoroDoc();
    a.adapter.joinDocRoom('doc-1', docA);
    b.adapter.joinDocRoom('doc-1', docB);
    await harness.settle();

    insert(docA, 0, 'from-a ');
    await harness.settle();
    insert(docB, text(docB).length, 'from-b');
    await harness.settle();

    expect(text(docA)).toBe(text(docB));
    expect(text(docA)).toContain('from-a');
    expect(text(docA)).toContain('from-b');
  });

  it('queues an offline local edit and resends it on reconnect (R3)', async () => {
    const harness = new Harness();
    const client = harness.createClient();
    const clientDoc = new LoroDoc();
    client.adapter.joinDocRoom('doc-1', clientDoc);
    await harness.settle();

    client.setConnected(false);
    insert(clientDoc, 0, 'offline-edit');
    await harness.settle();
    // Nothing reached the server while offline.
    expect(text(harness.serverDoc('doc-1'))).toBe('');

    client.setConnected(true);
    await harness.settle();
    expect(text(harness.serverDoc('doc-1'))).toBe('offline-edit');
  });

  it('syncs flock rooms across two clients', async () => {
    const harness = new Harness();
    const a = harness.createClient();
    const b = harness.createClient();
    const flockA = new MemoryFlock();
    const flockB = new MemoryFlock();
    a.adapter.joinMetaRoom(flockA);
    b.adapter.joinMetaRoom(flockB);
    await harness.settle();

    flockA.set('title', 'hello');
    await harness.settle();

    expect(flockB.get('title')).toBe('hello');
    expect(harness.serverFlock('meta').get('title')).toBe('hello');
  });

  it('pushes flock changes as incremental deltas and stays quiet on no-op imports', async () => {
    const harness = new Harness();
    const a = harness.createClient();
    const b = harness.createClient();
    const flockA = new MemoryFlock();
    const flockB = new MemoryFlock();
    a.adapter.joinMetaRoom(flockA);
    b.adapter.joinMetaRoom(flockB);
    await harness.settle();

    const flockUpdatesTo = (client: { received: typeof a.received }) =>
      client.received.filter(
        (message): message is Extract<LocalLoroDataPlaneServerMessage, { type: 'update' }> =>
          message.type === 'update' && message.payload.kind === 'flock-json'
      );
    const baselineB = flockUpdatesTo(b).length;

    flockA.set('title', 'hello');
    await harness.settle();
    // Dirty-marking is subscription-driven only: one change → exactly one push
    // to B (no explicit-plus-subscription double broadcast).
    expect(flockUpdatesTo(b).length - baselineB).toBe(1);

    // A redelivered bundle changes nothing server-side (same entry clocks):
    // the flock fires no event, so nothing is re-broadcast.
    const afterFirst = flockUpdatesTo(b).length;
    const serverFlock = harness.serverFlock('meta');
    serverFlock.importJson(serverFlock.exportJson({}));
    await harness.settle();
    expect(flockUpdatesTo(b).length).toBe(afterFirst);

    // Pushes are DELTAS: a second key must not re-ship the first one.
    flockA.set('subtitle', 'world');
    await harness.settle();
    const lastToB = flockUpdatesTo(b).at(-1);
    expect(lastToB).toBeDefined();
    const bundle =
      lastToB && lastToB.payload.kind === 'flock-json'
        ? (lastToB.payload.bundle as { entries?: Record<string, unknown> })
        : {};
    expect(Object.keys(bundle.entries ?? {})).toEqual(['subtitle']);
    expect(flockB.get('subtitle')).toBe('world');
  });

  it('rejoin catch-up is incremental: only entries missed while offline are re-sent', async () => {
    const harness = new Harness();
    const client = harness.createClient('peer-rejoin');
    const flock = new MemoryFlock();
    client.adapter.joinMetaRoom(flock);
    await harness.settle();

    harness.serverFlock('meta').set('before', 1);
    await harness.settle();
    expect(flock.get('before')).toBe(1);

    client.setConnected(false);
    harness.serverFlock('meta').set('while-offline', 2);
    await harness.settle();

    const framesBefore = client.received.length;
    client.setConnected(true);
    await harness.settle();

    expect(flock.get('while-offline')).toBe(2);
    // The catch-up frames after reconnect must carry ONLY the missed entry —
    // the client's haveVersion covers everything it already holds.
    const entriesReSent: string[] = [];
    for (const message of client.received.slice(framesBefore)) {
      if (message.type !== 'joined' && message.type !== 'update') continue;
      if (!('payload' in message) || !message.payload) continue;
      if (message.payload.kind !== 'flock-json') continue;
      const bundle = message.payload.bundle as { entries?: Record<string, unknown> };
      entriesReSent.push(...Object.keys(bundle.entries ?? {}));
    }
    expect(entriesReSent).toEqual(['while-offline']);
  });

  it('routes the meta room to resolveMetaFlock, not resolveFlockDoc("meta")', async () => {
    // The CLI's internal metaFlock (where doc-metadata / latestUserMsgId live and
    // the dispatch watcher listens) must receive renderer meta writes. A regression
    // here silently swallows every dispatch: no CLI reaction, no logs.
    const metaFlock = new MemoryFlock();
    const harness = new Harness('ws', metaFlock);

    const client = harness.createClient();
    const flock = new MemoryFlock();
    client.adapter.joinMetaRoom(flock);
    await harness.settle();

    flock.set('latestUserMsgId', 'turn-1');
    await harness.settle();

    // Landed in the dispatch-critical metaFlock...
    expect(metaFlock.get('latestUserMsgId')).toBe('turn-1');
    // ...and NOT in the decoy named 'meta' flock doc.
    expect(harness.serverFlock('meta').get('latestUserMsgId')).toBeUndefined();
  });

  it('pushes presence on connect and on every presence change', async () => {
    const presenceStore = new EphemeralStore(30_000);
    const listeners = new Set<() => void>();
    const notify = () => {
      for (const listener of listeners) listener();
    };
    const server = new LocalLoroDataPlaneServer({
      workspaceId: 'ws',
      resolveDoc: async () => new LoroDoc(),
      resolveFlockDoc: async () => {
        throw new Error('not used');
      },
      presenceSource: {
        encodeLocalOrigin: () => presenceStore.encodeAll(),
        subscribeLocalOrigin: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });

    // Seed presence before the client connects.
    presenceStore.set('machine:m1', { kind: 'machine', machineId: 'm1' });
    notify();

    const received: LocalLoroDataPlaneServerMessage[] = [];
    const connection = {
      id: 'conn-1',
      send: (m: LocalLoroDataPlaneServerMessage) => received.push(m),
    };

    // First message registers the connection → gets the current presence snapshot.
    await server.handleMessage(connection, {
      type: 'join',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      requestId: 'r1',
      workspaceId: 'ws',
      peerId: 'renderer',
      room: { scope: 'doc', docId: 'doc-1' },
    });
    const presenceMessages = () => received.filter((m) => m.type === 'presence');
    await vi.waitFor(() => {
      expect(presenceMessages()).toHaveLength(1);
    });

    // A presence change pushes again; the receiver can decode it into a store.
    presenceStore.set('session:s1', { kind: 'session', sessionId: 's1' });
    notify();
    await vi.waitFor(() => {
      expect(presenceMessages()).toHaveLength(2);
    });

    const last = presenceMessages().at(-1);
    if (last?.type !== 'presence') throw new Error('expected presence message');
    const mirror = new EphemeralStore(30_000);
    mirror.apply(base64ToBytes(last.dataBase64));
    expect(mirror.keys().sort()).toEqual(['machine:m1', 'session:s1']);
  });
});
