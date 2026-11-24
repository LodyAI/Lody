import {
  getCurrentPullRequestsByRepository,
  resolveSessionPullRequests,
  type SessionAutoDelivery,
  type SessionAutoDeliveryStallReason,
  type SessionMeta,
  type SessionPullRequestCiState,
  type SessionPullRequestMergeState,
} from '@lody/shared';
import type {
  AutoDeliverOptions,
  AutomationEvent,
  AutomationReceipt,
  ConditionObservation,
} from '@lody/shared/automations';
import { automationIdentity, type AutomationLedger } from '../storage/ledger';
import { pullRequestCheckpointId } from '../sources/pull-requests';

/**
 * Auto delivery: after the user turns it on, the Host requests the next step for
 * the Session's current pull request (create it, fix CI, resolve conflicts, merge)
 * from what the PR poller observed. Each request is the existing quick-action text,
 * delivered through the ordinary automation receipt and Session admission.
 */
export const DELIVERY_EVENT_TYPE = 'session.delivery.step';
export const DELIVERY_EVENT_SOURCE = 'lody/auto-delivery';
/** Each repair kind is requested at most this many times per enablement. */
export const DELIVERY_ATTEMPT_LIMIT = 3;
/** How long after a settled Create PR request a missing PR stops delivery. */
export const DELIVERY_PR_CREATION_GRACE_MS = 10 * 60_000;
export const DELIVERY_CI_REPORT_GRACE_MS = 5 * 60_000;

export type DeliveryStep = 'create_pr' | 'fix_ci' | 'resolve_conflicts' | 'merge';

/** Durable progress of one enablement. A new enablement starts a new epoch. */
export type DeliveryProgress = {
  epoch: number;
  prUrl?: string;
  createRequested?: boolean;
  fixHeads: string[];
  conflictHeads: string[];
  mergeHeads: string[];
  unreportedCi?: { head: string; since: number };
  lastStep?: {
    eventId: string;
    step: DeliveryStep;
    attempt?: number;
    prUrl?: string;
    headSha?: string;
  };
};

export type PullRequestSnapshot = {
  url: string;
  repoFullName: string;
  number: number;
  status: string;
  headSha?: string;
  ciState: SessionPullRequestCiState | null;
  mergeState: SessionPullRequestMergeState | null;
  observedAt: number;
};

/** What happened to the last request, from its receipt. */
export type StepOutcome =
  | { state: 'outstanding' }
  | { state: 'stopped' }
  | { state: 'failed' }
  | { state: 'settled'; at: number };

export type DeliveryStatus = Omit<SessionAutoDelivery, 'updatedAt'>;

export type DeliveryDecision = {
  status: DeliveryStatus;
  progress: DeliveryProgress;
  step?: { step: DeliveryStep; attempt?: number; pr?: PullRequestSnapshot };
  /** The pull request was merged: delivery has ended and the setting turns off. */
  finished?: boolean;
  observed?: PullRequestSnapshot;
};

const stepState = (step: DeliveryStep): DeliveryStatus['state'] =>
  step === 'create_pr'
    ? 'pr'
    : step === 'fix_ci'
      ? 'fix'
      : step === 'resolve_conflicts'
        ? 'conflict'
        : 'merge';

