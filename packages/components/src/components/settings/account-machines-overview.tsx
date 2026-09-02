import { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Folder,
  Loader2,
  LockKeyhole,
  MonitorCog,
  Users,
} from 'lucide-react';
import type { AgentConfigMeta, MachineId } from '@lody/shared';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { userAtom } from '@/atoms';
import { AgentIcon } from '@/components/icons/agent-icon';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { useOpenSettings } from '@/hooks/use-open-settings';
import { useVisibleLocalProjectsFromMachineIndex } from '@/hooks/use-visible-local-projects';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { isElectronRenderer } from '@/lib/electron';
import { cn } from '@/lib/utils';
import { Badge } from '@/ui/badge';
import { Button } from '@lody/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';

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
  const [expandedMachineIds, setExpandedMachineIds] = useState<Set<MachineId>>(() => new Set());

  const toggleDirectories = (machineId: MachineId) => {
    setExpandedMachineIds((previous) => {
      const next = new Set(previous);
      if (next.has(machineId)) next.delete(machineId);
      else next.add(machineId);
      return next;
    });
  };

  return (
    <TooltipProvider delayDuration={250}>
      <section className="mx-3 overflow-hidden rounded-xl border border-border/60 bg-card/60 md:mx-0 md:rounded-lg">
        <header className="flex items-start justify-between gap-3 border-b border-border/60 bg-muted/30 px-3 py-2.5">
          <div className="min-w-0">
            <h2 className="text-xs font-semibold text-muted-foreground">
              {t('settings.account.machines.title', 'My machines')}
            </h2>
            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground/85">
              {t(
                'settings.account.machines.description',
                'Machines connected by you, with their Agents and shared directories.'
              )}
            </p>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="small"
                icon
                className="shrink-0"
                aria-label={t('settings.account.machines.privacyHelpLabel', 'About private access')}
              >
                <CircleHelp className="h-3.5 w-3.5" strokeWidth={1.75} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-72 leading-relaxed">
              {t(
                'settings.account.machines.privacyHelp',
                'Conversations on a private machine, and conversations in private directories on a shared machine, are not visible to other workspace members.'
              )}
            </TooltipContent>
          </Tooltip>
        </header>

        <div className="hidden cursor-default select-none grid-cols-[minmax(180px,1fr)_100px_180px_140px_32px] items-center gap-3 border-b border-border/50 px-3 py-1.5 text-[10px] font-medium text-muted-foreground/70 md:grid">
          <span>{t('settings.account.machines.machineColumn', 'Machine')}</span>
          <span>{t('settings.account.machines.accessColumn', 'Access')}</span>
          <span>{t('settings.account.machines.agentsColumn', 'Agents')}</span>
          <span>{t('settings.account.machines.directoriesColumn', 'Directories')}</span>
          <span className="sr-only">{t('settings.account.machines.actionsColumn', 'Actions')}</span>
        </div>

        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('workspace.machines.loadingVisibility', 'Loading machines')}
          </div>
        ) : items.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            {t('workspace.machines.empty', 'No machines connected')}
          </div>
        ) : (
          items.map((item, index) => {
            const expanded = expandedMachineIds.has(item.id);
            return (
              <div key={item.id} className={cn(index > 0 && 'border-t border-border/50')}>
                <div className="grid min-w-0 grid-cols-1 gap-3 px-3 py-3 md:grid-cols-[minmax(180px,1fr)_100px_180px_140px_32px] md:items-center">
                  <div className="flex min-w-0 items-center gap-3.5">
                    <span
                      className={cn(
                        'h-2 w-2 shrink-0 rounded-full ring-4',
                        item.isOnline
                          ? 'bg-status-success ring-status-success/20'
                          : 'bg-muted-foreground/45 ring-muted'
                      )}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onManageMachine(item.id)}
                          className="min-w-0 truncate rounded-sm text-start text-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {item.name}
                        </button>
                        {item.id === currentMachineId ? (
                          <Badge
                            variant="secondary"
                            className="shrink-0 px-1.5 py-0 text-[10px] font-medium text-muted-foreground"
                          >
                            {t('settings.account.machines.localMachine', 'This machine')}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {item.isOnline
                          ? t('workspace.machines.online', 'Online')
                          : t('workspace.machines.offline', 'Offline')}
                        {item.os ? ` · ${item.os}` : ''}
                      </p>
                    </div>
                    <div className="ms-auto md:hidden">
                      <AccessStatus sharedWithTeam={item.sharedWithTeam} scope="machine" />
                    </div>
                  </div>

                  <div className="hidden md:block">
                    <AccessStatus sharedWithTeam={item.sharedWithTeam} scope="machine" />
                  </div>

                  <AgentStackButton
                    agents={item.agents}
                    onClick={() => onConfigureAgents(item.id)}
                  />

                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    className="justify-between"
                    onClick={() => toggleDirectories(item.id)}
                    aria-expanded={expanded}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Folder className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                      <span className="truncate text-start">
                        {t('settings.account.machines.directoryCount', {
                          count: item.directories.length,
                          defaultValue: '{{count}} directories',
                        })}
                      </span>
                    </span>
                    <ChevronDown
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 transition-transform',
                        expanded && 'rotate-180'
                      )}
                    />
                  </Button>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        icon
                        className="hidden"
                        onClick={() => onManageMachine(item.id)}
                        aria-label={t('settings.account.machines.manageMachine', {
                          name: item.name,
                          defaultValue: 'Manage {{name}}',
                        })}
                      >
                        <MonitorCog className="h-4 w-4" strokeWidth={1.75} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t('settings.account.machines.manageMachineShort', 'Machine settings')}
                    </TooltipContent>
                  </Tooltip>
                </div>

                {expanded ? (
                  <div className="border-t border-border/50 bg-foreground/[0.018] px-3 py-2.5">
                    {item.directories.length === 0 ? (
                      <div className="flex items-center justify-between gap-3 py-1 text-xs text-muted-foreground">
                        <span>
                          {t(
                            'settings.machines.noConnectedFolders',
                            'No connected folders on this machine.'
                          )}
                        </span>
                        <Button
                          variant="ghost"
                          size="small"
                          onClick={() => onOpenDirectories(item.id)}
                        >
                          {t('settings.account.machines.openProjects', 'Open Projects')}
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {item.directories.map((directory) => (
                          <button
                            key={directory.key}
                            type="button"
                            onClick={() => onOpenDirectory(item.id, directory.key)}
                            className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-start transition-colors hover:bg-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Folder
                              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                              strokeWidth={1.75}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium text-foreground">
                                {directory.name}
                              </span>
                              <span className="block truncate font-mono text-[10px] text-muted-foreground">
                                {directory.rootPath}
                              </span>
                            </span>
                            <AccessStatus
                              sharedWithTeam={directory.sharedWithTeam}
                              scope="directory"
                            />
                            <ChevronRight
                              className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
                              aria-hidden="true"
                            />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </section>
    </TooltipProvider>
  );
}

function AgentStackButton({ agents, onClick }: { agents: AgentConfigMeta[]; onClick: () => void }) {
  const { t } = useTranslation();
  const visibleAgents = agents.slice(0, 3);
  const hiddenCount = Math.max(0, agents.length - visibleAgents.length);
  const names = agents.map((agent) => agent.name).join(', ');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="small"
          className="min-w-0 justify-between"
          onClick={onClick}
          aria-label={t('settings.account.machines.configureAgents', 'Configure Agents')}
        >
          <span className="flex shrink-0 -space-x-1.5" aria-hidden="true">
            {visibleAgents.length === 0 ? (
              <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-card bg-muted text-muted-foreground">
                <Bot className="h-3 w-3" strokeWidth={1.75} />
              </span>
            ) : (
              visibleAgents.map((agent) => (
                <span
                  key={agent.id}
                  className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-card bg-background text-foreground"
                >
                  <AgentIcon
                    cliType={agent.cliType}
                    agentType={agent.agentType}
                    brandId={agent.brandId}
                    env={agent.env}
                    className="h-3 w-3"
                  />
                </span>
              ))
            )}
            {hiddenCount > 0 ? (
              <span className="flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-card bg-muted px-1 text-[9px] font-medium text-muted-foreground">
                +{hiddenCount}
              </span>
            ) : null}
          </span>
          <span className="ms-auto shrink-0 text-xs">
            {t('settings.account.machines.configureAgentsShort', 'Configure')}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        <p className="font-medium">
          {t('settings.account.machines.configureAgents', 'Configure Agents')}
        </p>
        <p className="mt-0.5 text-muted-foreground">
          {agents.length > 0
            ? names
            : t(
                'settings.account.machines.noAgentsHint',
                'No Agents are configured on this machine yet.'
              )}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function AccessStatus({
  sharedWithTeam,
  scope,
}: {
  sharedWithTeam: boolean;
  scope: 'machine' | 'directory';
}) {
  const { t } = useTranslation();
  const Icon = sharedWithTeam ? Users : LockKeyhole;
  const label = sharedWithTeam
    ? t('workspace.machines.shared', 'Shared')
    : t('workspace.machines.private', 'Private');
  const description = sharedWithTeam
    ? scope === 'machine'
      ? t(
          'workspace.machines.sharedTooltip',
          'Workspace members can access this machine. Only the machine owner can change sharing.'
        )
      : t(
          'settings.account.machines.sharedDirectoryTooltip',
          'Workspace members can access this directory.'
        )
    : scope === 'machine'
      ? t(
          'settings.account.machines.privateMachineTooltip',
          'Only you can access this machine. Its conversations are not visible to other workspace members.'
        )
      : t(
          'settings.account.machines.privateDirectoryTooltip',
          'Only you can access this directory. Its conversations are not visible to other workspace members.'
        );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 cursor-default select-none items-center gap-1 rounded-md bg-foreground/[0.04] px-1.5 py-0.5 text-[10px] text-muted-foreground"
          aria-label={`${label}. ${description}`}
        >
          <Icon className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 leading-relaxed">{description}</TooltipContent>
    </Tooltip>
  );
}
