import { createContext, createElement, useContext, type ReactNode } from 'react';

export const ALL_ONBOARDING_STEPS = ['arrive', 'account', 'model', 'start'] as const;

export type OnboardingStepKey = (typeof ALL_ONBOARDING_STEPS)[number];

/**
 * Resolves the exact Desktop Onboarding step path upfront (§2):
 *
 * - Cloud · no Sorbet credentials: `['arrive', 'account', 'model', 'start']`
 * - Cloud · Sorbet has credentials: `['arrive', 'account', 'start']`
 * - OSS local · no Sorbet credentials: `['arrive', 'model', 'start']`
 * - OSS local · Sorbet has credentials: `['arrive', 'start']`
 */
export function getDesktopOnboardingSteps(input: {
  cloudAccount: boolean;
  needsModel: boolean;
}): readonly OnboardingStepKey[] {
  return [
    'arrive',
    ...(input.cloudAccount ? (['account'] as const) : []),
    ...(input.needsModel ? (['model'] as const) : []),
    'start',
  ];
}

const OnboardingStepsContext = createContext<readonly OnboardingStepKey[]>(ALL_ONBOARDING_STEPS);

export function OnboardingStepsProvider({
  steps,
  children,
}: {
  steps: readonly OnboardingStepKey[];
  children: ReactNode;
}) {
  return createElement(OnboardingStepsContext.Provider, { value: steps }, children);
}

export function useOnboardingSteps(): readonly OnboardingStepKey[] {
  return useContext(OnboardingStepsContext);
}

export function useOnboardingStepPosition(step: OnboardingStepKey): {
  current: number;
  total: number;
} {
  const steps = useContext(OnboardingStepsContext);
  const index = steps.indexOf(step);
  return {
    current: index === -1 ? 1 : index + 1,
    total: steps.length,
  };
}
