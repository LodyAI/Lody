import { useCallback, useRef } from 'react';
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { desktopOnboardingDraftAtom, desktopOnboardingPhaseAtom } from '@/atoms/onboarding';
import { currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { OnboardingOverlay, type DesktopOnboardingCompletion } from '@/components/onboarding';
import { enterDesktopProduct } from '@/components/onboarding/desktop-onboarding-completion';
import { useOnboardingThemeLifecycle } from '@/components/onboarding/use-onboarding-theme-lifecycle';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';

export const Route = createFileRoute('/onboarding')({
  component: DesktopOnboardingRoute,
});

function DesktopOnboardingRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const setPhase = useSetAtom(desktopOnboardingPhaseAtom);
  const setDraft = useSetAtom(desktopOnboardingDraftAtom);
  const inFlightCompletion = useRef<Promise<boolean> | null>(null);
  const completeThemeLifecycle = useOnboardingThemeLifecycle();

  const complete = useCallback(
    (completion: DesktopOnboardingCompletion): Promise<boolean> => {
      // Concurrent triggers (double click, Skip racing Run) share one attempt;
      // a settled attempt clears the ref so a failure stays retryable.
      if (inFlightCompletion.current) return inFlightCompletion.current;
      const targetWorkspace = completion.workspaceSlug ?? workspaceSlug;
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
        onProductEntered: completeThemeLifecycle,
        onDurableCompletion: () => {
          setPhase(null);
          setDraft({ provider: null, project: null });
        },
        onPersistenceFailure: (error) => {
          console.error('Failed to persist desktop onboarding completion', error);
          toast.error(
            t(
              'onboarding.completion.persistenceFailed',
              'Desktop setup could not be saved. Product entry will continue, but setup may appear again after restarting.'
            )
          );
        },
        onNavigationFailure: (error) => {
          toast.error(error instanceof Error ? error.message : String(error));
        },
      }).finally(() => {
        inFlightCompletion.current = null;
      });
      inFlightCompletion.current = attempt;
      return attempt;
    },
    [completeThemeLifecycle, navigate, setDraft, setPhase, t, workspaceSlug]
  );

  if (!isElectronRenderer()) return <Navigate to="/" replace />;
  return <OnboardingOverlay onCompleted={complete} />;
}
