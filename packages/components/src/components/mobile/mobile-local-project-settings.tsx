import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { machineSupportsLocalProjectRemovalProtocol, type MachineId } from '@lody/shared';
import { ChevronRight, Loader2, Wrench } from 'lucide-react';
import { Switch } from '@/ui/switch';
import { TooltipProvider } from '@/ui/tooltip';
import { currentWorkspaceIdAtom } from '@/atoms';
import { getMachineMetaMapAtom } from '@/atoms/machines';
import { useLocalProjectsAdmin } from '@/hooks/use-local-projects-admin';
import { useRemoveLocalProject } from '@/hooks/use-remove-local-project';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { getLocalProjectVisibilityKey } from '@/lib/visible-local-project-index';
import type { ProjectSkillsSource } from '@/hooks/use-project-skills';
import {
  MobileSettingsRow,
  MobileSettingsRowGroup,
  MobileSettingsSection,
} from '@/components/mobile/mobile-settings-row';
import { MobileAcpHistorySheet } from '@/components/mobile/mobile-acp-history-sheet';
import { MobileWorktreeConfigSheet } from '@/components/mobile/mobile-worktree-config-sheet';
import { MobileProjectSkillsRow } from '@/components/mobile/mobile-project-skills-sheet';
import { MobileRemoveLocalProjectSheet } from '@/components/mobile/mobile-remove-local-project-sheet';
import { AgentIcon } from '@/components/icons/agent-icon';
import { getHistoryProviderLabel } from '@/components/settings/project-settings';
import { useAppCapability } from '@/lib/app-platform';

export type MobileLocalProjectSettingsProps = {
  /** The machine that owns the project we're viewing. */
  machineId: string;
  /** Local-project id within that machine. */
  projectId: string;
  /** Called after the project is removed so the screen can navigate away
     (the project no longer exists). */
  onRemoved?: () => void;
};

/**
 * Per-project settings rendered inside the mobile project detail
 * page's Settings tab. Three sections at the top level:
 *   1. Workspace sharing — single "share with team" toggle. We omit
 *      the project name + path here because the project screen's own
 *      header already shows them; repeating felt redundant.
 *   2. Worktree — a single "Worktree setup & cleanup" row. Tapping it
 *      opens `MobileWorktreeConfigSheet` with the actual setup +
 *      cleanup editors, so the first level stays a short list instead
 *      of two tall script boxes.
 *   3. Conversation sync — a list of ACP providers available on the
 *      project's machine. Tapping a row opens the
 *      `MobileAcpHistorySheet` (vaul bottom sheet).
 *
 * Each drill-in is a bottom sheet (not an in-tab drill) so the project
 * screen's own back chip stays the sole "leave here" affordance —
 * drilling inside the Settings tab rendered two competing back arrows.
 */
