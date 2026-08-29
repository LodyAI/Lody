import { useTranslation } from 'react-i18next';
import { CheckCircle2 } from 'lucide-react';
import { OnboardingBackButton, OnboardingNextButton, OnboardingShell } from '../onboarding-shell';

export function SummaryScreen({
  hasAgent,
  onBack,
  onComplete,
}: {
  hasAgent: boolean;
  onBack: () => void;
  onComplete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <OnboardingShell
      stepKey="summary"
      title={
        hasAgent
          ? t('onboarding.summary.title', 'Lody is ready')
          : t('onboarding.summary.exploreTitle', 'Explore Lody')
      }
      description={
        hasAgent
          ? t(
              'onboarding.summary.description',
              'You can add providers and projects later from Settings.'
            )
          : t(
              'onboarding.summary.exploreDescription',
              'Enter Lody now and connect a coding agent from Settings when you are ready.'
            )
      }
      secondaryAction={<OnboardingBackButton onClick={onBack} />}
      primaryAction={
        <OnboardingNextButton
          finish
          onClick={onComplete}
          label={
            hasAgent
              ? t('onboarding.summary.open', 'Open Lody')
              : t('onboarding.summary.enter', 'Enter Lody')
          }
        />
      }
    >
      <div className="flex min-h-48 items-center justify-center">
        <CheckCircle2 className="size-16 text-primary" />
      </div>
    </OnboardingShell>
  );
}
