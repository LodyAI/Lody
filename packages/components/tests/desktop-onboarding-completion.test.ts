import { describe, expect, it } from 'vitest';
import { enterDesktopProduct } from '../src/components/onboarding/desktop-onboarding-completion';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function completionState() {
  const persistenceErrors: unknown[] = [];
  const state = { entered: false, resumable: true, failures: [] as string[] };
  return {
    state,
    persistenceErrors,
    onProductEntered: () => {
      state.entered = true;
    },
    onDurableCompletion: () => {
      state.resumable = false;
    },
    onPersistenceFailure: (error: unknown) => {
      persistenceErrors.push(error);
      state.failures.push('persistence');
    },
    onNavigationFailure: () => {
      state.failures.push('navigation');
    },
  };
}

describe('enterDesktopProduct', () => {
  it.each(['navigation', 'persistence'] as const)(
    'clears resume state only after both succeed, with %s first',
    async (first) => {
      const persistence = deferred<{ ok: true }>();
      const navigation = deferred<void>();
      const completion = completionState();
      const result = enterDesktopProduct({
        ...completion,
        persistCompletion: () => persistence.promise,
        navigate: () => navigation.promise,
      });
      if (first === 'navigation') {
        navigation.resolve();
        await expect(result).resolves.toBe(true);
        expect(completion.state).toEqual({ entered: true, resumable: true, failures: [] });
        persistence.resolve({ ok: true });
      } else {
        persistence.resolve({ ok: true });
        await persistence.promise;
        expect(completion.state).toEqual({ entered: false, resumable: true, failures: [] });
        navigation.resolve();
      }
      await result;
      await persistence.promise;
      expect(completion.state).toEqual({ entered: true, resumable: false, failures: [] });
    }
  );

  it.each(['unavailable', 'throw', 'reject', 'negative', 'late-reject'])(
    'keeps product entry successful and resume state recoverable on %s persistence',
    async (failure) => {
      const persistence = deferred<{ ok: boolean; message?: string }>();
      const completion = completionState();
      const result = enterDesktopProduct({
        ...completion,
        persistCompletion: () => {
          if (failure === 'unavailable') return undefined;
          if (failure === 'throw') throw new Error('synthetic write failure');
          return persistence.promise;
        },
        navigate: () => Promise.resolve(),
      });
      if (failure === 'late-reject') {
        await expect(result).resolves.toBe(true);
        expect(completion.state).toEqual({ entered: true, resumable: true, failures: [] });
      }
      if (failure === 'negative') persistence.resolve({ ok: false, message: 'write failed' });
      if (failure === 'reject' || failure === 'late-reject') {
        persistence.reject(new Error('synthetic write failure'));
      }
      await expect(result).resolves.toBe(true);
      expect(completion.state).toEqual({
        entered: true,
        resumable: true,
        failures: ['persistence'],
      });
      if (failure === 'negative') expect(completion.persistenceErrors).toEqual(['write failed']);
    }
  );

  it.each(['throw', 'reject'])(
    'preserves resume state after navigation %s and allows a successful retry',
    async (failure) => {
      const completion = completionState();
      const persistCompletion = () => Promise.resolve({ ok: true as const });
      const result = await enterDesktopProduct({
        ...completion,
        persistCompletion,
        navigate: () => {
          if (failure === 'throw') throw new Error('synthetic navigation failure');
          return Promise.reject(new Error('synthetic navigation failure'));
        },
      });
      expect(result).toBe(false);
      expect(completion.state).toEqual({
        entered: false,
        resumable: true,
        failures: ['navigation'],
      });
      await expect(
        enterDesktopProduct({
          ...completion,
          persistCompletion,
          navigate: () => Promise.resolve(),
        })
      ).resolves.toBe(true);
      expect(completion.state).toEqual({
        entered: true,
        resumable: false,
        failures: ['navigation'],
      });
    }
  );
});
