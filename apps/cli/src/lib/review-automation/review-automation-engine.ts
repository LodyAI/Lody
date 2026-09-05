import {
  buildAuthorFixPrompt,
  buildCiFixRecheckPrompt,
  buildReviewPrompt,
  buildReviewRecheckPrompt,
  CREATE_PR_PROMPT,
  findTouchedProtectedPaths,
  getServerNow,
  isReviewRunTerminal,
  REVIEW_STANDARDS_FALLBACK_FILENAMES,
  REVIEW_STANDARDS_FILENAME,
  type AgentConfigId,
  type ReviewFinding,
  type ReviewerAgentRef,
  type ReviewRun,
  type SessionId,
  type SessionMeta,
  type SessionPullRequestCiState,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';
import type { Logger } from '@/utils/logger';
import {
  advanceReviewRun,
  readReviewRun,
  writeReviewPolicy,
  readReviewPolicy,
} from './review-automation-store';
import { nextStateForAction, planReviewStep, type ReviewAction } from './review-automation-plan';

/**
 * Machine-side driver for auto review and merge.
 *
 * It lives on the machine, not in MCP, for two reasons that are both hard
 * constraints rather than preferences. The orchestration contract caps a chain
 * at `LODY_MAX_CHAIN_DEPTH` (5) hops from the last human input, so a loop that
 * can run a dozen rounds cannot be built out of MCP session calls at all. And
 * that same contract observes only Lody-owned state — GitHub, CI, and webhooks
 * are explicitly outside it, while this loop is mostly a reaction to them.
 *
 * Stepping around the chain-depth guard is what makes the run's own budgets
 * load-bearing: they are the replacement safety mechanism, not a convenience.
 */

export type ReviewSessionFacts = {
  meta: SessionMeta;
  /** A turn is executing, or a dispatch is pending. */
  busy: boolean;
};

export type ReviewAutomationEngineDeps = {
  repo: LoroRepo;
  workspaceId: WorkspaceId;
  logger: Logger;

  readSessionFacts: (sessionId: SessionId) => Promise<ReviewSessionFacts | undefined>;
  /**
   * Creates the reviewer as a child of the authoring session. A child shares its
   * parent's machine and working directory, which is the entire reason the
   * reviewer can see the changes at all — and it starts with a fresh
   * conversation, so the reviewer never inherits the author's reasoning.
   */
  createReviewerSession: (args: {
    parentSessionId: SessionId;
    prompt: string;
    reviewerAgentConfigId?: AgentConfigId;
    reviewerAgentType?: string;
    modeId?: string;
    modelId?: string;
    configOptionValues?: Record<string, string | boolean>;
  }) => Promise<{ sessionId: SessionId }>;
  /** Durable dispatch; returns the user turn id so interruption can be detected. */
  sendChat: (sessionId: SessionId, prompt: string) => Promise<{ userTurnId: string }>;

  /**
   * Changed files and head commit for an open pull request.
   *
   * Read through GitHub rather than by running git in the working copy: the
   * engine would otherwise have to resolve a session's workdir, which lives
   * inside the session manager and may need a live process. Both facts are only
   * consulted once a PR exists, so there is nothing to learn earlier anyway.
   */
  readPullRequestFacts: (
    prUrl: string
  ) => Promise<{ changedPaths: string[]; headSha?: string } | undefined>;
  /** What the branch is meant to achieve. */
  readIntent: (sessionId: SessionId) => Promise<string | undefined>;
  /**
   * The authoring session's latest assistant message.
   *
   * The reviewer is a separate session and cannot see the author's conversation,
   * so without this the author's "I disagree, because…" reaches nobody and a
   * genuine disagreement burns rounds instead of escalating.
   */
  readLastAssistantText: (sessionId: SessionId) => Promise<string | undefined>;
  /** Whether the frozen reviewer can still be resolved on this machine. */
  isReviewerAvailable: (reviewer?: ReviewerAgentRef) => Promise<boolean>;

  /** Unresolved review threads authored by people, excluding Lody's own comment. */
  hasPendingHumanReview: (prUrl: string) => Promise<boolean>;
  postPullRequestComment: (prUrl: string, body: string) => Promise<void>;
  mergePullRequest: (prUrl: string) => Promise<{ merged: boolean; message?: string }>;

  /**
   * Re-runs this session's step after a delay. Needed exactly once: a run
   * waiting out the no-CI grace window gets no document events (an absent CI
   * rollup changes nothing), so the expiry has to be armed explicitly.
   */
  reevaluateLater?: (sessionId: SessionId, delayMs: number) => void;

  /** Surfaces a run that needs a person; also flips the session's needs-you signal. */
  notifyNeedsUser: (sessionId: SessionId, summary: string) => Promise<void>;
};

type ReviewerSessionSelection = Pick<
  Parameters<ReviewAutomationEngineDeps['createReviewerSession']>[0],
  'reviewerAgentConfigId' | 'reviewerAgentType' | 'modeId' | 'modelId' | 'configOptionValues'
>;

/** Maps the frozen reviewer row onto the exact child-session launch selection. */
export const resolveReviewerSessionSelection = (
  reviewer: ReviewerAgentRef | undefined
): ReviewerSessionSelection => ({
  ...(reviewer?.agentConfigId ? { reviewerAgentConfigId: reviewer.agentConfigId } : {}),
  ...(reviewer?.agentType ? { reviewerAgentType: reviewer.agentType } : {}),
  ...(reviewer?.modeId ? { modeId: reviewer.modeId } : {}),
  ...(reviewer?.modelId ? { modelId: reviewer.modelId } : {}),
  ...(reviewer?.configOptionValues ? { configOptionValues: reviewer.configOptionValues } : {}),
});

type CurrentPullRequest = { url: string; status: 'open' | 'closed' | 'merged' | 'draft' };

/** The reconciler keeps the current PR last in the array. */
const currentPullRequest = (meta: SessionMeta): CurrentPullRequest | undefined => {
  const list = meta.pullRequests ?? [];
  const last = list[list.length - 1];
  return last ? { url: last.url, status: last.status } : undefined;
};

/**
 * Ref the reviewer diffs against. `origin/` is prepended because the working
 * copy's local branch may lag the remote the PR is actually opened against.
 */
const resolveBaseRef = (meta: SessionMeta | undefined): string => {
  const base = meta?.baseBranch?.trim();
  if (!base) {
    return 'origin/HEAD';
  }
  return base.includes('/') ? base : `origin/${base}`;
};

/** Failed steps in a row before a run gives up and asks for a human. */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * How long a head must show no CI rollup before the absence reads as "this
 * repository has no CI". Check suites register within seconds of a push, so
 * five minutes is far past the registration race — the same order as the
 * planner's PR-association (3min) and merge-in-flight (2min) graces.
 */
export const NO_CI_GRACE_MS = 5 * 60_000;

export type CiAbsenceVerdict = {
  noCiConfirmed: boolean;
  /** Set while an absence stamp exists but the grace window has not elapsed. */
  retryAfterMs?: number;
};

/**
 * Tells "the repository has no CI" apart from "check suites have not
 * registered yet". Both look identical to the merge gate — `s` undefined —
 * but only the second resolves on its own. The discriminator is time: stamp
 * the first sighting of an unchanged head with no rollup, and only after a
 * full grace window treat the absence as real.
 *
 * Pure apart from the caller-owned `firstSeen` map it maintains; exported for
 * tests. The map is engine-local and deliberately NOT durable: a restart
 * re-stamps and waits a fresh window, which is the safe direction.
 */
export const trackCiAbsence = (args: {
  prUrl: string | undefined;
  headSha: string | undefined;
  ciState: SessionPullRequestCiState | undefined;
  firstSeen: Map<string, number>;
  now: number;
}): CiAbsenceVerdict => {
  const { prUrl, headSha, ciState, firstSeen, now } = args;
  if (!prUrl || !headSha || ciState !== undefined) {
    // CI reported something, or there is no head to watch: stamps are void.
    firstSeen.clear();
    return { noCiConfirmed: false };
  }
  const key = `${prUrl}@${headSha}`;
  // A new head restarts the window: a new push registers new check suites.
  for (const existing of firstSeen.keys()) {
    if (existing !== key) {
      firstSeen.delete(existing);
    }
  }
  const seen = firstSeen.get(key) ?? now;
  firstSeen.set(key, seen);
  const elapsedMs = now - seen;
  return elapsedMs >= NO_CI_GRACE_MS
    ? { noCiConfirmed: true }
    : { noCiConfirmed: false, retryAfterMs: NO_CI_GRACE_MS - elapsedMs };
};

/**
 * A submission for the current round that approved the branch, not yet consumed
 * by a transition. `recheck_ci_fix` clears `submittedRound`, so a stale approval
 * carried over from an earlier head does not qualify.
 */
const isFreshApproval = (run: ReviewRun): boolean =>
  run.state === 'reviewing' && run.submittedRound === run.round && run.verdict === 'approve';

/**
 * Pins the approval to a commit, so a later push can be noticed.
 *
 * Three failure modes meet here, and each of the two obvious conditions causes
 * one of them — which is why this is a disjunction rather than either half:
 *
 * - Stamp only when unset → the sha goes permanently stale. After a CI fix
 *   pushes a new head, the post-approval check compares old-vs-new forever:
 *   spot check → approve → still unequal → spot check. That loop consumes no
 *   budget and never throws, so nothing stops it.
 * - Stamp on every pass → pins a head the reviewer never looked at, silently
 *   retiring the check.
 * - Stamp ONLY on a fresh approval → dead in the approve-then-open-PR order,
 *   which is the primary flow. The approval happens before a PR exists, so there
 *   is no head to record; by the time one exists the state has left `reviewing`
 *   and never returns, so the check never arms at all.
 *
 * `isFreshApproval` re-stamps after each genuine re-approval (kills the loop);
 * the `!approvedSha` fallback records the first head known after an approval
 * that predated the PR (arms the check in that order). Once set, the fallback is
 * inert, so it cannot resurrect the loop.
 *
 * Exported for tests: every branch here is a shipped-and-fixed bug.
 */
export const resolveApprovedShaPatch = (
  run: ReviewRun,
  headSha: string | undefined
): Partial<ReviewRun> =>
  headSha && (isFreshApproval(run) || (run.verdict === 'approve' && !run.approvedSha))
    ? { approvedSha: headSha }
    : {};

const blockingFindingsOf = (findings: readonly ReviewFinding[]): ReviewFinding[] =>
  findings.filter(
    (finding) =>
      finding.severity === 'blocking' &&
      (finding.resolution === 'open' || finding.resolution === 'unresolved')
  );

export class ReviewAutomationEngine {
  /** Head keys (`prUrl@sha`) first seen with no CI rollup, and when. */
  private readonly ciAbsentSince = new Map<string, number>();

  constructor(private readonly deps: ReviewAutomationEngineDeps) {}

  /**
   * Runs one step for one session. Safe to call on any signal: it re-reads
   * durable state and the planner answers `wait` when nothing changed.
   */
  async step(sessionId: SessionId): Promise<void> {
    const run = await readReviewRun(this.deps.repo, this.deps.workspaceId, sessionId);
    if (!run || isReviewRunTerminal(run.state)) {
      return;
    }

    const author = await this.deps.readSessionFacts(sessionId);
    if (!author) {
      return;
    }
    // The checkbox is the presence of `autoReview` on session meta. It being
    // gone means the user unchecked it, which stops the run wherever it is.
    if (!author.meta.autoReview) {
      return;
    }

    const reviewer = run.reviewerSessionId
      ? await this.deps.readSessionFacts(run.reviewerSessionId)
      : undefined;

    const pr = currentPullRequest(author.meta);
    const prState = pr ? author.meta.pullRequestState?.[pr.url] : undefined;

    // GitHub is only consulted when the pass could actually reach the merge
    // path. A pass runs on every session-metadata change, and the long states
    // (waiting on a review, waiting on the author to fix) cannot merge — asking
    // GitHub there would spawn two `gh` processes per keystroke-scale event for
    // facts nothing reads.
    const needsGitHubFacts =
      Boolean(pr) &&
      (run.state === 'creating_pr' ||
        run.state === 'waiting_ci' ||
        run.state === 'fixing_ci' ||
        run.state === 'resolving_conflict' ||
        // A confirmed run leaves this state straight into the merge gate, which
        // reads every one of these facts.
        (run.state === 'awaiting_merge_confirmation' && run.mergeConfirmed === true) ||
        run.state === 'merging' ||
        (run.state === 'reviewing' && run.submittedRound === run.round));

    const prFacts =
      needsGitHubFacts && pr
        ? await this.deps.readPullRequestFacts(pr.url).catch(() => undefined)
        : undefined;
    const headSha = prFacts?.headSha;
    const ciAbsence = trackCiAbsence({
      prUrl: pr?.url,
      headSha,
      ciState: prState?.s,
      firstSeen: this.ciAbsentSince,
      now: getServerNow(),
    });
    const touchedProtectedPaths = findTouchedProtectedPaths(
      prFacts?.changedPaths ?? [],
      run.policy.protectedPaths
    );

    const humanReviewPending =
      needsGitHubFacts && pr
        ? await this.deps.hasPendingHumanReview(pr.url).catch(() => false)
        : false;

    const humanIntervened =
      Boolean(run.lastEngineTurnId) &&
      Boolean(author.meta.latestUserMsgId) &&
      author.meta.latestUserMsgId !== run.lastEngineTurnId;

    const reviewerAvailable = run.reviewerSessionId
      ? true
      : await this.deps.isReviewerAvailable(run.policy.reviewer).catch(() => false);

    const action = planReviewStep({
      state: run.state,
      // `updatedAt` only moves on a transition, so this is time-in-state.
      stateAgeMs: Math.max(0, getServerNow() - run.updatedAt),
      mode: run.mode ?? 'review_and_merge',
      round: run.round,
      ciFixUsed: run.ciFixUsed,
      conflictUsed: run.conflictUsed,
      budget: run.policy.budget,
      findings: run.findings,
      ...(run.approvedSha ? { approvedSha: run.approvedSha } : {}),
      ...(headSha ? { headSha } : {}),
      submissionForCurrentRound: run.submittedRound === run.round,
      ...(run.verdict ? { verdict: run.verdict } : {}),
      ...(pr ? { prUrl: pr.url, prStatus: pr.status } : {}),
      prState: prState ?? null,
      authorBusy: author.busy,
      reviewerBusy: reviewer?.busy ?? false,
      reviewerSessionExists: Boolean(run.reviewerSessionId),
      reviewerAvailable,
      humanIntervened,
      humanReviewPending,
      touchedProtectedPaths,
      mergeConfirmedOnce: run.policy.mergeConfirmedOnce === true,
      mergeConfirmedForRun: run.mergeConfirmed === true,
      noCiConfirmed: ciAbsence.noCiConfirmed,
    });

    if (action.kind === 'wait') {
      // A pass waiting out the no-CI grace gets no wake-up from anywhere else:
      // an absent rollup produces no document changes, so no event will fire
      // when the window expires. Arm the expiry explicitly.
      if (ciAbsence.retryAfterMs !== undefined) {
        this.deps.reevaluateLater?.(sessionId, ciAbsence.retryAfterMs);
      }
      return;
    }

    this.deps.logger.debug(
      `[review-automation] sessionId=${sessionId} state=${run.state} action=${action.kind}`
    );
    await this.perform(run, action, sessionId, headSha);
  }

  private async perform(
    run: ReviewRun,
    action: ReviewAction,
    sessionId: SessionId,
    headSha: string | undefined
  ): Promise<void> {
    const nextState = nextStateForAction(action);
    if (!nextState) {
      return;
    }

    const approvalPatch = resolveApprovedShaPatch(run, headSha);

    // Any successful action clears the failure streak.
    const basePatch: Partial<ReviewRun> = { ...approvalPatch, consecutiveFailures: 0 };

    switch (action.kind) {
      case 'start_review': {
        const author = await this.deps.readSessionFacts(sessionId);
        const intent = await this.deps.readIntent(sessionId).catch(() => undefined);
        const prompt = buildReviewPrompt({
          baseRef: resolveBaseRef(author?.meta),
          standardsFilename: REVIEW_STANDARDS_FILENAME,
          fallbackFilenames: REVIEW_STANDARDS_FALLBACK_FILENAMES,
          ...(intent ? { intent } : {}),
          ...(run.policy.requirements ? { requirements: run.policy.requirements } : {}),
        });
        const created = await this.deps.createReviewerSession({
          parentSessionId: sessionId,
          prompt,
          ...resolveReviewerSessionSelection(run.policy.reviewer),
        });
        await advanceReviewRun(this.deps.repo, this.deps.workspaceId, run, {
          state: nextState,
          detail: `Review round ${action.round} started.`,
          patch: { ...basePatch, reviewerSessionId: created.sessionId, round: action.round },
        });
        return;
      }

      case 'recheck': {
        if (!run.reviewerSessionId) {
          return;
        }
        // The author's last message is the only place a disagreement can be
        // expressed — they were told to "explain why in your reply", and the
        // reviewer is a separate session that cannot see this conversation.
        // Without forwarding it, a genuine dispute burns rounds instead of
        // escalating.
        const authorReply = await this.deps.readLastAssistantText(sessionId).catch(() => undefined);
        const prompt = buildReviewRecheckPrompt({
          openFindings: action.openFindings,
          round: action.round,
          maxRounds: run.policy.budget.reviewRounds,
          ...(authorReply ? { authorReply } : {}),
        });
        await this.deps.sendChat(run.reviewerSessionId, prompt);
        await advanceReviewRun(this.deps.repo, this.deps.workspaceId, run, {
          state: nextState,
          detail: `Re-check round ${action.round} started.`,
          patch: { ...basePatch, round: action.round },
        });
        return;
      }

      case 'recheck_ci_fix': {
        if (!run.reviewerSessionId) {
          return;
        }
        const author = await this.deps.readSessionFacts(sessionId);
        await this.deps.sendChat(
          run.reviewerSessionId,
          buildCiFixRecheckPrompt(resolveBaseRef(author?.meta))
        );
        await advanceReviewRun(this.deps.repo, this.deps.workspaceId, run, {
          state: nextState,
          // Deliberately not a new round: small CI churn must not drain the budget.
          detail: 'Spot-checking the latest push.',
          patch: { ...basePatch, submittedRound: 0 },
        });
        return;
      }

      case 'finish_merged': {
        await advanceReviewRun(this.deps.repo, this.deps.workspaceId, run, {
          state: nextState,
          detail: 'Merged (confirmed after the run was interrupted mid-merge).',
          patch: basePatch,
        });
        return;
      }

      case 'finish_review': {
        const blocking = blockingFindingsOf(run.findings);
        await advanceReviewRun(this.deps.repo, this.deps.workspaceId, run, {
          state: nextState,
          detail:
            blocking.length === 0
              ? 'Review finished with nothing blocking.'
              : `Review finished with ${blocking.length} blocking finding(s).`,
        });
        // A one-shot review is something the user asked for and is waiting on,
        // so its result is worth surfacing even though nothing went wrong.
        await this.deps.notifyNeedsUser(
          sessionId,
          blocking.length === 0
            ? 'The review found nothing blocking.'
            : `The review raised ${blocking.length} blocking finding(s).`
        );
        return;
      }

      case 'ask_author_to_fix': {
        const author = await this.deps.readSessionFacts(sessionId);
        const dispatched = await this.deps.sendChat(
          sessionId,
          buildAuthorFixPrompt(action.findings, {
            hasPullRequest: Boolean(author && currentPullRequest(author.meta)),
          })
        );
        await advanceReviewRun(this.deps.repo, this.deps.workspaceId, run, {
          state: nextState,
          detail: `Sent ${action.findings.length} blocking finding(s) to the author.`,
          patch: { ...basePatch, lastEngineTurnId: dispatched.userTurnId },
        });
        return;
      }

      case 'ask_author_to_create_pr': {
        const dispatched = await this.deps.sendChat(sessionId, CREATE_PR_PROMPT);
        await advanceReviewRun(this.deps.repo, this.deps.workspaceId, run, {
          state: nextState,
          detail: 'Review passed; asked the author to open a pull request.',
          patch: { ...basePatch, lastEngineTurnId: dispatched.userTurnId },
        });
        return;
      }

      case 'ask_author_to_fix_ci': {
        const dispatched = await this.deps.sendChat(
          sessionId,
          'CI is failing on this pull request. Read the failing checks with `gh`, fix the cause, and push. Do not disable or skip the check.'
        );
        await advanceReviewRun(this.deps.repo, this.deps.workspaceId, run, {
          state: nextState,
          detail: `Asked the author to fix CI (attempt ${run.ciFixUsed + 1}).`,
          patch: {
            ...basePatch,
            ciFixUsed: run.ciFixUsed + 1,
            lastEngineTurnId: dispatched.userTurnId,
          },
        });
        return;
      }

      case 'ask_author_to_resolve_conflict': {
        const dispatched = await this.deps.sendChat(
          sessionId,
          'This branch conflicts with its base branch. Merge the base branch in, resolve the conflicts, and push.'
        );
        await advanceReviewRun(this.deps.repo, this.deps.workspaceId, run, {
          state: nextState,
          detail: `Asked the author to resolve conflicts (attempt ${run.conflictUsed + 1}).`,
          patch: {
            ...basePatch,
            conflictUsed: run.conflictUsed + 1,
            lastEngineTurnId: dispatched.userTurnId,
          },
        });
        return;
      }

      case 'request_merge_confirmation': {
        const summary = action.ciAbsent
          ? 'Everything passed: the review is clear and this repository has no CI checks. This is the first automatic merge in this workspace, so it is waiting for your confirmation.'
          : 'Everything passed: the review is clear and CI is green. This is the first automatic merge in this workspace, so it is waiting for your confirmation.';
        await advanceReviewRun(this.deps.repo, this.deps.workspaceId, run, {
          state: nextState,
          detail: summary,
        });
        await this.deps.notifyNeedsUser(sessionId, summary);
        return;
      }

      case 'merge': {
        await this.merge(run, sessionId);
        return;
      }

      case 'pause': {
        const summary =
          'Auto review paused because you sent a message in this session. Resume it from the banner when you are done.';
        await advanceReviewRun(this.deps.repo, this.deps.workspaceId, run, {
          state: nextState,
          detail: summary,
          // Remembering where it stopped is what makes resuming possible;
          // without it the only way back was to toggle the feature off and on,
          // which restarts the review from round one with a fresh budget.
          patch: { pausedFrom: run.state },
        });
        // A pause is silent from the user's side — they wrote a message, not
        // "stop the automation" — so it has to say so.
        await this.deps.notifyNeedsUser(sessionId, summary);
        return;
      }

      case 'block': {
        await advanceReviewRun(this.deps.repo, this.deps.workspaceId, run, {
          state: nextState,
          detail: action.summary,
          patch: { blocked: { reason: action.reason, summary: action.summary } },
        });
        // A run that stops silently reads as a run that is still working. It is
        // not: someone has to look at it.
        await this.deps.notifyNeedsUser(sessionId, action.summary);
        return;
      }

      default:
        return;
    }
  }

  /**
   * Counts a failed step, and stops the run once it keeps failing.
   *
   * A throwing step leaves durable state untouched, so the same action would be
   * retried on every session-metadata change. That is a hot loop, and for
   * `start_review` a hot loop that repeatedly attempts session creation.
   */
  async recordFailure(sessionId: SessionId, message: string): Promise<void> {
    const run = await readReviewRun(this.deps.repo, this.deps.workspaceId, sessionId);
    if (!run || isReviewRunTerminal(run.state)) {
      return;
    }
    const failures = (run.consecutiveFailures ?? 0) + 1;
    if (failures < MAX_CONSECUTIVE_FAILURES) {
      await advanceReviewRun(this.deps.repo, this.deps.workspaceId, run, {
        state: run.state,
        detail: `Step failed (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${message}`,
        patch: { consecutiveFailures: failures },
      });
      return;
    }
    const summary = `Auto review stopped after ${MAX_CONSECUTIVE_FAILURES} failed attempts. Last error: ${message}`;
    await advanceReviewRun(this.deps.repo, this.deps.workspaceId, run, {
      state: 'blocked',
      detail: summary,
      patch: {
        consecutiveFailures: failures,
        blocked: { reason: 'error', summary },
      },
    });
    await this.deps.notifyNeedsUser(sessionId, summary);
  }

  private async merge(run: ReviewRun, sessionId: SessionId): Promise<void> {
    const author = await this.deps.readSessionFacts(sessionId);
    const pr = author ? currentPullRequest(author.meta) : undefined;
    if (!pr) {
      return;
    }

    const merging = await advanceReviewRun(this.deps.repo, this.deps.workspaceId, run, {
      state: 'merging',
      detail: 'Merging the pull request.',
    });

    if (run.policy.postPrComment) {
      // Posted by the engine rather than by the reviewer: the reviewer runs
      // read-only, and a comment written here can carry an identity marker so
      // the merge gate never mistakes Lody's own comment for a human's.
      await this.deps
        .postPullRequestComment(pr.url, this.buildReviewComment(run))
        .catch(() => undefined);
    }

    const result = await this.deps.mergePullRequest(pr.url).catch((error: unknown) => ({
      merged: false,
      message: error instanceof Error ? error.message : String(error),
    }));

    if (result.merged) {
      await advanceReviewRun(this.deps.repo, this.deps.workspaceId, merging, {
        state: 'merged',
        detail: 'Merged.',
      });
      // The first confirmed merge is what retires the confirmation gate.
      if (!run.policy.mergeConfirmedOnce) {
        const policy = await readReviewPolicy(this.deps.repo, this.deps.workspaceId);
        await writeReviewPolicy(this.deps.repo, this.deps.workspaceId, {
          ...policy,
          mergeConfirmedOnce: true,
        });
      }
      return;
    }

    const summary = `The merge did not go through: ${result.message ?? 'GitHub refused it'}.`;
    await advanceReviewRun(this.deps.repo, this.deps.workspaceId, merging, {
      state: 'blocked',
      detail: summary,
      patch: { blocked: { reason: 'merge_failed', summary } },
    });
    await this.deps.notifyNeedsUser(sessionId, summary);
  }

  private buildReviewComment(run: ReviewRun): string {
    const blocking = blockingFindingsOf(run.findings);
    const suggestions = run.findings.filter((finding) => finding.severity === 'suggestion');
    const lines = [
      '<!-- lody-review-agent -->',
      '**Lody review agent**',
      '',
      blocking.length === 0
        ? `Reviewed over ${run.round} round(s); nothing blocking remained.`
        : `${blocking.length} blocking finding(s) still open.`,
    ];
    if (suggestions.length > 0) {
      lines.push('', `${suggestions.length} non-blocking suggestion(s) are in Lody.`);
    }
    return lines.join('\n');
  }
}

/** Marker used to tell Lody's own PR comment apart from a person's. */
export const LODY_REVIEW_COMMENT_MARKER = '<!-- lody-review-agent -->';

export const buildBlockedNotification = (run: ReviewRun): string =>
  run.blocked?.summary ?? 'Auto review and merge stopped and needs your attention.';

export const reviewRunStartedAt = (run: ReviewRun): number => run.createdAt ?? getServerNow();
