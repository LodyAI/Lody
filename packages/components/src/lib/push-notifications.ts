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
let registeredGeneration: number | undefined;
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
  const refresh = () => {
    void subscribe(generation, true).catch(() => console.error('Push refresh failed'));
  };
  const changed = (event: MessageEvent) => {
    if (
      event.data?.type === 'lody:push-subscription-changed' &&
      (event.source as ServiceWorker | null)?.scriptURL ===
        new URL('/push/lody/worker.js', location.origin).href
    )
      refresh();
  };
  const web = !isNativeAppShell() && isPushSupported();
  if (web) {
    window.addEventListener('focus', refresh);
    navigator.serviceWorker.addEventListener('message', changed);
  }
  return () => {
    if (web) {
      window.removeEventListener('focus', refresh);
      navigator.serviceWorker.removeEventListener('message', changed);
    }
    if (port === value) {
      port = undefined;
      userId = undefined;
      generation++;
    }
  };
}
function enabled() {
  return isNativeAppShell()
    ? localStorage.getItem(enabledKey) !== 'false'
    : localStorage.getItem(enabledKey) === 'true';
}
async function webLock<T>(task: () => Promise<T>): Promise<T> {
  return await navigator.locks.request('lody:push', task);
}
function currentWebAccount(epoch: number) {
  return (
    epoch === generation && Boolean(userId) && localStorage.getItem('lody:push-user') === userId
  );
}
function accountMessage(reg: ServiceWorkerRegistration, id: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!reg.active) return reject(new Error('Push worker unavailable'));
    const channel = new MessageChannel();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Push worker account update timed out')), 5000);
    channel.port1.onmessage = (event) =>
      finish(event.data?.ok === true ? undefined : new Error('Push worker account update failed'));
    reg.active.postMessage({ type: 'account', userId: id }, [channel.port2]);
  });
}
async function revokeWebAccount(stillDisabled: () => boolean) {
  const reg = await navigator.serviceWorker.getRegistration('/push/lody/');
  if (reg?.active && new URL(reg.scope).pathname === '/push/lody/' && stillDisabled())
    await accountMessage(reg, null);
}
async function clearWebSubscription() {
  const reg = await navigator.serviceWorker.getRegistration('/push/lody/');
  if (!reg || new URL(reg.scope).pathname !== '/push/lody/') return;
  // Clear display authorization before removing the remote subscription.
  try {
    await accountMessage(reg, null);
  } finally {
    await (await reg.pushManager.getSubscription())?.unsubscribe();
    for (const notification of await reg.getNotifications()) notification.close();
  }
}
function vapidKey(): Uint8Array<ArrayBuffer> {
  const value = import.meta.env.VITE_PUSH_VAPID_PUBLIC_KEY;
  const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const key = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  if (key.length !== 65 || key[0] !== 4) throw new Error('Invalid Web Push public key');
  return key;
}

async function save(input: Omit<PushRegistration, 'installationId' | 'language'>, epoch: number) {
  const current = port;
  const id = installationId();
  const write = writes
    .catch(() => {})
    .then(async () => {
      if (!current || !userId || epoch !== generation || !enabled()) return;
      if (!isNativeAppShell() && !currentWebAccount(epoch)) return;
      await current.register({ ...input, installationId: id, language });
      if (epoch === generation && enabled()) registeredGeneration = epoch;
    });
  writes = write;
  await write;
}

