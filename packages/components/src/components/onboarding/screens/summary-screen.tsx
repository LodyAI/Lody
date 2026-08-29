import { useTranslation } from 'react-i18next';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { OnboardingBackButton, OnboardingNextButton, OnboardingShell } from '../onboarding-shell';

export type OnboardingSummaryAgentState = 'ready' | 'preparing' | 'missing';

export function SummaryScreen({
  agentState,
  onBack,
  onComplete,
}: {
  agentState: OnboardingSummaryAgentState;
  onBack: () => void;
  onComplete: () => void;
}) {
  const { t } = useTranslation();
  const title =
    agentState === 'ready'
      ? t('onboarding.summary.title', 'Lody is ready')
      : agentState === 'preparing'
        ? t('onboarding.summary.preparingTitle', 'Your Agent is getting ready')
        : t('onboarding.summary.exploreTitle', 'Explore Lody');
  const description =
    agentState === 'ready'
      ? t(
          'onboarding.summary.description',
          'You can add providers and projects later from Settings.'
        )
      : agentState === 'preparing'
        ? t(
            'onboarding.summary.preparingDescription',
            'Runtime downloads continue in the background. Enter Lody now and start once setup finishes.'
          )
        : t(
            'onboarding.summary.exploreDescription',
            'Enter Lody now and connect a coding agent from Settings when you are ready.'
          );

  return (
    <OnboardingShell
      stepKey="summary"
      title={title}
      description={description}
      secondaryAction={<OnboardingBackButton onClick={onBack} />}
      primaryAction={
        <OnboardingNextButton
          finish
          onClick={onComplete}
          label={
            agentState === 'ready'
              ? t('onboarding.summary.open', 'Open Lody')
              : t('onboarding.summary.enter', 'Enter Lody')
          }
        />
      }
    >
      <div className="flex min-h-48 items-center justify-center">
        {agentState === 'preparing' ? (
          <Loader2 className="size-16 animate-spin text-primary" />
        ) : (
          <CheckCircle2 className="size-16 text-primary" />
        )}
      </div>
    </OnboardingShell>
  );
}
