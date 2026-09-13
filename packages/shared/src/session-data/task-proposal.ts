import type { MessageContent, TaskProposalMeta } from '../ai';
import { TaskProposalMetaSchema } from '../message-schemas';
import type { SessionEntry } from './domain';
export class HistoryActionRefused extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}
export type TaskProposalPublishResult =
  | { pending: true }
  | { pending: false; outcome: 'created'; taskId?: string }
  | { pending: false; outcome: 'dismissed' };
const sameActor = (
  current: TaskProposalMeta['proposedBy'],
  desired: TaskProposalMeta['proposedBy']
): boolean =>
  current?.kind === desired?.kind &&
  current?.agentConfigId === desired?.agentConfigId &&
  current?.name === desired?.name;

const samePendingProposal = (current: TaskProposalMeta, desired: TaskProposalMeta): boolean =>
  current.proposalId === desired.proposalId &&
  current.title === desired.title &&
  current.body === desired.body &&
  current.outcome === undefined &&
  current.taskId === undefined &&
  sameActor(current.proposedBy, desired.proposedBy);

export function planTaskProposal(
  history: SessionEntry[],
  turnId: string,
  desiredMeta: TaskProposalMeta,
  timestamp: string
) {
  const desiredItem: MessageContent = {
    type: 'system_notice',
    name: 'task_proposal',
    meta: desiredMeta,
  };
  let changed = false;
  let result: TaskProposalPublishResult = { pending: true };
  const apply = (): SessionEntry[] => {
    const existingIndex = history.findIndex((entry) => entry.id === turnId);
    if (existingIndex < 0) {
      changed = true;
      return [
        ...history,
        {
          id: turnId,
          role: 'system',
          timestamp: timestamp,
          items: [desiredItem],
          fileDiff: [],
          finished: true,
        },
      ];
    }

    const existing = history[existingIndex];
    const proposalItemIndex = existing?.items?.findIndex(
      (item) => item.type === 'system_notice' && item.name === 'task_proposal'
    );
    const proposalItem =
      proposalItemIndex !== undefined && proposalItemIndex >= 0
        ? existing?.items?.[proposalItemIndex]
        : undefined;
    const existingMetaValue =
      proposalItem?.type === 'system_notice' && proposalItem.name === 'task_proposal'
        ? proposalItem.meta
        : undefined;
    const parsedExistingMeta = TaskProposalMetaSchema.safeParse(existingMetaValue);
    const existingMeta = parsedExistingMeta.success ? parsedExistingMeta.data : undefined;

    if (!existing || proposalItemIndex === undefined || proposalItemIndex < 0 || !existingMeta) {
      throw new HistoryActionRefused(
        'TASK_PROPOSAL_ID_CONFLICT',
        `History entry ${turnId} exists but is not a task proposal. Use a different proposalId.`
      );
    }
    if (existingMeta.proposalId !== desiredMeta.proposalId) {
      throw new HistoryActionRefused(
        'TASK_PROPOSAL_ID_CONFLICT',
        `History entry ${turnId} belongs to a different proposal. Use a different proposalId.`
      );
    }
    if (existingMeta.outcome === 'created') {
      result = {
        pending: false,
        outcome: 'created',
        ...(existingMeta.taskId ? { taskId: existingMeta.taskId } : {}),
      };
      return history;
    }
    if (existingMeta.outcome === 'dismissed') {
      result = { pending: false, outcome: 'dismissed' };
      return history;
    }
    if (samePendingProposal(existingMeta, desiredMeta)) {
      return history;
    }

    const items = [...(existing.items ?? [])];
    items[proposalItemIndex] = desiredItem;
    const nextHistory = [...history];
    nextHistory[existingIndex] = { ...existing, items };
    changed = true;
    return nextHistory;
  };
  const turns = apply();
  return { turns, matched: changed, proposal: result };
}
