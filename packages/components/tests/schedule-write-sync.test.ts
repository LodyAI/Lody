import { describe, expect, it, vi } from 'vitest';
import { createManagedStoreCache } from '../src/providers/store-ref-tracker';
import { waitForScheduleWriteSync, withScheduleWrite } from '../src/providers/schedule-write-sync';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('Schedule authored write synchronization', () => {
  it('opens an unopened document before writing and retains it through offline idle cleanup until acknowledgement', async () => {
    const ack = deferred();
    const dispose = vi.fn();
    const create = vi.fn(async () => ({
      dispose,
      waitUntilSynced: () => ack.promise,
      getState: () => ({}),
      firstSynced: Promise.resolve(),
    }));
    const cache = createManagedStoreCache({ create, releaseDelayMs: 60_000 });
    const write = vi.fn(() => {
      expect(create).toHaveBeenCalledWith('schedule');
      return 'saved locally';
    });
    expect(await withScheduleWrite(cache, 'schedule', write)).toBe('saved locally');
    await cache.releaseIdle();
    expect(dispose).not.toHaveBeenCalled();
    ack.resolve();
    await ack.promise;
    await cache.releaseIdle();
    expect(dispose).toHaveBeenCalledOnce();
    await cache.disposeAll();
  });

  it('does not accept an acknowledgement from an old connection generation', async () => {
    let status = 'joined';
    let notify = () => {};
    const old = deferred();
    const current = deferred();
    const waitUntilSynced = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const off = vi.fn();
    const binding = {
      get status() {
        return status;
      },
      waitUntilSynced,
      onStatusChange: (listener: () => void) => {
        notify = listener;
        return off;
      },
    };
    const abort = new AbortController();
    const done = vi.fn();
    const result = waitForScheduleWriteSync(binding as never, abort.signal).then(done);
    status = 'detached';
    notify();
    status = 'joined';
    notify();
    old.resolve();
    await old.promise;
    expect(done).not.toHaveBeenCalled();
    expect(waitUntilSynced).toHaveBeenCalledTimes(2);
    current.resolve();
    await result;
    expect(done).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledOnce();
  });

  it('releases synchronization ownership when the workspace is destroyed offline', async () => {
    const off = vi.fn();
    const binding = { status: 'detached', onStatusChange: () => off };
    const abort = new AbortController();
    const result = waitForScheduleWriteSync(binding as never, abort.signal);
    abort.abort();
    await result;
    expect(off).toHaveBeenCalledOnce();
  });
});

it('waits for a missing definition to hydrate before mutating a Registry-only schedule', async () => {
  const hydrate = deferred();
  const cache = createManagedStoreCache({
    releaseDelayMs: 60_000,
    create: async () => ({
      dispose() {},
      getState: () => null,
      firstSynced: hydrate.promise,
      waitUntilSynced: async () => {},
    }),
  });
  const write = vi.fn(() => 'paused');
  const pending = withScheduleWrite(cache, 'unopened', write);
  await cache.get('unopened');
  expect(write).not.toHaveBeenCalled();
  hydrate.resolve();
  expect(await pending).toBe('paused');
  await cache.disposeAll();
});
it('creates a new definition offline without waiting for remote hydration', async () => {
  const cache = createManagedStoreCache({
    releaseDelayMs: 60_000,
    create: async () => ({
      dispose() {},
      getState: () => null,
      firstSynced: new Promise<void>(() => {}),
      waitUntilSynced: async () => {},
    }),
  });
  expect(await withScheduleWrite(cache, 'new', () => 'created', { create: true })).toBe('created');
  await cache.disposeAll();
});
