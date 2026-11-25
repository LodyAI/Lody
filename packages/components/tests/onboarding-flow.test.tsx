// @vitest-environment jsdom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MotionGlobalConfig } from 'framer-motion';
import { Provider, createStore, type Store } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUD_PLATFORM_CAPABILITIES,
  LOCAL_PLATFORM_CAPABILITIES,
  createStaticStore,
  type PlatformProvider,
  type PlatformSessionState,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type { WorkspaceId } from '@lody/shared';

import {
  EMPTY_DESKTOP_ONBOARDING_DRAFT,
  desktopOnboardingDraftAtom,
  desktopOnboardingPhaseAtom,
} from '../src/atoms/onboarding';
import {
  ConnectModelSheet,
  EMPTY_ARRIVAL_PROBE,
  IDLE_SORBET_OAUTH_STATE,
  OnboardingOverlay,
  SorbetOnboardingControllerProvider,
  StartScreen,
  buildStaticSuggestionPills,
  detectProviderFromApiKeyPrefix,
  type SorbetOnboardingController,
} from '../src/components/onboarding';
import { initI18n } from '../src/i18n';
import { TEST_CLOUD_PLATFORM } from './test-platform';

// ResizeObserver stub for ChatComposer measurement in jsdom.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

function makeController(
  overrides: Partial<SorbetOnboardingController> = {}
): SorbetOnboardingController {
  return {
    probe: EMPTY_ARRIVAL_PROBE,
    probeLoading: false,
    oauthState: IDLE_SORBET_OAUTH_STATE,
    refreshProbe: async () => EMPTY_ARRIVAL_PROBE,
    startOAuth: async ({ providerId, providerName }) => ({
      ...IDLE_SORBET_OAUTH_STATE,
      revision: 1,
      attemptId: 'attempt-1',
      providerId,
      providerName: providerName ?? providerId,
      phase: 'waiting',
      authorizationUrl: 'https://auth.example.com/oauth',
    }),
    cancelOAuth: async () => undefined,
    describeImport: async (source) => ({
      source,
      systemPromptKind: source === 'claude-code' ? 'macos-keychain' : 'none',
    }),
    runImport: async (req) => ({ status: 'not_found', source: req.source }),
    connectApiKey: async ({ providerId, apiKey }) => {
      if (apiKey.includes('bad')) {
        return { ok: false, code: 'invalid_key' };
      }
      return {
        ok: true,
        providerId,
        providerName: providerId === 'anthropic' ? 'Claude' : 'OpenAI',
        modelSelector: `${providerId}/recommended-model`,
        modelName: 'Recommended Model',
        source: { kind: 'api_key', last4: apiKey.slice(-4) },
        models: [],
      };
    },
    connectCustomProvider: async () => ({ ok: false, code: 'unknown' }),
    disconnectProvider: async () => undefined,
    applyDefaultModelSelection: async () => undefined,
    ...overrides,
  };
}

function mountInRouter(
  ui: React.ReactNode,
  options: { store: Store; platform: PlatformProvider }
) {
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <>{ui}</>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return (
    <Provider store={options.store}>
      <PlatformContext.Provider value={options.platform}>
        <RouterProvider router={router} />
      </PlatformContext.Provider>
    </Provider>
  );
}

