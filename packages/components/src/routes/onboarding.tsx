import { useCallback, useRef } from 'react';
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
import { useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { desktopOnboardingDraftAtom, desktopOnboardingPhaseAtom } from '@/atoms/onboarding';
import { currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { OnboardingOverlay, type DesktopOnboardingCompletion } from '@/components/onboarding';
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
  const completionPending = useRef(false);
  const completeThemeLifecycle = useOnboardingThemeLifecycle();

  const complete = useCallback(
    (completion: DesktopOnboardingCompletion) => {
      if (completionPending.current) return;
      completionPending.current = true;
      void (async () => {
        const result = await getIpcServices()?.app.completeOnboarding();
        if (!result?.ok) {
          completionPending.current = false;
          toast.error(
            result?.message ?? t('onboarding.completion.failed', 'Could not finish desktop setup.')
          );
          return;
        }
        completeThemeLifecycle();
        setPhase(null);
        setDraft({ provider: null, project: null });
        const targetWorkspace = completion.workspaceSlug ?? workspaceSlug;
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
      })().catch((error: unknown) => {
        completionPending.current = false;
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [completeThemeLifecycle, navigate, setDraft, setPhase, t, workspaceSlug]
  );

  if (!isElectronRenderer()) return <Navigate to="/" replace />;
  return <OnboardingOverlay onCompleted={complete} />;
}
