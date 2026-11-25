import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { usePostHog } from '@/lib/posthog-context';
import { usePlatformCapability } from '@lody/platform/react';
import { v4 as uuidv4 } from 'uuid';
import {
  capturePostHogEvent,
  getDurationSinceMs,
  getPerformanceNowMs,
} from '@/lib/posthog-analytics';
import type {
  DesktopOnboardingProjectSelection,
  DesktopOnboardingResumePhase,
} from '@/atoms/onboarding';

const FLOW_ID_STORAGE_KEY = 'lody-desktop-onboarding-analytics-flow-id';

export type DesktopOnboardingAnalyticsEvent =
  | 'onboarding/flow_started'
  | 'onboarding/flow_resumed'
  | 'onboarding/flow_completed'
  | 'onboarding/step_viewed'
  | 'onboarding/step_exited'
  | 'onboarding/operation_started'
  | 'onboarding/operation_succeeded'
  | 'onboarding/operation_failed'
  | 'onboarding/completion_started'
  | 'onboarding/completion_succeeded'
  | 'onboarding/completion_failed'
  | 'onboarding/persistence_failed';

export type OnboardingOperation =
  | 'arrival_probe'
  | 'browser_sign_in'
  | 'first_session_create'
  | 'first_session_dispatch'
  | 'local_project_import'
  | 'model_connect_oauth'
  | 'model_connect_import'
  | 'model_connect_api_key'
  | 'model_connect_custom'
  | 'session_check'
  | 'slug_availability_check'
  | 'slug_availability_retry_request'
  | 'workspace_create'
  | 'workspace_list'
  | 'workspace_list_retry'
  | 'workspace_slug_repair'
  | 'workspace_switch';

export type OnboardingModelConnectionMethod =
  | 'oauth'
  | 'import_claude_code'
  | 'import_codex'
  | 'import_env'
  | 'api_key'
  | 'custom'
  | 'skip';

export interface DesktopOnboardingTraceProperties {
  action?: 'authenticated' | 'back' | 'complete' | 'continue' | 'skip';
  attempt?: number | null;
  available?: boolean;
  cloud_account?: boolean;
  connection_method?: OnboardingModelConnectionMethod;
  destination?: 'root' | 'session' | 'workspace_chat';
  duration_ms?: number | null;
  entry_point?: 'first_task' | 'first_task_skip' | 'summary' | 'unknown';
  failure_code?: string;
  has_model?: boolean;
  has_session?: boolean;
  has_workspace?: boolean;
  initial_step?: DesktopOnboardingResumePhase;
  multi_workspace?: boolean;
  needs_model?: boolean;
  next_step?: DesktopOnboardingResumePhase | 'product';
  operation?: OnboardingOperation;
  project_kind?: DesktopOnboardingProjectSelection['kind'] | 'none';
  result?: 'cancelled' | 'imported' | 'not_found' | 'oauth_conflict' | 'passed';
  resumed?: boolean;
  retryable?: boolean;
  step?: DesktopOnboardingResumePhase | 'unknown';
  step_count?: number;
  step_index?: number | null;
}

type AnalyticsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function getSessionStorage(): AnalyticsStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function getOrCreateDesktopOnboardingFlowId(
  storage: AnalyticsStorage | null = getSessionStorage(),
  createId: () => string = uuidv4
): string {
  try {
    const existing = storage?.getItem(FLOW_ID_STORAGE_KEY);
    if (existing) return existing;
    const created = createId();
    storage?.setItem(FLOW_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return createId();
  }
}

export function clearDesktopOnboardingFlowId(
  storage: AnalyticsStorage | null = getSessionStorage()
): void {
  try {
    storage?.removeItem(FLOW_ID_STORAGE_KEY);
  } catch {
    // Analytics storage is best-effort and must never affect product entry.
  }
}

interface OnboardingAnalyticsContextValue {
  enabled: boolean;
  flowId: string;
  capture: (
    event: DesktopOnboardingAnalyticsEvent,
    properties?: DesktopOnboardingTraceProperties
  ) => void;
  clearFlow: () => void;
  now: () => number;
  durationSince: (startedAtMs: number) => number | null;
}

const DISABLED_ONBOARDING_ANALYTICS: OnboardingAnalyticsContextValue = {
  enabled: false,
  flowId: 'disabled',
  capture: () => undefined,
  clearFlow: () => undefined,
  now: getPerformanceNowMs,
  durationSince: getDurationSinceMs,
};

const OnboardingAnalyticsContext = createContext<OnboardingAnalyticsContextValue>(
  DISABLED_ONBOARDING_ANALYTICS
);

export function OnboardingAnalyticsProvider({ children }: { children: ReactNode }) {
  const postHog = usePostHog();
  const enabled = usePlatformCapability('telemetry');
  const [flowId] = useState(() =>
    enabled ? getOrCreateDesktopOnboardingFlowId() : DISABLED_ONBOARDING_ANALYTICS.flowId
  );
  const capture = useCallback<OnboardingAnalyticsContextValue['capture']>(
    (event, properties) => {
      if (!enabled) return;
      try {
        capturePostHogEvent(postHog, event, {
          flow_id: flowId,
          flow_schema_version: 2,
          ...properties,
        });
      } catch (error) {
        console.warn('[onboarding] Analytics capture failed:', error);
      }
    },
    [enabled, flowId, postHog]
  );
  const value = useMemo<OnboardingAnalyticsContextValue>(
    () => ({
      enabled,
      flowId,
      capture,
      clearFlow: clearDesktopOnboardingFlowId,
      now: getPerformanceNowMs,
      durationSince: getDurationSinceMs,
    }),
    [capture, enabled, flowId]
  );
  return (
    <OnboardingAnalyticsContext.Provider value={value}>
      {children}
    </OnboardingAnalyticsContext.Provider>
  );
}

export function useOnboardingAnalytics(): OnboardingAnalyticsContextValue {
  return useContext(OnboardingAnalyticsContext);
}
