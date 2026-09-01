import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { usePlatformCapability } from '@lody/platform/react';
import type { AgentConfigMeta, ManagedBuiltinAgentType, ProviderSetupTask } from '@lody/shared';
import {
  desktopOnboardingDraftAtom,
  desktopOnboardingPhaseAtom,
  type DesktopOnboardingProviderSelection,
  type DesktopOnboardingResumePhase,
} from '@/atoms/onboarding';
import {
  cmdRetryProviderSetupAtom,
  getAllAgentConfigAtom,
  getAllProviderSetupsAtom,
} from '@/atoms/agents';
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
import {
  useOnboardingAnalytics,
  type DesktopOnboardingTraceProperties,
} from './onboarding-analytics';
import { WindowDragStrip } from '@/ui/window-drag-region';

export type DesktopOnboardingCompletion = {
  sessionId?: string;
  workspaceSlug?: string;
  entryPoint?: 'first_task' | 'first_task_skip' | 'summary';
  sourceStep?: DesktopOnboardingResumePhase;
  sourceStepDurationMs?: number | null;
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
  const analytics = useOnboardingAnalytics();
  const { stop: stopOnboardingAudio } = onboardingAudio;
  const audioHandoffStoppedRef = useRef(false);
  const providerSetupTraceRef = useRef<string | null>(null);
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
  const stepStartedAtRef = useRef(analytics.now());
  const flowStartedCapturedRef = useRef(false);
  const viewedPhaseRef = useRef<DesktopOnboardingResumePhase | null>(null);
  const captureStepExit = useCallback(
    (
      action: 'continue' | 'back' | 'skip' | 'authenticated' | 'complete',
      nextStep: DesktopOnboardingResumePhase | 'product',
      properties?: DesktopOnboardingTraceProperties
    ) => {
      analytics.capture('onboarding/step_exited', {
        step: phase,
        next_step: nextStep,
        action,
        duration_ms: analytics.durationSince(stepStartedAtRef.current),
        ...properties,
      });
    },
    [analytics, phase]
  );
  const advanceTo = useCallback(
    (
      next: DesktopOnboardingResumePhase,
      action: 'continue' | 'back' | 'skip' | 'authenticated' = 'continue',
      properties?: DesktopOnboardingTraceProperties
    ) => {
      captureStepExit(action, next, properties);
      setPersistedPhase(next);
    },
    [captureStepExit, setPersistedPhase]
  );
  const goAfterCeremony = useCallback(
    () =>
      advanceTo(cloudAccount ? 'login' : multiWorkspace ? 'workspace' : 'providers', 'continue'),
    [advanceTo, cloudAccount, multiWorkspace]
  );
  const goAfterLogin = useCallback(
    () => advanceTo(multiWorkspace ? 'workspace' : 'providers', 'authenticated'),
    [advanceTo, multiWorkspace]
  );
  const goBeforeProviders = useCallback(
    () => advanceTo(multiWorkspace ? 'workspace' : cloudAccount ? 'login' : 'ceremony', 'back'),
    [advanceTo, cloudAccount, multiWorkspace]
  );

  // The summary must tell the truth about a pending setup: a failed task is
  // not "still progressing", and a deleted one is no longer pending at all.
  // A successful setup is REPLACED by a published AgentConfig under the same
  // id, so the config check must come first or success reads as "missing".
  const providerSetups = useAtomValue(getAllProviderSetupsAtom);
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const retryProviderSetup = useSetAtom(cmdRetryProviderSetupAtom);
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
    if (!flowStartedCapturedRef.current) {
      flowStartedCapturedRef.current = true;
      analytics.capture(
        persistedPhase === null ? 'onboarding/flow_started' : 'onboarding/flow_resumed',
        {
          initial_step: phase,
          resumed: persistedPhase !== null,
          cloud_account: cloudAccount,
          multi_workspace: multiWorkspace,
        }
      );
    }
    if (viewedPhaseRef.current === phase) return;
    viewedPhaseRef.current = phase;
    stepStartedAtRef.current = analytics.now();
    const stepIndex = visibleSteps.indexOf(phase);
    analytics.capture('onboarding/step_viewed', {
      step: phase,
      step_index: stepIndex === -1 ? null : stepIndex + 1,
      step_count: visibleSteps.length,
      provider_selection_kind: draft.provider?.kind ?? 'none',
      project_kind: draft.project?.kind ?? 'none',
      agent_state: phase === 'summary' ? summaryAgent.state : undefined,
    });
  }, [
    analytics,
    cloudAccount,
    draft.project?.kind,
    draft.provider?.kind,
    multiWorkspace,
    persistedPhase,
    phase,
    summaryAgent.state,
    visibleSteps,
  ]);

  useEffect(() => {
    if (selectedSetupId === null) {
      providerSetupTraceRef.current = null;
      return;
    }
    const traceKey = `${selectedSetupId}:${summaryAgent.state}:${failedProviderSetup?.attempt ?? 0}`;
    if (providerSetupTraceRef.current === traceKey) return;
    providerSetupTraceRef.current = traceKey;
    if (summaryAgent.state === 'preparing') {
      analytics.capture('onboarding/operation_started', {
        step: phase,
        operation: 'agent_setup',
        attempt: failedProviderSetup?.attempt ?? null,
      });
      return;
    }
    if (summaryAgent.state === 'ready') {
      analytics.capture('onboarding/operation_succeeded', {
        step: phase,
        operation: 'agent_setup',
      });
      return;
    }
    if (failedProviderSetup) {
      console.error('[onboarding] Agent setup failed:', {
        id: failedProviderSetup.id,
        machineId: failedProviderSetup.machineId,
        agentName: failedProviderSetup.config.name,
        failureCode: failedProviderSetup.failureCode,
        attempt: failedProviderSetup.attempt,
      });
      analytics.capture('onboarding/operation_failed', {
        step: phase,
        operation: 'agent_setup',
        failure_code: failedProviderSetup.failureCode ?? 'agent_setup_failed',
        attempt: failedProviderSetup.attempt,
        retryable: true,
      });
      return;
    }
    analytics.capture('onboarding/operation_failed', {
      step: phase,
      operation: 'agent_setup',
      failure_code: 'agent_setup_missing',
      retryable: false,
    });
  }, [analytics, failedProviderSetup, phase, selectedSetupId, summaryAgent.state]);

  const completeOnboarding = useCallback(
    async (entryPoint: NonNullable<DesktopOnboardingCompletion['entryPoint']>) => {
      return onCompleted({
        entryPoint,
        sourceStep: phase,
        sourceStepDurationMs: analytics.durationSince(stepStartedAtRef.current),
      });
    },
    [analytics, onCompleted, phase]
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
    login: (
      <LoginScreen key="login" onBack={() => advanceTo('ceremony', 'back')} onNext={goAfterLogin} />
    ),
    workspace: (
      <WorkspaceScreen
        key="workspace"
        onBack={() => advanceTo(cloudAccount ? 'login' : 'ceremony', 'back')}
        onNext={() => advanceTo('providers')}
      />
    ),
    providers: (
      <ProvidersScreen
        key="providers"
        onBack={goBeforeProviders}
        onSkip={() => {
          setDraft({ provider: null, project: null });
          advanceTo('summary', 'skip', { provider_selection_kind: 'none' });
        }}
        onNext={(provider) => {
          setDraft({ provider, project: null });
          advanceTo('projects', 'continue', { provider_selection_kind: provider.kind });
        }}
        onManagedRuntimeSelected={setPreferredBuiltinRuntime}
      />
    ),
    projects: (
      <ProjectsScreen
        key="projects"
        onBack={() => advanceTo('providers', 'back')}
        onSkip={() => {
          setDraft((previous) => ({ ...previous, project: null }));
          advanceTo('summary', 'skip', { project_kind: 'none' });
        }}
        onComplete={(project) => {
          setDraft((previous) => ({ ...previous, project }));
          advanceTo(
            project.kind === 'local' && draft.provider?.kind === 'agentConfig'
              ? 'firstTask'
              : 'summary',
            'continue',
            { project_kind: project.kind }
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
          onBack={() => advanceTo('projects', 'back')}
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
            void completeOnboarding('first_task_skip');
          }}
          onContinue={() => {
            return completeOnboarding('first_task');
          }}
        />
      ) : null,
    summary: (
      <SummaryScreen
        key="summary"
        agentState={summaryAgent.state}
        agentName={summaryAgent.name}
        agentFailureCode={failedProviderSetup?.failureCode}
        projectName={draft.project?.name}
        onRetryAgent={
          failedProviderSetup ? () => retryProviderSetup(failedProviderSetup.id) : undefined
        }
        onBack={() => advanceTo(draft.project ? 'projects' : 'providers', 'back')}
        onComplete={() => {
          void completeOnboarding('summary');
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
