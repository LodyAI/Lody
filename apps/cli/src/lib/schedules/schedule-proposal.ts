import { getServerNow, type MessageContent, type ScheduleProposalMeta } from '@lody/shared';
import { readSessionHistory, type SessionTurn } from '@lody/shared/session-data';

export type ScheduleProposalDraft = Pick<
  ScheduleProposalMeta,
  'proposalId' | 'title' | 'prompt' | 'rule' | 'destination' | 'target'
>;

export type ScheduleProposalActor = { agentConfigId?: string; name?: string };

export type ScheduleProposalPublishResult =
  | { pending: true }
  | { pending: false; outcome: 'created'; scheduleId?: string }
  | { pending: false; outcome: 'dismissed' };

type ProposalDocument = {
  roomId: string;
  sessionData: {
    history: { readAll(): readonly unknown[] };
    commands: { appendTurn(turn: SessionTurn): Promise<void> };
  };
};

const sameDraft = (current: ScheduleProposalMeta, desired: ScheduleProposalMeta): boolean =>
  JSON.stringify({
    ...current,
    outcome: undefined,
    scheduleId: undefined,
  }) === JSON.stringify({ ...desired, outcome: undefined, scheduleId: undefined });

/**
 * Write a schedule proposal card into the invoking conversation.
 *
 * It is a `system_notice` history item, so it survives
 * the turn and stays actionable days later. Idempotent on `proposalId`: a retry
 * with the same draft is a no-op, a retry with a different draft is a conflict,
 * and a proposal the person already acted on reports that outcome instead of
 * being rewritten.
 */
export async function publishScheduleProposal(
  doc: ProposalDocument,
  draft: ScheduleProposalDraft,
  actor: ScheduleProposalActor,
  now: () => number = getServerNow
): Promise<ScheduleProposalPublishResult> {
  const desired: ScheduleProposalMeta = {
    ...draft,
    proposedBy: {
      kind: 'agent',
      ...(actor.agentConfigId ? { agentConfigId: actor.agentConfigId } : {}),
      ...(actor.name ? { name: actor.name } : {}),
    },
  };
  const item: MessageContent = { type: 'system_notice', name: 'schedule_proposal', meta: desired };
  const entryId = `schedule-proposal-${draft.proposalId}`;
  const existing = readSessionHistory(doc.sessionData.history).find(
    (entry) => entry.id === entryId
  );
  if (!existing) {
    await doc.sessionData.commands.appendTurn({
      id: entryId,
      role: 'system',
      timestamp: new Date(now()).toISOString(),
      items: [item],
      fileDiff: [],
      finished: true,
    });
    return { pending: true };
  }
  const prior = (existing.items as MessageContent[] | undefined)?.find(
    (candidate) => candidate.type === 'system_notice' && candidate.name === 'schedule_proposal'
  );
  const current =
    prior?.type === 'system_notice' && prior.name === 'schedule_proposal'
      ? (prior.meta as ScheduleProposalMeta | undefined)
      : undefined;
  if (!current || !sameDraft(current, desired)) throw new Error('Idempotency key conflict');
  if (current.outcome === 'created')
    return { pending: false, outcome: 'created', scheduleId: current.scheduleId };
  if (current.outcome === 'dismissed') return { pending: false, outcome: 'dismissed' };
  return { pending: true };
}
