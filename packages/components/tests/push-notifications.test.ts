import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/native-platform', () => ({ isNativeAppShell: () => true }));
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function setup() {
  vi.resetModules();
  vi.stubGlobal('localStorage', storage());
  let deliver: ((input: any) => Promise<void>) | undefined;
  let stopped = false;
  vi.stubGlobal('window', {
    __LODY_PUSH__: {
      permission: async () => 'granted',
      requestPermission: async () => true,
      register: async (fn: typeof deliver) => {
        deliver = fn;
      },
      unregister: async () => {
        stopped = true;
      },
    },
  });
  const module = await import('../src/lib/push-notifications');
  const records = new Map<string, {token: string; bundleId?: string}>();
  const remove = module.installPushPort({
    register: async (input) => {
      records.set(input.installationId, {token: input.token, bundleId: input.bundleId});
    },
    unregister: async ({ installationId }) => {
      records.delete(installationId);
    },
  });
  const client = (await module.initPush())!;
  return {
    module,
    client,
    records,
    remove,
    deliver: () => deliver!({ platform: 'ios', purpose: 'notification', token: 'token', bundleId: 'app.test' }),
    stopped: () => stopped,
  };
}
describe('push client ownership', () => {
  it('uploads native token changes and removes registrations on logout', async () => {
    const t = await setup();
    await t.client.login('alice');
    await t.deliver();
    expect([...t.records.values()]).toEqual([{token: 'token', bundleId: 'app.test'}]);
    await t.module.logoutPush();
    expect(t.records.size).toBe(0);
    expect(t.stopped()).toBe(true);
    expect(localStorage.getItem('lody:push-user')).toBeNull();
    await t.deliver();
    expect(t.records.size).toBe(0);
    t.remove();
  });
  it('does not resurrect a subscription after opt-out', async () => {
    const t = await setup();
    await t.client.login('alice');
    await t.deliver();
    await t.client.User.PushSubscription.optOut();
    await t.deliver();
    expect(t.records.size).toBe(0);
    expect(await t.client.User.PushSubscription.getOptedIn()).toBe(false);
    t.remove();
  });
  it('disposal invalidates late native callbacks', async () => {
    const t = await setup();
    await t.client.login('alice');
    t.remove();
    await t.deliver();
    expect(t.records.size).toBe(0);
  });
});
