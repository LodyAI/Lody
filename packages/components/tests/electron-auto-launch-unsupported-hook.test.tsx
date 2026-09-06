// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getAutoLaunchStatus: vi.fn() }));

vi.mock('../src/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({ app: { getAutoLaunchStatus: mocks.getAutoLaunchStatus } }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useElectronAutoLaunch } from '../src/hooks/use-electron-auto-launch';

type AutoLaunchStatus = {
  supported: boolean;
  enabled: boolean;
  hideWindowOnAutoLaunch: boolean;
};

const deferredStatus = () => {
  let resolve!: (value: AutoLaunchStatus) => void;
  const promise = new Promise<AutoLaunchStatus>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const render = (isElectron: boolean): { readonly current: { unsupported: boolean } } => {
  const state = { current: { unsupported: false } };
  function Probe() {
    state.current = useElectronAutoLaunch(isElectron);
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Probe />);
  });
  return state;
};

describe('useElectronAutoLaunch unsupported flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
  });

  it('stays quiet while the initial status read is still in flight', async () => {
    const status = deferredStatus();
    mocks.getAutoLaunchStatus.mockReturnValue(status.promise);

    const state = render(true);

    // Before the main process answers there is no verdict to report. Treating "not
    // answered" as "unsupported" would flash the notice on macOS and Windows on every
    // visit to Settings.
    expect(state.current.unsupported).toBe(false);

    await act(async () => {
      status.resolve({ supported: true, enabled: false, hideWindowOnAutoLaunch: false });
      await status.promise;
    });

    expect(state.current.unsupported).toBe(false);
  });

  it('reports unsupported once the platform answers that it cannot auto-launch', async () => {
    const status = deferredStatus();
    mocks.getAutoLaunchStatus.mockReturnValue(status.promise);

    const state = render(true);

    await act(async () => {
      status.resolve({ supported: false, enabled: false, hideWindowOnAutoLaunch: false });
      await status.promise;
    });

    expect(state.current.unsupported).toBe(true);
  });

  it('stays quiet when the status read fails', async () => {
    // A read that never answered is not a verdict about the platform. Reporting it
    // would tell the user their platform cannot auto-launch when in fact Lody just
    // could not ask -- the same confusion as the unexplained disabled switch, inverted.
    mocks.getAutoLaunchStatus.mockRejectedValue(new Error('ipc unavailable'));

    const state = render(true);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(state.current.unsupported).toBe(false);
  });

  it('never reports unsupported outside Electron', async () => {
    mocks.getAutoLaunchStatus.mockResolvedValue({
      supported: false,
      enabled: false,
      hideWindowOnAutoLaunch: false,
    });

    const state = render(false);

    await act(async () => {
      await Promise.resolve();
    });

    expect(state.current.unsupported).toBe(false);
  });
});