async function subscribe(epoch: number, create: boolean) {
  if (!port || !userId) return;
  if (isNativeAppShell()) {
    const bridge = window.__LODY_PUSH__;
    if (!enabled() || !bridge || (await bridge.permission()) !== 'granted' || epoch !== generation)
      return;
    await bridge.register((input) => save(input, epoch));
    return;
  }
  await webLock(async () => {
    if (!currentWebAccount(epoch)) return;
    const registration = await navigator.serviceWorker.register('/push/lody/worker.js', {
      scope: '/push/lody/',
      updateViaCache: 'none',
    });
    // Wait for this exact registration, not navigator.serviceWorker.ready (the
    // page is deliberately outside our dedicated worker scope).
    if (!registration.active)
      await new Promise<void>((resolve, reject) => {
        const installing = registration.installing ?? registration.waiting;
        if (!installing) return reject(new Error('Push worker unavailable'));
        const timer = setTimeout(() => {
          installing.removeEventListener('statechange', changed);
          reject(new Error('Push worker activation timed out'));
        }, 10000);
        const changed = () => {
          if (installing.state === 'activated') {
            clearTimeout(timer);
            installing.removeEventListener('statechange', changed);
            resolve();
          }
          if (installing.state === 'redundant') {
            clearTimeout(timer);
            installing.removeEventListener('statechange', changed);
            reject(new Error('Push worker failed'));
          }
        };
        installing.addEventListener('statechange', changed);
        changed();
      });
    if (!currentWebAccount(epoch)) return;
    // Bind even with permission disabled, so an account switch cannot leave the old recipient active.
    await accountMessage(registration, null);
    if (!enabled() || Notification.permission !== 'granted') return;
    let subscription = await registration.pushManager.getSubscription();
    const key = vapidKey();
    const previousKey = subscription?.options.applicationServerKey;
    if (subscription && (!previousKey || !equalKey(new Uint8Array(previousKey), key))) {
      if (!create) return;
      await subscription.unsubscribe();
      subscription = null;
    }
    if (!currentWebAccount(epoch) || !enabled()) return;
    if (!subscription && create)
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
    if (!subscription || !currentWebAccount(epoch) || !enabled()) return;
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
    if (currentWebAccount(epoch) && enabled()) await accountMessage(registration, userId!);
  });
}
function equalKey(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function isPushSupported(): boolean {
  if (typeof window === 'undefined' || window.__LODY_ELECTRON__ === true) return false;
  if (isNativeAppShell()) return Boolean(window.__LODY_PUSH__);
  return Boolean(
    window.isSecureContext &&
    'Notification' in window &&
    'PushManager' in window &&
    'serviceWorker' in navigator &&
    navigator.locks &&
    import.meta.env.VITE_PUSH_VAPID_PUBLIC_KEY
  );
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
          await webLock(async () => {
            if (!currentWebAccount(epoch)) return;
            for (const reg of await navigator.serviceWorker.getRegistrations()) {
              if (new URL(reg.scope).pathname === '/push/onesignal/') {
                await (await reg.pushManager.getSubscription())?.unsubscribe();
                await reg.unregister();
              }
            }
          });
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
        // Revoke display permission without waiting behind a browser network operation.
        await revokeWebAccount(() => !localStorage.getItem('lody:push-user')).catch(() => {});
        await webLock(async () => {
          // A newer login owns the origin now. Never tear down its subscription.
          if (localStorage.getItem('lody:push-user')) return;
          await clearWebSubscription();
        });
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
              await revokeWebAccount(() => !enabled()).catch(() => {});
              await webLock(async () => {
                if (enabled()) return;
                await clearWebSubscription();
              });
            }
          })(),
        ]);
      },
      async getOptedIn() {
        if (!enabled() || registeredGeneration !== generation) return false;
        if (isNativeAppShell()) return (await window.__LODY_PUSH__?.permission()) === 'granted';
        const reg = await navigator.serviceWorker.getRegistration('/push/lody/');
        return (
          Notification.permission === 'granted' && Boolean(await reg?.pushManager.getSubscription())
        );
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
  const scheduledGeneration = generation;
  const timer = setTimeout(() => {
    void withPush((value) => {
      if (!controller.signal.aborted && scheduledGeneration === generation)
        return task(value, controller.signal);
    }).catch(() => console.error('Push setup failed'));
  }, timeoutMs);
  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}

export async function logoutPush() {
  // Persistent OS/browser registrations outlive the delayed in-memory login.
  // Local revocation must also run when no authenticated port was mounted.
  if (typeof window === 'undefined') return;
  if (
    !isNativeAppShell() &&
    (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !navigator.locks)
  )
    return;
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
