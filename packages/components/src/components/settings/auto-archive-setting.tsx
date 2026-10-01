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
        'Archive keeps chats and local branches, but the owning machine may remove the worktree. Files ignored by Git or changed/deleted by cleanup scripts may be lost. Save important files outside the worktree first. These rules run only here, for your sessions.'
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
