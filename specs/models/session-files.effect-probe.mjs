// Design probes for Effect 3.18.4, not product integration tests.
// Run in a temporary effect@3.18.4 installation, retaining this script's and
// store-ref-tracker.ts's repository-relative paths. See the owning Agent Note.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cause, Effect, Exit, Fiber, Ref, Scope } from 'effect';
import { createManagedStoreCache } from '../../packages/components/src/providers/store-ref-tracker.ts';

const gate = () => Promise.withResolvers();
const interrupted = (exit) => Exit.isFailure(exit) && Cause.isInterrupted(exit.cause);

void test('interrupting a Promise wrapper leaves non-cooperative writes running', async () => {
  const started = gate();
  const release = gate();
  const settled = gate();
  const state = { journal: 'preparing', history: [], continued: false };
  const rawWrite = async () => {
    started.resolve();
    await release.promise;
    state.history.push('fixed-turn-id');
    settled.resolve();
  };
  const fiber = Effect.runFork(
    Effect.gen(function* () {
      state.journal = 'submitting';
      yield* Effect.tryPromise(rawWrite);
      state.continued = true;
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          state.journal = 'uncertain';
        })
      )
    )
  );
  await started.promise;
  assert.equal(interrupted(await Effect.runPromise(Fiber.interrupt(fiber))), true);
  assert.deepEqual(state, { journal: 'uncertain', history: [], continued: false });
  release.resolve();
  await settled.promise;
  assert.deepEqual(state, {
    journal: 'uncertain',
    history: ['fixed-turn-id'],
    continued: false,
  });
});

void test('an abort-aware boundary stops the controlled transfer itself', async () => {
  const started = gate();
  const active = new Set();
  let completeTransfer;
  let acceptedBytes = false;
  const transfer = (signal) =>
    new Promise((resolve, reject) => {
      const ticket = {};
      active.add(ticket);
      const abort = () => {
        active.delete(ticket);
        signal.removeEventListener('abort', abort);
        reject(new Error('aborted'));
      };
      completeTransfer = () => {
        if (!active.delete(ticket)) return;
        signal.removeEventListener('abort', abort);
        acceptedBytes = true;
        resolve('ready');
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      started.resolve();
    });
  const fiber = Effect.runFork(
    Effect.tryPromise({
      try: (signal) => transfer(signal),
      catch: (error) => error,
    })
  );
  await started.promise;
  assert.equal(active.size, 1);
  assert.equal(interrupted(await Effect.runPromise(Fiber.interrupt(fiber))), true);
  completeTransfer();
  assert.equal(active.size, 0);
  assert.equal(acceptedBytes, false);
});

void test('workspace-owned work outlives submit and closes before its dependencies', async () => {
  const started = gate();
  const releaseWork = gate();
  const prepared = gate();
  const cleanupStarted = gate();
  const releaseCleanup = gate();
  const resources = new Set();
  const events = [];
  const owner = await Effect.runPromise(Scope.make());
  const work = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          resources.add('attachment');
          started.resolve();
        }),
        () =>
          Effect.promise(async () => {
            events.push('cleanup-started');
            cleanupStarted.resolve();
            await releaseCleanup.promise;
            resources.delete('attachment');
            events.push('cleanup-finished');
          })
      );
      yield* Effect.promise(() => releaseWork.promise);
      events.push('prepared-after-submit-returned');
      prepared.resolve();
      yield* Effect.never;
    })
  );
  // The runPromise entry point has returned, while work belongs to owner.
  const fiber = await Effect.runPromise(Effect.forkIn(work, owner));
  await started.promise;
  releaseWork.resolve();
  await prepared.promise;
  // Ask the owner to close. Its async finalizer explicitly blocks this boundary.
  const closing = Effect.runPromise(Scope.close(owner, Exit.void)).then(() => {
    assert.equal(resources.size, 0);
    events.push('repo-destroyed');
  });
  await cleanupStarted.promise;
  assert.equal(resources.has('attachment'), true);
  assert.equal(events.includes('repo-destroyed'), false);
  releaseCleanup.resolve();
  await closing;
  assert.equal(interrupted(await Effect.runPromise(Fiber.await(fiber))), true);
  assert.deepEqual(events.slice(-3), ['cleanup-started', 'cleanup-finished', 'repo-destroyed']);
});

