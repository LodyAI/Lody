import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useOpenSettings } from '@/hooks/use-open-settings';
import type { TFunction } from 'i18next';
import { formatDistanceToNow, type Locale } from 'date-fns';
import { enUS, zhCN } from 'date-fns/locale';
import {
  AlertCircle,
  Boxes,
  BrushCleaning,
  Download,
  ExternalLink,
  Folder,
  FolderPlus,
  FolderOpen,
  Github,
  Info,
  Loader2,
  MessagesSquare,
  Plus,
  RefreshCw,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import {
  getLocalProjectHistoryProviderKey,
  type LocalProjectHistoryCatalogItem,
  type LocalProjectHistoryCatalogResult,
  type LocalProjectHistoryProvider,
  type LocalProjectHistoryProviderKey,
  type LocalProjectHistorySyncSummary,
  type LocalProjectMeta,
  type MachineId,
  type WorktreeCleanupScriptConfig,
  type WorktreeSetupScriptConfig,
  type WorktreeSetupShell,
} from '@lody/shared';
import { useAtomValue } from 'jotai';
import {
  currentWorkspaceIdAtom,
  currentWorkspaceSlugAtom,
  settingsSelectedMachineIdAtom,
  settingsSelectedProjectKeyAtom,
} from '@/atoms';
import { useIsMobile } from '@/hooks/use-mobile';
import { useLocalProjectsAdmin } from '@/hooks/use-local-projects-admin';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { Button, type ButtonProps } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Switch } from '@/ui/switch';
import { CachedAvatarImg } from '@/components/cached-avatar-img';
import { getGitHubOwnerAvatarUrl } from '@/lib/github-avatar';
import { Textarea } from '@/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { MachinePills, type MachinePillItem } from './machine-pills';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import { toIntlLocale } from '@/lib/intl-locale';
import { openExternalUrl } from '@/lib/native-browser';
import { cn } from '@/lib/utils';
import { MobileProjectSettings } from '@/components/mobile/mobile-project-settings';
import { settingContainerClass } from '.';
import { AgentIcon, getAgentDisplayName } from '@/components/icons/agent-icon';
import { useSettingsDataCache } from './settings-data-cache';
import { useGithubProjectWorktreeSaves } from '@/hooks/use-github-project-worktree-admin';
import { AddLocalProjectDialogContainer } from '@/components/local-projects/add-local-project-dialog-container';
import { ProjectSkillsTab } from './project-skills-tab';
import type { ProjectSkillsSource } from '@/hooks/use-project-skills';
import { useAppCapability } from '@/lib/app-platform';
import { getVisibleLocalProjectHistoryFailures } from '@/lib/local-project-history-catalog';

export type ProjectSettingsRow = {
  key: string;
  machineId: MachineId;
  machineName: string;
  /** Shell this project's machine runs, probed from the machine OS. Local
     projects only edit this shell; the value drives which textarea we show. */
  shell: WorktreeSetupShell;
  project: LocalProjectMeta;
  sharedWithTeam: boolean;
  isUpdating: boolean;
  canUpdateSharing: boolean;
  worktreeSetup: WorktreeSetupScriptConfig;
  isWorktreeSetupLoading: boolean;
  isWorktreeSetupSaving: boolean;
  worktreeSetupError: string | null;
  worktreeCleanup: WorktreeCleanupScriptConfig;
  isWorktreeCleanupLoading: boolean;
  isWorktreeCleanupSaving: boolean;
  worktreeCleanupError: string | null;
  historyImports: ProjectHistoryImportState[];
};

export type ProjectHistoryImportState = {
  provider: LocalProjectHistoryProvider;
  providerKey: LocalProjectHistoryProviderKey;
  canSync: boolean;
  isSyncing: boolean;
  isImporting: boolean;
  catalog: LocalProjectHistoryCatalogResult | null;
  syncSummary: LocalProjectHistorySyncSummary | null;
  selectedSessionIds: string[];
  resolvingSessionIds: string[];
  errorMessage: string | null;
};

export type ProjectSettingsSection = {
  machineId: MachineId;
  machineName: string;
  rows: ProjectSettingsRow[];
};

export type GithubProjectSettingsRow = {
  key: string;
  owner: string;
  repoFullName: string;
  name: string;
  private: boolean;
  worktreeSetup: WorktreeSetupScriptConfig;
  isWorktreeSetupSaving: boolean;
  worktreeSetupError: string | null;
  worktreeCleanup: WorktreeCleanupScriptConfig;
  isWorktreeCleanupSaving: boolean;
  worktreeCleanupError: string | null;
};

export type GithubProjectSettingsSection = {
  owner: string;
  rows: GithubProjectSettingsRow[];
};

type ProjectSettingsSelection =
  | { key: string; kind: 'local'; row: ProjectSettingsRow }
  | { key: string; kind: 'github'; row: GithubProjectSettingsRow };

export type ProjectSettingsViewProps = {
  sections: ProjectSettingsSection[];
  githubSections: GithubProjectSettingsSection[];
  isLoading: boolean;
  githubProjectsLoading: boolean;
  initialMachineId?: MachineId | null;
  initialProjectKey?: string | null;
  onSharedWithTeamChange?: (row: ProjectSettingsRow, sharedWithTeam: boolean) => Promise<void>;
  onSyncHistory?: (row: ProjectSettingsRow, provider: LocalProjectHistoryProvider) => Promise<void>;
  onImportHistory?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider
  ) => Promise<void>;
  onResolveHistoryConflict?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider,
    session: LocalProjectHistoryCatalogItem
  ) => Promise<void>;
  onHistorySelectionChange?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider,
    selectedIds: string[]
  ) => void;
  onWorktreeSetupChange?: (
    row: ProjectSettingsRow,
    config: WorktreeSetupScriptConfig
  ) => Promise<void>;
  onWorktreeCleanupChange?: (
    row: ProjectSettingsRow,
    config: WorktreeCleanupScriptConfig
  ) => Promise<void>;
  onGithubWorktreeSetupChange?: (
    row: GithubProjectSettingsRow,
    config: WorktreeSetupScriptConfig
  ) => Promise<void>;
  onGithubWorktreeCleanupChange?: (
    row: GithubProjectSettingsRow,
    config: WorktreeCleanupScriptConfig
  ) => Promise<void>;
  onAddLocalProject?: () => void;
  onAddGitHubProject?: () => void;
};

const EMPTY_WORKTREE_SETUP: WorktreeSetupScriptConfig = {
  scripts: {},
};

export function sortProjectRows(rows: ProjectSettingsRow[]): ProjectSettingsRow[] {
  return [...rows].sort((left, right) => {
    const createdAtDiff = (left.project.createdAtMs ?? 0) - (right.project.createdAtMs ?? 0);
    if (createdAtDiff !== 0) return createdAtDiff;
    return left.project.name.localeCompare(right.project.name);
  });
}

