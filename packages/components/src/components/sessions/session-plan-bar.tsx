import { useMemo } from 'react';
import { CheckCircle2, Circle, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SessionPlanEntry } from '@lody/shared';

import { CarbonInProgress } from '@/components/icons/carbon-in-progress';
import { cn } from '@/lib/utils';
import { Collapsible } from '@lody/ui/collapsible';

type SessionPlanBarProps = {
  entries?: SessionPlanEntry[] | null;
  defaultOpen?: boolean;
  /** Controlled open state (overrides defaultOpen). */
  open?: boolean;
  /** Callback when the user toggles open/closed (controlled mode). */
  onOpenChange?: (open: boolean) => void;
  className?: string;
};

type PlanStatus = SessionPlanEntry['status'];

const emptyEntries: SessionPlanEntry[] = [];

const PlanStatusIcon = ({ status, className }: { status: PlanStatus; className?: string }) => {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className={cn('h-4 w-4 text-status-success', className)} />;
    case 'in_progress':
      return <CarbonInProgress className={cn('h-4 w-4 text-primary', className)} />;
    case 'pending':
    default:
      return <Circle className={cn('h-4 w-4 text-muted-foreground', className)} />;
  }
};

const pickSummaryEntry = (entries: SessionPlanEntry[]): SessionPlanEntry | null => {
  if (!entries.length) return null;
  return (
    entries.find((entry) => entry.status === 'in_progress') ??
    entries.find((entry) => entry.status === 'pending') ??
    entries[entries.length - 1] ??
    null
  );
};

export const SessionPlanBar = ({
  entries,
  defaultOpen = false,
  open,
  onOpenChange,
  className,
}: SessionPlanBarProps) => {
  const { t } = useTranslation();
  const safeEntries = entries ?? emptyEntries;

  const summary = useMemo(() => pickSummaryEntry(safeEntries), [safeEntries]);
  const completedCount = useMemo(
    () => safeEntries.filter((entry) => entry.status === 'completed').length,
    [safeEntries]
  );
  const totalCount = safeEntries.length;

  const statusLabel = summary
    ? t(`codexMessage.plan.status.${summary.status}` as const)
    : t('codexMessage.plan.empty', 'Plan cleared');
  const summaryText = summary ? summary.content : t('codexMessage.plan.empty', 'Plan cleared');

  return (
    <Collapsible.Root defaultOpen={defaultOpen} open={open} onOpenChange={onOpenChange}>
      <div className={cn('rounded-lg border bg-muted/30 px-3 py-2', className)}>
        <Collapsible.Trigger
          render={
            <button
              type="button"
              className={cn(
                'group flex w-full items-center justify-between gap-3 text-left',
                'focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
              )}
            />
          }
        >
          <div className="flex min-w-0 items-center gap-2">
            <PlanStatusIcon status={summary?.status ?? 'pending'} />
            <span className="min-w-0 truncate text-sm font-medium">
              {statusLabel}: {summaryText}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {completedCount}/{totalCount}
            </span>
            <ChevronRight className="h-4 w-4 transition-transform group-data-[panel-open]:rotate-90" />
          </div>
        </Collapsible.Trigger>
        <Collapsible.Panel className="mt-2">
          {/* The rule and the space above the list ride on a child: the panel's
              own height is what the reveal animates, and Base UI measures it
              with `scrollHeight`, which counts padding. */}
          <ul className="space-y-1 border-t border-border/60 pt-2">
            {safeEntries.map((entry, index) => (
              <li
                key={`${index}-${entry.content}`}
                className="flex items-start gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted"
              >
                <PlanStatusIcon status={entry.status} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <span className="break-words leading-snug">{entry.content}</span>
                </div>
              </li>
            ))}
          </ul>
        </Collapsible.Panel>
      </div>
    </Collapsible.Root>
  );
};

export default SessionPlanBar;
