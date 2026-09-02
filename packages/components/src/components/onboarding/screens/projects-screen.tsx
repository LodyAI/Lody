import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCloudAction, usePlatformCapability } from '@lody/platform/react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, ExternalLink, FolderPlus, Github, Loader2 } from 'lucide-react';
import type { LocalProjectId, MachineId } from '@lody/shared';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import type { DesktopOnboardingProjectSelection } from '@/atoms/onboarding';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import {
  localCliStartingAtom,
  localMachineIdAtom,
  localProbeResultAtom,
} from '@/atoms/local-probe';
import { useVisibleLocalProjects } from '@/hooks/use-visible-local-projects';
import { useCloudQuery } from '@lody/platform/react';
import { useConvexErrorMessage } from '@/hooks/use-convex-error-message';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { selectAndWriteLocalProject } from '@/lib/local-project-import';
import { openExternalUrl } from '@/lib/native-browser';
import { Button } from '@lody/ui/button';
import { OnboardingShell, OnboardingBackButton, OnboardingNextButton } from '../onboarding-shell';
import { useOnboardingAnalytics } from '../onboarding-analytics';

export interface ProjectsScreenLocalEntry {
  key: string;
  machineId: MachineId;
  localProjectId: LocalProjectId;
  name: string;
  detail: string;
}

export interface ProjectsScreenGitHubEntry {
  /** Use repo full name as the stable key. */
  key: string;
  /** owner/repo */
  name: string;
  /** Visibility / extra detail (e.g. Private/Public). */
  detail: string;
}

export interface ProjectsScreenViewProps {
  local: ProjectsScreenLocalEntry[];
  github: ProjectsScreenGitHubEntry[];
  /** True while a local project import dialog is open. */
  importing: boolean;
  /** True while the GitHub install URL is being created. */
  connectingGitHub: boolean;
  /** Whether local-project import is available in this renderer. */
  canImportLocal: boolean;
  /** Hint shown when the local-project import action is disabled. */
  localImportDisabledHint?: string;
  /** Whether the connect-GitHub action is enabled (workspace ready). */
  canConnectGitHub: boolean;
  /** True while the GitHub repository list is still loading. */
  loadingRepos: boolean;
  selectedProjectKey?: string | null;
  onSelectProject?: (selection: DesktopOnboardingProjectSelection) => void;
  onAddLocal: () => void;
  onConnectGitHub: () => void;
  onBack: () => void;
  /** Leave onboarding project-less; the summary must say so honestly. */
  onSkip: () => void;
  onComplete: (selection: DesktopOnboardingProjectSelection) => void;
}

