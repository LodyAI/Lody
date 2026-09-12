import { z } from 'zod';
import { parseHistoryWrite } from '../history-write-schema';
import type { PermissionOutcome } from '../message';
import type { OpenAssistantTurnInput, TaskProposalResolution } from './types';

// # Shared session commands, single source
//
// The business rules for the domain commands live here once. The Loro adapter
// applies them inside the shared writer's conditional commit; the independent
// in-memory double applies them to a detached turn. Neither adapter re-states
// the rule, so a change here cannot drift between them.

type Draft = Record<string, unknown>;

const asRecord = (value: unknown): Draft | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Draft)
    : undefined;

/** Reopen: an explicit non-terminal state, and the two end markers removed. */
export function applyResumeAssistant(draft: Draft): void {
  draft.finished = false;
  delete draft.endedAt;
  delete draft.permissionWaitMs;
}

/**
 * Reopen an existing assistant turn. Provenance is filled only where the stored
 * turn has none, so a re-dispatch never overwrites what a peer already wrote.
 */
export function applyOpenAssistantTurn(draft: Draft, input: OpenAssistantTurnInput): void {
  applyResumeAssistant(draft);
  if (draft.userTurnId === undefined && input.userTurnId !== undefined)
    draft.userTurnId = input.userTurnId;
  if (input.modelInfo !== undefined) draft.modelInfo = input.modelInfo;
}

/** The fresh assistant turn `openAssistantTurn` creates when none exists. */
export function createAssistantTurn(input: OpenAssistantTurnInput): Draft {
  return {
    id: input.turnId,
    role: 'assistant',
    timestamp: input.timestamp,
    ...(input.userTurnId !== undefined ? { userTurnId: input.userTurnId } : {}),
    ...(input.modelInfo !== undefined ? { modelInfo: input.modelInfo } : {}),
    items: [],
    fileDiff: [],
  };
}

/**
 * Write a permission outcome onto the first matching tool call in one turn.
 * Returns whether a request matched.
 */
export function applyRespondPermission(
  draft: Draft,
  requestId: string,
  outcome: PermissionOutcome
): boolean {
  const items = Array.isArray(draft.items) ? draft.items : [];
  for (const item of items) {
    const record = asRecord(item);
    if (record?.type !== 'tool_call') continue;
    const request = asRecord(record.permissionRequest);
    if (request?.requestId !== requestId) continue;
    record.permissionRequest = { ...request, outcome };
    return true;
  }
  return false;
}

/**
 * Shared, side-effect-free planner for a task-proposal decision. Only the first
 * matching notice is resolved, matching the previous single-item behaviour.
 */
export function resolveTaskProposalOnEntry(
  entry: { items?: unknown },
  proposalId: string,
  resolution: TaskProposalResolution
): boolean {
  const items = Array.isArray(entry.items) ? entry.items : [];
  for (const item of items) {
    const notice = asRecord(item);
    if (
      notice?.type === 'system_notice' &&
      notice.name === 'task_proposal' &&
      asRecord(notice.meta)?.proposalId === proposalId
    ) {
      const meta = asRecord(notice.meta)!;
      meta.outcome = resolution.outcome;
      if (resolution.taskId !== undefined) meta.taskId = resolution.taskId;
      return true;
    }
  }
  return false;
}

export function hasTaskProposal(entry: { items?: unknown }, proposalId: string): boolean {
  const items = Array.isArray(entry.items) ? entry.items : [];
  return items.some((item) => {
    const notice = asRecord(item);
    return (
      notice?.type === 'system_notice' &&
      notice.name === 'task_proposal' &&
      asRecord(notice.meta)?.proposalId === proposalId
    );
  });
}

const TaskProposalResolutionSchema = z
  .object({ outcome: z.enum(['created', 'dismissed']), taskId: z.string().optional() })
  .strict();

/** Validate a caller-supplied decision before any write is attempted. */
export function parseTaskProposalResolution(value: unknown): TaskProposalResolution {
  return parseHistoryWrite(TaskProposalResolutionSchema, value) as TaskProposalResolution;
}
