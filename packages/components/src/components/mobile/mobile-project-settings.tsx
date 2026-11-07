import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Folder, FolderOpen, FolderPlus, Folders, Github } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import type { MachineId } from '@lody/shared';
import { Switch } from '@lody/ui/switch';
import { Tooltip } from '@lody/ui/tooltip';
import * as stylex from '@stylexjs/stylex';

import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { MobileSettingsRow, MobileSettingsSection } from '@/components/mobile/mobile-settings-row';
import { AgentIcon } from '@/components/icons/agent-icon';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';
import {
  getHistoryProviderLabel,
  ProjectHistoryImportPanel,
  type MultiRepoProjectRow,
  type ProjectRowProps,
  type ProjectSettingsRow,
  type ProjectSettingsViewProps,
  WorktreeSetupEditor,
} from '@/components/settings/project-settings';
import { mobileSurface } from './surface';

/** Tailwind's `transition-colors`: colour properties only, 150ms, standard ease. */
const TRANSITION_COLORS = {
  transitionProperty: 'color, background-color, border-color, text-decoration-color, fill, stroke',
  transitionDuration: '150ms',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

const styles = stylex.create({
  spinnerMuted: { color: 'hsl(var(--muted-foreground) / 1)' },
  multiRepoIdentity: {
    display: 'flex',
    minWidth: 'calc(var(--spacing) * 0)',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 3)',
  },
  multiRepoTile: {
    display: 'flex',
    width: 'calc(var(--spacing) * 9)',
    height: 'calc(var(--spacing) * 9)',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'var(--radius-xl)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--primary)) 10%, transparent)',
    color: 'hsl(var(--primary))',
  },
  multiRepoGlyph: { width: '1.05rem', height: '1.05rem' },
  multiRepoText: { minWidth: 'calc(var(--spacing) * 0)' },
  multiRepoLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.95rem',
    fontWeight: 'var(--font-weight-medium)',
    lineHeight: 'var(--leading-tight)',
    color: 'hsl(var(--foreground) / 1)',
  },
  multiRepoLabelBlock: { display: 'block' },
  multiRepoCount: {
    display: 'block',
    marginTop: 'calc(var(--spacing) * 0.5)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.78rem',
    lineHeight: 'var(--leading-tight)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  multiRepoChevron: {
    width: 'calc(var(--spacing) * 4)',
    height: 'calc(var(--spacing) * 4)',
  },
  /** The machine's name, with its online mark in front. */
  machineHeading: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[1.5],
  },
  /** The machine's online mark. */
  machineDot: {
    width: '0.375rem',
    height: '0.375rem',
    flexShrink: 0,
    borderRadius: themeRadius.full,
  },
  machineDotOnline: {
    backgroundColor: themeColors.statusSuccess,
    boxShadow: '0 0 0 2px hsl(var(--status-success) / 0.2)',
  },
  machineDotOffline: {
    backgroundColor: 'hsl(var(--muted-foreground) / 0.4)',
    boxShadow: '0 0 0 2px hsl(var(--muted))',
  },
  machineName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  /** The loading state. */
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[2],
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[6],
    paddingBottom: themeSpace[6],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
  /** The empty state. */
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[2],
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[10],
    paddingBottom: themeSpace[10],
    textAlign: 'center',
  },
  /** The mark of the empty state. */
  emptyGlyph: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: themeSpace[9],
    height: themeSpace[9],
    borderRadius: themeRadius.full,
    backgroundColor: 'hsl(var(--muted) / 0.6)',
  },
  emptyIcon: {
    width: themeSpace[4],
    height: themeSpace[4],
    color: themeColors.mutedForeground,
  },
  emptyText: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },

  /** A row's label, in the settings ink. */
  rowLabel: { color: themeColors.foreground },
  /** The value column of a row. */
  valueColumn: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  /** The second line of a row's value. */
  valueMeta: {
    marginTop: '0.125rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.72rem',
    lineHeight: 1.25,
    color: themeColors.mutedForeground,
  },
  /** The share control beside a row. */
  shareControl: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
  },
  /** The chevron at the end of a row. */
  chevron: {
    width: themeSpace[4],
    height: themeSpace[4],
  },
  /** The rule between two rows of a card. */
  rowDivider: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: themeColors.border,
  },
  /** The editors under a project row. */
  rowEditors: {
    marginInline: themeSpace[4],
    marginBottom: themeSpace[3],
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[5],
  },

  /** The history panel of a project row. */
  historyPanel: {
    marginInline: themeSpace[4],
    marginBottom: themeSpace[3],
    overflow: 'hidden',
    borderRadius: themeRadius.xl,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: themeColors.tabBorder,
  },
  /** The tab strip of the history panel. */
  historyTabs: {
    display: 'flex',
    overflowX: 'auto',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: themeColors.tabBorder,
    backgroundColor: themeColors.tabBar,
  },
  /** One tab of the strip. */
  historyTab: {
    position: 'relative',
    display: 'flex',
    height: themeSpace[9],
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1.5],
    paddingInline: themeSpace[3],
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: themeColors.tabBorder,
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    cursor: 'pointer',
    ...TRANSITION_COLORS,
  },
  /** The selected tab. */
  historyTabActive: {
    backgroundColor: themeColors.tabActive,
    color: themeColors.tabActiveForeground,
    '::after': {
      content: "''",
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: '0.125rem',
      backgroundColor: themeColors.tabActiveAccent,
    },
  },
  /** A tab that is not selected. */
  historyTabIdle: {
    backgroundColor: themeColors.tabInactive,
    color: themeColors.tabInactiveForeground,
    ':hover': {
      backgroundColor: themeColors.tabHover,
      color: themeColors.tabHoverForeground,
    },
  },
  /** The mark of a tab. */
  historyTabIcon: {
    width: themeSpace[3],
    height: themeSpace[3],
    opacity: 0.6,
  },
  /** A tab's label. */
  historyTabLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** The single-provider header of the history panel. */
  historyHead: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1.5],
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[2],
    paddingBottom: themeSpace[2],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: themeColors.tabBorder,
    backgroundColor: themeColors.tabBar,
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
});

