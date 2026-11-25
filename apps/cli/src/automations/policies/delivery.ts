import { Clock, Effect, Semaphore } from 'effect';
import {
  AUTO_DELIVERY_ORIGIN_PROMPT,
  CREATE_PR_BASE_PROMPT,
  PR_BRANCH_UPKEEP_PROMPT,
  buildFixCiRequest,
  buildMergePrRequest,
  buildResolveConflictsRequest,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  resolveSessionPullRequests,
  withPrBranchUpkeep,
  withProjectGroupPrScope,
  withQuickActionOrigin,
  type MachineId,
  type PrPromptProvider,
  type SessionAutoDelivery,
  type SessionAutoDeliveryStallReason,
  type SessionAutoDeliveryStatus,
  type SessionId,
  type SessionMeta,
  type SessionPullRequestCiState,
  type SessionPullRequestMergeState,
} from '@lody/shared';
import {
  autoDeliverOptionsSchema,
  type AutoDeliverOptions,
  type AutomationEvent,
  type AutomationReceipt,
  type ConditionObservation,
} from '@lody/shared/automations';
import { z } from 'zod';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import { automationIdentity, type AutomationLedger } from '../storage/ledger';
import { CANCELLABLE_DELIVERY_STATES, SESSION_BUSY_BLOCK_REASONS } from '../storage/schema';
import {
  inferPullRequestProvider,
  mapGitHubCiState,
  mapGitHubMergeState,
  pullRequestCheckpointId,
  type PullRequestCheckStatus,
  type PullRequestMergeability,
} from '../sources/pull-requests';
import { configureSessionPolicies } from './session';

/**
 * Auto delivery: after the user turns it on, the Host requests the next step for
 * the Session's pull/merge requests (create, fix CI, resolve conflicts, merge)
 * from provider-neutral observations. Each request is delivered through the
 * ordinary automation receipt and Session admission.
 */
export const DELIVERY_EVENT_TYPE = 'session.delivery.step';
export const DELIVERY_EVENT_SOURCE = 'lody/auto-delivery';
/** Each repair kind is requested at most this many times per PR per enablement. */
export const DELIVERY_ATTEMPT_LIMIT = 3;
/** How long after a settled Create PR request a missing PR stops delivery. */
export const DELIVERY_PR_CREATION_GRACE_MS = 10 * 60_000;
export const DELIVERY_CI_REPORT_GRACE_MS = 5 * 60_000;
/** How long a transient or unconfirmed receipt block stays quiet before surfacing as stalled. */
export const DELIVERY_TRANSIENT_BLOCK_GRACE_MS = 60_000;

export type DeliveryStep = 'create_pr' | 'fix_ci' | 'resolve_conflicts' | 'merge';

export type DeliveryPrAttempts = {
  fixHeads: string[];
  conflictHeads: string[];
  mergeHeads: string[];
  unreportedCi?: { head: string; since: number };
};

/** Durable progress of one enablement. A new enablement starts a new epoch. */
export type DeliveryProgress = {
  epoch: number;
  prUrl?: string;
  prUrls?: string[];
  prAttempts?: Record<string, DeliveryPrAttempts>;
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
    blockedSince?: number;
  };
};

export type PullRequestSnapshot = {
  provider: PrPromptProvider;
  url: string;
  repoFullName?: string;
  number?: number;
  status: string;
  headSha?: string;
  checks: PullRequestCheckStatus;
  mergeability: PullRequestMergeability;
  observedAt: number;
};

/** What happened to the last request, from its receipt. */
export type StepOutcome =
  | { state: 'outstanding' }
  | { state: 'stopped' }
  | { state: 'blocked'; reason?: string; transient?: boolean }
  | { state: 'failed' }
  | { state: 'superseded' }
  | { state: 'settled'; at: number };

const TRANSIENT_BLOCK_REASONS: ReadonlySet<string> = new Set([
  'execution_release_unconfirmed',
  'guard:delivery_pr_unobserved',
  'adapter_unavailable',
  'permission_unconfirmed',
  'target_permission_unconfirmed',
  'target_unavailable',
  'owner_unavailable',
  'target_owner_unavailable',
]);

export type DeliveryStatus = SessionAutoDeliveryStatus;

export type DeliveryStepDecision =
  | { step: 'create_pr' }
  | { step: 'fix_ci' | 'resolve_conflicts'; attempt: number; pr: PullRequestSnapshot }
  | { step: 'merge'; pr: PullRequestSnapshot };

