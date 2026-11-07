import { afterEach, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  login: vi.fn(async () => {}),
  User: {
    setLanguage: vi.fn(async () => {}),
    PushSubscription: { optIn: vi.fn(async () => {}), optOut: vi.fn(async () => {}) },
  },
}));
vi.mock('../src/lib/native-platform', () => ({ isNativeAppShell: () => false }));
vi.mock('../src/lib/onesignal', () => ({
  initOneSignal: async () => sdk,
  isOneSignalSupported: () => true,
  getOneSignalPermissionState: async () => 'granted',
  getOneSignalPushSubscriptionOptedIn: async () => true,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([undefined, 'false'])(
  'preserves an existing OneSignal Web subscription unless explicitly disabled (%s)',
  async (preference) => {
    vi.resetModules();
    const values = new Map<string, string>();
    if (preference) values.set('lody:push-enabled', preference);
    vi.stubGlobal('localStorage', {
      removeItem: (key: string) => values.delete(key),
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    vi.stubGlobal('window', {});
    const { initPush } = await import('../src/lib/push-notifications');
    await (await initPush())!.login('alice');
    expect(sdk.login).toHaveBeenCalledWith('lody-push-v2:alice');
    expect(sdk.User.PushSubscription.optOut).toHaveBeenCalledTimes(preference === 'false' ? 1 : 0);
    expect(sdk.User.PushSubscription.optIn).toHaveBeenCalledTimes(preference === 'false' ? 0 : 1);
  }
);