export function ProjectsScreenView({
  local,
  github,
  importing,
  connectingGitHub,
  canImportLocal,
  localImportDisabledHint,
  canConnectGitHub,
  loadingRepos,
  selectedProjectKey,
  onSelectProject,
  onAddLocal,
  onConnectGitHub,
  onBack,
  onSkip,
  onComplete,
}: ProjectsScreenViewProps) {
  const { t } = useTranslation();

  const totalProjects = local.length + github.length;
  const hasAnyProject = totalProjects > 0;
  const resolvedSelectedProjectKey =
    selectedProjectKey ??
    (local[0] ? `local:${local[0].key}` : github[0] ? `github:${github[0].key}` : null);
  const previewProjectName =
    local.find((entry) => `local:${entry.key}` === resolvedSelectedProjectKey)?.name ??
    github.find((entry) => `github:${entry.key}` === resolvedSelectedProjectKey)?.name;

  return (
    <OnboardingShell
      stepKey="projects"
      size="wide"
      title={t('onboarding.projects.title', 'Pick a project to start with')}
      description={t(
        'onboarding.projects.description',
        'Add at least one project so Lody knows where to work.'
      )}
      previewIdentity={previewProjectName ? { projectName: previewProjectName } : undefined}
      previewState={{
        projectStatus:
          importing || connectingGitHub ? 'importing' : hasAnyProject ? 'ready' : 'missing',
      }}
      secondaryAction={<OnboardingBackButton onClick={onBack} />}
      primaryAction={
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="large" onClick={onSkip}>
            {t('onboarding.projects.skip', 'Skip for now')}
          </Button>
          <OnboardingNextButton
            finish
            onClick={() => {
              const selectedLocal = local.find(
                (entry) => `local:${entry.key}` === resolvedSelectedProjectKey
              );
              if (selectedLocal) {
                onComplete({
                  kind: 'local',
                  machineId: selectedLocal.machineId,
                  localProjectId: selectedLocal.localProjectId,
                  name: selectedLocal.name,
                });
                return;
              }
              const selectedGitHub = github.find(
                (entry) => `github:${entry.key}` === resolvedSelectedProjectKey
              );
              if (selectedGitHub) {
                onComplete({
                  kind: 'github',
                  repoFullName: selectedGitHub.key,
                  name: selectedGitHub.name,
                });
              }
            }}
            disabled={!hasAnyProject || resolvedSelectedProjectKey === null}
            label={t('common.next', 'Next')}
          />
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {hasAnyProject ? (
          <ExistingProjectList
            local={local}
            github={github}
            selectedProjectKey={resolvedSelectedProjectKey}
            onSelect={onSelectProject ?? (() => undefined)}
          />
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <ActionCard
            icon={
              importing ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <FolderPlus className="h-5 w-5" />
              )
            }
            title={t('onboarding.projects.addLocalTitle', 'Add a local project')}
            description={t(
              'onboarding.projects.addLocalDescription',
              'Pick a folder on this machine.'
            )}
            disabled={importing || !canImportLocal}
            disabledHint={
              !canImportLocal
                ? (localImportDisabledHint ??
                  t(
                    'onboarding.projects.localOnDesktopOnly',
                    'Local projects can only be added from the desktop app.'
                  ))
                : undefined
            }
            onClick={onAddLocal}
          />
          <ActionCard
            icon={
              connectingGitHub ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Github className="h-5 w-5" />
              )
            }
            title={t('onboarding.projects.connectGitHubTitle', 'Connect a GitHub repository')}
            description={t(
              'onboarding.projects.connectGitHubDescription',
              'Authorize Lody to access selected repos.'
            )}
            trailing={<ExternalLink className="h-3.5 w-3.5 text-muted-foreground/70" />}
            disabled={connectingGitHub || !canConnectGitHub}
            onClick={onConnectGitHub}
          />
        </div>

        {!hasAnyProject ? (
          <p className="text-center text-xs text-muted-foreground/80">
            {loadingRepos
              ? t('onboarding.projects.loadingRepos', 'Loading your repositories…')
              : t(
                  'onboarding.projects.needAtLeastOne',
                  'Add at least one project to finish setup.'
                )}
          </p>
        ) : null}
      </div>
    </OnboardingShell>
  );
}

interface ProjectsScreenProps {
  onBack: () => void;
  onSkip: () => void;
  onComplete: (selection: DesktopOnboardingProjectSelection) => void;
}

export function ProjectsScreen({ onBack, onSkip, onComplete }: ProjectsScreenProps) {
  const { t } = useTranslation();
  const analytics = useOnboardingAnalytics();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const localCliStarting = useAtomValue(localCliStartingAtom);
  const setLocalProbeResult = useSetAtom(localProbeResultAtom);
  const getConvexErrorMessage = useConvexErrorMessage();
  const repos = useCloudQuery(
    cloudOperations.github.getWorkspaceRepositories,
    workspaceId ? { workspaceId } : 'skip'
  );
  const createGitHubInstallState = useCloudAction(cloudOperations.github.createGitHubInstallState);
  const canUseGitHub = usePlatformCapability('githubIntegration');

  const { projects: localProjectIndex } = useVisibleLocalProjects();
  const localProjectList = useMemo(
    () =>
      Array.from(localProjectIndex.values()).filter(
        (entry) => localMachineId !== null && entry.machineId === localMachineId
      ),
    [localMachineId, localProjectIndex]
  );
  const repoList = useMemo(() => repos ?? [], [repos]);

  const [importing, setImporting] = useState(false);
  const [connectingGitHub, setConnectingGitHub] = useState(false);
  const [selectedProject, setSelectedProject] = useState<DesktopOnboardingProjectSelection | null>(
    null
  );

  useEffect(() => {
    if (selectedProject) return;
    const firstLocal = localProjectList[0];
    if (firstLocal) {
      setSelectedProject({
        kind: 'local',
        machineId: firstLocal.machineId,
        localProjectId: firstLocal.project.id,
        name: firstLocal.project.name || firstLocal.project.id,
      });
      return;
    }
    const firstRepo = repoList[0];
    if (firstRepo) {
      setSelectedProject({
        kind: 'github',
        repoFullName: firstRepo.fullName,
        name: firstRepo.fullName,
      });
    }
  }, [localProjectList, repoList, selectedProject]);

  const isElectron = isElectronRenderer();
  const localProjects = isElectron ? getIpcServices()?.localProjects : undefined;
  const selectLocalProjectDirectory = localProjects
    ? localProjects.selectDirectory.bind(localProjects)
    : undefined;
  const canImportLocal =
    isElectron &&
    Boolean(selectLocalProjectDirectory) &&
    runtime !== null &&
    localMachineId !== null &&
    !localCliStarting;
  const localImportDisabledHint =
    !isElectron || !selectLocalProjectDirectory
      ? t(
          'onboarding.projects.localOnDesktopOnly',
          'Local projects can only be added from the desktop app.'
        )
      : !canImportLocal
        ? t('onboarding.projects.waitingLocalAgent', 'Waiting for the local agent to connect…')
        : undefined;

  const handleAddLocalProject = useCallback(() => {
    if (!canImportLocal || !selectLocalProjectDirectory) return;
    const startedAtMs = analytics.now();
    analytics.capture('onboarding/operation_started', {
      step: 'projects',
      operation: 'local_project_import',
    });
    void (async () => {
      try {
        setImporting(true);
        if (!runtime) return;
        const result = await selectAndWriteLocalProject({
          runtime,
          selectDirectory: selectLocalProjectDirectory,
          timeoutMessage: t('localProjects.add.timeout', 'The machine did not respond in time.'),
        });
        if (!result) {
          analytics.capture('onboarding/operation_succeeded', {
            step: 'projects',
            operation: 'local_project_import',
            result: 'cancelled',
            duration_ms: analytics.durationSince(startedAtMs),
          });
          return;
        }
        setSelectedProject({
          kind: 'local',
          machineId: result.machineId,
          localProjectId: result.localProjectId,
          name: result.name,
        });
        const machineId = result.machineId;
        if (machineId && workspaceId !== null) {
          setLocalProbeResult({
            ok: true,
            machineId,
            homeDir: window.__LODY_PLATFORM__?.homeDir,
          });
        }
        analytics.capture('onboarding/operation_succeeded', {
          step: 'projects',
          operation: 'local_project_import',
          result: 'imported',
          duration_ms: analytics.durationSince(startedAtMs),
        });
      } catch (error) {
        console.error('Failed to import local project', error);
        analytics.capture('onboarding/operation_failed', {
          step: 'projects',
          operation: 'local_project_import',
          failure_code: 'local_project_import_failed',
          duration_ms: analytics.durationSince(startedAtMs),
          retryable: true,
        });
        toast.error(t('onboarding.projects.localImportFailed', 'Could not add the local project.'));
      } finally {
        setImporting(false);
      }
    })();
  }, [
    analytics,
    canImportLocal,
    selectLocalProjectDirectory,
    runtime,
    setLocalProbeResult,
    t,
    workspaceId,
  ]);

  const handleConnectGitHub = useCallback(() => {
    if (workspaceId === null) return;
    const startedAtMs = analytics.now();
    analytics.capture('onboarding/operation_started', {
      step: 'projects',
      operation: 'github_install',
    });
    setConnectingGitHub(true);
    void (async () => {
      try {
        const githubAppName: string =
          (import.meta.env as { VITE_GITHUB_APP_NAME?: string }).VITE_GITHUB_APP_NAME || 'lodyai';
        const { state } = await createGitHubInstallState({
          workspaceId,
          workspaceSlug: workspaceSlug ?? undefined,
          returnTarget: isElectron ? 'desktop' : 'web',
        });
        const installUrl = `https://github.com/apps/${githubAppName}/installations/new?state=${encodeURIComponent(state)}`;
        const opened = await openExternalUrl(installUrl);
        analytics.capture('onboarding/operation_succeeded', {
          step: 'projects',
          operation: 'github_install',
          result: opened ? 'external_browser' : 'current_window',
          duration_ms: analytics.durationSince(startedAtMs),
        });
        if (!opened) {
          // Final fallback: navigate the current window so the user is not stranded.
          window.location.assign(installUrl);
        }
      } catch (error) {
        console.error('[onboarding] Failed to start GitHub installation:', error);
        analytics.capture('onboarding/operation_failed', {
          step: 'projects',
          operation: 'github_install',
          failure_code: 'github_install_failed',
          duration_ms: analytics.durationSince(startedAtMs),
          retryable: true,
        });
        toast.error(
          t('settings.integrations.github.connectFailed', 'Failed to start GitHub installation'),
          {
            description: getConvexErrorMessage(
              error,
              t('settings.integrations.github.connectFailed', 'Failed to start GitHub installation')
            ),
          }
        );
      } finally {
        setConnectingGitHub(false);
      }
    })();
  }, [
    analytics,
    createGitHubInstallState,
    getConvexErrorMessage,
    isElectron,
    t,
    workspaceId,
    workspaceSlug,
  ]);

  const local: ProjectsScreenLocalEntry[] = useMemo(
    () =>
      localProjectList.map((entry) => ({
        key: entry.key,
        machineId: entry.machineId,
        localProjectId: entry.project.id,
        name: entry.project.name || entry.project.id,
        detail: entry.project.rootPath || entry.machine.name || '',
      })),
    [localProjectList]
  );

  const github: ProjectsScreenGitHubEntry[] = useMemo(
    () =>
      repoList.map((repo) => ({
        key: repo.fullName,
        name: repo.fullName,
        detail: repo.private
          ? t('onboarding.projects.repoPrivate', 'Private')
          : t('onboarding.projects.repoPublic', 'Public'),
      })),
    [repoList, t]
  );

  return (
    <ProjectsScreenView
      local={local}
      github={github}
      importing={importing}
      connectingGitHub={connectingGitHub}
      canImportLocal={canImportLocal}
      localImportDisabledHint={localImportDisabledHint}
      canConnectGitHub={canUseGitHub && workspaceId !== null}
      loadingRepos={canUseGitHub && workspaceId !== null && repos === undefined}
      selectedProjectKey={
        selectedProject?.kind === 'local'
          ? `local:${selectedProject.machineId}:${selectedProject.localProjectId}`
          : selectedProject
            ? `github:${selectedProject.repoFullName}`
            : null
      }
      onSelectProject={setSelectedProject}
      onAddLocal={handleAddLocalProject}
      onConnectGitHub={handleConnectGitHub}
      onBack={onBack}
      onSkip={onSkip}
      onComplete={onComplete}
    />
  );
}

interface ExistingProjectListProps {
  local: ProjectsScreenLocalEntry[];
  github: ProjectsScreenGitHubEntry[];
  selectedProjectKey: string | null;
  onSelect: (selection: DesktopOnboardingProjectSelection) => void;
}

function ExistingProjectList({
  local,
  github,
  selectedProjectKey,
  onSelect,
}: ExistingProjectListProps) {
  const { t } = useTranslation();
  const items = useMemo(
    () => [
      ...local.map((entry) => ({ ...entry, kind: 'local' as const })),
      ...github.map((entry) => ({ ...entry, kind: 'github' as const })),
    ],
    [local, github]
  );

  return (
    <div className="rounded-lg border border-border/60 bg-card/40">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 text-xs font-medium tracking-wider text-muted-foreground/80">
        <span>{t('onboarding.projects.connectedHeading', 'Connected')}</span>
        <span className="text-[11px] tracking-normal normal-case text-muted-foreground/70">
          {t('onboarding.projects.connectedCount', '{{count}} project', {
            count: items.length,
            defaultValue_one: '{{count}} project',
            defaultValue_other: '{{count}} projects',
          })}
        </span>
      </div>
      {/*
        Cap height ~6 rows and let the rest scroll. `overscroll-contain` keeps
        the wheel from chaining to the page-level overlay scroll once the user
        hits an end inside the list.
      */}
      <ul className="scrollbar-pro max-h-[260px] divide-y divide-border/50 overflow-y-auto overscroll-contain">
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.li
              key={`${item.kind}:${item.key}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
              className="px-2 py-1.5"
            >
              <button
                type="button"
                onClick={() =>
                  onSelect(
                    item.kind === 'local'
                      ? {
                          kind: 'local',
                          machineId: item.machineId,
                          localProjectId: item.localProjectId,
                          name: item.name,
                        }
                      : { kind: 'github', repoFullName: item.key, name: item.name }
                  )
                }
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left',
                  selectedProjectKey === `${item.kind}:${item.key}`
                    ? 'bg-primary/10 ring-1 ring-primary/40'
                    : 'hover:bg-muted/60'
                )}
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                  {item.kind === 'local' ? (
                    <FolderPlus className="size-4 text-muted-foreground" />
                  ) : (
                    <Github className="size-4 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">{item.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{item.detail}</div>
                </div>
                {selectedProjectKey === `${item.kind}:${item.key}` ? (
                  <Check className="size-4 shrink-0 text-primary" />
                ) : null}
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}

interface ActionCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  disabled?: boolean;
  disabledHint?: string;
  onClick: () => void;
  trailing?: React.ReactNode;
}

function ActionCard({
  icon,
  title,
  description,
  disabled,
  disabledHint,
  onClick,
  trailing,
}: ActionCardProps) {
  return (
    <motion.button
      type="button"
      whileHover={disabled ? undefined : { y: -2 }}
      whileTap={disabled ? undefined : { scale: 0.98 }}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'group relative flex w-full flex-col items-start gap-2 rounded-lg border bg-card/40 p-4 text-left transition-all',
        'border-border/60 hover:border-primary/50 hover:bg-card/70',
        'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border/60 disabled:hover:bg-card/40'
      )}
    >
      {trailing ? <span className="absolute right-3 top-3">{trailing}</span> : null}
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/60 text-foreground transition-colors group-hover:bg-primary/15 group-hover:text-primary">
        {icon}
      </div>
      <div className="space-y-0.5">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground">{disabledHint ?? description}</div>
      </div>
    </motion.button>
  );
}
