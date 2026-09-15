import {
  evaluateAutoMerge,
  hasDisputedFinding,
  isBlockingFinding,
  type AutoMergeBlocker,
  type ReviewBlockedReason,
  type ReviewBudget,
  type ReviewFinding,
  type ReviewRunMode,
  type ReviewRunState,
  type SessionPullRequestStateMeta,
} from '@lody/shared';

/**
 * Pure policy for auto review and merge.
 *
 * Every gate that can spend tokens, write to GitHub, or merge lives here so it
 * can be tested without a daemon, a repository, or an agent — the same split
 * `task-automation-plan.ts` uses.
 *
 * The states are all "waiting for" states, which is what makes a pass safely
 * repeatable: re-running the planner against unchanged facts returns `wait`
 * rather than dispatching the same prompt twice.
 */

export type ReviewPlanFacts = {
  state: ReviewRunState;
  /**
   * How long the run has sat in its current state.
   *
   * Derived from the run's `updatedAt`, which only moves on a transition — a
   * waiting state performs no writes — so this is time-in-state. It is a fact
   * rather than a clock read so the planner stays pure and testable.
   */
  stateAgeMs: number;
  /** `review_only` reports and stops; it never opens a PR or merges. */
  mode: ReviewRunMode;
  /** Completed review rounds. */
  round: number;
  ciFixUsed: number;
  conflictUsed: number;
  budget: ReviewBudget;
  findings: readonly ReviewFinding[];
  /** Set once the reviewer approved; used to notice later pushes. */
  approvedSha?: string;
  headSha?: string;

  /** A reviewer submission landed for the round currently being awaited. */
  submissionForCurrentRound: boolean;
  /** The reviewer's verdict from that submission. */
  verdict?: 'approve' | 'request_changes';

  prUrl?: string;
  prStatus?: 'open' | 'closed' | 'merged' | 'draft';
  prState?: SessionPullRequestStateMeta | null;

  /** A turn is currently executing in the authoring session. */
  authorBusy: boolean;
  /** A turn is currently executing in the reviewer session. */
  reviewerBusy: boolean;
  /** The reviewer child session has been created. False on a brand new run. */
  reviewerSessionExists: boolean;
  /** The reviewer's agent is resolvable on this machine. */
  reviewerAvailable: boolean;

  /**
   * A human wrote into the authoring session after the run started. Pausing on
   * this is deliberate: an agent quietly continuing to drive a conversation the
   * user just took over is the behavior that makes people turn automation off.
   */
  humanIntervened: boolean;
  /** Unresolved human review threads on the PR, excluding Lody's own comment. */
  humanReviewPending: boolean;
  /** Changed paths that match the policy's protected list. */
  touchedProtectedPaths: readonly string[];
  /** A human has confirmed a merge in this workspace before. */
  mergeConfirmedOnce: boolean;
  /** A human authorized this specific run's merge from the confirmation prompt. */
  mergeConfirmedForRun: boolean;
  /**
   * The engine watched this exact head show no CI rollup for a full grace
   * window, proving the repository has no CI rather than CI that has not
   * registered yet.
   */
  noCiConfirmed: boolean;
};

export type ReviewAction =
  | { kind: 'wait' }
  | { kind: 'start_review'; round: number }
  | { kind: 'recheck'; round: number; openFindings: ReviewFinding[] }
  /** Cheap spot check after a CI fix; deliberately does not consume a review round. */
  | { kind: 'recheck_ci_fix' }
  /** A review-only run has reported; there is nothing further to do. */
  | { kind: 'finish_review' }
  /** A merge that already landed (observed after a crash mid-merge). */
  | { kind: 'finish_merged' }
  | { kind: 'ask_author_to_fix'; findings: ReviewFinding[] }
  | { kind: 'ask_author_to_create_pr' }
  | { kind: 'ask_author_to_fix_ci' }
  | { kind: 'ask_author_to_resolve_conflict' }
  | { kind: 'request_merge_confirmation'; blockers: AutoMergeBlocker[]; ciAbsent: boolean }
  | { kind: 'merge' }
  | { kind: 'pause' }
  | { kind: 'block'; reason: ReviewBlockedReason; summary: string };

