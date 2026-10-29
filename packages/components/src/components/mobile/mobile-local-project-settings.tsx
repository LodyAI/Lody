import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { machineSupportsLocalProjectRemovalProtocol, type MachineId } from '@lody/shared';
import { ChevronRight, Wrench } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { Switch } from '@lody/ui/switch';
import { Tooltip } from '@lody/ui/tooltip';
import { currentWorkspaceIdAtom } from '@/atoms';
import { getMachineMetaMapAtom } from '@/atoms/machines';
import { useLocalProjectsAdmin } from '@/hooks/use-local-projects-admin';
import { useRemoveLocalProject } from '@/hooks/use-remove-local-project';
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
import { AgentIcon } from '@/components/icons/agent-icon';
import { getHistoryProviderLabel } from '@/components/settings/project-settings';
import { useAppCapability } from '@/lib/app-platform';
// The theme tokens are imported by path, not by the `@/` alias: the StyleX
// compiler links a theme file on its own and does not follow bundler aliases.
import { themeFontWeight, themeSpace } from '../../style/theme-scale.stylex';
import { mobileSurface } from './surface';

const styles = stylex.create({
  /** The share toggle's box: the switch, and its spinner when it works. */
  shareControl: { display: 'flex', alignItems: 'center', gap: themeSpace[2] },
  identityTileInk: {
    backgroundColor: 'color-mix(in oklab, hsl(var(--primary)) 10%, transparent)',
    color: 'hsl(var(--primary))',
  },
  chevronInk: {
    color: 'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 60%, transparent)',
  },
  /** The row that destroys the project. */
  deleteButton: {
    display: 'block',
    width: '100%',
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[3],
    textAlign: 'center',
    fontSize: '0.95rem',
    fontWeight: themeFontWeight.medium,
    color: 'hsl(var(--destructive) / 1)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: 'var(--tw-duration, var(--default-transition-duration))',
    transitionTimingFunction: 'var(--tw-ease, var(--default-transition-timing-function))',
    backgroundColor: {
      default: null,
      ':active': 'color-mix(in oklab, hsl(var(--destructive) / 1) 10%, transparent)',
    },
  },
});

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
  const { removeLocalProject } = useRemoveLocalProject();

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

  if (isLoading && !row) {
    return (
      <MobileSettingsSection title={t('workspace.projects.title', 'Project')}>
        <div {...stylex.props(mobileSurface.notice)}>
          <Spinner diameter="calc(var(--spacing) * 4)" />
          {t('workspace.projects.loading', 'Loading local projects')}
        </div>
      </MobileSettingsSection>
    );
  }

  if (!row) {
    return (
      <MobileSettingsSection title={t('workspace.projects.title', 'Project')}>
        <div {...stylex.props(mobileSurface.empty)}>
          <p {...stylex.props(mobileSurface.emptyText)}>
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
    <Tooltip.Provider delay={200}>
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
            <div {...stylex.props(styles.shareControl)}>
              {row.isUpdating ? (
                <Spinner diameter="calc(var(--spacing) * 4)" className="text-muted-foreground" />
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
            <div {...stylex.props(mobileSurface.identity)}>
              <div {...stylex.props(mobileSurface.identityTile, styles.identityTileInk)}>
                <Wrench {...stylex.props(mobileSurface.identityGlyph)} />
              </div>
              <span
                {...stylex.props(mobileSurface.identityLabel, mobileSurface.identityLabelTight)}
              >
                {t('workspace.projects.worktreeConfigRow', 'Worktree setup & cleanup')}
              </span>
            </div>
          }
          onClick={() => setWorktreeSheetOpen(true)}
          trailing={<ChevronRight {...stylex.props(mobileSurface.chevron, styles.chevronInk)} />}
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
                  <div {...stylex.props(mobileSurface.identity)}>
                    <div {...stylex.props(mobileSurface.identityTile, styles.identityTileInk)}>
                      <AgentIcon
                        cliType={state.provider.cliType}
                        agentType={state.provider.agentType}
                        className={stylex.props(mobileSurface.identityGlyph).className}
                      />
                    </div>
                    <span
                      {...stylex.props(
                        mobileSurface.identityLabel,
                        mobileSurface.identityLabelTight
                      )}
                    >
                      {state.providerLabel ?? getHistoryProviderLabel(state.provider)}
                    </span>
                  </div>
                }
                onClick={() => setSelectedProviderKey(state.providerKey)}
                trailing={
                  <ChevronRight {...stylex.props(mobileSurface.chevron, styles.chevronInk)} />
                }
              />
            ))}
          </MobileSettingsRowGroup>
        </MobileSettingsSection>
      ) : null}

      {machineSupportsLocalProjectRemovalProtocol(machineMeta) ? (
        <MobileSettingsSection>
          <button
            type="button"
            onClick={() => {
              void removeLocalProject({
                machineId: row.machineId,
                localProjectId: row.project.id,
                projectName: row.project.name,
                originalRootPath: projectPath ?? undefined,
              }).then((removed) => {
                if (removed) onRemoved?.();
              });
            }}
            {...stylex.props(styles.deleteButton)}
          >
            {t('workspace.projects.delete', 'Delete project')}
          </button>
        </MobileSettingsSection>
      ) : null}

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
    </Tooltip.Provider>
  );
}
