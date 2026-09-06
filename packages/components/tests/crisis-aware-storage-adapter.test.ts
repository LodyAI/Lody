import type { StorageAdapter } from 'loro-repo';
import { afterEach, describe, expect, it } from 'vitest';

import { createCrisisAwareStorageAdapter } from '../src/providers/crisis-aware-storage-adapter';
import {
  getStorageCrisisState,
  isStorageCrisisError,
  resetStorageCrisisForTests,
} from '../src/lib/storage-crisis';

const CONNECTION_CLOSING =
  "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.";

function domException(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

type FakeAdapterOptions = {
  /** Fails every call until cleared, mimicking a dead IndexedDB connection. */
  failWith?: Error;
  withOptionalMethods?: boolean;
};

/**
 * Records which adapter methods actually ran. "Did not touch IndexedDB" is the
 * contract under test, and the reached list is the only place it is observable.
 */
function createFakeAdapter(options: FakeAdapterOptions = {}) {
  const reached: string[] = [];
  let failure = options.failWith ?? null;

  const guard = async <T>(operation: string, result: T): Promise<T> => {
    reached.push(operation);
    if (failure) throw failure;
    return result;
  };

  const adapter: StorageAdapter = {
    save: () => guard('save', undefined),
    loadDoc: () => guard('loadDoc', undefined),
    loadMeta: () => guard('loadMeta', undefined),
  };

  if (options.withOptionalMethods !== false) {
    adapter.init = () => guard('init', undefined);
    adapter.compactMeta = () => guard('compactMeta', undefined);
    adapter.compactFlockDoc = () => guard('compactFlockDoc', undefined);
    adapter.loadFlockDoc = () => guard('loadFlockDoc', undefined);
    adapter.deleteDoc = () => guard('deleteDoc', undefined);
    adapter.deleteFlockDoc = () => guard('deleteFlockDoc', undefined);
    adapter.close = () => {
      reached.push('close');
    };
  }

  return {
    adapter,
    reached,
    recover(): void {
      failure = null;
    },
  };
}

afterEach(() => {
  resetStorageCrisisForTests();
});

describe('createCrisisAwareStorageAdapter', () => {
  it('passes healthy calls through', async () => {
    const inner = createFakeAdapter();
    const adapter = createCrisisAwareStorageAdapter(inner.adapter);

    await adapter.loadDoc('session-1');
    await adapter.loadMeta();

    expect(inner.reached).toEqual(['loadDoc', 'loadMeta']);
    expect(getStorageCrisisState()).toBeNull();
  });

  it('replaces a dying-connection failure with a crisis error and latches', async () => {
    const inner = createFakeAdapter({
      failWith: domException('InvalidStateError', CONNECTION_CLOSING),
    });
    const crises: string[] = [];
    const adapter = createCrisisAwareStorageAdapter(inner.adapter, {
      onCrisis: (state) => crises.push(`${state.kind}/${state.operation}`),
    });

    // `loadDoc` is the real-world entry point: opening a brand-new session room
    // runs a readwrite transaction before any write is attempted.
    const error = await adapter.loadDoc('session-1').then(
      () => null,
      (reason: unknown) => reason
    );

    expect(isStorageCrisisError(error)).toBe(true);
    expect((error as Error).message).not.toMatch(/IDBDatabase|transaction|connection is closing/);
    expect(getStorageCrisisState()).toEqual({
      kind: 'unavailable',
      operation: 'loadDoc',
      detail: `InvalidStateError: ${CONNECTION_CLOSING}`,
    });
    expect(crises).toEqual(['unavailable/loadDoc']);
  });

  it('stops reaching storage once the crisis is latched, even after it recovers', async () => {
    const inner = createFakeAdapter({
      failWith: domException('QuotaExceededError', "Failed to execute 'put' on 'IDBObjectStore'."),
    });
    const adapter = createCrisisAwareStorageAdapter(inner.adapter);

    await expect(adapter.save({} as never)).rejects.toSatisfy(isStorageCrisisError);
    expect(inner.reached).toEqual(['save']);

    // The underlying store coming back does not clear the latch: the page's
    // IndexedDB connection stays dead until the process restarts.
    inner.recover();

    await expect(adapter.loadDoc('session-1')).rejects.toSatisfy(isStorageCrisisError);
    await expect(adapter.loadMeta()).rejects.toSatisfy(isStorageCrisisError);
    await expect(adapter.loadFlockDoc?.('flock-1')).rejects.toSatisfy(isStorageCrisisError);
    await expect(adapter.deleteDoc?.('session-1')).rejects.toSatisfy(isStorageCrisisError);
    expect(inner.reached).toEqual(['save']);
  });

  it('fails reads closed rather than answering "no such document"', async () => {
    const inner = createFakeAdapter({
      failWith: domException('InvalidStateError', CONNECTION_CLOSING),
    });
    const adapter = createCrisisAwareStorageAdapter(inner.adapter);
    await expect(adapter.loadMeta()).rejects.toSatisfy(isStorageCrisisError);

    // An `undefined` here would read as an empty workspace and invite a write
    // that overwrites durable history once the store came back.
    await expect(adapter.loadDoc('session-1')).rejects.toSatisfy(isStorageCrisisError);
  });

  it('leaves unclassified failures untouched and keeps storage usable', async () => {
    const transient = new Error('Failed to hydrate document snapshot: corrupt frame');
    const inner = createFakeAdapter({ failWith: transient });
    const adapter = createCrisisAwareStorageAdapter(inner.adapter);

    await expect(adapter.loadDoc('session-1')).rejects.toBe(transient);
    expect(getStorageCrisisState()).toBeNull();

    inner.recover();
    await expect(adapter.loadMeta()).resolves.toBeUndefined();
  });

  it('still closes the connection during a crisis', async () => {
    const inner = createFakeAdapter({
      failWith: domException('InvalidStateError', CONNECTION_CLOSING),
    });
    const adapter = createCrisisAwareStorageAdapter(inner.adapter);
    await expect(adapter.loadMeta()).rejects.toSatisfy(isStorageCrisisError);

    // Closing opens no transaction, and runtime dispose depends on it.
    adapter.close?.();
    expect(inner.reached).toEqual(['loadMeta', 'close']);
  });

  it('does not advertise optional methods the wrapped adapter lacks', () => {
    const inner = createFakeAdapter({ withOptionalMethods: false });
    const adapter = createCrisisAwareStorageAdapter(inner.adapter);

    expect(adapter.init).toBeUndefined();
    expect(adapter.loadFlockDoc).toBeUndefined();
    expect(adapter.deleteDoc).toBeUndefined();
    expect(adapter.close).toBeUndefined();
  });
});