export function sortGithubProjectRows(
  rows: GithubProjectSettingsRow[]
): GithubProjectSettingsRow[] {
  return [...rows].sort((left, right) => left.repoFullName.localeCompare(right.repoFullName));
}

/** Pill id for the GitHub group in the Projects pill row. */
const GITHUB_PILL_ID = '__github__';

export function getHistoryProviderLabel(provider: LocalProjectHistoryProvider): string {
  return getAgentDisplayName(provider.cliType, provider.agentType) ?? provider.agentType;
}

function getHistoryCatalogFromProject(
  project: LocalProjectMeta,
  provider: LocalProjectHistoryProvider
) {
  return project.history?.[getLocalProjectHistoryProviderKey(provider)];
}

function sortHistoryCatalogItems(
  sessions: LocalProjectHistoryCatalogItem[]
): LocalProjectHistoryCatalogItem[] {
  return [...sessions].sort((left, right) => {
    const leftUpdatedAt = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightUpdatedAt = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt - leftUpdatedAt;
    return left.title.localeCompare(right.title);
  });
}

export function catalogFromProject(
  project: LocalProjectMeta,
  provider: LocalProjectHistoryProvider
): LocalProjectHistoryCatalogResult | null {
  const catalog = getHistoryCatalogFromProject(project, provider);
  if (!catalog) return null;
  return {
    listed: Object.keys(catalog.sessions).length,
    lastListedAt: catalog.lastListedAt,
    sessions: sortHistoryCatalogItems(Object.values(catalog.sessions)),
  };
}

export function formatHistorySyncSummary(
  summary: LocalProjectHistorySyncSummary,
  t: TFunction
): string {
  return t('workspace.projects.historySyncSummary', {
    defaultValue:
      'Imported {{imported}}, refreshed {{refreshed}}, skipped {{skipped}}, conflicts {{conflicted}}, failed {{failed}}',
    imported: summary.imported,
    refreshed: summary.refreshed,
    skipped: summary.skipped,
    conflicted: summary.conflicted,
    failed: summary.failed,
  });
}

