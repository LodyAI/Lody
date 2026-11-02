import posthog from 'posthog-js';
import { postHogPrivacy } from './posthog-privacy';

type PostHogClient = typeof posthog;
type PostHogOptions = NonNullable<Parameters<PostHogClient['init']>[1]>;
type TimerHandle = ReturnType<typeof setTimeout>;
type IdleHandle = number;

export type DeferredPostHogScheduler = {
  setTimeout: (handler: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
  requestIdleCallback?: (handler: () => void, options: { timeout: number }) => IdleHandle;
  cancelIdleCallback?: (handle: IdleHandle) => void;
};

type DeferredPostHogOptions = {
  startupDelayMs?: number;
  idleTimeoutMs?: number;
  maxQueuedCalls?: number;
  flushBatchSize?: number;
  onBeforeInitialize?: () => void;
  onDisabled?: (reason: 'initialization-failed' | 'missing-api-key') => void;
};

type DeferredCall = {
  args: unknown[];
  method: DeferredMethod;
};

type DeferredMethod = 'capture' | 'captureException' | 'group' | 'identify' | 'register' | 'reset';

export const POSTHOG_STARTUP_DELAY_MS = 15_000;
export const POSTHOG_IDLE_TIMEOUT_MS = 15_000;
export const POSTHOG_MAX_DEFERRED_CALLS = 200;
export const POSTHOG_DEFERRED_FLUSH_BATCH_SIZE = 25;

const DEFERRED_METHODS = new Set<DeferredMethod>([
  'capture',
  'captureException',
  'group',
  'identify',
  'register',
  'reset',
]);

function isPageLifecycleCapture(call: DeferredCall): boolean {
  return (
    call.method === 'capture' && (call.args[0] === '$pageview' || call.args[0] === '$pageleave')
  );
}

function isEvictableEvent(call: DeferredCall): boolean {
  return (
    (call.method === 'capture' && !isPageLifecycleCapture(call)) ||
    call.method === 'captureException'
  );
}

function normalizePageViewKey(navigationKey: string): string {
  if (typeof window === 'undefined') return navigationKey;
  try {
    return new URL(navigationKey, window.location.href).href;
  } catch {
    return navigationKey;
  }
}

const defaultScheduler: DeferredPostHogScheduler = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  requestIdleCallback:
    typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function'
      ? (handler, options) => window.requestIdleCallback(handler, options)
      : undefined,
  cancelIdleCallback:
    typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function'
      ? (handle) => window.cancelIdleCallback(handle)
      : undefined,
};

function addCaptureTimestamp(args: unknown[]): unknown[] {
  const options = args[2];
  if (options && typeof options === 'object' && 'timestamp' in options) {
    return args;
  }

  return [
    args[0],
    args[1],
    {
      ...(options && typeof options === 'object' ? options : {}),
      timestamp: new Date(),
    },
  ];
}

