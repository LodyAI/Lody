import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type AcpSessionMonitorSnapshot,
  type AgentConfigMeta,
  type MachineId,
  type MachineMonitorSnapshot,
  type MachineViewMeta,
  type ProviderSetupTask,
  type SessionMeta,
} from '@lody/shared';
import {
  Activity,
  Bot,
  ChevronUp,
  Download,
  Laptop,
  Loader2,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Unplug,
  UserRound,
  Users,
} from 'lucide-react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Switch } from '@/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { useMachineOnlineStatus } from '@/hooks/use-machine-online-status';
import { useMachineActionState } from '@/hooks/use-machine-action-state';
import { MobileSettingsDetailHeader } from '@/components/mobile/mobile-settings-layout';
import { MobileSettingsSection } from '@/components/mobile/mobile-settings-row';
import { ProviderRow } from './provider-row';
import { ProviderSetupRow } from './provider-setup-row';
import { DeviceResourceMonitor } from './device-resource-monitor';
import type { MachineMonitorViewState } from '@/hooks/use-machine-monitor';
import {
  WorkspaceMachineAccordionSummary,
  WorkspaceMachineOwnerAvatar,
  type WorkspaceMachineAccordionMeta,
} from './workspace-machine-accordion';

export type MachineProvidersSectionProps = {
  machine: MachineViewMeta;
  configs: AgentConfigMeta[];
  setups?: ProviderSetupTask[];
  onAddConfig: () => void;
  onEditConfig: (config: AgentConfigMeta) => void;
  onDeleteConfig?: (config: AgentConfigMeta) => Promise<void>;
  onRefreshConfig?: (config: AgentConfigMeta) => Promise<void>;
  onRetrySetup?: (setup: ProviderSetupTask) => Promise<void>;
  onDeleteSetup?: (setup: ProviderSetupTask) => Promise<void>;
  /** Desktop pills content is flush with the title — no extra horizontal inset. */
  flush?: boolean;
  variant?: 'default' | 'mobile-list';
};

/** "Agent Provider" list + add button — shared by the mobile detail pane and the
 *  desktop Agents tab. */
