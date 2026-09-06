import { describe, expect, it, vi } from 'vitest';
import { enterDesktopProduct } from '../src/components/onboarding/desktop-onboarding-completion';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('enterDesktopProduct', () => {
  it('enters the product without waiting for native completion persistence', async () => {
    const persistence = deferred<{ ok: true }>();
    const onProductEntered = vi.fn();
    const onDurableCompletion = vi.fn();
    const navigate = vi.fn().mockResolvedValue(undefined);

    const result = enterDesktopProduct({
      persistCompletion: () => persistence.promise,
      navigate,
      onProductEntered,
      onDurableCompletion,
      onPersistenceFailure: vi.fn(),
      onNavigationFailure: vi.fn(),
    });

    await expect(result).resolves.toBe(true);
    expect(navigate).toHaveBeenCalledOnce();
    expect(onProductEntered).toHaveBeenCalledOnce();
    expect(onDurableCompletion).not.toHaveBeenCalled();

    persistence.resolve({ ok: true });
    await persistence.promise;
    await Promise.resolve();
    expect(onDurableCompletion).toHaveBeenCalledOnce();
  });

  it('reports persistence failure without changing successful product entry', async () => {
    const onPersistenceFailure = vi.fn();
    const onDurableCompletion = vi.fn();

    const result = await enterDesktopProduct({
      persistCompletion: () => Promise.resolve({ ok: false, message: 'write failed' }),
      navigate: () => Promise.resolve(),
      onProductEntered: vi.fn(),
      onDurableCompletion,
      onPersistenceFailure,
      onNavigationFailure: vi.fn(),
    });

    expect(result).toBe(true);
    expect(onPersistenceFailure).toHaveBeenCalledWith('write failed');
    expect(onDurableCompletion).not.toHaveBeenCalled();
  });

  it('does not clear resumable state when navigation fails', async () => {
    const onNavigationFailure = vi.fn();
    const onDurableCompletion = vi.fn();

    const result = await enterDesktopProduct({
      persistCompletion: () => Promise.resolve({ ok: true }),
      navigate: () => Promise.reject(new Error('navigation failed')),
      onProductEntered: vi.fn(),
      onDurableCompletion,
      onPersistenceFailure: vi.fn(),
      onNavigationFailure,
    });

    expect(result).toBe(false);
    expect(onNavigationFailure).toHaveBeenCalledOnce();
    expect(onDurableCompletion).not.toHaveBeenCalled();
  });
});
