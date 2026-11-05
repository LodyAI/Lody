import { isNativeAppShell, isNativeIOSAppShell } from './native-platform';

type OneSignalLanguage = 'en' | 'zh';
type OneSignalLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

type OneSignalPushSubscription = {
  optIn: () => void | Promise<void>;
  optOut: () => void | Promise<void>;
  getOptedIn?: () => Promise<boolean>;
  optedIn?: boolean | (() => boolean | Promise<boolean>);
};

export type OneSignalClient = {
  init?: (options: {
    appId: string;
    safari_web_id?: string;
    allowLocalhostAsSecureOrigin?: boolean;
    serviceWorkerPath?: string;
    serviceWorkerUpdaterPath?: string;
    serviceWorkerParam?: { scope: string };
    autoResubscribe?: boolean;
    welcomeNotification?: { disable: boolean; message: string };
  }) => Promise<void>;
  login: (externalId: string, jwtToken?: string) => Promise<void> | void;
  logout?: () => Promise<void> | void;
  User: {
    setLanguage: (language: OneSignalLanguage) => void | Promise<void>;
    PushSubscription: OneSignalPushSubscription;
  };
  Notifications: {
    requestPermission: (fallbackToSettings?: boolean) => Promise<boolean>;
    getPermissionState?: () => Promise<NotificationPermission>;
  };
  Debug?: {
    setLogLevel: (level: OneSignalLogLevel) => void;
  };
};

type OneSignalSdk = OneSignalClient & {
  init: NonNullable<OneSignalClient['init']>;
};

type NativeNotificationClickEvent = {
  result: {
    actionId?: string;
    url?: string;
  };
  notification: {
    launchURL?: string;
    additionalData?: Record<string, unknown>;
  };
};

type NativeOneSignalPlugin = {
  initialize: (appId: string) => void;
  login: (externalId: string) => void;
  logout: () => void;
  User: {
    setLanguage: (language: string) => void;
    pushSubscription: {
      optIn: () => void;
      optOut: () => void;
      getOptedInAsync: () => Promise<boolean>;
    };
  };
  Notifications: {
    requestPermission: (fallbackToSettings?: boolean) => Promise<boolean>;
    permissionNative: () => Promise<number>;
    addEventListener: (
      event: 'click',
      listener: (event: NativeNotificationClickEvent) => void
    ) => void;
  };
  Debug?: {
    setLogLevel: (level: number) => void;
  };
};

type LiveActivitySetupBridge = {
  setupOneSignalLiveActivities?: () => Promise<void>;
};

type OneSignalWindow = Window & {
  OneSignal?: OneSignalClient | NativeOneSignalPlugin;
  OneSignalDeferred?: Array<(oneSignal: OneSignalSdk) => void | Promise<void>>;
  plugins?: {
    OneSignal?: NativeOneSignalPlugin;
  };
  __LODY_CORDOVA_READY__?: boolean;
  __LODY_LIVE_ACTIVITY__?: LiveActivitySetupBridge;
};

const ONE_SIGNAL_SDK_SRC = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
const ONE_SIGNAL_SCRIPT_SELECTOR = 'script[data-lody-onesignal-sdk="true"]';
const NATIVE_ONE_SIGNAL_READY_TIMEOUT_MS = 10000;
const WEB_ONE_SIGNAL_READY_TIMEOUT_MS = 15000;

let oneSignalSdkPromise: Promise<OneSignalSdk> | null = null;
let oneSignalInitPromise: Promise<OneSignalClient | null> | null = null;
let currentOneSignalClient: OneSignalClient | null = null;
let nativeNotificationClickListenerRegistered = false;
let nativeSdkInitialized = false;

function getOneSignalWindow(): OneSignalWindow {
  return window as OneSignalWindow;
}

function setCurrentOneSignalClient(oneSignal: OneSignalClient): void {
  currentOneSignalClient = oneSignal;
  getOneSignalWindow().OneSignal = oneSignal;
}

function isNativeOneSignalPlugin(value: unknown): value is NativeOneSignalPlugin {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const plugin = value as Partial<NativeOneSignalPlugin>;
  const user = plugin.User;
  const notifications = plugin.Notifications;
  return (
    typeof plugin.initialize === 'function' &&
    typeof plugin.login === 'function' &&
    typeof user === 'object' &&
    user !== null &&
    typeof user.pushSubscription === 'object' &&
    user.pushSubscription !== null &&
    typeof notifications === 'object' &&
    notifications !== null &&
    typeof notifications.requestPermission === 'function' &&
    typeof notifications.permissionNative === 'function'
  );
}

