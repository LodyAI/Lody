import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import {
  machineSupportsProviderSetupProtocol,
  type MachineAcpBinaryProgressMessage,
  type MachineViewMeta,
  type ProviderSetupTask,
} from '@lody/shared';
import { Check, Copy, Loader2, RotateCcw, Trash2, XCircle } from 'lucide-react';

import { AgentReadinessMark, type AgentReadiness } from '@/components/shared/agent-readiness-mark';
import { Button } from '@/ui/button';
import { writeTextToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/lib/native-browser';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useMachineAcpBinaryProgress } from '@/hooks/use-machine-acp-binary-progress';
import { useMachineOnlineStatus } from '@/hooks/use-machine-online-status';
import { AcpAuthenticationPanel } from './acp-authentication-panel';
import { labelForAgent } from './provider-row';
import { ProviderProgressButton } from './provider-progress-button';

const BUB_ACP_INSTALL_DOCS_URL = 'https://bub.build/docs/tutorials/acp-server/';
const BUB_ACP_INSTALL_COMMAND = 'curl -fsSL https://bub.build/install.sh | bash -- --preset acp';

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
  const [installCommandCopied, setInstallCommandCopied] = useState(false);
  const config = setup.config;
  const isBubSetup = config.cliType === 'builtin' && config.agentType === 'bub';
  const installDocsUrl = isBubSetup ? BUB_ACP_INSTALL_DOCS_URL : undefined;
  const showBubInstallCommand =
    isBubSetup && setup.status === 'failed' && setup.failureCode === 'runtime-unavailable';
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
          if (isBubSetup) {
            return t(
              'settings.agent.setup.bubInstallRequired',
              'Bub or its ACP server is not installed on the target machine.'
            );
          }
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

  // A setup row sits in the same list as a published AgentConfig row, so it
  // borrows that row's geometry exactly: the same mark, the same two-line text
  // column, the same fixed action slots. Anything narrower here re-ragged every
  // column the moment a pending setup appeared above the published agents.
  const markReadiness: AgentReadiness =
    setup.status === 'failed' ||
    (setup.status === 'queued' &&
      (!machineOnline || (machine !== undefined && !supportsSetupProtocol)))
      ? 'cold'
      : active
        ? 'arriving'
        : 'ready';

  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 bg-card/40',
        setup.status === 'failed' && 'border-status-error/30',
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-3 py-3 pl-3">
        <AgentReadinessMark
          cliType={config.cliType}
          agentType={config.agentType}
          brandId={config.brandId}
          env={config.env}
          readiness={markReadiness}
          percent={downloadPercent}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{config.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {labelForAgent(config.cliType, config.agentType)}
          </div>
        </div>
        {/* Status column, then action column, then delete — the same three
            slots an AgentConfig row uses, in the same order, so a pending setup
            above a published agent lines up with it instead of ragging the
            list. The middle slot is empty here because a setup has nothing to
            edit; the width stays reserved, which is what holds the column. */}
        <div className="flex min-w-20 shrink-0 justify-end">
          {setup.status === 'failed' ? (
            <XCircle className="h-4 w-4 shrink-0 text-status-error" />
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1 pr-3">
          <div className="w-12 shrink-0" />
          <div className="flex w-20 shrink-0 items-center justify-end">
            {active ? (
              <ProviderProgressButton
                className="w-full"
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full gap-1 px-0"
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
          </div>
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
      </div>
      {/* Aligned to the name above it, not to the card edge: the sentence is
          about this agent, so it starts where the agent's text column starts. */}
      <p className="ml-[3.25rem] pb-3 pr-3 text-xs text-muted-foreground">{statusText}</p>
      {showBubInstallCommand ? (
        <div className="ml-[3.25rem] space-y-2 pb-3 pr-3">
          <p className="text-xs text-muted-foreground">
            {t('settings.agent.setup.bubInstallCommand', 'Install it in one step:')}
          </p>
          <div className="flex min-w-0 items-center gap-2 rounded-md bg-muted/60 px-2 py-1.5">
            <code className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap text-xs">
              {BUB_ACP_INSTALL_COMMAND}
            </code>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1 px-2 text-xs"
              aria-label={
                installCommandCopied ? t('common.copied', 'Copied') : t('common.copy', 'Copy')
              }
              onClick={() => {
                void writeTextToClipboard(BUB_ACP_INSTALL_COMMAND).then((copied) => {
                  if (copied) setInstallCommandCopied(true);
                });
              }}
            >
              {installCommandCopied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {installCommandCopied ? t('common.copied', 'Copied') : t('common.copy', 'Copy')}
            </Button>
          </div>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => {
              void openExternalUrl(BUB_ACP_INSTALL_DOCS_URL);
            }}
          >
            {t('settings.agent.dialog.bubInstallDocs', 'Open install guide')}
          </Button>
        </div>
      ) : setup.status === 'failed' && installDocsUrl ? (
        <div className="ml-[3.25rem] pb-3 pr-3">
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => {
              void openExternalUrl(installDocsUrl);
            }}
          >
            {t('settings.agent.dialog.bubInstallDocs', 'Open install guide')}
          </Button>
        </div>
      ) : null}
      {setup.status === 'awaiting-auth' ? (
        <div className="ml-[3.25rem] pb-3 pr-3">
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
