import { useAtom, useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { Switch } from '@lody/ui/switch';
import { experimentalFeaturesEnabledAtom } from '@/atoms/settings';
import { CompactRow, CompactSection } from './compact-layout';

/**
 * User-facing experimental features.
 *
 * Unlike the Developer-mode beta section, the master switch is always visible.
 * It does not control developer-only features.
 */
export function ExperimentalFeaturesSection() {
  const { t } = useTranslation();
  return (
    <CompactSection title={t('settings.experimental.title', 'Experimental features')}>
      <ExperimentalFeatureRows />
    </CompactSection>
  );
}

/** The user-facing experimental features master switch. */
export function ExperimentalFeatureRows() {
  const { t } = useTranslation();
  const [experimentalEnabled, setExperimentalEnabled] = useAtom(experimentalFeaturesEnabledAtom);

  return (
    <CompactRow label={t('settings.experimental.enable', 'Enable experimental features')}>
      <Switch
        checked={experimentalEnabled}
        onCheckedChange={setExperimentalEnabled}
        aria-label={t('settings.experimental.enable', 'Enable experimental features')}
      />
    </CompactRow>
  );
}

/** Whether any experimental feature row should render. */
export function useHasExperimentalFeatures(): boolean {
  return useAtomValue(experimentalFeaturesEnabledAtom);
}