function mapNativePermissionState(permission: number): NotificationPermission {
  switch (permission) {
    case 1:
      return 'denied';
    case 2:
    case 3:
    case 4:
      return 'granted';
    default:
      return 'default';
  }
}

function mapNativeLogLevel(level: OneSignalLogLevel): number {
  switch (level) {
    case 'trace':
      return 6;
    case 'debug':
      return 5;
    case 'info':
      return 4;
    case 'warn':
      return 3;
    case 'error':
      return 2;
    case 'fatal':
      return 1;
  }
  return 4;
}

function normalizeNotificationTarget(rawUrl?: string): string | null {
  if (!rawUrl || typeof window === 'undefined') {
    return null;
  }

  if (rawUrl.startsWith('/')) {
    return rawUrl;
  }

  try {
    const parsed = new URL(rawUrl);
    if (
      parsed.protocol === 'http:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'capacitor:' ||
      parsed.protocol === 'lody:'
    ) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
    }
  } catch {
    return null;
  }

  return null;
}

function navigateWithinApp(target: string): void {
  const currentTarget = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (currentTarget === target) {
    return;
  }
  window.history.pushState(null, '', target);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function registerNativeNotificationHandlers(nativeOneSignal: NativeOneSignalPlugin): void {
  if (nativeNotificationClickListenerRegistered) {
    return;
  }

  nativeNotificationClickListenerRegistered = true;
  // TODO(analytics P0): push/received — the native OneSignal plugin's typed
  // surface here only exposes 'click'. Emitting push/received needs the
  // 'foregroundWillDisplay' listener, which requires widening NativeOneSignalPlugin
  // and confirming the plugin version exposes it; deferred to avoid a runtime
  // risk on an unverified native API.
  nativeOneSignal.Notifications.addEventListener('click', (event) => {
    const recipient = event.notification.additionalData?.recipientUserId;
    if (typeof recipient === 'string' && recipient !== localStorage.getItem('lody:push-user'))
      return;
    // Prefer data.route (in-app path) over URL-based targets
    const dataRoute = event.notification.additionalData?.route;
    const routeTarget =
      typeof dataRoute === 'string' && dataRoute.startsWith('/') && !dataRoute.startsWith('//')
        ? dataRoute
        : null;
    const target =
      routeTarget ||
      normalizeNotificationTarget(event.result.url) ||
      normalizeNotificationTarget(event.notification.launchURL);

    if (!target) {
      return;
    }

    navigateWithinApp(target);
  });
}

function createNativeOneSignalClient(nativeOneSignal: NativeOneSignalPlugin): OneSignalClient {
  return {
    login: async (externalId) => {
      nativeOneSignal.login(externalId);
    },
    logout: async () => {
      nativeOneSignal.logout();
    },
    User: {
      setLanguage: async (language) => {
        nativeOneSignal.User.setLanguage(language);
      },
      PushSubscription: {
        optIn: async () => {
          nativeOneSignal.User.pushSubscription.optIn();
        },
        optOut: async () => {
          nativeOneSignal.User.pushSubscription.optOut();
        },
        getOptedIn: async () => nativeOneSignal.User.pushSubscription.getOptedInAsync(),
      },
    },
    Notifications: {
      requestPermission: async (fallbackToSettings = false) =>
        nativeOneSignal.Notifications.requestPermission(fallbackToSettings),
      getPermissionState: async () => {
        const permission = await nativeOneSignal.Notifications.permissionNative();
        return mapNativePermissionState(permission);
      },
    },
    Debug: nativeOneSignal.Debug
      ? {
          setLogLevel: (level) => {
            nativeOneSignal.Debug?.setLogLevel(mapNativeLogLevel(level));
          },
        }
      : undefined,
  };
}

function getNativeOneSignalPlugin(): NativeOneSignalPlugin | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const oneSignalWindow = getOneSignalWindow();
  const pluginOneSignal = oneSignalWindow.plugins?.OneSignal;
  if (isNativeOneSignalPlugin(pluginOneSignal)) {
    return pluginOneSignal;
  }

  // The Cordova plugin declares `<clobbers target="OneSignal" />`; depending on
  // loader timing, Capacitor may expose it there before `window.plugins.OneSignal`.
  return isNativeOneSignalPlugin(oneSignalWindow.OneSignal) ? oneSignalWindow.OneSignal : null;
}

