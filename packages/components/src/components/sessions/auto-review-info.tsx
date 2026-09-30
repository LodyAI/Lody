import { useTranslation } from 'react-i18next';
import type { ReviewBudget } from '@lody/shared';
import { Dialog } from '@/ui/dialog';
import { Button } from '@lody/ui/button';

/**
 * The contract the user reads once.
 *
 * One piece of content serves three surfaces — the info popover, the
 * confirmation shown when the checkbox is ticked, and the step list the status
 * banner ticks through — so the mental model is built once and then recognized,
 * rather than learned separately in each place.
 */
export type AutoReviewContractProps = {
  budget: ReviewBudget;
};

export function AutoReviewContract({ budget }: AutoReviewContractProps) {
  const { t } = useTranslation();

  const steps = [
    t(
      'sessions.autoReview.step.review',
      'Review — a review agent reads the whole branch against REVIEW.md from the base branch.'
    ),
    t(
      'sessions.autoReview.step.fix',
      'Fix — findings come back to this session, and the reviewer re-checks them.'
    ),
    t('sessions.autoReview.step.pr', 'Pull request — opened by this session once nothing blocks.'),
    t('sessions.autoReview.step.ci', 'CI — failures and conflicts come back here to fix.'),
    t(
      'sessions.autoReview.step.merge',
      'Merge — once CI is green and nothing is unresolved, the pull request is merged.'
    ),
  ];

  const guarantees = [
    t(
      'sessions.autoReview.never.humanReview',
      'Never merges while a person has unresolved review comments.'
    ),
    t('sessions.autoReview.never.forcePush', 'Never force-pushes.'),
    t(
      'sessions.autoReview.never.protected',
      'Never merges a branch that changes REVIEW.md, .github/, or your other protected paths.'
    ),
    t('sessions.autoReview.never.pause', 'Pauses the moment you send a message in this session.'),
  ];

  return (
    <div className="space-y-3 text-xs">
      <ol className="space-y-1.5">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-2">
            <span className="shrink-0 text-muted-foreground tabular-nums">{index + 1}.</span>
            <span className="text-foreground/90">{step}</span>
          </li>
        ))}
      </ol>

      <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/30 p-2.5">
        <div className="font-medium text-foreground/90">
          {t('sessions.autoReview.neverTitle', 'What it will not do')}
        </div>
        <ul className="space-y-1 text-muted-foreground">
          {guarantees.map((line) => (
            <li key={line}>· {line}</li>
          ))}
        </ul>
      </div>

      <p className="text-muted-foreground">
        {t('sessions.autoReview.budget', {
          defaultValue:
            'Budget: {{rounds}} review rounds, {{ci}} CI fixes, {{conflict}} conflict attempts. It stops and tells you when any runs out.',
          rounds: budget.reviewRounds,
          ci: budget.ciFixAttempts,
          conflict: budget.conflictAttempts,
        })}
      </p>
    </div>
  );
}

export type AutoReviewConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  budget: ReviewBudget;
  onConfirm: () => void;
};

/**
 * Shown when the checkbox is ticked.
 *
 * Automatic merge is not reversible, so the moment of consent is the moment to
 * state plainly what will happen — not a tooltip the user may never open.
 */
export function AutoReviewConfirmDialog({
  open,
  onOpenChange,
  budget,
  onConfirm,
}: AutoReviewConfirmDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="max-w-md">
        <Dialog.Header>
          <Dialog.Title>
            {t('sessions.autoReview.confirmTitle', 'Auto review and merge')}
          </Dialog.Title>
          <Dialog.Description>
            {t(
              'sessions.autoReview.confirmDescription',
              'Lody will take this branch to the end, including merging it.'
            )}
          </Dialog.Description>
        </Dialog.Header>

        <AutoReviewContract budget={budget} />

        <Dialog.Footer>
          <Button variant="secondary" size="small" onClick={() => onOpenChange(false)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="small"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {t('sessions.autoReview.confirmAction', 'Turn on')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

export type ReviewAgentSetupDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machineName?: string;
  onOpenSettings: () => void;
};

/** Guides a review action to the exact prerequisite instead of failing later. */
export function ReviewAgentSetupDialog({
  open,
  onOpenChange,
  machineName,
  onOpenSettings,
}: ReviewAgentSetupDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="max-w-sm">
        <Dialog.Header>
          <Dialog.Title>
            {t('sessions.autoReview.setupTitle', 'Configure a review agent')}
          </Dialog.Title>
          <Dialog.Description>
            {t('sessions.autoReview.setupDescription', {
              defaultValue:
                'Choose an agent, model, reasoning, and mode for {{machine}} before sessions on it can start a review.',
              machine: machineName ?? t('sessions.autoReview.thisMachine', 'this machine'),
            })}
          </Dialog.Description>
        </Dialog.Header>
        <Dialog.Footer>
          <Button variant="secondary" size="small" onClick={() => onOpenChange(false)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="small"
            onClick={() => {
              onOpenChange(false);
              onOpenSettings();
            }}
          >
            {t('sessions.autoReview.openSettings', 'Open review settings')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