function MobileMachineHeading({ name, online }: { name: string; online: boolean }) {
  const { t } = useTranslation();
  return (
    <span {...stylex.props(styles.machineHeading)}>
      <span
        {...stylex.props(
          styles.machineDot,
          online ? styles.machineDotOnline : styles.machineDotOffline
        )}
        title={
          online
            ? t('workspace.machines.online', 'Online')
            : t('workspace.machines.offline', 'Offline')
        }
      />
      <span {...stylex.props(styles.machineName)}>{name}</span>
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
  multiRepoProjects = [],
  onCreateMultiRepoProject,
  onOpenMultiRepoProject,
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
  const groupMachineIds = new Set(machineGroups.map((group) => group.machineId));
  const boundTo = (machineId: MachineId) =>
    multiRepoProjects.filter((project) => project.boundMachineId === machineId);
  // Projects that run anywhere, or whose machine this page does not list.
  const anyMachineProjects = initialMachineId
    ? []
    : multiRepoProjects.filter(
        (project) => !project.boundMachineId || !groupMachineIds.has(project.boundMachineId)
      );
  const multiRepoRow = (project: MultiRepoProjectRow, hasDivider: boolean) => (
    <MobileSettingsRow
      key={`multi:${project.id}`}
      hasDivider={hasDivider}
      label={
        <span {...stylex.props(styles.multiRepoIdentity)}>
          <span {...stylex.props(styles.multiRepoTile)}>
            <Folders {...stylex.props(styles.multiRepoGlyph)} />
          </span>
          <span {...stylex.props(styles.multiRepoText)}>
            <span {...stylex.props(styles.multiRepoLabel, styles.multiRepoLabelBlock)}>
              {project.name}
            </span>
            <span {...stylex.props(styles.multiRepoCount)}>
              {t('workspace.projects.repositoryCount', '{{count}} repositories or folders', {
                count: project.memberCount,
              })}
            </span>
          </span>
        </span>
      }
      onClick={onOpenMultiRepoProject ? () => onOpenMultiRepoProject(project.id) : undefined}
      trailing={<ChevronRight {...stylex.props(styles.multiRepoChevron)} />}
    />
  );
  const fallbackTitle = t('workspace.projects.title', 'Projects');
  const addFolderLabel = t('workspace.projects.addFolder', 'Add folder');

  if (
    (isLoading || githubProjectsLoading) &&
    totalProjects + totalGithubProjects === 0 &&
    machineGroups.length === 0
  ) {
    return (
      <MobileSettingsSection title={fallbackTitle}>
        <div {...stylex.props(styles.loading)}>
          <Spinner diameter="calc(var(--spacing) * 4)" />
          {t('workspace.projects.loading', 'Loading projects')}
        </div>
      </MobileSettingsSection>
    );
  }

  if (totalProjects + totalGithubProjects === 0 && machineGroups.length === 0) {
    return (
      <MobileSettingsSection title={fallbackTitle}>
        <div {...stylex.props(styles.empty)}>
          <div {...stylex.props(styles.emptyGlyph)}>
            <FolderOpen {...stylex.props(styles.emptyIcon)} />
          </div>
          <p {...stylex.props(styles.emptyText)}>
            {t('workspace.projects.empty', 'No projects yet')}
          </p>
        </div>
      </MobileSettingsSection>
    );
  }

  return (
    <Tooltip.Provider delay={200}>
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
                <span {...stylex.props(mobileSurface.identity)}>
                  <span {...stylex.props(mobileSurface.identityTile)}>
                    <FolderPlus {...stylex.props(mobileSurface.identityGlyph)} />
                  </span>
                  <span
                    {...stylex.props(
                      mobileSurface.identityLabel,
                      mobileSurface.identityLabelTight,
                      styles.rowLabel
                    )}
                  >
                    {addFolderLabel}
                  </span>
                </span>
              }
              onClick={() => onAddLocalProject(group.machineId)}
              trailing={<ChevronRight {...stylex.props(styles.chevron)} />}
            />
          ) : null}
          {boundTo(group.machineId).map((project) => multiRepoRow(project, true))}
        </MobileSettingsSection>
      ))}
      {anyMachineProjects.length > 0 || (onCreateMultiRepoProject && !initialMachineId) ? (
        <MobileSettingsSection title={t('workspace.projects.anyMachineTitle', 'Any machine')}>
          {anyMachineProjects.map((project, index) => multiRepoRow(project, index > 0))}
          {onCreateMultiRepoProject ? (
            <MobileSettingsRow
              hasDivider={anyMachineProjects.length > 0}
              label={
                <span {...stylex.props(styles.multiRepoIdentity)}>
                  <span {...stylex.props(styles.multiRepoTile)}>
                    <Folders {...stylex.props(styles.multiRepoGlyph)} />
                  </span>
                  <span {...stylex.props(styles.multiRepoLabel)}>
                    {t('workspace.projects.createMultiRepo', 'Several repositories or folders')}
                  </span>
                </span>
              }
              onClick={() => onCreateMultiRepoProject()}
              trailing={<ChevronRight {...stylex.props(styles.multiRepoChevron)} />}
            />
          ) : null}
        </MobileSettingsSection>
      ) : null}
      {visibleGithubSections.map((section) => (
        <MobileSettingsSection key={section.owner} title={`GitHub · ${section.owner}`}>
          {section.rows.map((row, rowIndex) => (
            <div key={row.key} {...stylex.props(rowIndex > 0 && styles.rowDivider)}>
              <MobileSettingsRow
                label={
                  <div {...stylex.props(mobileSurface.identity)}>
                    <div {...stylex.props(mobileSurface.identityTile)}>
                      <Github {...stylex.props(mobileSurface.identityGlyph)} />
                    </div>
                    <div {...stylex.props(styles.valueColumn)}>
                      <p
                        {...stylex.props(
                          mobileSurface.identityLabel,
                          mobileSurface.identityLabelTight,
                          styles.rowLabel
                        )}
                      >
                        {row.name}
                      </p>
                      <p {...stylex.props(styles.valueMeta)}>{row.repoFullName}</p>
                    </div>
                  </div>
                }
              />
              <div {...stylex.props(styles.rowEditors)}>
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
    </Tooltip.Provider>
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
    <div {...stylex.props(mobileSurface.identity)}>
      <div {...stylex.props(mobileSurface.identityTile)}>
        <Folder {...stylex.props(mobileSurface.identityGlyph)} />
      </div>
      <div {...stylex.props(styles.valueColumn)}>
        <p
          {...stylex.props(
            mobileSurface.identityLabel,
            mobileSurface.identityLabelTight,
            styles.rowLabel
          )}
        >
          {row.project.name}
        </p>
        <p {...stylex.props(styles.valueMeta)} title={row.project.rootPath}>
          {row.project.rootPath}
        </p>
      </div>
    </div>
  );

  const shareControl = (
    <div {...stylex.props(styles.shareControl)}>
      {row.isUpdating ? (
        <Spinner diameter="calc(var(--spacing) * 3.5)" {...stylex.props(styles.spinnerMuted)} />
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
    <div {...stylex.props(hasDivider && styles.rowDivider)}>
      <MobileSettingsRow label={label}>{shareControl}</MobileSettingsRow>
      <div {...stylex.props(styles.rowEditors)}>
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
        <div {...stylex.props(styles.historyPanel)}>
          {visibleHistoryImports.length > 1 ? (
            <div
              role="tablist"
              aria-label={t('workspace.projects.historyTablistLabel', 'History providers')}
              {...stylex.props(styles.historyTabs)}
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
                    {...stylex.props(
                      styles.historyTab,
                      active ? styles.historyTabActive : styles.historyTabIdle
                    )}
                    onClick={() => setActiveProviderKey(state.providerKey)}
                  >
                    <AgentIcon
                      cliType={state.provider.cliType}
                      agentType={state.provider.agentType}
                      {...stylex.props(styles.historyTabIcon)}
                    />
                    <span {...stylex.props(styles.historyTabLabel)}>{providerLabel}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div {...stylex.props(styles.historyHead)}>
              <AgentIcon
                cliType={activeHistoryState.provider.cliType}
                agentType={activeHistoryState.provider.agentType}
                {...stylex.props(styles.historyTabIcon)}
              />
              <span {...stylex.props(styles.historyTabLabel)}>
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
