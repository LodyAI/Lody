// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AutoLaunchSettingRows } from '../src/components/settings/general-setting';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type State = Parameters<typeof AutoLaunchSettingRows>[0]['autoLaunch'];

const state = (overrides: Partial<State>): State => ({
  supported: true,
  enabled: false,
  hideWindowOnAutoLaunch: false,
  loading: false,
  enabledLoading: false,
  hideWindowLoading: false,
  updateEnabled: async () => {},
  updateHideWindow: async () => {},
  ...overrides,
});

describe('AutoLaunchSettingRows', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(async () => {
    await initI18n('en');
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = async (autoLaunch: State) => {
    await act(async () => root.render(<AutoLaunchSettingRows autoLaunch={autoLaunch} />));
  };

  /** Each row: whether its name is stepped back, its helper, and its switch. */
  const rows = () =>
    Array.from(container.children).map((row) => ({
      label: row.querySelector('p')?.textContent,
      dimmed: row.hasAttribute('data-disabled'),
      helper: row.querySelectorAll('p')[1]?.textContent ?? null,
      switchDisabled: row.querySelector<HTMLButtonElement>('button')?.disabled,
    }));

  it('says why both switches are unavailable where the OS has no login item', async () => {
    await render(state({ supported: false }));

    expect(rows()).toEqual([
      {
        label: 'Launch at startup',
        dimmed: true,
        helper: 'Available on macOS and Windows only.',
        switchDisabled: true,
      },
      {
        label: 'Hide window on auto-launch',
        dimmed: true,
        helper: 'Available on macOS and Windows only.',
        switchDisabled: true,
      },
    ]);
  });

  it('reads hiding the window as depending on launching at startup', async () => {
    await render(state({ enabled: false }));

    expect(rows()).toEqual([
      { label: 'Launch at startup', dimmed: false, helper: null, switchDisabled: false },
      {
        label: 'Hide window on auto-launch',
        dimmed: true,
        helper: 'Applies once Launch at startup is on.',
        switchDisabled: true,
      },
    ]);
  });

  it('lets both be set, and explains nothing, once launching at startup is on', async () => {
    await render(state({ enabled: true }));

    expect(rows()).toEqual([
      { label: 'Launch at startup', dimmed: false, helper: null, switchDisabled: false },
      { label: 'Hide window on auto-launch', dimmed: false, helper: null, switchDisabled: false },
    ]);
  });
});
