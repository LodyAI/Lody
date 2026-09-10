import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { Loader2, RefreshCw, Trash2 } from 'lucide-react';
import {
  REGISTRY_ACP_AGENTS,
  type AgentConfigCliType,
  type AgentConfigMeta,
  type MachineAcpBinaryProgressMessage,
  type MachineViewMeta,
  parseRateLimitEntryKey,
} from '@lody/shared';
import { toast } from 'sonner';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
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
import { cn } from '@/lib/utils';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useMachineAcpBinaryProgress } from '@/hooks/use-machine-acp-binary-progress';
import { AgentIcon } from '@/components/icons/agent-icon';
import { CodexResetForecastChip } from '@/components/codex-reset/codex-reset-forecast-entry';
import { canShowCodexResetForecast } from '@/lib/codex-reset-forecast';
import {
  canShowSubscriptionRateLimits,
  formatAgentRateLimitWindowLabel,
  formatRateLimitWindowShortLabel,
  getAgentRateLimitEntries,
  getAgentRateLimitWindows,
} from '@/lib/session-usage';

export type ProviderRowProps = {
  config: AgentConfigMeta;
  machine: MachineViewMeta | undefined;
  onEdit: (config: AgentConfigMeta) => void;
  onDelete?: (config: AgentConfigMeta) => Promise<void>;
  onRefresh?: (config: AgentConfigMeta) => Promise<void>;
  variant?: 'card' | 'list';
  className?: string;
};

/** One provider entry. Signing in again lives in the provider's detail dialog
 *  (`AgentConfigDialog`), not here: only some providers can sign in at all. */
