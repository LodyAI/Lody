import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import {
  machineSupportsProviderSetupProtocol,
  type MachineAcpBinaryProgressMessage,
  type MachineViewMeta,
  type ProviderSetupTask,
} from '@lody/shared';
import { RotateCcw, Trash2 } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';

import { AgentReadinessMark, type AgentReadiness } from '@/components/shared/agent-readiness-mark';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { withClassName } from '@/lib/stylex';
import { openExternalUrl } from '@/lib/native-browser';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useMachineAcpBinaryProgress } from '@/hooks/use-machine-acp-binary-progress';
import { useMachineOnlineStatus } from '@/hooks/use-machine-online-status';
import { AcpAuthenticationPanel } from './acp-authentication-panel';
import { labelForAgent } from './provider-row';
import { ProviderProgressButton } from './provider-progress-button';
import { BUB_ACP_INSTALL_DOCS_URL, BubInstallGuide } from './bub-install-guide';
import { settingsCatalog as catalog } from './surface';

/** Where the agent's text column starts: the mark, its gap, and the row's inset. */
const TEXT_INSET = '52px';

const styles = stylex.create({
  root: { minWidth: 0 },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    minWidth: 0,
    paddingBlock: space[3],
    paddingInlineStart: space[3],
  },
  text: { flexGrow: 1, minWidth: 0 },
  name: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.875em',
    color: colors.label,
  },
  agent: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.75em',
    color: colors.secondaryLabel,
  },
  /** The provider row's status column, reserved so the actions line up with it. */
  statusSlot: { flexShrink: 0, minWidth: '80px' },
  actions: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[1],
    paddingInlineEnd: space[3],
  },
  editSlot: { flexShrink: 0, width: '48px' },
  primarySlot: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
    width: '80px',
  },
  /** Layout only, for the button in the slot: it fills the slot. */
  fill: { width: '100%' },
  /** Aligned to the name above it, not to the edge: it is about this agent. */
  detail: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    paddingInlineStart: TEXT_INSET,
    paddingInlineEnd: space[3],
    paddingBottom: space[3],
  },
  status: { margin: 0, fontSize: '0.75em', color: colors.secondaryLabel },
  /** A failure says so in its sentence; the row takes no border for it. */
  statusFailed: { color: colors.destructive },
});

export type ProviderSetupRowProps = {
  setup: ProviderSetupTask;
  /** Undefined only while the target machine's meta has not loaded yet. */
  machine: MachineViewMeta | undefined;
  onRetry: (setup: ProviderSetupTask) => Promise<void>;
  onDelete: (setup: ProviderSetupTask) => Promise<void>;
  /** Layout only. The row draws no surface: a list's card draws it. */
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
    <div {...withClassName(stylex.props(styles.root), className)}>
      <div {...stylex.props(styles.head)}>
        <AgentReadinessMark
          cliType={config.cliType}
          agentType={config.agentType}
          brandId={config.brandId}
          env={config.env}
          readiness={markReadiness}
          percent={downloadPercent}
          size="md"
        />
        <div {...stylex.props(styles.text)}>
          <div {...stylex.props(styles.name)}>{config.name}</div>
          <div {...stylex.props(styles.agent)}>
            {labelForAgent(config.cliType, config.agentType)}
          </div>
        </div>
        {/* Reserve the provider row's status and edit columns so setup actions
            stay aligned with published providers. Failures are explained below. */}
        <div {...stylex.props(styles.statusSlot)} aria-hidden="true" />
        <div {...stylex.props(styles.actions)}>
          <div {...stylex.props(styles.editSlot)} />
          <div {...stylex.props(styles.primarySlot)}>
            {active ? (
              <ProviderProgressButton
                className={stylex.props(styles.fill).className}
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
                variant="secondary"
                size="small"
                className={stylex.props(styles.fill).className}
                disabled={actionPending !== null}
                onClick={() => void runAction('retry', onRetry)}
              >
                {actionPending === 'retry' ? (
                  <Spinner size="small" />
                ) : (
                  <RotateCcw {...stylex.props(catalog.icon)} />
                )}
                {t('common.retry', 'Retry')}
              </Button>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="small"
            icon
            tone="destructive"
            disabled={actionPending !== null}
            aria-label={t('common.delete', 'Delete')}
            onClick={() => void runAction('delete', onDelete)}
          >
            {actionPending === 'delete' ? (
              <Spinner size="small" />
            ) : (
              <Trash2 {...stylex.props(catalog.icon)} />
            )}
          </Button>
        </div>
      </div>
      {/* Aligned to the name above it, not to the edge: the sentence is about
          this agent, so it starts where the agent's text column starts. */}
      <div {...stylex.props(styles.detail)}>
        <p {...stylex.props(styles.status, setup.status === 'failed' && styles.statusFailed)}>
          {statusText}
        </p>
        {showBubInstallCommand ? (
          <BubInstallGuide />
        ) : setup.status === 'failed' && installDocsUrl ? (
          <div>
            <Button
              type="button"
              variant="link"
              size="small"
              onClick={() => {
                void openExternalUrl(installDocsUrl);
              }}
            >
              {t('settings.agent.dialog.bubInstallDocs', 'Open install guide')}
            </Button>
          </div>
        ) : null}
        {setup.status === 'awaiting-auth' ? (
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
        ) : null}
      </div>
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
