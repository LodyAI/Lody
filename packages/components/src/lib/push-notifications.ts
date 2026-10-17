import { isNativeAppShell } from './native-platform';

export type PushRegistration = {
  installationId: string;
  platform: 'web' | 'ios' | 'android';
  token: string;
  bundleId?: string;
  p256dh?: string;
  auth?: string;
  language: string;
  purpose: 'notification' | 'activity' | 'activity-start';
  activityId?: string;
  workspaceId?: string;
};
export type NativePushBridge = {
  permission(): Promise<NotificationPermission>;
  requestPermission(): Promise<boolean>;
  register(
    listener: (registration: Omit<PushRegistration, 'installationId' | 'language'>) => Promise<void>
  ): Promise<void>;
  unregister(): Promise<void>;
};
declare global {
  interface Window {
    __LODY_PUSH__?: NativePushBridge;
  }
}

type PushPort = {
  register(input: PushRegistration): Promise<unknown>;
  unregister(input: { installationId: string }): Promise<unknown>;
};
let port: PushPort | undefined;
let userId: string | undefined;
let generation = 0;
let language = 'en';
let pending: Promise<unknown> = Promise.resolve();
let writes: Promise<unknown> = Promise.resolve();
const installationKey = 'lody:push-installation';
const enabledKey = 'lody:push-enabled';
function installationId() {
  let id = localStorage.getItem(installationKey);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(installationKey, id);
  }
  return id;
}
export function installPushPort(value: PushPort): () => void {
  port = value;
  return () => {
    if (port === value) {
      port = undefined;
      userId = undefined;
      generation++;
    }
  };
}
function enabled() {
  return localStorage.getItem(enabledKey) !== 'false';
}
function worker() {
  return navigator.serviceWorker.register('/push/lody/worker.js', { scope: '/push/lody/' });
}
async function save(input: Omit<PushRegistration, 'installationId' | 'language'>, epoch: number) {
  const current = port;
  const id = installationId();
  const write = writes
    .catch(() => {})
    .then(async () => {
      if (!current || !userId || epoch !== generation || !enabled()) return;
      await current.register({ ...input, installationId: id, language });
    });
  writes = write;
  await write;
}

async function subscribe(epoch: number, create: boolean) {
  if (!port || !userId || !enabled()) return;
  if (isNativeAppShell()) {
    const bridge = window.__LODY_PUSH__;
    if (!bridge || (await bridge.permission()) !== 'granted' || epoch !== generation) return;
    await bridge.register((input) => save(input, epoch));
    return;
  }
  if (Notification.permission !== 'granted') return;
  const registration = await worker();
  // Wait for this exact registration, not navigator.serviceWorker.ready (the
  // page is deliberately outside our dedicated worker scope).
  if (!registration.active)
    await new Promise<void>((resolve, reject) => {
      const installing = registration.installing ?? registration.waiting;
      if (!installing) return reject(new Error('Push worker unavailable'));
      const changed = () => {
        if (installing.state === 'activated') {
          installing.removeEventListener('statechange', changed);
          resolve();
        }
        if (installing.state === 'redundant') {
          installing.removeEventListener('statechange', changed);
          reject(new Error('Push worker failed'));
        }
      };
      installing.addEventListener('statechange', changed);
      changed();
    });
  if (epoch !== generation || !enabled()) return;
  registration.active?.postMessage({ type: 'account', userId });
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription && create)
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: import.meta.env.VITE_PUSH_VAPID_PUBLIC_KEY,
    });
  if (!subscription) return;
  const json = subscription.toJSON();
  await save(
    {
      platform: 'web',
      purpose: 'notification',
      token: subscription.endpoint,
      p256dh: json.keys?.p256dh,
      auth: json.keys?.auth,
    },
    epoch
  );
}

export function isPushSupported(): boolean {
  if (typeof window === 'undefined' || window.__LODY_ELECTRON__ === true) return false;
  // First release supports native shells only. Browser registration remains
  // deferred even when a deployment still has VAPID configuration.
  return isNativeAppShell() && Boolean(window.__LODY_PUSH__);
}

