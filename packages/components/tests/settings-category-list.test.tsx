// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore, type Store } from 'jotai';

import { bugReportDialogOpenAtom } from '../src/atoms/bug-report';
import { SettingsCategoryList } from '../src/components/settings/settings-category-list';
import { initI18n } from '../src/i18n';
import { TestCloudPlatformProvider } from './test-platform';

const navigateMock = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('SettingsCategoryList', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let store: Store | undefined;

  beforeEach(async () => {
    await initI18n('en');
    navigateMock.mockClear();
    Reflect.deleteProperty(window, '__LODY_NATIVE__');
    Reflect.deleteProperty(window, 'Capacitor');
    store = createStore();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    store = undefined;
    vi.restoreAllMocks();
  });

  async function renderList() {
    if (!store) throw new Error('Missing test store');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(
          TestCloudPlatformProvider,
          null,
          createElement(
            Provider,
            { store },
            createElement(SettingsCategoryList, { workspaceName: 'acme' })
          )
        )
      );
    });
  }

  it('renders a bottom bug report action that opens the report dialog state', async () => {
    await renderList();

    const reportButton = getButton('Report a bug');
    expect(reportButton.textContent).toContain('Send a report with optional machine logs');

    await act(async () => {
      reportButton.click();
    });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(store?.get(bugReportDialogOpenAtom)).toBe(true);
  });

  it('keeps settings category rows navigating normally', async () => {
    await renderList();

    expect(container?.textContent).not.toContain('My Machines');
    expect(container?.textContent).not.toContain('People');

    await act(async () => {
      getButton('Preferences').click();
    });

    expect(navigateMock).toHaveBeenCalledWith({
      to: '/$workspaceName/settings/preferences',
      params: { workspaceName: 'acme' },
      search: expect.any(Function),
    });
    expect(store?.get(bugReportDialogOpenAtom)).toBe(false);
  });

  it('routes workspace member management through General', async () => {
    await renderList();

    await act(async () => {
      getButton('General').click();
    });

    expect(navigateMock).toHaveBeenCalledWith({
      to: '/$workspaceName/settings/workspace',
      params: { workspaceName: 'acme' },
      search: expect.any(Function),
    });
  });

  it('navigates to the appearance category', async () => {
    await renderList();

    await act(async () => {
      getButton('Appearance').click();
    });

    expect(navigateMock).toHaveBeenCalledWith({
      to: '/$workspaceName/settings/appearance',
      params: { workspaceName: 'acme' },
      search: expect.any(Function),
    });
  });

  it('exposes billing in a mobile web browser and navigates to it', async () => {
    await renderList();

    await act(async () => {
      getButton('Billing').click();
    });

    expect(navigateMock).toHaveBeenCalledWith({
      to: '/$workspaceName/settings/billing',
      params: { workspaceName: 'acme' },
      search: expect.any(Function),
    });
  });

  it.each(['ios', 'android'])('does not expose billing in the native %s app', async (platform) => {
    Object.defineProperty(window, 'Capacitor', {
      configurable: true,
      value: {
        getPlatform: () => platform,
      },
    });

    await renderList();

    expect(container?.textContent).not.toContain('Billing');
  });

  function getButton(name: string): HTMLButtonElement {
    const button = Array.from(container?.querySelectorAll('button') ?? []).find((node) =>
      node.textContent?.includes(name)
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Could not find button: ${name}`);
    }
    return button;
  }
});