export function ProviderRow({
  config,
  machine,
  onEdit,
  onDelete,
  onRefresh,
  variant = 'card',
  className,
}: ProviderRowProps) {
  const { t } = useTranslation();
  const { cliType, agentType } = config;
  const envCount = Object.keys(config.env || {}).length;
  const showRateLimits =
    canShowSubscriptionRateLimits({ cliType, agentType, config }) &&
    !!machine?.raceLimits &&
    Object.keys(machine.raceLimits).some(
      (key) => parseRateLimitEntryKey(key).cliType === agentType
    );

  // Compact usage meters shown inline after the provider name.
  const rateLimitWindows = useMemo(() => {
    if (!showRateLimits || !machine?.raceLimits) return [];
    for (const entry of getAgentRateLimitEntries(machine.raceLimits, agentType)) {
      const windows = getAgentRateLimitWindows(entry.limits);
      if (windows.length > 0) return windows;
    }
    return [];
  }, [showRateLimits, machine?.raceLimits, agentType]);

  // Codex-only: the third-party reset forecast for OpenAI's own usage limits.
  const showResetForecast = canShowCodexResetForecast({ cliType, agentType, config });

  const typeBadge = cliType === 'builtin' ? null : cliType === 'custom' ? 'Custom' : 'Registry';

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const binaryProgress = useMachineAcpBinaryProgress(
    runtime,
    machine?.id ?? null,
    config.agentType
  );
  const binaryProgressText = binaryProgress ? formatBinaryProgressText(t, binaryProgress) : null;

  const handleDelete = async () => {
    if (!onDelete) return;
    try {
      setDeleting(true);
      await onDelete(config);
      setDeleteOpen(false);
    } catch (error) {
      toast.error(t('agents.deleteConfigError', 'Failed to delete configuration'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleRefresh = async () => {
    if (!onRefresh) return;
    try {
      setRefreshing(true);
      await onRefresh(config);
      toast.success(
        t('settings.agent.provider.refreshSuccess', 'Refreshed {{name}}', { name: config.name })
      );
    } catch (error) {
      toast.error(
        t('settings.agent.provider.refreshFailed', 'Failed to refresh {{agent}}', {
          agent: config.name,
        }),
        { description: error instanceof Error ? error.message : String(error) }
      );
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div
      className={cn(
        'overflow-hidden',
        variant === 'card'
          ? '@container rounded-lg bg-foreground/[0.04]'
          : 'bg-transparent [&+&]:border-t [&+&]:border-border',
        className
      )}
    >
      <div className="flex w-full min-w-0 items-center transition-colors hover:bg-hover/40">
        <button
          type="button"
          onClick={() => onEdit(config)}
          className={cn(
            'flex min-w-0 flex-1 items-center text-left focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring',
            variant === 'card' ? 'gap-2 rounded-md px-3 py-1.5' : 'gap-3 rounded-none px-4 py-3'
          )}
          aria-label={t('agents.editConfig', 'Edit config')}
        >
          <div
            className={cn(
              'flex shrink-0 items-center justify-center text-foreground/80',
              variant === 'card' ? 'h-6 w-6' : 'h-8 w-8'
            )}
          >
            <AgentIcon
              cliType={cliType}
              agentType={agentType}
              brandId={config.brandId}
              env={config.env}
              className={variant === 'card' ? 'h-4 w-4' : 'h-5 w-5'}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="min-w-0 truncate text-sm font-medium">{config.name}</span>
              {typeBadge ? (
                <Badge variant="secondary" className="text-[10px] capitalize">
                  {typeBadge}
                </Badge>
              ) : null}
            </div>
          </div>
        </button>
        <div
          className={cn(
            'flex shrink-0 items-center gap-2 pr-3 text-xs text-muted-foreground',
            variant === 'card' ? 'py-1.5' : 'py-3'
          )}
        >
          {/* Not mounted at all when ineligible, so a non-Codex row costs no
              store subscription and no clock tick. */}
          {showResetForecast ? <CodexResetForecastChip enabled /> : null}
          {rateLimitWindows.length > 0 && variant === 'card' && (
            <div className="hidden items-center gap-2.5 @sm:flex">
              {rateLimitWindows.map((window, index) => (
                <RateLimitMeter
                  key={`${window.windowDurationSeconds ?? 'unknown'}-${index}`}
                  label={formatAgentRateLimitWindowLabel(
                    window,
                    formatRateLimitWindowShortLabel(window.windowDurationSeconds),
                    t
                  )}
                  remainingPercent={window.remainingPercent}
                />
              ))}
            </div>
          )}
          {envCount > 0 && (
            <span>{t('settings.agent.provider.envCount', { count: envCount })}</span>
          )}
          {refreshing && binaryProgressText ? (
            <span className="max-w-[9rem] truncate whitespace-nowrap">{binaryProgressText}</span>
          ) : null}
          {onRefresh && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              disabled={refreshing}
              aria-label={t(
                'agents.acpCapabilities.refreshModelsAndModes',
                'Refresh models and modes'
              )}
              onClick={(event) => {
                event.stopPropagation();
                void handleRefresh();
              }}
            >
              {refreshing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              aria-label={t('common.delete', 'Delete')}
              onClick={(event) => {
                event.stopPropagation();
                setDeleteOpen(true);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
      {rateLimitWindows.length > 0 && variant === 'card' && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-3 pb-2.5 pt-0.5 @sm:hidden">
          {rateLimitWindows.map((window, index) => (
            <RateLimitMeter
              key={`${window.windowDurationSeconds ?? 'unknown'}-${index}`}
              label={formatRateLimitWindowShortLabel(window.windowDurationSeconds)}
              remainingPercent={window.remainingPercent}
            />
          ))}
        </div>
      )}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('agents.deleteConfigConfirm', 'Delete Configuration')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('agents.deleteConfigConfirmDescription', {
                name: config.name,
                defaultValue:
                  'Are you sure you want to delete "{{name}}"? This action cannot be undone.',
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
              className={cn('bg-destructive text-destructive-foreground hover:bg-destructive/90')}
            >
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('common.delete', 'Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RateLimitMeter({
  label,
  remainingPercent,
}: {
  label: string;
  remainingPercent: number | null;
}) {
  const pct = remainingPercent == null ? 0 : Math.min(100, Math.max(0, remainingPercent));
  const percentText = remainingPercent == null ? '—' : `${Math.round(remainingPercent)}%`;
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground"
      title={`${label}: ${percentText}`}
    >
      <span className="font-medium">{label}</span>
      <span className="relative h-1 w-10 overflow-hidden rounded-full bg-foreground/10">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-muted-foreground/60"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="font-mono tabular-nums">{percentText}</span>
    </span>
  );
}

function formatBinaryProgressText(
  t: ReturnType<typeof useTranslation>['t'],
  progress: MachineAcpBinaryProgressMessage
): string {
  if (progress.status === 'downloading') {
    if (typeof progress.percent === 'number') {
      return t('settings.agent.provider.binaryDownloadingPercent', 'Downloading {{percent}}%', {
        percent: Math.round(progress.percent),
      });
    }
    return t('settings.agent.provider.binaryDownloading', 'Downloading');
  }
  if (progress.status === 'verifying') {
    return t('settings.agent.provider.binaryVerifying', 'Verifying');
  }
  if (progress.status === 'extracting') {
    return t('settings.agent.provider.binaryExtracting', 'Extracting');
  }
  if (progress.status === 'publishing') {
    return t('settings.agent.provider.binaryPublishing', 'Installing');
  }
  if (progress.status === 'not-installed') {
    return t('settings.agent.provider.binaryRequired', 'Download required');
  }
  if (progress.status === 'error') {
    return t('settings.agent.provider.binaryFailed', 'Download failed');
  }
  if (progress.status === 'installed') {
    return t('settings.agent.provider.binaryReady', 'Ready');
  }
  return t('settings.agent.provider.binaryChecking', 'Checking');
}

export function labelForAgent(cliType: AgentConfigCliType, agentType: string): string {
  if (cliType === 'builtin') {
    if (agentType === 'claude') return 'Claude';
    if (agentType === 'codex') return 'Codex';
    return agentType;
  }
  if (cliType === 'custom') {
    return 'Custom';
  }
  const registry = REGISTRY_ACP_AGENTS.find((a) => a.id === agentType);
  return registry?.name ?? agentType;
}
