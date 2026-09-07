import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import {
  machineSupportsProviderSetupProtocol,
  type MachineAcpBinaryProgressMessage,
  type MachineViewMeta,
  type ProviderSetupTask,
} from '@lody/shared';
import { Loader2, RotateCcw, Trash2, XCircle } from 'lucide-react';

import { AgentIcon } from '@/components/icons/agent-icon';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useMachineAcpBinaryProgress } from '@/hooks/use-machine-acp-binary-progress';
import { useMachineOnlineStatus } from '@/hooks/use-machine-online-status';
import { AcpAuthenticationPanel } from './acp-authentication-panel';
import { labelForAgent } from './provider-row';
import { ProviderProgressButton } from './provider-progress-button';

export type ProviderSetupRowProps = {
  setup: ProviderSetupTask;
  /** Undefined only while the target machine's meta has not loaded yet. */
  machine: MachineViewMeta | undefined;
  onRetry: (setup: ProviderSetupTask) => Promise<void>;
  onDelete: (setup: ProviderSetupTask) => Promise<void>;
  className?: string;
};

export function ProviderSetupRow({
  setup,
  machine,
  onRetry,
  onDelete,
  className,
}: ProviderSetupRowProps) {
  const { t } = useTranslation();
  const [actionPending, setActionPending] = useState<'retry' | 'delete' | null>(null);
  const config = setup.config;
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const runtimeProgress = useMachineAcpBinaryProgress(runtime, setup.machineId, config.agentType);
  const machineOnline = useMachineOnlineStatus(setup.machineId) === 'online';
  const supportsSetupProtocol = machineSupportsProviderSetupProtocol(machine);
  const active =
    setup.status === 'queued' ||
    setup.status === 'preparing-runtime' ||
    setup.status === 'verifying';
  const downloadPercent =
    setup.status === 'preparing-runtime' &&
    runtimeProgress?.status === 'downloading' &&
    typeof runtimeProgress.percent === 'number'
      ? Math.min(100, Math.max(0, Math.round(runtimeProgress.percent)))
      : null;

  const statusText = (() => {
    const status = setup.status;
    switch (status) {
      case 'queued':
        if (machine && !supportsSetupProtocol) {
          return t(
            'settings.agent.setup.unsupportedTarget',
            'Update Lody on the target machine to finish this provider setup.'
          );
        }
        if (!machineOnline) {
          return t(
            'settings.agent.setup.machineOffline',
            'Waiting for the target machine to come online…'
          );
        }
        return t('settings.agent.setup.queued', 'Waiting for the target machine…');
      case 'preparing-runtime':
        return runtimeProgress
          ? formatRuntimeProgress(t, runtimeProgress)
          : t('settings.agent.setup.preparingRuntime', 'Downloading the agent runtime…');
      case 'verifying':
        return t('settings.agent.setup.verifying', 'Checking credentials and provider access…');
      case 'awaiting-auth':
        return t('settings.agent.setup.awaitingAuth', 'Sign in to finish this provider setup.');
      case 'failed':
        if (setup.failureCode === 'runtime-unavailable') {
          return t(
            'settings.agent.setup.runtimeUnavailable',
            'This runtime is not available on the target machine.'
          );
        }
        if (setup.failureCode === 'runtime-install-failed') {
          return t(
            'settings.agent.setup.runtimeInstallFailed',
            'The agent runtime could not be downloaded.'
          );
        }
        return t(
          'settings.agent.setup.verificationFailed',
          'Provider verification failed. Try again.'
        );
      default:
        return status satisfies never;
    }
  })();

  const runAction = async (
    action: 'retry' | 'delete',
    callback: (setup: ProviderSetupTask) => Promise<void>
  ) => {
    if (actionPending) return;
    setActionPending(action);
    try {
      await callback(setup);
    } catch {
      // The owning screen reports the actionable error.
    } finally {
      setActionPending(null);
    }
  };

  return (
    <div
      className={cn(
        'rounded-xl border border-border/60 bg-card/40 px-3 py-3',
        setup.status === 'failed' && 'border-status-error/30',
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted/40">
          <AgentIcon
            cliType={config.cliType}
            agentType={config.agentType}
            brandId={config.brandId}
            env={config.env}
            className="h-5 w-5"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{config.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {labelForAgent(config.cliType, config.agentType)}
          </div>
        </div>
        {active ? (
          <ProviderProgressButton
            percent={downloadPercent}
            label={
              downloadPercent !== null
                ? `${downloadPercent}%`
                : setup.status === 'queued'
                  ? t('onboarding.providers.waitingAction', 'Waiting')
                  : t('onboarding.providers.workingAction', 'Working')
            }
            ariaLabel={statusText}
          />
        ) : setup.status === 'failed' ? (
          <XCircle className="h-4 w-4 shrink-0 text-status-error" />
        ) : null}
        {setup.status === 'failed' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={actionPending !== null}
            onClick={() => void runAction('retry', onRetry)}
          >
            {actionPending === 'retry' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
            {t('common.retry', 'Retry')}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
          disabled={actionPending !== null}
          aria-label={t('common.delete', 'Delete')}
          onClick={() => void runAction('delete', onDelete)}
        >
          {actionPending === 'delete' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{statusText}</p>
      {setup.status === 'awaiting-auth' ? (
        <div className="mt-3">
          <AcpAuthenticationPanel
            machineId={setup.machineId}
            configId={config.id}
            cliType={config.cliType}
            agentType={config.agentType}
            customAcp={config.customAcp}
            runtimeOverrides={config.runtimeOverrides}
            env={config.env}
            compact
          />
        </div>
      ) : null}
    </div>
  );
}

function formatRuntimeProgress(
  t: ReturnType<typeof useTranslation>['t'],
  progress: MachineAcpBinaryProgressMessage
): string {
  if (progress.status === 'downloading') {
    return typeof progress.percent === 'number'
      ? t(
          'settings.agent.setup.downloadingPercent',
          'Downloading the agent runtime… {{percent}}%',
          {
            percent: Math.round(progress.percent),
          }
        )
      : t('settings.agent.setup.preparingRuntime', 'Downloading the agent runtime…');
  }
  if (progress.status === 'verifying') {
    return t('settings.agent.setup.verifyingRuntime', 'Verifying the agent runtime…');
  }
  if (progress.status === 'extracting') {
    return t('settings.agent.setup.extractingRuntime', 'Extracting the agent runtime…');
  }
  if (progress.status === 'publishing') {
    return t('settings.agent.setup.installingRuntime', 'Installing the agent runtime…');
  }
  if (progress.status === 'installed') {
    return t('settings.agent.setup.runtimeReady', 'Agent runtime ready; checking provider access…');
  }
  if (progress.status === 'error') {
    return (
      progress.error ??
      t('settings.agent.setup.runtimeInstallFailed', 'The agent runtime could not be downloaded.')
    );
  }
  return t('settings.agent.setup.preparingRuntime', 'Downloading the agent runtime…');
}
