import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAtom } from 'jotai';
import { usePlatformCapability } from '@lody/platform/react';
import type { ManagedBuiltinAgentType } from '@lody/shared';
import {
  desktopOnboardingDraftAtom,
  desktopOnboardingPhaseAtom,
  type DesktopOnboardingResumePhase,
} from '@/atoms/onboarding';
import { getDesktopOnboardingSteps, OnboardingStepsProvider } from './onboarding-steps';
import { OnboardingCeremony } from './ceremony/ceremony';
import { useOnboardingAudio } from './ceremony/use-onboarding-audio';
import { OnboardingShellHost } from './onboarding-shell';
import { LoginScreen } from './screens/login-screen';
import { WorkspaceScreen } from './screens/workspace-screen';
import { ProvidersScreen } from './screens/providers-screen';
import { ProjectsScreen } from './screens/projects-screen';
import { FirstTaskScreen } from './screens/first-task-screen';
import { SummaryScreen } from './screens/summary-screen';
import { useOnboardingBuiltinRuntimePrefetch } from './use-onboarding-builtin-runtime-prefetch';

export type DesktopOnboardingCompletion = {
  sessionId?: string;
  workspaceSlug?: string;
};

export function resolveDesktopOnboardingPhase(
  phase: DesktopOnboardingResumePhase | null,
  input: { cloudAccount: boolean; multiWorkspace: boolean; hasAgent: boolean; hasProject: boolean }
): DesktopOnboardingResumePhase {
  if (!phase) return 'ceremony';
  if (phase === 'login' && !input.cloudAccount) return 'providers';
  if (phase === 'workspace' && !input.multiWorkspace) return 'providers';
  if (phase === 'firstTask' && (!input.hasAgent || !input.hasProject)) return 'projects';
  return phase;
}

export function OnboardingOverlay({
  onCompleted,
}: {
  onCompleted: (completion: DesktopOnboardingCompletion) => void;
}) {
  const cloudAccount = usePlatformCapability('cloudAccount');
  const multiWorkspace = usePlatformCapability('multiWorkspace');
  const [persistedPhase, setPersistedPhase] = useAtom(desktopOnboardingPhaseAtom);
  const [draft, setDraft] = useAtom(desktopOnboardingDraftAtom);
  const [preferredBuiltinRuntime, setPreferredBuiltinRuntime] =
    useState<ManagedBuiltinAgentType | null>(null);
  const onboardingAudio = useOnboardingAudio();
  const { stop: stopOnboardingAudio } = onboardingAudio;
  const audioHandoffStoppedRef = useRef(false);
  useOnboardingBuiltinRuntimePrefetch(preferredBuiltinRuntime);

  const steps = useMemo(
    () => getDesktopOnboardingSteps({ cloudAccount, multiWorkspace }),
    [cloudAccount, multiWorkspace]
  );
  const phase = resolveDesktopOnboardingPhase(persistedPhase, {
    cloudAccount,
    multiWorkspace,
    hasAgent: draft.agentConfigId !== null,
    hasProject: draft.project !== null,
  });
  const advanceTo = useCallback(
    (next: DesktopOnboardingResumePhase) => setPersistedPhase(next),
    [setPersistedPhase]
  );
  const goAfterCeremony = useCallback(
    () => advanceTo(cloudAccount ? 'login' : multiWorkspace ? 'workspace' : 'providers'),
    [advanceTo, cloudAccount, multiWorkspace]
  );
  const goAfterLogin = useCallback(
    () => advanceTo(multiWorkspace ? 'workspace' : 'providers'),
    [advanceTo, multiWorkspace]
  );
  const goBeforeProviders = useCallback(
    () => advanceTo(multiWorkspace ? 'workspace' : cloudAccount ? 'login' : 'ceremony'),
    [advanceTo, cloudAccount, multiWorkspace]
  );

  useEffect(() => {
    if (phase === 'ceremony') {
      audioHandoffStoppedRef.current = false;
      return undefined;
    }
    if (audioHandoffStoppedRef.current) return undefined;
    audioHandoffStoppedRef.current = true;
    stopOnboardingAudio(3.2);
    return undefined;
  }, [phase, stopOnboardingAudio]);

  const screens: Record<DesktopOnboardingResumePhase, ReactNode> = {
    ceremony: (
      <OnboardingCeremony
        key="ceremony"
        audio={onboardingAudio}
        playing
        onFinish={goAfterCeremony}
      />
    ),
    login: <LoginScreen key="login" onBack={() => advanceTo('ceremony')} onNext={goAfterLogin} />,
    workspace: (
      <WorkspaceScreen
        key="workspace"
        onBack={() => advanceTo(cloudAccount ? 'login' : 'ceremony')}
        onNext={() => advanceTo('providers')}
      />
    ),
    providers: (
      <ProvidersScreen
        key="providers"
        onBack={goBeforeProviders}
        onSkip={() => advanceTo('summary')}
        onNext={(agentConfigId) => {
          setDraft((previous) => ({ ...previous, agentConfigId }));
          advanceTo('projects');
        }}
        onManagedRuntimeSelected={setPreferredBuiltinRuntime}
      />
    ),
    projects: (
      <ProjectsScreen
        key="projects"
        onBack={() => advanceTo('providers')}
        onComplete={(project) => {
          setDraft((previous) => ({ ...previous, project }));
          advanceTo(project.kind === 'local' && draft.agentConfigId ? 'firstTask' : 'summary');
        }}
      />
    ),
    firstTask:
      draft.agentConfigId && draft.project ? (
        <FirstTaskScreen
          key="firstTask"
          agentConfigId={draft.agentConfigId}
          project={draft.project}
          onBack={() => advanceTo('projects')}
          onContinue={() => onCompleted({})}
          onSessionStarted={onCompleted}
        />
      ) : null,
    summary: (
      <SummaryScreen
        key="summary"
        hasAgent={draft.agentConfigId !== null}
        onBack={() => advanceTo(draft.project ? 'projects' : 'providers')}
        onComplete={() => onCompleted({})}
      />
    ),
  };

  return (
    <OnboardingStepsProvider steps={phase === 'summary' ? [...steps, 'summary'] : steps}>
      <div className="fixed inset-0 z-40 overflow-hidden bg-[#f7f5f2] text-slate-950">
        {phase === 'ceremony' ? (
          <div className="absolute inset-0 z-10">{screens[phase]}</div>
        ) : (
          <div className="absolute inset-0 z-10">
            <OnboardingShellHost>{screens[phase]}</OnboardingShellHost>
          </div>
        )}
      </div>
    </OnboardingStepsProvider>
  );
}
