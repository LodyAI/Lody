// @vitest-environment jsdom

import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CLOUD_PLATFORM_CAPABILITIES,
  LOCAL_PLATFORM_CAPABILITIES,
  type PlatformProvider,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ capture: vi.fn() }));

vi.mock('@/lib/posthog-context', () => ({
  usePostHog: () => ({ capture: mocks.capture }),
}));

import {
  OnboardingAnalyticsProvider,
  useOnboardingAnalytics,
  type DesktopOnboardingTraceProperties,
} from '../src/components/onboarding/onboarding-analytics';
import { ModelScreen } from '../src/components/onboarding/screens/model-screen';
import {
  EMPTY_ARRIVAL_PROBE,
  IDLE_SORBET_OAUTH_STATE,
  SorbetOnboardingControllerProvider,
  type SorbetOnboardingController,
} from '../src/components/onboarding/shared/sorbet-onboarding-controller';
import { initI18n } from '../src/i18n';
import { TEST_CLOUD_PLATFORM } from './test-platform';

function AnalyticsProbe() {
  const analytics = useOnboardingAnalytics();
  useEffect(() => {
    analytics.capture('onboarding/operation_failed', {
      step: 'account',
      operation: 'workspace_create',
      failure_code: 'workspace_create_failed',
      name: 'Private Workspace',
      message: 'raw backend detail',
      api_key: 'sk-ant-secret-must-never-leak',
    } as unknown as DesktopOnboardingTraceProperties);
  }, [analytics]);
  return null;
}

function makeTestController(): SorbetOnboardingController {
  return {
    probe: EMPTY_ARRIVAL_PROBE,
    probeLoading: false,
    oauthState: IDLE_SORBET_OAUTH_STATE,
    refreshProbe: async () => EMPTY_ARRIVAL_PROBE,
    startOAuth: async () => IDLE_SORBET_OAUTH_STATE,
    cancelOAuth: async () => undefined,
    describeImport: async (source) => ({ source, systemPromptKind: 'none' }),
    runImport: async (req) => ({ status: 'not_found', source: req.source }),
    connectApiKey: async ({ providerId }) => ({
      ok: true,
      providerId,
      providerName: 'Claude',
      modelSelector: 'anthropic/claude-sonnet-4-5',
      modelName: 'Sonnet 4.5',
      source: { kind: 'api_key', last4: 'a3f9' },
      models: [],
    }),
    connectCustomProvider: async () => ({ ok: false, code: 'unknown' }),
    disconnectProvider: async () => undefined,
    applyDefaultModelSelection: async () => undefined,
  };
}

describe('desktop onboarding analytics', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    sessionStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    mocks.capture.mockReset();
  });

  it('captures fixed trace fields and strips secrets, user-authored names, and raw errors', async () => {
    const platform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      capabilities: CLOUD_PLATFORM_CAPABILITIES,
    };
    await act(async () => {
      root.render(
        <PlatformContext.Provider value={platform}>
          <OnboardingAnalyticsProvider>
            <AnalyticsProbe />
          </OnboardingAnalyticsProvider>
        </PlatformContext.Provider>
      );
    });

    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalledWith('onboarding/operation_failed', {
      flow_id: expect.any(String),
      flow_schema_version: 2,
      step: 'account',
      operation: 'workspace_create',
      failure_code: 'workspace_create_failed',
    });
  });

  it('does not capture or persist a flow id when telemetry is unavailable (OSS local)', async () => {
    const platform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      capabilities: LOCAL_PLATFORM_CAPABILITIES,
    };
    await act(async () => {
      root.render(
        <PlatformContext.Provider value={platform}>
          <OnboardingAnalyticsProvider>
            <AnalyticsProbe />
          </OnboardingAnalyticsProvider>
        </PlatformContext.Provider>
      );
    });

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });

  it('records model skip distribution without leaking secrets', async () => {
    const onSkip = vi.fn();
    const platform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      capabilities: CLOUD_PLATFORM_CAPABILITIES,
    };
    await act(async () => {
      root.render(
        <PlatformContext.Provider value={platform}>
          <OnboardingAnalyticsProvider>
            <SorbetOnboardingControllerProvider value={makeTestController()}>
              <ModelScreen onConnected={vi.fn()} onSkip={onSkip} />
            </SorbetOnboardingControllerProvider>
          </OnboardingAnalyticsProvider>
        </PlatformContext.Provider>
      );
    });

    const skipBtn = container.querySelector(
      '[data-testid="onboarding-model-skip"]'
    ) as HTMLButtonElement;
    expect(skipBtn).not.toBeNull();
    await act(async () => {
      skipBtn.click();
    });

    expect(onSkip).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalledWith(
      'onboarding/operation_succeeded',
      expect.objectContaining({
        step: 'model',
        connection_method: 'skip',
      })
    );
  });
});
