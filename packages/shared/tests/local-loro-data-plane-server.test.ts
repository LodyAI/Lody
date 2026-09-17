import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { LoroDoc } from 'loro-crdt';
import {
  LocalLoroDataPlaneServer,
  type LocalLoroDataPlaneServerConnection,
} from '../src/local-loro-data-plane-server';
import {
  base64ToBytes,
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
  type FlockVersionVector,
  type LocalLoroDataPlaneServerMessage,
} from '../src/local-loro-data-plane';
import { MemoryFlock } from './helpers/memory-flock';

const WORKSPACE_ID = 'ws';

// MemoryFlock with an instrumented, optionally slow exportJson so the
// write-time coalescing tests can count export passes and race changes into a
// running one.
class CountingFlock extends MemoryFlock {
  exportCount = 0;
  exportDelayMs = 0;
  onExport: (() => void) | null = null;

  override async exportJson(
    from: FlockVersionVector
  ): Promise<ReturnType<MemoryFlock['exportJson']>> {
    this.exportCount += 1;
    this.onExport?.();
    if (this.exportDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.exportDelayMs));
    }
    return super.exportJson(from);
  }
}

function makeConnection(id = 'conn-1'): {
  connection: LocalLoroDataPlaneServerConnection;
  received: LocalLoroDataPlaneServerMessage[];
} {
  const received: LocalLoroDataPlaneServerMessage[] = [];
  return {
    connection: { id, send: (message) => void received.push(message) },
    received,
  };
}

