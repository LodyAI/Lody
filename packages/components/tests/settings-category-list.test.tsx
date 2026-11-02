// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore, type Store } from 'jotai';

import { BetaFeaturesSection } from '../src/components/settings/beta-features-setting';
import { ExperimentalFeaturesSection } from '../src/components/settings/experimental-features-setting';
import {
  developerModeEnabledAtom,
  e2eeWorkspaceCreationEnabledAtom,
  e2eeWorkspaceCreationFeatureEnabledAtom,
  experimentalFeaturesEnabledAtom,
  roostHistoryExperimentEnabledAtom,
  roostHistoryFeatureEnabledAtom,
} from '../src/atoms/settings';
import { bugReportDialogOpenAtom } from '../src/atoms/bug-report';
import { userAtom } from '../src/atoms';
import { SettingsCategoryList } from '../src/components/settings/settings-category-list';
import { MobileSettingsFoldContext } from '../src/components/mobile/mobile-settings-fold-context';
import { MobileStatsSettings } from '../src/components/mobile/mobile-stats-settings';
import { MobileGeneralSettings } from '../src/components/mobile/mobile-general-settings';
import { MobileSettingsFoldPanels } from '../src/components/mobile/mobile-settings-fold-panels';
import { MobileSettingsLayout } from '../src/components/mobile/mobile-settings-layout';
import { initI18n } from '../src/i18n';
import { TestCloudPlatformProvider } from './test-platform';

const usageCache = vi.hoisted(() => ({
  value: null as null | {
    workspaceId: string;
    usageTimelineByRange: {
      week?: {
        totals: { tokens: number; costUSD: number };
        buckets?: Array<{
          bucketStartMs: number;
          tokens: number;
          byModel: Array<{ modelId: string; tokens: number; costUSD: number }>;
        }>;
      };
    };
  },
}));
vi.mock('../src/components/settings/settings-data-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/components/settings/settings-data-cache')>()),
  useOptionalSettingsDataCache: () => usageCache.value,
  useSettingsDataCache: () => ({
    workspaceId: null,
    usageTimelineByRange: {},
    usageCalendar: null,
  }),
  useSettingsUsageDay: () => ({ day: undefined, loading: false }),
}));

