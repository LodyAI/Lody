import { EphemeralStreamCrdt } from '@loro-dev/streams-crdt/loro';
import { classifyMachinePresence } from '../../../apps/cli/src/commands/session-machine-presence';
import { collectOnlineMachineIdsFromPresence } from '../src/presence';
import type { MachineId } from '../src/ids';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EphemeralStore } from 'loro-crdt';
import { createEncryptedPresenceAdaptorLegacy } from '../src/encrypted-presence-adaptor-legacy';
import { isFreshLodyPresenceState, parseLodyPresenceStates } from '../src/presence';
import type { EncryptedPresencePort, EncryptedPresenceEntry } from '../src/encrypted-presence';

const state = { kind: 'machine', machineId: 'm', instanceId: 'i', updatedAt: 1000 } as const;
const publicationKey = 'machine:m:i';
const envelope = (frame: Uint8Array, id = 'a'.repeat(32)) => {
  const transport = new EphemeralStore(60000);
  try {
    transport.set(id, frame);
    return transport.encodeAll();
  } finally {
    transport.destroy();
  }
};
const ciphertexts = (update: Uint8Array) => {
  const transport = new EphemeralStore(60000);
  try {
    transport.apply(update);
    return Object.values(transport.getAllStates());
  } finally {
    transport.destroy();
  }
};
afterEach(() => {
  vi.useRealTimers();
});
describe('encrypted ephemeral adaptor', () => {
  it('coalesces before crypto, emits only ciphertext, prioritizes heartbeats and preserves ordinary DTOs', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    vi.setSystemTime(1000);
    const store = new EphemeralStore(90000);
    const sent: Uint8Array[] = [];
    const publications: unknown[] = [];
    const port: EncryptedPresencePort = {
      seal: async (p) => {
        publications.push(p);
        return new Uint8Array([231, publications.length]);
      },
      open: async () => null,
    };
    const encrypted = createEncryptedPresenceAdaptorLegacy(store, port);
    encrypted.adaptor.subscribeLocalUpdates((bytes) => sent.push(bytes));
    try {
      store.set('session:s:i', {
        kind: 'session',
        sessionId: 's',
        machineId: 'm',
        instanceId: 'i',
        status: { type: 'running' },
        updatedAt: 1000,
      });
      store.set(publicationKey, state);
      store.set(publicationKey, { ...state, updatedAt: 1001 });
      expect(sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(250);
      expect(publications).toEqual([{ key: publicationKey, state: { ...state, updatedAt: 1001 } }]);
      expect(sent.map(ciphertexts)).toEqual([[new Uint8Array([231, 1])]]);
      expect(encrypted.adaptor.localUpdateKey(sent[0])).toMatch(/^[0-9a-f]{32}$/);
      await vi.advanceTimersByTimeAsync(250);
      expect(sent.map(ciphertexts)).toEqual([
        [new Uint8Array([231, 1])],
        [new Uint8Array([231, 2])],
      ]);
    } finally {
      await encrypted.close();
      store.destroy();
    }
  });
  it('isolates bad frames and crypto failure, applies authenticated entries without echo, and honors expiry', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    vi.setSystemTime(1000);
    const store = new EphemeralStore(90000);
    const sent: Uint8Array[] = [];
    const port: EncryptedPresencePort = {
      seal: async () => {
        throw new Error('unavailable');
      },
      open: async (frame) => {
        if (frame[0] === 0) return null;
        if (frame[0] === 1) return null;
        return { key: 'author:machine:m:i', state, expiresAt: 61000 };
      },
    };
    const encrypted = createEncryptedPresenceAdaptorLegacy(store, port);
    encrypted.adaptor.subscribeLocalUpdates((bytes) => sent.push(bytes));
    try {
      await encrypted.adaptor.applyRemoteUpdates([
        envelope(new Uint8Array([0]), 'a'.repeat(32)),
        envelope(new Uint8Array([1]), 'b'.repeat(32)),
        envelope(new Uint8Array([2]), 'c'.repeat(32)),
      ]);
      const parsed = parseLodyPresenceStates(store.getAllStates(), { authenticatedExpiry: true });
      expect(parsed['author:machine:m:i']).toEqual({ ...state, expiresAt: 61000 });
      expect(parseLodyPresenceStates(store.getAllStates())['author:machine:m:i']).toEqual(state);
      expect(isFreshLodyPresenceState(parsed['author:machine:m:i'], 60999)).toBe(true);
      expect(isFreshLodyPresenceState(parsed['author:machine:m:i'], 61000)).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(59000);
      expect(store.get('author:machine:m:i')).toBeUndefined();
      store.set(publicationKey, state);
      await vi.advanceTimersByTimeAsync(250);
      expect(store.get(publicationKey)).toEqual(state);
      expect(sent).toEqual([]);
    } finally {
      await encrypted.close();
      store.destroy();
    }
  });
  it('fences a late native signature and joins its actual completion before closing', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    vi.setSystemTime(1000);
    const store = new EphemeralStore(90000);
    const sent: Uint8Array[] = [];
    let finish!: (value: Uint8Array) => void;
    const port: EncryptedPresencePort = {
      seal: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      open: async () => null,
    };
    const encrypted = createEncryptedPresenceAdaptorLegacy(store, port);
    encrypted.adaptor.subscribeLocalUpdates((bytes) => sent.push(bytes));
    store.set(publicationKey, state);
    await vi.advanceTimersByTimeAsync(250);
    let closed = false;
    const closing = encrypted.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish(new Uint8Array([99]));
    await closing;
    expect(closed).toBe(true);
    expect(sent).toEqual([]);
    store.destroy();
  });
  it('retires cached state and late projections on verified ledger changes', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    vi.setSystemTime(1000);
    const store = new EphemeralStore(90000);
    let invalidate!: () => void;
    let finish!: (entry: Awaited<ReturnType<EncryptedPresencePort['open']>>) => void;
    const port: EncryptedPresencePort = {
      subscribeInvalidation: (listener) => {
        invalidate = listener;
        return () => {};
      },
      seal: async () => new Uint8Array(),
      open: async (frame) =>
        frame[0] === 1
          ? { key: 'author:machine:m:i', state, expiresAt: 61000 }
          : new Promise((resolve) => {
              finish = resolve;
            }),
    };
    const encrypted = createEncryptedPresenceAdaptorLegacy(store, port);
    await encrypted.adaptor.applyRemoteUpdates([envelope(new Uint8Array([1]))]);
    expect(store.get('author:machine:m:i')).toBeDefined();
    const pending = encrypted.adaptor.applyRemoteUpdates([envelope(new Uint8Array([2]))]);
    invalidate();
    expect(store.get('author:machine:m:i')).toBeUndefined();
    finish({ key: 'author:machine:m:i', state, expiresAt: 61000 });
    await pending;
    expect(store.get('author:machine:m:i')).toBeUndefined();
    await encrypted.close();
    store.destroy();
  });
});

