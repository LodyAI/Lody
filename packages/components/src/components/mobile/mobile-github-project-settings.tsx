import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Loader2, Wrench } from 'lucide-react';
import { useGithubProjectWorktreeAdmin } from '@/hooks/use-github-project-worktree-admin';
import type { ProjectSkillsSource } from '@/hooks/use-project-skills';
import { MobileSettingsRow, MobileSettingsSection } from '@/components/mobile/mobile-settings-row';
import { MobileWorktreeConfigSheet } from '@/components/mobile/mobile-worktree-config-sheet';
import { MobileProjectSkillsRow } from '@/components/mobile/mobile-project-skills-sheet';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';

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
        <div className="flex items-center justify-center gap-2 px-4 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('workspace.projects.loading', 'Loading')}
        </div>
      </MobileSettingsSection>
    );
  }

  if (!row) {
    return (
      <MobileSettingsSection title={t('workspace.projects.worktreeSetupTitle', 'Worktree')}>
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">
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
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Wrench className="h-[1.05rem] w-[1.05rem]" />
              </div>
              <span className="truncate text-[0.95rem] font-medium leading-tight">
                {t('workspace.projects.worktreeConfigRow', 'Worktree setup & cleanup')}
              </span>
            </div>
          }
          onClick={() => setSheetOpen(true)}
          trailing={<ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />}
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