/** Pure decision from durable progress and the latest observations. */
export function decideDelivery(input: {
  options: AutoDeliverOptions;
  progress: DeliveryProgress;
  candidates: readonly string[];
  pr?: PullRequestSnapshot;
  workspacePending: boolean;
  lastStep?: StepOutcome;
  now: number;
}): DeliveryDecision {
  const { options, now } = input;
  const progress = { ...input.progress };
  const prUrl = progress.prUrl ?? input.pr?.url;
  const status = (state: DeliveryStatus['state'], extra: Partial<DeliveryStatus> = {}) => ({
    status: { state, ...(prUrl ? { prUrl } : {}), ...extra },
    progress,
  });
  const stalled = (reason: SessionAutoDeliveryStallReason) => status('stalled', { reason });
  const request = (
    step: DeliveryStep,
    pr?: PullRequestSnapshot,
    attempt?: number
  ): DeliveryDecision => ({
    ...status(stepState(step), attempt ? { attempt } : {}),
    step: { step, ...(attempt ? { attempt } : {}), ...(pr ? { pr } : {}) },
  });

  const last = progress.lastStep;
  if (last && input.lastStep?.state === 'outstanding')
    return status(stepState(last.step), last.attempt ? { attempt: last.attempt } : {});
  if (input.lastStep?.state === 'stopped') return stalled('stopped');
  if (input.lastStep?.state === 'failed') return stalled('request_failed');
  const settledAt = input.lastStep?.state === 'settled' ? input.lastStep.at : undefined;

  if (!progress.prUrl) {
    if (input.candidates.length > 1) return stalled('multiple_prs');
    const [candidate] = input.candidates;
    if (candidate) progress.prUrl = candidate;
    else if (!progress.createRequested) {
      progress.createRequested = true;
      return request('create_pr');
    } else if (settledAt !== undefined && now - settledAt > DELIVERY_PR_CREATION_GRACE_MS)
      return stalled('pr_not_created');
    else return status('pr');
  }

  const pr = input.pr;
  if (!pr || pr.url !== progress.prUrl) return status('ci');
  if (pr.status === 'merged') return { ...status('merged'), finished: true };
  if (pr.status === 'closed') return stalled('pr_closed');
  if (pr.status === 'draft') return stalled('pr_draft');
  // The last request's effect is unknown until a poll taken after it ended.
  if (!pr.headSha || (settledAt !== undefined && pr.observedAt <= settledAt)) return status('ci');
  if (input.workspacePending) return stalled('workspace_unpushed');
  const head = pr.headSha;

  if (pr.mergeState === 'd') {
    if (!options.resolveConflicts) return stalled('conflicts');
    if (progress.conflictHeads.includes(head)) return stalled('no_new_commit');
    if (progress.conflictHeads.length >= DELIVERY_ATTEMPT_LIMIT) return stalled('conflict_limit');
    progress.conflictHeads = [...progress.conflictHeads, head];
    return request('resolve_conflicts', pr, progress.conflictHeads.length);
  }
  if (pr.ciState === 'f' || pr.ciState === 'e') {
    if (!options.fixCi) return stalled('ci_failed');
    if (progress.fixHeads.includes(head)) return stalled('no_new_commit');
    if (progress.fixHeads.length >= DELIVERY_ATTEMPT_LIMIT) return stalled('ci_limit');
    progress.fixHeads = [...progress.fixHeads, head];
    return request('fix_ci', pr, progress.fixHeads.length);
  }
  if (pr.ciState === null) {
    if (progress.unreportedCi?.head !== head)
      progress.unreportedCi = { head, since: pr.observedAt };
    if (pr.observedAt - progress.unreportedCi.since < DELIVERY_CI_REPORT_GRACE_MS)
      return status('ci');
  }
  // Pending checks, or GitHub still computing mergeability.
  if (pr.ciState === 'p' || pr.ciState === 'x' || pr.mergeState === null) return status('ci');
  if (pr.mergeState === 'b') return stalled('merge_blocked');
  if (pr.mergeState === 'h') return stalled('merge_behind');
  if (!options.merge) return status('ready');
  if (progress.mergeHeads.includes(head)) return stalled('merge_failed');
  progress.mergeHeads = [...progress.mergeHeads, head];
  return request('merge', pr);
}

export const deliveryCheckpointId = (sessionId: string) =>
  automationIdentity('auto-delivery', sessionId);

export const emptyDeliveryProgress = (epoch: number): DeliveryProgress => ({
  epoch,
  fixHeads: [],
  conflictHeads: [],
  mergeHeads: [],
});

export function readDeliveryProgress(
  ledger: AutomationLedger,
  sessionId: string
): DeliveryProgress | undefined {
  return ledger.checkpoint(deliveryCheckpointId(sessionId))?.data as DeliveryProgress | undefined;
}

function writeDeliveryProgress(
  ledger: AutomationLedger,
  sessionId: string,
  progress: DeliveryProgress,
  now: number
): void {
  ledger.observe(
    deliveryCheckpointId(sessionId),
    { revision: automationIdentity(JSON.stringify(progress)), observedAt: now, data: progress },
    []
  );
}

/** A new enablement forgets the previous one's attempts and pull request. */
export function startDeliveryEpoch(ledger: AutomationLedger, sessionId: string, now: number) {
  writeDeliveryProgress(ledger, sessionId, emptyDeliveryProgress(now), now);
}

export function readPullRequestSnapshot(
  ledger: AutomationLedger,
  sessionId: string,
  url: string
): PullRequestSnapshot | undefined {
  const checkpoint = ledger.checkpoint(pullRequestCheckpointId(sessionId, url));
  if (!checkpoint) return undefined;
  const data = checkpoint.data;
  if (
    typeof data.status !== 'string' ||
    typeof data.repoFullName !== 'string' ||
    typeof data.prNumber !== 'number'
  )
    return undefined;
  return {
    url,
    repoFullName: data.repoFullName,
    number: data.prNumber,
    status: data.status,
    ...(typeof data.headSha === 'string' ? { headSha: data.headSha } : {}),
    // Checkpoints written before these fields existed read as "still computing".
    ciState: (data.ciState ?? null) as SessionPullRequestCiState | null,
    mergeState: (data.mergeState ?? null) as SessionPullRequestMergeState | null,
    observedAt: checkpoint.observedAt,
  };
}

function stepOutcome(ledger: AutomationLedger, eventId: string): StepOutcome {
  const receipts = ledger.eventReceipts(DELIVERY_EVENT_SOURCE, eventId);
  if (!receipts.length)
    return ledger.hasEventDelivery(DELIVERY_EVENT_SOURCE, eventId)
      ? { state: 'outstanding' }
      : { state: 'failed' };
  const receipt = receipts.reduce((latest, item) =>
    item.updatedAt > latest.updatedAt ? item : latest
  );
  return receiptOutcome(receipt);
}

