import { useCallback, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import {
  deriveTaskTitle,
  generateTaskOrderKeyAtEnd,
  generateTaskOrderKeyBetween,
  buildTaskIndexRow,
  countTaskLinks,
  summarizeTaskMentions,
  getServerNow,
  getSessionRoomId,
  getTaskIndexFlockDocId,
  isEmptyTaskDraft,
  normalizeTaskLabels,
  taskIndexKeys,
  type ProjectRef,
  type TaskActivityType,
  type TaskAgentRef,
  type TaskDocMeta,
  type TaskDocInput,
  type TaskId,
  type TaskIndexRow,
  type TaskLink,
  type TaskPriority,
  type TaskSessionLinkOrigin,
  type TaskStatus,
  type TaskTimelineEntry,
  type SessionId,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { readSessionHistoryEntry } from '@/lib/session-store-history';
import { activeWorkspaceRuntimeAtom, type TaskDocStore, type WorkspaceRuntime } from '@/atoms/runtime';
import { taskIndexRowsAtom, taskListAtom } from '@/atoms/tasks';

export type CreateTaskInput = {
  title?: string;
  body?: string;
  /**
   * Entrusting the task at creation. Distinct from `lastRunConfig`: setting this
   * is what lets the scheduler start the task unattended, so it must come from
   * an explicit choice, never from merely picking who would run it.
   */
  agent?: TaskAgentRef;
  /** Who would run it. Prefills the next Run; does NOT delegate. */
  lastRunConfig?: TaskAgentRef;
  priority?: TaskPriority;
  labels?: string[];
  /** Defaults to the creator when absent. */
  ownerId?: string;
  projects?: ProjectRef[];
  /**
   * Column the task starts in. Optional and defaulted, so capture stays
   * zero-required-fields; the board's per-column add button uses it so a task
   * created from a column lands in that column.
   */
  status?: TaskStatus;
};

export type TaskFieldsPatch = {
  title?: string;
  status?: TaskStatus;
  /** Empty string or null clears ownership (unassigned). */
  ownerId?: string | null;
  /** Null clears priority (no priority). */
  priority?: TaskPriority | null;
  labels?: string[];
  agent?: TaskAgentRef | null;
  projects?: ProjectRef[];
  lastRunConfig?: TaskAgentRef;
  order?: string;
};

/**
 * Tasks live in two places on purpose: the task document is authoritative, and
 * the workspace index carries the summary that lists and boards draw. Every
 * mutation writes the document first, then republishes the index row from the
 * document's own post-write state, so a lost index write self-heals on the next
 * mutation instead of drifting silently.
 */
export function useTaskActions() {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const user = useAtomValue(userAtom);
  const tasks = useAtomValue(taskListAtom);
  const setRows = useSetAtom(taskIndexRowsAtom);

  const actorName = user?.name;
  const actorId = user?.id;
  // Attach/detach are declared before the link helpers they call, so they reach
  // them through refs rather than forcing a reorder of this file.
  const linkSessionRef = useRef<
    ((taskId: TaskId, sessionId: SessionId, origin: TaskSessionLinkOrigin) => Promise<void>) | null
  >(null);
  const unlinkSessionRef = useRef<((taskId: TaskId, sessionId: SessionId) => Promise<void>) | null>(
    null
  );

  const publishIndexRow = useCallback(
    async (activeRuntime: WorkspaceRuntime, row: TaskIndexRow) => {
      setRows((previous) => ({ ...previous, [row.taskId]: row }));
      await activeRuntime.writer.flockRowPut(
        getTaskIndexFlockDocId(activeRuntime.workspaceId),
        taskIndexKeys.task(row.taskId as TaskId),
        row
      );
    },
    [setRows]
  );

  /** Republish the index row from the document's current state. */
  const syncIndexRow = useCallback(
    async (activeRuntime: WorkspaceRuntime, store: TaskDocStore) => {
      const state = store.getState() as unknown as {
        meta: TaskDocMeta;
        links?: TaskLink[];
        timeline?: TaskTimelineEntry[];
      };
      await publishIndexRow(
        activeRuntime,
        buildTaskIndexRow(
          state.meta,
          countTaskLinks(state.links ?? []),
          summarizeTaskMentions(state.timeline ?? [])
        )
      );
    },
    [publishIndexRow]
  );

  const appendTimelineEntry = useCallback(
    (draft: TaskDocInput, entry: TaskTimelineEntry) => {
      const timeline = (draft as unknown as { timeline: TaskTimelineEntry[] }).timeline;
      timeline.push(entry);
    },
    []
  );

  const buildActivityEntry = useCallback(
    (activityType: TaskActivityType, activityData?: Record<string, string>): TaskTimelineEntry => ({
      id: uuidv4(),
      kind: 'activity',
      actorKind: 'human',
      ...(actorId ? { actorId } : {}),
      ...(actorName ? { actorName } : {}),
      createdAt: getServerNow(),
      activityType,
      ...(activityData ? { activityData } : {}),
    }),
    [actorId, actorName]
  );

  const createTask = useCallback(
    async (input: CreateTaskInput): Promise<TaskId | null> => {
      if (!runtime || isEmptyTaskDraft(input)) {
        return null;
      }
      const taskId = uuidv4() as TaskId;
      const now = getServerNow();
      const title = deriveTaskTitle(input);
      const order = generateTaskOrderKeyAtEnd(
        tasks.map((task) => task.order),
        Math.random
      );
      const meta: TaskDocMeta = {
        taskId,
        title,
        status: input.status ?? 'backlog',
        ownerId: input.ownerId ?? actorId ?? '',
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.labels && input.labels.length > 0
          ? { labels: normalizeTaskLabels(input.labels) }
          : {}),
        ...(input.lastRunConfig ? { lastRunConfig: input.lastRunConfig } : {}),
        order,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.projects && input.projects.length > 0 ? { projects: input.projects } : {}),
        createdAt: now,
        updatedAt: now,
        ...(actorId ? { createdBy: actorId } : {}),
      };

      await runtime.withTaskStore(taskId, async (store) => {
        store.setState((draft: TaskDocInput) => {
          Object.assign(draft.meta as unknown as TaskDocMeta, meta);
          (draft as unknown as { body: string }).body = input.body ?? '';
          appendTimelineEntry(draft, buildActivityEntry('created'));
        });
        await syncIndexRow(runtime, store);
      });

      return taskId;
    },
    [actorId, appendTimelineEntry, buildActivityEntry, runtime, syncIndexRow, tasks]
  );

  const updateTaskFields = useCallback(
    async (taskId: TaskId, patch: TaskFieldsPatch): Promise<void> => {
      if (!runtime) {
        return;
      }
      await runtime.withTaskStore(taskId, async (store) => {
        const before = (store.getState() as unknown as { meta: TaskDocMeta }).meta;
        const activities: TaskTimelineEntry[] = [];
        if (patch.status !== undefined && patch.status !== before.status) {
          activities.push(
            buildActivityEntry('status_changed', { from: before.status, to: patch.status })
          );
        }
        if (patch.ownerId !== undefined) {
          const nextOwnerId = patch.ownerId ?? '';
          if (nextOwnerId !== (before.ownerId ?? '')) {
            activities.push(
              buildActivityEntry('owner_changed', nextOwnerId ? { to: nextOwnerId } : {})
            );
          }
        }
        if (patch.agent !== undefined) {
          const nextAgentId = patch.agent?.agentConfigId ?? '';
          if (nextAgentId !== (before.agent?.agentConfigId ?? '')) {
            activities.push(
              buildActivityEntry('agent_changed', nextAgentId ? { to: nextAgentId } : {})
            );
          }
        }

        store.setState((draft: TaskDocInput) => {
          const meta = draft.meta as unknown as TaskDocMeta;
          if (patch.title !== undefined) {
            meta.title = patch.title;
          }
          if (patch.status !== undefined) {
            meta.status = patch.status;
          }
          if (patch.ownerId !== undefined) {
            meta.ownerId = patch.ownerId ?? '';
          }
          if (patch.priority !== undefined) {
            if (patch.priority === null) {
              delete meta.priority;
            } else {
              meta.priority = patch.priority;
            }
          }
          if (patch.labels !== undefined) {
            meta.labels = normalizeTaskLabels(patch.labels);
          }
          if (patch.order !== undefined) {
            meta.order = patch.order;
          }
          if (patch.projects !== undefined) {
            meta.projects = patch.projects;
          }
          if (patch.lastRunConfig !== undefined) {
            meta.lastRunConfig = patch.lastRunConfig;
          }
          if (patch.agent !== undefined) {
            if (patch.agent === null) {
              delete meta.agent;
            } else {
              meta.agent = patch.agent;
            }
          }
          meta.updatedAt = getServerNow();
          for (const activity of activities) {
            appendTimelineEntry(draft, activity);
          }
        });
        await syncIndexRow(runtime, store);
      });
    },
    [appendTimelineEntry, buildActivityEntry, runtime, syncIndexRow]
  );

  const setTaskStatus = useCallback(
    (taskId: TaskId, status: TaskStatus) => updateTaskFields(taskId, { status }),
    [updateTaskFields]
  );

  const setTaskBody = useCallback(
    async (taskId: TaskId, body: string): Promise<void> => {
      if (!runtime) {
        // The editor treats fulfillment as a durable local acknowledgement.
        // A no-op here would falsely mark the draft synced and let the empty
        // document snapshot replace it when the runtime returns.
        throw new Error('Runtime not ready');
      }
      await runtime.withTaskStore(taskId, async (store) => {
        store.setState((draft: TaskDocInput) => {
          (draft as unknown as { body: string }).body = body;
          (draft.meta as unknown as TaskDocMeta).updatedAt = getServerNow();
        });
        await syncIndexRow(runtime, store);
      });
    },
    [runtime, syncIndexRow]
  );

  /**
   * Attaches an existing session: writes the provenance record on the task and
   * the back-pointer on the session, so both sides agree about the association.
   */
  const attachSession = useCallback(
    async (taskId: TaskId, sessionId: SessionId): Promise<void> => {
      if (!runtime) {
        return;
      }
      await linkSessionRef.current?.(taskId, sessionId, 'manual-attach');
      await runtime.writer.upsertDocMeta(getSessionRoomId(sessionId), { taskId });
    },
    [runtime]
  );

  const detachSession = useCallback(
    async (taskId: TaskId, sessionId: SessionId): Promise<void> => {
      if (!runtime) {
        return;
      }
      await unlinkSessionRef.current?.(taskId, sessionId);
      // Clearing the pointer keeps the session from claiming a task it is no
      // longer recorded under.
      await runtime.writer.upsertDocMeta(getSessionRoomId(sessionId), { taskId: undefined });
    },
    [runtime]
  );

  const linkSession = useCallback(
    async (
      taskId: TaskId,
      sessionId: SessionId,
      origin: TaskSessionLinkOrigin,
      options: { parentSessionId?: SessionId } = {}
    ): Promise<void> => {
      if (!runtime) {
        return;
      }
      await runtime.withTaskStore(taskId, async (store) => {
        const existing = (store.getState() as unknown as { links?: TaskLink[] }).links ?? [];
        if (
          existing.some((link) => link.sessionId === sessionId && link.removedAt === undefined)
        ) {
          return;
        }
        store.setState((draft: TaskDocInput) => {
          const links = (draft as unknown as { links: TaskLink[] }).links;
          links.push({
            id: uuidv4(),
            kind: 'session',
            sessionId,
            origin,
            actorKind: 'human',
            ...(actorId ? { actorId } : {}),
            ...(actorName ? { actorName } : {}),
            ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
            linkedAt: getServerNow(),
          });
          appendTimelineEntry(draft, buildActivityEntry('session_linked', { origin }));
        });
        await syncIndexRow(runtime, store);
      });
    },
    [actorId, actorName, appendTimelineEntry, buildActivityEntry, runtime, syncIndexRow]
  );

  const unlinkSession = useCallback(
    async (taskId: TaskId, sessionId: SessionId): Promise<void> => {
      if (!runtime) {
        return;
      }
      await runtime.withTaskStore(taskId, async (store) => {
        store.setState((draft: TaskDocInput) => {
          const links = (draft as unknown as { links: TaskLink[] }).links;
          for (const link of links) {
            if (link.sessionId === sessionId && link.removedAt === undefined) {
              link.removedAt = getServerNow();
            }
          }
        });
        await syncIndexRow(runtime, store);
      });
    },
    [runtime, syncIndexRow]
  );

  const appendComment = useCallback(
    async (
      taskId: TaskId,
      input: {
        body: string;
        mentions?: string[];
        agentMentions?: string[];
        quote?: string;
        dispatchedSessionId?: SessionId;
      }
    ): Promise<void> => {
      if (!runtime || input.body.trim().length === 0) {
        return;
      }
      await runtime.withTaskStore(taskId, async (store) => {
        store.setState((draft: TaskDocInput) => {
          (draft.meta as unknown as TaskDocMeta).updatedAt = getServerNow();
          appendTimelineEntry(draft, {
            id: uuidv4(),
            kind: 'comment',
            actorKind: 'human',
            ...(actorId ? { actorId } : {}),
            ...(actorName ? { actorName } : {}),
            createdAt: getServerNow(),
            body: input.body,
            ...(input.mentions && input.mentions.length > 0 ? { mentions: input.mentions } : {}),
            ...(input.agentMentions && input.agentMentions.length > 0
              ? { agentMentions: input.agentMentions }
              : {}),
            ...(input.quote ? { quote: input.quote } : {}),
            ...(input.dispatchedSessionId
              ? { dispatchedSessionId: input.dispatchedSessionId }
              : {}),
          });
        });
        // The index carries lastCommentAt and mentionedUserIds, which is what the
        // unread badge reads. Without this republish a comment — and every
        // @person in it — stayed invisible outside the open task page.
        await syncIndexRow(runtime, store);
      });
    },
    [actorId, actorName, appendTimelineEntry, runtime, syncIndexRow]
  );

  /** Move a task between two neighbours without renumbering siblings. */
  const reorderTask = useCallback(
    async (taskId: TaskId, beforeOrder: string | null, afterOrder: string | null) => {
      const order = generateTaskOrderKeyBetween(beforeOrder, afterOrder, Math.random);
      await updateTaskFields(taskId, { order });
    },
    [updateTaskFields]
  );

  /**
   * Records the outcome of an agent's task proposal on the history item that
   * carries it, so the card shows what was decided instead of asking again.
   */
  const resolveTaskProposal = useCallback(
    async (
      sessionId: SessionId,
      entryId: string,
      itemIndex: number,
      nextMeta: Record<string, unknown>
    ): Promise<void> => {
      if (!runtime) {
        return;
      }
      const entry = await runtime.withSessionStore(sessionId, (sessionStore) =>
        readSessionHistoryEntry(sessionStore, entryId)
      );
      if (!entry) {
        return;
      }
      const items = Array.isArray(entry.items) ? [...(entry.items as unknown[])] : [];
      const target = items[itemIndex];
      if (!target || typeof target !== 'object') {
        return;
      }
      items[itemIndex] = { ...(target as Record<string, unknown>), meta: nextMeta };
      await runtime.writer.updateSessionHistory(sessionId, entryId, {
        ...(entry as unknown as Record<string, unknown>),
        items,
      });
    },
    [runtime]
  );

  linkSessionRef.current = linkSession;
  unlinkSessionRef.current = unlinkSession;

  return {
    createTask,
    attachSession,
    detachSession,
    updateTaskFields,
    setTaskStatus,
    setTaskBody,
    linkSession,
    unlinkSession,
    appendComment,
    reorderTask,
    resolveTaskProposal,
  };
}
