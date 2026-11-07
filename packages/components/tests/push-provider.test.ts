import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/lib/native-platform', () => ({
  isNativeAppShell: () => true,
  isNativeIOSAppShell: () => false,
}));
vi.mock('../src/lib/deferred-posthog', () => ({ deferredPostHog: {} }));
vi.mock('../src/lib/posthog-analytics', () => ({ capturePostHogEvent: () => {} }));
vi.mock('@lody/shared', () => ({ hashAnalyticsId: (value: string) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function setup() {
  vi.resetModules();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  });
  vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'app');
  let owner: string | undefined;
  let optedIn = false;
  let direct = false;
  const sdk = {
    initialize() {},
    login(id: string) {
      owner = id;
    },
    logout() {
      owner = undefined;
    },
    User: {
      setLanguage() {},
      pushSubscription: {
        optIn() {
          optedIn = true;
        },
        optOut() {
          optedIn = false;
        },
        getOptedInAsync: async () => optedIn,
      },
    },
    Notifications: {
      requestPermission: async () => true,
      permissionNative: async () => 2,
      addEventListener() {},
    },
  };
  vi.stubGlobal('window', {
    plugins: { OneSignal: sdk },
    __LODY_CORDOVA_READY__: true,
    __LODY_PUSH__: {
      permission: async () => 'granted',
      register: async () => {
        direct = true;
      },
      unregister: async () => {
        direct = false;
      },
    },
  });
  const module = await import('../src/lib/push-notifications');
  module.installPushPort({ register: async () => {}, unregister: async () => {} });
  return { module, sdk, bridge: window.__LODY_PUSH__!, state: () => ({ owner, optedIn, direct }) };
}
it('registers the authenticated native account with OneSignal by default and revokes it at logout', async () => {
  const t = await setup();
  const client = (await t.module.initPush())!;
  await client.login('alice');
  await client.User.PushSubscription.optIn();
  expect(t.state()).toEqual({ owner: 'lody-push-v2:alice', optedIn: true, direct: false });
  await client.login('bob');
  expect(t.state().owner).toBe('lody-push-v2:bob');
  await t.module.logoutPush();
  expect(t.state()).toEqual({ owner: undefined, optedIn: false, direct: false });
});
it('does not revive a deferred OneSignal login after logout', async () => {
  vi.useFakeTimers();
  try {
    const t = await setup();
    t.module.schedulePushTask((client) => client.login('alice'), 1000);
    await t.module.logoutPush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.state().owner).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it.each([true, false])(
  'disabling notifications revokes both providers across a mode switch (direct first: %s)',
  async (first) => {
    const t = await setup();
    const port = { register: async () => {}, unregister: vi.fn(async () => {}) };
    for (const selfHostedEnabled of [first, !first]) {
      t.module.installPushPort({ ...port, selfHostedEnabled });
      const client = (await t.module.initPush())!;
      await client.login('alice');
      await client.User.PushSubscription.optIn();
    }
    const client = (await t.module.initPush())!;
    await client.User.PushSubscription.optOut();
    expect(t.state()).toMatchObject({ optedIn: false, direct: false });
    expect(port.unregister).toHaveBeenCalled();
  }
);

it('retires the previous OneSignal identity when another account logs into direct mode', async () => {
  const t = await setup();
  await (await t.module.initPush())!.login('alice');
  t.module.installPushPort({
    selfHostedEnabled: true,
    register: async () => {},
    unregister: async () => {},
  });
  await (await t.module.initPush())!.login('bob');
  expect(t.state()).toEqual({ owner: undefined, optedIn: false, direct: true });
});

it('waits for a pending native unregister before enabling OneSignal again', async () => {
  const t = await setup();
  const client = (await t.module.initPush())!;
  await client.login('alice');
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  t.bridge.unregister = async () => {
    started();
    await pending;
  };
  let sdkDisabled!: () => void;
  const optedOut = new Promise<void>((resolve) => {
    sdkDisabled = resolve;
  });
  const originalOptOut = t.sdk.User.pushSubscription.optOut;
  t.sdk.User.pushSubscription.optOut = () => {
    originalOptOut();
    sdkDisabled();
  };
  const disabled = client.User.PushSubscription.optOut();
  await Promise.all([entered, optedOut]);
  const enabled = client.User.PushSubscription.optIn();
  expect(t.state().optedIn).toBe(false);
  release();
  await Promise.all([disabled, enabled]);
  expect(t.state().optedIn).toBe(true);
});
