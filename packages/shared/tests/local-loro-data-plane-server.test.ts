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
  createJsonLineSplitter,
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
  type FlockVersionVector,
  type LocalLoroDataPlaneServerMessage,
} from '../src/local-loro-data-plane';
import {
  PromptSuggestionStore,
  readPromptSuggestion,
  PROMPT_SUGGESTION_TTL_MS,
} from '../src/prompt-suggestions';
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

  it('isolates machine/session identity and replaces text with explicit empty or failed results', () => {
    const source = new PromptSuggestionStore();
    const peer = new EphemeralStore(PROMPT_SUGGESTION_TTL_MS);
    try {
      source.publish('machine-a', {
        sessionId: 'session-a',
        result: { type: 'completed', text: '  hello\nworld ' },
      });
      source.publish('machine-a', {
        sessionId: 'session-b',
        result: { type: 'completed', text: 'other' },
      });
      peer.apply(source.encode());
      expect(readPromptSuggestion(peer.getAllStates(), 'machine-a', 'session-a')).toBe(
        '  hello\nworld '
      );
      expect(readPromptSuggestion(peer.getAllStates(), 'machine-b', 'session-a')).toBeNull();
      for (const result of [
        { type: 'completed', text: null },
        { type: 'completed', text: '' },
        { type: 'failed' },
      ] as const) {
        vi.advanceTimersByTime(1);
        source.publish('machine-a', { sessionId: 'session-a', result });
        peer.apply(source.encode());
        expect(readPromptSuggestion(peer.getAllStates(), 'machine-a', 'session-a')).toBeNull();
        expect(readPromptSuggestion(peer.getAllStates(), 'machine-a', 'session-b')).toBe('other');
      }
    } finally {
      source.destroy();
      peer.destroy();
    }
  });
});

describe('local data-plane UTF-8 chunk decoding', () => {
  const UTF8_PATH = '01_CH3.5.5_软件研究_申报资料/CH3.5.5.1_软件描述文档.md';

  it('reassembles a flock bundle frame split at every byte offset', () => {
    const frame = `${JSON.stringify({ kind: 'flock-json', entries: { [UTF8_PATH]: { kind: 'file' } } })}\n`;
    const bytes = new TextEncoder().encode(frame);

    for (let offset = 1; offset < bytes.byteLength; offset += 1) {
      const lines: string[] = [];
      const splitLines = createJsonLineSplitter({ onLine: (line) => lines.push(line) });
      splitLines(bytes.subarray(0, offset));
      splitLines(bytes.subarray(offset));

      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0] as string) as { entries: Record<string, unknown> };
      expect(Object.keys(parsed.entries)).toEqual([UTF8_PATH]);
      expect(lines[0]).not.toContain('\uFFFD');
    }
  });
});

