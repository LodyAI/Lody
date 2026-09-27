import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { CircleHelp } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { space } from '@lody/ui/tokens/scales.stylex';
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
import { Tooltip } from '@lody/ui/tooltip';
import { CompactRow, CompactSection } from './compact-layout';
import { settingsSurface as surface } from './surface';

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
      onManageMachine={(machineId) => openSettings('machines', { machineId })}
    />
  );
}

const styles = stylex.create({
  note: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: space[2] },
  /** A glyph inside a box that sizes it — an icon Button's. */
  glyph: { width: '100%', height: '100%' },
});

/**
 * The machines this person connected, as settings rows: a machine's name, one
 * line of what it is (reachability, platform, access, how many Agents and
 * directories), and one answer — Manage, which opens its settings, where its
 * Agents, sharing and directories live.
 */
export function AccountMachinesOverviewView({
  items,
  loading = false,
  currentMachineId,
  onManageMachine,
}: {
  items: AccountMachineOverviewItem[];
  loading?: boolean;
  currentMachineId?: MachineId | null;
  onManageMachine: (machineId: MachineId) => void;
}) {
  const { t } = useTranslation();

  return (
    <Tooltip.Provider delay={250}>
      <CompactSection
        title={t('settings.account.machines.title', 'My machines')}
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
          items.map((item) => (
            <CompactRow
              key={item.id}
              label={item.name}
              helper={[
                item.id === currentMachineId
                  ? t('settings.account.machines.localMachine', 'This machine')
                  : null,
                item.isOnline
                  ? t('workspace.machines.online', 'Online')
                  : t('workspace.machines.offline', 'Offline'),
                item.os,
                item.sharedWithTeam
                  ? t('workspace.machines.shared', 'Shared')
                  : t('workspace.machines.private', 'Private'),
                t('settings.account.machines.agentCount', {
                  count: item.agents.length,
                  defaultValue: '{{count}} Agents',
                }),
                t('settings.account.machines.directoryCount', {
                  count: item.directories.length,
                  defaultValue: '{{count}} directories',
                }),
              ]
                .filter(Boolean)
                .join(' · ')}
            >
              <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={() => onManageMachine(item.id)}
                aria-label={t('settings.account.machines.manageMachine', {
                  name: item.name,
                  defaultValue: 'Manage {{name}}',
                })}
              >
                {t('settings.account.machines.manage', 'Manage')}
              </Button>
            </CompactRow>
          ))
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
