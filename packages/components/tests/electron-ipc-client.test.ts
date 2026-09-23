// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import {
  createLodyIpcProxy,
  getIpcServices,
  getPublicBrowserBridge,
} from '../src/lib/electron-ipc-client';

afterEach(() => {
  delete window.ipc;
});

describe('renderer IPC bridge', () => {
  const invokeSnapshot = async (channel: string) => {
    if (channel !== 'localPlatform.getSnapshot') throw new Error(`Unexpected channel: ${channel}`);
    return { userId: 'local:1' };
  };

  it('returns the result from the addressed service method', async () => {
    const services = createLodyIpcProxy({ invoke: invokeSnapshot })!;
    expect(await services.localPlatform.getSnapshot()).toEqual({ userId: 'local:1' });
  });

  it('returns null when the bridge is missing', () => {
    expect(createLodyIpcProxy(null)).toBeNull();
    expect(createLodyIpcProxy(undefined)).toBeNull();
  });

  it('reads a bridge installed after module evaluation and observes its removal', async () => {
    window.ipc = { invoke: invokeSnapshot, on: () => () => {}, send: () => {} };
    expect(await getIpcServices()!.localPlatform.getSnapshot()).toEqual({ userId: 'local:1' });
    delete window.ipc;
    expect(getIpcServices()).toBeNull();
  });

  it('updates native browser tracking independently and disposes its input subscription', async () => {
    const nativeView = { browserId: 'browser-one', visible: false, trackInteraction: false };
    const listeners = new Map<string, (...args: unknown[]) => void>();
    window.ipc = {
      invoke: async (channel, raw) => {
        if (channel !== 'publicBrowser.setVisible')
          throw new Error(`Unexpected channel: ${channel}`);
        const input = raw as { browserId: string; visible: boolean; trackInteraction?: boolean };
        if (input.browserId !== nativeView.browserId) throw new Error('Unknown browser');
        Object.assign(nativeView, input);
        return { ok: true };
      },
      on: (channel, listener) => {
        listeners.set(channel, listener);
        return () => {
          listeners.delete(channel);
        };
      },
      send: () => {},
    };
    const bridge = getPublicBrowserBridge()!;
    await bridge.setVisible('browser-one', true, true);
    expect(nativeView).toEqual({ browserId: 'browser-one', visible: true, trackInteraction: true });
    await bridge.setVisible('browser-one', false);
    expect(nativeView.trackInteraction).toBe(true);
    await bridge.setVisible('browser-one', true, false);
    expect(nativeView.trackInteraction).toBe(false);

    const received: unknown[] = [];
    const stop = bridge.onInteraction((event) => received.push(event));
    listeners.get('publicBrowser.interaction')?.({ browserId: 'browser-one', source: 'pointer' });
    expect(received).toEqual([{ browserId: 'browser-one', source: 'pointer' }]);
    stop();
    listeners.get('publicBrowser.interaction')?.({ browserId: 'browser-one', source: 'keyboard' });
    expect(received).toEqual([{ browserId: 'browser-one', source: 'pointer' }]);
  });
});