it('retains ciphertext in the real server EphemeralStore and hydrates a late subscriber from its bootstrap', async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  vi.setSystemTime(1000);
  const source = new EphemeralStore(60000),
    server = new EphemeralStore(90000),
    target = new EphemeralStore(60000);
  const outgoing: Uint8Array[] = [];
  const cipher = new Uint8Array(324).fill(231);
  cipher[0] = 0;
  const writer = createEncryptedPresenceAdaptorLegacy(source, {
    seal: async () => cipher,
    open: async () => null,
  });
  const reader = createEncryptedPresenceAdaptorLegacy(target, {
    seal: async () => new Uint8Array(),
    open: async (frame) =>
      Buffer.from(frame).equals(Buffer.from(cipher))
        ? { key: 'author:machine:m:i', state, expiresAt: 61000 }
        : null,
  });
  writer.adaptor.subscribeLocalUpdates((bytes) => outgoing.push(bytes));
  try {
    source.set(publicationKey, state);
    await vi.advanceTimersByTimeAsync(250);
    expect(outgoing).toHaveLength(1);
    server.apply(outgoing[0]);
    expect(Object.keys(server.getAllStates())).toHaveLength(1);
    expect(new TextDecoder().decode(outgoing[0])).not.toContain(publicationKey);
    await reader.adaptor.applyRemoteUpdates([server.encodeAll()]);
    expect(target.get('author:machine:m:i')).toEqual({ ...state, expiresAt: 61000 });
  } finally {
    await writer.close();
    await reader.close();
    source.destroy();
    server.destroy();
    target.destroy();
  }
});

