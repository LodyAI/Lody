import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeferredPostHogController,
  type DeferredPostHogScheduler,
} from '../src/lib/deferred-posthog';

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

  it('waits for the delay and idle window, then replays startup calls in order', () => {
    const { calls, client } = createClient();
    const scheduled = createScheduler();
    const onBeforeInitialize = vi.fn(() => {
      calls.push({ method: 'beforeInitialize', args: [] });
    });
    const controller = createDeferredPostHogController(client, scheduled.scheduler, {
      startupDelayMs: 123,
      idleTimeoutMs: 456,
      onBeforeInitialize,
    });

    controller.configure(' project-key ', { api_host: 'https://example.test' });
    controller.client.register({ platform: 'web' });
    controller.client.capture('app/launch', { launch_mode: 'direct' });
    controller.client.identify('user-1');

    expect(client.init).not.toHaveBeenCalled();
    expect(scheduled.scheduler.setTimeout).toHaveBeenCalledWith(expect.any(Function), 123);

    scheduled.runDelay();
    expect(client.init).not.toHaveBeenCalled();
    expect(scheduled.scheduler.requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 456,
    });

    scheduled.runIdle();

    expect(calls.map((call) => call.method)).toEqual([
      'beforeInitialize',
      'init',
      'register',
      'capture',
      'identify',
    ]);
    expect(client.init).toHaveBeenCalledWith('project-key', {
      api_host: 'https://example.test',
    });
    expect(client.capture).toHaveBeenCalledWith(
      'app/launch',
      { launch_mode: 'direct' },
      { timestamp: expect.any(Date) }
    );
    expect(onBeforeInitialize).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicit capture timestamp and invokes later calls immediately', () => {
    const { calls, client } = createClient();
    const scheduled = createScheduler({ withIdle: false });
    const controller = createDeferredPostHogController(client, scheduled.scheduler);
    const timestamp = new Date('2026-08-04T00:00:00.000Z');

    controller.configure('project-key', {});
    controller.client.capture('queued', null, { timestamp });
    scheduled.runDelay();
    controller.client.capture('ready');

    expect(calls.map((call) => call.method)).toEqual(['init', 'capture', 'capture']);
    expect(client.capture).toHaveBeenNthCalledWith(1, 'queued', null, { timestamp });
    expect(client.capture).toHaveBeenNthCalledWith(2, 'ready');
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

  it('replays identity and page lifecycle state after a transient init failure', () => {
    const { calls, client } = createClient({ initFailures: 1 });
    const scheduled = createScheduler({ withIdle: false });
    const controller = createDeferredPostHogController(client, scheduled.scheduler);

    controller.configure('project-key', {});
    controller.trackPageView('/workspace');
    controller.client.identify('user-1');
    controller.client.capture('discarded-startup-event');
    expect(() => scheduled.runDelay()).not.toThrow();

    controller.configure('project-key', {});
    controller.initializeNow();
    controller.flushForPageHide(new Date('2026-08-04T00:00:03.000Z'));

    expect(calls.map((call) => call.method)).toEqual([
      'init',
      'init',
      'capture',
      'identify',
      'capture',
      'shutdown',
    ]);
    expect(client.capture.mock.calls.map((call) => call[0])).toEqual(['$pageview', '$pageleave']);
    expect(client.capture).toHaveBeenNthCalledWith(1, '$pageview', null, expect.any(Object));
    expect(client.identify).toHaveBeenCalledWith('user-1');
    expect(client.capture).toHaveBeenNthCalledWith(2, '$pageleave', null, expect.any(Object));
  });

  it('applies logout, navigation, and identity changes before its automatic retry', () => {
    const { calls, client } = createClient({ initFailures: 1 });
    const scheduled = createScheduler({ withIdle: false });
    const controller = createDeferredPostHogController(client, scheduled.scheduler);

    controller.configure('project-key', {});
    controller.client.identify('user-a');
    controller.trackPageView('/workspace');
    controller.client.capture('discarded-before-failure');
    scheduled.runDelay();

    controller.client.reset();
    controller.trackPageView('/login');
    controller.client.identify('user-b');
    controller.client.capture('discarded-after-failure');
    scheduled.runDelay();

    expect(calls.map((call) => call.method)).toEqual([
      'init',
      'init',
      'identify',
      'capture',
      'reset',
      'capture',
      'identify',
    ]);
    expect(client.capture.mock.calls.map((call) => call[0])).toEqual(['$pageview', '$pageview']);
    expect(client.identify.mock.calls).toEqual([['user-a'], ['user-b']]);
    expect(client.reset).toHaveBeenCalledTimes(1);
  });

  it('does not let repeated provider renders exceed the automatic retry budget', () => {
    const { client } = createClient({ initFailures: 3 });
    const scheduled = createScheduler({ withIdle: false });
    const controller = createDeferredPostHogController(client, scheduled.scheduler);
    const initOptions = { api_host: 'https://example.test' };

    controller.configure('project-key', initOptions);
    controller.client.capture('discarded-before-first-failure');
    scheduled.runDelay();

    controller.configure('project-key', initOptions);
    controller.client.capture('discarded-before-automatic-retry');
    scheduled.runDelay();

    controller.configure('project-key', initOptions);
    controller.configure('project-key', initOptions);
    controller.client.capture('discarded-after-retry-budget');
    controller.flushForPageHide();

    expect(client.init).toHaveBeenCalledTimes(2);
    expect(client.capture).not.toHaveBeenCalled();
    expect(scheduled.scheduler.setTimeout).toHaveBeenCalledTimes(2);
    expect(() => scheduled.runDelay()).toThrow('No startup delay scheduled');
  });

  it('bounds an event storm and drains the retained calls in small batches', () => {
    const { calls, client } = createClient();
    const scheduled = createScheduler({ withIdle: false });
    const controller = createDeferredPostHogController(client, scheduled.scheduler, {
      maxQueuedCalls: 4,
      flushBatchSize: 2,
    });

    controller.configure('project-key', {});
    for (let index = 0; index < 6; index += 1) {
      controller.client.capture(`event-${index}`);
    }
    controller.initializeNow();

    expect(calls.filter((call) => call.method === 'capture').map((call) => call.args[0])).toEqual([
      'event-2',
      'event-3',
    ]);
    scheduled.runNextDrain();
    expect(calls.filter((call) => call.method === 'capture').map((call) => call.args[0])).toEqual([
      'event-2',
      'event-3',
      'event-4',
      'event-5',
    ]);
  });

  it('drops excess events before identity state when the queue is full', () => {
    const { calls, client } = createClient();
    const scheduled = createScheduler({ withIdle: false });
    const controller = createDeferredPostHogController(client, scheduled.scheduler, {
      maxQueuedCalls: 2,
    });

    controller.configure('project-key', {});
    controller.client.register({ platform: 'web' });
    controller.client.identify('user-1');
    controller.client.capture('discarded-event');
    controller.initializeNow();

    expect(calls.map((call) => call.method)).toEqual(['init', 'register', 'identify']);
  });

  it('allows the same page to be tracked after analytics is disabled and reconfigured', () => {
    const { calls, client } = createClient();
    const scheduled = createScheduler({ withIdle: false });
    const controller = createDeferredPostHogController(client, scheduled.scheduler);

    controller.configure('first-key', {});
    controller.trackPageView('/same-page');
    controller.configure('', {});
    controller.configure('second-key', {});
    controller.trackPageView('/same-page');
    controller.initializeNow();

    expect(calls.filter((call) => call.method === 'capture').map((call) => call.args[0])).toEqual([
      '$pageview',
    ]);
  });

  it('dedupes relative and absolute keys for the initial pageview', () => {
    vi.stubGlobal('window', {
      location: { href: 'https://lody.ai/workspace?tab=tasks' },
    });
    const { client } = createClient();
    const scheduled = createScheduler({ withIdle: false });
    const controller = createDeferredPostHogController(client, scheduled.scheduler);

    controller.configure('project-key', {});
    controller.trackPageView('/workspace?tab=tasks');
    controller.trackPageView('https://lody.ai/workspace?tab=tasks');
    controller.initializeNow();

    expect(client.capture).toHaveBeenCalledTimes(1);
    expect(client.capture).toHaveBeenCalledWith('$pageview', null, expect.any(Object));
  });

  it('keeps identity and page lifecycle calls during a bounded event storm', () => {
    const { client } = createClient();
    const scheduled = createScheduler({ withIdle: false });
    const controller = createDeferredPostHogController(client, scheduled.scheduler, {
      maxQueuedCalls: 200,
      flushBatchSize: 200,
    });

    controller.configure('project-key', {});
    controller.trackPageView('/first');
    controller.client.identify('user-1');
    for (let index = 0; index < 201; index += 1) {
      controller.client.captureException(new Error(`failure-${index}`));
    }
    controller.initializeNow();

    expect(client.capture).toHaveBeenCalledWith('$pageview', null, expect.any(Object));
    expect(client.identify).toHaveBeenCalledWith('user-1');
    expect(client.captureException).toHaveBeenCalledTimes(198);
  });

  it('flushes deferred page timing with sendBeacon semantics on a short visit', () => {
    const { calls, client } = createClient();
    const scheduled = createScheduler();
    const controller = createDeferredPostHogController(client, scheduled.scheduler);
    const firstPageAt = new Date('2026-08-04T00:00:00.000Z');
    const secondPageAt = new Date('2026-08-04T00:00:02.000Z');
    const pageHideAt = new Date('2026-08-04T00:00:03.000Z');

    controller.configure('project-key', {});
    controller.trackPageView('/first', firstPageAt);
    controller.trackPageView('/second', secondPageAt);
    controller.flushForPageHide(pageHideAt);

    expect(calls.map((call) => call.method)).toEqual([
      'init',
      'capture',
      'capture',
      'capture',
      'shutdown',
    ]);
    expect(client.capture).toHaveBeenNthCalledWith(1, '$pageview', null, {
      timestamp: firstPageAt,
      send_instantly: true,
    });
    expect(client.capture).toHaveBeenNthCalledWith(2, '$pageview', null, {
      timestamp: secondPageAt,
      send_instantly: true,
    });
    expect(client.capture).toHaveBeenNthCalledWith(3, '$pageleave', null, {
      timestamp: pageHideAt,
      transport: 'sendBeacon',
      send_instantly: true,
    });
    expect(client.shutdown).toHaveBeenCalledTimes(1);
  });
});
