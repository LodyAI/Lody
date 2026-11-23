import { z } from 'zod';
import { isRecord } from '../json-guards';
import type { SubagentTaskPayload } from '../ai';

/**
 * Devin CLI (`devin acp`) publishes subagent lifecycle and attribution through
 * private `cognition.ai/*` `_meta` keys, enabled by the client capability
 * `_meta["cognition.ai/subagentSupport"]: true` sent at `initialize`.
 *
 * - `subagent_started` / `subagent_completed` ride `tool_call_update` rows keyed
 *   by the subagent's own agentId, which becomes the `taskId` merged by the
 *   history applier.
 * - `subagent_context` tags every update a subagent produced; `parentAgentId`
 *   names the owning agent, with `"root"` for the main agent's own output.
 *
 * The protocol is undocumented and may drift between Devin versions, so the
 * parsers fail closed (`null`): unrecognized shapes degrade to ordinary tool
 * calls rather than throwing mid-turn.
 */
export const DEVIN_SUBAGENT_STARTED_META_KEY = 'cognition.ai/subagent_started';
export const DEVIN_SUBAGENT_COMPLETED_META_KEY = 'cognition.ai/subagent_completed';
export const DEVIN_SUBAGENT_CONTEXT_META_KEY = 'cognition.ai/subagent_context';

const DevinSubagentStartedSchema = z.object({
  agentId: z.string().min(1),
  title: z.string().optional(),
  task: z.string().optional(),
  profile: z.string().optional(),
  isBackground: z.boolean().optional(),
  model: z.string().optional(),
});

const DevinSubagentCompletedSchema = z.object({
  agentId: z.string().min(1),
  success: z.boolean().optional(),
  summary: z.string().optional(),
});

const DevinSubagentContextSchema = z.object({
  parentAgentId: z.string().min(1),
});

/**
 * Materialize a Devin lifecycle `_meta` into a task-panel payload, or return
 * null when the update carries no recognizable Devin lifecycle marker.
 */
export const parseDevinSubagentTaskMeta = (meta: unknown): SubagentTaskPayload | null => {
  if (!isRecord(meta)) return null;

  // Terminal wins when a row carries both markers, so a collapsed
  // start+complete update never strands the task in `in_progress`.
  const completed = DevinSubagentCompletedSchema.safeParse(meta[DEVIN_SUBAGENT_COMPLETED_META_KEY]);
  if (completed.success) {
    const c = completed.data;
    const failed = c.success === false;
    return {
      taskId: c.agentId,
      status: failed ? 'failed' : 'completed',
      taskKind: 'subagent',
      event: 'task_notification',
      ...(c.summary !== undefined ? { summary: c.summary } : {}),
      ...(failed && c.summary !== undefined ? { error: c.summary } : {}),
    };
  }

  const started = DevinSubagentStartedSchema.safeParse(meta[DEVIN_SUBAGENT_STARTED_META_KEY]);
  if (started.success) {
    const s = started.data;
    const description = s.title ?? s.task;
    return {
      taskId: s.agentId,
      status: 'in_progress',
      taskKind: 'subagent',
      event: 'task_started',
      ...(description !== undefined ? { description } : {}),
      ...(s.profile !== undefined ? { subagentType: s.profile } : {}),
      ...(s.model !== undefined ? { modelId: s.model } : {}),
      ...(s.isBackground !== undefined ? { isBackgrounded: s.isBackground } : {}),
    };
  }

  return null;
};

/**
 * Id of the subagent that produced this update, or null for untagged updates
 * and for the main agent itself (`parentAgentId: "root"`). A nested subagent's
 * lifecycle row can itself be context-tagged with its parent subagent's id, so
 * callers must check lifecycle markers before dropping on this.
 */
export const getDevinSubagentContextId = (meta: unknown): string | null => {
  if (!isRecord(meta)) return null;
  const parsed = DevinSubagentContextSchema.safeParse(meta[DEVIN_SUBAGENT_CONTEXT_META_KEY]);
  if (!parsed.success || parsed.data.parentAgentId === 'root') return null;
  return parsed.data.parentAgentId;
};

/**
 * Whether `_meta` carries any `cognition.ai/subagent*` payload besides the
 * context tag — the lifecycle markers above or a future key this version does
 * not know (`subagent_started`, `subagent_completed`, control/list surfaces
 * such as `subagentControl` or `subagents/*`). Such updates must pass through
 * rather than be dropped, so a malformed or drifted lifecycle row degrades to
 * a visible tool call instead of silently disappearing.
 */
export const hasOtherDevinSubagentMeta = (meta: unknown): boolean =>
  isRecord(meta) &&
  Object.keys(meta).some(
    (key) => key.startsWith('cognition.ai/subagent') && key !== DEVIN_SUBAGENT_CONTEXT_META_KEY
  );