const route = vi.hoisted(() => ({ pathname: '/acme/settings/ai-usage' }));
const navigateMock = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  useParams: () => ({ workspaceName: 'acme' }),
  useLocation: () => ({ pathname: route.pathname }),
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
    usageCache.value = null;
    route.pathname = '/acme/settings/ai-usage';
    Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
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
    delete window.__LODY_HORIZONTAL_DIVISION__;
  });

  async function renderList(
    fold: { messageHeight: number; lowerTop: number; gapHeight: number } | null = null
  ) {
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
            createElement(
              MobileSettingsFoldContext.Provider,
              { value: fold },
              createElement(SettingsCategoryList, { workspaceName: 'acme' })
            )
          )
        )
      );
    });
  }

  it('keeps usage controls and charts on their panels and retains the chosen range when unfolded', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const renderUsage = (
      fold: { messageHeight: number; lowerTop: number; gapHeight: number } | null
    ) =>
      root!.render(
        <TestCloudPlatformProvider>
          <Provider store={store}>
            <MobileSettingsFoldContext.Provider value={fold}>
              <MobileStatsSettings />
            </MobileSettingsFoldContext.Provider>
          </Provider>
        </TestCloudPlatformProvider>
      );
    await act(async () => renderUsage({ messageHeight: 250, lowerTop: 290, gapHeight: 40 }));
    const summary = container.querySelector<HTMLElement>('[data-usage-summary]')!;
    const charts = container.querySelector<HTMLElement>('[data-usage-charts]')!;
    expect(summary.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Week');
    expect(summary.style.flexBasis).toBe('250px');
    expect(charts.classList.contains('overflow-y-auto')).toBe(true);
    const day = [...summary.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (tab) => tab.textContent === 'Day'
    )!;
    await act(async () => day.click());
    await act(async () => renderUsage(null));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Day');
    expect(
      container.querySelector('[data-usage-charts]')?.classList.contains('overflow-y-auto')
    ).toBe(false);
  });

  it('retains the selected usage range when the actual settings layout folds and unfolds', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 900,
      left: 0,
      right: 669,
      width: 669,
      height: 800,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <TestCloudPlatformProvider>
          <Provider store={store}>
            <MobileSettingsLayout
              title="Usage"
              isNativeApp
              isMachineDetail={false}
              isAgentConfigTab={false}
              onBack={() => {}}
            >
              <MobileStatsSettings />
            </MobileSettingsLayout>
          </Provider>
        </TestCloudPlatformProvider>
      )
    );
    const settingsViewport = container.querySelector<HTMLElement>('[data-scroll-area-viewport]');
    expect(settingsViewport).not.toBeNull();
    const day = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (tab) => tab.textContent === 'Day'
    )!;
    await act(async () => day.click());
    await act(async () => {
      window.__LODY_HORIZONTAL_DIVISION__ = { top: 455, height: 40, viewportHeight: 951 };
      window.dispatchEvent(new Event('lody:division-change'));
    });
    expect(container.querySelector<HTMLElement>('[data-usage-summary]')?.style.flexBasis).toBe(
      '355px'
    );
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Day');
    expect(container.querySelector('[data-scroll-area-viewport]')).toBe(settingsViewport);
    await act(async () => {
      delete window.__LODY_HORIZONTAL_DIVISION__;
      window.dispatchEvent(new Event('lody:division-change'));
    });
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Day');
    expect(container.querySelector('[data-scroll-area-viewport]')).toBe(settingsViewport);
  });

  it('puts notification preferences above the fold and session settings below', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <TestCloudPlatformProvider>
          <Provider store={store}>
            <MobileSettingsFoldContext.Provider
              value={{ messageHeight: 250, lowerTop: 290, gapHeight: 40 }}
            >
              <MobileGeneralSettings />
            </MobileSettingsFoldContext.Provider>
          </Provider>
        </TestCloudPlatformProvider>
      )
    );
    const upper = container.querySelector('[data-settings-fold-upper]')!;
    const lower = container.querySelector('[data-settings-fold-lower]')!;
    expect(upper.textContent?.toLowerCase()).toContain('notification');
    expect(lower.textContent).toContain('Queued message behavior');
  });

  it.each(['account', 'appearance', 'preferences'])(
    'enables the %s detail panels and preserves their input during fold and keyboard changes',
    async (page) => {
      route.pathname = `/acme/settings/${page}`;
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        top: 100,
        bottom: 900,
        left: 0,
        right: 669,
        width: 669,
        height: 800,
        x: 0,
        y: 100,
        toJSON: () => ({}),
      });
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () =>
        root!.render(
          <MobileSettingsLayout
            title="Settings"
            isNativeApp
            isMachineDetail={false}
            isAgentConfigTab={false}
            onBack={() => {}}
          >
            <MobileSettingsFoldPanels
              upper={<input aria-label="draft" defaultValue="unsaved" />}
              lower={<div>Details</div>}
            />
          </MobileSettingsLayout>
        )
      );
      const input = container.querySelector<HTMLInputElement>('input')!;
      await act(async () => {
        window.__LODY_HORIZONTAL_DIVISION__ = { top: 455, height: 40, viewportHeight: 951 };
        window.dispatchEvent(new Event('lody:division-change'));
      });
      expect(
        container.querySelector<HTMLElement>('[data-settings-fold-upper]')?.style.flexBasis
      ).toBe('355px');
      expect(
        container.querySelector('[data-settings-fold-lower]')?.classList.contains('overflow-y-auto')
      ).toBe(true);
      await act(async () => {
        document.documentElement.style.setProperty('--native-keyboard-height', '250px');
        window.dispatchEvent(new Event('lody:keyboard-resize'));
      });
      expect(
        container.querySelector('[data-settings-fold-lower]')?.classList.contains('overflow-y-auto')
      ).toBe(false);
      expect(container.querySelector('input')).toBe(input);
      expect(input.value).toBe('unsaved');
      document.documentElement.style.removeProperty('--native-keyboard-height');
    }
  );

  it('requires developer mode only for new encrypted workspace creation and retains the preference', async () => {
    store?.set(developerModeEnabledAtom, true);
    store?.set(e2eeWorkspaceCreationEnabledAtom, false);
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <Provider store={store}>
          <BetaFeaturesSection />
        </Provider>
      )
    );
    const control = container.querySelector<HTMLElement>(
      '[role="switch"][aria-label="Encrypted workspace creation"]'
    );
    expect(control).not.toBeNull();
    await act(async () => control?.click());
    expect(store?.get(e2eeWorkspaceCreationFeatureEnabledAtom)).toBe(true);
    await act(async () => store?.set(developerModeEnabledAtom, false));
    expect(store?.get(e2eeWorkspaceCreationFeatureEnabledAtom)).toBe(false);
    expect(store?.get(e2eeWorkspaceCreationEnabledAtom)).toBe(true);
    expect(container.querySelector('[role="switch"]')).toBeNull();
  });

  it('keeps Roost in developer features without an experimental master gate', async () => {
    store?.set(experimentalFeaturesEnabledAtom, false);
    store?.set(developerModeEnabledAtom, true);
    store?.set(roostHistoryExperimentEnabledAtom, false);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <Provider store={store}>
          <ExperimentalFeaturesSection />
          <BetaFeaturesSection />
        </Provider>
      );
    });
    expect(container.textContent).not.toContain('Review agent');
    const roostSwitch = container.querySelector<HTMLElement>(
      '[role="switch"][aria-label="Roost history"]'
    );
    expect(roostSwitch).not.toBeNull();
    await act(async () => roostSwitch?.click());
    expect(store?.get(roostHistoryFeatureEnabledAtom)).toBe(true);

    await act(async () =>
      container
        ?.querySelector<HTMLElement>('[role="switch"][aria-label="Enable experimental features"]')
        ?.click()
    );
    expect(store?.get(roostHistoryFeatureEnabledAtom)).toBe(true);
    const experimentalSection = [...container.querySelectorAll('section')].find((section) =>
      section.textContent?.includes('Experimental features')
    );
    expect(experimentalSection?.textContent).not.toContain('Roost history');

    await act(async () => store?.set(developerModeEnabledAtom, false));
    expect(store?.get(roostHistoryFeatureEnabledAtom)).toBe(false);
    expect(container.querySelector('[role="switch"][aria-label="Roost history"]')).toBeNull();

    await act(async () => store?.set(developerModeEnabledAtom, true));
    expect(store?.get(roostHistoryFeatureEnabledAtom)).toBe(true);
    const restoredSwitch = container.querySelector<HTMLElement>(
      '[role="switch"][aria-label="Roost history"]'
    );
    expect(restoredSwitch?.getAttribute('aria-checked')).toBe('true');
    await act(async () => restoredSwitch?.click());
    expect(store?.get(roostHistoryFeatureEnabledAtom)).toBe(false);
  });

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

  it('places the account above the fold and all settings below', async () => {
    store?.set(userAtom, { id: 'person', name: 'Example User', email: 'user@example.test' });
    await renderList({ messageHeight: 300, lowerTop: 450, gapHeight: 40 });
    const upper = container!.querySelector<HTMLElement>('[data-settings-fold-upper]')!;
    const lower = container!.querySelector<HTMLElement>('[data-settings-fold-lower]')!;
    expect(upper.textContent).toContain('Example User');
    expect(upper.textContent).toContain('user@example.test');
    const workspace = upper.querySelector<HTMLButtonElement>('[data-settings-fold-workspace]')!;
    expect(workspace.textContent).toContain('acme');
    expect(workspace.textContent).toContain('Workspace');
    await act(async () => workspace.click());
    expect(navigateMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/$workspaceName/settings/workspace' })
    );
    navigateMock.mockClear();
    expect(upper.textContent).not.toContain('Preferences');
    expect(lower.textContent).toContain('Preferences');
    expect(lower.textContent).toContain('General');
    await act(async () => {
      [...lower.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('General'))!
        .click();
    });
    expect(navigateMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/$workspaceName/settings/workspace' })
    );
  });

  it('shows weekly workspace totals and aggregates hourly buckets by UTC day', async () => {
    usageCache.value = {
      workspaceId: 'workspace',
      usageTimelineByRange: {
        week: {
          totals: { tokens: 125000, costUSD: 1.25 },
          buckets: [
            {
              bucketStartMs: 0,
              tokens: 10000,
              byModel: [{ modelId: 'model-a', tokens: 10000, costUSD: 0 }],
            },
            {
              bucketStartMs: 3600000,
              tokens: 15000,
              byModel: [{ modelId: 'model-a', tokens: 15000, costUSD: 0 }],
            },
            {
              bucketStartMs: 86400000,
              tokens: 100000,
              byModel: [{ modelId: 'model-b', tokens: 100000, costUSD: 0 }],
            },
          ],
        },
      },
    };
    await renderList({ messageHeight: 300, lowerTop: 450, gapHeight: 40 });
    const usage = container!.querySelector<HTMLElement>('[data-settings-fold-usage]')!;
    expect(usage.textContent).toContain('125K');
    expect(usage.textContent).toContain('$1.25');
    expect(usage.textContent).toContain('Workspace');
    expect(usage.textContent).toContain('Last 7 days');
    expect(usage.textContent).toContain('model-b');
    expect(usage.textContent).toContain('80%');
    const bars = usage.querySelectorAll<HTMLElement>('[data-settings-usage-chart] span');
    expect([...bars].map((bar) => bar.style.height)).toEqual(['25%', '100%']);
    expect(usage.textContent).not.toContain('UTC');
    await act(async () => usage.click());
    expect(navigateMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/$workspaceName/settings/ai-usage' })
    );
  });

  it('shows actual zero usage when a zero-valued snapshot arrives', async () => {
    usageCache.value = {
      workspaceId: 'workspace',
      usageTimelineByRange: { week: { totals: { tokens: 0, costUSD: 0 } } },
    };
    await renderList({ messageHeight: 300, lowerTop: 450, gapHeight: 40 });
    const usage = container!.querySelector<HTMLElement>('[data-settings-fold-usage]')!;
    expect(usage.textContent).toContain('0');
    expect(usage.textContent).not.toContain('Loading');
    expect(usage.textContent).not.toContain('—');
  });

  it('does not present unavailable usage as zero', async () => {
    usageCache.value = { workspaceId: 'workspace', usageTimelineByRange: {} };
    await renderList({ messageHeight: 300, lowerTop: 450, gapHeight: 40 });
    const usage = container!.querySelector<HTMLElement>('[data-settings-fold-usage]')!;
    expect(usage.textContent).toContain('—');
    expect(usage.textContent).toContain('Loading');
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

  it('does not expose desktop-only keyboard shortcuts', async () => {
    await renderList();

    expect(container?.textContent).not.toContain('Keyboard Shortcuts');
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

  it('opens the category reached by keyboard navigation', async () => {
    await renderList();
    const preferences = getButton('Preferences');

    await act(async () => preferences.focus());
    await act(async () => {
      preferences.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' })
      );
    });

    expect(document.activeElement).toBe(getButton('Appearance'));
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