it('reconstructs a replacement store from retained authenticated receipts even when the host rejects replayed bootstrap frames', async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  vi.setSystemTime(1000);
  const receipts = new Map<string, EncryptedPresenceEntry>();
  const port: EncryptedPresencePort = {
    seal: async () => new Uint8Array(),
    open: async () => ({ key: 'author:machine:m:i', state, expiresAt: 61000 }),
  };
  const firstStore = new EphemeralStore(60000);
  const first = createEncryptedPresenceAdaptorLegacy(firstStore, port, { retained: receipts });
  const bootstrap = envelope(new Uint8Array([77]));
  await first.adaptor.applyRemoteUpdates([bootstrap]);
  await first.close();
  firstStore.destroy();
  port.open = async () => null; // The same host still remembers this exact original.
  const replacementStore = new EphemeralStore(60000);
  const replacement = createEncryptedPresenceAdaptorLegacy(replacementStore, port, {
    retained: receipts,
  });
  try {
    await replacement.adaptor.applyRemoteUpdates([bootstrap]);
    expect(replacementStore.get('author:machine:m:i')).toEqual({ ...state, expiresAt: 61000 });
    await vi.advanceTimersByTimeAsync(60000);
    expect(replacementStore.get('author:machine:m:i')).toBeUndefined();
    expect(receipts.size).toBe(0);
  } finally {
    await replacement.close();
    replacementStore.destroy();
  }
});

it('keeps a real SDK joined room unknown during local crypto failure and recovers after key availability changes', async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  vi.setSystemTime(1000);
  const store = new EphemeralStore(60000);
  const listeners = new Set<() => void>();
  const recovered = Promise.withResolvers<void>();
  let locked = true;
  const bridge = createEncryptedPresenceAdaptorLegacy(
    store,
    {
      seal: async () => new Uint8Array(),
      open: async (frame) =>
        frame[0] === 0
          ? null
          : locked
            ? { unavailable: true }
            : { key: 'author:machine:m:i', state, expiresAt: 61000 },
      subscribeInvalidation: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    {
      onAvailabilityChange: (available) => {
        if (available) recovered.resolve();
      },
    }
  );
  const bootstrap = envelope(new Uint8Array([77]));
  const sdk = new EphemeralStreamCrdt({
    streamUrl: 'https://synthetic.invalid/ds/protected/workspace?ephemeral=presence',
    auth: async () => undefined,
    adaptor: bridge.adaptor,
    fetch: async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `event: bootstrap\ndata: ${Buffer.from(bootstrap).toString('base64')}\n\n`
              )
            );
            init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream', 'Stream-SSE-Data-Encoding': 'base64' } }
      ),
  });
  try {
    expect((await sdk.join()).ok).toBe(true);
    const online = () =>
      bridge.isAvailable()
        ? collectOnlineMachineIdsFromPresence(
            parseLodyPresenceStates(store.getAllStates(), { authenticatedExpiry: true }),
            1000
          )
        : null;
    expect(classifyMachinePresence(online(), 'm' as MachineId)).toBe('unknown');
    // A bad frame cannot restore the unavailable local capability.
    await bridge.adaptor.applyRemoteUpdates([new Uint8Array([255])]);
    expect(classifyMachinePresence(online(), 'm' as MachineId)).toBe('unknown');
    await bridge.adaptor.applyRemoteUpdates([envelope(new Uint8Array([0]))]);
    locked = false;
    await bridge.adaptor.applyRemoteUpdates([envelope(new Uint8Array([88]), 'b'.repeat(32))]);
    expect(classifyMachinePresence(bridge.isAvailable() ? new Set() : null, 'm' as MachineId)).toBe(
      'unknown'
    );
    for (const listener of listeners) listener();
    await recovered.promise;
    expect(classifyMachinePresence(online(), 'm' as MachineId)).toBe('online');
  } finally {
    bridge.retire();
    await sdk.close();
    await bridge.close();
    store.destroy();
  }
});
