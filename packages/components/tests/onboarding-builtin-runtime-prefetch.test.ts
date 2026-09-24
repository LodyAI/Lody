import { beforeEach, describe, expect, it } from 'vitest';
import type { ManagedBuiltinAgentType } from '@lody/shared';

import { __onboardingBuiltinRuntimePrefetchForTests as prefetch } from '../src/components/onboarding/use-onboarding-builtin-runtime-prefetch';

type Deferred = { promise: Promise<void>; resolve: () => void };

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * The scheduler records completion in `.then`/`.finally` hops, so the test has
 * to let those microtasks run. This is a fixed number of microtask turns, not a
 * timer or a wall-clock wait, so it cannot race.
 */
async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

/** Records start order and reports each start through its own explicit signal. */
function createRecorder(hold?: Deferred) {
  const starts: ManagedBuiltinAgentType[] = [];
  const started = new Map<ManagedBuiltinAgentType, Deferred>();
  const signalFor = (agentType: ManagedBuiltinAgentType): Deferred => {
    const existing = started.get(agentType);
    if (existing) return existing;
    const deferred = createDeferred();
    started.set(agentType, deferred);
    return deferred;
  };
  const run = async (agentType: ManagedBuiltinAgentType): Promise<void> => {
    starts.push(agentType);
    signalFor(agentType).resolve();
    if (hold) await hold.promise;
  };
  return { starts, run, waitForStart: (agentType: ManagedBuiltinAgentType) => signalFor(agentType).promise };
}

describe('onboarding builtin runtime prefetch scheduling', () => {
  beforeEach(() => {
    prefetch.reset();
  });

  it('places the selected runtime first without changing the background order', () => {
    expect(prefetch.resolvePrefetchOrder(null)).toEqual(['kimi', 'codex', 'claude']);
    expect(prefetch.resolvePrefetchOrder('codex')).toEqual(['codex', 'kimi', 'claude']);
    expect(prefetch.resolvePrefetchOrder('claude')).toEqual(['claude', 'kimi', 'codex']);
  });

  it('starts every runtime concurrently instead of queueing behind the first', async () => {
    const hold = createDeferred();
    const recorder = createRecorder(hold);

    prefetch.schedule('workspace:machine', prefetch.resolvePrefetchOrder(null), recorder.run);

    // No task has settled, so a serial scheduler would never start the other
    // two and this await would never resolve.
    await Promise.all([
      recorder.waitForStart('kimi'),
      recorder.waitForStart('codex'),
      recorder.waitForStart('claude'),
    ]);
    expect(recorder.starts).toEqual(['kimi', 'codex', 'claude']);

    hold.resolve();
  });

  it('launches the preferred runtime first without restarting work in flight', async () => {
    const hold = createDeferred();
    const recorder = createRecorder(hold);

    const initial = prefetch.schedule('workspace:machine', ['kimi'], recorder.run);
    await recorder.waitForStart('kimi');

    initial.dispose();
    prefetch.schedule('workspace:machine', prefetch.resolvePrefetchOrder('codex'), recorder.run);
    await Promise.all([recorder.waitForStart('codex'), recorder.waitForStart('claude')]);

    // 'codex' leads the new order, and the in-flight 'kimi' is not started twice.
    expect(recorder.starts).toEqual(['kimi', 'codex', 'claude']);

    hold.resolve();
  });

  it('does not restart a runtime that already finished', async () => {
    const recorder = createRecorder();

    const initial = prefetch.schedule('workspace:machine', ['kimi'], recorder.run);
    await recorder.waitForStart('kimi');
    await drainMicrotasks();

    initial.dispose();
    prefetch.schedule('workspace:machine', prefetch.resolvePrefetchOrder(null), recorder.run);
    await Promise.all([recorder.waitForStart('codex'), recorder.waitForStart('claude')]);

    expect(recorder.starts).toEqual(['kimi', 'codex', 'claude']);
  });
});