export type DeliveryDecision = {
  status: DeliveryStatus;
  progress: DeliveryProgress;
  step?: DeliveryStepDecision;
  /** All tracked pull requests were merged: delivery has ended and the setting turns off. */
  finished?: boolean;
  observed?: PullRequestSnapshot;
};

const emptyAttempts = (): DeliveryPrAttempts => ({
  fixHeads: [],
  conflictHeads: [],
  mergeHeads: [],
});

function readPrAttempts(progress: DeliveryProgress, url: string): DeliveryPrAttempts {
  const existing = progress.prAttempts?.[url];
  if (existing) {
    return {
      fixHeads: [...existing.fixHeads],
      conflictHeads: [...existing.conflictHeads],
      mergeHeads: [...existing.mergeHeads],
      ...(existing.unreportedCi ? { unreportedCi: { ...existing.unreportedCi } } : {}),
    };
  }
  if (progress.prUrl === url) {
    return {
      fixHeads: [...progress.fixHeads],
      conflictHeads: [...progress.conflictHeads],
      mergeHeads: [...progress.mergeHeads],
      ...(progress.unreportedCi ? { unreportedCi: { ...progress.unreportedCi } } : {}),
    };
  }
  return emptyAttempts();
}

/** Mirrors active PR attempts onto legacy top-level fields for checkpoint backward compatibility. */
function writePrAttempts(
  progress: DeliveryProgress,
  url: string,
  attempts: DeliveryPrAttempts
): void {
  progress.prAttempts = { ...(progress.prAttempts ?? {}), [url]: attempts };
  progress.fixHeads = [...attempts.fixHeads];
  progress.conflictHeads = [...attempts.conflictHeads];
  progress.mergeHeads = [...attempts.mergeHeads];
  progress.unreportedCi = attempts.unreportedCi;
}

function stepStatusPayload(
  step: DeliveryStep,
  attempt?: number
): { state: 'pr' | 'merge' } | { state: 'fix' | 'conflict'; attempt?: number } {
  if (step === 'create_pr') return { state: 'pr' };
  if (step === 'merge') return { state: 'merge' };
  return { state: step === 'fix_ci' ? 'fix' : 'conflict', ...(attempt ? { attempt } : {}) };
}

