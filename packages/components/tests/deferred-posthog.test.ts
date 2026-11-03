import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferredPostHogController, type DeferredPostHogScheduler } from '../src/lib/deferred-posthog';

type PostHogClient = Parameters<typeof createDeferredPostHogController>[0];

function createClient({ initFailures = 0 }: { initFailures?: number } = {}) {
  const calls: Array<{ args: unknown[]; method: string }> = [];
  let remainingInitFailures = initFailures;
  const client = {
    __loaded: false,
    init: vi.fn(function (this: { __loaded: boolean }, ...args: unknown[]) {
      calls.push({ method: 'init', args });
      if (remainingInitFailures > 0) {
        remainingInitFailures -= 1;
        throw new Error('init failed');
      }
      this.__loaded = true;
      return this;
    }),
    capture: vi.fn((...args: unknown[]) => {
      calls.push({ method: 'capture', args });
    }),
    captureException: vi.fn((...args: unknown[]) => {
      calls.push({ method: 'captureException', args });
    }),
    group: vi.fn((...args: unknown[]) => {
      calls.push({ method: 'group', args });
    }),
    identify: vi.fn((...args: unknown[]) => {
      calls.push({ method: 'identify', args });
    }),
    register: vi.fn((...args: unknown[]) => {
      calls.push({ method: 'register', args });
    }),
    reset: vi.fn((...args: unknown[]) => {
      calls.push({ method: 'reset', args });
    }),
    shutdown: vi.fn(async () => {
      calls.push({ method: 'shutdown', args: [] });
    }),
  };

  return { calls, client: client as unknown as PostHogClient };
}

function createScheduler({ withIdle = true }: { withIdle?: boolean } = {}) {
  let nextTimeoutHandle = 1;
  const timeoutHandlers = new Map<number, { handler: () => void; ms: number }>();
  let idleHandler: (() => void) | null = null;
  const scheduler: DeferredPostHogScheduler = {
    setTimeout: vi.fn((handler, ms) => {
      const handle = nextTimeoutHandle;
      nextTimeoutHandle += 1;
      timeoutHandlers.set(handle, { handler, ms });
      return handle as unknown as ReturnType<typeof setTimeout>;
    }),
    clearTimeout: vi.fn((handle) => {
      timeoutHandlers.delete(handle as unknown as number);
    }),
    ...(withIdle
      ? {
          requestIdleCallback: vi.fn((handler: () => void) => {
            idleHandler = handler;
            return 2;
          }),
          cancelIdleCallback: vi.fn(),
        }
      : {}),
  };

  return {
    scheduler,
    runDelay() {
      const entry = Array.from(timeoutHandlers.entries()).find(([, value]) => value.ms > 0);
      if (!entry) throw new Error('No startup delay scheduled');
      timeoutHandlers.delete(entry[0]);
      entry[1].handler();
    },
    runNextDrain() {
      const entry = Array.from(timeoutHandlers.entries()).find(([, value]) => value.ms === 0);
      if (!entry) throw new Error('No queue drain scheduled');
      timeoutHandlers.delete(entry[0]);
      entry[1].handler();
    },
    runIdle() {
      if (!idleHandler) throw new Error('No idle callback scheduled');
      const handler = idleHandler;
      idleHandler = null;
      handler();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deferred PostHog initialization', () => {
  it.each([
    { __LODY_ELECTRON__: true },
    { __LODY_NATIVE__: true },
    { Capacitor: { getPlatform: () => 'ios' } },
    { Capacitor: { getPlatform: () => 'android' } },
  ])('omits native page lifecycle events while delivering product events: %j', (nativeWindow) => {
    vi.stubGlobal('window', { ...nativeWindow, location: { href: 'https://example.test/' } });
    const { calls, client } = createClient();
    const scheduled = createScheduler();
    const controller = createDeferredPostHogController(client, scheduled.scheduler);
    controller.configure('synthetic-key', {});

    controller.trackPageView('/workspace');
    controller.trackPageView('/workspace/session');
    controller.trackPageView('/workspace/session', new Date(), { force: true });
    controller.client.capture('session/message_submit_requested', {});
    controller.flushForPageHide();

    expect(calls.filter(({ method }) => method === 'capture').map(({ args }) => args[0])).toEqual([
      'session/message_submit_requested',
    ]);
  });

  it('drops queued calls when analytics has no project key', () => {
    const { client } = createClient();
    const scheduled = createScheduler();
    const onDisabled = vi.fn();
    const controller = createDeferredPostHogController(client, scheduled.scheduler, {
      onDisabled,
    });

    controller.client.capture('before-config');
    controller.configure('', {});
    controller.initializeNow();
    controller.client.capture('after-config');

    expect(client.init).not.toHaveBeenCalled();
    expect(client.capture).not.toHaveBeenCalled();
    expect(scheduled.scheduler.setTimeout).not.toHaveBeenCalled();
    expect(onDisabled).toHaveBeenCalledTimes(1);
  });

  it('keeps analytics initialization failures out of the product path', () => {
    const { client } = createClient({ initFailures: 1 });
    const scheduled = createScheduler({ withIdle: false });
    const onDisabled = vi.fn();
    const controller = createDeferredPostHogController(client, scheduled.scheduler, {
      onDisabled,
    });

    controller.configure('project-key', {});
    controller.client.capture('queued');

    expect(() => scheduled.runDelay()).not.toThrow();
    expect(() => controller.client.capture('after-failure')).not.toThrow();
    expect(client.capture).not.toHaveBeenCalled();
    expect(onDisabled).toHaveBeenCalledTimes(1);
  });
});
