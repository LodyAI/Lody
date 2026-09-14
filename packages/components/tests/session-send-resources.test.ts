import { describe, expect, it } from 'vitest';
import type { SessionId } from '@lody/shared';
import type { SessionDocStore } from '../src/atoms/runtime';
import { createSessionSendResources } from '../src/lib/session-send-resources';

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const unusedStores = {
  acquire: async (): Promise<SessionDocStore> => {
    throw new Error('Unexpected acquisition');
  },
  releaseRef: () => {},
};

describe('workspace send resources', () => {
  it('aborts all children and waits for non-cooperative work before closing', async () => {
    const resources = createSessionSendResources(unusedStores);
    const started = gate();
    const rawFinished = gate();
    const cooperativeStarted = gate();
    const aborted = gate();
    const raw = resources.run(async () => {
      started.resolve();
      await rawFinished.promise;
    });
    const cooperative = resources.run(async (signal) => {
      cooperativeStarted.resolve();
      await new Promise<void>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted.resolve();
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true }
        );
      });
    });
    const outcomes = Promise.allSettled([raw, cooperative]);
    await Promise.all([started.promise, cooperativeStarted.promise]);
    let closed = false;
    const closing = resources.dispose();
    expect(resources.dispose()).toBe(closing);
    void closing.then(() => {
      closed = true;
    });
    await aborted.promise;
    expect(closed).toBe(false);
    await expect(resources.run(async () => 'late')).rejects.toMatchObject({ name: 'AbortError' });
    rawFinished.resolve();
    await closing;
    for (const outcome of await outcomes) {
      expect(outcome).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
    }
  });

  it('returns a late acquisition without exposing it to cancelled work', async () => {
    const acquired = gate<SessionDocStore>();
    const acquiring = gate();
    const store = { id: 'session' } as unknown as SessionDocStore;
    const borrowed = new Set<SessionId>();
    const resources = createSessionSendResources({
      acquire: async (id) => {
        acquiring.resolve();
        const value = await acquired.promise;
        borrowed.add(id);
        return value;
      },
      releaseRef: (id) => {
        borrowed.delete(id);
      },
    });
    const controller = new AbortController();
    let used = false;
    const work = resources.withSessionStore(
      'session' as SessionId,
      () => {
        used = true;
      },
      controller.signal
    );
    const result = work.catch((error: unknown) => error);
    await acquiring.promise;
    controller.abort();
    acquired.resolve(store);
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(used).toBe(false);
    expect(borrowed.size).toBe(0);
    await resources.dispose();
  });

  it('preserves failures without cancelling sibling operations', async () => {
    const resources = createSessionSendResources(unusedStores);
    const siblingReady = gate();
    const siblingFinish = gate<string>();
    const sibling = resources.run(async () => {
      siblingReady.resolve();
      return siblingFinish.promise;
    });
    await siblingReady.promise;
    const error = new Error('Upload rejected');
    await expect(
      resources.run(async () => {
        throw error;
      })
    ).rejects.toBe(error);
    siblingFinish.resolve('completed');
    expect(await sibling).toBe('completed');
    await resources.dispose();
  });
});