export function MachineProvidersSection({
  machine,
  configs,
  setups = [],
  onAddConfig,
  onEditConfig,
  onDeleteConfig,
  onRefreshConfig,
  onRetrySetup,
  onDeleteSetup,
  flush = false,
  variant = 'default',
}: MachineProvidersSectionProps) {
  const { t } = useTranslation();
  const addButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          onClick={onAddConfig}
          aria-label={t('settings.agent.provider.addProvider', 'Add provider')}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('settings.agent.provider.addProvider', 'Add provider')}</TooltipContent>
    </Tooltip>
  );

  if (variant === 'mobile-list') {
    return (
      <MobileSettingsSection
        title={t('settings.agent.provider.title', 'Agent Provider')}
        actions={addButton}
      >
        {configs.length === 0 && setups.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-8 text-center text-sm">
            <Bot className="h-6 w-6 text-muted-foreground/70" />
            <p className="mt-2 text-muted-foreground">
              {t('settings.agent.provider.empty', 'No providers on this machine yet.')}
            </p>
            <Button size="sm" className="mt-3" onClick={onAddConfig}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t('settings.agent.provider.addProvider', 'Add provider')}
            </Button>
          </div>
        ) : (
          <>
            {setups.map((setup, index) => (
              <ProviderSetupRow
                key={setup.id}
                setup={setup}
                machine={machine}
                onRetry={onRetrySetup ?? (async () => undefined)}
                onDelete={onDeleteSetup ?? (async () => undefined)}
                className={cn(
                  'rounded-none border-0 bg-transparent',
                  index > 0 && 'border-t border-border'
                )}
              />
            ))}
            {configs.map((config, index) => (
              <ProviderRow
                key={config.id}
                config={config}
                machine={machine}
                onEdit={onEditConfig}
                onDelete={onDeleteConfig}
                onRefresh={onRefreshConfig}
                variant="list"
                className={index === 0 && setups.length > 0 ? 'border-t border-border' : undefined}
              />
            ))}
          </>
        )}
      </MobileSettingsSection>
    );
  }

  return (
    <section className="flex flex-col">
      <div
        className={cn(
          'flex items-center justify-between gap-2 pb-1 pt-0.5',
          flush ? 'px-0' : 'px-4'
        )}
      >
        <h3 className="text-xs font-semibold text-muted-foreground">
          {t('settings.agent.provider.title', 'Agent Provider')}
        </h3>
        {addButton}
      </div>
      {configs.length === 0 && setups.length === 0 ? (
        <EmptyProviders onAdd={onAddConfig} flush={flush} />
      ) : (
        <div className={cn('space-y-2', flush ? '' : 'mx-4')}>
          {setups.map((setup) => (
            <ProviderSetupRow
              key={setup.id}
              setup={setup}
              machine={machine}
              onRetry={onRetrySetup ?? (async () => undefined)}
              onDelete={onDeleteSetup ?? (async () => undefined)}
            />
          ))}
          {configs.map((config) => (
            <ProviderRow
              key={config.id}
              config={config}
              machine={machine}
              onEdit={onEditConfig}
              onDelete={onDeleteConfig}
              onRefresh={onRefreshConfig}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export type MachineDetailPaneProps = {
  mode?: 'agents' | 'devices';
  readOnly?: boolean;
  machine: MachineViewMeta;
  configs: AgentConfigMeta[];
  setups?: ProviderSetupTask[];
  isOwn: boolean;
  isLocal: boolean;
  ownerName: string | null;
  sharedWithTeam: boolean;
  canDelete: boolean;
  onRename: (machineId: MachineId, newName: string) => Promise<void>;
  onDelete: (machine: MachineViewMeta) => Promise<void>;
  onSharedWithTeamChange?: (machineId: MachineId, sharedWithTeam: boolean) => Promise<void>;
  onAddConfig: () => void;
  onEditConfig: (config: AgentConfigMeta) => void;
  onDeleteConfig?: (config: AgentConfigMeta) => Promise<void>;
  onRefreshConfig?: (config: AgentConfigMeta) => Promise<void>;
  onRetrySetup?: (setup: ProviderSetupTask) => Promise<void>;
  onDeleteSetup?: (setup: ProviderSetupTask) => Promise<void>;
  onPing?: (machineId: MachineId) => Promise<number>;
  daemonUpdate?: { currentVersion: string; latestVersion: string };
  onRestartDaemon?: (machineId: MachineId) => Promise<void>;
  onUpgradeDaemon?: (machineId: MachineId, targetVersion: string) => Promise<void>;
  canRevokeCredentials?: boolean;
  /** Must reject on failure so the confirm dialog stays open; the callback owns
   *  surfacing the error (toast) exactly once. */
  onRevokeCredentials?: () => Promise<void>;
  monitorSnapshot?: MachineMonitorSnapshot | null;
  monitorState?: MachineMonitorViewState;
  monitorSessionMetas?: readonly SessionMeta[];
  onOpenMonitorSession?: (session: AcpSessionMonitorSnapshot, meta?: SessionMeta) => void;
  onTerminateMonitorSession?: (session: AcpSessionMonitorSnapshot) => Promise<void>;
  /** Extra owner-only information shown below the resource monitor. */
  footer?: ReactNode;
  /** Desktop Machines embeds the detail directly below its full-width accordion row. */
  accordion?: {
    meta: WorkspaceMachineAccordionMeta;
    onCollapse: () => void;
    /** The accordion list owns the stable summary row and mounts this pane as its body. */
    headerRenderedExternally?: boolean;
  };
};

export function MachineDetailPane(props: MachineDetailPaneProps) {
  const {
    machine,
    mode = 'agents',
    readOnly = false,
    configs,
    setups = [],
    isOwn,
    isLocal,
    ownerName,
    sharedWithTeam,
    canDelete,
    onRename,
    onDelete,
    onSharedWithTeamChange,
    onAddConfig,
    onEditConfig,
    onDeleteConfig,
    onRefreshConfig,
    onRetrySetup,
    onDeleteSetup,
    onPing,
    daemonUpdate,
    onRestartDaemon,
    onUpgradeDaemon,
    canRevokeCredentials = false,
    onRevokeCredentials,
    monitorSnapshot = null,
    monitorState = 'disabled',
    monitorSessionMetas = [],
    onOpenMonitorSession,
    onTerminateMonitorSession,
    footer,
    accordion,
  } = props;
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const monitoredOnline = useMachineOnlineStatus(machine.id) === 'online';
  // The accordion list already owns the workspace-wide presence snapshot. Reuse
  // it so collapsing and expanding a row cannot briefly change the status dot.
  const isOnline = accordion ? accordion.meta.isOnline : monitoredOnline;

  const {
    renaming,
    setRenaming,
    renameDraft,
    setRenameDraft,
    renameSaving,
    inputRef,
    commitRename,
    sharing,
    effectiveShared,
    handleSharedToggle,
    deleteOpen,
    setDeleteOpen,
    deleting,
    handleDelete,
    pinging,
    pingLatencyMs,
    handlePing,
    restartingDaemon,
    upgradingDaemon,
    handleRestartDaemon,
    handleUpgradeDaemon,
  } = useMachineActionState({
    machine,
    sharedWithTeam,
    daemonUpdate,
    onRename,
    onDelete,
    onSharedWithTeamChange,
    onPing,
    onRestartDaemon,
    onUpgradeDaemon,
  });
  const pendingRenameRef = useRef(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const manageableOwnMachine = isOwn && !readOnly;
  const shareControlVisible =
    !isMobile && !renaming && manageableOwnMachine && !!onSharedWithTeamChange;
  const restartVisible = !isMobile && !renaming && !readOnly && !!onRestartDaemon;
  const revokeVisible =
    !isMobile && !renaming && !readOnly && canRevokeCredentials && !!onRevokeCredentials;
  const removeVisible = !isMobile && !renaming && manageableOwnMachine;
  const managementGroupVisible =
    shareControlVisible || restartVisible || (!isMobile && !renaming && !!onPing);
  const destructiveGroupVisible = revokeVisible || removeVisible;
  const updateVisible = isOnline && !!daemonUpdate && !!onUpgradeDaemon;
  // Desktop renders every action inline in the header (rename pencil, share
  // switch, ping, restart, revoke, delete); the ⋮ menu is mobile-only.
  const actionsMenuVisible =
    !renaming &&
    isMobile &&
    !readOnly &&
    (isOwn || canDelete || !!onRestartDaemon || !!onPing || (updateVisible && !!daemonUpdate));
  const externalAccordionHeader = accordion?.headerRenderedExternally === true;
  const detailToolbarVisible =
    !externalAccordionHeader ||
    manageableOwnMachine ||
    !!onPing ||
    shareControlVisible ||
    restartVisible ||
    destructiveGroupVisible ||
    updateVisible;

  const metaBadges = (
    <>
      {isLocal && (
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          {t('workspace.machines.thisDevice', 'This device')}
        </Badge>
      )}
      {ownerName && !isOwn && (
        <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
          <UserRound className="h-2.5 w-2.5" />
          {ownerName}
        </Badge>
      )}
      {isMobile && (
        <span
          aria-hidden
          className={cn(
            'mx-1 h-2 w-2 shrink-0 rounded-full ring-4',
            isOnline
              ? 'bg-status-success ring-status-success/20'
              : 'bg-muted-foreground/50 ring-muted'
          )}
        />
      )}
      <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
        <Laptop className="h-2.5 w-2.5" />
        {machine.os || '-'}
      </Badge>
      <Badge variant="secondary" className="px-1.5 py-0 font-mono text-[10px]">
        {machine.cliVersion ? `v${machine.cliVersion}` : t('machines.never', 'Never')}
      </Badge>
    </>
  );

  return (
    <div className={cn('flex min-h-0 w-full min-w-0 flex-col', accordion ? 'h-auto' : 'h-full')}>
      {detailToolbarVisible ? (
        <header
          className={cn(
            externalAccordionHeader ? 'px-4 py-2' : 'px-4 py-3',
            accordion &&
              !externalAccordionHeader &&
              'sticky top-0 z-20 rounded-t-xl border-b border-border/60 bg-background/95 backdrop-blur'
          )}
        >
          <MobileSettingsDetailHeader active={isMobile}>
            <div className="flex min-w-0 items-center gap-2">
              {accordion && !externalAccordionHeader ? (
                <span
                  role="img"
                  aria-label={
                    isOnline
                      ? t('workspace.machines.online', 'Online')
                      : t('workspace.machines.offline', 'Offline')
                  }
                  className={cn(
                    'h-2.5 w-2.5 shrink-0 rounded-full ring-4',
                    isOnline
                      ? 'bg-status-success ring-status-success/20'
                      : 'bg-muted-foreground/50 ring-muted'
                  )}
                />
              ) : null}
              <div
                className={cn(
                  isMobile ? 'flex min-w-0 flex-1 items-center justify-center' : 'contents'
                )}
              >
                {renaming ? (
                  <Input
                    ref={inputRef}
                    value={renameDraft}
                    disabled={renameSaving}
                    className="h-7 min-w-0 flex-1 px-1.5 py-0 text-base font-semibold leading-snug"
                    onChange={(event) =>
                      setRenameDraft(event.target.value.replace(/[\r\n]+/g, ' '))
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setRenameDraft(machine.name);
                        setRenaming(false);
                        return;
                      }
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                    onBlur={() => void commitRename()}
                  />
                ) : externalAccordionHeader ? (
                  manageableOwnMachine ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                      onClick={() => setRenaming(true)}
                    >
                      <Pencil className="h-3 w-3" />
                      {t('workspace.machines.editName', 'Edit machine name')}
                    </Button>
                  ) : null
                ) : (
                  <>
                    <h2
                      className={cn(
                        'min-w-0 truncate font-semibold',
                        isMobile ? 'text-center text-lg' : 'text-base'
                      )}
                    >
                      {machine.name || machine.id}
                    </h2>
                    {renameSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {!isMobile && manageableOwnMachine && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                        aria-label={t('workspace.machines.editName', 'Edit machine name')}
                        onClick={() => setRenaming(true)}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                    )}
                  </>
                )}
              </div>
              {onPing && !renaming && !isMobile && (
                <div
                  className={cn(
                    'flex shrink-0 items-center gap-1.5',
                    !shareControlVisible && 'ml-auto'
                  )}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 bg-muted/40 px-2 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    disabled={pinging}
                    onClick={() => void handlePing()}
                  >
                    {pinging ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Activity className="mr-1 h-3.5 w-3.5" />
                    )}
                    {t('settings.agent.machinePing.button', 'Ping')}
                  </Button>
                  {pingLatencyMs !== null && (
                    <span className="font-mono text-xs text-muted-foreground">
                      {t('settings.agent.machinePing.latency', '{{latency}} ms', {
                        latency: String(pingLatencyMs),
                      })}
                    </span>
                  )}
                </div>
              )}
              {shareControlVisible && (
                <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
                  <span className="whitespace-nowrap text-xs text-muted-foreground">
                    {t('workspace.machines.shareMachineLabel', 'Share machine')}
                  </span>
                  {sharing ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : (
                    <Switch
                      checked={effectiveShared}
                      onCheckedChange={(checked) => void handleSharedToggle(checked)}
                      aria-label={t('workspace.machines.shareToggle', {
                        machineName: machine.name,
                        defaultValue: 'Share {{machineName}} with the team',
                      })}
                    />
                  )}
                </div>
              )}
              {restartVisible && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label={t(
                        'settings.agent.machineLifecycle.restartButton',
                        'Restart daemon'
                      )}
                      disabled={restartingDaemon || upgradingDaemon}
                      onClick={() => void handleRestartDaemon()}
                    >
                      {restartingDaemon ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t('settings.agent.machineLifecycle.restartButton', 'Restart daemon')}
                  </TooltipContent>
                </Tooltip>
              )}
              {managementGroupVisible && destructiveGroupVisible && (
                <div aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
              )}
              {revokeVisible && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label={t(
                        'settings.devices.credentials.disconnect',
                        'Revoke machine access'
                      )}
                      onClick={() => setRevokeOpen(true)}
                    >
                      <Unplug className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t('settings.devices.credentials.disconnect', 'Revoke machine access')}
                  </TooltipContent>
                </Tooltip>
              )}
              {removeVisible ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 px-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed"
                        aria-label={t(
                          'workspace.machines.removeFromWorkspace',
                          'Remove from workspace'
                        )}
                        disabled={!canDelete}
                        onClick={() => setDeleteOpen(true)}
                      >
                        <LogOut className="h-3.5 w-3.5" />
                        {t('workspace.machines.removeFromWorkspace', 'Remove from workspace')}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {!canDelete ? (
                    <TooltipContent>
                      {t(
                        'workspace.machines.removeUnavailableOnline',
                        'Stop Lody on this machine before removing it from this workspace.'
                      )}
                    </TooltipContent>
                  ) : null}
                </Tooltip>
              ) : null}
              {actionsMenuVisible && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      aria-label={t('workspace.machines.moreActions', 'Machine options')}
                    >
                      {sharing ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <MoreHorizontal className="h-4 w-4" />
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="w-60"
                    onCloseAutoFocus={(event) => {
                      if (pendingRenameRef.current) {
                        event.preventDefault();
                        pendingRenameRef.current = false;
                        requestAnimationFrame(() => {
                          inputRef.current?.focus();
                          inputRef.current?.select();
                        });
                      }
                    }}
                  >
                    {isMobile && manageableOwnMachine && (
                      <DropdownMenuItem
                        onSelect={() => {
                          pendingRenameRef.current = true;
                          setRenaming(true);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        <span>{t('workspace.machines.editName', 'Edit machine name')}</span>
                      </DropdownMenuItem>
                    )}
                    {isMobile && manageableOwnMachine && onSharedWithTeamChange && (
                      <DropdownMenuItem
                        onSelect={(event) => {
                          event.preventDefault();
                          if (sharing) return;
                          void handleSharedToggle(!effectiveShared);
                        }}
                        disabled={sharing}
                      >
                        <Users className="h-3.5 w-3.5" />
                        <span className="min-w-0 flex-1">
                          {t('workspace.machines.shareMachineLabel', 'Share machine')}
                        </span>
                        <Switch
                          checked={effectiveShared}
                          disabled={sharing}
                          aria-hidden
                          tabIndex={-1}
                          className="pointer-events-none"
                        />
                      </DropdownMenuItem>
                    )}
                    {isMobile &&
                      isOwn &&
                      (onPing || (updateVisible && daemonUpdate) || onRestartDaemon) && (
                        <DropdownMenuSeparator />
                      )}
                    {isMobile && onPing && (
                      <DropdownMenuItem
                        onSelect={(event) => {
                          event.preventDefault();
                          void handlePing();
                        }}
                        disabled={pinging}
                      >
                        {pinging ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Activity className="h-3.5 w-3.5" />
                        )}
                        <span className="min-w-0 flex-1">
                          {t('settings.agent.machinePing.button', 'Ping')}
                        </span>
                        {pingLatencyMs !== null && (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {t('settings.agent.machinePing.latency', '{{latency}} ms', {
                              latency: String(pingLatencyMs),
                            })}
                          </span>
                        )}
                      </DropdownMenuItem>
                    )}
                    {isMobile && updateVisible && daemonUpdate && (
                      <DropdownMenuItem
                        onSelect={() => void handleUpgradeDaemon()}
                        disabled={restartingDaemon || upgradingDaemon}
                      >
                        {upgradingDaemon ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        <span>
                          {t(
                            'settings.agent.machineLifecycle.upgradeAndRestartButton',
                            'Update and restart'
                          )}
                        </span>
                      </DropdownMenuItem>
                    )}
                    {onRestartDaemon && (
                      <DropdownMenuItem
                        onSelect={() => void handleRestartDaemon()}
                        disabled={restartingDaemon || upgradingDaemon}
                      >
                        {restartingDaemon ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        <span>
                          {t('settings.agent.machineLifecycle.restartButton', 'Restart daemon')}
                        </span>
                      </DropdownMenuItem>
                    )}
                    {isMobile && isOwn && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onSelect={(event) => {
                            event.preventDefault();
                            setDeleteOpen(true);
                          }}
                          disabled={!canDelete}
                          className="text-destructive focus:text-destructive"
                        >
                          <LogOut className="h-3.5 w-3.5" />
                          <span>
                            {canDelete
                              ? t('workspace.machines.removeFromWorkspace', 'Remove from workspace')
                              : t(
                                  'workspace.machines.removeUnavailableOnlineShort',
                                  'Stop machine before removing'
                                )}
                          </span>
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {accordion && !externalAccordionHeader ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label={t('settings.machines.collapseMachine', {
                    machine: machine.name || machine.id,
                    defaultValue: 'Collapse {{machine}}',
                  })}
                  aria-expanded={true}
                  onClick={accordion.onCollapse}
                >
                  <ChevronUp className="h-4 w-4" aria-hidden />
                </Button>
              ) : null}
              {accordion && !externalAccordionHeader ? (
                <WorkspaceMachineOwnerAvatar owner={accordion.meta.owner} />
              ) : null}
            </div>
          </MobileSettingsDetailHeader>
          {/* Desktop (story) keeps the meta badges in the header; on mobile they
            move to the first line of the content, flush with the body. */}
          {!isMobile && accordion ? (
            externalAccordionHeader ? null : (
              <WorkspaceMachineAccordionSummary
                meta={accordion.meta}
                className="mt-1.5 justify-start"
                showOwner={false}
              />
            )
          ) : !isMobile ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              {metaBadges}
            </div>
          ) : null}
          {updateVisible && daemonUpdate && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/25 bg-primary/5 px-3 py-2">
              <div className="min-w-0">
                <div className="text-xs font-medium text-foreground">
                  {t('settings.agent.machineLifecycle.updateAvailable', 'Update available')}
                </div>
                <div className="font-mono text-[11px] text-muted-foreground">
                  {t(
                    'settings.agent.machineLifecycle.updateVersion',
                    'v{{current}} -> v{{latest}}',
                    {
                      current: daemonUpdate.currentVersion,
                      latest: daemonUpdate.latestVersion,
                    }
                  )}
                </div>
              </div>
              <div className="shrink-0">
                <Button
                  size="sm"
                  className="h-8 px-3"
                  disabled={restartingDaemon || upgradingDaemon}
                  onClick={() => void handleUpgradeDaemon()}
                >
                  {upgradingDaemon ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="mr-1 h-3.5 w-3.5" />
                  )}
                  {t(
                    'settings.agent.machineLifecycle.upgradeAndRestartButton',
                    'Update and restart'
                  )}
                </Button>
              </div>
            </div>
          )}
        </header>
      ) : null}

      <div className={cn('min-h-0 flex-1', accordion ? 'overflow-visible' : 'overflow-y-auto')}>
        {isMobile && (
          <div className="flex flex-wrap items-center gap-1.5 px-4 pb-1 pt-1 text-[11px] text-muted-foreground">
            {metaBadges}
          </div>
        )}
        {mode === 'devices' ? (
          <>
            {footer}
            <DeviceResourceMonitor
              snapshot={monitorSnapshot}
              state={monitorState}
              sessionMetas={monitorSessionMetas}
              agentConfigs={configs}
              onOpenSession={onOpenMonitorSession}
              onTerminateSession={onTerminateMonitorSession}
            />
          </>
        ) : (
          <MachineProvidersSection
            machine={machine}
            configs={configs}
            setups={setups}
            onAddConfig={onAddConfig}
            onEditConfig={onEditConfig}
            onDeleteConfig={onDeleteConfig}
            onRefreshConfig={onRefreshConfig}
            onRetrySetup={onRetrySetup}
            onDeleteSetup={onDeleteSetup}
          />
        )}
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('workspace.machines.removeConfirmTitle', 'Remove machine from workspace?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.machines.removeConfirmDescription', {
                machineName: machine.name,
                defaultValue:
                  'Remove {{machineName}} from this workspace. It can appear again if it reconnects to this workspace later.',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t('common.cancel', 'Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('workspace.machines.removeAction', 'Remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.devices.credentials.confirmTitle', 'Revoke machine access?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'settings.devices.credentials.confirmDescription',
                '{{machine}} will be signed out of every workspace. To reconnect it, create a new machine connection request.',
                { machine: machine.name }
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>
              {t('common.cancel', 'Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={revoking}
              onClick={(event) => {
                event.preventDefault();
                setRevoking(true);
                void onRevokeCredentials?.()
                  .then(() => setRevokeOpen(false))
                  .catch(() => {
                    // Failure: the callback surfaces the error toast itself;
                    // keep the dialog open so "still not revoked" stays visible.
                  })
                  .finally(() => setRevoking(false));
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revoking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t('settings.devices.credentials.disconnect', 'Revoke machine access')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EmptyProviders({ onAdd, flush = false }: { onAdd: () => void; flush?: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/30 px-6 py-8 text-center text-sm',
        flush ? '' : 'mx-4'
      )}
    >
      <Bot className="h-6 w-6 text-muted-foreground/70" />
      <p className="mt-2 text-muted-foreground">
        {t('settings.agent.provider.empty', 'No providers on this machine yet.')}
      </p>
      <Button size="sm" className="mt-3" onClick={onAdd}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        {t('settings.agent.provider.addProvider', 'Add provider')}
      </Button>
    </div>
  );
}
