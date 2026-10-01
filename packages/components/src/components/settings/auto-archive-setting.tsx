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
        'This device automatically archives sessions you own when a PR status changes. Conversation history and local branches are kept. The owning machine can remove managed worktrees after committing non-ignored changes; ignored files and files removed by cleanup scripts are not backed up. Save needed files outside the worktree first.'
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
