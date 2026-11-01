import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/native-platform', () => ({ isNativeAppShell: () => false }));
const key = new Uint8Array(65);
key[0] = 4;
const publicKey = Buffer.from(key).toString('base64url');
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function setup(permission = 'granted') {
  vi.resetModules();
  vi.stubEnv('VITE_PUSH_VAPID_PUBLIC_KEY', publicKey);
  vi.stubGlobal('location', { origin: 'https://lody.test' });
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  const events = new EventTarget();
  vi.stubGlobal(
    'window',
    Object.assign(events, {
      isSecureContext: true,
      Notification: function () {},
      PushManager: function () {},
    })
  );
  const requestPermission = vi.fn(async () => 'granted');
  vi.stubGlobal('Notification', { permission, requestPermission });
  let subscription: any = null;
  let number = 0;
  const bindings: Array<string | null> = [];
  const uploaded = new Map<string, any>();
  const subscribed = vi.fn(async (options: { applicationServerKey: Uint8Array }) => {
    subscription = {
      endpoint: `https://fcm.googleapis.com/send/${++number}`,
      options: { applicationServerKey: options.applicationServerKey.buffer },
      toJSON: () => ({ keys: { p256dh: 'public', auth: 'secret' } }),
      unsubscribe: async () => {
        subscription = null;
        return true;
      },
    };
    return subscription;
  });
  const notifications = [{ close: vi.fn() }];
  const reg = {
    scope: 'https://lody.test/push/lody/',
    active: {
      postMessage: (data: any, ports: MessagePort[]) => {
        bindings.push(data.userId);
        ports[0]!.postMessage({ ok: true });
      },
    },
    pushManager: { getSubscription: async () => subscription, subscribe: subscribed },
    getNotifications: async () => notifications,
  };
  const legacy = {
    scope: 'https://lody.test/push/onesignal/',
    pushManager: { getSubscription: async () => ({ unsubscribe: vi.fn(async () => true) }) },
    unregister: vi.fn(async () => true),
  };
  const unrelated = { scope: 'https://lody.test/other/', unregister: vi.fn() };
  let queue: Promise<unknown> = Promise.resolve();
  const serviceWorker = Object.assign(new EventTarget(), {
    register: vi.fn(async () => reg),
    getRegistration: async () => reg,
    getRegistrations: async () => [reg, legacy, unrelated],
  });
  vi.stubGlobal('navigator', {
    serviceWorker,
    locks: {
      request: (_name: string, task: () => Promise<unknown>) => {
        const result = queue.catch(() => {}).then(task);
        queue = result;
        return result;
      },
    },
  });
  const push = await import('../src/lib/push-notifications');
  const remove = push.installPushPort({
    register: async (input) => {
      uploaded.set(input.installationId, input);
    },
    unregister: async ({ installationId }) => {
      uploaded.delete(installationId);
    },
  });
  const client = (await push.initPush())!;
  return {
    push,
    client,
    remove,
    storage,
    uploaded,
    bindings,
    reg,
    subscribed,
    requestPermission,
    serviceWorker,
    legacy,
    unrelated,
    notifications,
    subscription: () => subscription,
  };
}
describe('Web Push lifecycle', () => {
  it('requires HTTPS, VAPID and browser support; never enables Electron', async () => {
    const t = await setup();
    expect(t.push.isPushSupported()).toBe(true);
    vi.stubEnv('VITE_PUSH_VAPID_PUBLIC_KEY', '');
    expect(t.push.isPushSupported()).toBe(false);
    vi.stubEnv('VITE_PUSH_VAPID_PUBLIC_KEY', publicKey);
    window.isSecureContext = false;
    expect(t.push.isPushSupported()).toBe(false);
    window.isSecureContext = true;
    window.__LODY_ELECTRON__ = true;
    expect(t.push.isPushSupported()).toBe(false);
    t.remove();
  });
  it('does not ask permission or subscribe on login before explicit opt-in; retires only the vendor scope', async () => {
    const t = await setup();
    await t.client.login('alice');
    expect(t.uploaded.size).toBe(0);
    expect(t.subscription()).toBeNull();
    expect(t.requestPermission).not.toHaveBeenCalled();
    expect(t.legacy.unregister).toHaveBeenCalledOnce();
    expect(t.unrelated.unregister).not.toHaveBeenCalled();
    await t.client.User.PushSubscription.optIn();
    expect([...t.uploaded.values()][0]).toMatchObject({
      platform: 'web',
      token: 'https://fcm.googleapis.com/send/1',
      p256dh: 'public',
      auth: 'secret',
    });
    expect(t.bindings.at(-1)).toBe('alice');
    expect(await t.client.User.PushSubscription.getOptedIn()).toBe(true);
    await t.client.logout();
    expect(t.uploaded.size).toBe(0);
    expect(t.subscription()).toBeNull();
    expect(t.bindings.at(-1)).toBeNull();
    expect(t.notifications[0]!.close).toHaveBeenCalled();
    t.remove();
  });
  it('reuses the subscription on account switch and renews after a VAPID key change', async () => {
    const t = await setup();
    await t.client.login('alice');
    await t.client.User.PushSubscription.optIn();
    await t.client.login('bob');
    expect(t.subscribed).toHaveBeenCalledTimes(1);
    expect(t.bindings.at(-1)).toBe('bob');
    const next = key.slice();
    next[1] = 2;
    vi.stubEnv('VITE_PUSH_VAPID_PUBLIC_KEY', Buffer.from(next).toString('base64url'));
    await t.client.User.PushSubscription.optIn();
    expect([...t.uploaded.values()][0].token).toBe('https://fcm.googleapis.com/send/2');
    expect(t.bindings.at(-1)).toBe('bob');
    t.remove();
  });
  it('does not resurrect a subscription when opt-out races an in-flight subscribe', async () => {
    const t = await setup();
    await t.client.login('alice');
    const entered = deferred();
    const release = deferred();
    const create = t.subscribed.getMockImplementation()!;
    t.subscribed.mockImplementationOnce(async (options) => {
      entered.resolve();
      await release.promise;
      return create(options);
    });
    const subscribing = t.client.User.PushSubscription.optIn();
    await entered.promise;
    const revoked = deferred();
    const post = t.reg.active.postMessage;
    t.reg.active.postMessage = (data, ports) => {
      post(data, ports);
      if (data.userId === null) revoked.resolve();
    };
    const stopping = t.client.User.PushSubscription.optOut();
    await revoked.promise; // revocation must not wait for the held Web Lock
    expect(t.bindings.at(-1)).toBeNull();
    release.resolve();
    await Promise.all([subscribing, stopping]);
    expect(t.uploaded.size).toBe(0);
    expect(t.subscription()).toBeNull();
    expect(t.bindings.at(-1)).toBeNull();
    t.remove();
  });
  it('prevents stale tabs from registering for the previous account', async () => {
    const t = await setup();
    await t.client.login('alice');
    await t.client.User.PushSubscription.optIn();
    t.storage.set('lody:push-user', 'bob');
    t.uploaded.clear();
    await t.client.User.setLanguage('zh');
    expect(t.uploaded.size).toBe(0);
    t.remove();
  });
  it('clears persistent browser state on logout before push login after a reload', async () => {
    const t = await setup();
    await t.client.login('alice');
    await t.client.User.PushSubscription.optIn();
    t.remove(); // equivalent to the new document having no in-memory port or user
    await t.push.logoutPush();
    expect(t.subscription()).toBeNull();
    expect(t.bindings.at(-1)).toBeNull();
    expect(t.storage.has('lody:push-user')).toBe(false);
  });
  it('recreates a missing subscription on focus for an opted-in account', async () => {
    const t = await setup();
    await t.client.login('alice');
    await t.client.User.PushSubscription.optIn();
    await t.subscription().unsubscribe();
    const restored = deferred();
    const post = t.reg.active.postMessage;
    t.reg.active.postMessage = (data, ports) => {
      post(data, ports);
      if (data.userId === 'alice') restored.resolve();
    };
    window.dispatchEvent(new Event('focus'));
    await restored.promise;
    expect([...t.uploaded.values()][0].token).toBe('https://fcm.googleapis.com/send/2');
    t.remove();
  });
  it('renews a VAPID key through the refresh event path', async () => {
    const t = await setup();
    await t.client.login('alice');
    await t.client.User.PushSubscription.optIn();
    const next = key.slice();
    next[1] = 3;
    vi.stubEnv('VITE_PUSH_VAPID_PUBLIC_KEY', Buffer.from(next).toString('base64url'));
    const restored = deferred();
    const post = t.reg.active.postMessage;
    t.reg.active.postMessage = (data, ports) => {
      post(data, ports);
      if (data.userId === 'alice') restored.resolve();
    };
    window.dispatchEvent(new Event('focus'));
    await restored.promise;
    expect([...t.uploaded.values()][0].token).toBe('https://fcm.googleapis.com/send/2');
    t.remove();
  });
  it('reconciles a subscription-change message from the dedicated worker', async () => {
    const t = await setup();
    await t.client.login('alice');
    await t.client.User.PushSubscription.optIn();
    await t.subscription().unsubscribe();
    const restored = deferred();
    const post = t.reg.active.postMessage;
    t.reg.active.postMessage = (data, ports) => {
      post(data, ports);
      if (data.userId === 'alice') restored.resolve();
    };
    const event = Object.assign(new Event('message'), {
      data: { type: 'lody:push-subscription-changed' },
      source: { scriptURL: 'https://lody.test/push/lody/worker.js' },
    });
    t.serviceWorker.dispatchEvent(event);
    await restored.promise;
    expect([...t.uploaded.values()][0].token).toBe('https://fcm.googleapis.com/send/2');
    t.remove();
  });
  it('does not subscribe when permission was denied', async () => {
    const t = await setup('denied');
    await t.client.login('alice');
    await t.client.User.PushSubscription.optIn();
    expect(t.subscription()).toBeNull();
    expect(t.uploaded.size).toBe(0);
    expect(await t.client.User.PushSubscription.getOptedIn()).toBe(false);
    t.remove();
  });
});
