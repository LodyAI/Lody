import { jotaiStore } from '@/lib/utils';
import {
  desktopOnboardingPhaseAtom,
  normalizeDesktopOnboardingPhase,
  type DesktopOnboardingResumePhase,
} from '@/atoms/onboarding';

export type OnboardingDevApi = {
  status: () => { phase: DesktopOnboardingResumePhase | null };
  restart: (phase?: DesktopOnboardingResumePhase) => void;
  goto: (phase: DesktopOnboardingResumePhase) => void;
  finish: () => void;
  phases: readonly DesktopOnboardingResumePhase[];
};

const PHASES = [
  'arrive',
  'account',
  'model',
  'start',
] as const satisfies readonly DesktopOnboardingResumePhase[];

function makeApi(): OnboardingDevApi {
  return {
    phases: PHASES,
    status: () => ({
      phase: normalizeDesktopOnboardingPhase(jotaiStore.get(desktopOnboardingPhaseAtom)),
    }),
    restart: (phase = 'arrive') => {
      jotaiStore.set(desktopOnboardingPhaseAtom, phase);
    },
    goto: (phase) => {
      jotaiStore.set(desktopOnboardingPhaseAtom, phase);
    },
    finish: () => {
      jotaiStore.set(desktopOnboardingPhaseAtom, null);
    },
  };
}

export function installOnboardingDevApi(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as { lodyOnboarding?: OnboardingDevApi }).lodyOnboarding = makeApi();
}
