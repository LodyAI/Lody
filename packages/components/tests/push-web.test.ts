import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/native-platform', () => ({ isNativeAppShell: () => false }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('deferred Web Push', () => {
  it('does not register a worker or request permission even with browser support and VAPID configured', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_PUSH_VAPID_PUBLIC_KEY', 'test-public-key');
    const requestPermission = vi.fn();
    const register = vi.fn();
    vi.stubGlobal('window', {
      isSecureContext: true,
      Notification: function () {},
      PushManager: function () {},
    });
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission });
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    const push = await import('../src/lib/push-notifications');
    expect(await push.initPush()).toBeNull();
    const setup = vi.fn();
    await push.withPush(setup);
    expect(setup).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
