import { describe, expect, it } from 'vitest';
import { IosSimulatorDeviceControlSchema } from '@lody/shared';
import { createSimulatorDeviceControls } from './device-controls';

describe('simulator device controls', () => {
  it('maps only typed commands to fixed device-scoped routes and commits rotation after acknowledgement', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const pasted: string[] = [];
    let fail = false;
    const controller = createSimulatorDeviceControls({
      udid: 'test-device',
      port: 1234,
      signal: new AbortController().signal,
      active: () => true,
      hostControl: async (control) => {
        if (control.kind === 'text') pasted.push(control.text);
      },
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        });
        expect(init?.redirect).toBe('error');
        return new Response(
          JSON.stringify(
            fail
              ? { ok: false }
              : String(url).endsWith('/interface')
                ? { appearance: 'dark' }
                : { ok: true }
          )
        );
      },
    });
    await controller.execute({ kind: 'button', button: 'home' });
    await controller.execute({ kind: 'rotate', direction: 'left' });
    expect(controller.rotation()).toBe(270);
    fail = true;
    await expect(controller.execute({ kind: 'rotate', direction: 'right' })).rejects.toThrow();
    expect(controller.rotation()).toBe(270);
    fail = false;
    await controller.execute({ kind: 'rotate', direction: 'right' });
    expect(controller.rotation()).toBe(0);
    await controller.execute({ kind: 'appearance', appearance: 'dark' });
    await controller.execute({ kind: 'open-url', url: 'demo://route?token=synthetic' });
    await controller.execute({ kind: 'shake' });
    await controller.execute({ kind: 'text', text: '你好 🌏' });
    expect(pasted).toEqual(['你好 🌏']);
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:1234/simulators/test-device/input',
        body: { type: 'button', button: 'home', duration: 0 },
      },
      {
        url: 'http://127.0.0.1:1234/simulators/test-device/orientation?value=landscape-right',
        body: null,
      },
      {
        url: 'http://127.0.0.1:1234/simulators/test-device/orientation?value=portrait',
        body: null,
      },
      {
        url: 'http://127.0.0.1:1234/simulators/test-device/orientation?value=portrait',
        body: null,
      },
      {
        url: 'http://127.0.0.1:1234/simulators/test-device/input',
        body: { type: 'key', code: 'KeyV', modifiers: ['command'], duration: 0 },
      },
    ]);
  });

  it('reestablishes acknowledged portrait when a new operation inherits a rotated device', async () => {
    let nativeOrientation = 'landscape-left';
    let rejectReset = false;
    const options = {
      udid: 'device',
      port: 1234,
      signal: new AbortController().signal,
      active: () => true,
      hostControl: async () => {},
      fetch: async (url: Parameters<typeof fetch>[0]) => {
        if (rejectReset) return new Response('{"ok":false}');
        nativeOrientation = new URL(String(url)).searchParams.get('value') ?? '';
        return new Response('{"ok":true}');
      },
    };
    const first = createSimulatorDeviceControls(options);
    await first.initialize();
    expect(nativeOrientation).toBe('portrait');
    await first.execute({ kind: 'rotate', direction: 'right' });
    expect(nativeOrientation).toBe('landscape-left');
    const replacement = createSimulatorDeviceControls(options);
    rejectReset = true;
    await expect(replacement.initialize()).rejects.toThrow();
    expect(nativeOrientation).toBe('landscape-left');
    rejectReset = false;
    await replacement.initialize();
    expect(nativeOrientation).toBe('portrait');
    expect(replacement.rotation()).toBe(0);
    await replacement.execute({ kind: 'rotate', direction: 'left' });
    expect(nativeOrientation).toBe('landscape-right');
  });

  it('prepares the device software keyboard before establishing a preview baseline', async () => {
    let keyboardReady = false;
    const controls = createSimulatorDeviceControls({
      udid: 'device',
      port: 1234,
      softwareKeyboard: true,
      signal: new AbortController().signal,
      active: () => true,
      hostControl: async (control) => {
        expect(control).toEqual({ kind: 'prepare-keyboard' });
        keyboardReady = true;
      },
      fetch: async () => {
        expect(keyboardReady).toBe(true);
        return new Response('{"ok":true}');
      },
    });
    await controls.initialize();
    expect(controls.rotation()).toBe(0);
  });

  it('rejects revoked ownership, bad acknowledgements and oversized native responses', async () => {
    let active = false;
    const calls: string[] = [];
    const controller = createSimulatorDeviceControls({
      udid: 'device',
      port: 1234,
      signal: new AbortController().signal,
      active: () => active,
      hostControl: async () => {
        throw Error('not used');
      },
      fetch: async (url) => {
        calls.push(String(url));
        return new Response('x'.repeat(65537));
      },
    });
    await expect(controller.execute({ kind: 'button', button: 'home' })).rejects.toThrow();
    expect(calls).toEqual([]);
    active = true;
    await expect(controller.execute({ kind: 'button', button: 'home' })).rejects.toThrow(
      'too large'
    );
  });

  it('never presses paste after a failed clipboard write or revoked ownership', async () => {
    let active = true;
    let rejectWrite = true;
    const calls: unknown[] = [];
    const controller = createSimulatorDeviceControls({
      udid: 'device',
      port: 1234,
      signal: new AbortController().signal,
      active: () => active,
      hostControl: async () => {
        if (rejectWrite) throw Error('write failed');
        active = false;
      },
      fetch: async (url) => {
        calls.push(url);
        return new Response('{"ok":true}');
      },
    });
    await expect(controller.execute({ kind: 'text', text: 'secret' })).rejects.toThrow();
    rejectWrite = false;
    await expect(controller.execute({ kind: 'text', text: 'secret' })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('rejects arbitrary routes, unsupported actions and non-navigation URLs at the boundary', () => {
    for (const input of [
      { kind: 'button', button: 'home', udid: 'other' },
      { kind: 'install', path: '/tmp/test.app' },
      { kind: 'text', text: 'x'.repeat(16001) },
      ...[
        'javascript:alert(1)',
        'vbscript:msgbox(1)',
        'file:///etc/passwd',
        'data:text/html,test',
        'https://test.invalid/\nsecret',
      ].map((url) => ({ kind: 'open-url', url })),
    ])
      expect(IosSimulatorDeviceControlSchema.safeParse(input).success).toBe(false);
    expect(
      IosSimulatorDeviceControlSchema.parse({ kind: 'open-url', url: 'myapp://settings' })
    ).toEqual({ kind: 'open-url', url: 'myapp://settings' });
  });
});
