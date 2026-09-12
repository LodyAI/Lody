import { requireSessionAccepted, type SessionData } from '@lody/shared/session-data';
import { getServerNow, type SessionId, type TaskProposalMeta } from '@lody/shared';
import { LodyOperationStoreError } from '@/orchestration/operation-store';

export type TaskProposalDraft = {
  proposalId: string;
  title: string;
  body?: string;
};

export type TaskProposalActor = {
  agentConfigId?: string;
  name?: string;
};

export type TaskProposalPublishResult =
  | { pending: true }
  | { pending: false; outcome: 'created'; taskId?: string }
  | { pending: false; outcome: 'dismissed' };

type TaskProposalDocument = {
  roomId: string;
  sessionData: SessionData;
};

export type TaskProposalPersistence = {
  repo: {
    flush(): Promise<void>;
  };
  getOrCreateSessionDoc(sessionId: SessionId): Promise<TaskProposalDocument>;
  syncDocOrThrow(docId: string, options?: { reason?: string }): Promise<void>;
};

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const syncProposalDoc = async (
  manager: Pick<TaskProposalPersistence, 'syncDocOrThrow'>,
  roomId: string,
  phase: 'hydrate' | 'commit'
): Promise<void> => {
  try {
    await manager.syncDocOrThrow(roomId, { reason: `mcp.task_propose:${phase}` });
  } catch (error) {
    const detail =
      phase === 'hydrate'
        ? 'The conversation could not be synchronized before writing the task proposal.'
        : 'The task proposal was saved locally, but remote synchronization was not confirmed.';
    throw new LodyOperationStoreError(
      'TASK_PROPOSAL_SYNC_FAILED',
      `${detail} Retry with the same proposalId; retries are idempotent. ${formatError(error)}`,
      true
    );
  }
};

export const publishTaskProposal = async (
  manager: TaskProposalPersistence,
  sessionId: SessionId,
  draft: TaskProposalDraft,
  actor: TaskProposalActor,
  options: { now?: () => number } = {}
): Promise<TaskProposalPublishResult> => {
  const doc = await manager.getOrCreateSessionDoc(sessionId);

  // The MCP server owns this manager for one call only. Hydrating before the
  // conditional upsert and awaiting the commit sync are what make an `ok` reply
  // mean another client can actually observe the card after fast cleanup.
  await syncProposalDoc(manager, doc.roomId, 'hydrate');

  const desiredMeta: TaskProposalMeta = {
    proposalId: draft.proposalId,
    title: draft.title,
    ...(draft.body !== undefined ? { body: draft.body } : {}),
    proposedBy: {
      kind: 'agent',
      ...(actor.agentConfigId ? { agentConfigId: actor.agentConfigId } : {}),
      ...(actor.name ? { name: actor.name } : {}),
    },
  };
  const turnId = `task-proposal-${draft.proposalId}`;
  let changed = false;
  let result: TaskProposalPublishResult = { pending: true };

  const applied = await doc.sessionData.commands.applyHistoryAction({
    kind: 'task-proposal',
    turnId,
    meta: desiredMeta,
    timestamp: new Date((options.now ?? getServerNow)()).toISOString(),
  });
  if (applied.status === 'rejected' && applied.reason.code === 'conflict')
    throw new LodyOperationStoreError(
      'TASK_PROPOSAL_ID_CONFLICT',
      `History entry ${turnId} belongs to a different proposal. Use a different proposalId.`,
      false
    );
  const accepted = requireSessionAccepted(applied);
  changed = accepted.matched ?? false;
  result = accepted.proposal ?? { pending: true };

  if (!changed) {
    return result;
  }

  await manager.repo.flush();
  await syncProposalDoc(manager, doc.roomId, 'commit');
  return result;
};
