import { useCallback, useRef } from 'react';
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { desktopOnboardingDraftAtom, desktopOnboardingPhaseAtom } from '@/atoms/onboarding';
import { currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { OnboardingOverlay, type DesktopOnboardingCompletion } from '@/components/onboarding';
import { enterDesktopProduct } from '@/components/onboarding/desktop-onboarding-completion';
import {
  OnboardingAnalyticsProvider,
  useOnboardingAnalytics,
  type DesktopOnboardingTraceProperties,
} from '@/components/onboarding/onboarding-analytics';
import { useOnboardingThemeLifecycle } from '@/components/onboarding/use-onboarding-theme-lifecycle';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';

export const Route = createFileRoute('/onboarding')({
  component: DesktopOnboardingRoute,
});

function DesktopOnboardingRoute() {
  if (!isElectronRenderer()) return <Navigate to="/" replace />;
  return (
    <OnboardingAnalyticsProvider>
      <DesktopOnboardingExperience />
    </OnboardingAnalyticsProvider>
  );
}

function DesktopOnboardingExperience() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const setPhase = useSetAtom(desktopOnboardingPhaseAtom);
  const setDraft = useSetAtom(desktopOnboardingDraftAtom);
  const inFlightCompletion = useRef<Promise<boolean> | null>(null);
  const completeThemeLifecycle = useOnboardingThemeLifecycle();
  const analytics = useOnboardingAnalytics();

  const complete = useCallback(
    (completion: DesktopOnboardingCompletion): Promise<boolean> => {
      // Concurrent triggers (double click, Skip racing Run) share one attempt;
      // a settled attempt clears the ref so a failure stays retryable.
      if (inFlightCompletion.current) return inFlightCompletion.current;
      const targetWorkspace = completion.workspaceSlug ?? workspaceSlug;
      const destination = completion.sessionId
        ? 'session'
        : targetWorkspace
          ? 'workspace_chat'
          : 'root';
      const startedAtMs = analytics.now();
      const eventProperties: DesktopOnboardingTraceProperties = {
        entry_point: completion.entryPoint ?? 'unknown',
        destination,
        has_session: Boolean(completion.sessionId),
        has_workspace: Boolean(targetWorkspace),
      };
      analytics.capture('onboarding/completion_started', eventProperties);
      const attempt = enterDesktopProduct({
        persistCompletion: () => getIpcServices()?.app.completeOnboarding(),
        navigate: async () => {
          if (targetWorkspace && completion.sessionId) {
            await navigate({
              to: '/$workspaceName/sessions/$sessionId',
              params: { workspaceName: targetWorkspace, sessionId: completion.sessionId },
              replace: true,
            });
            return;
          }
          if (targetWorkspace) {
            await navigate({
              to: '/$workspaceName/chat',
              params: { workspaceName: targetWorkspace },
              replace: true,
            });
            return;
          }
          await navigate({ to: '/', replace: true });
        },
        onProductEntered: () => {
          completeThemeLifecycle();
          analytics.capture('onboarding/step_exited', {
            step: completion.sourceStep ?? 'unknown',
            next_step: 'product',
            action: 'complete',
            entry_point: completion.entryPoint ?? 'unknown',
            duration_ms: completion.sourceStepDurationMs ?? null,
          });
          analytics.capture('onboarding/completion_succeeded', {
            ...eventProperties,
            duration_ms: analytics.durationSince(startedAtMs),
          });
        },
        onDurableCompletion: () => {
          analytics.capture('onboarding/flow_completed', eventProperties);
          analytics.clearFlow();
          setPhase(null);
          setDraft({ provider: null, project: null });
        },
        onPersistenceFailure: (error) => {
          console.error('Failed to persist desktop onboarding completion', error);
          analytics.capture('onboarding/persistence_failed', {
            ...eventProperties,
            failure_code: error === undefined ? 'completion_ipc_unavailable' : 'persistence_failed',
          });
          toast.error(
            t(
              'onboarding.completion.persistenceFailed',
              'Desktop setup could not be saved. Product entry will continue, but setup may appear again after restarting.'
            )
          );
        },
        onNavigationFailure: (error) => {
          console.error('[onboarding] Failed to enter the product:', error);
          analytics.capture('onboarding/completion_failed', {
            ...eventProperties,
            failure_code: 'navigation_failed',
            duration_ms: analytics.durationSince(startedAtMs),
          });
          toast.error(error instanceof Error ? error.message : String(error));
        },
      }).finally(() => {
        inFlightCompletion.current = null;
      });
      inFlightCompletion.current = attempt;
      return attempt;
    },
    [analytics, completeThemeLifecycle, navigate, setDraft, setPhase, t, workspaceSlug]
  );

  return <OnboardingOverlay onCompleted={complete} />;
}