void test('atomic phase and generation checks reject late ready and cancel events', async () => {
  // Exhaust both event orders; no scheduler timing determines the winner.
  for (const order of [
    ['cancel', 'submit'],
    ['submit', 'cancel'],
  ]) {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* Ref.make({ phase: 'ready', generation: 0 });
        const winners = [];
        for (const event of order) {
          const won = yield* Ref.modify(state, (old) =>
            old.phase === 'ready'
              ? [true, { ...old, phase: event === 'cancel' ? 'canceled' : 'submitting' }]
              : [false, old]
          );
          if (won) winners.push(event);
        }
        const settled = yield* Ref.get(state);
        // A stale completion cannot cross the phase boundary.
        yield* Ref.update(state, (old) =>
          old.phase === 'preparing' && old.generation === 0 ? { ...old, phase: 'ready' } : old
        );
        assert.deepEqual(yield* Ref.get(state), settled);
        // Nor can attempt 0 complete a retried attempt 1.
        yield* Ref.set(state, { phase: 'preparing', generation: 1 });
        yield* Ref.update(state, (old) =>
          old.phase === 'preparing' && old.generation === 0 ? { ...old, phase: 'ready' } : old
        );
        assert.deepEqual(yield* Ref.get(state), { phase: 'preparing', generation: 1 });
        return winners;
      })
    );
    assert.deepEqual(result, [order[0]]);
  }
});

void test('interrupting a late store acquisition still releases its borrowed reference', async () => {
  const acquiring = gate();
  const created = gate();
  const events = [];
  const cache = createManagedStoreCache({
    create: () => {
      acquiring.resolve();
      return created.promise;
    },
    // No elapsed time is used: releaseIfIdle triggers disposal explicitly.
    releaseDelayMs: 60_000,
    unload: async () => {
      events.push('unloaded');
    },
  });
  try {
    const work = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.tryPromise(() => cache.acquire('session')),
          () => Effect.sync(() => cache.releaseRef('session'))
        );
        yield* Effect.never;
      })
    );
    const fiber = Effect.runFork(work);
    await acquiring.promise;
    // acquireRelease masks acquisition until release is registered. This test
    // deliberately supplies a finite, explicitly controlled acquisition.
    await Effect.runPromise(Fiber.interruptFork(fiber));
    created.resolve({ dispose: () => events.push('disposed') });
    assert.equal(interrupted(await Effect.runPromise(Fiber.await(fiber))), true);
    await cache.releaseIfIdle('session');
    assert.deepEqual(events, ['disposed', 'unloaded']);
  } finally {
    await cache.disposeAll();
  }
});

void test("a send finalizer releases its own lease without disposing the UI's store", async () => {
  const started = gate();
  const events = [];
  const sharedStore = { value: 'visible history', dispose: () => events.push('disposed') };
  const cache = createManagedStoreCache({
    create: async () => sharedStore,
    releaseDelayMs: 60_000,
    unload: async () => {
      events.push('unloaded');
    },
  });
  try {
    const uiStore = await cache.acquire('session');
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const sendStore = yield* Effect.acquireRelease(
            Effect.tryPromise(() => cache.acquire('session')),
            () => Effect.sync(() => cache.releaseRef('session'))
          );
          assert.equal(sendStore, uiStore);
          started.resolve();
          yield* Effect.never;
        })
      )
    );
    await started.promise;
    await Effect.runPromise(Fiber.interrupt(fiber));
    await cache.releaseIfIdle('session');
    assert.deepEqual(events, []);
    assert.equal(uiStore.value, 'visible history');
    cache.releaseRef('session');
    await cache.releaseIfIdle('session');
    assert.deepEqual(events, ['disposed', 'unloaded']);
  } finally {
    await cache.disposeAll();
  }
});
