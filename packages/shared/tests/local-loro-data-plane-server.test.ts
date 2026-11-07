import { beforeEach, afterEach } from 'vitest';
import { Effect, Layer } from 'effect';

import { LocalLoroWriterTurn } from '../src/local-loro-writer';
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
    const entries = flockEntriesOf(received);
    expect(Object.keys(entries)).toHaveLength(40);
    expect(entries['key-39']).toBe('value-39');
  });
});

describe('LocalLoroDataPlaneServerLegacy backpressure (drain-aware writer)', () => {
  const insert = (doc: LoroDoc, value: string): void => {
    doc.getText('t').insert(doc.getText('t').length, value);
    doc.commit();
  };

  it('a slow connection preserves edits and resumes synchronization on drain', async () => {
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
beforeEach(() => {
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
afterEach(async () => {
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
    const cleared = new EphemeralStore();
    for (const frame of snapshots.filter((message) => message.workspaceId === 'a'))
      cleared.apply(base64ToBytes(frame.dataBase64));
    const latest = new EphemeralStore();
    for (const frame of snapshots.filter((message) => message.workspaceId === 'b'))
      latest.apply(base64ToBytes(frame.dataBase64));
    expect(cleared.get('active-session')).toBeUndefined();
    expect(latest.get('active-session')).toBe('final');
    expect(flockEntriesOf(slow.received)).toEqual({ latest: 1 });
    await Promise.all([first.disposeLegacy(), second.disposeLegacy()]);
  });
});

describe('prompt suggestion channel', () => {
  it('replays the latest local suggestion on join and delivers later clears outside presence', async () => {
    const store = new EphemeralStore(86_400_000);
    const receivedStore = new EphemeralStore(86_400_000);
    store.set('machine:session', {
      machineId: 'machine',
      sessionId: 'session',
      result: { type: 'completed', text: 'Continue' },
    });
    const { connection, received } = makeConnection('suggestion-peer');
    const server = new LocalLoroDataPlaneServerLegacy({
      workspaceId: WORKSPACE_ID,
      resolveDoc: async () => new LoroDoc(),
      resolveFlockDoc: async () => new MemoryFlock(),
      promptSuggestionSource: {
        encodeAll: () => store.encodeAll(),
        subscribe: (listener) => store.subscribe(listener),
      },
    });
    try {
      await server.handleMessage(connection, {
        type: 'join',
        protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
        workspaceId: WORKSPACE_ID,
        peerId: 'viewer',
        requestId: 'join',
        room: { scope: 'doc', docId: 'session' },
      });
      await settle();
      const applyLatest = () => {
        const frames = received.filter((m) => m.type === 'prompt-suggestions');
        expect(frames.length).toBeGreaterThan(0);
        for (const frame of frames) receivedStore.apply(base64ToBytes(frame.dataBase64));
        return receivedStore.getAllStates()['machine:session'];
      };
      expect(applyLatest()).toMatchObject({ result: { text: 'Continue' } });
      store.set('machine:session', {
        machineId: 'machine',
        sessionId: 'session',
        result: { type: 'completed', text: null },
      });
      await settle();
      expect(applyLatest()).toMatchObject({ result: { text: null } });
      expect(received.some((m) => m.type === 'presence')).toBe(false);
    } finally {
      await server.disposeLegacy();
      store.destroy();
      receivedStore.destroy();
    }
  });
});
