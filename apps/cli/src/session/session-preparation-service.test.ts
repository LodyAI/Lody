import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import {
  SessionPreparationService,
  type SessionPreparationResource,
} from './session-preparation-service';

function deferred() {
  let resolvePromise: () => void = () => {};
  let rejectPromise: (error: unknown) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createResource() {
  const initialized = deferred();
  const sessionReady = deferred();
  const started = deferred();
  const disposed = deferred();
  const state = { disposed: false };
  const resource: SessionPreparationResource = {
    initialized: initialized.promise,
    sessionReady: sessionReady.promise,
    start: () => started.resolve(),
    dispose: async () => {
      state.disposed = true;
      disposed.resolve();
    },
  };
  return { resource, initialized, sessionReady, started, disposed, state };
}

const sessionId = 'session-preparation' as SessionId;
const identity = { sessionId, requesterUserId: 'user-1', claimKey: 'key' };
const lease = { sessionId, requesterUserId: 'user-1', preparationId: 'prepare' };

describe('SessionPreparationService', () => {
  const services: SessionPreparationService<SessionPreparationResource>[] = [];
  const gates: ReturnType<typeof deferred>[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const pendingGate of gates) pendingGate.resolve();
    await Promise.all(services.map((service) => service.disposeAll()));
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
    services.length = gates.length = directories.length = 0;
    vi.useRealTimers();
  });

  function gate() {
    const value = deferred();
    gates.push(value);
    return value;
  }

  function createService(maxConcurrent = 1) {
    const service = new SessionPreparationService<SessionPreparationResource>(
      { debug: () => {} },
      { hardTtlMs: 120_000, maxConcurrent }
    );
    services.push(service);
    return service;
  }

  function start(
    service: SessionPreparationService<SessionPreparationResource>,
    prepared = createResource()
  ) {
    service.start({ ...lease, requestKey: 'key', create: async () => prepared.resource });
    return prepared;
  }

  it('publishes before side effects, tracks readiness, and transfers ownership exactly once', async () => {
    const service = createService();
    const prepared = createResource();
    let visibleAtStart: SessionPreparationResource | null = null;
    prepared.resource.start = () => {
      visibleAtStart = service.peek(identity);
      prepared.started.resolve();
    };
    start(service, prepared);
    expect(service.getState(sessionId)).toBe('preparing');
    await prepared.started.promise;
    expect(visibleAtStart).toBe(prepared.resource);
    expect(service.peek({ ...identity, requesterUserId: 'other' })).toBeNull();
    expect(service.peek({ ...identity, claimKey: 'wrong' })).toBeNull();
    prepared.initialized.resolve();
    await prepared.initialized.promise;
    expect(service.getState(sessionId)).toBe('initialized');
    prepared.sessionReady.resolve();
    await prepared.sessionReady.promise;
    expect(service.getState(sessionId)).toBe('session-ready');
    expect(service.claim({ ...identity, isCompatible: () => true })).toEqual({
      status: 'claimed',
      resource: prepared.resource,
    });
    expect(service.claim({ ...identity, isCompatible: () => true })).toEqual({
      status: 'miss',
      cleanup: null,
    });
    expect(service.cancel(lease)).toBe('not-found');
    await service.disposeAll();
    expect(prepared.state.disposed).toBe(false);
  });

  it.each([
    'cancel',
    'ttl',
    'failure',
    'start-error',
    'incompatible',
    'compatibility-error',
  ] as const)(
    'keeps %s cleanup visible until the old workspace can no longer delete the cold workspace',
    async (trigger) => {
      vi.useFakeTimers();
      const service = createService();
      const root = await mkdtemp(join(tmpdir(), 'lody-preparation-'));
      directories.push(root);
      const workdir = join(root, 'worktree');
      await mkdir(workdir);
      const releaseCleanup = gate();
      const cleanupStarted = deferred();
      const prepared = createResource();
      prepared.resource.dispose = async () => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        await rm(workdir, { recursive: true, force: true });
      };
      if (trigger === 'start-error') {
        prepared.resource.start = () => {
          prepared.started.resolve();
          throw new Error('start failed');
        };
      }
      start(service, prepared);
      await prepared.started.promise;
      if (trigger === 'cancel') service.cancel(lease);
      if (trigger === 'ttl') await vi.advanceTimersByTimeAsync(120_000);
      if (trigger === 'failure') prepared.sessionReady.reject(new Error('startup failed'));
      if (trigger === 'incompatible' || trigger === 'compatibility-error') {
        service.claim({
          ...identity,
          isCompatible: () => {
            if (trigger === 'compatibility-error') throw new Error('workspace unavailable');
            return false;
          },
        });
      }
      await cleanupStarted.promise;
      expect(service.getState(sessionId)).toBeNull();
      const result = service.claim({ ...identity, isCompatible: () => true });
      expect(result.status).toBe('miss');
      if (result.status !== 'miss') throw new Error('retired preparation was claimed');
      expect(result.cleanup).not.toBeNull();
      const discarded = service.discard(sessionId);
      expect(discarded).not.toBeNull();
      let coldStarted = false;
      const cold = (async () => {
        await result.cleanup;
        coldStarted = true;
        await mkdir(workdir);
        await writeFile(join(workdir, 'owned'), 'durable session');
      })();
      await Promise.resolve();
      expect(coldStarted).toBe(false);
      releaseCleanup.resolve();
      await Promise.all([cold, discarded, service.disposeAll()]);
      expect(await readFile(join(workdir, 'owned'), 'utf8')).toBe('durable session');
      expect(service.discard(sessionId)).toBeNull();
    }
  );

  it.each(['claim', 'cancel', 'shutdown'] as const)(
    '%s joins cleanup even when resource creation has not returned',
    async (operation) => {
      const service = createService();
      const createStarted = deferred();
      const releaseCreate = gate();
      const releaseCleanup = gate();
      const cleanupStarted = deferred();
      const prepared = createResource();
      prepared.resource.dispose = async () => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        prepared.state.disposed = true;
        prepared.initialized.reject(new Error('disposed before start'));
        prepared.sessionReady.reject(new Error('disposed before start'));
      };
      service.start({
        ...lease,
        requestKey: 'key',
        create: async () => {
          createStarted.resolve();
          await releaseCreate.promise;
          return prepared.resource;
        },
      });
      await createStarted.promise;
      let cleanup: Promise<void> | null;
      if (operation === 'claim') {
        const result = service.claim({ ...identity, isCompatible: () => true });
        if (result.status !== 'miss') throw new Error('unpublished preparation was claimed');
        cleanup = result.cleanup;
      } else {
        service.cancel(lease);
        cleanup = operation === 'shutdown' ? service.disposeAll() : service.discard(sessionId);
      }
      expect(cleanup).not.toBeNull();
      let completed = false;
      const completion = Promise.resolve(cleanup).then(() => {
        completed = true;
      });
      await Promise.resolve();
      expect(completed).toBe(false);
      releaseCreate.resolve();
      await cleanupStarted.promise;
      expect(completed).toBe(false);
      releaseCleanup.resolve();
      await completion;
      expect(prepared.state.disposed).toBe(true);
      expect(service.peek(identity)).toBeNull();
    }
  );

  it.each(['replacement', 'cancel-then-start'] as const)(
    'serializes %s behind retirement, including a second cancellation',
    async (operation) => {
      const service = createService();
      const first = createResource();
      const releaseCleanup = gate();
      first.resource.dispose = async () => {
        await releaseCleanup.promise;
        first.state.disposed = true;
      };
      start(service, first);
      await first.started.promise;
      if (operation === 'cancel-then-start') service.cancel(lease);
      let secondCreated = false;
      service.start({
        ...lease,
        preparationId: 'second',
        requestKey: 'changed',
        create: async () => {
          secondCreated = true;
          return createResource().resource;
        },
      });
      expect(service.cancel(lease)).toBe('not-found');
      service.cancel({ ...lease, preparationId: 'second' });
      const third = createResource();
      let disposedBeforeThird = false;
      service.start({
        ...lease,
        preparationId: 'third',
        requestKey: 'third',
        create: async () => {
          disposedBeforeThird = first.state.disposed;
          return third.resource;
        },
      });
      expect(service.peek({ ...identity, claimKey: 'third' })).toBeNull();
      releaseCleanup.resolve();
      await third.started.promise;
      expect(secondCreated).toBe(false);
      expect(disposedBeforeThird).toBe(true);
      expect(service.claim({ ...identity, claimKey: 'third', isCompatible: () => true })).toEqual({
        status: 'claimed',
        resource: third.resource,
      });
    }
  );

  it('keeps another session independent of retirement and enforces lease ownership', async () => {
    const service = createService(2);
    const first = start(service);
    await first.started.promise;
    expect(service.start({ ...lease, requestKey: 'key', create: async () => first.resource })).toBe(
      'duplicate'
    );
    expect(service.cancel({ ...lease, requesterUserId: 'other' })).toBe('not-owned');
    expect(
      service.start({
        ...lease,
        requesterUserId: 'other',
        requestKey: 'key',
        create: async () => first.resource,
      })
    ).toBe('busy');
    const releaseCleanup = gate();
    first.resource.dispose = async () => {
      await releaseCleanup.promise;
      first.state.disposed = true;
    };
    service.cancel(lease);
    const second = createResource();
    const otherIdentity = {
      ...identity,
      sessionId: 'other-session' as SessionId,
      requesterUserId: 'other',
    };
    service.start({
      ...lease,
      ...otherIdentity,
      requestKey: 'key',
      create: async () => second.resource,
    });
    await second.started.promise;
    expect(first.state.disposed).toBe(false);
    expect(service.claim({ ...otherIdentity, isCompatible: () => true }).status).toBe('claimed');
  });

  it('replaces the same requester across sessions only after disposing its old lease', async () => {
    const service = createService();
    const first = start(service);
    await first.started.promise;
    const releaseCleanup = gate();
    first.resource.dispose = async () => {
      await releaseCleanup.promise;
      first.state.disposed = true;
    };
    const second = createResource();
    const otherSession = 'replacement-session' as SessionId;
    let oldDisposedAtCreate = false;
    expect(
      service.start({
        ...lease,
        sessionId: otherSession,
        requestKey: 'key',
        create: async () => {
          oldDisposedAtCreate = first.state.disposed;
          return second.resource;
        },
      })
    ).toBe('replaced');
    expect(
      service.start({
        ...lease,
        sessionId: 'busy-session' as SessionId,
        requesterUserId: 'other',
        requestKey: 'key',
        create: async () => createResource().resource,
      })
    ).toBe('busy');
    releaseCleanup.resolve();
    await second.started.promise;
    expect(oldDisposedAtCreate).toBe(true);
    expect(service.getState(sessionId)).toBeNull();
    expect(
      service.claim({ ...identity, sessionId: otherSession, isCompatible: () => true }).status
    ).toBe('claimed');
  });

  it('retains routing claim identity when the preparation configuration changes', async () => {
    const service = createService();
    const first = createResource();
    service.start({
      ...lease,
      requestKey: 'model-a',
      claimKey: 'routing',
      create: async () => first.resource,
    });
    await first.started.promise;
    const second = createResource();
    expect(
      service.start({
        ...lease,
        preparationId: 'second',
        requestKey: 'model-b',
        claimKey: 'routing',
        create: async () => second.resource,
      })
    ).toBe('replaced');
    await second.started.promise;
    expect(first.state.disposed).toBe(true);
    expect(service.cancel(lease)).toBe('not-found');
    expect(service.claim({ ...identity, claimKey: 'routing', isCompatible: () => true })).toEqual({
      status: 'claimed',
      resource: second.resource,
    });
  });

  it('releases retirement after creation or disposal rejects', async () => {
    const service = createService();
    const createStarted = deferred();
    const releaseCreate = gate();
    service.start({
      ...lease,
      requestKey: 'key',
      create: async () => {
        createStarted.resolve();
        await releaseCreate.promise;
        throw new Error('creation failed');
      },
    });
    await createStarted.promise;
    service.cancel(lease);
    const cleanup = service.discard(sessionId);
    releaseCreate.resolve();
    await cleanup;
    expect(service.discard(sessionId)).toBeNull();
    const prepared = start(service);
    await prepared.started.promise;
    prepared.resource.dispose = async () => {
      throw new Error('disposal failed');
    };
    await service.discard(sessionId);
    expect(service.discard(sessionId)).toBeNull();
    const replacement = start(service);
    await replacement.started.promise;
    expect(service.claim({ ...identity, isCompatible: () => true }).status).toBe('claimed');
  });
});
