import { text as uiText } from '@lody/ui/tokens/scales.stylex';
import { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { workspaceContentModeAtom } from '@/atoms/workspace-content-mode';
import { E2eeMachineSharingSettings } from './e2ee/machine-sharing-settings';
import { useTranslation } from 'react-i18next';
import { Bot, Folder, Plus, Trash2 } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import type { AgentConfigMeta, MachineId } from '@lody/shared';
import { useLocalProjectsAdmin } from '@/hooks/use-local-projects-admin';
import { useRemoveLocalProject } from '@/hooks/use-remove-local-project';
import { AddLocalProjectDialogContainer } from '@/components/local-projects/add-local-project-dialog-container';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Switch } from '@lody/ui/switch';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { settingsSurface as surface } from './surface';
import { settingsMaterial } from './material.stylex';
import { settingsRecordsCard } from './compact-layout';
import type { ProjectSettingsRow } from './project-settings';
import { AgentIcon } from '@/components/icons/agent-icon';

export type MachineConnectedProject = {
  key: string;
  localProjectId?: string;
  name: string;
  rootPath: string;
  sharedWithTeam: boolean;
};

type PresentedProject = MachineConnectedProject & {
  adminRow?: ProjectSettingsRow;
};

type MachineConnectedResourcesProps = {
  machineId: MachineId;
  configs: AgentConfigMeta[];
  preloadedProjects: MachineConnectedProject[];
  projectsLoading: boolean;
  readOnly?: boolean;
  /** Render only folders (Access tab), only agents (Overview tab), or both. */
  section?: 'all' | 'folders' | 'agents';
  /** Nested desktop detail already owns horizontal alignment — drop extra inset. */
  flush?: boolean;
  onManageAgents: () => void;
};

/**
 * Keeps the already-loaded machine metadata visible while the heavier project
 * administration model catches up. Teammates get the same directory and Agent
 * inventory without mounting owner-only sharing controls.
 */
export function MachineConnectedResources(props: MachineConnectedResourcesProps) {
  const mode = useAtomValue(workspaceContentModeAtom);
  const section = props.section ?? 'all';
  if (
    mode?.descriptor &&
    'contentMode' in mode.descriptor &&
    mode.descriptor.contentMode === 'e2ee'
  ) {
    return (
      <>
        {section !== 'agents' ? (
          <E2eeMachineSharingSettings
            machineId={props.machineId}
            projects={props.preloadedProjects.flatMap((project) =>
              project.localProjectId
                ? [{ id: project.localProjectId, name: project.name, rootPath: project.rootPath }]
                : []
            )}
          />
        ) : null}
        {section !== 'folders' ? (
          <MachineConnectedResourcesContent
            machineId={props.machineId}
            configs={props.configs}
            projects={[]}
            projectsLoading={props.projectsLoading}
            readOnly={!!props.readOnly}
            hideFolders
            hideAgents={false}
            flush={props.flush}
            onManageAgents={props.onManageAgents}
          />
        ) : null}
      </>
    );
  }
  if (props.readOnly) {
    return (
      <MachineConnectedResourcesContent
        machineId={props.machineId}
        configs={props.configs}
        projects={props.preloadedProjects}
        projectsLoading={props.projectsLoading}
        readOnly
        hideFolders={section === 'agents'}
        hideAgents={section === 'folders'}
        flush={props.flush}
        onManageAgents={props.onManageAgents}
      />
    );
  }

  return <ManageableMachineConnectedResources {...props} />;
}

function ManageableMachineConnectedResources({
  machineId,
  configs,
  preloadedProjects,
  projectsLoading,
  section = 'all',
  flush = false,
  onManageAgents,
}: MachineConnectedResourcesProps) {
  const { sections, isLoading, onSharedWithTeamChange } = useLocalProjectsAdmin();
  const { removeLocalProject } = useRemoveLocalProject();
  const [addFolderOpen, setAddFolderOpen] = useState(false);
  const adminProjects = useMemo(
    () => sections.find((section) => section.machineId === machineId)?.rows ?? [],
    [machineId, sections]
  );
  const projects: PresentedProject[] =
    adminProjects.length > 0
      ? adminProjects.map((row) => ({
          key: row.key,
          name: row.project.name,
          rootPath: row.project.rootPath,
          sharedWithTeam: row.sharedWithTeam,
          adminRow: row,
        }))
      : preloadedProjects;

  return (
    <>
      <MachineConnectedResourcesContent
        machineId={machineId}
        configs={configs}
        projects={projects}
        projectsLoading={(isLoading || projectsLoading) && projects.length === 0}
        readOnly={false}
        hideFolders={section === 'agents'}
        hideAgents={section === 'folders'}
        flush={flush}
        onManageAgents={onManageAgents}
        onSharedWithTeamChange={onSharedWithTeamChange}
        onAddFolder={() => setAddFolderOpen(true)}
        onRemoveFolder={(row) => {
          void removeLocalProject({
            machineId: row.machineId,
            localProjectId: row.project.id,
            projectName: row.project.name,
            originalRootPath: row.project.rootPath,
          });
        }}
      />
      {section !== 'agents' ? (
        <AddLocalProjectDialogContainer
          open={addFolderOpen}
          onOpenChange={setAddFolderOpen}
          initialMachineId={machineId}
        />
      ) : null}
    </>
  );
}

