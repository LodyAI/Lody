import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import lodyIcon from '@/assets/lody-icon.png';
import { OnboardingNextButton, OnboardingShell } from '../onboarding-shell';

const styles = stylex.create({
  stage: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '208px',
    paddingBlock: space[6],
  },
  mark: { width: '112px', height: '112px', objectFit: 'contain' },
});

export function CeremonyScreen({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  return (
    <OnboardingShell
      stepKey="ceremony"
      eyebrow={t('onboarding.ceremony.eyebrow', 'Welcome')}
      title={t('onboarding.ceremony.title', 'Set up Lody')}
      description={t(
        'onboarding.ceremony.description',
        'Connect an agent and a project, then start your first real session.'
      )}
      primaryAction={
        <OnboardingNextButton
          onClick={onNext}
          label={t('onboarding.ceremony.start', 'Get started')}
        />
      }
    >
      <div {...stylex.props(styles.stage)}>
        <img src={lodyIcon} alt="" {...stylex.props(styles.mark)} />
      </div>
    </OnboardingShell>
  );
}