export function MobileLocalProjectSettings({
  machineId,
  projectId,
  onRemoved,
}: MobileLocalProjectSettingsProps) {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const machineMeta = useAtomValue(getMachineMetaMapAtom).get(machineId as MachineId);
  const onlineMachineIds = useOnlineMachineIds();
  // Team sharing is cloud-only; the whole sharing section hides on the local
  // (open-source) platform.
  const teamSharingAvailable = useAppCapability('teamSharing');
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
  const { removeLocalProject, preflightLocalProjectRemoval, getRemoveLocalProjectImpact } =
    useRemoveLocalProject();
  const [removeSheetOpen, setRemoveSheetOpen] = useState(false);

  const projectKey = getLocalProjectVisibilityKey(machineId, projectId);
  const skillsSource: ProjectSkillsSource | null = workspaceId
    ? { kind: 'local', workspaceId, machineId, localProjectId: projectId }
    : null;
  const row = useMemo(() => {
    for (const section of sections) {
      const found = section.rows.find((entry) => entry.key === projectKey);
      if (found) return found;
    }
    return null;
  }, [projectKey, sections]);

  /* Which provider the user has drilled into. `null` = list view. */
  const [selectedProviderKey, setSelectedProviderKey] = useState<string | null>(null);
  /* Worktree setup + cleanup live behind a single drill-in row that opens
     this sheet, so the Settings tab's first level stays a short list. */
  const [worktreeSheetOpen, setWorktreeSheetOpen] = useState(false);
  const removeImpact = useMemo(
    () =>
      row
        ? getRemoveLocalProjectImpact({
            machineId: row.machineId,
            localProjectId: row.project.id,
          })
        : { conversationCount: 0, runningSessionCount: 0 },
    [getRemoveLocalProjectImpact, row]
  );

  if (isLoading && !row) {
    return (
      <MobileSettingsSection title={t('workspace.projects.title', 'Project')}>
        <div className="flex items-center justify-center gap-2 px-4 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('workspace.projects.loading', 'Loading local projects')}
        </div>
      </MobileSettingsSection>
    );
  }

  if (!row) {
    return (
      <MobileSettingsSection title={t('workspace.projects.title', 'Project')}>
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            {t('workspace.projects.notAvailable', '此项目在当前机器上不可用')}
          </p>
        </div>
      </MobileSettingsSection>
    );
  }

  const visibleHistoryImports = row.historyImports.filter(
    (state) => state.canSync || state.catalog
  );
  const selectedState =
    selectedProviderKey != null
      ? visibleHistoryImports.find((state) => state.providerKey === selectedProviderKey)
      : null;

  const projectPath = typeof row.project.rootPath === 'string' ? row.project.rootPath : null;

  return (
    <TooltipProvider delayDuration={200}>
      {teamSharingAvailable && (
        <MobileSettingsSection
          title={t('workspace.projects.workspaceShareTitle', '工作区共享')}
          description={
            row.canUpdateSharing
              ? undefined
              : t(
                  'workspace.projects.sharePreparing',
                  'Sharing will be available when this machine finishes connecting.'
                )
          }
        >
          <MobileSettingsRow label={t('workspace.projects.shareToggle', '与团队共享')}>
            <div className="flex items-center gap-2">
              {row.isUpdating ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : null}
              <Switch
                checked={row.sharedWithTeam}
                disabled={row.isUpdating || !row.canUpdateSharing || !onSharedWithTeamChange}
                aria-label={t('workspace.projects.shareToggle', '与团队共享')}
                onCheckedChange={(checked) => {
                  void onSharedWithTeamChange?.(row, checked);
                }}
              />
            </div>
          </MobileSettingsRow>
        </MobileSettingsSection>
      )}

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
          onClick={() => setWorktreeSheetOpen(true)}
          trailing={<ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />}
        />
      </MobileSettingsSection>

      <MobileProjectSkillsRow source={skillsSource} />

      {visibleHistoryImports.length > 0 ? (
        <MobileSettingsSection
          title={t('workspace.projects.historySyncSection', '对话同步')}
          description={t(
            'workspace.projects.historySyncSectionHelper',
            '从其他 ACP agent 中导入该项目的历史对话。'
          )}
        >
          <MobileSettingsRowGroup>
            {visibleHistoryImports.map((state) => (
              <MobileSettingsRow
                key={state.providerKey}
                label={
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <AgentIcon
                        cliType={state.provider.cliType}
                        agentType={state.provider.agentType}
                        className="h-[1.05rem] w-[1.05rem]"
                      />
                    </div>
                    <span className="truncate text-[0.95rem] font-medium leading-tight">
                      {getHistoryProviderLabel(state.provider)}
                    </span>
                  </div>
                }
                onClick={() => setSelectedProviderKey(state.providerKey)}
                trailing={<ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />}
              />
            ))}
          </MobileSettingsRowGroup>
        </MobileSettingsSection>
      ) : null}

      {machineSupportsLocalProjectRemovalProtocol(machineMeta) ? (
        <MobileSettingsSection>
          <button
            type="button"
            onClick={() => setRemoveSheetOpen(true)}
            className="block w-full px-4 py-3 text-center text-[0.95rem] font-medium text-destructive transition-colors active:bg-destructive/10"
          >
            {t('workspace.projects.delete', 'Delete project')}
          </button>
        </MobileSettingsSection>
      ) : null}

      <MobileRemoveLocalProjectSheet
        open={removeSheetOpen}
        onOpenChange={setRemoveSheetOpen}
        projectName={row.project.name}
        pathLabel={projectPath}
        deviceName={row.machineName}
        deviceOnline={onlineMachineIds.has(row.machineId)}
        conversationCount={removeImpact.conversationCount}
        runningSessionCount={removeImpact.runningSessionCount}
        canCleanupWorktrees={
          onlineMachineIds.has(row.machineId) &&
          machineSupportsLocalProjectRemovalProtocol(machineMeta)
        }
        onPreflightCleanup={() =>
          preflightLocalProjectRemoval({
            machineId: row.machineId,
            localProjectId: row.project.id,
          })
        }
        onConfirm={async (options) => {
          const removed = await removeLocalProject(
            {
              machineId: row.machineId,
              localProjectId: row.project.id,
              projectName: row.project.name,
              originalRootPath: projectPath ?? undefined,
            },
            options
          );
          if (removed) onRemoved?.();
          return removed;
        }}
      />

      <MobileWorktreeConfigSheet
        open={worktreeSheetOpen}
        onOpenChange={setWorktreeSheetOpen}
        shell={row.shell}
        setupConfig={row.worktreeSetup}
        cleanupConfig={row.worktreeCleanup}
        isSetupLoading={row.isWorktreeSetupLoading}
        isSetupSaving={row.isWorktreeSetupSaving}
        setupError={row.worktreeSetupError}
        isCleanupLoading={row.isWorktreeCleanupLoading}
        isCleanupSaving={row.isWorktreeCleanupSaving}
        cleanupError={row.worktreeCleanupError}
        onSetupSave={(config) => onWorktreeSetupChange?.(row, config)}
        onCleanupSave={(config) => onWorktreeCleanupChange?.(row, config)}
      />

      {/* Provider detail surface — stacked as a bottom sheet so the
         project page's existing back chip stays the sole "leave
         here" affordance. `selectedState` is keyed by providerKey,
         so reopening for a different provider picks up that
         provider's catalog / selection without leaking state. */}
      {selectedState ? (
        <MobileAcpHistorySheet
          open
          onOpenChange={(open) => {
            if (!open) setSelectedProviderKey(null);
          }}
          row={row}
          state={selectedState}
          onSyncHistory={onSyncHistory}
          onImportHistory={onImportHistory}
          onResolveHistoryConflict={onResolveHistoryConflict}
          onHistorySelectionChange={onHistorySelectionChange}
        />
      ) : null}
    </TooltipProvider>
  );
}
