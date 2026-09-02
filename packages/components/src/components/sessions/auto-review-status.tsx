import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  isBlockingFinding,
  type ReviewFinding,
  type ReviewRun,
  type ReviewRunState,
} from '@lody/shared';
import { Button } from '@lody/ui/button';
import { cn } from '@/lib/utils';

/**
 * Always-visible state for a session under auto review.
 *
 * It is deliberately not tucked into the "…" menu with the checkbox. Someone who
 * ticked the box days ago has forgotten, and discovering the automation only
 * when a pull request merges itself is the single worst outcome for trust — so
 * an active run states itself, and its off switch is one click from that
 * statement.
 */

export type AutoReviewStatusProps = {
  run: ReviewRun;
  maxRounds: number;
  onDisable: () => void;
  /** Grants this run's merge; the only exit from the confirmation prompt. */
  onConfirmMerge?: () => void;
  /** Hands control back after the run paused on a human message. */
  onResume?: () => void;
  onFixFinding?: (finding: ReviewFinding) => void;
};

const STATE_LABELS: Record<ReviewRunState, string> = {
  reviewing: 'Reviewing the branch',
  fixing: 'Waiting for fixes',
  creating_pr: 'Opening a pull request',
  waiting_ci: 'Waiting for CI',
  fixing_ci: 'Fixing CI',
  resolving_conflict: 'Resolving conflicts',
  awaiting_merge_confirmation: 'Ready to merge — needs your confirmation',
  merging: 'Merging',
  merged: 'Merged',
  reviewed: 'Review finished',
  paused: 'Paused — you sent a message',
  blocked: 'Stopped',
};

const isBusyState = (state: ReviewRunState): boolean =>
  state === 'reviewing' ||
  state === 'fixing' ||
  state === 'creating_pr' ||
  state === 'waiting_ci' ||
  state === 'fixing_ci' ||
  state === 'resolving_conflict' ||
  state === 'merging';

export function AutoReviewStatus({
  run,
  maxRounds,
  onDisable,
  onConfirmMerge,
  onResume,
  onFixFinding,
}: AutoReviewStatusProps) {
  const { t } = useTranslation();
  const blocking = run.findings.filter(isBlockingFinding);
  const suggestions = run.findings.filter((finding) => finding.severity === 'suggestion');
  const busy = isBusyState(run.state);

  // Fixing by hand sends a message into the session, which the engine correctly
  // reads as a human taking over and pauses on. Offering it while the run is
  // driving would mean the banner's own button halts the automation it fronts,
  // so it appears only once the run is no longer driving — which is also the
  // only time it is useful, since otherwise the engine is handling the fixes.
  const canFixManually =
    run.state === 'reviewed' || run.state === 'blocked' || run.state === 'paused';

  return (
    <div
      className={cn(
        'rounded-lg border bg-card/60 px-3 py-2 text-xs',
        run.state === 'blocked' ? 'border-destructive/40' : 'border-border/70'
      )}
    >
      <div className="flex items-center gap-2">
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : run.state === 'merged' || (run.state === 'reviewed' && blocking.length === 0) ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        )}

        <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">
          {t(`sessions.autoReview.state.${run.state}`, STATE_LABELS[run.state])}
        </span>

        {run.state === 'reviewing' || run.state === 'fixing' ? (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {t('sessions.autoReview.round', {
              defaultValue: 'Round {{round}}/{{max}}',
              round: run.round,
              max: maxRounds,
            })}
          </span>
        ) : null}

        <Button
          variant="ghost"
          size="mini"
          icon
          className="shrink-0"
          onClick={onDisable}
          aria-label={t('sessions.autoReview.turnOff', 'Turn off auto review')}
          title={t('sessions.autoReview.turnOff', 'Turn off auto review')}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {run.blocked ? <p className="mt-1.5 text-muted-foreground">{run.blocked.summary}</p> : null}

      {/* The confirmation prompt has exactly one exit, and this is it. Without
          the button the run waits forever: the workspace-level flag that would
          satisfy the gate is only ever written by the merge it gates. */}
      {run.state === 'awaiting_merge_confirmation' && onConfirmMerge ? (
        <div className="mt-2 flex items-center gap-2">
          <Button size="small" onClick={onConfirmMerge}>
            {t('sessions.autoReview.confirmMerge', 'Merge now')}
          </Button>
          <span className="text-muted-foreground">
            {t(
              'sessions.autoReview.confirmMergeHelper',
              'First automatic merge in this workspace.'
            )}
          </span>
        </div>
      ) : null}

      {run.state === 'paused' && onResume ? (
        <div className="mt-2 flex items-center gap-2">
          <Button variant="secondary" size="small" onClick={onResume}>
            {t('sessions.autoReview.resume', 'Resume')}
          </Button>
          <span className="text-muted-foreground">
            {t('sessions.autoReview.resumeHelper', 'Picks up where it stopped.')}
          </span>
        </div>
      ) : null}

      {blocking.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {blocking.map((finding) => (
            <li key={finding.id} className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-foreground/90">{finding.title}</div>
                <div className="truncate text-[0.7rem] text-muted-foreground">
                  {finding.file}
                  {finding.line ? `:${finding.line}` : ''}
                </div>
              </div>
              {onFixFinding && canFixManually ? (
                <Button
                  variant="ghost"
                  size="small"
                  className="shrink-0"
                  onClick={() => onFixFinding(finding)}
                >
                  {t('sessions.autoReview.fixThis', 'Fix this')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {suggestions.length > 0 ? (
        <p className="mt-1.5 text-muted-foreground">
          {t('sessions.autoReview.suggestions', {
            defaultValue: '{{count}} non-blocking suggestion(s).',
            count: suggestions.length,
          })}
        </p>
      ) : null}
    </div>
  );
}