// Connection whose send() can signal backpressure (false) and later drain,
// mirroring the CLI net-socket connection.
function makeBackpressureConnection(id = 'conn-bp'): {
  connection: LocalLoroDataPlaneServerConnection;
  received: LocalLoroDataPlaneServerMessage[];
  setAccepting: (accepting: boolean) => void;
  drain: () => void;
} {
  const received: LocalLoroDataPlaneServerMessage[] = [];
  const drainListeners = new Set<() => void>();
  let accepting = true;
  return {
    connection: {
      id,
      send: (message) => {
        received.push(message);
        return accepting;
      },
      onDrain: (listener) => {
        drainListeners.add(listener);
        return () => drainListeners.delete(listener);
      },
    },
    received,
    setAccepting: (next) => {
      accepting = next;
    },
    drain: () => {
      for (const listener of [...drainListeners]) listener();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function flockEntriesOf(messages: LocalLoroDataPlaneServerMessage[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const message of messages) {
    if (message.type !== 'update' && message.type !== 'joined') continue;
    if (!message.payload || message.payload.kind !== 'flock-json') continue;
    const entries = (message.payload.bundle as { entries?: Record<string, { d?: unknown }> })
      .entries;
    for (const [key, record] of Object.entries(entries ?? {})) {
      merged[key] = record.d;
    }
  }
  return merged;
}

describe('LocalLoroDataPlaneServer doc room hydration signals', () => {
  async function receiveRepairedKey(overwritePeerFrontier: boolean) {
    const { LoroRepo } = createRequire(import.meta.url)('loro-repo') as typeof import('loro-repo');
    const sourceRepo = await LoroRepo.create({ metaDebounceCommitMs: 0 });
    const targetRepo = await LoroRepo.create({ metaDebounceCommitMs: 0 });
    const source = sourceRepo.getMeta();
    const target = targetRepo.getMeta();
    const record = (key: string, clock: string) => ({
      version: 0,
      entries: {
        [JSON.stringify([key])]: { d: key, c: clock },
      },
    });
    source.importJson(record('overwritten', '1700000000000,2,aa'));
    if (overwritePeerFrontier) source.importJson(record('overwritten', '1700000000000,3,bb'));
    source.commit();
    const work: Array<() => void | Promise<void>> = [];
    const server = new LocalLoroDataPlaneServer({
      workspaceId: WORKSPACE_ID,
      resolveDoc: async () => new LoroDoc(),
      resolveFlockDoc: async () => source,
      scheduler: {
        scheduleDataWork: (task) => {
          work.push(task);
          return () => {};
        },
      },
    });
    const drain = async () => {
      for (let task; (task = work.shift());) await task();
    };
    await server.handleMessage(
      {
        id: 'repair',
        send: (message) => {
          if (
            (message.type === 'joined' || message.type === 'update') &&
            message.payload?.kind === 'flock-json'
          ) {
            void target.importJson(message.payload.bundle);
          }
        },
      },
      {
        type: 'join',
        protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
        workspaceId: WORKSPACE_ID,
        peerId: 'reader',
        requestId: 'join',
        room: { scope: 'flock-doc', flockDocId: 'repair' },
      }
    );
    await drain();
    source.importJson(record('late-key', '1700000000000,1,aa'));
    source.commit();
    await drain();
    const received = target.get(['late-key']);
    server.dispose();
    await sourceRepo.destroy();
    await targetRepo.destroy();
    return received;
  }

  it('forwards a repaired older Flock key even after its peer frontier was overwritten', async () => {
    expect(await receiveRepairedKey(true)).toBe('late-key');
  });

  // Known migration gap: bootstrap may repair aa:1 while aa:2 remains visible.
  // Remove .fails when the local plane forwards exact changed keys or reconciles
  // without treating a maximum clock as proof that every older key is present.
  it.fails('forwards a same-vector repair while the higher peer clock remains visible', async () => {
    expect(await receiveRepairedKey(false)).toBe('late-key');
  });

  it('notifies doc room joins and publishes room status to subscribers', async () => {
    const onDocRoomJoin = vi.fn();
    const onDocRoomLeave = vi.fn();
    const server = new LocalLoroDataPlaneServer({
      workspaceId: WORKSPACE_ID,
      resolveDoc: async () => new LoroDoc(),
      resolveFlockDoc: async () => new CountingFlock(),
      onDocRoomJoin,
      onDocRoomLeave,
    });
    const { connection, received } = makeConnection();
    const room = { scope: 'doc' as const, docId: 'session-1' };

    await server.handleMessage(connection, {
      type: 'join',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      requestId: 'join-doc-1',
      workspaceId: WORKSPACE_ID,
      peerId: 'peer-1',
      room,
    });
    await settle();

    expect(onDocRoomJoin).toHaveBeenCalledWith('session-1');

    server.publishRoomStatus(room, 'connecting');
    await settle();

    expect(received).toContainEqual(
      expect.objectContaining({
        type: 'room-status',
        workspaceId: WORKSPACE_ID,
        peerId: 'peer-1',
        room,
        status: 'connecting',
      })
    );

    await server.handleMessage(connection, {
      type: 'leave',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      workspaceId: WORKSPACE_ID,
      peerId: 'peer-1',
      room,
    });
    await settle();

    expect(onDocRoomLeave).toHaveBeenCalledWith('session-1');
  });

  it('notifies flock room joins and leaves for local-first cloud bridging', async () => {
    const onFlockRoomJoin = vi.fn();
    const onFlockRoomLeave = vi.fn();
    const server = new LocalLoroDataPlaneServer({
      workspaceId: WORKSPACE_ID,
      resolveDoc: async () => new LoroDoc(),
      resolveFlockDoc: async () => new CountingFlock(),
      onFlockRoomJoin,
      onFlockRoomLeave,
    });
    const { connection, received } = makeConnection();
    const room = { scope: 'flock-doc' as const, flockDocId: 'ws:fis:session-1' };

    await server.handleMessage(connection, {
      type: 'join',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      requestId: 'join-flock-1',
      workspaceId: WORKSPACE_ID,
      peerId: 'peer-1',
      room,
    });
    await settle();

    expect(onFlockRoomJoin).toHaveBeenCalledWith('ws:fis:session-1');

    server.publishRoomStatus(room, 'connecting');
    await settle();

    expect(received).toContainEqual(
      expect.objectContaining({
        type: 'room-status',
        workspaceId: WORKSPACE_ID,
        peerId: 'peer-1',
        room,
        status: 'connecting',
      })
    );

    await server.handleMessage(connection, {
      type: 'leave',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      workspaceId: WORKSPACE_ID,
      peerId: 'peer-1',
      room,
    });
    await settle();

    expect(onFlockRoomLeave).toHaveBeenCalledWith('ws:fis:session-1');
  });
});

describe('LocalLoroDataPlaneServer machine monitor bridge', () => {
  it('applies renderer observer state and pushes the current CLI monitor state', async () => {
    let notifyChange: (() => void) | null = null;
    const apply = vi.fn();
    const server = new LocalLoroDataPlaneServer({
      workspaceId: WORKSPACE_ID,
      resolveDoc: async () => new LoroDoc(),
      resolveFlockDoc: async () => new CountingFlock(),
      machineMonitorSource: {
        apply,
        encodeAll: () => new Uint8Array([4, 5, 6]),
        subscribe: (listener) => {
          notifyChange = listener;
          return () => {
            notifyChange = null;
          };
        },
      },
    });
    const { connection, received } = makeConnection();

    await server.handleMessage(connection, {
      type: 'machine-monitor',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      workspaceId: WORKSPACE_ID,
      peerId: 'peer-1',
      dataBase64: 'AQID',
    });
    await settle();

    expect(apply).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(received).toContainEqual(
      expect.objectContaining({
        type: 'machine-monitor',
        workspaceId: WORKSPACE_ID,
        dataBase64: 'BAUG',
      })
    );

    received.length = 0;
    notifyChange?.();
    await settle();
    expect(received.some((message) => message.type === 'machine-monitor')).toBe(true);
    server.dispose();
  });
});

describe('LocalLoroDataPlaneServer flock write-time coalescing', () => {
  const makeFlockServer = (flock: CountingFlock) =>
    new LocalLoroDataPlaneServer({
      workspaceId: WORKSPACE_ID,
      resolveDoc: async () => {
        throw new Error('unused');
      },
      resolveFlockDoc: async () => flock,
    });

  const joinFlockRoom = async (
    server: LocalLoroDataPlaneServer,
    connection: LocalLoroDataPlaneServerConnection
  ) => {
    await server.handleMessage(connection, {
      type: 'join',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      requestId: 'join-1',
      workspaceId: WORKSPACE_ID,
      peerId: 'peer-1',
      room: { scope: 'flock-doc', flockDocId: 'flock-1' },
    });
    await settle();
    await settle();
  };

  it('folds a synchronous burst of changes into one write-time export', async () => {
    const flock = new CountingFlock();
    const server = makeFlockServer(flock);
    const { connection, received } = makeConnection();
    await joinFlockRoom(server, connection);
    const exportsAfterJoin = flock.exportCount;

    for (let index = 0; index < 25; index += 1) {
      flock.set(`key-${index}`, index);
    }
    // Drain the coalesced pass (and its possible follow-up).
    await settle();
    await settle();
    await settle();

    // Exports happen at WRITE time against the peer's frontier: a burst of 25
    // changes costs at most one running + one queued export, never 25.
    expect(flock.exportCount - exportsAfterJoin).toBeLessThanOrEqual(2);
    const updates = received.filter((m) => m.type === 'update');
    expect(updates.length).toBeGreaterThanOrEqual(1);
    const entries = flockEntriesOf(updates);
    expect(entries['key-24']).toBe(24);
  });

  it('never materializes a bulk frame inline with the CRDT mutation producer', async () => {
    const flock = new CountingFlock();
    const server = makeFlockServer(flock);
    const { connection } = makeConnection();
    await joinFlockRoom(server, connection);

    let mutationReturned = false;
    let exportedInline = false;
    flock.onExport = () => {
      if (!mutationReturned) exportedInline = true;
    };
    flock.set('deferred-export', true);
    mutationReturned = true;

    expect(exportedInline).toBe(false);
    await settle();
    expect(flock.exportCount).toBeGreaterThan(0);
  });

  it('a change landing during a running export still gets its own follow-up pass', async () => {
    const flock = new CountingFlock();
    flock.exportDelayMs = 10;
    const server = makeFlockServer(flock);
    const { connection, received } = makeConnection();
    await joinFlockRoom(server, connection);

    flock.set('first', 1);
    // Let the first pass START (export in flight)…
    await settle();
    // …then land another change mid-export.
    flock.set('second', 2);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const entries = flockEntriesOf(received.filter((m) => m.type === 'update'));
    expect(entries['second']).toBe(2);
  });
});

describe('LocalLoroDataPlaneServer incremental flock sync', () => {
  it('a join catch-up above the frame budget is chunked, not failed', async () => {
    const flock = new MemoryFlock();
    for (let index = 0; index < 40; index += 1) {
      flock.set(`key-${String(index).padStart(2, '0')}`, `value-${index}`);
    }
    const server = new LocalLoroDataPlaneServer({
      workspaceId: WORKSPACE_ID,
      resolveDoc: async () => {
        throw new Error('unused');
      },
      resolveFlockDoc: async () => flock,
      maxPayloadBytes: 512,
    });
    const { connection, received } = makeConnection();
    await server.handleMessage(connection, {
      type: 'join',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      requestId: 'join-chunked',
      workspaceId: WORKSPACE_ID,
      peerId: 'peer-1',
      room: { scope: 'flock-doc', flockDocId: 'flock-big' },
    });
    await settle();
    await settle();

    await vi.waitFor(() => {
      expect(Object.keys(flockEntriesOf(received))).toHaveLength(40);
    });

    expect(received.some((m) => m.type === 'error')).toBe(false);
    const joined = received.filter((m) => m.type === 'joined');
    expect(joined).toHaveLength(1);
    const updates = received.filter((m) => m.type === 'update');
    // Chunked: the joined frame carries the first slice, follow-up updates the
    // rest, each under the budget.
    expect(updates.length).toBeGreaterThanOrEqual(1);
    for (const message of [...joined, ...updates]) {
      expect(JSON.stringify(message).length).toBeLessThanOrEqual(512 + 512);
    }
    const entries = flockEntriesOf(received);
    expect(Object.keys(entries)).toHaveLength(40);
    expect(entries['key-39']).toBe('value-39');
  });

  it('a peer that reports haveVersion gets only the delta on join', async () => {
    const flock = new MemoryFlock();
    flock.set('old', 'seen');
    const haveVersion = JSON.stringify(flock.version());
    flock.set('new', 'unseen');
    const server = new LocalLoroDataPlaneServer({
      workspaceId: WORKSPACE_ID,
      resolveDoc: async () => {
        throw new Error('unused');
      },
      resolveFlockDoc: async () => flock,
    });
    const { connection, received } = makeConnection();
    await server.handleMessage(connection, {
      type: 'join',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      requestId: 'join-delta',
      workspaceId: WORKSPACE_ID,
      peerId: 'peer-1',
      room: { scope: 'flock-doc', flockDocId: 'flock-delta' },
      haveVersion,
    });
    await settle();
    await settle();

    const entries = flockEntriesOf(received);
    expect(entries).toEqual({ new: 'unseen' });
  });

  it('discards an async Flock join reply superseded on the same connection', async () => {
    const flock = new CountingFlock();
    flock.set('server-only', 'value');
    const originalExportJson = flock.exportJson.bind(flock);
    let signalExportStarted: (() => void) | undefined;
    let releaseExport: (() => void) | undefined;
    const exportStarted = new Promise<void>((resolve) => {
      signalExportStarted = resolve;
    });
    const exportReleased = new Promise<void>((resolve) => {
      releaseExport = resolve;
    });
    let deferNextExport = true;
    flock.exportJson = async (from) => {
      if (deferNextExport) {
        deferNextExport = false;
        signalExportStarted?.();
        await exportReleased;
      }
      return await originalExportJson(from);
    };
    const server = new LocalLoroDataPlaneServer({
      workspaceId: WORKSPACE_ID,
      resolveDoc: async () => {
        throw new Error('unused');
      },
      resolveFlockDoc: async () => flock,
    });
    const { connection, received } = makeConnection();
    const room = { scope: 'flock-doc' as const, flockDocId: 'flock-racy-join' };

    await server.handleMessage(connection, {
      type: 'join',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      requestId: 'join-old',
      workspaceId: WORKSPACE_ID,
      peerId: 'peer-1',
      room,
    });
    await exportStarted;
    await server.handleMessage(connection, {
      type: 'join',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      requestId: 'join-new',
      workspaceId: WORKSPACE_ID,
      peerId: 'peer-1',
      room,
    });

    releaseExport?.();
    await settle();
    await settle();
    await settle();

    expect(
      received.filter((message) => message.type === 'joined').map((message) => message.requestId)
    ).toEqual(['join-new']);
    expect(flockEntriesOf(received)).toEqual({ 'server-only': 'value' });
  });
});

describe('LocalLoroDataPlaneServer backpressure (drain-aware writer)', () => {
  const insert = (doc: LoroDoc, value: string): void => {
    doc.getText('t').insert(doc.getText('t').length, value);
    doc.commit();
  };

  it('a blocked connection pauses exports and resumes with ONE coalesced delta on drain', async () => {
    const doc = new LoroDoc();
    const server = new LocalLoroDataPlaneServer({
      workspaceId: WORKSPACE_ID,
      resolveDoc: async () => doc,
      resolveFlockDoc: async () => {
        throw new Error('unused');
      },
    });
    const { connection, received, setAccepting, drain } = makeBackpressureConnection();
    await server.handleMessage(connection, {
      type: 'join',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      requestId: 'join-bp',
      workspaceId: WORKSPACE_ID,
      peerId: 'peer-1',
      room: { scope: 'doc', docId: 'doc-1' },
    });
    await settle();
    await settle();
    expect(received.filter((m) => m.type === 'joined')).toHaveLength(1);

    setAccepting(false);
    insert(doc, 'a');
    await settle();
    // The first delta went out (and flipped the connection to blocked)…
    const updatesWhileBlocked = () =>
      received.filter((m) => m.type === 'update' && m.payload.kind === 'doc-update');
    expect(updatesWhileBlocked()).toHaveLength(1);

    // …further edits must NOT produce frames while blocked (no unbounded
    // buffering, no disconnect — the old design destroyed the socket here).
    insert(doc, 'b');
    insert(doc, 'c');
    await settle();
    await settle();
    expect(updatesWhileBlocked()).toHaveLength(1);
    expect(received.some((m) => m.type === 'error')).toBe(false);

    // Drain: everything missed arrives as ONE coalesced delta.
    setAccepting(true);
    drain();
    await settle();
    await settle();
    expect(updatesWhileBlocked()).toHaveLength(2);

    const mirror = new LoroDoc();
    for (const message of received) {
      if (message.type === 'update' && message.payload.kind === 'doc-update') {
        mirror.import(base64ToBytes(message.payload.dataBase64));
      }
    }
    expect(mirror.getText('t').toString()).toBe('abc');
  });
});
