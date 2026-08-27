import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_BUDGET,
  type ReviewFinding,
  type SessionPullRequestStateMeta,
} from '@lody/shared';
import { planReviewStep, type ReviewPlanFacts } from './review-automation-plan';

const finding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: 'f1',
  file: 'src/a.ts',
  severity: 'blocking',
  title: 'Off-by-one in the retry loop',
  detail: 'The loop retries one time too many.',
  failureScenario: 'With maxRetries=1 the request is sent twice.',
  resolution: 'open',
  raisedInRound: 1,
  ...overrides,
});

const facts = (overrides: Partial<ReviewPlanFacts> = {}): ReviewPlanFacts => ({
  state: 'waiting_ci',
  stateAgeMs: 0,
  mode: 'review_and_merge',
  round: 1,
  ciFixUsed: 0,
  conflictUsed: 0,
  budget: DEFAULT_REVIEW_BUDGET,
  findings: [],
  submissionForCurrentRound: false,
  authorBusy: false,
  reviewerBusy: false,
  reviewerSessionExists: true,
  reviewerAvailable: true,
  humanIntervened: false,
  humanReviewPending: false,
  touchedProtectedPaths: [],
  mergeConfirmedOnce: true,
  mergeConfirmedForRun: false,
  noCiConfirmed: false,
  prUrl: 'https://github.com/o/r/pull/1',
  prStatus: 'open',
  prState: { s: 's', m: 'c', t: 0 } satisfies SessionPullRequestStateMeta,
  ...overrides,
});

