// @vitest-environment jsdom

import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider as JotaiProvider, createStore } from 'jotai';
import {
  CLOUD_PLATFORM_CAPABILITIES,
  LOCAL_PLATFORM_CAPABILITIES,
  type PlatformProvider,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ capture: vi.fn() }));

vi.mock('@posthog/react', () => ({
  usePostHog: () => ({ capture: mocks.capture }),
}));

import {
  clearDesktopOnboardingFlowId,
  getOrCreateDesktopOnboardingFlowId,
  OnboardingAnalyticsProvider,
  useOnboardingAnalytics,
  type DesktopOnboardingTraceProperties,
} from '../src/components/onboarding/onboarding-analytics';
import { OnboardingOverlay } from '../src/components/onboarding/onboarding-overlay';
import { SummaryScreen } from '../src/components/onboarding/screens/summary-screen';
import { initI18n } from '../src/i18n';
import { TEST_CLOUD_PLATFORM } from './test-platform';

function AnalyticsProbe() {
  const analytics = useOnboardingAnalytics();
  useEffect(() => {
    analytics.capture('onboarding/operation_failed', {
      step: 'workspace',
      operation: 'workspace_create',
      failure_code: 'workspace_create_failed',
      name: 'Private Workspace',
      message: 'raw backend detail',
    } as unknown as DesktopOnboardingTraceProperties);
  }, [analytics]);
  return null;
}

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((item) =>
    item.textContent?.includes(label)
  );
  if (!button) throw new Error(`Expected button containing "${label}"`);
  return button;
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

  it('reuses one anonymous flow id until durable completion clears it', () => {
    const storage = createMemoryStorage();
    const first = getOrCreateDesktopOnboardingFlowId(storage, () => 'flow-1');
    const second = getOrCreateDesktopOnboardingFlowId(storage, () => 'flow-2');
    expect(first).toBe('flow-1');
    expect(second).toBe('flow-1');

    clearDesktopOnboardingFlowId(storage);
    expect(getOrCreateDesktopOnboardingFlowId(storage, () => 'flow-3')).toBe('flow-3');
  });

  it('captures fixed trace fields and strips user-authored or raw-error properties', async () => {
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
      flow_schema_version: 1,
      step: 'workspace',
      operation: 'workspace_create',
      failure_code: 'workspace_create_failed',
    });
  });

  it('does not capture or persist a flow id when telemetry is unavailable', async () => {
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

  it('starts the real desktop flow and records its first visible step', async () => {
    const platform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      capabilities: CLOUD_PLATFORM_CAPABILITIES,
    };
    await act(async () => {
      root.render(
        <PlatformContext.Provider value={platform}>
          <OnboardingAnalyticsProvider>
            <JotaiProvider store={createStore()}>
              <OnboardingOverlay onCompleted={vi.fn(() => Promise.resolve(true))} />
            </JotaiProvider>
          </OnboardingAnalyticsProvider>
        </PlatformContext.Provider>
      );
    });

    const events = mocks.capture.mock.calls.map(([event, properties]) => ({ event, properties }));
    expect(events.map(({ event }) => event)).toContain('onboarding/flow_started');
    expect(events.map(({ event }) => event)).toContain('onboarding/step_viewed');
    const flowStarted = events.find(({ event }) => event === 'onboarding/flow_started');
    const stepViewed = events.find(({ event }) => event === 'onboarding/step_viewed');
    expect(flowStarted?.properties).toMatchObject({ initial_step: 'ceremony', resumed: false });
    expect(stepViewed?.properties).toMatchObject({ step: 'ceremony', step_index: 1 });
    expect(stepViewed?.properties.flow_id).toBe(flowStarted?.properties.flow_id);
  });

  it('links a failed Summary retry to its started attempt without raw error detail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const platform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      capabilities: CLOUD_PLATFORM_CAPABILITIES,
    };
    await act(async () => {
      root.render(
        <PlatformContext.Provider value={platform}>
          <OnboardingAnalyticsProvider>
            <SummaryScreen
              agentState="failed"
              agentFailureCode="runtime_install_failed"
              onBack={vi.fn()}
              onComplete={vi.fn()}
              onRetryAgent={vi.fn(() => Promise.reject(new Error('private machine detail')))}
            />
          </OnboardingAnalyticsProvider>
        </PlatformContext.Provider>
      );
    });
    await act(async () => {
      findButton(container, 'Retry').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const retryEvents = mocks.capture.mock.calls.filter(
      ([, properties]) => properties.operation === 'agent_setup_retry_request'
    );
    expect(retryEvents.map(([event]) => event)).toEqual([
      'onboarding/operation_started',
      'onboarding/operation_failed',
    ]);
    expect(retryEvents[1]?.[1]).toMatchObject({
      failure_code: 'agent_setup_retry_failed',
      retryable: true,
    });
    expect(retryEvents[1]?.[1]).not.toHaveProperty('message');
    expect(retryEvents[1]?.[1].flow_id).toBe(retryEvents[0]?.[1].flow_id);
  });
});
