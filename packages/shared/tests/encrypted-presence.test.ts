import { afterEach, describe, expect, it, vi } from 'vitest';
import { EphemeralStore } from 'loro-crdt';
import { createEncryptedPresenceAdaptorLegacy } from '../src/encrypted-presence-adaptor-legacy';
import { isFreshLodyPresenceState, parseLodyPresenceStates } from '../src/presence';
import type { EncryptedPresencePort } from '../src/encrypted-presence';

const state = { kind: 'machine', machineId: 'm', instanceId: 'i', updatedAt: 1000 } as const;
const publicationKey = 'machine:m:i';
afterEach(() => {
  vi.useRealTimers();
});
describe('encrypted ephemeral adaptor', () => {
  it('coalesces before crypto, emits only ciphertext, prioritizes heartbeats and preserves ordinary DTOs', async () => {
    vi.useFakeTimers();
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
      expect(sent).toEqual([new Uint8Array([231, 1])]);
      expect(encrypted.adaptor.localUpdateKey(sent[0])).toBe(publicationKey);
      await vi.advanceTimersByTimeAsync(250);
      expect(sent).toEqual([new Uint8Array([231, 1]), new Uint8Array([231, 2])]);
    } finally {
      await encrypted.close();
      store.destroy();
    }
  });
  it('isolates bad frames and crypto failure, applies authenticated entries without echo, and honors expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const store = new EphemeralStore(90000);
    const sent: Uint8Array[] = [];
    const port: EncryptedPresencePort = {
      seal: async () => {
        throw new Error('unavailable');
      },
      open: async (frame) => {
        if (frame[0] === 0) throw new Error('bad frame');
        if (frame[0] === 1) return null;
        return { key: 'author:machine:m:i', state, expiresAt: 61000 };
      },
    };
    const encrypted = createEncryptedPresenceAdaptorLegacy(store, port);
    encrypted.adaptor.subscribeLocalUpdates((bytes) => sent.push(bytes));
    try {
      await encrypted.adaptor.applyRemoteUpdates([
        new Uint8Array([0]),
        new Uint8Array([1]),
        new Uint8Array([2]),
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
    vi.useFakeTimers();
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
    vi.useFakeTimers();
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
    await encrypted.adaptor.applyRemoteUpdates([new Uint8Array([1])]);
    expect(store.get('author:machine:m:i')).toBeDefined();
    const pending = encrypted.adaptor.applyRemoteUpdates([new Uint8Array([2])]);
    invalidate();
    expect(store.get('author:machine:m:i')).toBeUndefined();
    finish({ key: 'author:machine:m:i', state, expiresAt: 61000 });
    await pending;
    expect(store.get('author:machine:m:i')).toBeUndefined();
    await encrypted.close();
    store.destroy();
  });
});
