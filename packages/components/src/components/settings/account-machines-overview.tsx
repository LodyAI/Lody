import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { ChevronDown, CircleHelp, Folder, MonitorCog } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, focus, radius, space } from '@lody/ui/tokens/scales.stylex';
import type { AgentConfigMeta, MachineId } from '@lody/shared';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { userAtom } from '@/atoms';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { useOpenSettings } from '@/hooks/use-open-settings';
import { useVisibleLocalProjectsFromMachineIndex } from '@/hooks/use-visible-local-projects';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { isElectronRenderer } from '@/lib/electron';
import { Button, type ButtonSize, type ButtonVariant } from '@lody/ui/button';
import { Menu } from '@lody/ui/menu';
import { Tooltip } from '@lody/ui/tooltip';
import { CompactSection } from './compact-layout';
import { settingsSurface as surface } from './surface';
import { settingsType as type } from './type.stylex';

export type AccountMachineDirectory = {
  key: string;
  name: string;
  rootPath: string;
  sharedWithTeam: boolean;
};

export type AccountMachineOverviewItem = {
  id: MachineId;
  name: string;
  os?: string;
  isOnline: boolean;
  sharedWithTeam: boolean;
  agents: AgentConfigMeta[];
  directories: AccountMachineDirectory[];
};

