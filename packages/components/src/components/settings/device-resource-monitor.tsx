import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AcpSessionMonitorSnapshot,
  AgentConfigMeta,
  MachineMonitorResourceUsage,
  MachineMonitorSnapshot,
  SessionMeta,
} from '@lody/shared';
import {
  AlertTriangle,
  Circle,
  CircleStop,
  CircleX,
  Cpu,
  Gauge,
  Hand,
  Loader2,
  TerminalSquare,
} from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Card } from '@/ui/card';
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
import { toast } from 'sonner';
import type { MachineMonitorViewState } from '@/hooks/use-machine-monitor';
import { cn } from '@/lib/utils';
import { AgentIcon, getAgentDisplayName } from '@/components/icons/agent-icon';

type SessionPresentationMeta = SessionMeta;

export function DeviceResourceMonitor({
  snapshot,
  state,
  os,
  cliVersion,
  flush = false,
  sessionMetas = [],
  agentConfigs = [],
  onOpenSession,
  onTerminateSession,
}: {
  snapshot: MachineMonitorSnapshot | null;
  state: MachineMonitorViewState;
  os?: string | null;
  cliVersion?: string | null;
  /** Desktop pills content is flush with the title — no extra horizontal inset. */
  flush?: boolean;
  sessionMetas?: readonly SessionPresentationMeta[];
  agentConfigs?: readonly AgentConfigMeta[];
  onOpenSession?: (session: AcpSessionMonitorSnapshot, meta?: SessionPresentationMeta) => void;
  onTerminateSession?: (session: AcpSessionMonitorSnapshot) => Promise<void>;
}) {
  const { t } = useTranslation();
  const versionLabel = cliVersion ? `v${cliVersion}` : null;
  const sectionPadX = flush ? 'px-0' : 'px-4';
  if (state === 'disabled') {
    return (
      <div
        className={cn(
          'flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground',
          sectionPadX
        )}
      >
        {(os || versionLabel) && (
          <div className="flex flex-wrap items-center justify-center gap-x-2 text-[11px]">
            {os && <span>{os}</span>}
            {os && versionLabel && <span aria-hidden>·</span>}
            {versionLabel && <span className="font-mono">{versionLabel}</span>}
          </div>
        )}
        {t(
          'settings.devices.monitor.offline',
          'Resource monitoring is available while the device is online.'
        )}
      </div>
    );
  }
  if (!snapshot) {
    return (
      <div
        className={cn(
          'flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground',
          sectionPadX
        )}
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('settings.devices.monitor.observing', 'Waiting for a resource sample')}
      </div>
    );
  }

  return (
    <div>
      <section className={cn('py-3', sectionPadX)}>
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <ResourceMetric
            icon={TerminalSquare}
            label={t('settings.devices.resources.cli', 'CLI')}
            trailing={versionLabel}
            resource={snapshot.cliControlPlane}
          />
          <ResourceMetric
            icon={Cpu}
            label={t('settings.devices.resources.sessions', 'ACP sessions')}
            mobileLabel="ACP"
            resource={snapshot.sessionsAggregate}
          />
          <Card className="min-w-0 bg-card/40 p-2 shadow-none sm:p-3">
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground sm:gap-1.5 sm:text-xs">
              <Gauge className="h-3 w-3 shrink-0 sm:h-3.5 sm:w-3.5" />
              <span className="truncate">
                {t('settings.devices.resources.deviceInfo', 'Device info')}
              </span>
              {os && (
                <span className="min-w-0 truncate font-normal text-muted-foreground/80">
                  · {os}
                </span>
              )}
            </div>
            <StatRow
              label={t('settings.devices.sessions.cpu', 'CPU')}
              value={formatDeviceCpu(snapshot)}
            />
            <StatRow
              label={t('settings.devices.sessions.memoryShort', 'Mem')}
              value={
                <>
                  <span className="sm:hidden">
                    {formatBytePair(
                      Math.max(0, snapshot.effectiveMemoryBytes - snapshot.availableMemoryBytes),
                      snapshot.effectiveMemoryBytes
                    )}
                  </span>
                  <span className="hidden sm:inline">
                    {`${formatBytes(
                      Math.max(0, snapshot.effectiveMemoryBytes - snapshot.availableMemoryBytes)
                    )} / ${formatBytes(snapshot.effectiveMemoryBytes)}`}
                  </span>
                </>
              }
            />
          </Card>
        </div>
      </section>

      {snapshot.sessions.length > 0 || snapshot.sessionsTruncated ? (
        <section className={cn('pb-3 pt-4 md:pb-4 md:pt-5', flush ? 'px-0' : 'px-2 md:px-4')}>
          {snapshot.sessions.length > 0 ? (
            <SessionTable
              sessions={snapshot.sessions}
              sessionMetas={sessionMetas}
              agentConfigs={agentConfigs}
              onOpenSession={onOpenSession}
              onTerminateSession={onTerminateSession}
            />
          ) : null}
          {snapshot.sessionsTruncated ? (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-status-warning">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t('settings.devices.sessions.truncated', 'Only the first 100 sessions are shown.')}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function ResourceMetric({
  icon: Icon,
  label,
  mobileLabel,
  trailing,
  resource,
}: {
  icon: typeof Cpu;
  label: string;
  mobileLabel?: string;
  trailing?: ReactNode;
  resource: MachineMonitorResourceUsage;
}) {
  const { t } = useTranslation();
  return (
    <Card className="min-w-0 bg-card/40 p-2 shadow-none sm:p-3">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground sm:gap-1.5 sm:text-xs">
        <Icon className="h-3 w-3 shrink-0 sm:h-3.5 sm:w-3.5" />
        {mobileLabel && <span className="truncate sm:hidden">{mobileLabel}</span>}
        <span className={cn('truncate', mobileLabel && 'hidden sm:inline')}>{label}</span>
        {trailing && (
          <span className="min-w-0 truncate font-mono text-muted-foreground/80">{trailing}</span>
        )}
      </div>
      <StatRow label={t('settings.devices.sessions.cpu', 'CPU')} value={formatCpu(resource)} />
      <StatRow
        label={t('settings.devices.sessions.memoryShort', 'Mem')}
        value={formatBytes(resource.memoryBytes)}
      />
    </Card>
  );
}

/** Micro-label + prominent value pair used by the resource metric groups. */
function StatRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="mt-1 flex items-baseline gap-1.5 sm:gap-2">
      <span className="w-7 shrink-0 text-[10px] text-muted-foreground/70 sm:w-8">{label}</span>
      <span className="min-w-0 truncate text-xs font-semibold tabular-nums text-foreground sm:text-sm">
        {value}
      </span>
    </div>
  );
}

function SessionTable({
  sessions,
  sessionMetas,
  agentConfigs,
  onOpenSession,
  onTerminateSession,
}: {
  sessions: AcpSessionMonitorSnapshot[];
  sessionMetas: readonly SessionPresentationMeta[];
  agentConfigs: readonly AgentConfigMeta[];
  onOpenSession?: (session: AcpSessionMonitorSnapshot, meta?: SessionPresentationMeta) => void;
  onTerminateSession?: (session: AcpSessionMonitorSnapshot) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [confirmSession, setConfirmSession] = useState<AcpSessionMonitorSnapshot | null>(null);
  const [terminatingSessionId, setTerminatingSessionId] = useState<string | null>(null);
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null);
  const metaById = useMemo(
    () => new Map(sessionMetas.map((meta) => [meta.id, meta] as const)),
    [sessionMetas]
  );
  const configById = useMemo(
    () => new Map(agentConfigs.map((config) => [config.id, config] as const)),
    [agentConfigs]
  );

  const terminate = async (session: AcpSessionMonitorSnapshot) => {
    if (!onTerminateSession || terminatingSessionId) return;
    setTerminatingSessionId(session.sessionId);
    const minimumLoading = new Promise<void>((resolve) => setTimeout(resolve, 300));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      await onTerminateSession(session);
      await minimumLoading;
      setConfirmSession(null);
    } catch (error) {
      await minimumLoading;
      toast.error(
        t('settings.devices.sessions.terminateFailed', 'Failed to terminate ACP process'),
        {
          description: error instanceof Error ? error.message : String(error),
        }
      );
    } finally {
      setTerminatingSessionId(null);
    }
  };

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border/60 bg-background">
        <div className="hidden grid-cols-[minmax(160px,40%)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_40px] gap-2.5 bg-muted/25 px-2 py-1.5 text-[11px] font-medium text-muted-foreground md:grid">
          <span>{t('settings.devices.sessions.session', 'Session')}</span>
          <span className="truncate text-center">
            {t('settings.devices.sessions.status', 'Status')}
          </span>
          <span className="truncate text-center">
            {t('settings.devices.sessions.memory', 'Memory')}
          </span>
          <span className="truncate text-center">{t('settings.devices.sessions.cpu', 'CPU')}</span>
          <span className="truncate">{t('settings.devices.sessions.processes', 'Processes')}</span>
          <span aria-label={t('settings.devices.sessions.actions', 'Actions')} />
        </div>
        {sessions.map((session, index) => {
          const meta = metaById.get(session.sessionId);
          const config = meta?.agentConfigId ? configById.get(meta.agentConfigId) : undefined;
          const cliType = meta?.cliType ?? toAgentConfigCliType(session.agentCliType);
          const agentType = meta?.agentType ?? session.agentType;
          const agentName =
            config?.name ?? getAgentDisplayName(cliType, agentType) ?? agentType ?? 'ACP';
          const title = meta?.title?.trim() || t('settings.devices.sessions.untitled', 'Untitled');
          const isTerminating = terminatingSessionId === session.sessionId;
          const isHovered = hoveredSessionId === session.sessionId;
          return (
            <div
              key={session.sessionId}
              className={cn(
                'grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 border-t border-border/50 px-1 py-2 transition-colors md:grid-cols-[minmax(160px,40%)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_40px] md:gap-2.5 md:px-2',
                index === 0 && 'border-t-0 md:border-t',
                isHovered && 'bg-muted'
              )}
            >
              <button
                type="button"
                disabled={!onOpenSession}
                className="col-span-2 flex min-w-0 items-center gap-2.5 rounded-md px-1 py-0.5 text-left enabled:cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default md:col-span-1 md:p-1"
                onMouseEnter={() => {
                  if (onOpenSession) setHoveredSessionId(session.sessionId);
                }}
                onMouseLeave={() => setHoveredSessionId(null)}
                onClick={() => onOpenSession?.(session, meta)}
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/30 text-foreground">
                  {cliType && agentType ? (
                    <AgentIcon
                      cliType={cliType}
                      agentType={agentType}
                      brandId={config?.brandId}
                      env={config?.env}
                      className="h-4 w-4"
                    />
                  ) : (
                    <Cpu className="h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="truncate text-sm font-medium md:text-xs">{title}</div>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-sm break-words">{title}</TooltipContent>
                  </Tooltip>
                  {/* Mobile devices view shows only the ACP logo + conversation
                      title; the agent-type line stays on the wider desktop table. */}
                  <div className="hidden truncate text-[11px] text-muted-foreground md:block">
                    {agentName}
                  </div>
                </div>
              </button>
              <div className="hidden min-w-0 justify-center md:flex">
                <StatusIcon status={session.status} />
              </div>
              <div className="hidden min-w-0 truncate text-center text-xs tabular-nums md:block">
                {formatBytes(session.resource.memoryBytes)}
              </div>
              <div className="hidden min-w-0 truncate text-center text-xs tabular-nums md:block">
                {formatCpu(session.resource)}
              </div>
              <div className="hidden min-w-0 truncate text-xs tabular-nums md:block">
                {session.resource.processCount ?? '-'}
              </div>
              <div className="hidden items-center justify-end gap-0.5 md:flex">
                {onTerminateSession && (
                  <SessionActionButton
                    label={t('settings.devices.sessions.terminate', 'Terminate ACP process')}
                    destructive
                    disabled={isTerminating}
                    onClick={() => {
                      if (isActiveSessionStatus(session.status)) setConfirmSession(session);
                      else void terminate(session);
                    }}
                  >
                    {isTerminating ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CircleStop className="h-3.5 w-3.5" />
                    )}
                  </SessionActionButton>
                )}
              </div>
              <div className="col-span-2 flex min-h-8 min-w-0 items-center gap-1 px-1 text-[11px] tabular-nums text-muted-foreground min-[360px]:gap-2 min-[360px]:text-xs md:hidden">
                <div className="min-w-0 flex-1">
                  <StatusIcon status={session.status} showLabel />
                </div>
                <span className="shrink-0 whitespace-nowrap">
                  {formatCpu(session.resource)} {t('settings.devices.sessions.cpu', 'CPU')}
                </span>
                <span className="shrink-0 whitespace-nowrap">
                  {formatBytes(session.resource.memoryBytes)}{' '}
                  {t('settings.devices.sessions.memoryShort', 'Mem')}
                </span>
                <span className="shrink-0 whitespace-nowrap">
                  {session.resource.processCount === null
                    ? '-'
                    : t('settings.devices.sessions.processCount', '{{count}} proc', {
                        count: session.resource.processCount,
                      })}
                </span>
                <span className="flex shrink-0 gap-0.5">
                  {onTerminateSession && (
                    <SessionActionButton
                      label={t('settings.devices.sessions.terminate', 'Terminate ACP process')}
                      destructive
                      disabled={isTerminating}
                      onClick={() => {
                        if (isActiveSessionStatus(session.status)) setConfirmSession(session);
                        else void terminate(session);
                      }}
                    >
                      {isTerminating ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <CircleStop className="h-4 w-4" />
                      )}
                    </SessionActionButton>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <AlertDialog
        open={confirmSession !== null}
        onOpenChange={(open) => !open && setConfirmSession(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                'settings.devices.sessions.terminateConfirmTitle',
                'Terminate running ACP process?'
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'settings.devices.sessions.terminateConfirmDescription',
                'The active agent turn will stop immediately. The session and its files will remain available.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive"
              disabled={!confirmSession}
              onClick={() => {
                const session = confirmSession;
                setConfirmSession(null);
                if (session) void terminate(session);
              }}
            >
              {t('settings.devices.sessions.terminateAction', 'Terminate')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SessionActionButton({
  label,
  destructive = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          icon
          tone={destructive ? 'destructive' : 'neutral'}
          disabled={disabled}
          onClick={onClick}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function toAgentConfigCliType(value: string | null) {
  return value === 'builtin' || value === 'registry' || value === 'custom' ? value : null;
}

function isActiveSessionStatus(status: AcpSessionMonitorSnapshot['status']): boolean {
  return (
    status === 'initializing' ||
    status === 'running' ||
    status === 'waiting_permission' ||
    status === 'finalizing'
  );
}

function StatusIcon({
  status,
  showLabel = false,
}: {
  status: AcpSessionMonitorSnapshot['status'];
  /** Touch layouts show the status text inline — tooltips are unreachable there. */
  showLabel?: boolean;
}) {
  const { t } = useTranslation();
  const label = t(`settings.devices.status.${status}`, status.replace('_', ' '));
  const icon = (() => {
    switch (status) {
      case 'running':
        return <Loader2 className="h-3.5 w-3.5 animate-spin text-status-success" />;
      case 'waiting_permission':
        return <Hand className="h-3.5 w-3.5 text-status-warning" />;
      case 'failed':
        return <CircleX className="h-3.5 w-3.5 text-destructive" />;
      case 'idle':
        return <Circle className="h-3 w-3 text-muted-foreground/50" />;
      // initializing / finalizing / stopping — transitional states
      default:
        return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/60" />;
    }
  })();
  if (showLabel) {
    return (
      <span className="flex w-fit items-center gap-1.5 text-[11px] text-muted-foreground">
        <span aria-hidden className="flex h-3.5 w-3.5 items-center justify-center">
          {icon}
        </span>
        {label}
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          tabIndex={0}
          className="flex h-5 w-5 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {icon}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatBytePair(usedBytes: number, totalBytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let divisor = 1;
  let unit = 0;
  while (totalBytes / divisor >= 1024 && unit < units.length - 1) {
    divisor *= 1024;
    unit += 1;
  }
  const formatValue = (bytes: number) => {
    const value = bytes / divisor;
    return value === 0 || value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1);
  };
  return `${formatValue(usedBytes)}/${formatValue(totalBytes)} ${units[unit]}`;
}

function formatCpu(resource: MachineMonitorResourceUsage): string {
  if (resource.cpuCores === null) return '-';
  return formatPercent(resource.cpuCores * 100);
}

function formatDeviceCpu(snapshot: MachineMonitorSnapshot): string {
  if (snapshot.deviceCpuCores === null || snapshot.deviceCpuCores === undefined) return '-';
  return formatPercent(snapshot.deviceCpuCores * 100);
}

function formatPercent(percent: number): string {
  return `${percent.toFixed(percent > 0 && percent < 10 ? 1 : 0)}%`;
}
