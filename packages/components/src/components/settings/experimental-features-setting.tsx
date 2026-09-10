import { useAtom, useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { Switch } from '@lody/ui/switch';
import {
  experimentalFeaturesEnabledAtom,
  reviewAgentExperimentEnabledAtom,
} from '@/atoms/settings';
import { CompactRow, CompactSection } from './compact-layout';

/**
 * User-facing experimental features.
 *
 * Unlike the Developer-mode beta section, the master switch is always visible:
 * a feature nobody can find is a feature nobody evaluates. Turning the master
 * switch off hides the list but keeps each opt-in, so flipping it back on
 * restores the previous choices rather than silently resetting them.
 */
export function ExperimentalFeaturesSection() {
  const { t } = useTranslation();
  const [experimentalEnabled, setExperimentalEnabled] = useAtom(experimentalFeaturesEnabledAtom);
  const [reviewAgentEnabled, setReviewAgentEnabled] = useAtom(reviewAgentExperimentEnabledAtom);

  return (
    <CompactSection title={t('settings.experimental.title', 'Experimental features')}>
      <CompactRow
        label={t('settings.experimental.enable', 'Enable experimental features')}
        helper={t(
          'settings.experimental.enableHelper',
          'Show features that are still being built. They can change or break.'
        )}
      >
        <Switch
          checked={experimentalEnabled}
          onCheckedChange={setExperimentalEnabled}
          aria-label={t('settings.experimental.enable', 'Enable experimental features')}
        />
      </CompactRow>

      {experimentalEnabled ? (
        <CompactRow
          label={t('settings.experimental.reviewAgent', 'Review agent')}
          helper={t(
            'settings.experimental.reviewAgentHelper',
            'Let a review agent check a branch, hand fixes back to the session, and merge once CI is green. You choose per session.'
          )}
        >
          <Switch
            checked={reviewAgentEnabled}
            onCheckedChange={setReviewAgentEnabled}
            aria-label={t('settings.experimental.reviewAgent', 'Review agent')}
          />
        </CompactRow>
      ) : null}
    </CompactSection>
  );
}

/** Whether any experimental feature row should render. */
export function useHasExperimentalFeatures(): boolean {
  return useAtomValue(experimentalFeaturesEnabledAtom);
}
