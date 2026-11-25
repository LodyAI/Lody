import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  parseGitHubPullRequestUrl,
  resolveSessionPullRequests,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import type { AutomationReceipt, ConditionObservation } from '@lody/shared/automations';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { SessionAutomationAuthority } from '@/session/session-automation-authority';
import type { AutomationLedger } from '../storage/ledger';
import type { ActionAuthorization, ActionResult } from '../runtime/engine';
import { pullRequestCheckpointId } from '../sources/pull-requests';
import { sessionActionSchema } from './authorization';

export type ArchiveActionDeps = {
  manager: LoroDocumentManager;
  authority: SessionAutomationAuthority;
  ledger: AutomationLedger;
  admission(receipt: AutomationReceipt): Promise<ConditionObservation>;
};

export function prepareArchiveAction(receipt: AutomationReceipt): ActionResult {
  const { sessionId } = sessionActionSchema.parse(receipt.intent.action.parameters);
  return { state: 'resolved', sessionId, prepared: { kind: 'archive', sessionId } };
}

export async function submitArchiveAction(
  deps: ArchiveActionDeps,
  receipt: AutomationReceipt,
  allowed: ActionAuthorization
): Promise<ActionResult> {
  if (allowed.reason === 'archive_already_committed')
    return { state: 'settled', reason: allowed.reason };
  const result = await deps.authority.archive(
    receipt.sessionId as SessionId,
    receipt.rule.ownerUserId,
    () => deps.admission(receipt),
    receipt.id
  );
  return { state: result.value === 'yes' ? 'settled' : 'blocked', reason: result.reason };
}

export async function reconcileArchiveAction(
  deps: ArchiveActionDeps,
  receipt: AutomationReceipt,
  meta: SessionMeta,
  resubmit: () => Promise<ActionResult>
): Promise<ActionResult> {
  if (await deps.authority.archived(receipt.sessionId as SessionId))
    return { state: 'settled', reason: 'archive_already_committed' };
  if (!meta.isArchived) return resubmit();
  return { state: 'unknown', reason: 'archive_group_unconfirmed' };
}

export async function cancelArchiveAction(
  reconcile: () => Promise<ActionResult>
): Promise<ActionResult> {
  const observed = await reconcile();
  return observed.state === 'settled'
    ? { state: 'settled', reason: 'archive_already_committed' }
    : { state: 'cancelled', reason: 'user_cancelled' };
}

export async function observeCurrentPr(
  deps: Pick<ArchiveActionDeps, 'manager' | 'ledger'>,
  receipt: AutomationReceipt,
  prUrl: string
): Promise<ConditionObservation> {
  const sessionId = receipt.event.scope.sessionId;
  if (!sessionId) return { value: 'unknown', reason: 'source_session_unlinked' };
  const record = await deps.manager.repo.getDocMeta(getSessionRoomId(sessionId as SessionId));
  const meta = record?.meta as SessionMeta | undefined;
  if (!record || !meta || isLoroRepoDocDeleted(record))
    return { value: 'unknown', reason: 'source_session_unavailable' };
  const linked = resolveSessionPullRequests(meta);
  const repository = parseGitHubPullRequestUrl(prUrl)?.repoFullName.toLowerCase();
  const pr = linked
    .filter(
      (item) => parseGitHubPullRequestUrl(item.url)?.repoFullName.toLowerCase() === repository
    )
    .at(-1);
  if (!repository || !pr) return { value: 'unknown', reason: 'pr_link_unconfirmed' };
  if (pr.url !== prUrl) return { value: 'no', reason: 'pr_superseded' };
  const observation = deps.ledger.checkpoint(pullRequestCheckpointId(sessionId, prUrl));
  if (!observation) return { value: 'unknown', reason: 'pr_observation_missing' };
  // Merged is terminal provider evidence; a busy group must not hold that stale forever.
  if (observation.data.status === 'merged' && pr.status === 'merged')
    return { value: 'yes', reason: 'merged' };
  if (Date.now() - observation.observedAt > 5 * 60_000)
    return { value: 'unknown', reason: 'pr_observation_stale' };
  return { value: 'no', reason: String(observation.data.status) };
}