const openBlockingFindings = (findings: readonly ReviewFinding[]): ReviewFinding[] =>
  findings.filter(isBlockingFinding);

/** PR association arrives out-of-band, so a turn ending without one is not yet an error. */
const PR_ASSOCIATION_GRACE_MS = 3 * 60_000;

/** How long a `merging` state is assumed to be a merge genuinely in flight. */
const MERGE_IN_FLIGHT_GRACE_MS = 2 * 60_000;

const isTerminalPlanState = (state: ReviewRunState): boolean =>
  state === 'merged' || state === 'reviewed' || state === 'blocked';

/**
 * Blockers a human has to clear. Everything else is either transient (CI still
 * running) or something the loop can act on itself.
 */
const isHumanOnlyBlocker = (blocker: AutoMergeBlocker): boolean =>
  blocker === 'protected_path' || blocker === 'human_review_pending' || blocker === 'disputed';

const describeBlockers = (blockers: readonly AutoMergeBlocker[]): string => blockers.join(', ');

export const planReviewStep = (facts: ReviewPlanFacts): ReviewAction => {
  // A human taking the wheel outranks every other consideration, including a
  // run that is one step from merging.
  if (facts.humanIntervened && facts.state !== 'paused') {
    return { kind: 'pause' };
  }
  // Paused runs wait for an explicit resume, which clears `humanIntervened` by
  // re-seeding the engine's turn marker. Nothing here can un-pause on its own:
  // the user took the wheel, so the user hands it back.
  if (facts.state === 'paused' || isTerminalPlanState(facts.state)) {
    return { kind: 'wait' };
  }
  // `merging` is the one state written before an external side effect, so a
  // crash between the write and its outcome would otherwise park the run
  // forever — the module's own "every gated state needs a reachable exit" rule.
  if (facts.state === 'merging') {
    if (facts.prStatus === 'merged') {
      return { kind: 'finish_merged' };
    }
    if (facts.stateAgeMs < MERGE_IN_FLIGHT_GRACE_MS) {
      // Almost always a merge genuinely in flight in this process.
      return { kind: 'wait' };
    }
    if (facts.authorBusy || facts.reviewerBusy) {
      return { kind: 'wait' };
    }
    // Stale: nobody is completing it, so re-evaluate from the gate.
    return planMergePath(facts);
  }
  // The confirmation prompt's ONLY exit. Waiting unconditionally here left every
  // run parked forever, because the policy flag that would satisfy the gate is
  // written by the merge it gates.
  if (facts.state === 'awaiting_merge_confirmation') {
    if (!facts.mergeConfirmedForRun) {
      return { kind: 'wait' };
    }
    if (facts.authorBusy || facts.reviewerBusy) {
      return { kind: 'wait' };
    }
    return planMergePath(facts);
  }
  // Never write into a session mid-turn: the prompt would queue behind whatever
  // is running and arrive with the wrong context.
  if (facts.authorBusy || facts.reviewerBusy) {
    return { kind: 'wait' };
  }

  if (hasDisputedFinding(facts.findings)) {
    return {
      kind: 'block',
      reason: 'disputed',
      summary:
        'The reviewer and the author disagree about a finding. Two agents arguing will not converge, so this needs your call.',
    };
  }

  switch (facts.state) {
    case 'reviewing':
      return planAfterReview(facts);
    case 'fixing':
      // The author's turn ended (checked above), so the fixes are in.
      return planRecheck(facts);
    case 'creating_pr':
      if (facts.prUrl) {
        return planMergePath(facts);
      }
      // PR association is not synchronous with the turn ending: it arrives via
      // the webhook fan-out or the poller's discovery lane. This pass runs ON
      // the turn-end metadata event, so an agent that opened a PR moments before
      // finishing would lose that race and the run would die with a false error.
      if (facts.stateAgeMs < PR_ASSOCIATION_GRACE_MS) {
        return { kind: 'wait' };
      }
      return {
        kind: 'block',
        reason: 'error',
        summary:
          'The author session finished without opening a pull request. Open one yourself, or turn the checkbox off and back on to retry.',
      };
    case 'waiting_ci':
      return planMergePath(facts);
    case 'fixing_ci':
      // A CI fix is usually small, so it gets a spot check rather than a full
      // review round — otherwise flaky CI alone can exhaust the review budget.
      return { kind: 'recheck_ci_fix' };
    case 'resolving_conflict':
      return planMergePath(facts);
    default:
      return { kind: 'wait' };
  }
};

