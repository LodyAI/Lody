import { InferInputType, InferType, schema } from 'loro-mirror';

import type { SessionId, TaskId } from './ids';
import type {
  TaskActivityType,
  TaskActorKind,
  TaskLinkKind,
  TaskPrProvider,
  TaskPriority,
  TaskSessionLinkOrigin,
  TaskStatus,
  TaskTimelineEntryKind,
} from './task-types';

/**
 * A task document is the source of truth for one task: its scalar fields, the
 * collaborative body, the association records, and the thread.
 *
 * Scalars live in a `LoroMap` so two people editing different fields (one moves
 * status, one reassigns the owner) merge instead of overwriting each other. The
 * body is an explicit `LoroText` so human edits and agent splices merge at the
 * character level. Values that are always replaced as a whole (the entrusted
 * agent, the project list) are stored as plain JSON.
 */
export const taskMetaSchema = schema.LoroMap({
  taskId: schema.String<TaskId>(),
  title: schema.String(),
  status: schema.String<TaskStatus>(),
  /**
   * Human user id, or empty string when unassigned. Never an agent id.
   * Empty is allowed so capture and triage can leave ownership open.
   */
  ownerId: schema.String(),
  /** Fractional index for manual ordering. */
  order: schema.String(),
  /** `TaskPriority` — absent means no priority. */
  priority: schema.String<TaskPriority>({ required: false }),
  /** `string[]` of normalized labels — replaced as a whole. */
  labels: schema.Any({ required: false }),
  /** `TaskAgentRef` — absent means this task is never automated. */
  agent: schema.Any({ required: false }),
  /** `ProjectRef[]` — replaced as a whole. */
  projects: schema.Any({ required: false }),
  /** `TaskAgentRef` selected by the last manual Run, used to prefill re-runs. */
  lastRunConfig: schema.Any({ required: false }),
  createdAt: schema.Number(),
  updatedAt: schema.Number(),
  createdBy: schema.String({ required: false }),
});

export const taskLinkSchema = schema.LoroMap({
  id: schema.String(),
  kind: schema.String<TaskLinkKind>(),
  actorKind: schema.String<TaskActorKind>(),
  actorId: schema.String({ required: false }),
  actorName: schema.String({ required: false }),
  linkedAt: schema.Number(),
  /** Detaching writes a tombstone instead of dropping the record. */
  removedAt: schema.Number({ required: false }),
  sessionId: schema.String<SessionId>({ required: false }),
  origin: schema.String<TaskSessionLinkOrigin>({ required: false }),
  parentSessionId: schema.String<SessionId>({ required: false }),
  provider: schema.String<TaskPrProvider>({ required: false }),
  url: schema.String({ required: false }),
  originSessionId: schema.String<SessionId>({ required: false }),
});

export const taskTimelineEntrySchema = schema.LoroMap({
  id: schema.String(),
  kind: schema.String<TaskTimelineEntryKind>(),
  actorKind: schema.String<TaskActorKind>(),
  actorId: schema.String({ required: false }),
  actorName: schema.String({ required: false }),
  createdAt: schema.Number(),
  body: schema.String({ required: false }),
  /** Mentioned user ids. */
  mentions: schema.LoroList(schema.String(), undefined, { required: false }),
  /** Mentioned agent config ids; mentioning an agent is what dispatches. */
  agentMentions: schema.LoroList(schema.String(), undefined, { required: false }),
  dispatchedSessionId: schema.String<SessionId>({ required: false }),
  originSessionId: schema.String<SessionId>({ required: false }),
  quote: schema.String({ required: false }),
  /** Reserved for anchored comments; never written in v1. */
  anchor: schema.String({ required: false }),
  activityType: schema.String<TaskActivityType>({ required: false }),
  /** Compact activity payload, e.g. `{ from, to }` for a status change. */
  activityData: schema.Any({ required: false }),
});

/** Root schema for a task doc; see `sessionDocSchema` on adding root fields. */
export const taskDocSchema = schema({
  meta: taskMetaSchema,
  body: schema.LoroText(),
  links: schema.LoroList(taskLinkSchema, (item: { id: string }) => item.id),
  timeline: schema.LoroList(taskTimelineEntrySchema, (item: { id: string }) => item.id),
});

export type TaskDocState = InferType<typeof taskDocSchema>;
export type TaskDocInput = InferInputType<typeof taskDocSchema>;
