import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Check, Clock3, Minus, RotateCcw, XCircle } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import type { ProviderSetupFailureCode } from '@lody/shared';
import { Table } from '@lody/ui/table';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { OnboardingBackButton, OnboardingNextButton, OnboardingShell } from '../onboarding-shell';
import { useOnboardingAnalytics } from '../onboarding-analytics';
import { onboardingSurface as surface } from './surface';

const styles = stylex.create({
  retry: { marginTop: space[3] },
  // Layout only: the table owns each cell's type, padding and truncation.
  labelColumn: { width: '96px' },
  valueColumn: { maxWidth: '192px' },
  value: { fontWeight: 500 },
  status: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  statusReady: { color: colors.success },
});

export type OnboardingSummaryAgentState = 'ready' | 'preparing' | 'failed' | 'missing';

type SummaryStatus = 'ready' | 'preparing' | 'failed' | 'missing';

export function SummaryScreen({
  agentState,
  agentName,
  agentFailureCode,
  projectName,
  onBack,
  onComplete,
  onRetryAgent,
}: {
  agentState: OnboardingSummaryAgentState;
  agentName?: string;
  agentFailureCode?: ProviderSetupFailureCode;
  projectName?: string;
  onBack: () => void;
  onComplete: () => void;
  onRetryAgent?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const analytics = useOnboardingAnalytics();
  const [retryingAgent, setRetryingAgent] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const title =
    agentState === 'ready'
      ? t('onboarding.summary.title', 'Lody is ready')
      : agentState === 'preparing'
        ? t('onboarding.summary.preparingTitle', 'Ready to enter Lody')
        : agentState === 'failed'
          ? t('onboarding.summary.failedTitle', 'Agent setup needs attention')
          : t('onboarding.summary.exploreTitle', 'Explore Lody');
  const description =
    agentState === 'ready'
      ? t('onboarding.summary.description', 'You can add Agents and projects later from Settings.')
      : agentState === 'preparing'
        ? t(
            'onboarding.summary.preparingDescription',
            'Your Agent setup is still in progress. You can enter Lody now and check its status in Settings.'
          )
        : agentState === 'failed'
          ? t(
              'onboarding.summary.failedDescription',
              'Your Agent could not finish setup. Retry here or enter Lody and finish later.'
            )
          : t(
              'onboarding.summary.exploreDescription',
              'Enter Lody now and connect a coding agent from Settings when you are ready.'
            );

  const resolvedAgentName =
    agentName ??
    (agentState === 'missing'
      ? t('onboarding.summary.notConfigured', 'Not configured')
      : t('onboarding.summary.selectedAgent', 'Selected Agent'));
  const resolvedProjectName = projectName ?? t('onboarding.summary.notSelected', 'Not selected');

  return (
    <OnboardingShell
      stepKey="summary"
      title={title}
      description={description}
      secondaryAction={<OnboardingBackButton onClick={onBack} />}
      primaryAction={
        <OnboardingNextButton
          finish
          onClick={onComplete}
          label={
            agentState === 'ready'
              ? t('onboarding.summary.open', 'Open Lody')
              : t('onboarding.summary.enter', 'Enter Lody')
          }
        />
      }
    >
      <div {...stylex.props(surface.card)}>
        <Table.Root size="large">
          <Table.Body>
            <SummaryRow
              label={t('onboarding.summary.agent', 'Agent')}
              value={resolvedAgentName}
              status={agentState}
            />
            <SummaryRow
              label={t('onboarding.summary.project', 'Project')}
              value={resolvedProjectName}
              status={projectName ? 'ready' : 'missing'}
            />
          </Table.Body>
        </Table.Root>
      </div>
      {agentState === 'failed' && onRetryAgent ? (
        <div {...stylex.props(surface.message, surface.messageDanger, styles.retry)}>
          <div role="alert" {...stylex.props(surface.messageBody)}>
            <p {...stylex.props(surface.messageText)}>
              {agentFailureCode
                ? agentFailureMessage(t, agentFailureCode)
                : t('onboarding.summary.agentRetryHint', 'Agent setup can be retried here.')}
            </p>
            {retryError ? <p {...stylex.props(surface.messageDetail)}>{retryError}</p> : null}
          </div>
          <Button
            type="button"
            variant="secondary"
            size="small"
            disabled={retryingAgent}
            onClick={() => {
              if (retryingAgent) return;
              const startedAtMs = analytics.now();
              setRetryingAgent(true);
              setRetryError(null);
              analytics.capture('onboarding/operation_started', {
                step: 'summary',
                operation: 'agent_setup_retry_request',
              });
              void onRetryAgent()
                .then(() => {
                  analytics.capture('onboarding/operation_succeeded', {
                    step: 'summary',
                    operation: 'agent_setup_retry_request',
                    duration_ms: analytics.durationSince(startedAtMs),
                  });
                })
                .catch((error: unknown) => {
                  console.error('[onboarding] Failed to retry Agent setup from Summary:', error);
                  analytics.capture('onboarding/operation_failed', {
                    step: 'summary',
                    operation: 'agent_setup_retry_request',
                    failure_code: 'agent_setup_retry_failed',
                    duration_ms: analytics.durationSince(startedAtMs),
                    retryable: true,
                  });
                  setRetryError(error instanceof Error ? error.message : String(error));
                })
                .finally(() => setRetryingAgent(false));
            }}
          >
            {retryingAgent ? (
              <Spinner size="small" />
            ) : (
              <RotateCcw {...stylex.props(surface.icon16)} />
            )}
            {t('common.retry', 'Retry')}
          </Button>
        </div>
      ) : null}
    </OnboardingShell>
  );
}

function agentFailureMessage(
  t: ReturnType<typeof useTranslation>['t'],
  failureCode: ProviderSetupFailureCode
): string {
  switch (failureCode) {
    case 'runtime-unavailable':
      return t(
        'onboarding.summary.failure.runtimeUnavailable',
        'This Agent is not available on the selected machine. Update Lody or choose another machine in Settings.'
      );
    case 'runtime-install-failed':
      return t(
        'onboarding.summary.failure.runtimeInstallFailed',
        'Lody could not download the Agent runtime. Check your connection and try again.'
      );
    case 'verification-failed':
      return t(
        'onboarding.summary.failure.verificationFailed',
        'Lody could not verify this Agent. Check its sign-in or credentials and try again.'
      );
    default:
      return failureCode satisfies never;
  }
}

function SummaryRow({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status: SummaryStatus;
}) {
  const { t } = useTranslation();
  const statusLabel =
    status === 'ready'
      ? t('onboarding.summary.statusReady', 'Ready')
      : status === 'preparing'
        ? t('onboarding.summary.statusPreparing', 'Setting up')
        : status === 'failed'
          ? t('onboarding.summary.statusFailed', 'Setup failed')
          : t('onboarding.summary.statusLater', 'Set up later');

  return (
    <Table.Row>
      <Table.ColumnHeader scope="row" className={stylex.props(styles.labelColumn).className}>
        {label}
      </Table.ColumnHeader>
      <Table.Cell className={stylex.props(styles.valueColumn).className}>
        <span {...stylex.props(styles.value)}>{value}</span>
      </Table.Cell>
      <Table.Cell align="end">
        <span {...stylex.props(styles.status)}>
          {status === 'ready' ? (
            <Check {...stylex.props(surface.icon14, styles.statusReady)} />
          ) : status === 'preparing' ? (
            <Clock3 {...stylex.props(surface.icon14, surface.iconAccent)} />
          ) : status === 'failed' ? (
            <XCircle {...stylex.props(surface.icon14, surface.iconDestructive)} />
          ) : (
            <Minus {...stylex.props(surface.icon14, surface.iconMuted)} />
          )}
          {statusLabel}
        </span>
      </Table.Cell>
    </Table.Row>
  );
}