describe('reorganized desktop onboarding flow', () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: Store;
  const originalMatchMedia = window.matchMedia;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    MotionGlobalConfig.skipAnimations = true;
    window.scrollTo = () => {};
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    vi.useFakeTimers();
    await initI18n('en');
    window.localStorage.clear();
    window.sessionStorage.clear();
    store = createStore();
    store.set(desktopOnboardingPhaseAtom, null);
    store.set(desktopOnboardingDraftAtom, EMPTY_DESKTOP_ONBOARDING_DRAFT);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    MotionGlobalConfig.skipAnimations = false;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
    delete (window as { ipc?: unknown }).ipc;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('auto-advances Arrive beats 1-3 every 2.4s, pauses on hover, and skips directly to Model on OSS local', async () => {
    const localPlatform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      capabilities: LOCAL_PLATFORM_CAPABILITIES,
    };
    const controller = makeController();

    await act(async () => {
      root.render(
        mountInRouter(
          <SorbetOnboardingControllerProvider value={controller}>
            <OnboardingOverlay onCompleted={async () => true} />
          </SorbetOnboardingControllerProvider>,
          { store, platform: localPlatform }
        )
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(container.querySelector('[data-testid="onboarding-arrive-stage"]')).not.toBeNull();
    expect(container.textContent).toContain('Stay in the flow.');

    // Beat 1 -> Beat 2 after 2.4s (+ AnimatePresence exit/enter)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2450);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(container.textContent).toContain('Step away with confidence.');

    // Hovering pauses auto-advance
    const stage = container.querySelector('[data-testid="onboarding-arrive-stage"]')!;
    await act(async () => {
      stage.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(container.textContent).toContain('Step away with confidence.');

    // Skip button jumps straight to `Model` on OSS local when Sorbet has no credentials
    const skipBtn = container.querySelector(
      '[data-testid="onboarding-arrive-skip"]'
    ) as HTMLButtonElement;
    await act(async () => {
      skipBtn.click();
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(container.querySelector('[data-testid="onboarding-model-screen"]')).not.toBeNull();
  });

  it('skips Model step automatically when ArrivalProbe reports Sorbet already has credentials', async () => {
    const localPlatform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      capabilities: LOCAL_PLATFORM_CAPABILITIES,
    };
    const readyController = makeController({
      probe: {
        model: {
          kind: 'ready',
          provider: 'anthropic',
          providerName: 'Claude',
          model: 'anthropic/claude-sonnet-4-5',
          modelName: 'Sonnet 4.5',
          source: { kind: 'oauth' },
        },
        methods: EMPTY_ARRIVAL_PROBE.methods,
        connectedProviders: [
          {
            providerId: 'anthropic',
            providerName: 'Claude',
            authType: 'oauth',
            source: { kind: 'oauth' },
          },
        ],
        models: [
          {
            selector: 'anthropic/claude-sonnet-4-5',
            providerId: 'anthropic',
            modelId: 'claude-sonnet-4-5',
            displayName: 'Sonnet 4.5',
          },
        ],
      },
    });

    await act(async () => {
      root.render(
        mountInRouter(
          <SorbetOnboardingControllerProvider value={readyController}>
            <OnboardingOverlay onCompleted={async () => true} />
          </SorbetOnboardingControllerProvider>,
          { store, platform: localPlatform }
        )
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    const skipArrive = container.querySelector(
      '[data-testid="onboarding-arrive-skip"]'
    ) as HTMLButtonElement;
    await act(async () => {
      skipArrive.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    // Directly enters `Start`, skipping `Model`, with `Claude · Subscription` chip in the top rail!
    expect(container.querySelector('[data-testid="onboarding-start-screen"]')).not.toBeNull();
    const modelChip = container.querySelector('[data-testid="onboarding-chip-model"]');
    expect(modelChip?.textContent).toContain('Claude');
  });

  it('auto-selects a single workspace on Account and flies the account chip to OnboardingChipRail', async () => {
    store.set(desktopOnboardingPhaseAtom, 'account');
    const setActive = vi.fn(async () => undefined);
    const cloudPlatform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      capabilities: CLOUD_PLATFORM_CAPABILITIES,
      identity: {
        ...TEST_CLOUD_PLATFORM.identity,
        session: createStaticStore<PlatformSessionState>({
          status: 'authenticated',
          user: { id: 'u-1', name: 'wibus', email: 'wibus@example.com' },
        }),
      },
      workspaces: {
        ...TEST_CLOUD_PLATFORM.workspaces,
        state: createStaticStore({
          status: 'ready' as const,
          activeWorkspaceId: 'ws-1' as WorkspaceId,
          workspaces: [
            {
              id: 'ws-1' as WorkspaceId,
              name: 'Personal',
              slug: 'personal',
              role: 'owner',
            },
          ],
        }),
        setActive,
      },
    };

    await act(async () => {
      root.render(
        mountInRouter(
          <SorbetOnboardingControllerProvider value={makeController()}>
            <OnboardingOverlay onCompleted={async () => true} />
          </SorbetOnboardingControllerProvider>,
          { store, platform: cloudPlatform }
        )
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    // Single workspace auto-advances to `model` and populates `wibus · Personal` chip!
    expect(container.querySelector('[data-testid="onboarding-model-screen"]')).not.toBeNull();
    const accountChip = container.querySelector('[data-testid="onboarding-chip-account"]');
    expect(accountChip?.textContent).toContain('wibus');
    expect(accountChip?.textContent).toContain('Personal');
  });

  it('ConnectModelSheet performs zero import reads until confirmed, pre-discloses macOS Keychain, and masks API keys after 600ms', async () => {
    const runImport = vi.fn<SorbetOnboardingController['runImport']>(async () => ({
      status: 'oauth_conflict',
      source: 'claude-code',
      providerId: 'anthropic',
      providerName: 'Claude',
    }));
    const startOAuth = vi.fn(makeController().startOAuth);
    const controller = makeController({ runImport, startOAuth });
    const onConnected = vi.fn();

    await act(async () => {
      root.render(
        <SorbetOnboardingControllerProvider value={controller}>
          <ConnectModelSheet showHeader onConnected={onConnected} />
        </SorbetOnboardingControllerProvider>
      );
    });

    // Zero upfront import calls on mount!
    expect(runImport).not.toHaveBeenCalled();

    // Expanding Claude Code discloses macOS Keychain prompt before reading anything
    await act(async () => {
      (container.querySelector('[data-testid="import-row-claude-code"]') as HTMLElement).click();
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(runImport).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Keychain');

    // Confirming import runs `runImport` and offers 1-click OAuth re-login on rotating token conflict
    await act(async () => {
      (
        container.querySelector('[data-testid="confirm-import-claude-code"]') as HTMLElement
      ).click();
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(runImport).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('rotate');

    await act(async () => {
      (
        container.querySelector('[data-testid="import-relogin-oauth-claude-code"]') as HTMLElement
      ).click();
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(startOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'anthropic' })
    );

    // Prefix detection + 600ms API key masking
    expect(detectProviderFromApiKeyPrefix('sk-ant-api03-1234567890abcd')?.providerId).toBe(
      'anthropic'
    );
    await act(async () => {
      (container.querySelector('[data-testid="expand-paste-api-key"]') as HTMLElement).click();
      await vi.advanceTimersByTimeAsync(20);
    });
    const input = container.querySelector('[data-testid="api-key-input"]') as HTMLInputElement;
    await act(async () => {
      input.blur();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'sk-ant-api03-valid-key-99ef');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(650);
    });
    expect(input.value).toBe('••••••••••••99ef');
  });

  it('StartScreen scans repos lazily only when Project popover opens and adapts static suggestion pills', async () => {
    const discoverRecentRepos = vi.fn(async () => [
      { name: 'lody', rootPath: '/Users/dev/code/lody', mtimeMs: Date.now() },
    ]);
    Object.defineProperty(window, 'ipc', {
      configurable: true,
      value: {
        invoke: async (channel: string) => {
          if (channel === 'localProjects.discoverRecentRepos') return discoverRecentRepos();
          if (channel === 'localProjects.inspectRepoPromptHints') {
            return { hasTests: true, isDirty: true, hasTodos: true };
          }
          return null;
        },
        on: () => () => undefined,
        send: () => undefined,
      },
    });

    const exploreFirst = vi.fn(async () => true);
    const localPlatform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      capabilities: LOCAL_PLATFORM_CAPABILITIES,
    };

    await act(async () => {
      root.render(
        mountInRouter(
          <SorbetOnboardingControllerProvider value={makeController()}>
            <StartScreen
              project={null}
              modelChip={null}
              selectedAgentConfigId={null}
              exitingToProduct={false}
              onProjectChange={vi.fn()}
              onModelConnected={vi.fn()}
              onAgentConfigChange={vi.fn()}
              onBeginExitTransition={vi.fn()}
              onEnterWithSession={async () => true}
              onExploreFirst={exploreFirst}
            />
          </SorbetOnboardingControllerProvider>,
          { store, platform: localPlatform }
        )
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    // Repo scan has NOT run before opening the Project popover!
    expect(discoverRecentRepos).not.toHaveBeenCalled();
    // Amber "Connect model" chip is visible when model was skipped
    expect(container.querySelector('[data-testid="onboarding-connect-model-chip"]')).not.toBeNull();
    // Real ChatComposer `#chat-prompt` is mounted and editable
    expect(container.querySelector('#chat-prompt')).not.toBeNull();

    // Opening Project popover triggers lazy repo discovery while `Open folder…` is immediately present
    await act(async () => {
      (container.querySelector('[data-testid="onboarding-project-chip"]') as HTMLElement).click();
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(discoverRecentRepos).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="onboarding-open-folder"]')).not.toBeNull();

    // Static suggestion pills adapt deterministically without LLM calls
    const noProjectPills = buildStaticSuggestionPills(false, null, (_k, opts) =>
      String(opts?.defaultValue ?? '')
    );
    expect(noProjectPills).toHaveLength(3);
    const repoPills = buildStaticSuggestionPills(
      true,
      { hasTests: true, isDirty: true, hasTodos: true },
      (_k, opts) => String(opts?.defaultValue ?? '')
    );
    expect(repoPills).toEqual([
      'Walk through how this repository is structured',
      'Run the test suite and fix any failures',
      'Review my uncommitted changes',
    ]);
  });
});
