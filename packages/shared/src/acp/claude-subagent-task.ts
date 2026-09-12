import { z } from 'zod';
import { isRecord } from '../json-guards';
import type { SubagentTaskPayload } from '../ai';

/**
 * Subagent/background/scheduled task persistence helpers.
 *
 * New ACP adapters publish task snapshots through `_meta.lody.task`. The legacy
 * raw-input carriers below remain only so the centralized one-release migration
 * path can replay history produced by earlier Claude and Kimi runtimes. The
 * history applier converts either shape into a first-class `subagent_task` item
 * merged by `taskId`; the persisted store never contains the carrier key.
 */

/**
 * Legacy internal wire key, stripped when the history applier materializes the
 * `subagent_task` item.
 */
export const LODY_CLAUDE_TASK_LIFECYCLE_RAW_INPUT_KEY = 'lodyClaudeTaskLifecycle';
/** Provider-neutral carrier used by newer builtin ACP adapters. */
export const LODY_SUBAGENT_TASK_LIFECYCLE_RAW_INPUT_KEY = 'lodySubagentTaskLifecycle';

export const SUBAGENT_TASK_EVENTS = [
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification',
] as const;

export const SUBAGENT_TASK_STATUSES = ['pending', 'in_progress', 'completed', 'failed'] as const;

const SubagentTaskUsageSchema = z.object({
  totalTokens: z.number().optional(),
  toolUses: z.number().optional(),
  durationMs: z.number().optional(),
});

/** Runtime validator for a persisted `subagent_task` payload (foreign data). */
export const SubagentTaskPayloadSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(SUBAGENT_TASK_STATUSES),
  taskKind: z.enum(['subagent', 'background', 'scheduled']).optional(),
  actor: z.string().optional(),
  parentTaskId: z.string().optional(),
  modelId: z.string().optional(),
  startedAtEpochSeconds: z.number().nonnegative().optional(),
  endedAtEpochSeconds: z.number().nonnegative().optional(),
  event: z.enum(SUBAGENT_TASK_EVENTS).optional(),
  toolUseId: z.string().optional(),
  subagentType: z.string().optional(),
  taskType: z.string().optional(),
  workflowName: z.string().optional(),
  description: z.string().optional(),
  summary: z.string().optional(),
  rawStatus: z.string().optional(),
  usage: SubagentTaskUsageSchema.optional(),
  lastToolName: z.string().optional(),
  isBackgrounded: z.boolean().optional(),
  error: z.string().optional(),
  skipTranscript: z.boolean().optional(),
  hasOutputFile: z.boolean().optional(),
});

const LodyTaskMetaSchema = z.object({
  version: z.literal(1),
  taskId: z.string().min(1),
  kind: z.enum(['subagent', 'background', 'scheduled']),
  status: z.enum(SUBAGENT_TASK_STATUSES),
  event: z.enum(SUBAGENT_TASK_EVENTS).optional(),
  description: z.string().optional(),
  actor: z.string().optional(),
  parentTaskId: z.string().optional(),
  parentToolCallId: z.string().optional(),
  modelId: z.string().optional(),
  startedAtEpochSeconds: z.number().nonnegative().optional(),
  endedAtEpochSeconds: z.number().nonnegative().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  lastToolName: z.string().optional(),
  usage: SubagentTaskUsageSchema.optional(),
  skipTranscript: z.boolean().optional(),
});

/** Read a provider-neutral task lifecycle snapshot from `_meta.lody.task`. */
export const parseLodyTaskMeta = (meta: unknown): SubagentTaskPayload | null => {
  if (!isRecord(meta) || !isRecord(meta.lody)) return null;
  const parsed = LodyTaskMetaSchema.safeParse(meta.lody.task);
  if (!parsed.success) return null;
  const task = parsed.data;
  return {
    taskId: task.taskId,
    status: task.status,
    taskKind: task.kind,
    ...(task.event !== undefined ? { event: task.event } : {}),
    ...(task.actor !== undefined ? { actor: task.actor } : {}),
    ...(task.parentTaskId !== undefined ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.parentToolCallId !== undefined ? { toolUseId: task.parentToolCallId } : {}),
    ...(task.modelId !== undefined ? { modelId: task.modelId } : {}),
    ...(task.startedAtEpochSeconds !== undefined
      ? { startedAtEpochSeconds: task.startedAtEpochSeconds }
      : {}),
    ...(task.endedAtEpochSeconds !== undefined
      ? { endedAtEpochSeconds: task.endedAtEpochSeconds }
      : {}),
    ...(task.description !== undefined ? { description: task.description } : {}),
    ...(task.summary !== undefined ? { summary: task.summary } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
    ...(task.lastToolName !== undefined ? { lastToolName: task.lastToolName } : {}),
    ...(task.usage !== undefined ? { usage: task.usage } : {}),
    isBackgrounded: task.kind === 'background',
    ...(task.skipTranscript !== undefined ? { skipTranscript: task.skipTranscript } : {}),
  };
};

/**
 * Read the subagent-task payload off the internal wire tool_call `rawInput`.
 * Returns `null` when absent or malformed, so the applier can cheaply tell a
 * task-carrying tool_call from an ordinary one.
 */
export const parseSubagentTaskWire = (rawInput: unknown): SubagentTaskPayload | null => {
  if (!isRecord(rawInput)) return null;
  const carrier =
    rawInput[LODY_SUBAGENT_TASK_LIFECYCLE_RAW_INPUT_KEY] ??
    rawInput[LODY_CLAUDE_TASK_LIFECYCLE_RAW_INPUT_KEY];
  if (!isRecord(carrier)) return null;
  const parsed = SubagentTaskPayloadSchema.safeParse(carrier);
  return parsed.success ? (parsed.data as SubagentTaskPayload) : null;
};

/**
 * Merge lifecycle events for the same task while preserving stable identity.
 * Activity descriptions describe the current tool, not the task's purpose, and
 * progress snapshots must not turn a background task back into a foreground
 * subagent. A nonterminal progress event arriving after settlement is stale;
 * explicit starts/updates remain able to resume the same task (for example,
 * Codex `resumeAgent`).
 */
export const mergeSubagentTaskPayload = (
  prev: SubagentTaskPayload,
  incoming: SubagentTaskPayload
): SubagentTaskPayload => {
  const wasSettled = prev.status === 'completed' || prev.status === 'failed';
  const isNonterminal = incoming.status === 'pending' || incoming.status === 'in_progress';
  const explicitlyRestarts = incoming.event === 'task_started' || incoming.event === 'task_updated';

  if (wasSettled && isNonterminal && !explicitlyRestarts) return prev;

  const merged = {
    ...prev,
    ...incoming,
    ...(prev.actor !== undefined ? { actor: prev.actor } : {}),
    ...(prev.description !== undefined ? { description: prev.description } : {}),
  };

  if (prev.isBackgrounded === true || prev.taskKind === 'background') {
    return { ...merged, taskKind: 'background', isBackgrounded: true };
  }
  return merged;
};
