import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { usePlatformCapability } from '@lody/platform/react';
import type { AgentConfigMeta, ManagedBuiltinAgentType, ProviderSetupTask } from '@lody/shared';
import {
  desktopOnboardingDraftAtom,
  desktopOnboardingPhaseAtom,
  type DesktopOnboardingProviderSelection,
  type DesktopOnboardingResumePhase,
} from '@/atoms/onboarding';
import { getAllAgentConfigAtom, getAllProviderSetupsAtom } from '@/atoms/agents';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
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
import { WindowDragStrip } from '@/ui/window-drag-region';

export type DesktopOnboardingCompletion = {
  sessionId?: string;
  workspaceSlug?: string;
};

export function resolveDesktopOnboardingSummaryAgent(
  provider: DesktopOnboardingProviderSelection | null,
  providerSetups: readonly ProviderSetupTask[],
  agentConfigs: readonly AgentConfigMeta[]
): {
  state: 'ready' | 'preparing' | 'failed' | 'missing';
  name: string | undefined;
} {
  if (provider?.kind === 'agentConfig') {
    const publishedConfig = agentConfigs.find((config) => config.id === provider.agentConfigId);
    return publishedConfig
      ? { state: 'ready', name: publishedConfig.name }
      : { state: 'missing', name: provider.agentName };
  }
  if (provider?.kind !== 'providerSetup') return { state: 'missing', name: undefined };

  const publishedConfig = agentConfigs.find((config) => config.id === provider.providerSetupId);
  if (publishedConfig) return { state: 'ready', name: publishedConfig.name };
  const setup = providerSetups.find((candidate) => candidate.id === provider.providerSetupId);
  if (!setup) return { state: 'missing', name: provider.agentName };
  return {
    state: setup.status === 'failed' ? 'failed' : 'preparing',
    name: provider.agentName,
  };
}

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
  /** Resolves to whether product navigation succeeded; native persistence never gates it. */
  onCompleted: (completion: DesktopOnboardingCompletion) => Promise<boolean>;
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
    hasAgent: draft.provider?.kind === 'agentConfig',
    hasProject: draft.project !== null,
  });
  const visibleSteps = useMemo(
    () =>
      phase === 'summary' || draft.provider?.kind === 'providerSetup'
        ? steps.map((step) => (step === 'firstTask' ? 'summary' : step))
        : steps,
    [draft.provider?.kind, phase, steps]
  );
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

  // The summary must tell the truth about a pending setup: a failed task is
  // not "still progressing", and a deleted one is no longer pending at all.
  // A successful setup is REPLACED by a published AgentConfig under the same
  // id, so the config check must come first or success reads as "missing".
  const providerSetups = useAtomValue(getAllProviderSetupsAtom);
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const selectedSetupId =
    draft.provider?.kind === 'providerSetup' ? draft.provider.providerSetupId : null;
  const localMachineId = useAtomValue(localMachineIdAtom);
  const selectedSetupMachineIds = useMemo(
    () => (selectedSetupId !== null && localMachineId !== null ? [localMachineId] : []),
    [localMachineId, selectedSetupId]
  );
  useMachineFlockAgentConfigsForMachineIds(selectedSetupMachineIds);
  const summaryAgent = resolveDesktopOnboardingSummaryAgent(
    draft.provider,
    providerSetups,
    agentConfigs
  );
  const failedProviderSetup =
    selectedSetupId === null
      ? undefined
      : providerSetups.find((setup) => setup.id === selectedSetupId && setup.status === 'failed');

  useEffect(() => {
    if (!failedProviderSetup) return;
    console.error('[onboarding] Agent setup failed:', {
      id: failedProviderSetup.id,
      machineId: failedProviderSetup.machineId,
      agentName: failedProviderSetup.config.name,
      failureCode: failedProviderSetup.failureCode,
      attempt: failedProviderSetup.attempt,
    });
  }, [failedProviderSetup]);

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
        onSkip={() => {
          setDraft({ provider: null, project: null });
          advanceTo('summary');
        }}
        onNext={(provider) => {
          setDraft({ provider, project: null });
          advanceTo('projects');
        }}
        onManagedRuntimeSelected={setPreferredBuiltinRuntime}
      />
    ),
    projects: (
      <ProjectsScreen
        key="projects"
        onBack={() => advanceTo('providers')}
        onSkip={() => {
          setDraft((previous) => ({ ...previous, project: null }));
          advanceTo('summary');
        }}
        onComplete={(project) => {
          setDraft((previous) => ({ ...previous, project }));
          advanceTo(
            project.kind === 'local' && draft.provider?.kind === 'agentConfig'
              ? 'firstTask'
              : 'summary'
          );
        }}
      />
    ),
    firstTask:
      draft.provider?.kind === 'agentConfig' && draft.project ? (
        <FirstTaskScreen
          key="firstTask"
          agentConfigId={draft.provider.agentConfigId}
          project={draft.project}
          onBack={() => advanceTo('projects')}
          onAgentConfigChange={(config) => {
            setDraft((previous) => ({
              ...previous,
              provider: {
                kind: 'agentConfig',
                agentConfigId: config.id,
                agentName: config.name,
              },
            }));
          }}
          onSkip={() => {
            void onCompleted({});
          }}
          onContinue={() => {
            return onCompleted({});
          }}
        />
      ) : null,
    summary: (
      <SummaryScreen
        key="summary"
        agentState={summaryAgent.state}
        agentName={summaryAgent.name}
        projectName={draft.project?.name}
        onBack={() => advanceTo(draft.project ? 'projects' : 'providers')}
        onComplete={() => {
          void onCompleted({});
        }}
      />
    ),
  };

  return (
    <OnboardingStepsProvider steps={visibleSteps}>
      <div className="fixed inset-0 z-40 overflow-hidden bg-[#f7f5f2] text-slate-950">
        <WindowDragStrip className="z-30" />
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