export function parseHistoryUpdatedAt(updatedAt: string | undefined): Date | null {
  if (!updatedAt) return null;
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

export function formatHistoryUpdatedAt(
  updatedAt: string | undefined,
  locale: Locale,
  t: TFunction
): string {
  const date = parseHistoryUpdatedAt(updatedAt);
  if (!date) {
    return t('workspace.projects.historyUnknownTime', 'Unknown time');
  }
  return formatDistanceToNow(date, { addSuffix: true, locale });
}

const historyActionButtonClass =
  'box-border h-7 min-h-7 bg-foreground/[0.06] px-2 py-0 text-xs leading-none text-foreground hover:bg-foreground/[0.1] [&_svg]:h-3.5 [&_svg]:w-3.5';

export function historyStateKey(projectKey: string, provider: LocalProjectHistoryProvider): string {
  return `${getLocalProjectHistoryProviderKey(provider)}:${projectKey}`;
}

export function ProjectSettingsComponent({
  initialMachineId,
  initialProjectKey,
}: {
  initialMachineId?: MachineId | null;
  initialProjectKey?: string | null;
} = {}) {
  const { openSettings } = useOpenSettings();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const modalMachineTarget = useAtomValue(settingsSelectedMachineIdAtom);
  const modalProjectTarget = useAtomValue(settingsSelectedProjectKeyAtom);
  const resolvedInitialMachineId =
    initialMachineId !== undefined ? initialMachineId : modalMachineTarget;
  const resolvedInitialProjectKey =
    initialProjectKey !== undefined ? initialProjectKey : modalProjectTarget;
  const [addLocalProjectDialogOpen, setAddLocalProjectDialogOpen] = useState(false);
  /* All state + handlers live in `useLocalProjectsAdmin` so the mobile
     per-project surface (`MobileLocalProjectSettings`) can drive the
     same data model without duplicating mutations / catalog state. */
  const {
    sections,
    isLoading,
    onSharedWithTeamChange,
    onSyncHistory,
    onImportHistory,
    onResolveHistoryConflict,
    onHistorySelectionChange,
    onWorktreeSetupChange,
    onWorktreeCleanupChange,
  } = useLocalProjectsAdmin();
  const { workspaceReposWithStatus, workspaceReposLoading } = useSettingsDataCache();
  const {
    setupSavingByKey: githubSetupSavingByKey,
    setupErrorByKey: githubSetupErrorByKey,
    cleanupSavingByKey: githubCleanupSavingByKey,
    cleanupErrorByKey: githubCleanupErrorByKey,
    onWorktreeSetupChange: saveGithubWorktreeSetup,
    onWorktreeCleanupChange: saveGithubWorktreeCleanup,
  } = useGithubProjectWorktreeSaves();

  const githubSections = useMemo(() => {
    const grouped = new Map<string, GithubProjectSettingsSection>();
    for (const repo of workspaceReposWithStatus ?? []) {
      const [owner] = repo.repoFullName.split('/');
      const ownerName = owner?.trim() || 'GitHub';
      const row: GithubProjectSettingsRow = {
        key: `github:${repo.repoFullName}`,
        owner: ownerName,
        repoFullName: repo.repoFullName,
        name: repo.name,
        private: repo.private,
        worktreeSetup: repo.worktreeSetup ?? EMPTY_WORKTREE_SETUP,
        isWorktreeSetupSaving: githubSetupSavingByKey[repo.repoFullName] === true,
        worktreeSetupError: githubSetupErrorByKey[repo.repoFullName] ?? null,
        worktreeCleanup: repo.worktreeCleanup ?? EMPTY_WORKTREE_SETUP,
        isWorktreeCleanupSaving: githubCleanupSavingByKey[repo.repoFullName] === true,
        worktreeCleanupError: githubCleanupErrorByKey[repo.repoFullName] ?? null,
      };
      const section = grouped.get(ownerName);
      if (section) {
        section.rows.push(row);
      } else {
        grouped.set(ownerName, { owner: ownerName, rows: [row] });
      }
    }
    return Array.from(grouped.values())
      .map((section) => ({ ...section, rows: sortGithubProjectRows(section.rows) }))
      .sort((left, right) => left.owner.localeCompare(right.owner));
  }, [
    githubCleanupErrorByKey,
    githubCleanupSavingByKey,
    githubSetupErrorByKey,
    githubSetupSavingByKey,
    workspaceReposWithStatus,
  ]);

  const onGithubWorktreeSetupChange = async (
    row: GithubProjectSettingsRow,
    config: WorktreeSetupScriptConfig
  ) => {
    await saveGithubWorktreeSetup(row.repoFullName, config);
  };

  const onGithubWorktreeCleanupChange = async (
    row: GithubProjectSettingsRow,
    config: WorktreeCleanupScriptConfig
  ) => {
    await saveGithubWorktreeCleanup(row.repoFullName, config);
  };

  const handleAddGitHubProject = useCallback(() => {
    if (!workspaceSlug) return;
    openSettings('github');
  }, [openSettings, workspaceSlug]);

  return (
    <>
      <ProjectSettingsView
        sections={sections}
        githubSections={githubSections}
        isLoading={isLoading}
        githubProjectsLoading={workspaceReposLoading}
        initialMachineId={resolvedInitialMachineId}
        initialProjectKey={resolvedInitialProjectKey}
        onSharedWithTeamChange={onSharedWithTeamChange}
        onSyncHistory={onSyncHistory}
        onImportHistory={onImportHistory}
        onResolveHistoryConflict={onResolveHistoryConflict}
        onHistorySelectionChange={onHistorySelectionChange}
        onWorktreeSetupChange={onWorktreeSetupChange}
        onWorktreeCleanupChange={onWorktreeCleanupChange}
        onGithubWorktreeSetupChange={onGithubWorktreeSetupChange}
        onGithubWorktreeCleanupChange={onGithubWorktreeCleanupChange}
        onAddLocalProject={() => setAddLocalProjectDialogOpen(true)}
        onAddGitHubProject={workspaceSlug ? handleAddGitHubProject : undefined}
      />
      <AddLocalProjectDialogContainer
        open={addLocalProjectDialogOpen}
        onOpenChange={setAddLocalProjectDialogOpen}
      />
    </>
  );
}

export function ProjectSettingsView(props: ProjectSettingsViewProps) {
  const isMobile = useIsMobile();
  return isMobile ? <MobileProjectSettings {...props} /> : <ProjectSettingsDesktop {...props} />;
}

function ProjectSettingsDesktop({
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
  onAddLocalProject,
  onAddGitHubProject,
  initialMachineId,
  initialProjectKey,
}: ProjectSettingsViewProps) {
  const { t } = useTranslation();
  const onlineMachineIds = useOnlineMachineIds();

  const totalProjects = sections.reduce((sum, section) => sum + section.rows.length, 0);
  const totalGithubProjects = githubSections.reduce((sum, section) => sum + section.rows.length, 0);
  const totalCount = totalProjects + totalGithubProjects;
  const isAnyLoading = isLoading || githubProjectsLoading;

  // Pills under the title: GitHub first (if any repos), then each machine that
  // has local projects. The selected pill drives the left project list.
  const pills = useMemo<MachinePillItem[]>(() => {
    const list: MachinePillItem[] = [];
    if (githubSections.length > 0) {
      list.push({
        id: GITHUB_PILL_ID,
        label: t('chat.contextSwitch.github', 'GitHub'),
        icon: <Github className="h-3.5 w-3.5" />,
      });
    }
    for (const section of sections) {
      list.push({
        id: section.machineId,
        label: section.machineName,
        online: onlineMachineIds.has(section.machineId),
      });
    }
    return list;
  }, [sections, githubSections, onlineMachineIds, t]);

  const [selectedPillId, setSelectedPillId] = useState<string | null>(
    () => initialMachineId ?? null
  );
  const resolvedPillId =
    selectedPillId && pills.some((pill) => pill.id === selectedPillId)
      ? selectedPillId
      : (pills[0]?.id ?? null);
  const isGithubPill = resolvedPillId === GITHUB_PILL_ID;

  const currentSelections = useMemo<ProjectSettingsSelection[]>(() => {
    if (resolvedPillId === GITHUB_PILL_ID) {
      return githubSections.flatMap((section) =>
        section.rows.map((row) => ({ key: row.key, kind: 'github' as const, row }))
      );
    }
    const section = sections.find((entry) => entry.machineId === resolvedPillId);
    return (section?.rows ?? []).map((row) => ({ key: row.key, kind: 'local' as const, row }));
  }, [resolvedPillId, sections, githubSections]);

  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(
    () => initialProjectKey ?? null
  );
  const selectedProject =
    currentSelections.find((selection) => selection.key === selectedProjectKey) ??
    currentSelections[0] ??
    null;

  const addProjectActions =
    onAddLocalProject || onAddGitHubProject ? (
      <ProjectAddMenu
        onAddLocalProject={onAddLocalProject}
        onAddGitHubProject={onAddGitHubProject}
        className="h-8 w-8 shrink-0 bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1]"
      />
    ) : null;

  const detailHandlers = {
    onSharedWithTeamChange,
    onSyncHistory,
    onImportHistory,
    onResolveHistoryConflict,
    onHistorySelectionChange,
    onWorktreeSetupChange,
    onWorktreeCleanupChange,
    onGithubWorktreeSetupChange,
    onGithubWorktreeCleanupChange,
  };

  return (
    <div className={cn(settingContainerClass, 'md:max-w-6xl')}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">
            {t('settings.tabs.projects', 'Projects')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(
              'workspace.projects.settingsSubtitle',
              'Local folders and GitHub repositories available in this workspace.'
            )}
          </p>
        </div>
        {addProjectActions}
      </div>

      {isAnyLoading && totalCount === 0 ? (
        <div className="flex items-center justify-center gap-2 px-3 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('workspace.projects.loading', 'Loading projects')}
        </div>
      ) : totalCount === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-3 py-12 text-center">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted/60">
            <FolderOpen className="h-4 w-4 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">
            {t('workspace.projects.empty', 'No projects yet')}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <MachinePills
            pills={pills}
            selectedId={resolvedPillId}
            onSelect={(id) => {
              setSelectedPillId(id);
              setSelectedProjectKey(null);
            }}
          />
          <div className="flex h-[calc(90vh-16rem)] min-h-[400px] min-w-0">
            <div className="scrollbar-pro w-[240px] shrink-0 overflow-y-auto border-r border-border/60 py-1 pr-2">
              {isGithubPill
                ? githubSections.map((section) => (
                    <div key={section.owner} className="mb-2">
                      <ProjectOwnerLabel owner={section.owner} />
                      {section.rows.map((row) => (
                        <ProjectMasterRow
                          key={row.key}
                          selected={selectedProject?.key === row.key}
                          icon={<OwnerAvatar owner={section.owner} />}
                          title={row.name}
                          subtitle={row.repoFullName}
                          onClick={() => setSelectedProjectKey(row.key)}
                        />
                      ))}
                    </div>
                  ))
                : currentSelections.map((selection) =>
                    selection.kind === 'local' ? (
                      <ProjectMasterRow
                        key={selection.key}
                        selected={selectedProject?.key === selection.key}
                        icon={<Folder className="h-3.5 w-3.5" />}
                        title={selection.row.project.name}
                        subtitle={selection.row.project.rootPath}
                        onClick={() => setSelectedProjectKey(selection.key)}
                      />
                    ) : null
                  )}
            </div>
            <div className="min-w-0 flex-1 overflow-hidden">
              {selectedProject ? (
                <ProjectDetailPane selection={selectedProject} {...detailHandlers} />
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                  {t('workspace.projects.selectPrompt', 'Select a project.')}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectMasterRow({
  selected,
  icon,
  title,
  subtitle,
  onClick,
}: {
  readonly selected: boolean;
  readonly icon: ReactNode;
  readonly title: string;
  readonly subtitle: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'mb-0.5 flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
        selected ? 'bg-foreground/[0.08] text-foreground' : 'text-foreground/90 hover:bg-hover/50'
      )}
    >
      <div className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-foreground/[0.05] text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-tight">{title}</div>
        <div className="truncate font-mono text-[11px] leading-tight text-muted-foreground">
          {subtitle}
        </div>
      </div>
    </button>
  );
}

function ProjectOwnerLabel({ owner }: { readonly owner: string }) {
  return <div className="px-1 text-[11px] font-medium text-muted-foreground">{owner}</div>;
}

function OwnerAvatar({ owner }: { readonly owner: string }) {
  // Use avatars.githubusercontent.com (CORS-enabled + already allowed by the
  // Electron img-src CSP) rather than github.com/<owner>.png, whose CORS-mode
  // cache fetch is rejected in Electron. Swap to the Github glyph on error.
  const [failed, setFailed] = useState(false);
  if (failed || !owner) {
    return <Github className="h-3.5 w-3.5 text-muted-foreground" />;
  }
  return (
    <CachedAvatarImg
      src={getGitHubOwnerAvatarUrl(owner)}
      alt={owner}
      loading="lazy"
      className="h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}

function ProjectAddMenu({
  onAddLocalProject,
  onAddGitHubProject,
  className,
  size,
  variant,
}: {
  readonly onAddLocalProject?: () => void;
  readonly onAddGitHubProject?: () => void;
  readonly className?: string;
  readonly size?: ButtonProps['size'];
  readonly variant?: ButtonProps['variant'];
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={variant ?? 'ghost'}
          size={size ?? 'icon'}
          className={className}
          aria-label={t('workspace.projects.addProjectMenu', 'Add project')}
          title={t('workspace.projects.addProjectMenu', 'Add project')}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        {onAddLocalProject ? (
          <DropdownMenuItem onSelect={() => onAddLocalProject()}>
            <FolderPlus className="h-4 w-4" />
            <span className="flex min-w-0 flex-col">
              <span>{t('chat.contextSwitch.addProject', 'Add a local project')}</span>
              <span className="text-xs text-muted-foreground">
                {t(
                  'chat.contextSwitch.addLocalProjectHint',
                  'Browse the machine and pick a folder'
                )}
              </span>
            </span>
          </DropdownMenuItem>
        ) : null}
        {onAddGitHubProject ? (
          <DropdownMenuItem onSelect={() => onAddGitHubProject()}>
            <Github className="h-4 w-4" />
            <span className="flex min-w-0 flex-col">
              <span>{t('chat.contextSwitch.addGitHubRepo', 'Add a GitHub repository')}</span>
              <span className="text-xs text-muted-foreground">
                {t('chat.contextSwitch.addGitHubRepoHint', 'Connect a GitHub repository')}
              </span>
            </span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectDetailPane({
  selection,
  onSharedWithTeamChange,
  onSyncHistory,
  onImportHistory,
  onResolveHistoryConflict,
  onHistorySelectionChange,
  onWorktreeSetupChange,
  onWorktreeCleanupChange,
  onGithubWorktreeSetupChange,
  onGithubWorktreeCleanupChange,
}: {
  readonly selection: ProjectSettingsSelection;
} & Omit<ProjectRowProps, 'row'> & {
    onGithubWorktreeSetupChange?: (
      row: GithubProjectSettingsRow,
      config: WorktreeSetupScriptConfig
    ) => Promise<void>;
    onGithubWorktreeCleanupChange?: (
      row: GithubProjectSettingsRow,
      config: WorktreeCleanupScriptConfig
    ) => Promise<void>;
  }) {
  if (selection.kind === 'github') {
    return (
      <GithubProjectDetail
        row={selection.row}
        onWorktreeSetupChange={onGithubWorktreeSetupChange}
        onWorktreeCleanupChange={onGithubWorktreeCleanupChange}
      />
    );
  }

  return (
    <LocalProjectDetail
      row={selection.row}
      onSharedWithTeamChange={onSharedWithTeamChange}
      onSyncHistory={onSyncHistory}
      onImportHistory={onImportHistory}
      onResolveHistoryConflict={onResolveHistoryConflict}
      onHistorySelectionChange={onHistorySelectionChange}
      onWorktreeSetupChange={onWorktreeSetupChange}
      onWorktreeCleanupChange={onWorktreeCleanupChange}
    />
  );
}

function LocalProjectDetail({
  row,
  onSharedWithTeamChange,
  onSyncHistory,
  onImportHistory,
  onResolveHistoryConflict,
  onHistorySelectionChange,
  onWorktreeSetupChange,
  onWorktreeCleanupChange,
}: ProjectRowProps) {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const skillsSource: ProjectSkillsSource | null = workspaceId
    ? {
        kind: 'local',
        workspaceId,
        machineId: row.machineId,
        localProjectId: row.project.id,
      }
    : null;
  return (
    <TooltipProvider delayDuration={200}>
      {/* No name/path header — the left list already shows those. The share
          toggle sits at the end of the tab bar; each tab body scrolls on its
          own with scrollbar-pro so long lists never push the layout. */}
      <div className="flex h-full min-h-0 flex-col p-4 pt-3">
        <Tabs defaultValue="sync" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-2">
            <TabsList className="h-8">
              <TabsTrigger value="sync" className="gap-1.5 px-2.5 text-xs">
                <MessagesSquare className="h-3.5 w-3.5" />
                {t('workspace.projects.historySyncSection', 'Conversation sync')}
              </TabsTrigger>
              <TabsTrigger value="worktree" className="gap-1.5 px-2.5 text-xs">
                <TerminalSquare className="h-3.5 w-3.5" />
                {t('workspace.projects.worktreeSetupTab', 'Worktree setup')}
              </TabsTrigger>
              <TabsTrigger value="skills" className="gap-1.5 px-2.5 text-xs">
                <Boxes className="h-3.5 w-3.5" />
                {t('workspace.projects.skills.tabLabel', 'Skills')}
              </TabsTrigger>
            </TabsList>
            <ProjectShareControl row={row} onSharedWithTeamChange={onSharedWithTeamChange} />
          </div>
          <TabsContent value="sync" className="mt-3 flex min-h-0 flex-1 flex-col">
            <LocalHistorySection
              row={row}
              onSyncHistory={onSyncHistory}
              onImportHistory={onImportHistory}
              onResolveHistoryConflict={onResolveHistoryConflict}
              onHistorySelectionChange={onHistorySelectionChange}
            />
          </TabsContent>
          <TabsContent
            value="worktree"
            className="scrollbar-pro mt-3 min-h-0 flex-1 overflow-y-auto pr-1"
          >
            <div className="flex flex-col gap-5">
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
          </TabsContent>
          <TabsContent
            value="skills"
            className="scrollbar-pro mt-3 min-h-0 flex-1 overflow-y-auto pr-1"
          >
            <ProjectSkillsTab source={skillsSource} />
          </TabsContent>
        </Tabs>
      </div>
    </TooltipProvider>
  );
}

function ProjectShareControl({
  row,
  onSharedWithTeamChange,
}: {
  readonly row: ProjectSettingsRow;
  readonly onSharedWithTeamChange?: (
    row: ProjectSettingsRow,
    sharedWithTeam: boolean
  ) => Promise<void>;
}) {
  const { t } = useTranslation();
  // Sharing is a cloud team surface; hide the control entirely on the local
  // (open-source) platform instead of rendering a permanently disabled switch.
  const teamSharingAvailable = useAppCapability('teamSharing');
  const tooltipLabel = !row.canUpdateSharing
    ? t(
        'workspace.projects.sharePreparing',
        'Sharing will be available when this machine finishes connecting.'
      )
    : row.sharedWithTeam
      ? t('workspace.projects.sharedWithTeam', 'Shared with team')
      : t('workspace.projects.private', 'Private to you');
  const scopeDescription = t(
    'workspace.projects.shareScopeDescription',
    'Sharing a project also shares its device, which teammates need to open and continue conversations.'
  );

  if (!teamSharingAvailable) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex shrink-0 items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {t('workspace.projects.shareLabel', 'Share project')}
            {row.isUpdating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            ) : null}
          </span>
          <Switch
            checked={row.sharedWithTeam}
            disabled={row.isUpdating || !row.canUpdateSharing || !onSharedWithTeamChange}
            aria-label={t('workspace.projects.shareToggle', {
              defaultValue: 'Share project with team',
            })}
            onCheckedChange={(checked) => {
              void onSharedWithTeamChange?.(row, checked);
            }}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-72 px-2.5 py-2">
        <div className="font-medium">{tooltipLabel}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{scopeDescription}</div>
      </TooltipContent>
    </Tooltip>
  );
}

export type ProjectRowProps = {
  row: ProjectSettingsRow;
  onSharedWithTeamChange?: (row: ProjectSettingsRow, sharedWithTeam: boolean) => Promise<void>;
  onSyncHistory?: (row: ProjectSettingsRow, provider: LocalProjectHistoryProvider) => Promise<void>;
  onImportHistory?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider
  ) => Promise<void>;
  onResolveHistoryConflict?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider,
    session: LocalProjectHistoryCatalogItem
  ) => Promise<void>;
  onHistorySelectionChange?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider,
    selectedIds: string[]
  ) => void;
  onWorktreeSetupChange?: (
    row: ProjectSettingsRow,
    config: WorktreeSetupScriptConfig
  ) => Promise<void>;
  onWorktreeCleanupChange?: (
    row: ProjectSettingsRow,
    config: WorktreeCleanupScriptConfig
  ) => Promise<void>;
};

type LocalHistorySectionProps = Pick<
  ProjectRowProps,
  | 'row'
  | 'onSyncHistory'
  | 'onImportHistory'
  | 'onResolveHistoryConflict'
  | 'onHistorySelectionChange'
>;

function LocalHistorySection({
  row,
  onSyncHistory,
  onImportHistory,
  onResolveHistoryConflict,
  onHistorySelectionChange,
}: LocalHistorySectionProps) {
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

  if (!activeHistoryState) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted/60">
          <MessagesSquare className="h-4 w-4 text-muted-foreground" />
        </div>
        <p className="max-w-xs text-xs text-muted-foreground">
          {t(
            'workspace.projects.historySyncEmptyHint',
            'No agents detected on this machine yet. Conversation sync becomes available once an ACP agent has run here.'
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-foreground/[0.025]">
      <div
        role="tablist"
        aria-label={t('workspace.projects.historyTablistLabel', 'History providers')}
        className="flex shrink-0 gap-1 overflow-x-auto p-1"
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
                'flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-3 text-xs transition-colors',
                active
                  ? 'bg-foreground/[0.08] text-foreground'
                  : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground'
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
  );
}

function GithubProjectDetail({
  row,
  onWorktreeSetupChange,
  onWorktreeCleanupChange,
}: {
  row: GithubProjectSettingsRow;
  onWorktreeSetupChange?: (
    row: GithubProjectSettingsRow,
    config: WorktreeSetupScriptConfig
  ) => Promise<void>;
  onWorktreeCleanupChange?: (
    row: GithubProjectSettingsRow,
    config: WorktreeCleanupScriptConfig
  ) => Promise<void>;
}) {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const skillsSource: ProjectSkillsSource | null = workspaceId
    ? {
        kind: 'github',
        workspaceId,
        repoFullName: row.repoFullName,
      }
    : null;
  return (
    <div className="flex h-full min-h-0 flex-col p-4 pt-3">
      <Tabs defaultValue="worktree" className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2">
          <TabsList className="h-8">
            <TabsTrigger value="worktree" className="gap-1.5 px-2.5 text-xs">
              <TerminalSquare className="h-3.5 w-3.5" />
              {t('workspace.projects.worktreeSetupTab', 'Worktree setup')}
            </TabsTrigger>
            <TabsTrigger value="skills" className="gap-1.5 px-2.5 text-xs">
              <Boxes className="h-3.5 w-3.5" />
              {t('workspace.projects.skills.tabLabel', 'Skills')}
            </TabsTrigger>
          </TabsList>
          <span className="rounded-sm bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-muted-foreground">
            {row.private ? t('workspace.projects.privateRepo', 'Private') : 'Public'}
          </span>
        </div>
        <TabsContent
          value="worktree"
          className="scrollbar-pro mt-3 min-h-0 flex-1 overflow-y-auto pr-1"
        >
          <div className="flex flex-col gap-5">
            <WorktreeSetupEditor
              phase="setup"
              config={row.worktreeSetup}
              isSaving={row.isWorktreeSetupSaving}
              errorMessage={row.worktreeSetupError}
              onSave={(config) => onWorktreeSetupChange?.(row, config)}
            />
            <WorktreeSetupEditor
              phase="cleanup"
              config={row.worktreeCleanup}
              isSaving={row.isWorktreeCleanupSaving}
              errorMessage={row.worktreeCleanupError}
              onSave={(config) => onWorktreeCleanupChange?.(row, config)}
            />
          </div>
        </TabsContent>
        <TabsContent
          value="skills"
          className="scrollbar-pro mt-3 min-h-0 flex-1 overflow-y-auto pr-1"
        >
          <ProjectSkillsTab source={skillsSource} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function buildWorktreeSetupConfig(args: {
  bash: string;
  powershell: string;
  timeoutMs?: number;
}): WorktreeSetupScriptConfig {
  const scripts = {
    ...(args.bash.trim() ? { bash: args.bash } : {}),
    ...(args.powershell.trim() ? { powershell: args.powershell } : {}),
  };
  return {
    scripts,
    ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
  };
}

function getWorktreeShellLabel(shell: WorktreeSetupShell): string {
  return shell === 'powershell' ? 'PowerShell' : 'Bash';
}

type WorktreeScriptPhase = 'setup' | 'cleanup';

function getWorktreeShellPlaceholder(
  shell: WorktreeSetupShell,
  phase: WorktreeScriptPhase
): string {
  if (phase === 'cleanup') {
    return shell === 'powershell'
      ? 'Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue'
      : 'rm -rf node_modules';
  }
  return shell === 'powershell'
    ? 'Copy-Item .env.example .env\npnpm install'
    : 'cp .env.example .env\npnpm install';
}

/* Each setup/cleanup run owns a child shell session: lines in the same script
   share env/cwd state with each other, but that shell still exits before the
   agent starts. Detect env assignment intent so the UI can explain that the
   value will not reach the agent process. */
function scriptSetsEphemeralEnv(shell: WorktreeSetupShell, script: string): boolean {
  if (shell === 'powershell') {
    return (
      /\$env:[A-Za-z_]\w*\s*=/.test(script) ||
      /\[Environment\]::SetEnvironmentVariable/i.test(script)
    );
  }
  return /(^|[\n;&|])\s*export\s+[A-Za-z_]/.test(script);
}

function getWorktreeScriptEnvDocsUrl(language: string | undefined): string {
  const isChinese = language?.toLowerCase().startsWith('zh') ?? false;
  const path = isChinese ? '/zh/docs/worktrees' : '/docs/worktrees';
  return `https://lody.ai${path}#available-environment-variables`;
}

export function WorktreeSetupEditor({
  phase = 'setup',
  config,
  isLoading,
  isSaving,
  errorMessage,
  onSave,
  shell,
}: {
  phase?: WorktreeScriptPhase;
  config: WorktreeSetupScriptConfig;
  isLoading?: boolean;
  isSaving?: boolean;
  errorMessage?: string | null;
  onSave?: (config: WorktreeSetupScriptConfig) => Promise<void> | void;
  /* When set, the project's machine runs exactly this shell (local
     projects, probed from the OS), so we render only that shell's
     textarea and leave the other shell's stored script untouched. When
     omitted (GitHub projects, clonable on either OS) we render Bash /
     PowerShell tabs so both can be edited. */
  shell?: WorktreeSetupShell;
}) {
  const { t, i18n } = useTranslation();
  const [bash, setBash] = useState(config.scripts.bash ?? '');
  const [powershell, setPowershell] = useState(config.scripts.powershell ?? '');
  /* Track the last config we received or wrote so the sync effect can
     tell an external/refetched config (adopt it) apart from the parent
     echoing back our own save (ignore it). Without this, a blur-save on
     one shell would reset an unsaved edit in the other shell's textarea.
     The parent only swaps the config reference on a successful save, so a
     failed save keeps the in-progress edits. */
  const committedRef = useRef(config);

  useEffect(() => {
    if (JSON.stringify(config) === JSON.stringify(committedRef.current)) return;
    committedRef.current = config;
    setBash(config.scripts.bash ?? '');
    setPowershell(config.scripts.powershell ?? '');
  }, [config]);

  const readOnly = isLoading || !onSave;
  /* Distinct glyph per phase so the stacked setup + cleanup editors read as
     two different steps at a glance. Cleanup uses a broom (not a trash can),
     which reads as "tidy up after the run" rather than "delete this section". */
  const PhaseIcon = phase === 'cleanup' ? BrushCleaning : Wrench;
  const title =
    phase === 'cleanup'
      ? t('workspace.projects.worktreeCleanupTitle', 'Worktree cleanup')
      : t('workspace.projects.worktreeSetupTitle', 'Worktree setup');
  const description =
    phase === 'cleanup'
      ? t(
          'workspace.projects.worktreeCleanupDescription',
          'Runs when the conversation is archived, before the worktree is removed from disk.'
        )
      : t(
          'workspace.projects.worktreeSetupDescription',
          'Runs after the git worktree is created and before the agent starts.'
        );
  const loadingLabel =
    phase === 'cleanup'
      ? t('workspace.projects.worktreeCleanupLoading', 'Loading cleanup script')
      : t('workspace.projects.worktreeSetupLoading', 'Loading setup script');
  const savingLabel =
    phase === 'cleanup'
      ? t('workspace.projects.worktreeCleanupSaving', 'Saving…')
      : t('workspace.projects.worktreeSetupSaving', 'Saving…');
  const envDocsUrl = getWorktreeScriptEnvDocsUrl(i18n.resolvedLanguage ?? i18n.language);
  const handleOpenEnvDocs = () => {
    void openExternalUrl(envDocsUrl);
  };

  const persist = (override: Partial<{ bash: string; powershell: string }>) => {
    const nextConfig = buildWorktreeSetupConfig({
      bash: override.bash ?? bash,
      powershell: override.powershell ?? powershell,
      timeoutMs: config.timeoutMs,
    });
    if (JSON.stringify(nextConfig) === JSON.stringify(config)) return;
    committedRef.current = nextConfig;
    void onSave?.(nextConfig);
  };

  const renderShellTextarea = (target: WorktreeSetupShell) => {
    const value = target === 'powershell' ? powershell : bash;
    const setValue = target === 'powershell' ? setPowershell : setBash;
    const showsEphemeralEnvHint = scriptSetsEphemeralEnv(target, value);
    return (
      <div className="flex flex-col gap-1.5">
        <Textarea
          value={value}
          disabled={readOnly}
          rows={8}
          spellCheck={false}
          className="resize-y font-mono text-xs leading-relaxed"
          placeholder={getWorktreeShellPlaceholder(target, phase)}
          onChange={(event) => setValue(event.target.value)}
          onBlur={(event) =>
            persist(
              target === 'powershell'
                ? { powershell: event.target.value }
                : { bash: event.target.value }
            )
          }
        />
        {showsEphemeralEnvHint ? (
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <Info className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">
              {t(
                'workspace.projects.worktreeSetupEnvHint',
                "Environment variables set here only live inside this script — the agent process can't read them. Set the agent's environment variables in the agent config."
              )}
            </span>
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <PhaseIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            {title}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {description}{' '}
            <button
              type="button"
              className="inline-flex items-center gap-0.5 align-baseline text-foreground/80 underline-offset-4 hover:text-foreground hover:underline"
              onClick={handleOpenEnvDocs}
            >
              {t(
                'workspace.projects.worktreeScriptEnvDocsLink',
                'Script environment variables are available'
              )}
              <ExternalLink className="h-3 w-3" />
            </button>
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 rounded-md bg-foreground/[0.025] px-3 py-6 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {loadingLabel}
        </div>
      ) : shell ? (
        <div className="flex flex-col gap-2">
          <span className="inline-flex w-fit items-center gap-1.5 rounded-md bg-foreground/[0.05] px-2 py-1 text-xs font-medium text-foreground">
            <TerminalSquare className="h-3.5 w-3.5" />
            {getWorktreeShellLabel(shell)}
          </span>
          {renderShellTextarea(shell)}
        </div>
      ) : (
        <Tabs defaultValue="bash" className="flex flex-col gap-2">
          <TabsList className="h-8 self-start">
            <TabsTrigger value="bash" className="gap-1.5 px-2.5 text-xs">
              <TerminalSquare className="h-3.5 w-3.5" />
              Bash
            </TabsTrigger>
            <TabsTrigger value="powershell" className="gap-1.5 px-2.5 text-xs">
              <TerminalSquare className="h-3.5 w-3.5" />
              PowerShell
            </TabsTrigger>
          </TabsList>
          <TabsContent value="bash" className="mt-0">
            {renderShellTextarea('bash')}
          </TabsContent>
          <TabsContent value="powershell" className="mt-0">
            {renderShellTextarea('powershell')}
          </TabsContent>
        </Tabs>
      )}

      {isSaving ? (
        <div
          aria-live="polite"
          className="flex items-center justify-end gap-1 text-[11px] text-muted-foreground"
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          {savingLabel}
        </div>
      ) : null}

      {errorMessage ? (
        <div className="flex items-start gap-2 text-xs text-destructive">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{errorMessage}</span>
        </div>
      ) : null}
    </div>
  );
}

type ProjectHistoryImportPanelProps = {
  row: ProjectSettingsRow;
  state: ProjectHistoryImportState;
  onSyncHistory?: (row: ProjectSettingsRow, provider: LocalProjectHistoryProvider) => Promise<void>;
  onImportHistory?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider
  ) => Promise<void>;
  onResolveHistoryConflict?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider,
    session: LocalProjectHistoryCatalogItem
  ) => Promise<void>;
  onHistorySelectionChange?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider,
    selectedIds: string[]
  ) => void;
};

export function ProjectHistoryImportPanel({
  row,
  state,
  onSyncHistory,
  onImportHistory,
  onResolveHistoryConflict,
  onHistorySelectionChange,
}: ProjectHistoryImportPanelProps) {
  const { t, i18n } = useTranslation();
  const localeObj: Locale = i18n.language?.startsWith('zh') ? zhCN : enUS;
  const intlLocale = toIntlLocale(i18n.resolvedLanguage ?? i18n.language);
  const providerLabel = getHistoryProviderLabel(state.provider);
  const catalogSessions = state.catalog?.sessions ?? [];
  const hasSyncedCatalog = state.catalog !== null;
  const hasCatalogSessions = catalogSessions.length > 0;
  const selectedSet = new Set(state.selectedSessionIds);
  const [conflictSessionToResolve, setConflictSessionToResolve] =
    useState<LocalProjectHistoryCatalogItem | null>(null);
  const canManageCatalog = state.canSync && !state.isImporting;
  const selectableSessions = state.canSync
    ? catalogSessions.filter(
        (session) => session.status !== 'imported' && session.status !== 'sync_conflict'
      )
    : [];
  const allSelectableSelected =
    selectableSessions.length > 0 &&
    selectableSessions.every((session) => selectedSet.has(session.acpSessionId));
  const someSelectableSelected = selectableSessions.some((session) =>
    selectedSet.has(session.acpSessionId)
  );
  const selectAllChecked = allSelectableSelected
    ? true
    : someSelectableSelected
      ? 'indeterminate'
      : false;
  const lastListedAtDate =
    typeof state.catalog?.lastListedAt === 'number' ? new Date(state.catalog.lastListedAt) : null;
  const statusLabel = lastListedAtDate
    ? t('workspace.projects.historyLastSynced', {
        defaultValue: 'Last synced {{relative}}',
        relative: formatDistanceToNow(lastListedAtDate, { addSuffix: true, locale: localeObj }),
      })
    : t('workspace.projects.historyNotSyncedYet', {
        defaultValue: 'Not synced yet',
      });
  const syncFailures = state.syncSummary
    ? getVisibleLocalProjectHistoryFailures(state.syncSummary)
    : null;

  const updateSelection = (selectedIds: string[]) => {
    onHistorySelectionChange?.(row, state.provider, selectedIds);
  };

  const confirmConflictReplace = () => {
    const session = conflictSessionToResolve;
    if (!session) return;
    setConflictSessionToResolve(null);
    void onResolveHistoryConflict?.(row, state.provider, session);
  };

  const toggleSession = (acpSessionId: string) => {
    const next = new Set(selectedSet);
    if (next.has(acpSessionId)) {
      next.delete(acpSessionId);
    } else {
      next.add(acpSessionId);
    }
    updateSelection([...next]);
  };

  const toggleSelectAll = () => {
    if (allSelectableSelected) {
      updateSelection([]);
      return;
    }
    updateSelection(selectableSessions.map((session) => session.acpSessionId));
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col bg-tab-active text-xs">
        {hasCatalogSessions ? (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-tab-border px-3 py-2">
            <span className="truncate text-muted-foreground">{statusLabel}</span>
            <div className="flex shrink-0 items-center gap-2">
              {state.canSync && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={historyActionButtonClass}
                      disabled={state.isSyncing || state.isImporting}
                      onClick={() => {
                        void onSyncHistory?.(row, state.provider);
                      }}
                    >
                      {state.isSyncing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      <span>{t('workspace.projects.syncHistory', 'Sync')}</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    {t('workspace.projects.syncHistoryTooltip', {
                      defaultValue: 'Sync {{provider}} history',
                      provider: providerLabel,
                    })}
                  </TooltipContent>
                </Tooltip>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={historyActionButtonClass}
                disabled={
                  state.selectedSessionIds.length === 0 || !canManageCatalog || !onImportHistory
                }
                onClick={() => {
                  void onImportHistory?.(row, state.provider);
                }}
              >
                {state.isImporting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {t('workspace.projects.importSelectedHistory', {
                  defaultValue: 'Import',
                })}
              </Button>
            </div>
          </div>
        ) : null}
        {state.errorMessage !== null && state.errorMessage.length > 0 ? (
          <div className="scrollbar-pro flex max-h-28 shrink-0 items-start gap-2 overflow-y-auto border-b border-tab-border bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{state.errorMessage}</span>
          </div>
        ) : null}
        {state.syncSummary && (
          <div className="shrink-0 border-b border-tab-border px-3 py-1.5 text-[11px] text-muted-foreground">
            <div>{formatHistorySyncSummary(state.syncSummary, t)}</div>
            {syncFailures && syncFailures.failures.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-destructive">
                {syncFailures.failures.map((failure) => (
                  <li key={failure.acpSessionId} className="break-words">
                    {failure.acpSessionId}: {failure.message}
                  </li>
                ))}
                {syncFailures.remaining > 0 ? (
                  <li>
                    {t('workspace.projects.historySyncMoreFailures', {
                      defaultValue: '{{count}} more failures',
                      count: syncFailures.remaining,
                    })}
                  </li>
                ) : null}
              </ul>
            ) : null}
          </div>
        )}
        {hasCatalogSessions && (
          <div className="shrink-0 border-b border-tab-border px-3 py-2">
            <div
              role="button"
              tabIndex={selectableSessions.length === 0 || !canManageCatalog ? -1 : 0}
              aria-disabled={selectableSessions.length === 0 || !canManageCatalog}
              className="flex min-w-0 items-center gap-2 text-left"
              onClick={() => {
                if (selectableSessions.length > 0 && canManageCatalog) {
                  toggleSelectAll();
                }
              }}
              onKeyDown={(event) => {
                if (selectableSessions.length === 0 || !canManageCatalog) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  toggleSelectAll();
                }
              }}
            >
              <Checkbox
                checked={selectAllChecked}
                disabled={selectableSessions.length === 0 || !canManageCatalog}
                onCheckedChange={toggleSelectAll}
                onClick={(event) => event.stopPropagation()}
              />
              <span className="truncate text-muted-foreground">
                {t('workspace.projects.selectAllHistory', {
                  defaultValue: 'Select all available ({{count}})',
                  count: selectableSessions.length,
                })}
              </span>
            </div>
          </div>
        )}
        {!hasCatalogSessions ? (
          <div className="flex min-h-44 flex-1 flex-col items-center justify-center px-6 py-10 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground/[0.06]">
              <MessagesSquare className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="mt-3 max-w-sm">
              <p className="font-medium text-foreground">
                {hasSyncedCatalog
                  ? t('workspace.projects.historyEmpty', {
                      defaultValue: 'No {{provider}} conversations found',
                      provider: providerLabel,
                    })
                  : t('workspace.projects.historyInitialSyncTitle', {
                      defaultValue: 'Sync {{provider}} conversations',
                      provider: providerLabel,
                    })}
              </p>
              <p className="mt-1 leading-relaxed text-muted-foreground">
                {hasSyncedCatalog
                  ? t('workspace.projects.historyEmptyHint', {
                      defaultValue:
                        'Start a conversation for this project in {{provider}}, then sync again.',
                      provider: providerLabel,
                    })
                  : t('workspace.projects.historyInitialSyncHint', {
                      defaultValue:
                        "Find this project's conversations in {{provider}}, then choose which ones to import.",
                      provider: providerLabel,
                    })}
              </p>
            </div>
            {state.canSync ? (
              <Button
                type="button"
                size="sm"
                className="mt-4"
                disabled={state.isSyncing || state.isImporting || !onSyncHistory}
                onClick={() => {
                  void onSyncHistory?.(row, state.provider);
                }}
              >
                {state.isSyncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                <span>
                  {hasSyncedCatalog
                    ? t('workspace.projects.syncHistoryAgain', 'Sync again')
                    : t('workspace.projects.syncHistory', 'Sync')}
                </span>
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="scrollbar-pro min-h-0 flex-1 divide-y divide-tab-border overflow-y-auto overscroll-contain">
            {catalogSessions.map((session) => {
              const imported = session.status === 'imported';
              const conflict = session.status === 'sync_conflict';
              const selectionDisabled = imported || conflict || !canManageCatalog;
              const resolving = state.resolvingSessionIds.includes(session.acpSessionId);
              const canResolveConflict =
                conflict &&
                state.canSync &&
                !state.isSyncing &&
                !state.isImporting &&
                !resolving &&
                Boolean(session.importedSessionId) &&
                Boolean(onResolveHistoryConflict);
              const selected = selectedSet.has(session.acpSessionId);
              const updatedAtDate = parseHistoryUpdatedAt(session.updatedAt);
              const updatedAtLabel = formatHistoryUpdatedAt(session.updatedAt, localeObj, t);
              const updatedAtTitle = updatedAtDate
                ? updatedAtDate.toLocaleString(intlLocale)
                : session.acpSessionId;
              return (
                <div
                  key={session.acpSessionId}
                  role="button"
                  tabIndex={selectionDisabled ? -1 : 0}
                  aria-disabled={selectionDisabled}
                  className={cn(
                    'flex min-w-0 items-center gap-2 px-3 py-2',
                    selectionDisabled
                      ? 'cursor-default opacity-70'
                      : 'cursor-pointer hover:bg-tab-hover/40'
                  )}
                  onClick={() => {
                    if (!selectionDisabled) {
                      toggleSession(session.acpSessionId);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (selectionDisabled) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggleSession(session.acpSessionId);
                    }
                  }}
                >
                  <Checkbox
                    checked={imported || selected}
                    disabled={selectionDisabled}
                    onClick={(event) => event.stopPropagation()}
                    onCheckedChange={() => {
                      if (!selectionDisabled) toggleSession(session.acpSessionId);
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground">{session.title}</div>
                    <div
                      className="truncate text-[10px] text-muted-foreground"
                      title={updatedAtTitle}
                    >
                      {updatedAtLabel}
                    </div>
                  </div>
                  {imported && (
                    <span className="shrink-0 rounded-sm bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {t('workspace.projects.historyImported', 'Imported')}
                    </span>
                  )}
                  {conflict && (
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="rounded-sm border border-destructive/30 px-1.5 py-0.5 text-[10px] text-destructive">
                        {t('workspace.projects.historyConflict', 'Conflict')}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={historyActionButtonClass}
                        disabled={!canResolveConflict}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (!canResolveConflict) return;
                          setConflictSessionToResolve(session);
                        }}
                      >
                        {resolving ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        <span>{t('workspace.projects.resolveHistoryConflict', 'Re-import')}</span>
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <AlertDialog
        open={conflictSessionToResolve !== null}
        onOpenChange={(open) => {
          if (!open) setConflictSessionToResolve(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('workspace.projects.resolveHistoryConflictTitle', {
                defaultValue: 'Re-import conversation?',
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.projects.resolveHistoryConflictConfirm', {
                defaultValue:
                  'Re-import this conversation from {{provider}}? This replaces the current imported history with the latest source history and may discard local-only turns.',
                provider: providerLabel,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmConflictReplace}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('workspace.projects.resolveHistoryConflict', 'Re-import')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
