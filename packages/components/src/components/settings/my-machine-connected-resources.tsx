import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Folder } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import type { AgentConfigMeta, MachineId } from '@lody/shared';
import { useLocalProjectsAdmin } from '@/hooks/use-local-projects-admin';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Switch } from '@lody/ui/switch';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { settingsSurface as surface } from './surface';
import type { ProjectSettingsRow } from './project-settings';

export type MachineConnectedProject = {
  key: string;
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
  onManageAgents: () => void;
};

/**
 * Keeps the already-loaded machine metadata visible while the heavier project
 * administration model catches up. Teammates get the same directory and Agent
 * inventory without mounting owner-only sharing controls.
 */
export function MachineConnectedResources(props: MachineConnectedResourcesProps) {
  if (props.readOnly) {
    return (
      <MachineConnectedResourcesContent
        configs={props.configs}
        projects={props.preloadedProjects}
        projectsLoading={props.projectsLoading}
        readOnly
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
  onManageAgents,
}: MachineConnectedResourcesProps) {
  const { sections, isLoading, onSharedWithTeamChange } = useLocalProjectsAdmin();
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
    <MachineConnectedResourcesContent
      configs={configs}
      projects={projects}
      projectsLoading={(isLoading || projectsLoading) && projects.length === 0}
      readOnly={false}
      onManageAgents={onManageAgents}
      onSharedWithTeamChange={onSharedWithTeamChange}
    />
  );
}

function MachineConnectedResourcesContent({
  configs,
  projects,
  projectsLoading,
  readOnly,
  onManageAgents,
  onSharedWithTeamChange,
}: {
  configs: AgentConfigMeta[];
  projects: PresentedProject[];
  projectsLoading: boolean;
  readOnly: boolean;
  onManageAgents: () => void;
  onSharedWithTeamChange?: (row: ProjectSettingsRow, sharedWithTeam: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();

  return (
    <div {...stylex.props(styles.root)}>
      <section {...stylex.props(styles.group)}>
        <div {...stylex.props(styles.heading)}>
          <Folder aria-hidden {...stylex.props(styles.headingIcon)} />
          <h3 {...stylex.props(styles.title)}>
            {t('settings.machines.connectedFolders', 'Connected folders')}
          </h3>
        </div>
        {!readOnly ? (
          <p {...stylex.props(styles.hint)}>
            {t(
              'settings.machines.folderSharingHint',
              'Sharing a folder also makes this machine available to the workspace.'
            )}
          </p>
        ) : null}
        {projectsLoading ? (
          <p {...stylex.props(styles.note)}>{t('common.loading', 'Loading...')}</p>
        ) : projects.length === 0 ? (
          <p {...stylex.props(styles.note)}>
            {t('settings.machines.noConnectedFolders', 'No connected folders on this machine.')}
          </p>
        ) : (
          // Inside the machine's card, so the list is a region fill with ruled
          // rows rather than a second card.
          <div {...stylex.props(surface.formBlock, styles.list)}>
            {projects.map((project, index) => {
              const adminRow = project.adminRow;
              return (
                <div
                  key={project.key}
                  {...stylex.props(styles.row, index > 0 && surface.lineRuled)}
                >
                  <div {...stylex.props(styles.rowText)}>
                    <div {...stylex.props(styles.truncate, styles.name)}>{project.name}</div>
                    <div {...stylex.props(styles.truncate, styles.path)}>{project.rootPath}</div>
                  </div>
                  <span {...stylex.props(styles.access)}>
                    {project.sharedWithTeam
                      ? t('workspace.machines.shared', 'Shared')
                      : t('workspace.machines.private', 'Private')}
                  </span>
                  {!readOnly && adminRow && onSharedWithTeamChange ? (
                    <Switch
                      checked={project.sharedWithTeam}
                      disabled={adminRow.isUpdating || !adminRow.canUpdateSharing}
                      aria-label={t('workspace.projects.shareToggle', 'Share project with team')}
                      onCheckedChange={(checked) => {
                        void onSharedWithTeamChange(adminRow, checked);
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section {...stylex.props(styles.group)}>
        <div {...stylex.props(styles.headingRow)}>
          <div {...stylex.props(styles.heading)}>
            <Bot aria-hidden {...stylex.props(styles.headingIcon)} />
            <h3 {...stylex.props(styles.title)}>
              {t('settings.machines.connectedAgents', 'Connected agents')}
            </h3>
          </div>
          {!readOnly ? (
            <Button variant="secondary" size="small" onClick={onManageAgents}>
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
              <Badge key={config.id}>{config.name}</Badge>
            ))}
          </div>
        )}
      </section>
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
  group: { display: 'flex', flexDirection: 'column', gap: space[2], minWidth: 0 },
  headingRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
  },
  heading: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  headingIcon: { flexShrink: 0, width: '14px', height: '14px', color: colors.tertiaryLabel },
  title: { margin: 0, fontSize: '0.75em', fontWeight: 400, color: colors.secondaryLabel },
  hint: { margin: 0, fontSize: '0.75em', lineHeight: 1.375, color: colors.secondaryLabel },
  note: { margin: 0, fontSize: '0.8em', color: colors.secondaryLabel },
  /** The region fill holds rows that run edge to edge, so it drops its padding. */
  list: { paddingInline: 0, paddingBlock: 0, overflow: 'hidden' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    paddingInline: space[3],
    paddingBlock: '10px',
  },
  rowText: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  name: { fontSize: '0.875em', color: colors.label },
  path: {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '11px',
    color: colors.secondaryLabel,
  },
  access: { flexShrink: 0, fontSize: '11px', color: colors.secondaryLabel },
  chips: { display: 'flex', flexWrap: 'wrap', gap: space[1.5] },
});
