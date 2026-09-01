import { useTranslation } from 'react-i18next';
import { Check, Clock3, Minus } from 'lucide-react';
import { Table, TableBody, TableCell, TableRow } from '@/ui/table';
import { OnboardingBackButton, OnboardingNextButton, OnboardingShell } from '../onboarding-shell';

export type OnboardingSummaryAgentState = 'ready' | 'preparing' | 'missing';

type SummaryStatus = 'ready' | 'preparing' | 'missing';

export function SummaryScreen({
  agentState,
  agentName,
  projectName,
  onBack,
  onComplete,
}: {
  agentState: OnboardingSummaryAgentState;
  agentName?: string;
  projectName?: string;
  onBack: () => void;
  onComplete: () => void;
}) {
  const { t } = useTranslation();
  const title =
    agentState === 'ready'
      ? t('onboarding.summary.title', 'Lody is ready')
      : agentState === 'preparing'
        ? t('onboarding.summary.preparingTitle', 'Ready to enter Lody')
        : t('onboarding.summary.exploreTitle', 'Explore Lody');
  const description =
    agentState === 'ready'
      ? t('onboarding.summary.description', 'You can add Agents and projects later from Settings.')
      : agentState === 'preparing'
        ? t(
            'onboarding.summary.preparingDescription',
            'Your Agent setup is still in progress. You can enter Lody now and check its status in Settings.'
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
          ) : (
            <Minus className="size-3.5" />
          )}
          {statusLabel}
        </span>
      </TableCell>
    </TableRow>
  );
}
