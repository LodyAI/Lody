import type { TaskProposalResolution } from './types';

type ProposalNotice = {
  type?: unknown;
  name?: unknown;
  meta?: { proposalId?: unknown; outcome?: unknown; taskId?: unknown } | undefined;
};

/**
 * Shared, side-effect-free planner for a task-proposal decision. Both the Loro
 * adapter and the in-memory double run this on the *live* entry they locate at
 * commit time, so a rendered snapshot is never written back.
 *
 * Returns whether the proposal was found. Only the first matching notice is
 * resolved, matching the previous single-item behaviour.
 */
export function resolveTaskProposalOnEntry(
  entry: { items?: unknown },
  proposalId: string,
  resolution: TaskProposalResolution
): boolean {
  const items = Array.isArray(entry.items) ? (entry.items as ProposalNotice[]) : [];
  for (const item of items) {
    if (
      item?.type === 'system_notice' &&
      item.name === 'task_proposal' &&
      item.meta?.proposalId === proposalId
    ) {
      item.meta.outcome = resolution.outcome;
      if (resolution.taskId !== undefined) item.meta.taskId = resolution.taskId;
      return true;
    }
  }
  return false;
}