const receiptOutcome = (receipt: AutomationReceipt): StepOutcome => {
  switch (receipt.state) {
    case 'settled':
    case 'superseded':
      return { state: 'settled', at: receipt.updatedAt };
    case 'failed':
      return { state: 'failed' };
    case 'cancelled':
      return { state: 'stopped' };
    case 'blocked':
      return receipt.reason === 'target_stopped' ? { state: 'stopped' } : { state: 'outstanding' };
    default:
      return { state: 'outstanding' };
  }
};

const unfinished = (status: string | undefined) =>
  status === undefined || status === 'open' || status === 'draft';
const deliveryCandidates = (ledger: AutomationLedger, meta: SessionMeta) =>
  getCurrentPullRequestsByRepository(resolveSessionPullRequests(meta))
    .filter(
      (pr) =>
        unfinished(pr.status) &&
        unfinished(readPullRequestSnapshot(ledger, meta.id, pr.url)?.status)
    )
    .map((pr) => pr.url);

/**
 * One pass for an enabled Session: decide, publish the next request's event, then
 * record progress. Publication comes first; its deterministic event id makes a
 * repeat after a crash a no-op instead of a second request.
 */
export function advanceDelivery(input: {
  ledger: AutomationLedger;
  meta: SessionMeta;
  options: AutoDeliverOptions;
  now: number;
}): DeliveryDecision {
  const { ledger, meta, options, now } = input;
  const progress = readDeliveryProgress(ledger, meta.id) ?? emptyDeliveryProgress(now);
  const candidates = deliveryCandidates(ledger, meta);
  const prUrl = progress.prUrl ?? (candidates.length === 1 ? candidates[0] : undefined);
  const observed = prUrl ? readPullRequestSnapshot(ledger, meta.id, prUrl) : undefined;
  const decision = decideDelivery({
    options,
    progress,
    candidates,
    ...(observed ? { pr: observed } : {}),
    workspacePending: meta.workspaceDirty === true || meta.workspaceUnpushed === true,
    ...(progress.lastStep ? { lastStep: stepOutcome(ledger, progress.lastStep.eventId) } : {}),
    now,
  });
  if (decision.step) {
    const { step, attempt, pr } = decision.step;
    const eventId = [
      meta.id,
      decision.progress.epoch,
      step,
      pr?.headSha ?? 'none',
      attempt ?? 0,
    ].join(':');
    const lastStep = {
      eventId,
      step,
      ...(attempt ? { attempt } : {}),
      ...(pr ? { prUrl: pr.url } : {}),
      ...(pr?.headSha ? { headSha: pr.headSha } : {}),
    };
    decision.progress.lastStep = lastStep;
    ledger.publish(
      deliveryEvent(ledger.workspaceId, meta, decision.progress.epoch, lastStep, pr, now)
    );
  }
  if (
    JSON.stringify(decision.progress) !== JSON.stringify(progress) ||
    !readDeliveryProgress(ledger, meta.id)
  )
    writeDeliveryProgress(ledger, meta.id, decision.progress, now);
  return observed ? { ...decision, observed } : decision;
}

function deliveryEvent(
  workspaceId: string,
  meta: SessionMeta,
  epoch: number,
  step: NonNullable<DeliveryProgress['lastStep']>,
  pr: PullRequestSnapshot | undefined,
  now: number
): AutomationEvent {
  const sessionId = meta.id;
  return {
    id: step.eventId,
    source: DELIVERY_EVENT_SOURCE,
    type: DELIVERY_EVENT_TYPE,
    version: 1,
    subject: `session/${sessionId}`,
    observedAt: now,
    scope: { workspaceId, sessionId },
    data: {
      step: step.step,
      ...(step.attempt ? { attempt: step.attempt } : {}),
      ...(pr ? { prUrl: pr.url, repoFullName: pr.repoFullName, prNumber: pr.number } : {}),
      ...(step.headSha ? { headSha: step.headSha } : {}),
      ...(meta.projectRun ? { projectGroup: true } : {}),
    },
    provenance: 'command',
    completeness: 'observed',
    correlationId: `auto-delivery/${sessionId}/${epoch}`,
    depth: 0,
  };
}

/**
 * Admission guard: the request is still the latest one and its pull request has
 * not moved on (a new head, a merge or a close makes it obsolete).
 */
export function deliveryStepCurrent(
  ledger: AutomationLedger,
  sessionId: string,
  eventId: string
): ConditionObservation {
  const step = readDeliveryProgress(ledger, sessionId)?.lastStep;
  if (step?.eventId !== eventId) return { value: 'no', reason: 'delivery_step_replaced' };
  if (step.step === 'create_pr' || !step.prUrl) return { value: 'yes', reason: 'delivery_current' };
  const pr = readPullRequestSnapshot(ledger, sessionId, step.prUrl);
  if (!pr) return { value: 'unknown', reason: 'delivery_pr_unobserved' };
  if (pr.status !== 'open' || pr.headSha !== step.headSha)
    return { value: 'no', reason: 'delivery_pr_changed' };
  return { value: 'yes', reason: 'delivery_current' };
}
