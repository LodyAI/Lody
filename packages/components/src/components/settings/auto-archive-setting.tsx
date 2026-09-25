import { useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { autoArchiveOnPrClosedAtom, autoArchiveOnPrMergedAtom } from '@/atoms';
import { Switch } from '@lody/ui/switch';
import { CompactRow, CompactSection } from './compact-layout';

export function AutoArchiveSection() {
  const { t } = useTranslation();
  const [onPrMerged, setOnPrMerged] = useAtom(autoArchiveOnPrMergedAtom);
  const [onPrClosed, setOnPrClosed] = useAtom(autoArchiveOnPrClosedAtom);

  return (
    <CompactSection
      title={t('settings.autoArchive.title', 'Auto-archive sessions')}
      description={t(
        'settings.autoArchive.description',
        'Automatically archive a session conversation when one of the following happens. Applies to sessions you own and only on this device.'
      )}
    >
      <CompactRow label={t('settings.autoArchive.onPrMerged', 'When the PR is merged')}>
        <Switch checked={onPrMerged} onCheckedChange={setOnPrMerged} />
      </CompactRow>
      <CompactRow label={t('settings.autoArchive.onPrClosed', 'When the PR is closed')}>
        <Switch checked={onPrClosed} onCheckedChange={setOnPrClosed} />
      </CompactRow>
    </CompactSection>
  );
}