function setupNativeOneSignalLiveActivities(): void {
  const bridge = getOneSignalWindow().__LODY_LIVE_ACTIVITY__;
  const setup = bridge?.setupOneSignalLiveActivities;
  if (!setup) {
    return;
  }

  void Promise.resolve()
    .then(() => setup.call(bridge))
    .catch((error: unknown) => {
      console.error('OneSignal Live Activity setup failed', error);
    });
}

function waitForNativeCordovaReady(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Native OneSignal can only initialize in the browser.'));
  }

  const oneSignalWindow = getOneSignalWindow();
  if (oneSignalWindow.__LODY_CORDOVA_READY__ === true) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      document.removeEventListener('deviceready', handleReady);
      window.clearTimeout(timeoutId);
    };

    const handleReady = () => {
      if (settled) {
        return;
      }
      settled = true;
      oneSignalWindow.__LODY_CORDOVA_READY__ = true;
      cleanup();
      resolve();
    };

    const timeoutId = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error('Native OneSignal did not become ready in time.'));
    }, NATIVE_ONE_SIGNAL_READY_TIMEOUT_MS);

    document.addEventListener('deviceready', handleReady, { once: true });
  });
}

export function isOneSignalSupported(): boolean {
  if (typeof window === 'undefined' || window.__LODY_ELECTRON__ === true) {
    return false;
  }

  if (!import.meta.env.VITE_ONESIGNAL_APP_ID) {
    return false;
  }

  if (isNativeAppShell()) {
    return true;
  }

  return 'Notification' in window && typeof Notification === 'function';
}

export function loadOneSignalSdk(): Promise<OneSignalSdk> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('OneSignal SDK can only load in the browser.'));
  }

  if (oneSignalSdkPromise) {
    return oneSignalSdkPromise;
  }

  oneSignalSdkPromise = new Promise<OneSignalSdk>((resolve, reject) => {
    let settled = false;
    const readyTimeout = window.setTimeout(() => {
      rejectOnce(new Error('OneSignal SDK did not become ready in time.'));
    }, WEB_ONE_SIGNAL_READY_TIMEOUT_MS);
    const resolveOnce = (oneSignal: OneSignalSdk) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(readyTimeout);
      resolve(oneSignal);
    };

    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(readyTimeout);
      oneSignalSdkPromise = null;
      reject(error);
    };

    const oneSignalWindow = getOneSignalWindow();
    oneSignalWindow.OneSignalDeferred ??= [];
    oneSignalWindow.OneSignalDeferred.push(resolveOnce);

    const attachScript = (script: HTMLScriptElement) => {
      script.src = ONE_SIGNAL_SDK_SRC;
      script.defer = true;
      script.dataset.lodyOnesignalSdk = 'true';
      script.addEventListener(
        'error',
        () => {
          script.remove();
          rejectOnce(new Error('Failed to load OneSignal SDK.'));
        },
        { once: true }
      );
      document.head.append(script);
    };

    const existingScript = document.querySelector<HTMLScriptElement>(ONE_SIGNAL_SCRIPT_SELECTOR);
    if (existingScript) {
      existingScript.addEventListener(
        'error',
        () => {
          existingScript.remove();
          rejectOnce(new Error('Failed to load OneSignal SDK.'));
        },
        { once: true }
      );
      return;
    }

    attachScript(document.createElement('script'));
  });

  return oneSignalSdkPromise;
}

export async function getOneSignalPushSubscriptionOptedIn(
  oneSignal: OneSignalClient
): Promise<boolean | undefined> {
  const pushSubscription = oneSignal.User.PushSubscription;

  if (typeof pushSubscription.getOptedIn === 'function') {
    return pushSubscription.getOptedIn();
  }

  const { optedIn } = pushSubscription;
  if (typeof optedIn === 'boolean') {
    return optedIn;
  }

  if (typeof optedIn === 'function') {
    const result = optedIn();
    if (typeof result === 'boolean') {
      return result;
    }
    if (
      result !== null &&
      result !== undefined &&
      typeof (result as Promise<unknown>).then === 'function'
    ) {
      const awaitedResult = await result;
      return typeof awaitedResult === 'boolean' ? awaitedResult : undefined;
    }
  }

  return undefined;
}