// The settings facade preserves the existing permission/subscription distinction.
const client = {
  async login(id: string, _token?: string) {
    const epoch = ++generation;
    userId = id;
    localStorage.setItem('lody:push-user', id);
    installationId();
    pending = pending
      .catch(() => {})
      .then(async () => {
        if (epoch !== generation) return;
        // Replace old provider subscriptions only after the user opens the new app.
        if (!isNativeAppShell())
          for (const reg of await navigator.serviceWorker.getRegistrations()) {
            if (new URL(reg.scope).pathname === '/push/onesignal/') {
              await (await reg.pushManager.getSubscription())?.unsubscribe();
              await reg.unregister();
            }
          }
        await subscribe(epoch, true);
      });
    await pending;
  },
  async logout() {
    ++generation;
    userId = undefined;
    localStorage.removeItem('lody:push-user');
    const id = installationId();
    const current = port;
    localStorage.removeItem(installationKey);
    const localCleanup = async () => {
      if (isNativeAppShell()) await window.__LODY_PUSH__?.unregister();
      else {
        const reg = await navigator.serviceWorker.getRegistration('/push/lody/');
        reg?.active?.postMessage({ type: 'account', userId: null });
        await (await reg?.pushManager.getSubscription())?.unsubscribe();
        for (const notification of (await reg?.getNotifications()) ?? []) notification.close();
      }
    };
    await Promise.allSettled([
      localCleanup(),
      writes.catch(() => {}).then(() => current?.unregister({ installationId: id })),
    ]);
  },
  User: {
    async setLanguage(value: string) {
      language = value;
      await subscribe(generation, false);
    },
    PushSubscription: {
      async optIn() {
        localStorage.setItem(enabledKey, 'true');
        await subscribe(generation, true);
      },
      async optOut() {
        localStorage.setItem(enabledKey, 'false');
        ++generation;
        const id = installationId();
        const current = port;
        await Promise.allSettled([
          writes.catch(() => {}).then(() => current?.unregister({ installationId: id })),
          (async () => {
            if (isNativeAppShell()) await window.__LODY_PUSH__?.unregister();
            else {
              const reg = await navigator.serviceWorker.getRegistration('/push/lody/');
              reg?.active?.postMessage({ type: 'account', userId: null });
              await (await reg?.pushManager.getSubscription())?.unsubscribe();
              for (const notification of (await reg?.getNotifications()) ?? []) notification.close();
            }
          })(),
        ]);
      },
      async getOptedIn() {
        if (!enabled()) return false;
        if (isNativeAppShell()) return (await window.__LODY_PUSH__?.permission()) === 'granted';
        const reg = await navigator.serviceWorker.getRegistration('/push/lody/');
        return Boolean(await reg?.pushManager.getSubscription());
      },
    },
  },
  Notifications: {
    async requestPermission(_fallback?: boolean) {
      return isNativeAppShell()
        ? (await window.__LODY_PUSH__?.requestPermission()) === true
        : (await Notification.requestPermission()) === 'granted';
    },
    async getPermissionState(): Promise<NotificationPermission> {
      return isNativeAppShell()
        ? ((await window.__LODY_PUSH__?.permission()) ?? 'default')
        : Notification.permission;
    },
  },
};
export type PushClient = typeof client;
export async function initPush(): Promise<PushClient | null> {
  return isPushSupported() ? client : null;
}
export async function getPushPermissionState(value: PushClient) {
  return value.Notifications.getPermissionState();
}
export async function getPushSubscriptionOptedIn(value: PushClient) {
  return value.User.PushSubscription.getOptedIn();
}
export async function withPush(task: (value: PushClient) => void | Promise<void>) {
  const value = await initPush();
  if (value) await task(value);
}
export function schedulePushTask(
  task: (value: PushClient, signal: AbortSignal) => void | Promise<void>,
  timeoutMs = 2000
) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    void withPush((value) => {
      if (!controller.signal.aborted) return task(value, controller.signal);
    }).catch(() => console.error('Push setup failed'));
  }, timeoutMs);
  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}

export async function logoutPush() {
  if (!port || !userId) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.logout(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