/** Pure decision from durable progress and the latest provider-neutral observations. */
export function decideDelivery(input: {
  options: AutoDeliverOptions;
  progress: DeliveryProgress;
  candidates: readonly string[];
  pr?: PullRequestSnapshot;
  prs?: Readonly<Record<string, PullRequestSnapshot>>;
  workspacePending: boolean;
  lastStep?: StepOutcome;
  now: number;
}): DeliveryDecision {
  const { options, now } = input;
  const progress: DeliveryProgress = {
    ...input.progress,
    ...(input.progress.prUrls ? { prUrls: [...input.progress.prUrls] } : {}),
    ...(input.progress.prAttempts ? { prAttempts: { ...input.progress.prAttempts } } : {}),
  };
  const lookupPr = (url: string | undefined): PullRequestSnapshot | undefined => {
    if (!url) return undefined;
    if (input.prs?.[url]) return input.prs[url];
    if (input.pr && input.pr.url === url) return input.pr;
    return undefined;
  };
  const prRef = (url: string | undefined) => {
    if (!url) return {};
    const total = progress.prUrls?.length ?? 0;
    if (total <= 1) return { prUrl: url };
    const index = progress.prUrls!.indexOf(url);
    return index >= 0
      ? { prUrl: url, prIndex: index + 1, prTotal: total }
      : { prUrl: url, prTotal: total };
  };
  const emit = (url: string | undefined, status: DeliveryStatus): DeliveryDecision => ({
    status: { ...prRef(url), ...status },
    progress,
  });

  const last = progress.lastStep;
  if (last && input.lastStep?.state === 'outstanding') {
    if (last.blockedSince !== undefined) {
      const { blockedSince: _, ...cleared } = last;
      progress.lastStep = cleared;
    }
    return emit(last.prUrl ?? progress.prUrl, stepStatusPayload(last.step, last.attempt));
  }
  if (input.lastStep?.state === 'stopped')
    return emit(last?.prUrl ?? progress.prUrl, { state: 'stalled', reason: 'stopped' });
  if (input.lastStep?.state === 'blocked') {
    if (input.lastStep.transient && last) {
      const since = last.blockedSince ?? now;
      if (last.blockedSince === undefined) progress.lastStep = { ...last, blockedSince: since };
      if (now - since < DELIVERY_TRANSIENT_BLOCK_GRACE_MS)
        return emit(last.prUrl ?? progress.prUrl, stepStatusPayload(last.step, last.attempt));
    }
    return emit(last?.prUrl ?? progress.prUrl, {
      state: 'stalled',
      reason: 'request_blocked',
      ...(input.lastStep.reason ? { blockReason: input.lastStep.reason } : {}),
    });
  }
  if (input.lastStep?.state === 'failed')
    return emit(last?.prUrl ?? progress.prUrl, { state: 'stalled', reason: 'request_failed' });
  const settledAt = input.lastStep?.state === 'settled' ? input.lastStep.at : undefined;

  if (!progress.prUrls?.length) {
    if (progress.prUrl) {
      progress.prUrls = [progress.prUrl];
    } else if (input.candidates.length > 0) {
      progress.prUrls = [...input.candidates];
      progress.prUrl = input.candidates[0];
    } else if (!progress.createRequested) {
      progress.createRequested = true;
      return {
        ...emit(undefined, { state: 'pr' }),
        step: { step: 'create_pr' },
      };
    } else if (settledAt !== undefined && now - settledAt > DELIVERY_PR_CREATION_GRACE_MS) {
      return emit(undefined, { state: 'stalled', reason: 'pr_not_created' });
    } else {
      return emit(undefined, { state: 'pr' });
    }
  }

  const queue = progress.prUrls ?? (progress.prUrl ? [progress.prUrl] : []);
  let activeUrl = progress.prUrl && queue.includes(progress.prUrl) ? progress.prUrl : queue[0];
  let pr = lookupPr(activeUrl);

  if (pr?.status === 'merged') {
    const nextUrl = queue.find((url) => lookupPr(url)?.status !== 'merged');
    if (!nextUrl) {
      return { ...emit(activeUrl, { state: 'merged' }), finished: true };
    }
    activeUrl = nextUrl;
    progress.prUrl = nextUrl;
    pr = lookupPr(activeUrl);
  } else if (activeUrl) {
    progress.prUrl = activeUrl;
  }

  const stalled = (reason: Exclude<SessionAutoDeliveryStallReason, 'request_blocked'>) =>
    emit(activeUrl, { state: 'stalled', reason });

  if (!activeUrl || !pr || pr.url !== activeUrl) return emit(activeUrl, { state: 'ci' });
  if (pr.status === 'merged') return { ...emit(activeUrl, { state: 'merged' }), finished: true };
  if (pr.status === 'closed') return stalled('pr_closed');
  if (pr.status === 'draft') return stalled('pr_draft');
  const lastStepForActive = !last?.prUrl || last.prUrl === activeUrl;
  if (!pr.headSha || (lastStepForActive && settledAt !== undefined && pr.observedAt <= settledAt))
    return emit(activeUrl, { state: 'ci' });
  if (input.workspacePending) return stalled('workspace_unpushed');
  const head = pr.headSha;
  const attempts = readPrAttempts(progress, activeUrl);

  if (pr.mergeability === 'conflicts') {
    if (!options.resolveConflicts) return stalled('conflicts');
    if (attempts.conflictHeads.includes(head)) return stalled('no_new_commit');
    if (attempts.conflictHeads.length >= DELIVERY_ATTEMPT_LIMIT) return stalled('conflict_limit');
    attempts.conflictHeads = [...attempts.conflictHeads, head];
    writePrAttempts(progress, activeUrl, attempts);
    const attempt = attempts.conflictHeads.length;
    return {
      ...emit(activeUrl, { state: 'conflict', attempt }),
      step: { step: 'resolve_conflicts', attempt, pr },
    };
  }
  if (pr.checks === 'failed') {
    if (!options.fixCi) return stalled('ci_failed');
    if (attempts.fixHeads.includes(head)) return stalled('no_new_commit');
    if (attempts.fixHeads.length >= DELIVERY_ATTEMPT_LIMIT) return stalled('ci_limit');
    attempts.fixHeads = [...attempts.fixHeads, head];
    writePrAttempts(progress, activeUrl, attempts);
    const attempt = attempts.fixHeads.length;
    return {
      ...emit(activeUrl, { state: 'fix', attempt }),
      step: { step: 'fix_ci', attempt, pr },
    };
  }
  if (pr.checks === 'none') {
    if (attempts.unreportedCi?.head !== head)
      attempts.unreportedCi = { head, since: pr.observedAt };
    writePrAttempts(progress, activeUrl, attempts);
    if (pr.observedAt - attempts.unreportedCi.since < DELIVERY_CI_REPORT_GRACE_MS)
      return emit(activeUrl, { state: 'ci' });
  }
  if (pr.checks === 'pending' || pr.mergeability === 'unknown')
    return emit(activeUrl, { state: 'ci' });
  if (pr.mergeability === 'blocked') return stalled('merge_blocked');
  if (pr.mergeability === 'behind') return stalled('merge_behind');
  if (!options.merge) return emit(activeUrl, { state: 'ready' });
  if (attempts.mergeHeads.includes(head)) return stalled('merge_failed');
  attempts.mergeHeads = [...attempts.mergeHeads, head];
  writePrAttempts(progress, activeUrl, attempts);
  return {
    ...emit(activeUrl, { state: 'merge' }),
    step: { step: 'merge', pr },
  };
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

const isCheckStatus = (value: unknown): value is PullRequestCheckStatus =>
  value === 'passed' || value === 'failed' || value === 'pending' || value === 'none';

const isMergeability = (value: unknown): value is PullRequestMergeability =>
  value === 'clean' ||
  value === 'conflicts' ||
  value === 'behind' ||
  value === 'blocked' ||
  value === 'unknown';

const isProvider = (value: unknown): value is PrPromptProvider =>
  value === 'github' || value === 'gitlab' || value === 'other';

export function readPullRequestSnapshot(
  ledger: AutomationLedger,
  sessionId: string,
  url: string
): PullRequestSnapshot | undefined {
  const checkpoint = ledger.checkpoint(pullRequestCheckpointId(sessionId, url));
  if (!checkpoint) return undefined;
  const data = checkpoint.data;
  if (typeof data.status !== 'string') return undefined;
  const provider = isProvider(data.provider) ? data.provider : inferPullRequestProvider(url);
  const checks = isCheckStatus(data.checks)
    ? data.checks
    : mapGitHubCiState((data.ciState ?? null) as SessionPullRequestCiState | null);
  const mergeability = isMergeability(data.mergeability)
    ? data.mergeability
    : mapGitHubMergeState((data.mergeState ?? null) as SessionPullRequestMergeState | null);
  return {
    provider,
    url,
    ...(typeof data.repoFullName === 'string' ? { repoFullName: data.repoFullName } : {}),
    ...(typeof data.prNumber === 'number' ? { number: data.prNumber } : {}),
    status: data.status,
    ...(typeof data.headSha === 'string' ? { headSha: data.headSha } : {}),
    checks,
    mergeability,
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
      return { state: 'settled', at: receipt.updatedAt };
    case 'superseded':
      return { state: 'superseded' };
    case 'failed':
      return { state: 'failed' };
    case 'cancelled':
      return { state: 'stopped' };
    case 'blocked':
      if (receipt.reason === 'target_stopped') return { state: 'stopped' };
      if (receipt.reason && SESSION_BUSY_BLOCK_REASONS.has(receipt.reason))
        return { state: 'outstanding' };
      return {
        state: 'blocked',
        ...(receipt.reason ? { reason: receipt.reason } : {}),
        ...(receipt.reason && TRANSIENT_BLOCK_REASONS.has(receipt.reason)
          ? { transient: true }
          : {}),
      };
    default:
      return { state: 'outstanding' };
  }
};

const unfinished = (status: string | undefined) =>
  status === undefined || status === 'open' || status === 'draft';

function deliveryCandidates(
  ledger: AutomationLedger,
  meta: SessionMeta,
  selectedUrls?: readonly string[]
): string[] {
  const seen = new Set<string>();
  const allUnfinished: string[] = [];
  for (const pr of resolveSessionPullRequests(meta)) {
    const key = pr.url.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (
      unfinished(pr.status) &&
      unfinished(readPullRequestSnapshot(ledger, meta.id, pr.url)?.status)
    ) {
      allUnfinished.push(pr.url);
    }
  }
  if (!selectedUrls?.length) return allUnfinished;
  const available = new Map(allUnfinished.map((url) => [url.trim().toLowerCase(), url]));
  const filtered: string[] = [];
  for (const selected of selectedUrls) {
    const match = available.get(selected.trim().toLowerCase());
    if (match && !filtered.includes(match)) filtered.push(match);
  }
  return filtered;
}

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
  const candidates = deliveryCandidates(ledger, meta, options.prUrls);
  const urlsToRead = new Set<string>([
    ...(progress.prUrls ?? []),
    ...(progress.prUrl ? [progress.prUrl] : []),
    ...candidates,
  ]);
  const prs: Record<string, PullRequestSnapshot> = {};
  for (const url of urlsToRead) {
    const snapshot = readPullRequestSnapshot(ledger, meta.id, url);
    if (snapshot) prs[url] = snapshot;
  }
  const decision = decideDelivery({
    options,
    progress,
    candidates,
    prs,
    workspacePending: meta.workspaceDirty === true || meta.workspaceUnpushed === true,
    ...(progress.lastStep ? { lastStep: stepOutcome(ledger, progress.lastStep.eventId) } : {}),
    now,
  });
  const activeUrl = decision.progress.prUrl;
  const observed = activeUrl ? prs[activeUrl] : undefined;
  if (decision.step) {
    const stepDecision = decision.step;
    const pr = stepDecision.step === 'create_pr' ? undefined : stepDecision.pr;
    const attempt =
      stepDecision.step === 'fix_ci' || stepDecision.step === 'resolve_conflicts'
        ? stepDecision.attempt
        : undefined;
    const prKey = pr ? automationIdentity(pr.url).slice(0, 8) : 'none';
    const eventId = [
      meta.id,
      decision.progress.epoch,
      prKey,
      stepDecision.step,
      pr?.headSha ?? 'none',
      attempt ?? 0,
    ].join(':');
    const lastStep = {
      eventId,
      step: stepDecision.step,
      ...(attempt ? { attempt } : {}),
      ...(pr ? { prUrl: pr.url } : {}),
      ...(pr?.headSha ? { headSha: pr.headSha } : {}),
    };
    decision.progress.lastStep = lastStep;
    ledger.publish(
      deliveryEvent(ledger.workspaceId, meta, decision.progress.epoch, lastStep, pr, options, now)
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
  options: AutoDeliverOptions,
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
      ...(pr
        ? {
            provider: pr.provider,
            prUrl: pr.url,
            ...(pr.repoFullName ? { repoFullName: pr.repoFullName } : {}),
            ...(pr.number !== undefined ? { prNumber: pr.number } : {}),
          }
        : {}),
      ...(step.headSha ? { headSha: step.headSha } : {}),
      ...(step.step === 'merge' && options.mergeMethod ? { mergeMethod: options.mergeMethod } : {}),
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

const deliveryValues = z
  .object({
    provider: z.enum(['github', 'gitlab', 'other']).optional(),
    repoFullName: z.string().min(1).optional(),
    prNumber: z.number().int().positive().optional(),
    prUrl: z.string().url().optional(),
    headSha: z.string().min(1).optional(),
    mergeMethod: z.enum(['auto', 'squash', 'merge', 'rebase']).optional(),
    projectGroup: z.boolean().optional(),
  })
  .passthrough();

/**
 * Auto delivery sends the same request the matching Info Bar button sends, after
 * an origin line; it adds only facts the agent cannot discover (the merged head).
 */
export function deliveryRequest(step: string, values: unknown): string | undefined {
  const parsed = deliveryValues.safeParse(values);
  if (!parsed.success) return undefined;
  const { provider, repoFullName, prNumber, prUrl, headSha, mergeMethod } = parsed.data;
  const target = prUrl
    ? {
        ...(provider ? { provider } : {}),
        repoFullName: repoFullName ?? null,
        prNumber: prNumber ?? null,
        prUrl,
      }
    : undefined;
  const request =
    step === 'create_pr'
      ? withPrBranchUpkeep(CREATE_PR_BASE_PROMPT, PR_BRANCH_UPKEEP_PROMPT)
      : step === 'fix_ci' && target
        ? buildFixCiRequest(target)
        : step === 'resolve_conflicts' && target
          ? buildResolveConflictsRequest(target)
          : step === 'merge' && target && headSha
            ? buildMergePrRequest({ ...target, headSha, ...(mergeMethod ? { mergeMethod } : {}) })
            : undefined;
  if (!request) return undefined;
  return withQuickActionOrigin(
    AUTO_DELIVERY_ORIGIN_PROMPT,
    parsed.data.projectGroup ? withProjectGroupPrScope(request) : request
  );
}

const deliveryStatusKey = (
  status: DeliveryStatus | SessionAutoDelivery | null | undefined
): string => {
  if (!status) return '';
  const attempt =
    status.state === 'fix' || status.state === 'conflict' ? status.attempt : undefined;
  const reason = status.state === 'stalled' ? status.reason : undefined;
  const blockReason =
    status.state === 'stalled' && status.reason === 'request_blocked'
      ? status.blockReason
      : undefined;
  return JSON.stringify([
    status.state,
    attempt,
    reason,
    blockReason,
    status.prUrl,
    status.prIndex,
    status.prTotal,
  ]);
};

/**
 * Serializes `SessionMeta.autoDelivery` publication separately from engine `gate`.
 * Invariant: release `statusLock` before calling `Automations.cancel` (AB-BA order).
 */
export class DeliveryCoordinator {
  private readonly statusLock = Semaphore.makeUnsafe(1);

  constructor(
    private readonly deps: {
      ledger: AutomationLedger;
      manager: LoroDocumentManager;
      machineId: MachineId;
      logger: Logger;
    }
  ) {}

  private enabledRules() {
    const out: Array<{ sessionId: SessionId; ownerUserId: string; options: unknown }> = [];
    for (const rule of this.deps.ledger.rules()) {
      if (
        rule.enabled &&
        rule.scope.sessionId &&
        rule.handler.kind === 'policy' &&
        rule.handler.policy === 'auto-deliver' &&
        rule.ownerMachineId === this.deps.machineId
      ) {
        out.push({
          sessionId: rule.scope.sessionId as SessionId,
          ownerUserId: rule.ownerUserId,
          options: rule.handler.options,
        });
      }
    }
    return out;
  }

  /** Serializes `SessionMeta.autoDelivery` writers against `advanceAll`. */
  withStatusLock<A>(body: (now: number) => Promise<A>): Effect.Effect<A, unknown> {
    return this.statusLock.withPermit(
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Effect.tryPromise({ try: () => body(now), catch: (cause) => cause })
        ),
        Effect.uninterruptible
      )
    );
  }

  /** Advance all enabled Auto delivery rules on this machine and sync status transitions. */
  advanceAll(): Effect.Effect<void, unknown> {
    return this.withStatusLock(async (now) => {
      const { ledger, manager, logger } = this.deps;
      for (const rule of this.enabledRules()) {
        const { sessionId } = rule;
        try {
          const options = autoDeliverOptionsSchema.parse(rule.options);
          const roomId = getSessionRoomId(sessionId);
          const record = await manager.repo.getDocMeta(roomId);
          const meta = record?.meta as SessionMeta | undefined;
          if (!record || !meta || isLoroRepoDocDeleted(record) || meta.isArchived) continue;
          const decision = advanceDelivery({ ledger, meta, options, now });
          if (decision.finished) {
            configureSessionPolicies(
              ledger,
              sessionId,
              rule.ownerUserId,
              { autoDeliver: false },
              now
            );
          }
          if (deliveryStatusKey(meta.autoDelivery) !== deliveryStatusKey(decision.status)) {
            const pr = decision.observed;
            logger.debug(`Auto delivery ${sessionId}: ${deliveryStatusKey(decision.status)}`, {
              step: decision.step?.step,
              ...(pr
                ? {
                    provider: pr.provider,
                    head: pr.headSha,
                    status: pr.status,
                    checks: pr.checks,
                    mergeability: pr.mergeability,
                    observedAt: pr.observedAt,
                  }
                : {}),
              workspaceDirty: meta.workspaceDirty,
              workspaceUnpushed: meta.workspaceUnpushed,
            });
            await manager.repo.upsertDocMeta(roomId, {
              autoDelivery: { ...decision.status, updatedAt: now },
            });
          }
        } catch (cause) {
          // One Session's failure leaves the others' delivery running.
          logger.warn(`Auto delivery pass failed for ${sessionId}`, cause);
        }
      }
    });
  }

  /** Sessions with active Auto delivery demand for PR poller high-lane scheduling. */
  observationOwners(): Set<SessionId> {
    return new Set(this.enabledRules().map((rule) => rule.sessionId));
  }

  /** Must run outside `withStatusLock` to preserve the lock hierarchy. */
  cancelOutstandingStep(
    sessionId: string,
    cancelReceipt: (id: string) => Effect.Effect<void, unknown>
  ): Effect.Effect<void, unknown> {
    const { ledger } = this.deps;
    return Effect.gen(function* () {
      const lastStep = readDeliveryProgress(ledger, sessionId)?.lastStep;
      if (!lastStep) return;
      for (const receipt of ledger.eventReceipts(DELIVERY_EVENT_SOURCE, lastStep.eventId)) {
        if (CANCELLABLE_DELIVERY_STATES.has(receipt.state)) {
          yield* cancelReceipt(receipt.id);
        }
      }
    });
  }
}
