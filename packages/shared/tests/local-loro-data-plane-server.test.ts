import { beforeEach, afterEach } from 'vitest';
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Queue, Scope } from 'effect';
import { it as effectIt } from '@effect/vitest';
import { TestClock } from 'effect/testing';
import {
  LocalLoroWriterTurn,
  makeLocalLoroWriter,
  makeLocalLoroWriterOwner,
} from '../src/local-loro-writer';
import {
  makeLocalLoroWriterLegacy,
  type LocalLoroWriterLegacy,
} from '../src/local-loro-writer/legacy';
import { describe, expect, it, vi } from 'vitest';
import { EphemeralStore, LoroDoc } from 'loro-crdt';
import {
  LocalLoroDataPlaneServerLegacy,
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
  exportGate: Promise<void> | null = null;
  onExport: (() => void) | null = null;

  override async exportJson(
    from: FlockVersionVector
  ): Promise<ReturnType<MemoryFlock['exportJson']>> {
    this.exportCount += 1;
    this.onExport?.();
    if (this.exportGate) await this.exportGate;
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

const settle = () => vi.advanceTimersByTimeAsync(100);

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

describe('LocalLoroDataPlaneServerLegacy doc room hydration signals', () => {
  it('notifies doc room joins and publishes room status to subscribers', async () => {
    const active = new Set<string>();
    const onDocRoomJoin = (id: string) => {
      active.add(id);
    };
    const onDocRoomLeave = (id: string) => {
      active.delete(id);
    };
    const server = new LocalLoroDataPlaneServerLegacy({
      writerLegacy,
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

    expect([...active]).toEqual(['session-1']);

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

    expect(active.size).toBe(0);
  });

  it('notifies flock room joins and leaves for local-first cloud bridging', async () => {
    const active = new Set<string>();
    const onFlockRoomJoin = (id: string) => {
      active.add(id);
    };
    const onFlockRoomLeave = (id: string) => {
      active.delete(id);
    };
    const server = new LocalLoroDataPlaneServerLegacy({
      writerLegacy,
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

    expect([...active]).toEqual(['ws:fis:session-1']);

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

    expect(active.size).toBe(0);
  });
});

describe('LocalLoroDataPlaneServerLegacy machine monitor bridge', () => {
  it('applies renderer observer state and pushes the current CLI monitor state', async () => {
    let notifyChange: (() => void) | null = null;
    let applied: Uint8Array | null = null;
    const apply = (update: Uint8Array) => {
      applied = update;
    };
    const server = new LocalLoroDataPlaneServerLegacy({
      writerLegacy,
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

    expect(applied).toEqual(new Uint8Array([1, 2, 3]));
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
    await server.disposeLegacy();
  });
});

describe('LocalLoroDataPlaneServerLegacy flock write-time coalescing', () => {
  const makeFlockServer = (flock: CountingFlock) =>
    new LocalLoroDataPlaneServerLegacy({
      writerLegacy,
      workspaceId: WORKSPACE_ID,
      resolveDoc: async () => {
        throw new Error('unused');
      },
      resolveFlockDoc: async () => flock,
    });

  const joinFlockRoom = async (
    server: LocalLoroDataPlaneServerLegacy,
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
    const server = makeFlockServer(flock);
    const { connection, received } = makeConnection();
    await joinFlockRoom(server, connection);

    let release = () => {};
    flock.exportGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    flock.onExport = ready;
    flock.set('first', 1);
    await vi.advanceTimersByTimeAsync(1);
    await started;
    flock.set('second', 2);
    flock.exportGate = null;
    release();
    await settle();

    const entries = flockEntriesOf(received.filter((m) => m.type === 'update'));
    expect(entries['second']).toBe(2);
  });
});

describe('LocalLoroDataPlaneServerLegacy incremental flock sync', () => {
  it('a join catch-up above the frame budget is chunked, not failed', async () => {
    const flock = new MemoryFlock();
    for (let index = 0; index < 40; index += 1) {
      flock.set(`key-${String(index).padStart(2, '0')}`, `value-${index}`);
    }
    const server = new LocalLoroDataPlaneServerLegacy({
      writerLegacy,
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
    const server = new LocalLoroDataPlaneServerLegacy({
      writerLegacy,
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
    const server = new LocalLoroDataPlaneServerLegacy({
      writerLegacy,
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
    await vi.advanceTimersByTimeAsync(1);
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

describe('LocalLoroDataPlaneServerLegacy backpressure (drain-aware writer)', () => {
  const insert = (doc: LoroDoc, value: string): void => {
    doc.getText('t').insert(doc.getText('t').length, value);
    doc.commit();
  };

  it('a blocked connection pauses exports and resumes with ONE coalesced delta on drain', async () => {
    const doc = new LoroDoc();
    const server = new LocalLoroDataPlaneServerLegacy({
      writerLegacy,
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

let writerLegacy: LocalLoroWriterLegacy;
beforeEach((context) => {
  if (context.task.suite?.name === 'native process writer ownership') return;
  vi.useFakeTimers();
  writerLegacy = makeLocalLoroWriterLegacy(
    Layer.succeed(LocalLoroWriterTurn, {
      next: Effect.callback<void>((resume) => {
        const handle = setTimeout(() => resume(Effect.void), 0);
        return Effect.sync(() => clearTimeout(handle));
      }),
    })
  );
});
afterEach(async (context) => {
  if (context.task.suite?.name === 'native process writer ownership') return;
  const closed = writerLegacy.closeLegacy();
  await vi.runAllTimersAsync();
  await closed;
  vi.useRealTimers();
});

describe('local presence on the shared physical writer', () => {
  it('pauses every workspace export on write(false) and snapshots the final clear only at execution', async () => {
    const slow = makeBackpressureConnection('multiplexed-presence');
    slow.setAccepting(false);
    const source = () => {
      const store = new EphemeralStore();
      const listeners = new Set<() => void>();
      return {
        store,
        listeners,
        notify: () => {
          for (const listener of listeners) listener();
        },
        presence: {
          encodeLocalOrigin: () => store.encodeAll(),
          subscribeLocalOrigin: (listener: () => void) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        },
      };
    };
    const a = source();
    const b = source();
    a.store.set('active-session', 'running');
    b.store.set('active-session', 'starting');
    const flock = new CountingFlock();
    flock.set('latest', 1);
    const engine = (workspaceId: string, presenceSource: typeof a.presence) =>
      new LocalLoroDataPlaneServerLegacy({
        workspaceId,
        writerLegacy,
        presenceSource,
        resolveDoc: async () => new LoroDoc(),
        resolveFlockDoc: async () => flock,
      });
    const first = engine('a', a.presence);
    const second = engine('b', b.presence);
    await first.handleMessage(slow.connection, {
      type: 'detach',
      protocolVersion: 7,
      workspaceId: 'a',
      peerId: 'a',
    });
    await settle(); // first presence accepted, physical writer now blocked
    await second.handleMessage(slow.connection, {
      type: 'join',
      protocolVersion: 7,
      workspaceId: 'b',
      peerId: 'b',
      requestId: 'join-b',
      room: { scope: 'flock-doc', flockDocId: 'f' },
    });
    for (let value = 0; value < 20; value++) {
      a.store.set('active-session', `phase-${value}`);
      a.notify();
      b.store.set('active-session', `phase-${value}`);
      b.notify();
    }
    a.store.delete('active-session');
    a.notify();
    b.store.set('active-session', 'final');
    b.notify();
    await settle();
    expect(slow.received).toHaveLength(1);
    expect(flock.exportCount).toBe(0);
    slow.setAccepting(true);
    slow.drain();
    await settle();
    const snapshots = slow.received.filter((message) => message.type === 'presence');
    expect(snapshots.map((message) => message.workspaceId)).toEqual(['a', 'b', 'a']);
    const cleared = new EphemeralStore();
    cleared.apply(base64ToBytes(snapshots[2].dataBase64));
    const latest = new EphemeralStore();
    latest.apply(base64ToBytes(snapshots[1].dataBase64));
    expect(cleared.get('active-session')).toBeUndefined();
    expect(latest.get('active-session')).toBe('final');
    expect(flockEntriesOf(slow.received)).toEqual({ latest: 1 });
    await Promise.all([first.disposeLegacy(), second.disposeLegacy()]);
    expect(a.listeners.size + b.listeners.size).toBe(0);
  });

  it('a change during send leaves one follow-up and delivers its final deletion', async () => {
    const store = new EphemeralStore();
    store.set('active-session', 'initial');
    let notify = () => {};
    const states: Array<unknown> = [];
    const connection = {
      id: 'reentrant-presence',
      send: (message: LocalLoroDataPlaneServerMessage) => {
        if (message.type !== 'presence') return;
        const snapshot = new EphemeralStore();
        snapshot.apply(base64ToBytes(message.dataBase64));
        states.push(snapshot.get('active-session'));
        if (states.length === 1) {
          for (let i = 0; i < 30; i++) {
            store.set('active-session', `burst-${i}`);
            notify();
          }
          store.delete('active-session');
          notify();
        }
      },
    };
    const server = new LocalLoroDataPlaneServerLegacy({
      workspaceId: 'ws',
      writerLegacy,
      resolveDoc: async () => new LoroDoc(),
      resolveFlockDoc: async () => new MemoryFlock(),
      presenceSource: {
        encodeLocalOrigin: () => store.encodeAll(),
        subscribeLocalOrigin: (listener) => {
          notify = listener;
          return () => {
            notify = () => {};
          };
        },
      },
    });
    await server.handleMessage(connection, {
      type: 'detach',
      protocolVersion: 7,
      workspaceId: 'ws',
      peerId: 'peer',
    });
    await settle();
    expect(states).toEqual(['initial', undefined]);
    await server.disposeLegacy();
  });

  it('disconnect revokes queued frames and awaits the actual raw Flock Promise before a successor exports', async () => {
    const flock = new CountingFlock();
    flock.set('durable', 'value');
    let release = () => {};
    let started = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    flock.exportGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    flock.onExport = started;
    const server = new LocalLoroDataPlaneServerLegacy({
      workspaceId: 'ws',
      writerLegacy,
      resolveDoc: async () => new LoroDoc(),
      resolveFlockDoc: async () => flock,
    });
    const old = makeConnection('old-generation');
    const next = makeConnection('new-generation');
    const join = (connection: LocalLoroDataPlaneServerConnection, requestId: string) =>
      server.handleMessage(connection, {
        type: 'join',
        protocolVersion: 7,
        workspaceId: 'ws',
        peerId: 'peer',
        requestId,
        room: { scope: 'flock-doc', flockDocId: 'f' },
      });
    await join(old.connection, 'old');
    await vi.advanceTimersByTimeAsync(1);
    await ready;
    let closed = false;
    const first = server.handleDisconnectLegacy(old.connection.id).then(() => {
      closed = true;
    });
    const second = server.handleDisconnectLegacy(old.connection.id);
    await join(next.connection, 'next');
    await vi.advanceTimersByTimeAsync(1);
    expect(closed).toBe(false);
    expect(old.received).toEqual([]);
    expect(next.received).toEqual([]);
    expect(flock.exportCount).toBe(1);
    flock.exportGate = null;
    release();
    await Promise.all([first, second]);
    await settle();
    expect(old.received).toEqual([]);
    expect(
      next.received
        .filter((message) => message.type === 'joined')
        .map((message) => message.requestId)
    ).toEqual(['next']);
    expect(flockEntriesOf(next.received)).toEqual({ durable: 'value' });
    await server.disposeLegacy();
  });
});

describe('native process writer ownership', () => {
  effectIt.effect(
    'rotates workspace chunks on one socket and yields exactly one frame per host turn',
    () =>
      Effect.gen(function* () {
        const turns = yield* Queue.make<void>();
        const requested = yield* Deferred.make<void>();
        const ungated = yield* Deferred.make<void>();
        let grants = 0;
        const writer = yield* makeLocalLoroWriter.pipe(
          Effect.provideService(LocalLoroWriterTurn, {
            next: Effect.gen(function* () {
              yield* Deferred.succeed(requested, undefined);
              yield* Queue.take(turns);
              grants += 1;
            }),
          })
        );
        const seen: string[] = [];
        const signals = [
          Deferred.makeUnsafe<void>(),
          Deferred.makeUnsafe<void>(),
          Deferred.makeUnsafe<void>(),
        ];
        const connection = {
          id: 'shared-socket',
          send: (message: LocalLoroDataPlaneServerMessage) => {
            if (message.type === 'presence') seen.push(message.workspaceId);
            if (seen.length > grants) Deferred.doneUnsafe(ungated, Effect.void);
            Deferred.doneUnsafe(signals[seen.length - 1], Effect.void);
          },
        };
        const task = (workspaceId: string, frames: number) => ({
          owner: makeLocalLoroWriterOwner(),
          valid: () => true,
          onCause: () => {},
          build: Effect.succeed(
            Array.from({ length: frames }, () => ({
              type: 'presence' as const,
              protocolVersion: 7 as const,
              workspaceId,
              dataBase64: 'AA==',
            }))
          ),
        });
        writer.offer(connection, task('workspace-a', 3));
        writer.offer(connection, task('workspace-b', 1));
        const admission = yield* Effect.race(
          Deferred.await(requested).pipe(Effect.as('turn-ready')),
          Deferred.await(ungated).pipe(Effect.as('ungated-write'))
        );
        expect(admission).toBe('turn-ready');
        expect(seen).toEqual([]);
        yield* Queue.offer(turns, undefined);
        yield* Deferred.await(signals[0]);
        expect(seen).toEqual(['workspace-a']);
        yield* Queue.offer(turns, undefined);
        yield* Deferred.await(signals[1]);
        expect(seen).toEqual(['workspace-a', 'workspace-b']);
        yield* Queue.offer(turns, undefined);
        yield* Deferred.await(signals[2]);
        expect(seen).toEqual(['workspace-a', 'workspace-b', 'workspace-a']);
        yield* writer.close;
      })
  );

  effectIt.effect(
    'disconnect joins actual SDK settlement and concurrent close shares its bounded receipt',
    () =>
      Effect.gen(function* () {
        const turns = yield* Queue.make<void>();
        const writer = yield* makeLocalLoroWriter.pipe(
          Effect.provideService(LocalLoroWriterTurn, { next: Queue.take(turns) })
        );
        const started = yield* Deferred.make<void>();
        const settled = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(settled, undefined));
        let drainListener: (() => void) | null = null;
        const seen: LocalLoroDataPlaneServerMessage[] = [];
        const connection = {
          id: 'raw-sdk',
          send: (message: LocalLoroDataPlaneServerMessage) => {
            seen.push(message);
          },
          onDrain: (listener: () => void) => {
            drainListener = listener;
            return () => {
              drainListener = null;
            };
          },
        };
        const owner = makeLocalLoroWriterOwner();
        writer.offer(connection, {
          owner,
          valid: () => true,
          onCause: () => {},
          build: Effect.uninterruptible(
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(settled);
              return [{ type: 'pong' as const, protocolVersion: 7 as const }];
            })
          ),
        });
        yield* Queue.offer(turns, undefined);
        yield* Deferred.await(started);
        const first = yield* writer.disconnect(connection.id).pipe(Effect.forkChild);
        const second = yield* writer.disconnect(connection.id).pipe(Effect.forkChild);
        yield* TestClock.adjust('5 seconds');
        const a = yield* Fiber.await(first);
        const b = yield* Fiber.await(second);
        expect(Exit.isFailure(a)).toBe(true);
        expect(b).toEqual(a);
        expect(drainListener).toBeNull();
        expect(seen).toEqual([]);
        expect(() =>
          writer.offer(connection, {
            owner: makeLocalLoroWriterOwner(),
            valid: () => true,
            onCause: () => {},
            build: Effect.succeed([]),
          })
        ).toThrow('release_pending');
        yield* Deferred.succeed(settled, undefined);
        yield* writer.disconnect(connection.id);
        expect(seen).toEqual([]);
        const delivered = yield* Deferred.make<void>();
        writer.offer(connection, {
          owner: makeLocalLoroWriterOwner(),
          valid: () => true,
          onCause: () => {},
          build: Effect.sync(() => {
            Deferred.doneUnsafe(delivered, Effect.void);
            return [];
          }),
        });
        yield* Queue.offer(turns, undefined);
        yield* Deferred.await(delivered);
        yield* writer.close;
      })
  );

  effectIt.effect(
    'Scope finalizer observation is bounded without abandoning the raw producer',
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const turns = yield* Queue.make<void>();
        const writer = yield* Scope.provide(
          makeLocalLoroWriter.pipe(
            Effect.provideService(LocalLoroWriterTurn, { next: Queue.take(turns) })
          ),
          scope
        );
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(finish, undefined));
        writer.offer(
          {
            id: 'finalizer',
            send: () => {
              throw new Error('late write');
            },
          },
          {
            owner: makeLocalLoroWriterOwner(),
            valid: () => true,
            onCause: () => {},
            build: Effect.uninterruptible(
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(finish);
                return [{ type: 'pong' as const, protocolVersion: 7 as const }];
              })
            ),
          }
        );
        yield* Queue.offer(turns, undefined);
        yield* Deferred.await(started);
        const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
        yield* TestClock.adjust('10 seconds');
        const result = yield* Fiber.await(closing);
        expect(Exit.isFailure(result)).toBe(true);
        yield* Deferred.succeed(finish, undefined);
        // Scope.close is already consumed. Recovery belongs to writer.close.
        yield* writer.close;
      })
  );

  effectIt.effect(
    'failed drain unsubscribe retains the original complete Cause until recovery',
    () =>
      Effect.gen(function* () {
        const turns = yield* Queue.make<void>();
        const writer = yield* makeLocalLoroWriter.pipe(
          Effect.provideService(LocalLoroWriterTurn, { next: Queue.take(turns) })
        );
        const defect = new Error('synthetic unsubscribe defect');
        let removable = false;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            removable = true;
          })
        );
        let attached = false;
        const connection = {
          id: 'release-failure',
          send: () => {},
          onDrain: () => {
            attached = true;
            return () => {
              if (!removable) throw defect;
              attached = false;
            };
          },
        };
        writer.offer(connection, {
          owner: makeLocalLoroWriterOwner(),
          valid: () => true,
          onCause: () => {},
          build: Effect.succeed([]),
        });
        const first = yield* writer.disconnect(connection.id).pipe(Effect.exit);
        const second = yield* writer.disconnect(connection.id).pipe(Effect.exit);
        expect(Exit.isFailure(first)).toBe(true);
        if (Exit.isFailure(first) && Exit.isFailure(second)) {
          const a = Cause.findErrorOption(first.cause);
          const b = Cause.findErrorOption(second.cause);
          expect(a._tag).toBe('Some');
          if (a._tag === 'Some' && b._tag === 'Some')
            expect(a.value.fullCause).toBe(b.value.fullCause);
        }
        expect(attached).toBe(true);
        expect(() =>
          writer.offer(connection, {
            owner: makeLocalLoroWriterOwner(),
            valid: () => true,
            onCause: () => {},
            build: Effect.succeed([]),
          })
        ).toThrow('release_pending');
        removable = true;
        yield* writer.disconnect(connection.id);
        expect(attached).toBe(false);
        yield* writer.close;
      })
  );

  effectIt.effect(
    'the native writer reports mixed Fail/Die/Interrupt without selecting only Fail',
    () =>
      Effect.gen(function* () {
        const turns = yield* Queue.make<void>();
        const writer = yield* makeLocalLoroWriter.pipe(
          Effect.provideService(LocalLoroWriterTurn, { next: Queue.take(turns) })
        );
        const cause = Cause.combine(
          Cause.fail('synthetic failure'),
          Cause.combine(Cause.die('synthetic defect'), Cause.interrupt())
        );
        const reported = yield* Deferred.make<Cause.Cause<unknown>>();
        writer.offer(
          { id: 'cause', send: () => {} },
          {
            owner: makeLocalLoroWriterOwner(),
            valid: () => true,
            build: Effect.failCause(cause),
            onCause: (value) => {
              Deferred.doneUnsafe(reported, Effect.succeed(value));
            },
          }
        );
        yield* Queue.offer(turns, undefined);
        expect(yield* Deferred.await(reported)).toEqual(cause);
        yield* writer.close;
      })
  );
});
