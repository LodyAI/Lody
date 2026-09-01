import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Folder, FolderOpen, FolderPlus, Github, Loader2 } from 'lucide-react';
import type { MachineId } from '@lody/shared';
import { Switch } from '@/ui/switch';
import { TooltipProvider } from '@/ui/tooltip';
import { cn } from '@/lib/utils';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { MobileSettingsRow, MobileSettingsSection } from '@/components/mobile/mobile-settings-row';
import { AgentIcon } from '@/components/icons/agent-icon';
import {
  getHistoryProviderLabel,
  ProjectHistoryImportPanel,
  type ProjectRowProps,
  type ProjectSettingsRow,
  type ProjectSettingsViewProps,
  WorktreeSetupEditor,
} from '@/components/settings/project-settings';

function MobileMachineHeading({ name, online }: { name: string; online: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          online
            ? 'bg-status-success ring-2 ring-status-success/20'
            : 'bg-muted-foreground/40 ring-2 ring-muted'
        )}
        title={
          online
            ? t('workspace.machines.online', 'Online')
            : t('workspace.machines.offline', 'Offline')
        }
      />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

export function MobileProjectSettings({
  sections,
  githubSections,
  isLoading,
  githubProjectsLoading,
  onSharedWithTeamChange,
  onSyncHistory,
  onImportHistory,
  onResolveHistoryConflict,
  onHistorySelectionChange,
  onWorktreeSetupChange,
  onWorktreeCleanupChange,
  onGithubWorktreeSetupChange,
  onGithubWorktreeCleanupChange,
  addableMachines,
  onAddLocalProject,
  initialMachineId,
  initialProjectKey,
}: ProjectSettingsViewProps) {
  const { t } = useTranslation();
  const onlineMachineIds = useOnlineMachineIds();

  const visibleSections = initialMachineId
    ? sections.filter((section) => section.machineId === initialMachineId)
    : sections;
  const orderedSections = initialProjectKey
    ? visibleSections.map((section) => ({
        ...section,
        rows: [...section.rows].sort((left, right) => {
          if (left.key === initialProjectKey) return -1;
          if (right.key === initialProjectKey) return 1;
          return 0;
        }),
      }))
    : visibleSections;
  const visibleGithubSections = initialMachineId ? [] : githubSections;
  const totalProjects = orderedSections.reduce((sum, section) => sum + section.rows.length, 0);
  const totalGithubProjects = visibleGithubSections.reduce(
    (sum, section) => sum + section.rows.length,
    0
  );
  const visibleAddableMachines = (addableMachines ?? []).filter(
    (machine) => !initialMachineId || machine.machineId === initialMachineId
  );
  const addableMachineIds = new Set(visibleAddableMachines.map((machine) => machine.machineId));
  /* Machine groups: the sections that have projects, then the machines the user
     may add a folder to but which have none yet — without them, an empty
     machine has no add entry point on mobile at all. */
  const machineGroups: { machineId: MachineId; machineName: string; rows: ProjectSettingsRow[] }[] =
    [
      ...orderedSections.map((section) => ({
        machineId: section.machineId,
        machineName: section.machineName,
        rows: section.rows,
      })),
      ...visibleAddableMachines
        .filter(
          (machine) => !orderedSections.some((section) => section.machineId === machine.machineId)
        )
        .map((machine) => ({
          machineId: machine.machineId,
          machineName: machine.machineName,
          rows: [],
        })),
    ];
  const useMachineHeadings = machineGroups.length > 1;
  const fallbackTitle = t('workspace.projects.title', 'Projects');
  const addFolderLabel = t('workspace.projects.addFolder', 'Add folder');

  if (
    (isLoading || githubProjectsLoading) &&
    totalProjects + totalGithubProjects === 0 &&
    machineGroups.length === 0
  ) {
    return (
      <MobileSettingsSection title={fallbackTitle}>
        <div className="flex items-center justify-center gap-2 px-4 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('workspace.projects.loading', 'Loading projects')}
        </div>
      </MobileSettingsSection>
    );
  }

  if (totalProjects + totalGithubProjects === 0 && machineGroups.length === 0) {
    return (
      <MobileSettingsSection title={fallbackTitle}>
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted/60">
            <FolderOpen className="h-4 w-4 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">
            {t('workspace.projects.empty', 'No projects yet')}
          </p>
        </div>
      </MobileSettingsSection>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      {machineGroups.map((group) => (
        <MobileSettingsSection
          key={group.machineId}
          title={
            useMachineHeadings ? (
              <MobileMachineHeading
                name={group.machineName}
                online={onlineMachineIds.has(group.machineId)}
              />
            ) : (
              fallbackTitle
            )
          }
        >
          {group.rows.map((row, rowIndex) => (
            <MobileProjectRow
              key={row.key}
              row={row}
              hasDivider={rowIndex > 0}
              onSharedWithTeamChange={onSharedWithTeamChange}
              onSyncHistory={onSyncHistory}
              onImportHistory={onImportHistory}
              onResolveHistoryConflict={onResolveHistoryConflict}
              onHistorySelectionChange={onHistorySelectionChange}
              onWorktreeSetupChange={onWorktreeSetupChange}
              onWorktreeCleanupChange={onWorktreeCleanupChange}
            />
          ))}
          {onAddLocalProject && addableMachineIds.has(group.machineId) ? (
            <MobileSettingsRow
              hasDivider={group.rows.length > 0}
              label={
                <span className="flex min-w-0 items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <FolderPlus className="h-[1.05rem] w-[1.05rem]" />
                  </span>
                  <span className="truncate text-[0.95rem] font-medium leading-tight text-foreground">
                    {addFolderLabel}
                  </span>
                </span>
              }
              onClick={() => onAddLocalProject(group.machineId)}
              trailing={<ChevronRight className="h-4 w-4" />}
            />
          ) : null}
        </MobileSettingsSection>
      ))}
      {visibleGithubSections.map((section) => (
        <MobileSettingsSection key={section.owner} title={`GitHub · ${section.owner}`}>
          {section.rows.map((row, rowIndex) => (
            <div key={row.key} className={cn(rowIndex > 0 && 'border-t border-border')}>
              <MobileSettingsRow
                label={
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Github className="h-[1.05rem] w-[1.05rem]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[0.95rem] font-medium leading-tight text-foreground">
                        {row.name}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-[0.72rem] leading-tight text-muted-foreground">
                        {row.repoFullName}
                      </p>
                    </div>
                  </div>
                }
              />
              <div className="mx-4 mb-3 flex flex-col gap-5">
                <WorktreeSetupEditor
                  phase="setup"
                  config={row.worktreeSetup}
                  isSaving={row.isWorktreeSetupSaving}
                  errorMessage={row.worktreeSetupError}
                  onSave={(config) => onGithubWorktreeSetupChange?.(row, config)}
                />
                <WorktreeSetupEditor
                  phase="cleanup"
                  config={row.worktreeCleanup}
                  isSaving={row.isWorktreeCleanupSaving}
                  errorMessage={row.worktreeCleanupError}
                  onSave={(config) => onGithubWorktreeCleanupChange?.(row, config)}
                />
              </div>
            </div>
          ))}
        </MobileSettingsSection>
      ))}
    </TooltipProvider>
  );
}

type MobileProjectRowProps = ProjectRowProps & {
  hasDivider: boolean;
};

function MobileProjectRow({
  row,
  hasDivider,
  onSharedWithTeamChange,
  onSyncHistory,
  onImportHistory,
  onResolveHistoryConflict,
  onHistorySelectionChange,
  onWorktreeSetupChange,
  onWorktreeCleanupChange,
}: MobileProjectRowProps) {
  const { t } = useTranslation();
  const visibleHistoryImports = row.historyImports.filter(
    (state) => state.canSync || state.catalog
  );
  const [activeProviderKey, setActiveProviderKey] = useState<string | null>(
    visibleHistoryImports[0]?.providerKey ?? null
  );
  const activeHistoryState =
    visibleHistoryImports.find((state) => state.providerKey === activeProviderKey) ??
    visibleHistoryImports[0] ??
    null;

  const label = (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Folder className="h-[1.05rem] w-[1.05rem]" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[0.95rem] font-medium leading-tight text-foreground">
          {row.project.name}
        </p>
        <p
          className="mt-0.5 truncate font-mono text-[0.72rem] leading-tight text-muted-foreground"
          title={row.project.rootPath}
        >
          {row.project.rootPath}
        </p>
      </div>
    </div>
  );

  const shareControl = (
    <div className="flex items-center gap-2">
      {row.isUpdating ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      ) : null}
      <Switch
        checked={row.sharedWithTeam}
        disabled={row.isUpdating || !row.canUpdateSharing || !onSharedWithTeamChange}
        title={
          row.canUpdateSharing
            ? undefined
            : t(
                'workspace.projects.sharePreparing',
                'Sharing will be available when this machine finishes connecting.'
              )
        }
        aria-label={t('workspace.projects.shareToggle', {
          defaultValue: 'Share project with team',
        })}
        onCheckedChange={(checked) => {
          void onSharedWithTeamChange?.(row, checked);
        }}
      />
    </div>
  );

  return (
    <div className={cn(hasDivider && 'border-t border-border')}>
      <MobileSettingsRow label={label}>{shareControl}</MobileSettingsRow>
      <div className="mx-4 mb-3 flex flex-col gap-5">
        <WorktreeSetupEditor
          phase="setup"
          config={row.worktreeSetup}
          shell={row.shell}
          isLoading={row.isWorktreeSetupLoading}
          isSaving={row.isWorktreeSetupSaving}
          errorMessage={row.worktreeSetupError}
          onSave={(config) => onWorktreeSetupChange?.(row, config)}
        />
        <WorktreeSetupEditor
          phase="cleanup"
          config={row.worktreeCleanup}
          shell={row.shell}
          isLoading={row.isWorktreeCleanupLoading}
          isSaving={row.isWorktreeCleanupSaving}
          errorMessage={row.worktreeCleanupError}
          onSave={(config) => onWorktreeCleanupChange?.(row, config)}
        />
      </div>
      {activeHistoryState ? (
        <div className="mx-4 mb-3 overflow-hidden rounded-xl border border-tab-border">
          {visibleHistoryImports.length > 1 ? (
            <div
              role="tablist"
              aria-label={t('workspace.projects.historyTablistLabel', 'History providers')}
              className="flex overflow-x-auto border-b border-tab-border bg-tab-bar"
            >
              {visibleHistoryImports.map((state) => {
                const active = state.providerKey === activeHistoryState.providerKey;
                const providerLabel = getHistoryProviderLabel(state.provider);
                return (
                  <button
                    key={state.providerKey}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={cn(
                      'relative flex h-9 shrink-0 cursor-pointer items-center gap-1.5 border-r border-tab-border px-3 text-xs transition-colors',
                      active
                        ? "bg-tab-active text-tab-active-foreground after:absolute after:inset-x-0 after:top-0 after:h-0.5 after:bg-tab-active-accent after:content-['']"
                        : 'bg-tab-inactive text-tab-inactive-foreground hover:bg-tab-hover hover:text-tab-hover-foreground'
                    )}
                    onClick={() => setActiveProviderKey(state.providerKey)}
                  >
                    <AgentIcon
                      cliType={state.provider.cliType}
                      agentType={state.provider.agentType}
                      className="h-3 w-3 opacity-60"
                    />
                    <span className="truncate">{providerLabel}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 border-b border-tab-border bg-tab-bar px-3 py-2 text-xs text-muted-foreground">
              <AgentIcon
                cliType={activeHistoryState.provider.cliType}
                agentType={activeHistoryState.provider.agentType}
                className="h-3 w-3 opacity-60"
              />
              <span className="truncate">
                {getHistoryProviderLabel(activeHistoryState.provider)}
              </span>
            </div>
          )}
          <ProjectHistoryImportPanel
            key={activeHistoryState.providerKey}
            row={row}
            state={activeHistoryState}
            onSyncHistory={onSyncHistory}
            onImportHistory={onImportHistory}
            onResolveHistoryConflict={onResolveHistoryConflict}
            onHistorySelectionChange={onHistorySelectionChange}
          />
        </div>
      ) : null}
    </div>
  );
}
