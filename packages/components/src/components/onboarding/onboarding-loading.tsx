import { useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { motion, useReducedMotion } from 'framer-motion';
import * as stylex from '@stylexjs/stylex';
import type { CliRuntimeStartupStage, ElectronCliPhase, ElectronCliState } from '@lody/shared';
import { getIpcServices, onIpcEvent, sendIpc } from '@/lib/electron-ipc-client';
import lodyLogo from '@/assets/lody-icon.png';
import { onboardingLoadingSurface } from './onboarding-loading.surface';

const STARTUP_STAGES: CliRuntimeStartupStage[] = [
  'bootstrap',
  'auth',
  'sync-time',
  'fleet-start',
  'ready',
];

export interface OnboardingLoadingViewProps {
  /** Current CLI phase ('starting' until the runtime reaches 'running'). */
  phase: ElectronCliPhase;
  /** Current startup stage. Falls back to 'bootstrap' when undefined. */
  stage?: CliRuntimeStartupStage;
  /** True after the bypass timer fires — surface a softer message. */
  bypassed?: boolean;
}

export function OnboardingLoadingView({
  phase,
  stage = 'bootstrap',
  bypassed = false,
}: OnboardingLoadingViewProps) {
  const { t } = useTranslation();
  const shouldReduceMotion = useReducedMotion();

  const reachedIndex = useMemo(() => {
    if (phase === 'running') return STARTUP_STAGES.length - 1;
    return STARTUP_STAGES.indexOf(stage);
  }, [phase, stage]);

  const stageLabel = (s: CliRuntimeStartupStage) =>
    t(`onboarding.loading.stage.${s}`, defaultStageLabel(s));

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
      {...stylex.props(onboardingLoadingSurface.stack)}
    >
      <div {...stylex.props(onboardingLoadingSurface.markBox)}>
        <motion.div
          aria-hidden
          animate={{ scale: [1, 1.15, 1], opacity: [0.4, 0.15, 0.4] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
          {...stylex.props(onboardingLoadingSurface.glow)}
        />
        <motion.div
          aria-hidden
          animate={{ scale: [1, 1.35, 1], opacity: [0.25, 0, 0.25] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'easeOut' }}
          {...stylex.props(onboardingLoadingSurface.pulseRing)}
        />
        <motion.img
          src={lodyLogo}
          alt="Lody"
          animate={{ y: [0, -4, 0] }}
          transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
          {...stylex.props(onboardingLoadingSurface.logo)}
          draggable={false}
        />
      </div>

      <div {...stylex.props(onboardingLoadingSurface.copy)}>
        <h2 {...stylex.props(onboardingLoadingSurface.title)}>
          {bypassed
            ? t('onboarding.loading.titleBypassed', 'Almost ready')
            : t('onboarding.loading.title', 'Preparing your workspace')}
        </h2>
        <p {...stylex.props(onboardingLoadingSurface.subtitle)}>
          {bypassed ? (
            <Trans
              i18nKey="onboarding.loading.bypassHint"
              defaults="Continuing — the CLI is taking longer than expected."
            />
          ) : (
            <Trans
              i18nKey="onboarding.loading.subtitle"
              defaults="Spinning up the local agent runtime…"
            />
          )}
        </p>
      </div>

      <ul {...stylex.props(onboardingLoadingSurface.stages)}>
        {STARTUP_STAGES.map((s, i) => {
          const reached = i <= reachedIndex;
          const active = i === reachedIndex && phase !== 'running';
          const stalledProbe = bypassed && active && i < STARTUP_STAGES.length - 1;
          return (
            <li
              key={s}
              {...stylex.props(
                onboardingLoadingSurface.stage,
                reached
                  ? onboardingLoadingSurface.stageReached
                  : onboardingLoadingSurface.stagePending
              )}
            >
              <motion.span
                {...stylex.props(
                  onboardingLoadingSurface.dot,
                  active
                    ? stalledProbe || shouldReduceMotion
                      ? onboardingLoadingSurface.dotActive
                      : onboardingLoadingSurface.dotPulsing
                    : reached
                      ? onboardingLoadingSurface.dotDone
                      : onboardingLoadingSurface.dotPending
                )}
                data-onboarding-stalled-probe={stalledProbe ? '' : undefined}
                animate={
                  stalledProbe && !shouldReduceMotion
                    ? { y: 7, scaleY: 1.35, opacity: 0.68 }
                    : { y: 0, scaleY: 1, opacity: 1 }
                }
                transition={
                  stalledProbe && !shouldReduceMotion
                    ? {
                        type: 'spring',
                        stiffness: 190,
                        damping: 9,
                        mass: 0.55,
                        repeat: Infinity,
                        repeatType: 'reverse',
                        repeatDelay: 0.35,
                      }
                    : { duration: 0.2 }
                }
                aria-hidden
              />
              <span>{stageLabel(s)}</span>
            </li>
          );
        })}
      </ul>
    </motion.div>
  );
}

interface OnboardingLoadingProps {
  /** Called when CLI reports `phase === 'running'` (or after bypass timeout). */
  onReady: () => void;
  /** Hard-cap (ms) — proceed even if CLI hasn't reported ready, with a warning. */
  bypassAfterMs?: number;
}

// Falls open immediately on non-electron renderers so the rest of the flow
// can proceed.
export function OnboardingLoading({ onReady, bypassAfterMs = 45_000 }: OnboardingLoadingProps) {
  const [state, setState] = useState<ElectronCliState | null>(null);
  const [bypassed, setBypassed] = useState(false);

  useEffect(() => {
    if (!getIpcServices()) {
      onReady();
      return undefined;
    }

    let cancelled = false;
    let resolved = false;
    const bypassTimer =
      bypassAfterMs > 0
        ? window.setTimeout(() => {
            if (cancelled || resolved) return;
            resolved = true;
            setBypassed(true);
            onReady();
          }, bypassAfterMs)
        : null;

    const resolveReady = () => {
      if (resolved) return;
      resolved = true;
      if (bypassTimer !== null) window.clearTimeout(bypassTimer);
      onReady();
    };

    sendIpc('cli.subscribe', null);
    void getIpcServices()!
      .cli.getState()
      .then((s) => {
        if (cancelled) return;
        setState(s);
        if (s.phase === 'running') resolveReady();
      })
      .catch((error: unknown) => {
        console.error('[onboarding] Failed to read local CLI startup state:', error);
      });

    const unsubscribe = onIpcEvent('cli.state', (s) => {
      if (cancelled) return;
      setState(s);
      if (s.phase === 'running') resolveReady();
    });

    return () => {
      cancelled = true;
      if (bypassTimer !== null) window.clearTimeout(bypassTimer);
      unsubscribe();
    };
  }, [bypassAfterMs, onReady]);

  return (
    <OnboardingLoadingView
      phase={state?.phase ?? 'starting'}
      stage={state?.startupStage}
      bypassed={bypassed}
    />
  );
}

function defaultStageLabel(stage: CliRuntimeStartupStage): string {
  switch (stage) {
    case 'bootstrap':
      return 'Bootstrapping environment';
    case 'auth':
      return 'Verifying credentials';
    case 'sync-time':
      return 'Syncing server time';
    case 'fleet-start':
      return 'Starting agent fleet';
    case 'ready':
      return 'Ready';
    default:
      return stage;
  }
}
