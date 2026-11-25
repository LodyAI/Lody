import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { LayoutGroup } from 'framer-motion';
import { useAtom } from 'jotai';
import { usePlatformCapability } from '@lody/platform/react';
import {
  desktopOnboardingDraftAtom,
  desktopOnboardingPhaseAtom,
  normalizeDesktopOnboardingPhase,
  type DesktopOnboardingAccountChip,
  type DesktopOnboardingResumePhase,
} from '@/atoms/onboarding';
import { WindowDragStrip } from '@/ui/window-drag-region';
import { useOnboardingAudio } from './ceremony/use-onboarding-audio';
import {
  useOnboardingAnalytics,
  type DesktopOnboardingTraceProperties,
} from './onboarding-analytics';
import { OnboardingChipRail } from './onboarding-chip-rail';
import { getDesktopOnboardingSteps, OnboardingStepsProvider } from './onboarding-steps';
import { AccountScreen } from './screens/account-screen';
import { ContinuousEditorialStage } from './screens/arrive-screen';
import { ModelScreen } from './screens/model-screen';
import { StartScreen } from './screens/start-screen';
import { flatSurface } from './shared/flat-surface.stylex';
import {
  useSorbetOnboardingController,
  type ConnectedModelPayload,
} from './shared/sorbet-onboarding-controller';

const styles = stylex.create({
  dragStrip: { zIndex: 30 },
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 40,
    overflow: 'hidden',
    backgroundColor: '#FAF9F6',
    color: '#141413',
  },
  screen: {
    position: 'absolute',
    inset: 0,
    zIndex: 10,
  },
});

export type DesktopOnboardingCompletion = {
  sessionId?: string;
  workspaceSlug?: string;
  entryPoint?: 'first_task' | 'first_task_skip' | 'summary';
  sourceStep?: DesktopOnboardingResumePhase;
  sourceStepDurationMs?: number | null;
};