describe('planReviewStep', () => {
  it('merges when CI is green, the branch is clean, and nothing blocks', () => {
    expect(planReviewStep(facts())).toEqual({ kind: 'merge' });
  });

  it('does NOT merge when CI has not reported yet', () => {
    // The absent-CI window is real: right after a push no check suite has
    // registered, and the shared readiness helper treats that as ready. Auto
    // merge must not, or it merges before CI ever runs.
    const action = planReviewStep(facts({ prState: { m: 'c', t: 0 } }));
    expect(action).toEqual({ kind: 'wait' });
  });

  describe('repositories without CI', () => {
    it('merges once the engine has confirmed the absence over a grace window', () => {
      const action = planReviewStep(facts({ prState: { m: 'c', t: 0 }, noCiConfirmed: true }));
      expect(action).toEqual({ kind: 'merge' });
    });

    it('asks for the first-merge confirmation with a no-CI wording flag', () => {
      const action = planReviewStep(
        facts({ prState: { m: 'c', t: 0 }, noCiConfirmed: true, mergeConfirmedOnce: false })
      );
      expect(action).toMatchObject({ kind: 'request_merge_confirmation', ciAbsent: true });
    });

    it('does not let the absence flag waive CI that actually reported', () => {
      // Checks appeared after all: the exemption only covers a genuinely
      // absent rollup, never a pending or failing one.
      const action = planReviewStep(
        facts({ prState: { s: 'p', m: 'c', t: 0 }, noCiConfirmed: true })
      );
      expect(action).toEqual({ kind: 'wait' });
    });
  });

  it('waits while CI is pending and the first-merge confirmation is still owed', () => {
    // Both blockers resolve on their own (CI completes, then the confirmation
    // is requested); reporting this combination as an error parked every
    // first merge whose CI was slower than its review.
    const action = planReviewStep(
      facts({ prState: { s: 'p', m: 'c', t: 0 }, mergeConfirmedOnce: false })
    );
    expect(action).toEqual({ kind: 'wait' });
  });

  it('waits while CI is still running', () => {
    expect(planReviewStep(facts({ prState: { s: 'p', m: 'c', t: 0 } }))).toEqual({ kind: 'wait' });
  });

  it('pauses when a human writes into the session, even one step from merging', () => {
    expect(planReviewStep(facts({ humanIntervened: true }))).toEqual({ kind: 'pause' });
  });

  it('waits while a turn is executing rather than queueing behind it', () => {
    expect(planReviewStep(facts({ authorBusy: true }))).toEqual({ kind: 'wait' });
    expect(planReviewStep(facts({ reviewerBusy: true }))).toEqual({ kind: 'wait' });
  });

  it('blocks on a disputed finding instead of looping', () => {
    const action = planReviewStep(
      facts({ findings: [finding({ resolution: 'disputed', resolutionNote: 'intended' })] })
    );
    expect(action).toMatchObject({ kind: 'block', reason: 'disputed' });
  });

  it('asks the author to fix blocking findings while budget remains', () => {
    const open = finding();
    const action = planReviewStep(
      facts({
        state: 'reviewing',
        submissionForCurrentRound: true,
        verdict: 'request_changes',
        findings: [open],
        round: 1,
      })
    );
    expect(action).toEqual({ kind: 'ask_author_to_fix', findings: [open] });
  });

  it('blocks once the review round budget is spent', () => {
    const action = planReviewStep(
      facts({
        state: 'reviewing',
        submissionForCurrentRound: true,
        verdict: 'request_changes',
        findings: [finding()],
        round: DEFAULT_REVIEW_BUDGET.reviewRounds,
      })
    );
    expect(action).toMatchObject({ kind: 'block', reason: 'budget_exhausted' });
  });

  it('asks the author to open a PR once the review passes and none exists', () => {
    const action = planReviewStep(
      facts({
        state: 'reviewing',
        submissionForCurrentRound: true,
        verdict: 'approve',
        prUrl: undefined,
        prStatus: undefined,
        prState: null,
      })
    );
    expect(action).toEqual({ kind: 'ask_author_to_create_pr' });
  });

  it('does not treat resolved findings as blocking', () => {
    const action = planReviewStep(
      facts({
        state: 'reviewing',
        submissionForCurrentRound: true,
        verdict: 'approve',
        findings: [finding({ resolution: 'resolved' })],
      })
    );
    expect(action).toEqual({ kind: 'merge' });
  });

  it('asks for a CI fix while attempts remain and blocks after', () => {
    const failing = facts({ prState: { s: 'f', m: 'c', t: 0 } });
    expect(planReviewStep(failing)).toEqual({ kind: 'ask_author_to_fix_ci' });
    expect(
      planReviewStep({ ...failing, ciFixUsed: DEFAULT_REVIEW_BUDGET.ciFixAttempts })
    ).toMatchObject({ kind: 'block', reason: 'budget_exhausted' });
  });

  it('asks for conflict resolution while attempts remain and blocks after', () => {
    const dirty = facts({ prState: { s: 's', m: 'd', t: 0 } });
    expect(planReviewStep(dirty)).toEqual({ kind: 'ask_author_to_resolve_conflict' });
    expect(
      planReviewStep({ ...dirty, conflictUsed: DEFAULT_REVIEW_BUDGET.conflictAttempts })
    ).toMatchObject({ kind: 'block', reason: 'budget_exhausted' });
  });

  it('refuses to merge a branch touching protected paths', () => {
    const action = planReviewStep(facts({ touchedProtectedPaths: ['REVIEW.md'] }));
    expect(action).toMatchObject({ kind: 'block', reason: 'protected_path' });
  });

  it('refuses to merge while a person has unresolved review comments', () => {
    const action = planReviewStep(facts({ humanReviewPending: true }));
    expect(action).toMatchObject({ kind: 'block', reason: 'human_review_pending' });
  });

  it('asks for confirmation before the first automatic merge in a workspace', () => {
    const action = planReviewStep(facts({ mergeConfirmedOnce: false }));
    expect(action).toMatchObject({ kind: 'request_merge_confirmation' });
  });

  describe('merge confirmation', () => {
    // The confirmation state used to have no exit at all: the workspace flag
    // that satisfies the gate is only written by the merge it gates, so every
    // run parked here forever. The per-run grant is the way out.
    it('still waits while parked and ungranted', () => {
      expect(
        planReviewStep(
          facts({
            state: 'awaiting_merge_confirmation',
            mergeConfirmedOnce: false,
            mergeConfirmedForRun: false,
          })
        )
      ).toEqual({ kind: 'wait' });
    });

    it('merges once a human grants this run', () => {
      expect(
        planReviewStep(
          facts({
            state: 'awaiting_merge_confirmation',
            mergeConfirmedOnce: false,
            mergeConfirmedForRun: true,
          })
        )
      ).toEqual({ kind: 'merge' });
    });

    it('does not let the grant bypass any other gate', () => {
      const action = planReviewStep(
        facts({
          state: 'awaiting_merge_confirmation',
          mergeConfirmedOnce: false,
          mergeConfirmedForRun: true,
          humanReviewPending: true,
        })
      );
      expect(action).toMatchObject({ kind: 'block', reason: 'human_review_pending' });
    });

    it('still refuses a granted run whose CI has not reported', () => {
      expect(
        planReviewStep(
          facts({
            state: 'awaiting_merge_confirmation',
            mergeConfirmedForRun: true,
            prState: { m: 'c', t: 0 },
          })
        )
      ).toEqual({ kind: 'wait' });
    });
  });

  describe('states that could park forever', () => {
    it('waits out the PR association race instead of failing the run', () => {
      // Association arrives via webhook or the poller's discovery lane, while
      // this pass runs on the turn-end event — an agent that opened a PR just
      // before finishing would otherwise lose the race and die with a false
      // "finished without opening a pull request".
      const justFinished = facts({
        state: 'creating_pr',
        prUrl: undefined,
        prStatus: undefined,
        prState: null,
        stateAgeMs: 5_000,
      });
      expect(planReviewStep(justFinished)).toEqual({ kind: 'wait' });
      expect(planReviewStep({ ...justFinished, stateAgeMs: 10 * 60_000 })).toMatchObject({
        kind: 'block',
      });
    });

    it('finishes a merge that landed while the run was interrupted', () => {
      const action = planReviewStep(
        facts({ state: 'merging', prStatus: 'merged', stateAgeMs: 10 * 60_000 })
      );
      expect(action).toEqual({ kind: 'finish_merged' });
    });

    it('re-evaluates a stale merging state rather than parking', () => {
      // A crash between writing `merging` and its outcome must not strand the run.
      const action = planReviewStep(facts({ state: 'merging', stateAgeMs: 10 * 60_000 }));
      expect(action).toEqual({ kind: 'merge' });
    });

    it('still waits while a merge is plausibly in flight', () => {
      expect(planReviewStep(facts({ state: 'merging', stateAgeMs: 1_000 }))).toEqual({
        kind: 'wait',
      });
    });
  });

  it('spot-checks a push that landed after approval instead of spending a round', () => {
    const action = planReviewStep(facts({ approvedSha: 'aaa', headSha: 'bbb' }));
    expect(action).toEqual({ kind: 'recheck_ci_fix' });
  });

  it('merges when the head still matches what was approved', () => {
    expect(planReviewStep(facts({ approvedSha: 'aaa', headSha: 'aaa' }))).toEqual({
      kind: 'merge',
    });
  });

  it('cannot notice a post-approval push when no approval was ever pinned', () => {
    // Guards the approve-then-open-PR order: the approval happens before a PR
    // exists, so if the engine never records a head afterwards this check is
    // silently dead and any later push merges unreviewed. The engine's stamping
    // rule is what keeps `approvedSha` set here — see `approvalPatch`.
    expect(planReviewStep(facts({ approvedSha: undefined, headSha: 'bbb' }))).toEqual({
      kind: 'merge',
    });
  });

  it('re-checks with the reviewer once the author finishes fixing', () => {
    const open = finding({ resolution: 'unresolved' });
    const action = planReviewStep(facts({ state: 'fixing', findings: [open], round: 1 }));
    expect(action).toEqual({ kind: 'recheck', round: 2, openFindings: [open] });
  });

  describe('review-only runs', () => {
    const reviewOnly = (overrides: Partial<ReviewPlanFacts> = {}) =>
      facts({
        mode: 'review_only',
        state: 'reviewing',
        submissionForCurrentRound: true,
        ...overrides,
      });

    it('finishes after reporting instead of opening a pull request', () => {
      const action = planReviewStep(
        reviewOnly({ verdict: 'approve', prUrl: undefined, prStatus: undefined, prState: null })
      );
      expect(action).toEqual({ kind: 'finish_review' });
    });

    it('finishes after reporting rather than asking for fixes', () => {
      // The user asked for an opinion, not for the branch to be driven.
      const action = planReviewStep(
        reviewOnly({ verdict: 'request_changes', findings: [finding()] })
      );
      expect(action).toEqual({ kind: 'finish_review' });
    });

    it('never merges, even with everything green', () => {
      const action = planReviewStep(reviewOnly({ verdict: 'approve' }));
      expect(action).not.toEqual({ kind: 'merge' });
    });

    it('is terminal once finished', () => {
      expect(planReviewStep(facts({ mode: 'review_only', state: 'reviewed' }))).toEqual({
        kind: 'wait',
      });
    });
  });

  it('stays put in terminal and paused states', () => {
    expect(planReviewStep(facts({ state: 'merged' }))).toEqual({ kind: 'wait' });
    expect(planReviewStep(facts({ state: 'blocked' }))).toEqual({ kind: 'wait' });
    expect(planReviewStep(facts({ state: 'paused' }))).toEqual({ kind: 'wait' });
  });

  it('starts the review on a fresh run instead of blocking', () => {
    // A run is authorized by the UI in `reviewing` with no reviewer session yet;
    // creating that session is the engine's first job. Falling through to the
    // "no submission" branch here would have blocked every run on step one.
    const action = planReviewStep(
      facts({ state: 'reviewing', reviewerSessionExists: false, round: 1 })
    );
    expect(action).toEqual({ kind: 'start_review', round: 1 });
  });

  it('blocks a fresh run when no reviewer agent is available on this machine', () => {
    const action = planReviewStep(
      facts({ state: 'reviewing', reviewerSessionExists: false, reviewerAvailable: false })
    );
    expect(action).toMatchObject({ kind: 'block', reason: 'reviewer_unavailable' });
  });

  it('blocks when the reviewer ends its turn without submitting', () => {
    const action = planReviewStep(facts({ state: 'reviewing', submissionForCurrentRound: false }));
    expect(action).toMatchObject({ kind: 'block' });
  });
});