const planAfterReview = (facts: ReviewPlanFacts): ReviewAction => {
  // A run starts in `reviewing` with no reviewer yet: authorizing it is a UI
  // action, and creating the child session is this engine's first job.
  if (!facts.reviewerSessionExists) {
    if (!facts.reviewerAvailable) {
      return {
        kind: 'block',
        reason: 'reviewer_unavailable',
        summary:
          'The review agent is not available on this machine. Pick a different reviewer in settings, or run the branch on a machine that has it.',
      };
    }
    return { kind: 'start_review', round: facts.round };
  }

  if (!facts.submissionForCurrentRound) {
    if (!facts.reviewerAvailable) {
      return {
        kind: 'block',
        reason: 'reviewer_unavailable',
        summary:
          'The review agent is not available on this machine. Pick a different reviewer in settings, or run the branch on a machine that has it.',
      };
    }
    // Not busy and nothing submitted: the reviewer's turn ended without calling
    // the tool. Re-asking would usually just repeat the failure.
    return {
      kind: 'block',
      reason: 'error',
      summary:
        'The review agent finished its turn without submitting a review. Its session has the details.',
    };
  }

  // A review-only run's job ends the moment it has reported. It never opens a
  // pull request and never merges, whatever the verdict was.
  if (facts.mode === 'review_only') {
    return { kind: 'finish_review' };
  }

  const blocking = openBlockingFindings(facts.findings);
  if (facts.verdict === 'approve' && blocking.length === 0) {
    if (!facts.prUrl) {
      return { kind: 'ask_author_to_create_pr' };
    }
    return planMergePath(facts);
  }

  if (facts.round >= facts.budget.reviewRounds) {
    return {
      kind: 'block',
      reason: 'budget_exhausted',
      summary: `The review budget of ${facts.budget.reviewRounds} rounds ran out with ${blocking.length} blocking finding(s) still open. The findings list has what is left.`,
    };
  }

  return { kind: 'ask_author_to_fix', findings: blocking };
};

const planRecheck = (facts: ReviewPlanFacts): ReviewAction => {
  const open = facts.findings.filter(
    (finding) => finding.resolution === 'open' || finding.resolution === 'unresolved'
  );
  return { kind: 'recheck', round: facts.round + 1, openFindings: open };
};

/**
 * Everything from "the reviewer is happy" to the merge itself.
 *
 * CI state is read from the reconciler-maintained codes rather than polled here:
 * `s` is the CI rollup and `m` the merge state, and both are already durable.
 */