describe('native file-index domain observations', () => {
  const observe = (peerId: string, ownerSessionId = 'owner') => ({
    type: 'file-index-observe' as const,
    protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
    workspaceId: WORKSPACE_ID,
    peerId,
    ownerSessionId,
    requestId: `observe-${peerId}`,
  });

  it('delivers coalesced read-only snapshots per peer and releases one observer independently', async () => {
    const callbacks = new Map<
      string,
      (state: import('../src/local-loro-data-plane').LocalNativeFileIndexState) => void
    >();
    let observerId = 0;
    const server = new LocalLoroDataPlaneServerLegacy({
      writerLegacy,
      workspaceId: WORKSPACE_ID,
      resolveDoc: async () => {
        throw new Error('Native observation must not open a document');
      },
      resolveFlockDoc: async () => {
        throw new Error('Native observation must not open a legacy Flock');
      },
      nativeFileIndexSource: {
        async subscribe(_owner, onSnapshot) {
          const id = String(++observerId);
          callbacks.set(id, onSnapshot);
          onSnapshot({
            status: 'ready',
            fileIndex: { 'initial.ts': true },
            generations: {},
            updatedAtMs: 1,
          });
          return {
            async release() {
              callbacks.delete(id);
            },
          };
        },
      },
    });
    const { connection, received, setAccepting, drain } = makeBackpressureConnection();
    await server.handleMessage(connection, observe('first'));
    await server.handleMessage(connection, observe('second'));
    await settle();
    expect(
      received
        .filter((message) => message.type === 'file-index-observed')
        .map((message) => message.peerId)
    ).toEqual(['first', 'second']);
    const snapshots = () => received.filter((message) => message.type === 'file-index-snapshot');
    expect(
      snapshots()
        .filter((message) => message.peerId === 'first')
        .at(-1)?.state
    ).toMatchObject({ status: 'ready', fileIndex: { 'initial.ts': true } });
    setAccepting(false);
    for (const callback of callbacks.values()) callback({ status: 'loading' });
    await settle();
    for (const callback of callbacks.values())
      callback({
        status: 'ready',
        fileIndex: { 'latest.ts': true },
        generations: { 'latest.ts': 'generation' },
        updatedAtMs: 2,
      });
    await settle();
    setAccepting(true);
    drain();
    await settle();
    expect(
      snapshots()
        .filter((message) => message.peerId === 'second')
        .at(-1)?.state
    ).toMatchObject({
      status: 'ready',
      fileIndex: { 'latest.ts': true },
      generations: { 'latest.ts': 'generation' },
    });
    await server.handleMessage(connection, { ...observe('first'), type: 'file-index-unobserve' });
    const firstCount = snapshots().filter((message) => message.peerId === 'first').length;
    for (const callback of callbacks.values())
      callback({ status: 'ready', fileIndex: {}, updatedAtMs: 3 });
    await settle();
    expect(callbacks.size).toBe(1);
    expect(snapshots().filter((message) => message.peerId === 'first')).toHaveLength(firstCount);
    expect(
      snapshots()
        .filter((message) => message.peerId === 'second')
        .at(-1)?.state
    ).toMatchObject({ status: 'ready', fileIndex: {} });
    await server.disposeLegacy();
    expect(callbacks.size).toBe(0);
  });

  it('keeps a replacement reset when an older observation is queued behind backpressure', async () => {
    let generation = 0;
    const server = new LocalLoroDataPlaneServerLegacy({
      writerLegacy,
      workspaceId: WORKSPACE_ID,
      resolveDoc: async () => {
        throw new Error('unused');
      },
      resolveFlockDoc: async () => {
        throw new Error('unused');
      },
      nativeFileIndexSource: {
        async subscribe(_owner, onSnapshot) {
          generation++;
          onSnapshot({
            status: 'ready',
            fileIndex: { [`generation-${generation}`]: true },
            updatedAtMs: generation,
          });
          return { async release() {} };
        },
      },
    });
    const { connection, received, setAccepting, drain } = makeBackpressureConnection();
    setAccepting(false);
    await server.handleMessage(connection, observe('replaced'));
    await settle();
    await server.handleMessage(connection, { ...observe('replaced'), requestId: 'new-request' });
    setAccepting(true);
    drain();
    await settle();
    expect(received.filter((message) => message.type === 'file-index-snapshot')).toEqual([
      {
        ...observe('replaced'),
        type: 'file-index-snapshot',
        requestId: 'new-request',
        state: { status: 'ready', fileIndex: { 'generation-2': true }, updatedAtMs: 2 },
      },
    ]);
    await server.disposeLegacy();
  });

  it('fences a late subscription after disconnect and joins its actual release', async () => {
    let accept!: () => void;
    const pending = new Promise<void>((resolve) => {
      accept = resolve;
    });
    let started!: () => void;
    const subscribed = new Promise<void>((resolve) => {
      started = resolve;
    });
    let active = false;
    const server = new LocalLoroDataPlaneServerLegacy({
      writerLegacy,
      workspaceId: WORKSPACE_ID,
      resolveDoc: async () => {
        throw new Error('unused');
      },
      resolveFlockDoc: async () => {
        throw new Error('unused');
      },
      nativeFileIndexSource: {
        async subscribe(_owner, onSnapshot) {
          started();
          await pending;
          active = true;
          onSnapshot({ status: 'ready', fileIndex: { 'late.ts': true }, updatedAtMs: 1 });
          return {
            async release() {
              active = false;
            },
          };
        },
      },
    });
    const { connection, received } = makeConnection();
    const opening = server.handleMessage(connection, observe('late'));
    await subscribed;
    const closing = server.handleDisconnectLegacy(connection.id);
    accept();
    await opening;
    await closing;
    await settle();
    expect(active).toBe(false);
    expect(received.filter((message) => message.type.startsWith('file-index-'))).toEqual([]);
    await server.disposeLegacy();
  });

  it('bounds a stalled unsubscribe without blocking a different peer and retains late settlement', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let releasing!: () => void;
    const started = new Promise<void>((resolve) => {
      releasing = resolve;
    });
    let settledRelease = false;
    const server = new LocalLoroDataPlaneServerLegacy({
      writerLegacy,
      workspaceId: WORKSPACE_ID,
      nativeFileIndexReleaseTimeoutMs: 5,
      resolveDoc: async () => {
        throw new Error('unused');
      },
      resolveFlockDoc: async () => {
        throw new Error('unused');
      },
      nativeFileIndexSource: {
        async subscribe(owner, onSnapshot) {
          onSnapshot({ status: 'ready', fileIndex: { [owner]: true }, updatedAtMs: 1 });
          return {
            async release() {
              if (owner === 'stalled') {
                releasing();
                await pending;
                settledRelease = true;
              }
            },
          };
        },
      },
    });
    const { connection, received } = makeConnection();
    await server.handleMessage(connection, observe('stalled', 'stalled'));
    const closing = server.handleMessage(connection, {
      ...observe('stalled', 'stalled'),
      type: 'file-index-unobserve',
    });
    await started;
    await vi.advanceTimersByTimeAsync(5);
    await closing;
    expect(settledRelease).toBe(false);
    await server.handleMessage(connection, observe('independent', 'independent'));
    await settle();
    expect(
      received
        .filter(
          (message) => message.type === 'file-index-snapshot' && message.peerId === 'independent'
        )
        .at(-1)
    ).toMatchObject({ state: { status: 'ready', fileIndex: { independent: true } } });
    finish();
    await pending;
    await server.disposeLegacy();
    expect(settledRelease).toBe(true);
  });

  it('answers legacy capability explicitly without opening a Flock room', async () => {
    const server = new LocalLoroDataPlaneServerLegacy({
      writerLegacy,
      workspaceId: WORKSPACE_ID,
      resolveDoc: async () => {
        throw new Error('unused');
      },
      resolveFlockDoc: async () => {
        throw new Error('legacy fallback belongs to its caller');
      },
    });
    const { connection, received } = makeConnection();
    await server.handleMessage(connection, observe('legacy'));
    await settle();
    expect(received.filter((message) => message.type === 'file-index-observed')).toEqual([
      { ...observe('legacy'), type: 'file-index-observed', backend: 'legacy' },
    ]);
    await server.disposeLegacy();
  });
});
