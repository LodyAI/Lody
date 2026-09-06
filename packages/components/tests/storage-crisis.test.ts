import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyStorageFailure,
  describeStorageFailure,
  enterStorageCrisis,
  getStorageCrisisState,
  isStorageCrisisError,
  resetStorageCrisisForTests,
  StorageCrisisError,
  subscribeToStorageCrisis,
} from '../src/lib/storage-crisis';

/**
 * Builds the DOMException-shaped error the browser actually throws. jsdom is not
 * loaded here, so the shape (`name` + `message`) is what matters, exactly as the
 * classifier reads it.
 */
function domException(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

afterEach(() => {
  resetStorageCrisisForTests();
});

describe('classifyStorageFailure', () => {
  it('classifies a quota rejection by DOMException name', () => {
    expect(
      classifyStorageFailure(
        domException('QuotaExceededError', "Failed to execute 'put' on 'IDBObjectStore'.")
      )
    ).toBe('quota');
  });

  it('classifies a quota rejection spelled only in the message', () => {
    // Firefox says it in prose rather than through the DOMException name.
    expect(
      classifyStorageFailure(new Error('The current transaction exceeded its quota limitations.'))
    ).toBe('quota');
  });

  it('classifies the dying-connection aftermath error', () => {
    expect(
      classifyStorageFailure(
        domException(
          'InvalidStateError',
          "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing."
        )
      )
    ).toBe('unavailable');
  });

  it('classifies a disk-full failure to open the backing store', () => {
    expect(
      classifyStorageFailure(
        domException('UnknownError', 'Internal error opening backing store for indexedDB.open.')
      )
    ).toBe('unavailable');
  });

  it('walks the cause chain loro-repo wraps failures in', () => {
    // `createError()` keeps the cause but drops the DOMException name from the
    // text, so only the chain identifies this one.
    const wrapped = new Error('Failed to hydrate metadata snapshot: some detail', {
      cause: domException('QuotaExceededError', 'quota'),
    });
    expect(classifyStorageFailure(wrapped)).toBe('quota');
  });

  it('leaves unrelated failures unclassified', () => {
    expect(classifyStorageFailure(new Error('Network request failed'))).toBeNull();
    expect(classifyStorageFailure(domException('AbortError', 'The user aborted a request.'))).toBe(
      null
    );
    expect(classifyStorageFailure(null)).toBeNull();
    expect(classifyStorageFailure('boom')).toBeNull();
  });

  it('stops walking a cyclic cause chain', () => {
    const first = new Error('first') as Error & { cause?: unknown };
    const second = new Error('second') as Error & { cause?: unknown };
    first.cause = second;
    second.cause = first;
    expect(classifyStorageFailure(first)).toBeNull();
  });
});

describe('describeStorageFailure', () => {
  it('renders a one-line name/message summary', () => {
    expect(describeStorageFailure(domException('InvalidStateError', 'connection is closing'))).toBe(
      'InvalidStateError: connection is closing'
    );
  });
});

describe('storage crisis latch', () => {
  it('starts healthy', () => {
    expect(getStorageCrisisState()).toBeNull();
  });

  it('latches the first failure and notifies subscribers', () => {
    const seen: (string | null)[] = [];
    const unsubscribe = subscribeToStorageCrisis(() => {
      seen.push(getStorageCrisisState()?.kind ?? null);
    });

    enterStorageCrisis({ kind: 'quota', operation: 'save', detail: 'QuotaExceededError: full' });

    expect(getStorageCrisisState()).toEqual({
      kind: 'quota',
      operation: 'save',
      detail: 'QuotaExceededError: full',
    });
    expect(seen).toEqual(['quota']);
    unsubscribe();
  });

  it('keeps the first cause and does not re-notify on later failures', () => {
    enterStorageCrisis({ kind: 'quota', operation: 'save', detail: 'first' });

    const seen: string[] = [];
    const unsubscribe = subscribeToStorageCrisis(() => seen.push('notified'));
    enterStorageCrisis({ kind: 'unavailable', operation: 'loadDoc', detail: 'second' });

    expect(getStorageCrisisState()?.operation).toBe('save');
    expect(getStorageCrisisState()?.detail).toBe('first');
    expect(seen).toEqual([]);
    unsubscribe();
  });

  it('keeps notifying the remaining subscribers when one throws', () => {
    const seen: string[] = [];
    const unsubscribeThrowing = subscribeToStorageCrisis(() => {
      throw new Error('listener blew up');
    });
    const unsubscribe = subscribeToStorageCrisis(() => seen.push('notified'));

    enterStorageCrisis({ kind: 'unavailable', operation: 'loadDoc', detail: 'detail' });

    expect(seen).toEqual(['notified']);
    unsubscribeThrowing();
    unsubscribe();
  });
});

describe('StorageCrisisError', () => {
  it('carries a generic message instead of the raw engine text', () => {
    const raw = domException(
      'InvalidStateError',
      "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing."
    );
    const error = new StorageCrisisError('unavailable', 'loadDoc', { cause: raw });

    expect(error.message).not.toMatch(/IDBDatabase|transaction/);
    expect(error.kind).toBe('unavailable');
    expect(error.operation).toBe('loadDoc');
    expect(error.cause).toBe(raw);
  });

  it('recognizes an equivalent error from a second module copy', () => {
    const fromOtherBundle = new Error('anything');
    fromOtherBundle.name = 'StorageCrisisError';

    expect(isStorageCrisisError(new StorageCrisisError('quota', 'save'))).toBe(true);
    expect(isStorageCrisisError(fromOtherBundle)).toBe(true);
    expect(isStorageCrisisError(new Error('unrelated'))).toBe(false);
  });
});