export function createDeferredPostHogController(
  realClient: PostHogClient,
  scheduler: DeferredPostHogScheduler = defaultScheduler,
  options: DeferredPostHogOptions = {}
) {
  const startupDelayMs = options.startupDelayMs ?? POSTHOG_STARTUP_DELAY_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? POSTHOG_IDLE_TIMEOUT_MS;
  const maxQueuedCalls = Math.max(1, options.maxQueuedCalls ?? POSTHOG_MAX_DEFERRED_CALLS);
  const flushBatchSize = Math.max(1, options.flushBatchSize ?? POSTHOG_DEFERRED_FLUSH_BATCH_SIZE);
  const queuedCalls: DeferredCall[] = [];
  const deferredMethods = new Map<DeferredMethod, (...args: unknown[]) => unknown>();
  const boundMethods = new Map<
    PropertyKey,
    { source: (...args: unknown[]) => unknown; value: unknown }
  >();

  let apiKey: string | null = null;
  let initOptions: PostHogOptions | null = null;
  let disabled = false;
  let initializationFailed = false;
  let automaticRetryAvailable = true;
  let initialized = realClient.__loaded;
  let timeoutHandle: TimerHandle | null = null;
  let idleHandle: IdleHandle | null = null;
  let queueDrainHandle: TimerHandle | null = null;
  let queueDraining = false;
  let activePageViewKey: string | null = null;
  let pageViewActive = false;

  const cancelInitializationSchedule = () => {
    if (timeoutHandle !== null) {
      scheduler.clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    if (idleHandle !== null && scheduler.cancelIdleCallback) {
      scheduler.cancelIdleCallback(idleHandle);
      idleHandle = null;
    }
  };

  const cancelQueueDrain = () => {
    if (queueDrainHandle !== null) {
      scheduler.clearTimeout(queueDrainHandle);
      queueDrainHandle = null;
    }
  };

  const invoke = (method: DeferredMethod, args: unknown[]): unknown => {
    const target = Reflect.get(realClient, method, realClient) as unknown;
    if (typeof target !== 'function') {
      return undefined;
    }
    return Reflect.apply(target, realClient, args);
  };

  const invokeSafely = (call: DeferredCall) => {
    try {
      invoke(call.method, call.args);
    } catch {
      // Analytics is side-effect-only. One malformed event must not prevent
      // the remaining startup events from being delivered.
    }
  };

  const flushQueueSynchronously = () => {
    cancelQueueDrain();
    queueDraining = false;
    for (const call of queuedCalls.splice(0)) {
      invokeSafely(call);
    }
  };

  const drainQueueBatch = () => {
    queueDrainHandle = null;
    const pending = queuedCalls.splice(0, flushBatchSize);
    for (const call of pending) {
      invokeSafely(call);
    }
    if (queuedCalls.length > 0) {
      queueDrainHandle = scheduler.setTimeout(drainQueueBatch, 0);
      return;
    }
    queueDraining = false;
  };

  const startQueueDrain = () => {
    if (queueDraining || queuedCalls.length === 0) return;
    queueDraining = true;
    drainQueueBatch();
  };

  const enqueue = (call: DeferredCall) => {
    if (queuedCalls.length >= maxQueuedCalls) {
      const oldestEventIndex = queuedCalls.findIndex(isEvictableEvent);
      if (oldestEventIndex >= 0) {
        queuedCalls.splice(oldestEventIndex, 1);
      } else if (isEvictableEvent(call)) {
        return;
      } else {
        queuedCalls.shift();
      }
    }
    queuedCalls.push(call);
  };

  const retainReplayableState = () => {
    const retainedCalls = queuedCalls.filter((call) => !isEvictableEvent(call));
    queuedCalls.splice(0, queuedCalls.length, ...retainedCalls);
  };

  const initializeNow = ({ afterFailure = false, flushSynchronously = false } = {}) => {
    if (initializationFailed && !afterFailure) {
      return;
    }
    cancelInitializationSchedule();
    if (disabled || !apiKey || !initOptions) {
      return;
    }

    if (!initialized && !realClient.__loaded) {
      try {
        options.onBeforeInitialize?.();
        realClient.init(apiKey, initOptions);
        if (realClient === posthog) postHogPrivacy.sync(true);
        initialized = true;
        initializationFailed = false;
      } catch {
        // A later configure can retry initialization without React re-running
        // its identity and initial-page effects. Preserve that bounded state,
        // but discard ordinary telemetry from the failed startup window.
        initializationFailed = true;
        retainReplayableState();
        cancelQueueDrain();
        queueDraining = false;
        options.onDisabled?.('initialization-failed');
        if (automaticRetryAvailable) {
          automaticRetryAvailable = false;
          scheduleInitialization({ afterFailure: true });
        }
        return;
      }
    } else {
      initialized = true;
    }

    if (flushSynchronously) {
      flushQueueSynchronously();
    } else {
      startQueueDrain();
    }
  };

  const scheduleInitialization = ({ afterFailure = false } = {}) => {
    if (
      disabled ||
      initialized ||
      (!afterFailure && initializationFailed) ||
      timeoutHandle !== null ||
      idleHandle !== null
    ) {
      return;
    }

    timeoutHandle = scheduler.setTimeout(() => {
      timeoutHandle = null;
      if (scheduler.requestIdleCallback) {
        idleHandle = scheduler.requestIdleCallback(
          () => {
            idleHandle = null;
            initializeNow({ afterFailure });
          },
          { timeout: idleTimeoutMs }
        );
        return;
      }
      initializeNow({ afterFailure });
    }, startupDelayMs);
  };

  const enqueueOrInvoke = (method: DeferredMethod, args: unknown[]): unknown => {
    if (method === 'captureException' && realClient === posthog) {
      args = postHogPrivacy.prepareException(args);
    }
    if ((initialized || realClient.__loaded) && !queueDraining) {
      initialized = true;
      return invoke(method, args);
    }
    if (disabled) {
      return undefined;
    }

    const call = {
      method,
      args: method === 'capture' ? addCaptureTimestamp(args) : args,
    } satisfies DeferredCall;
    if (initializationFailed && isEvictableEvent(call)) {
      return undefined;
    }

    enqueue(call);
    return undefined;
  };

  const client = new Proxy(realClient, {
    get(target, property) {
      if (DEFERRED_METHODS.has(property as DeferredMethod)) {
        const method = property as DeferredMethod;
        let deferred = deferredMethods.get(method);
        if (!deferred) {
          deferred = (...args: unknown[]) => enqueueOrInvoke(method, args);
          deferredMethods.set(method, deferred);
        }
        return deferred;
      }

      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') {
        return value;
      }
      const source = value as (...args: unknown[]) => unknown;

      const cached = boundMethods.get(property);
      if (cached?.source === source) {
        return cached.value;
      }
      const bound = source.bind(target);
      boundMethods.set(property, { source, value: bound });
      return bound;
    },
  }) as PostHogClient;

  return {
    client,
    configure(nextApiKey: string | null | undefined, nextOptions: PostHogOptions) {
      const normalizedKey = nextApiKey?.trim() ?? '';
      if (!normalizedKey) {
        disabled = true;
        initializationFailed = false;
        automaticRetryAvailable = true;
        queuedCalls.length = 0;
        activePageViewKey = null;
        pageViewActive = false;
        cancelInitializationSchedule();
        cancelQueueDrain();
        queueDraining = false;
        options.onDisabled?.('missing-api-key');
        return false;
      }

      const configurationChanged =
        disabled || apiKey !== normalizedKey || initOptions !== nextOptions;
      if (!configurationChanged) {
        if (realClient.__loaded) {
          initialized = true;
          startQueueDrain();
          return false;
        }
        // The provider can render repeatedly. Re-applying the same singleton
        // options must not reset a failed initialization or turn the single
        // automatic retry into a render-driven retry loop.
        scheduleInitialization();
        return !initializationFailed;
      }

      cancelInitializationSchedule();
      disabled = false;
      initializationFailed = false;
      automaticRetryAvailable = true;
      apiKey = normalizedKey;
      initOptions = nextOptions;
      if (realClient.__loaded) {
        options.onBeforeInitialize?.();
        initialized = true;
        startQueueDrain();
        return false;
      }
      scheduleInitialization();
      return true;
    },
    initializeNow,
    trackPageView(
      navigationKey: string,
      timestamp = new Date(),
      { force = false }: { force?: boolean } = {}
    ) {
      const normalizedKey = normalizePageViewKey(navigationKey);
      if (disabled || (!force && pageViewActive && activePageViewKey === normalizedKey)) return;
      activePageViewKey = normalizedKey;
      pageViewActive = true;
      enqueueOrInvoke('capture', ['$pageview', null, { timestamp, send_instantly: true }]);
    },
    flushForPageHide(timestamp = new Date()) {
      if (disabled) return;
      if (pageViewActive) {
        pageViewActive = false;
        enqueueOrInvoke('capture', [
          '$pageleave',
          null,
          { timestamp, transport: 'sendBeacon', send_instantly: true },
        ]);
      }
      initializeNow({ flushSynchronously: true });
      if (!initialized && !realClient.__loaded) return;
      flushQueueSynchronously();
      const shutdown = Reflect.get(realClient, 'shutdown', realClient) as unknown;
      if (typeof shutdown === 'function') {
        void Promise.resolve(Reflect.apply(shutdown, realClient, [])).catch(() => undefined);
      }
    },
  };
}

