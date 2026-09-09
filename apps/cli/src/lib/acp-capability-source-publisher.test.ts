import { describe, expect, it } from 'vitest';
import type { AcpCapabilitySources } from '@lody/shared';
import { AcpCapabilitySourcePublisher } from './acp-capability-source-publisher';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('ACP source publisher', () => {
  it('invalidates before registration and fences a late scan across a runtime update', async () => {
    const first = deferred<Record<string, string>>();
    const secondStarted = deferred<void>();
    const finished = deferred<void>();
    const snapshots: AcpCapabilitySources[] = [];
    let next = first.promise;
    const publisher = new AcpCapabilitySourcePublisher({
      epoch: 'daemon-2',
      resolveVersions: () => next,
      publish: async (snapshot, isCurrent) => {
        if (!isCurrent()) return;
        snapshots.push(snapshot);
        if (snapshot.versions.config === 'new') finished.resolve();
        if (snapshots.length === 2) secondStarted.resolve();
      },
      onError: (error) => {
        throw error;
      },
    });
    await publisher.start();
    expect(snapshots).toEqual([{ epoch: 'daemon-2', versions: {} }]);
    next = Promise.resolve({ config: 'new' });
    publisher.refresh();
    await secondStarted.promise;
    first.resolve({ config: 'old' });
    await finished.promise;
    expect(snapshots).toEqual([
      { epoch: 'daemon-2', versions: {} },
      { epoch: 'daemon-2', versions: {} },
      { epoch: 'daemon-2', versions: { config: 'new' } },
    ]);
    await publisher.stop();
  });

  it('leaves failed discovery unknown and recovers on the next rescan', async () => {
    const failure = deferred<Record<string, string>>();
    const failed = deferred<void>();
    const recovered = deferred<void>();
    let versions = failure.promise;
    let snapshot: AcpCapabilitySources | undefined;
    const publisher = new AcpCapabilitySourcePublisher({
      epoch: 'daemon',
      resolveVersions: () => versions,
      publish: async (value, isCurrent) => {
        if (isCurrent()) snapshot = value;
        if (value.versions.config) recovered.resolve();
      },
      onError: () => failed.resolve(),
    });
    await publisher.start();
    failure.reject(new Error('disk lookup failed'));
    await failed.promise;
    expect(snapshot).toEqual({ epoch: 'daemon', versions: {} });
    versions = Promise.resolve({ config: 'new' });
    publisher.refresh();
    await recovered.promise;
    expect(snapshot?.versions).toEqual({ config: 'new' });
    await publisher.stop();
  });

  it('fences a write waiting on an open document when stopped', async () => {
    const opened = deferred<void>();
    const entered = deferred<void>();
    const snapshots: AcpCapabilitySources[] = [];
    const publisher = new AcpCapabilitySourcePublisher({
      epoch: 'daemon',
      resolveVersions: async () => ({ config: 'new' }),
      publish: async (value, isCurrent) => {
        entered.resolve();
        await opened.promise;
        if (isCurrent()) snapshots.push(value);
      },
      onError: (error) => {
        throw error;
      },
    });
    const start = publisher.start();
    await entered.promise;
    const stop = publisher.stop();
    opened.resolve();
    await Promise.all([start, stop]);
    expect(snapshots).toEqual([]);
  });
});