export function resolveDesktopOnboardingPhase(
  rawPhase: string | null | undefined,
  input: {
    cloudAccount: boolean;
    needsModel: boolean;
    revisitingStep?: 'account' | 'model' | null;
  }
): DesktopOnboardingResumePhase {
  const phase = normalizeDesktopOnboardingPhase(rawPhase);
  if (!phase) return 'arrive';
  if (phase === 'account' && !input.cloudAccount) {
    return input.needsModel ? 'model' : 'start';
  }
  if (phase === 'model' && !input.needsModel && input.revisitingStep !== 'model') {
    return 'start';
  }
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
  const [revisitingStep, setRevisitingStep] = useState<'account' | 'model' | null>(null);
  const [exitingToProduct, setExitingToProduct] = useState(false);

  const onboardingAudio = useOnboardingAudio();
  const { stop: stopOnboardingAudio } = onboardingAudio;
  const analytics = useOnboardingAnalytics();
  const sorbetController = useSorbetOnboardingController();

  // Compute `needsModel` from Sorbet's own ArrivalProbe upfront (§2 & §4) and lock
  // the initial step list once probed so step count never jumps mid-flow.
  const [lockedNeedsModel, setLockedNeedsModel] = useState<boolean | null>(null);
  useEffect(() => {
    if (lockedNeedsModel === null && sorbetController.probe !== null) {
      setLockedNeedsModel(sorbetController.probe.model.kind === 'none');
    }
  }, [lockedNeedsModel, sorbetController.probe]);

  const needsModel =
    lockedNeedsModel ?? (sorbetController.probe?.model.kind !== 'ready' && !draft.modelChip);

  // Hydrate top-rail modelChip when Sorbet already had credentials on ArrivalProbe!
  useEffect(() => {
    if (sorbetController.probe?.model.kind === 'ready' && !draft.modelChip) {
      const ready = sorbetController.probe.model;
      setDraft((prev) => ({
        ...prev,
        modelChip: {
          providerId: ready.provider,
          providerName: ready.providerName,
          modelSelector: ready.model,
          modelName: ready.modelName,
          source: ready.source,
        },
      }));
    }
  }, [draft.modelChip, setDraft, sorbetController.probe]);

  const steps = useMemo(
    () => getDesktopOnboardingSteps({ cloudAccount, needsModel }),
    [cloudAccount, needsModel]
  );

  const phase = resolveDesktopOnboardingPhase(persistedPhase, {
    cloudAccount,
    needsModel,
    revisitingStep,
  });

  const stepStartedAtRef = useRef(analytics.now());
  const flowStartedCapturedRef = useRef(false);
  const viewedPhaseRef = useRef<DesktopOnboardingResumePhase | null>(null);
  const audioStoppedRef = useRef(false);

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
      setRevisitingStep(null);
      captureStepExit(action, next, properties);
      setPersistedPhase(next);
    },
    [captureStepExit, setPersistedPhase]
  );

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
          needs_model: needsModel,
        }
      );
    }
    if (viewedPhaseRef.current === phase) return;
    viewedPhaseRef.current = phase;
    stepStartedAtRef.current = analytics.now();
    const stepIndex = steps.indexOf(phase);
    analytics.capture('onboarding/step_viewed', {
      step: phase,
      step_index: stepIndex === -1 ? null : stepIndex + 1,
      step_count: steps.length,
      has_model: Boolean(draft.modelChip || sorbetController.probe?.model.kind === 'ready'),
      project_kind: draft.project?.kind ?? 'none',
    });
  }, [
    analytics,
    cloudAccount,
    draft.modelChip,
    draft.project?.kind,
    multiWorkspace,
    needsModel,
    persistedPhase,
    phase,
    sorbetController.probe?.model.kind,
    steps,
  ]);

  // Fade out the procedural Ceremony score once leaving `arrive` + `account`.
  useEffect(() => {
    if (phase === 'arrive') {
      audioStoppedRef.current = false;
      return;
    }
    if (phase !== 'account' && !audioStoppedRef.current) {
      audioStoppedRef.current = true;
      stopOnboardingAudio(2.4);
    }
  }, [phase, stopOnboardingAudio]);

  // `Esc` returns to the previous editable step (`account` or `model`) per §6.3.
  useEffect(() => {
    if (phase === 'arrive' || exitingToProduct) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('[role="dialog"], [role="listbox"], [role="menu"]')) return;

      if (phase === 'start') {
        if (needsModel || draft.modelChip) {
          event.preventDefault();
          setRevisitingStep('model');
          captureStepExit('back', 'model');
          setPersistedPhase('model');
          return;
        }
        if (cloudAccount) {
          event.preventDefault();
          setRevisitingStep('account');
          captureStepExit('back', 'account');
          setPersistedPhase('account');
        }
      } else if (phase === 'model' && cloudAccount) {
        event.preventDefault();
        setRevisitingStep('account');
        captureStepExit('back', 'account');
        setPersistedPhase('account');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    captureStepExit,
    cloudAccount,
    draft.modelChip,
    exitingToProduct,
    needsModel,
    phase,
    setPersistedPhase,
  ]);

  const handleFinishArrive = useCallback(() => {
    const next: DesktopOnboardingResumePhase = cloudAccount
      ? 'account'
      : needsModel
        ? 'model'
        : 'start';
    advanceTo(next, 'continue');
  }, [advanceTo, cloudAccount, needsModel]);

  const handleAccountCompleted = useCallback(
    (chip: DesktopOnboardingAccountChip) => {
      setDraft((prev) => ({ ...prev, accountChip: chip }));
      const hasModelNow =
        Boolean(draft.modelChip) || sorbetController.probe?.model.kind === 'ready';
      const next: DesktopOnboardingResumePhase =
        needsModel && !hasModelNow ? 'model' : 'start';
      advanceTo(next, 'authenticated', { has_workspace: true });
    },
    [advanceTo, draft.modelChip, needsModel, setDraft, sorbetController.probe?.model.kind]
  );

  const handleModelConnected = useCallback(
    (payload: ConnectedModelPayload) => {
      setDraft((prev) => ({
        ...prev,
        modelChip: {
          providerId: payload.providerId,
          providerName: payload.providerName,
          modelSelector: payload.modelSelector,
          modelName: payload.modelName,
          source: payload.source,
        },
        agentConfigId: null,
      }));
    },
    [setDraft]
  );

  const handleSelectChipPhase = useCallback(
    (targetPhase: 'account' | 'model') => {
      if (targetPhase === phase) return;
      setRevisitingStep(targetPhase);
      captureStepExit('back', targetPhase);
      setPersistedPhase(targetPhase);
    },
    [captureStepExit, phase, setPersistedPhase]
  );

  const finishProductEntry = useCallback(
    async (
      entryPoint: NonNullable<DesktopOnboardingCompletion['entryPoint']>,
      sessionId?: string
    ): Promise<boolean> => {
      stopOnboardingAudio(0.6);
      const ok = await onCompleted({
        ...(sessionId ? { sessionId } : {}),
        ...(draft.accountChip?.workspaceSlug
          ? { workspaceSlug: draft.accountChip.workspaceSlug }
          : {}),
        entryPoint,
        sourceStep: phase,
        sourceStepDurationMs: analytics.durationSince(stepStartedAtRef.current),
      });
      if (!ok) {
        setExitingToProduct(false);
      }
      return ok;
    },
    [analytics, draft.accountChip?.workspaceSlug, onCompleted, phase, stopOnboardingAudio]
  );

  return (
    <OnboardingStepsProvider steps={steps}>
      <LayoutGroup id="lody-onboarding-stage">
        <div {...stylex.props(styles.overlay, flatSurface.onboardingLightScope)}>
          <WindowDragStrip xstyle={styles.dragStrip} />

          <OnboardingChipRail
            currentPhase={phase}
            accountChip={draft.accountChip}
            modelChip={draft.modelChip}
            exitingToProduct={exitingToProduct}
            onSelectPhase={handleSelectChipPhase}
          />

          <div {...stylex.props(styles.screen)}>
            {phase === 'arrive' || phase === 'account' ? (
              <ContinuousEditorialStage
                mode={phase}
                audio={onboardingAudio}
                onFinishArrive={handleFinishArrive}
                accountContent={
                  phase === 'account' ? (
                    <AccountScreen
                      revisiting={revisitingStep === 'account'}
                      onCompleted={handleAccountCompleted}
                    />
                  ) : null
                }
              />
            ) : phase === 'model' ? (
              <ModelScreen
                onConnected={(payload, method) => {
                  handleModelConnected(payload);
                  advanceTo('start', 'continue', {
                    connection_method: method,
                    has_model: true,
                  });
                }}
                onSkip={() => {
                  advanceTo('start', 'skip', {
                    connection_method: 'skip',
                    has_model: false,
                  });
                }}
              />
            ) : (
              <StartScreen
                project={draft.project}
                modelChip={draft.modelChip}
                selectedAgentConfigId={draft.agentConfigId}
                exitingToProduct={exitingToProduct}
                onProjectChange={(project) =>
                  setDraft((prev) => ({ ...prev, project }))
                }
                onModelConnected={handleModelConnected}
                onAgentConfigChange={(agentConfigId) =>
                  setDraft((prev) => ({ ...prev, agentConfigId }))
                }
                onBeginExitTransition={() => setExitingToProduct(true)}
                onEnterWithSession={(sessionId) =>
                  finishProductEntry('first_task', sessionId)
                }
                onExploreFirst={() => finishProductEntry('first_task_skip')}
              />
            )}
          </div>
        </div>
      </LayoutGroup>
    </OnboardingStepsProvider>
  );
}
