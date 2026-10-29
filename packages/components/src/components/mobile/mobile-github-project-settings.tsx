import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Wrench } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { useGithubProjectWorktreeAdmin } from '@/hooks/use-github-project-worktree-admin';
import type { ProjectSkillsSource } from '@/hooks/use-project-skills';
import { MobileSettingsRow, MobileSettingsSection } from '@/components/mobile/mobile-settings-row';
import { MobileWorktreeConfigSheet } from '@/components/mobile/mobile-worktree-config-sheet';
import { MobileProjectSkillsRow } from '@/components/mobile/mobile-project-skills-sheet';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { mobileSurface } from './surface';

export type MobileGithubProjectSettingsProps = {
  /** "owner/repo" — the workspace repo whose worktree scripts we're editing. */
  repoFullName: string;
};

/**
 * Per-repo settings rendered inside the mobile GitHub-project detail page's
 * Settings tab. Mirrors `MobileLocalProjectSettings`: the first level shows a
 * single "Worktree setup & cleanup" row; tapping it opens the editors in a
 * bottom sheet. GitHub repos can be cloned on either OS, so the sheet omits a
 * fixed shell and the editors render Bash / PowerShell tabs.
 */
export function MobileGithubProjectSettings({ repoFullName }: MobileGithubProjectSettingsProps) {
  const { t } = useTranslation();
  const { workspaceId } = useResolvedWorkspaceScope();
  const { rowByRepoFullName, isLoading, onWorktreeSetupChange, onWorktreeCleanupChange } =
    useGithubProjectWorktreeAdmin();
  const row = rowByRepoFullName.get(repoFullName) ?? null;
  const [sheetOpen, setSheetOpen] = useState(false);
  const skillsSource: ProjectSkillsSource | null = workspaceId
    ? { kind: 'github', workspaceId, repoFullName }
    : null;

  if (isLoading && !row) {
    return (
      <MobileSettingsSection title={t('workspace.projects.worktreeSetupTitle', 'Worktree')}>
        <div {...stylex.props(mobileSurface.notice)}>
          <Spinner diameter="calc(var(--spacing) * 4)" />
          {t('workspace.projects.loading', 'Loading')}
        </div>
      </MobileSettingsSection>
    );
  }

  if (!row) {
    return (
      <MobileSettingsSection title={t('workspace.projects.worktreeSetupTitle', 'Worktree')}>
        <div {...stylex.props(mobileSurface.empty)}>
          <p {...stylex.props(mobileSurface.emptyText)}>
            {t('workspace.projects.githubRepoNotAvailable', '此仓库在当前工作区不可用')}
          </p>
        </div>
      </MobileSettingsSection>
    );
  }

  return (
    <>
      <MobileSettingsSection title={t('workspace.projects.worktreeSetupTitle', 'Worktree')}>
        <MobileSettingsRow
          label={
            <div {...stylex.props(mobileSurface.identity)}>
              <div {...stylex.props(mobileSurface.identityTile)}>
                <Wrench {...stylex.props(mobileSurface.identityGlyph)} />
              </div>
              <span
                {...stylex.props(mobileSurface.identityLabel, mobileSurface.identityLabelTight)}
              >
                {t('workspace.projects.worktreeConfigRow', 'Worktree setup & cleanup')}
              </span>
            </div>
          }
          onClick={() => setSheetOpen(true)}
          trailing={<ChevronRight {...stylex.props(mobileSurface.chevron)} />}
        />
      </MobileSettingsSection>

      <MobileProjectSkillsRow source={skillsSource} />

      <MobileWorktreeConfigSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        setupConfig={row.worktreeSetup}
        cleanupConfig={row.worktreeCleanup}
        isSetupSaving={row.isWorktreeSetupSaving}
        setupError={row.worktreeSetupError}
        isCleanupSaving={row.isWorktreeCleanupSaving}
        cleanupError={row.worktreeCleanupError}
        onSetupSave={(config) => onWorktreeSetupChange(repoFullName, config)}
        onCleanupSave={(config) => onWorktreeCleanupChange(repoFullName, config)}
      />
    </>
  );
}
