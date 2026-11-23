import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scheduleAfterLoadIdle } from './after-first-paint.ts';

type IdleHandle = number;

function installSchedulerEnv(readyState: DocumentReadyState) {
  const idleCallbacks = new Map<IdleHandle, () => void>();
  const loadListeners = new Set<() => void>();
  let nextIdle = 1;
  let rafQueue: Array<() => void> = [];

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };

  const requestIdleCallback = (cb: () => void) => {
    const id = nextIdle++;
    idleCallbacks.set(id, cb);
    return id;
  };
  const cancelIdleCallback = (id: IdleHandle) => {
    idleCallbacks.delete(id);
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { readyState },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      requestIdleCallback,
      cancelIdleCallback,
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'load') loadListeners.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === 'load') loadListeners.delete(listener);
      },
    },
  });
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    rafQueue.push(() => cb(0));
    return rafQueue.length;
  };

  return {
    flushRaf() {
      const queued = rafQueue;
      rafQueue = [];
      for (const run of queued) run();
    },
    flushIdle() {
      const queued = [...idleCallbacks.values()];
      idleCallbacks.clear();
      for (const run of queued) run();
    },
    fireLoad() {
      for (const listener of [...loadListeners]) listener();
    },
    pendingIdle() {
      return idleCallbacks.size;
    },
    restore() {
      if (previous.window === undefined) {
        Reflect.deleteProperty(globalThis, 'window');
      } else {
        Object.defineProperty(globalThis, 'window', {
          configurable: true,
          value: previous.window,
        });
      }
      if (previous.document === undefined) {
        Reflect.deleteProperty(globalThis, 'document');
      } else {
        Object.defineProperty(globalThis, 'document', {
          configurable: true,
          value: previous.document,
        });
      }
      globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    },
  };
}

await test('scheduleAfterLoadIdle waits for load, two frames, then idle', () => {
  const env = installSchedulerEnv('loading');
  try {
    let started = false;
    const cancel = scheduleAfterLoadIdle(() => {
      started = true;
    });

    assert.equal(started, false);
    env.flushRaf();
    assert.equal(started, false);
    env.fireLoad();
    assert.equal(started, false);
    env.flushRaf();
    assert.equal(started, false);
    env.flushRaf();
    assert.equal(started, false);
    env.flushIdle();
    assert.equal(started, true);
    cancel();
  } finally {
    env.restore();
  }
});

await test('scheduleAfterLoadIdle starts after paint when the document is already complete', () => {
  const env = installSchedulerEnv('complete');
  try {
    let started = false;
    scheduleAfterLoadIdle(() => {
      started = true;
    });

    env.flushRaf();
    env.flushRaf();
    assert.equal(started, false);
    env.flushIdle();
    assert.equal(started, true);
  } finally {
    env.restore();
  }
});

await test('scheduleAfterLoadIdle cancel prevents a late idle callback', () => {
  const env = installSchedulerEnv('complete');
  try {
    let started = false;
    const cancel = scheduleAfterLoadIdle(() => {
      started = true;
    });
    env.flushRaf();
    env.flushRaf();
    assert.equal(env.pendingIdle(), 1);
    cancel();
    env.flushIdle();
    assert.equal(started, false);
  } finally {
    env.restore();
  }
});