export async function getOneSignalPermissionState(
  oneSignal: OneSignalClient
): Promise<NotificationPermission> {
  if (typeof oneSignal.Notifications.getPermissionState === 'function') {
    return oneSignal.Notifications.getPermissionState();
  }

  if (typeof window !== 'undefined' && typeof Notification === 'function') {
    return Notification.permission;
  }

  return 'default';
}

export function initOneSignal(): Promise<OneSignalClient | null> {
  if (!isOneSignalSupported()) {
    return Promise.resolve(null);
  }

  if (currentOneSignalClient) {
    return Promise.resolve(currentOneSignalClient);
  }

  if (oneSignalInitPromise) {
    return oneSignalInitPromise;
  }

  if (isNativeAppShell()) {
    oneSignalInitPromise = waitForNativeCordovaReady()
      .then(() => {
        const nativeOneSignal = getNativeOneSignalPlugin();
        if (!nativeOneSignal) {
          throw new Error('Native OneSignal plugin is unavailable.');
        }

        if (!nativeSdkInitialized) {
          if (import.meta.env.DEV) {
            nativeOneSignal.Debug?.setLogLevel(6);
          }
          nativeOneSignal.initialize(import.meta.env.VITE_ONESIGNAL_APP_ID);
          registerNativeNotificationHandlers(nativeOneSignal);
          nativeSdkInitialized = true;
          if (isNativeIOSAppShell()) {
            setupNativeOneSignalLiveActivities();
          }
        }

        const oneSignal = createNativeOneSignalClient(nativeOneSignal);
        setCurrentOneSignalClient(oneSignal);
        return oneSignal;
      })
      .catch((error: unknown) => {
        oneSignalInitPromise = null;
        throw error;
      });

    return oneSignalInitPromise;
  }

  const initPromise = loadOneSignalSdk()
    .then(async (oneSignal) => {
      await oneSignal.init({
        appId: import.meta.env.VITE_ONESIGNAL_APP_ID,
        safari_web_id: import.meta.env.VITE_ONESIGNAL_SAFARI_WEB_ID,
        allowLocalhostAsSecureOrigin: true,
        serviceWorkerPath: 'push/onesignal/OneSignalSDKWorker.js',
        serviceWorkerUpdaterPath: 'push/onesignal/OneSignalSDKUpdaterWorker.js',
        serviceWorkerParam: { scope: '/push/onesignal/' },
        autoResubscribe: false,
        welcomeNotification: { disable: true, message: '' },
      });

      if (import.meta.env.DEV) {
        oneSignal.Debug?.setLogLevel('debug');
      }

      setCurrentOneSignalClient(oneSignal);
      return oneSignal;
    })
    .catch((error: unknown) => {
      oneSignalInitPromise = null;
      throw error;
    });

  oneSignalInitPromise = initPromise;
  return initPromise;
}

export function withOneSignal(
  task: (oneSignal: OneSignalClient) => void | Promise<void>
): Promise<void> {
  return initOneSignal().then(async (oneSignal) => {
    if (!oneSignal) {
      return;
    }
    await task(oneSignal);
  });
}

export function scheduleOneSignalTask(
  task: (oneSignal: OneSignalClient, signal: AbortSignal) => void | Promise<void>,
  timeoutMs = 2000
): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  let cancelled = false;
  const controller = new AbortController();

  const run = () => {
    if (cancelled) {
      return;
    }
    void withOneSignal(async (oneSignal) => {
      if (controller.signal.aborted) return;
      await task(oneSignal, controller.signal);
    }).catch((error: unknown) => {
      console.error('OneSignal task failed', error);
    });
  };

  if (typeof window.requestIdleCallback === 'function') {
    const idleId = window.requestIdleCallback(run, { timeout: timeoutMs });
    return () => {
      cancelled = true;
      controller.abort();
      window.cancelIdleCallback(idleId);
    };
  }

  const timeoutId = window.setTimeout(run, timeoutMs);
  return () => {
    cancelled = true;
    controller.abort();
    window.clearTimeout(timeoutId);
  };
}
