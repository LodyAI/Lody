// @vitest-environment jsdom

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { frameSteps, MotionGlobalConfig } from 'framer-motion';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileConnectionStatus } from '../src/components/mobile/mobile-connection-status';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type Props = ComponentProps<typeof MobileConnectionStatus>;
const labels = {
  loading: 'Connecting',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
  recovered: 'Recovered',
  refreshing: 'Refreshing',
};
let container: HTMLDivElement;
let root: Root;
let previousSkip: boolean | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  previousSkip = MotionGlobalConfig.skipAnimations;
  MotionGlobalConfig.skipAnimations = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  MotionGlobalConfig.skipAnimations = previousSkip;
  vi.useRealTimers();
});

async function render(props: Props) {
  await act(async () => root.render(<MobileConnectionStatus labels={labels} {...props} />));
  await flushMotion();
}

async function flushMotion() {
  // Flush real Motion work without moving the recovery clock.
  for (let frame = 0; frame < 3; frame++) {
    await act(async () => {
      for (const step of Object.values(frameSteps)) {
        step.process({ delta: 16, timestamp: performance.now(), isProcessing: true });
      }
    });
  }
}

async function advance(milliseconds: number) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
  await flushMotion();
}

function status() {
  return container.querySelector('[role="status"]')!;
}

describe('mobile connection status', () => {
  it('shows a recovery only after reconnecting, for the complete recovery interval', async () => {
    await render({ state: 'online' });
    expect(status().textContent).toBe('');
    await render({ state: 'reconnecting' });
    expect(status().textContent).toBe('Reconnecting');
    await render({ state: 'online' });
    expect(status().textContent).toBe('Recovered');
    await advance(1199);
    expect(status().textContent).toBe('Recovered');
    expect(getComputedStyle(status().firstElementChild!).opacity).toBe('1');
    await advance(1);
    // AnimatePresence may retain the exiting subtree after it becomes invisible.
    expect(getComputedStyle(status().firstElementChild!).opacity).toBe('0');
  });

  it('cancels an old recovery without hiding a new offline status', async () => {
    await render({ state: 'reconnecting' });
    await render({ state: 'online' });
    await advance(600);
    await render({ state: 'offline' });
    expect(status().textContent).toBe('Offline');
    await advance(1200);
    expect(status().textContent).toBe('Offline');
  });

  it('prioritizes the physical pull over refresh and connection, without announcing its hint', async () => {
    await render({
      state: 'offline',
      refreshing: true,
      pull: { active: true, pastThreshold: false, label: 'Pull to refresh' },
    });
    expect(status().textContent).toBe('Pull to refresh');
    expect(status().querySelector('[aria-hidden="true"]')?.textContent).toBe('Pull to refresh');
    await render({
      state: 'offline',
      refreshing: true,
      pull: { active: true, pastThreshold: true, label: 'Release to refresh' },
    });
    expect(status().textContent).toBe('Release to refresh');
    await render({ state: 'offline', refreshing: true });
    expect(status().textContent).toBe('Refreshing');
    expect(status().querySelector('[data-slot="spinner"]')).not.toBeNull();
    await render({ state: 'offline' });
    expect(status().textContent).toBe('Offline');
  });
});