export function AccountMachinesOverview() {
  const { openSettings } = useOpenSettings();
  const currentUserId = useAtomValue(userAtom)?.id ?? null;
  const localMachineId = useAtomValue(localMachineIdAtom);
  const onlineMachineIds = useOnlineMachineIds();
  const machineIndex = useVisibleMachineMetas();
  const projectIndex = useVisibleLocalProjectsFromMachineIndex(machineIndex);

  const ownMachines = useMemo(
    () =>
      [...machineIndex.machines.values()].filter((machine) => {
        if (machine.id === localMachineId) return true;
        const ownerUserId =
          machineIndex.accessByMachineId.get(machine.id)?.ownerUserId ?? machine.ownerUserId;
        return Boolean(currentUserId && ownerUserId === currentUserId);
      }),
    [currentUserId, localMachineId, machineIndex.accessByMachineId, machineIndex.machines]
  );
  const ownMachineIds = useMemo(() => ownMachines.map((machine) => machine.id), [ownMachines]);
  useMachineFlockAgentConfigsForMachineIds(ownMachineIds);
  const allAgentConfigs = useAtomValue(getAllAgentConfigAtom);

  const items = useMemo<AccountMachineOverviewItem[]>(() => {
    const agentsByMachine = new Map<MachineId, AgentConfigMeta[]>();
    for (const config of allAgentConfigs) {
      if (!agentsByMachine.has(config.machineId)) agentsByMachine.set(config.machineId, []);
      agentsByMachine.get(config.machineId)?.push(config);
    }

    const directoriesByMachine = new Map<MachineId, AccountMachineDirectory[]>();
    for (const [key, entry] of projectIndex.projects) {
      if (!directoriesByMachine.has(entry.machineId)) {
        directoriesByMachine.set(entry.machineId, []);
      }
      directoriesByMachine.get(entry.machineId)?.push({
        key,
        name: entry.project.name,
        rootPath: entry.project.rootPath,
        sharedWithTeam: projectIndex.accessByProjectKey.get(key)?.sharedWithTeam ?? false,
      });
    }

    return ownMachines
      .map((machine) => ({
        id: machine.id,
        name: machine.name || machine.id,
        os: machine.os || undefined,
        isOnline: onlineMachineIds.has(machine.id),
        sharedWithTeam: machineIndex.accessByMachineId.get(machine.id)?.sharedWithTeam ?? false,
        agents: (agentsByMachine.get(machine.id) ?? []).sort((left, right) =>
          left.name.localeCompare(right.name)
        ),
        directories: (directoriesByMachine.get(machine.id) ?? []).sort((left, right) =>
          left.name.localeCompare(right.name)
        ),
      }))
      .sort((left, right) => {
        if (left.isOnline !== right.isOnline) return left.isOnline ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
  }, [
    allAgentConfigs,
    machineIndex.accessByMachineId,
    onlineMachineIds,
    ownMachines,
    projectIndex,
  ]);

  return (
    <AccountMachinesOverviewView
      items={items}
      loading={machineIndex.isLoading || projectIndex.isLoading}
      currentMachineId={isElectronRenderer() ? localMachineId : null}
      onConfigureAgents={(machineId) => openSettings('agents', { machineId })}
      onManageMachine={(machineId) => openSettings('machines', { machineId })}
      onOpenDirectory={(machineId, projectKey) =>
        openSettings('projects', { machineId, projectKey })
      }
      onOpenDirectories={(machineId) => openSettings('projects', { machineId })}
    />
  );
}

/** Wide enough for the machine's name and its three trailing columns on one line. */
const ROOMY = '@container (min-width: 30rem)';

const styles = stylex.create({
  /** The container the rows measure; the list is its only child. */
  frame: { minWidth: 0, containerType: 'inline-size' },
  /**
   * Every machine shares one set of columns — the name takes the rest, each
   * trailing column is as wide as its widest cell — so a count or a button sits
   * at the same x on every row however long the row's own text is.
   */
  list: {
    display: { default: 'flex', [ROOMY]: 'grid' },
    flexDirection: 'column',
    gridTemplateColumns: { default: null, [ROOMY]: 'minmax(0, 1fr) auto auto auto' },
    minWidth: 0,
  },
  /**
   * One machine: who it is, then how many Agents and directories it has, then
   * its settings. In a narrow panel the trailing half wraps under the name.
   */
  row: {
    display: { default: 'flex', [ROOMY]: 'grid' },
    flexWrap: 'wrap',
    gridColumn: { default: null, [ROOMY]: '1 / -1' },
    gridTemplateColumns: { default: null, [ROOMY]: 'subgrid' },
    alignItems: 'center',
    columnGap: space[1],
    rowGap: space[1],
    paddingInline: space[4],
    paddingBlock: '8px',
  },
  identity: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    // Narrow, the name owns its line and the three trailing cells wrap together.
    flexBasis: { default: '100%', [ROOMY]: 'auto' },
    minWidth: 0,
    paddingInlineEnd: space[3],
  },
  identityText: { minWidth: 0 },
  dot: {
    flexShrink: 0,
    width: '8px',
    height: '8px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: colors.tertiaryLabel,
  },
  dotOnline: {
    backgroundColor: colors.success,
    boxShadow: `0 0 0 3px color-mix(in oklab, ${colors.success} 20%, transparent)`,
  },
  nameLine: { display: 'flex', alignItems: 'baseline', gap: space[2], minWidth: 0 },
  /** The machine's name opens its settings: a link in the row's own words. */
  nameButton: {
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.mini,
    cornerShape: corner.round,
    backgroundColor: 'transparent',
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: '1em',
    fontWeight: 400,
    lineHeight: type.leading,
    textAlign: 'start',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    outlineStyle: 'none',
    textDecoration: { default: 'none', ':hover': 'underline' },
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 ${focus.ringWidth} ${colors.accent}` },
  },
  /** An offline machine reads a step quieter: it can be managed, not used. */
  nameOffline: { color: colors.secondaryLabel },
  /** "This machine": a note beside the name, in the name's own line. */
  here: { flexShrink: 0, fontSize: type.caption, color: colors.secondaryLabel },
  status: {
    margin: 0,
    fontSize: type.caption,
    lineHeight: type.leading,
    color: colors.secondaryLabel,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** A trailing column's cell: its content meets the column's end edge. */
  cell: { justifySelf: 'end' },
  /** The first trailing cell pushes the wrapped cells to the row's end edge. */
  cellLead: { marginInlineStart: { default: 'auto', [ROOMY]: 0 } },
  count: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  countOffline: { color: colors.secondaryLabel },
  note: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: space[2] },
  icon: { flexShrink: 0, width: '14px', height: '14px' },
  iconHint: { color: colors.tertiaryLabel },
  /** A glyph inside a box that sizes it — an icon Button's, a menu row's. */
  glyph: { width: '100%', height: '100%' },
  truncate: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  tooltipHint: { margin: 0, marginTop: '2px', opacity: 0.7 },
  tooltipTitle: { margin: 0 },
  /** A directory in the menu: its name, and where it is on disk under it. */
  directory: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingBlock: space[1],
  },
  directoryPath: {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '10px',
    color: colors.secondaryLabel,
  },
});

export function AccountMachinesOverviewView({
  items,
  loading = false,
  currentMachineId,
  onConfigureAgents,
  onManageMachine,
  onOpenDirectory,
  onOpenDirectories,
}: {
  items: AccountMachineOverviewItem[];
  loading?: boolean;
  currentMachineId?: MachineId | null;
  onConfigureAgents: (machineId: MachineId) => void;
  onManageMachine: (machineId: MachineId) => void;
  onOpenDirectory: (machineId: MachineId, projectKey: string) => void;
  onOpenDirectories: (machineId: MachineId) => void;
}) {
  const { t } = useTranslation();

  return (
    <Tooltip.Provider delay={250}>
      <CompactSection
        title={t('settings.account.machines.title', 'My machines')}
        boxed
        description={t(
          'settings.account.machines.description',
          'Machines connected by you, with their Agents and shared directories.'
        )}
        actions={<PrivacyHelp />}
      >
        {loading && items.length === 0 ? (
          <p {...stylex.props(surface.cardNote, styles.note)}>
            <Spinner size="small" label={null} />
            {t('workspace.machines.loadingVisibility', 'Loading machines')}
          </p>
        ) : items.length === 0 ? (
          <p {...stylex.props(surface.cardNote, styles.note)}>
            {t('workspace.machines.empty', 'No machines connected')}
          </p>
        ) : (
          <div {...stylex.props(styles.frame)}>
            <div {...stylex.props(styles.list)}>
              {items.map((item, index) => (
                <div key={item.id} {...stylex.props(styles.row, index > 0 && surface.lineRuled)}>
                  <div {...stylex.props(styles.identity)}>
                    <span
                      {...stylex.props(styles.dot, item.isOnline && styles.dotOnline)}
                      aria-hidden="true"
                    />
                    <div {...stylex.props(styles.identityText)}>
                      <div {...stylex.props(styles.nameLine)}>
                        <button
                          type="button"
                          onClick={() => onManageMachine(item.id)}
                          {...stylex.props(styles.nameButton, !item.isOnline && styles.nameOffline)}
                        >
                          {item.name}
                        </button>
                        {item.id === currentMachineId ? (
                          <span {...stylex.props(styles.here)}>
                            {t('settings.account.machines.localMachine', 'This machine')}
                          </span>
                        ) : null}
                      </div>
                      <p {...stylex.props(styles.status)}>
                        {[
                          item.isOnline
                            ? t('workspace.machines.online', 'Online')
                            : t('workspace.machines.offline', 'Offline'),
                          item.os,
                          item.sharedWithTeam
                            ? t('workspace.machines.shared', 'Shared')
                            : t('workspace.machines.private', 'Private'),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                  </div>

                  <div {...stylex.props(styles.cell, styles.cellLead)}>
                    <AgentsButton
                      agents={item.agents}
                      quiet={!item.isOnline}
                      onClick={() => onConfigureAgents(item.id)}
                    />
                  </div>
                  <div {...stylex.props(styles.cell)}>
                    <DirectoriesMenu
                      directories={item.directories}
                      quiet={!item.isOnline}
                      onOpenDirectory={(projectKey) => onOpenDirectory(item.id, projectKey)}
                      onOpenDirectories={() => onOpenDirectories(item.id)}
                    />
                  </div>
                  <div {...stylex.props(styles.cell)}>
                    <Tooltip.Root>
                      <Tooltip.Trigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="small"
                            icon
                            onClick={() => onManageMachine(item.id)}
                            aria-label={t('settings.account.machines.manageMachine', {
                              name: item.name,
                              defaultValue: 'Manage {{name}}',
                            })}
                          >
                            <MonitorCog strokeWidth={1.75} {...stylex.props(styles.glyph)} />
                          </Button>
                        }
                      />
                      <Tooltip.Content>
                        {t('settings.account.machines.manageMachineShort', 'Machine settings')}
                      </Tooltip.Content>
                    </Tooltip.Root>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CompactSection>
    </Tooltip.Provider>
  );
}

/**
 * The section's one header action. `CompactSection` hands a header action the
 * ghost icon Button's props, so they are forwarded to the Button this wraps.
 */
function PrivacyHelp({
  size = 'small',
  variant = 'ghost',
}: {
  size?: ButtonSize;
  variant?: ButtonVariant;
  icon?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <Button
            type="button"
            variant={variant}
            size={size}
            icon
            aria-label={t('settings.account.machines.privacyHelpLabel', 'About private access')}
          >
            <CircleHelp strokeWidth={1.75} {...stylex.props(styles.glyph)} />
          </Button>
        }
      />
      <Tooltip.Content side="left">
        {t(
          'settings.account.machines.privacyHelp',
          'Conversations on a private machine, and conversations in private directories on a shared machine, are not visible to other workspace members.'
        )}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

/** The directories a machine shares: a menu that lists them and opens one. */
function DirectoriesMenu({
  directories,
  quiet,
  onOpenDirectory,
  onOpenDirectories,
}: {
  directories: AccountMachineDirectory[];
  quiet: boolean;
  onOpenDirectory: (projectKey: string) => void;
  onOpenDirectories: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button type="button" variant="ghost" size="small">
            <span {...stylex.props(styles.count, quiet && styles.countOffline)}>
              {t('settings.account.machines.directoryCount', {
                count: directories.length,
                defaultValue: '{{count}} directories',
              })}
            </span>
            <ChevronDown {...stylex.props(styles.icon, styles.iconHint)} />
          </Button>
        }
      />
      <Menu.Content align="end">
        {directories.length === 0 ? (
          <Menu.Group>
            <Menu.GroupLabel>
              {t('settings.machines.noConnectedFolders', 'No connected folders on this machine.')}
            </Menu.GroupLabel>
            <Menu.Item onClick={onOpenDirectories}>
              {t('settings.account.machines.openProjects', 'Open Projects')}
            </Menu.Item>
          </Menu.Group>
        ) : (
          directories.map((directory) => (
            <Menu.Item
              key={directory.key}
              icon={<Folder strokeWidth={1.75} {...stylex.props(styles.glyph)} />}
              shortcut={
                directory.sharedWithTeam
                  ? t('workspace.machines.shared', 'Shared')
                  : t('workspace.machines.private', 'Private')
              }
              onClick={() => onOpenDirectory(directory.key)}
            >
              <span {...stylex.props(styles.directory)}>
                <span {...stylex.props(styles.truncate)}>{directory.name}</span>
                <span {...stylex.props(styles.truncate, styles.directoryPath)}>
                  {directory.rootPath}
                </span>
              </span>
            </Menu.Item>
          ))
        )}
      </Menu.Content>
    </Menu.Root>
  );
}

/** How many Agents a machine runs, naming them on hover; it opens their configuration. */
function AgentsButton({
  agents,
  quiet,
  onClick,
}: {
  agents: AgentConfigMeta[];
  quiet: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const names = agents.map((agent) => agent.name).join(', ');

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="small"
            onClick={onClick}
            aria-label={t('settings.account.machines.configureAgents', 'Configure Agents')}
          >
            <span {...stylex.props(styles.count, quiet && styles.countOffline)}>
              {t('settings.account.machines.agentCount', {
                count: agents.length,
                defaultValue: '{{count}} Agents',
              })}
            </span>
          </Button>
        }
      />
      <Tooltip.Content>
        <p {...stylex.props(styles.tooltipTitle)}>
          {t('settings.account.machines.configureAgents', 'Configure Agents')}
        </p>
        <p {...stylex.props(styles.tooltipHint)}>
          {agents.length > 0
            ? names
            : t(
                'settings.account.machines.noAgentsHint',
                'No Agents are configured on this machine yet.'
              )}
        </p>
      </Tooltip.Content>
    </Tooltip.Root>
  );
}
