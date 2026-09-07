import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Clock3, Loader2, Minus, RotateCcw, XCircle } from 'lucide-react';
import { Table, TableBody, TableCell, TableRow } from '@/ui/table';
import { Button } from '@/ui/button';
import { OnboardingBackButton, OnboardingNextButton, OnboardingShell } from '../onboarding-shell';
import { useOnboardingAnalytics } from '../onboarding-analytics';

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
  agentFailureCode?: string;
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
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card/45">
        <Table>
          <TableBody>
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
          </TableBody>
        </Table>
      </div>
      {agentState === 'failed' && onRetryAgent ? (
        <div className="mt-3 space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-3 text-xs text-destructive">
          <div role="alert">
            <p>{t('onboarding.summary.agentRetryHint', 'Agent setup can be retried here.')}</p>
            {agentFailureCode ? (
              <p className="mt-1 break-words font-mono opacity-90">
                {t('onboarding.summary.failureCode', 'Failure code: {{code}}', {
                  code: agentFailureCode,
                })}
              </p>
            ) : null}
            {retryError ? (
              <p className="mt-1 break-words font-mono opacity-90">{retryError}</p>
            ) : null}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
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
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RotateCcw className="size-3.5" />
            )}
            {t('common.retry', 'Retry')}
          </Button>
        </div>
      ) : null}
    </OnboardingShell>
  );
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
    <TableRow className="hover:bg-transparent">
      <TableCell className="w-24 py-4 text-xs font-medium text-muted-foreground">{label}</TableCell>
      <TableCell className="max-w-48 truncate py-4 font-medium">{value}</TableCell>
      <TableCell className="py-4 text-right">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          {status === 'ready' ? (
            <Check className="size-3.5 text-primary" />
          ) : status === 'preparing' ? (
            <Clock3 className="size-3.5 text-primary" />
          ) : status === 'failed' ? (
            <XCircle className="size-3.5 text-destructive" />
          ) : (
            <Minus className="size-3.5" />
          )}
          {statusLabel}
        </span>
      </TableCell>
    </TableRow>
  );
}