const planMergePath = (facts: ReviewPlanFacts): ReviewAction => {
  if (!facts.prUrl) {
    return { kind: 'ask_author_to_create_pr' };
  }

  // A push after approval invalidates the approval. The cheap spot check is
  // enough here: a full round would let ordinary CI churn drain the budget.
  if (facts.approvedSha && facts.headSha && facts.approvedSha !== facts.headSha) {
    return { kind: 'recheck_ci_fix' };
  }

  const mergeState = facts.prState?.m;
  const ciState = facts.prState?.s;

  if (mergeState === 'd') {
    if (facts.conflictUsed >= facts.budget.conflictAttempts) {
      return {
        kind: 'block',
        reason: 'budget_exhausted',
        summary: `The branch still conflicts with its base after ${facts.budget.conflictAttempts} attempt(s). Resolve it yourself and re-enable the checkbox.`,
      };
    }
    return { kind: 'ask_author_to_resolve_conflict' };
  }

  if (ciState === 'f' || ciState === 'e') {
    if (facts.ciFixUsed >= facts.budget.ciFixAttempts) {
      return {
        kind: 'block',
        reason: 'budget_exhausted',
        summary: `CI is still failing after ${facts.budget.ciFixAttempts} fix attempt(s). The failing checks are on the pull request.`,
      };
    }
    return { kind: 'ask_author_to_fix_ci' };
  }

  // The exemption applies only while the rollup is genuinely absent: if checks
  // appeared after all (pending, failing), the normal CI path owns them.
  const ciAbsent = facts.noCiConfirmed && facts.prState?.s === undefined;

  const blockers = evaluateAutoMerge({
    prState: facts.prState,
    prStatus: facts.prStatus,
    findings: facts.findings,
    humanReviewPending: facts.humanReviewPending,
    touchedProtectedPaths: facts.touchedProtectedPaths,
    confirmationSatisfied: facts.mergeConfirmedOnce || facts.mergeConfirmedForRun,
    ciAbsentConfirmed: ciAbsent,
  });

  if (blockers.length === 0) {
    return { kind: 'merge' };
  }

  const humanBlockers = blockers.filter(isHumanOnlyBlocker);
  if (humanBlockers.includes('protected_path')) {
    return {
      kind: 'block',
      reason: 'protected_path',
      summary: `This branch changes protected paths (${facts.touchedProtectedPaths.join(', ')}), so it will not be merged automatically. Merge it yourself after checking those changes.`,
    };
  }
  if (humanBlockers.includes('human_review_pending')) {
    return {
      kind: 'block',
      reason: 'human_review_pending',
      summary:
        'There are unresolved review comments from a person on this pull request. Automatic merge stays off until they are resolved.',
    };
  }

  // Only the confirmation gate is left: everything substantive already passed.
  if (blockers.every((blocker) => blocker === 'awaiting_confirmation')) {
    return { kind: 'request_merge_confirmation', blockers, ciAbsent };
  }

  // CI still running, the PR is not open yet, or the first-merge confirmation
  // is pending behind them — all resolve on their own.
  if (
    blockers.every(
      (blocker) =>
        blocker === 'ci_not_green' ||
        blocker === 'merge_state_not_clean' ||
        blocker === 'no_pr' ||
        blocker === 'awaiting_confirmation'
    )
  ) {
    return { kind: 'wait' };
  }

  return {
    kind: 'block',
    reason: 'error',
    summary: `Cannot merge automatically: ${describeBlockers(blockers)}.`,
  };
};

/** State the engine records after performing an action. */
export const nextStateForAction = (action: ReviewAction): ReviewRunState | null => {
  switch (action.kind) {
    case 'start_review':
    case 'recheck':
    case 'recheck_ci_fix':
      return 'reviewing';
    case 'finish_review':
      return 'reviewed';
    case 'finish_merged':
      return 'merged';
    case 'ask_author_to_fix':
      return 'fixing';
    case 'ask_author_to_create_pr':
      return 'creating_pr';
    case 'ask_author_to_fix_ci':
      return 'fixing_ci';
    case 'ask_author_to_resolve_conflict':
      return 'resolving_conflict';
    case 'request_merge_confirmation':
      return 'awaiting_merge_confirmation';
    case 'merge':
      return 'merging';
    case 'pause':
      return 'paused';
    case 'block':
      return 'blocked';
    case 'wait':
      return null;
  }
  // Unreachable while ReviewAction stays a closed union; satisfies
  // consistent-return without weakening the switch's exhaustiveness check.
  return null;
};