function MachineConnectedResourcesContent({
  machineId,
  configs,
  projects,
  projectsLoading,
  readOnly,
  onManageAgents,
  onSharedWithTeamChange,
  onAddFolder,
  onRemoveFolder,
  hideFolders,
  hideAgents,
  flush,
}: {
  machineId: MachineId;
  configs: AgentConfigMeta[];
  projects: PresentedProject[];
  projectsLoading: boolean;
  readOnly: boolean;
  hideFolders?: boolean;
  hideAgents?: boolean;
  flush?: boolean;
  onManageAgents: () => void;
  onSharedWithTeamChange?: (row: ProjectSettingsRow, sharedWithTeam: boolean) => Promise<void>;
  onAddFolder?: () => void;
  onRemoveFolder?: (row: ProjectSettingsRow) => void;
}) {
  const { t } = useTranslation();

  const foldersAction =
    !readOnly && onAddFolder ? (
      <Button type="button" variant="secondary" size="small" onClick={onAddFolder}>
        <Plus aria-hidden {...stylex.props(styles.actionIcon)} />
        {t('settings.machines.addFolder', 'Add folder')}
      </Button>
    ) : null;

  const agentsAction = !readOnly ? (
    <Button
      data-testid="settings-machine-manage-agents"
      data-machine-id={machineId}
      variant="secondary"
      size="small"
      onClick={onManageAgents}
    >
      {t('settings.machines.manageAgents', 'Manage in Agents')}
    </Button>
  ) : null;

  const folderRows = projects.map((project, index) => {
    const adminRow = project.adminRow;
    return (
      <div
        key={project.key}
        {...stylex.props(styles.row, (flush || index > 0) && surface.lineRuled)}
      >
        <div {...stylex.props(styles.rowText)}>
          <div {...stylex.props(styles.truncate, styles.name)}>{project.name}</div>
          <div {...stylex.props(styles.truncate, styles.path)}>{project.rootPath}</div>
        </div>
        {!readOnly && adminRow && onSharedWithTeamChange ? (
          <>
            <span {...stylex.props(styles.access)}>
              {t('workspace.projects.shareToggle', 'Share project with team')}
            </span>
            <Switch
              checked={project.sharedWithTeam}
              disabled={adminRow.isUpdating || !adminRow.canUpdateSharing}
              aria-label={t('workspace.projects.shareToggle', 'Share project with team')}
              onCheckedChange={(checked) => {
                void onSharedWithTeamChange(adminRow, checked);
              }}
            />
            {onRemoveFolder ? (
              <Button
                type="button"
                variant="ghost"
                size="small"
                icon
                aria-label={t('settings.machines.unlinkFolder', 'Remove folder')}
                onClick={() => onRemoveFolder(adminRow)}
              >
                <Trash2 aria-hidden {...stylex.props(styles.actionIcon)} />
              </Button>
            ) : null}
          </>
        ) : (
          <span {...stylex.props(styles.access)}>
            {project.sharedWithTeam
              ? t('workspace.machines.shared', 'Shared')
              : t('workspace.machines.private', 'Private')}
          </span>
        )}
      </div>
    );
  });

  if (flush) {
    // One records card for everything this machine connects: each kind is a
    // titled band of the card, its action on the band's own line, so the two
    // read as one group instead of two one-line boxes.
    return (
      <section
        aria-label={t('settings.machines.connectedResources', 'Connected resources')}
        {...stylex.props(settingsRecordsCard)}
      >
        {!hideFolders && (
          <>
            <div {...stylex.props(styles.band)}>
              <Folder aria-hidden {...stylex.props(styles.headingIcon)} />
              <h3 {...stylex.props(styles.bandTitle)}>
                {t('settings.machines.connectedFolders', 'Connected folders')}
              </h3>
              {foldersAction}
            </div>
            {projectsLoading ? (
              <p {...stylex.props(styles.bandNote)}>{t('common.loading', 'Loading...')}</p>
            ) : projects.length === 0 ? (
              <p {...stylex.props(styles.bandNote)}>
                {t('settings.machines.noConnectedFoldersShort', 'No folders connected yet.')}
              </p>
            ) : (
              folderRows
            )}
          </>
        )}

        {!hideAgents && (
          <>
            <div {...stylex.props(styles.band, !hideFolders && styles.bandAfter)}>
              <Bot aria-hidden {...stylex.props(styles.headingIcon)} />
              <h3 {...stylex.props(styles.bandTitle)}>
                {t('settings.machines.connectedAgents', 'Connected agents')}
              </h3>
              {agentsAction}
            </div>
            {configs.length === 0 ? (
              <p {...stylex.props(styles.bandNote)}>
                {t('settings.machines.noConnectedAgents', 'No agents configured for this machine.')}
              </p>
            ) : (
              <div {...stylex.props(styles.cardChips, styles.bandBody)}>
                {configs.map((config) => (
                  <Badge
                    key={config.id}
                    icon={
                      <AgentIcon
                        cliType={config.cliType}
                        agentType={config.agentType}
                        brandId={config.brandId}
                        env={config.env}
                        className={stylex.props(styles.agentIcon).className}
                      />
                    }
                  >
                    {config.name}
                  </Badge>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    );
  }

  return (
    <div {...stylex.props(styles.root)}>
      {!hideFolders && (
        <section {...stylex.props(styles.group)}>
          <div {...stylex.props(styles.headingRow)}>
            <div {...stylex.props(styles.heading)}>
              <Folder aria-hidden {...stylex.props(styles.headingIcon)} />
              <h3 {...stylex.props(styles.title)}>
                {t('settings.machines.connectedFolders', 'Connected folders')}
              </h3>
            </div>
            {foldersAction}
          </div>
          {projectsLoading ? (
            <p {...stylex.props(styles.note)}>{t('common.loading', 'Loading...')}</p>
          ) : projects.length === 0 ? (
            <p {...stylex.props(styles.note)}>
              {t('settings.machines.noConnectedFoldersShort', 'No folders connected yet.')}
            </p>
          ) : (
            <div {...stylex.props(surface.formBlock, styles.list)}>{folderRows}</div>
          )}
        </section>
      )}

      {!hideAgents && (
        <section {...stylex.props(styles.group)}>
          <div {...stylex.props(styles.headingRow)}>
            <div {...stylex.props(styles.heading)}>
              <Bot aria-hidden {...stylex.props(styles.headingIcon)} />
              <h3 {...stylex.props(styles.title)}>
                {t('settings.machines.connectedAgents', 'Connected agents')}
              </h3>
            </div>
            {!readOnly ? (
              <Button
                data-testid="settings-machine-manage-agents"
                data-machine-id={machineId}
                variant="secondary"
                size="small"
                onClick={onManageAgents}
              >
                {t('settings.machines.manageAgents', 'Manage in Agents')}
              </Button>
            ) : null}
          </div>
          {configs.length === 0 ? (
            <p {...stylex.props(styles.note)}>
              {t('settings.machines.noConnectedAgents', 'No agents configured for this machine.')}
            </p>
          ) : (
            <div {...stylex.props(styles.chips)}>
              {configs.map((config) => (
                <Badge
                  key={config.id}
                  icon={
                    <AgentIcon
                      cliType={config.cliType}
                      agentType={config.agentType}
                      brandId={config.brandId}
                      env={config.env}
                      className={stylex.props(styles.agentIcon).className}
                    />
                  }
                >
                  {config.name}
                </Badge>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[6],
    paddingInline: space[4],
    paddingTop: '20px',
    paddingBottom: space[4],
  },
  rootFlush: {
    paddingInline: 0,
    paddingTop: space[1],
    paddingBottom: 0,
  },
  group: { display: 'flex', flexDirection: 'column', gap: space[2], minWidth: 0 },
  headingRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
  },
  heading: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  headingIcon: { flexShrink: 0, width: '14px', height: '14px', color: colors.tertiaryLabel },
  actionIcon: { flexShrink: 0, width: '14px', height: '14px' },
  title: {
    margin: 0,
    fontSize: uiText.footnoteSize,
    fontWeight: 400,
    color: colors.secondaryLabel,
  },
  hint: {
    margin: 0,
    fontSize: uiText.footnoteSize,
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
  note: { margin: 0, fontSize: uiText.footnoteSize, color: colors.secondaryLabel },
  /** A titled band of the connected-resources card: its name, then its action. */
  band: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minHeight: '44px',
    paddingInline: space[4],
    paddingBlock: space[2],
  },
  /** A later band starts a new part of the card, ruled from the one above. */
  bandAfter: { boxShadow: settingsMaterial.rowRule },
  bandTitle: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    fontSize: uiText.subheadlineSize,
    fontWeight: 500,
    color: colors.label,
  },
  bandNote: {
    margin: 0,
    paddingInline: space[4],
    paddingTop: 0,
    paddingBottom: space[3],
    fontSize: uiText.footnoteSize,
    color: colors.tertiaryLabel,
  },
  bandBody: { paddingTop: 0 },
  cardChips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: space[1.5],
    paddingInline: space[4],
    paddingBlock: space[3],
  },
  /** The region fill holds rows that run edge to edge, so it drops its padding. */
  list: { paddingInline: 0, paddingBlock: 0, overflow: 'hidden' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    paddingInline: space[4],
    paddingBlock: '10px',
  },
  rowText: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  name: { fontSize: uiText.footnoteSize, color: colors.label },
  path: {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '11px',
    color: colors.secondaryLabel,
  },
  access: { flexShrink: 0, fontSize: '11px', color: colors.secondaryLabel },
  chips: { display: 'flex', flexWrap: 'wrap', gap: space[1.5] },
  agentIcon: { width: '100%', height: '100%' },
});
