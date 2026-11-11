// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { MachineLifecycleCapability } from '@lody/shared';
import {
  MachineBatchUpdateDialog,
  type BatchUpdateMachine,
} from '../src/components/settings/machine-batch-update-dialog';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const daemon: MachineLifecycleCapability = {
  launchMode: 'daemon',
  canRemoteRestart: true,
  canRemoteUpgrade: true,
};
const studio = (isOnline: boolean, running = 1): BatchUpdateMachine => ({
  id: 'studio',
  name: 'Studio',
  isOwn: true,
  isOnline,
  cliVersion: '1.0.0',
  supportsManagedUpdates: true,
  runningSessionCount: running,
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
const button = (text: string) =>
  [...document.body.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text)
  );

describe('update-all dialog keeps per-machine progress for the whole run', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    container.remove();
  });

  const render = async (props: {
    open: boolean;
    machines: BatchUpdateMachine[];
    probe: (id: string) => Promise<{ lifecycle: MachineLifecycleCapability }>;
    requestUpgrade?: () => Promise<void>;
  }) => {
    await act(async () => {
      root.render(
        createElement(MachineBatchUpdateDialog, {
          onOpenChange: () => {},
          latestVersion: '1.1.0',
          requestUpgrade: async () => {},
          ...props,
        })
      );
    });
    await flush();
  };

  it('a machine going offline and new parent callbacks mid-run do not reset the dialog', async () => {
    await render({
      open: true,
      machines: [studio(true)],
      probe: async () => ({ lifecycle: daemon }),
    });
    await act(async () => button('Update 1 machines')?.click());
    await flush();
    expect(document.body.textContent).toContain('Waiting until no conversation is running');

    // The forced/idle switch takes the machine offline and cancels its sessions:
    // the parent rebuilds both the machine list and the probe callback.
    await render({
      open: true,
      machines: [studio(false, 0)],
      probe: async () => ({ lifecycle: daemon }),
    });
    expect(document.body.textContent).toContain('Restarting on the new version');
    expect(button('Update 1 machines')).toBeUndefined();
  });

  it('closing the dialog stops polling machines', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const probe = vi.fn(async () => ({ lifecycle: daemon }));
    await render({ open: true, machines: [studio(true)], probe });
    await act(async () => button('Update 1 machines')?.click());
    await flush();
    const beforeTick = probe.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    // While open, the accepted machine's update record is polled.
    expect(probe.mock.calls.length).toBeGreaterThan(beforeTick);
    await render({ open: false, machines: [studio(true)], probe });
    const calls = probe.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(probe.mock.calls.length).toBe(calls);
  });
  it('a machine that went offline before its request was accepted still times out', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    let accept: () => void = () => {};
    const requestUpgrade = () => new Promise<void>((resolve) => (accept = resolve));
    const probe = async () => ({ lifecycle: daemon });
    await render({ open: true, machines: [studio(true)], probe, requestUpgrade });
    await act(async () => button('Update 1 machines')?.click());
    await render({ open: true, machines: [studio(false, 0)], probe, requestUpgrade });
    await act(async () => accept());
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000 + 3_000);
    });
    expect(document.body.textContent).toContain('Not back online after 5 minutes');
  });
});
