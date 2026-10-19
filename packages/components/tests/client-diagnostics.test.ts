// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectClientDiagnostics, parseClientUserAgent } from '../src/lib/client-diagnostics';
import { readClientLog } from '../src/lib/client-log';
vi.mock('../src/lib/client-log', async (original) => ({
  ...(await original<typeof import('../src/lib/client-log')>()),
  readClientLog: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(readClientLog).mockResolvedValue('renderer recovery event');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete window.__LODY_APP_INFO__;
  delete window.__LODY_PLATFORM__;
  delete window.__LODY_NATIVE__;
  delete window.__LODY_ELECTRON__;
  delete (navigator as Navigator & { userAgentData?: unknown }).userAgentData;
});

describe('reporting client environment and existing renderer log', () => {
  it('attaches a bounded tail from the existing durable logger and uses its redaction', async () => {
    vi.mocked(readClientLog).mockResolvedValue(
      'old-event' + 'x'.repeat(26000) + 'recovery-event token=private-value'
    );
    const result = await collectClientDiagnostics();
    expect(result).toContain('recovery-event');
    expect(result).not.toContain('old-event');
    expect(result).not.toContain('private-value');
    expect(result).toContain('[redacted]');
    expect(result.length).toBeLessThan(64000);
  });

  it('still includes the environment when the existing log read fails or hangs', async () => {
    vi.mocked(readClientLog).mockRejectedValueOnce(new Error('storage unavailable'));
    expect(await collectClientDiagnostics()).toContain('renderer log unavailable');
    vi.useFakeTimers();
    vi.mocked(readClientLog).mockImplementationOnce(() => new Promise(() => {}));
    const pending = collectClientDiagnostics();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toContain('renderer log read timed out');
  });

  it.each([
    [
      'Mozilla/5.0 (Linux; Android 15; Xiaomi) Chrome/130.0.0.0 Mobile Safari/537.36 MiuiBrowser/18.2',
      'Mi Browser',
      'Android',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Version/18.1 Mobile Safari/604.1',
      'Safari',
      'iOS',
    ],
    ['Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.1', 'Edge', 'Windows'],
    ['Mozilla/5.0 (Linux) Firefox/131.0', 'Firefox', 'Linux'],
  ])('identifies %s', (ua, browser, os) => {
    expect(parseClientUserAgent(ua)).toMatchObject({ browser, uaOS: os });
  });

  it('collects native version, manufacturer and OS without account, install ID or host path leakage', async () => {
    window.__LODY_NATIVE__ = true;
    window.__LODY_APP_INFO__ = {
      version: '1.2.3',
      build: '42',
      os_name: 'android',
      os_version: '15',
      manufacturer: 'Xiaomi',
      model: 'test-phone',
      webview_version: '130',
      install_id: 'private-id',
    };
    const report = await collectClientDiagnostics();
    for (const value of ['1.2.3', '42', 'android', '15', 'Xiaomi', 'test-phone'])
      expect(report).toContain(value);
    expect(report).not.toContain('private-id');
    window.__LODY_ELECTRON__ = true;
    window.__LODY_PLATFORM__ = {
      os: 'darwin',
      homeDir: '/private/home',
      machineName: 'private-host',
      osVersion: '27.0',
      electronVersion: '44.0',
      architecture: 'arm64',
    };
    const desktop = await collectClientDiagnostics();
    expect(desktop).toContain('27.0');
    expect(desktop).toContain('44.0');
    expect(desktop).not.toContain('/private/home');
    expect(desktop).not.toContain('private-host');
  });

  it('falls back when browser client hints reject and collects supported hints', async () => {
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      value: {
        getHighEntropyValues: async () => {
          throw new Error('denied');
        },
      },
    });
    expect(await collectClientDiagnostics()).toContain(navigator.userAgent);
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      value: {
        platform: 'Windows',
        getHighEntropyValues: async () => ({
          platformVersion: '15.0.0',
          fullVersionList: [{ brand: 'Microsoft Edge', version: '130.0.1' }],
          unwanted: 'private',
        }),
      },
    });
    const report = await collectClientDiagnostics();
    expect(report).toContain('130.0.1');
    expect(report).not.toContain('unwanted');
    delete (navigator as Navigator & { userAgentData?: unknown }).userAgentData;
  });
});