let removeDeferredStartupErrorListeners: (() => void) | null = null;
let removeDeferredPageLifecycleListeners: (() => void) | null = null;

function stopDeferredStartupErrorListeners(): void {
  removeDeferredStartupErrorListeners?.();
  removeDeferredStartupErrorListeners = null;
}

function stopDeferredPageLifecycleListeners(): void {
  removeDeferredPageLifecycleListeners?.();
  removeDeferredPageLifecycleListeners = null;
}

const deferredPostHogController = createDeferredPostHogController(posthog, defaultScheduler, {
  onBeforeInitialize: () => {
    stopDeferredStartupErrorListeners();
    postHogPrivacy.attach(posthog);
  },
  onDisabled: (reason) => {
    stopDeferredStartupErrorListeners();
    if (reason === 'missing-api-key') {
      stopDeferredPageLifecycleListeners();
    }
  },
});

export const deferredPostHog = deferredPostHogController.client;

function installDeferredStartupErrorListeners(): void {
  if (typeof window === 'undefined' || removeDeferredStartupErrorListeners) {
    return;
  }

  const handleError = (event: ErrorEvent) => {
    deferredPostHog.captureException(event.error ?? new Error(event.message), {
      lody_capture_source: 'pre_init_window_error',
    });
  };
  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    deferredPostHog.captureException(event.reason, {
      lody_capture_source: 'pre_init_unhandled_rejection',
    });
  };
  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);
  removeDeferredStartupErrorListeners = () => {
    window.removeEventListener('error', handleError);
    window.removeEventListener('unhandledrejection', handleUnhandledRejection);
  };
}

function installDeferredPageLifecycleListeners(): void {
  if (typeof window === 'undefined' || removeDeferredPageLifecycleListeners) return;

  const handlePageHide = () => {
    // PostHog is initialized during this pagehide on short visits, so its own
    // listener cannot observe the event currently being dispatched. Record the
    // leave first, then synchronously hand its request queue to sendBeacon.
    deferredPostHogController.flushForPageHide();
  };
  const handlePageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    deferredPostHogController.trackPageView(window.location.href, new Date(), { force: true });
  };

  window.addEventListener('pagehide', handlePageHide);
  window.addEventListener('pageshow', handlePageShow);
  removeDeferredPageLifecycleListeners = () => {
    window.removeEventListener('pagehide', handlePageHide);
    window.removeEventListener('pageshow', handlePageShow);
  };
}

export function trackDeferredPostHogPageView(navigationKey: string): void {
  deferredPostHogController.trackPageView(navigationKey);
}

export function scheduleDeferredPostHogInitialization(
  apiKey: string | null | undefined,
  options: PostHogOptions
): void {
  const shouldCaptureStartupErrors = deferredPostHogController.configure(apiKey, options);
  if (apiKey?.trim()) {
    installDeferredPageLifecycleListeners();
    if (shouldCaptureStartupErrors) {
      installDeferredStartupErrorListeners();
    } else {
      stopDeferredStartupErrorListeners();
    }
  }
}
