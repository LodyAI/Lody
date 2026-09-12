import { z } from 'zod';
import { isSessionGoalActive, resolveLatestSessionGoalFromHistory } from '../goal';
import { parseHistoryWrite } from '../history-write-schema';
import type { PermissionOutcome } from '../message';
import type {
  OpenAssistantTurnInput,
  ReplaceEditableTailInput,
  SessionEditableTailRejectionCode,
  SessionTurn,
  TaskProposalResolution,
} from './types';

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
 * Execution states that `seen` must never overwrite. `seen` is a read
 * acknowledgement, not an execution outcome: a turn that already started or
 * finished must not be pulled back to `seen` by a read that observed `pending`
 * before the writer advanced it. `pending_apply` is a pre-submission state that
 * still carries pending work, so it is not treated as unread either.
 */
const SEEN_REGRESSION_BLOCKED = new Set<string>([
  'processing',
  'handled',
  'failed',
  'canceled',
  'pending_apply',
]);

/** Whether marking this turn seen would regress an advanced execution state. */
export function markTurnSeenBlocked(draft: Draft): boolean {
  return typeof draft.status === 'string' && SEEN_REGRESSION_BLOCKED.has(draft.status);
}

/**
 * Mark a turn seen. Returns whether it changed anything; the legacy `read` flag
 * is derived from the same mapping the storage layer uses for `seen`.
 *
 * Callers must check `markTurnSeenBlocked` first: `seen` only advances an unread
 * or absent-status turn, and an advanced execution state stays untouched.
 */
export function applyMarkTurnSeen(draft: Draft): boolean {
  if (draft.status === 'seen' && draft.read === true) return false;
  draft.status = 'seen';
  draft.read = true;
  return true;
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

// # Editable tail rules
//
// The eligibility rule for "the last user turn the user may still edit" and the
// active-goal guard are stated here once. Both the CLI's pre-commit eligibility
// check and the storage command's commit-time re-check call `resolveEditableTail`
// and `planEditableTailReplacement`, so the pre-check and the commit can never
// drift into accepting different tails.

/** The fields the editable-tail rule inspects; structurally satisfied by turns. */
export type EditableTailTurn = {
  readonly id?: unknown;
  readonly role?: unknown;
  readonly status?: unknown;
  readonly inputConfig?: unknown;
  readonly finished?: unknown;
  readonly acpTurnId?: unknown;
};

export type EditableTail<T extends EditableTailTurn = EditableTailTurn> = {
  readonly userIndex: number;
  readonly turn: T;
  /** `acpTurnId` of the provider boundary preceding the tail, when there is one. */
  readonly forkTurnId?: string;
};

/**
 * Locate the editable tail: the last user turn, which must be `expectedUserTurnId`,
 * not parked in `pending_apply` and not a steer delivery. A preceding user turn
 * without an intervening finished provider boundary makes the tail uneditable.
 */
export function resolveEditableTail<T extends EditableTailTurn>(
  turns: readonly T[],
  expectedUserTurnId: string
): EditableTail<T> | null {
  let userIndex = -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.role === 'user') {
      userIndex = index;
      break;
    }
  }
  const turn = turns[userIndex];
  if (userIndex < 0 || !turn || turn.id !== expectedUserTurnId || turn.role !== 'user') return null;
  if (
    turn.status === 'pending_apply' ||
    asRecord(turn.inputConfig)?._lodyDeliveryKind === 'steer'
  ) {
    return null;
  }

  for (let index = userIndex - 1; index >= 0; index -= 1) {
    const entry = turns[index];
    if (!entry) continue;
    if (entry.role === 'user') return null;
    if (entry.role !== 'assistant') continue;
    if (entry.finished !== true || typeof entry.acpTurnId !== 'string' || !entry.acpTurnId) {
      return null;
    }
    return { userIndex, turn, forkTurnId: entry.acpTurnId };
  }

  return { userIndex, turn };
}

/** A domain refusal the storage adapter reports as `rejected`, never as a write. */
export class EditableTailRefusedError extends Error {
  constructor(readonly code: Exclude<SessionEditableTailRejectionCode, 'unsupported'>) {
    super(`The editable tail replacement was refused: ${code}`);
    this.name = 'EditableTailRefusedError';
  }
}

export type EditableTailPlan = {
  readonly turns: SessionTurn[];
  readonly previousUserTurnId?: string;
};

/**
 * Plan the replacement against the turns read at commit time. Throws
 * `EditableTailRefusedError` before any write for an invalid replacement, an
 * active goal, or a tail whose identity/boundary no longer matches.
 */
export function planEditableTailReplacement(
  turns: readonly SessionTurn[],
  input: ReplaceEditableTailInput
): EditableTailPlan {
  if (input.replacement.role !== 'user' || !input.replacement.id) {
    throw new EditableTailRefusedError('invalid_input');
  }
  const goal = resolveLatestSessionGoalFromHistory(turns) ?? input.fallbackGoal ?? null;
  if (isSessionGoalActive(goal)) throw new EditableTailRefusedError('active_goal');
  const tail = resolveEditableTail(turns, input.expectedUserTurnId);
  if (!tail || tail.forkTurnId !== input.expectedForkTurnId) {
    throw new EditableTailRefusedError('stale_boundary');
  }
  const prefix = turns.slice(0, tail.userIndex);
  let previousUserTurnId: string | undefined;
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    const entry = prefix[index];
    if (entry?.role === 'user' && typeof entry.id === 'string') {
      previousUserTurnId = entry.id;
      break;
    }
  }
  return {
    turns: [...prefix, input.replacement],
    ...(previousUserTurnId !== undefined ? { previousUserTurnId } : {}),
  };
}
