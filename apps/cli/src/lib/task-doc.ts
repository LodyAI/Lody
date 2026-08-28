import { Mirror } from 'loro-mirror';
import type { LoroDoc } from 'loro-crdt';
import {
  buildTaskIndexRow,
  countTaskLinks,
  deriveTaskTitle,
  generateTaskOrderKeyAtEnd,
  getServerNow,
  getTaskIdFromRoomId,
  getTaskIndexFlockDocId,
  getTaskIndexScanPrefix,
  getTaskRoomId,
  isEmptyTaskDraft,
  isTaskDocRoomId,
  isLoroRepoDocDeleted,
  listVisibleTaskIndexRows,
  normalizeProjectRefForDedup,
  normalizeTaskLabels,
  parseTaskIndexRow,
  readTaskIndexRows,
  summarizeTaskMentions,
  TASK_ORDER_MIN_KEY,
  taskDocSchema,
  taskIndexKeys,
  type ProjectRef,
  type TaskActivityType,
  type TaskDocMeta,
  type TaskId,
  type TaskIndexRow,
  type TaskIndexRowMap,
  type TaskLink,
  type TaskPrProvider,
  type TaskPriority,
  type TaskSessionLinkOrigin,
  type TaskStatus,
  type TaskTimelineEntry,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import { listAliveRoomIds } from './command-runtime';
import type { LoroDocumentManager } from './loro/doc';

export type TaskSnapshot = {
  meta: TaskDocMeta;
  body: string;
  links: TaskLink[];
  timeline: TaskTimelineEntry[];
};

const randomId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `t${getServerNow()}${Math.floor(Math.random() * 1e6)}`;

/**
 * Container seed for a brand-new task document, matching the app's
 * `createTaskStore`. The real values are assigned in the same transaction, so
 * these placeholders never reach a reader.
 */
const emptyTaskDocState = (taskId: TaskId) => ({
  meta: {
    taskId,
    title: '',
    status: 'backlog' as TaskStatus,
    ownerId: '',
    order: TASK_ORDER_MIN_KEY,
    priority: undefined,
    labels: undefined,
    agent: undefined,
    projects: undefined,
    lastRunConfig: undefined,
    createdAt: 0,
    updatedAt: 0,
    createdBy: undefined,
  },
  body: '',
  links: [],
  timeline: [],
});

/**
 * Opens a task document for one operation.
 *
 * Callers run inside a one-shot workspace manager whose transport is torn down
 * as soon as the callback returns, so a write must be flushed and pushed before
 * the handle is released — otherwise it strands in the local store.
 */
const withTaskMirror = async <T>(
  manager: LoroDocumentManager,
  taskId: TaskId,
  fn: (args: {
    mirror: Mirror<typeof taskDocSchema>;
    syncOnce: () => Promise<void>;
  }) => Promise<T> | T,
  options?: { seedEmptyDocument?: boolean }
): Promise<T> => {
  const roomId = getTaskRoomId(taskId);
  await manager.syncDocOrThrow(roomId, { reason: `task:${taskId}` }).catch(() => undefined);
  const handle = await manager.repo.openPersistedDoc(roomId);
  const mirror = new Mirror({
    doc: handle.doc as LoroDoc,
    schema: taskDocSchema,
    // Tolerate root keys written by peers running a newer schema version.
    ignoreUnknownProperties: true,
    // Only creation seeds the containers. Every other path must see an absent
    // document as absent: seeding here would make `readTask` answer with a
    // placeholder meta instead of null, and TASK_NOT_FOUND would stop existing.
    ...(options?.seedEmptyDocument ? { initialState: emptyTaskDocState(taskId) } : {}),
  });
  try {
    return await fn({
      mirror,
      syncOnce: async () => {
        await handle.syncOnce();
      },
    });
  } finally {
    mirror.dispose();
  }
};

export const taskExists = async (
  manager: LoroDocumentManager,
  taskId: TaskId
): Promise<boolean> => {
  const record = await manager.repo.getDocMeta(getTaskRoomId(taskId));
  if (record && isLoroRepoDocDeleted(record)) {
    return false;
  }
  const snapshot = await readTask(manager, taskId);
  return snapshot !== null;
};

export const planWorkspaceTaskEnumeration = (
  indexRows: TaskIndexRowMap,
  metaTaskIds: readonly TaskId[]
): { visibleTaskIds: TaskId[]; missingIndexTaskIds: TaskId[] } => {
  const visibleTaskIds = listVisibleTaskIndexRows(indexRows).map((row) => row.taskId as TaskId);
  const missingIndexTaskIds = [...new Set(metaTaskIds)].filter(
    (taskId) => !Object.prototype.hasOwnProperty.call(indexRows, taskId)
  );
  return { visibleTaskIds, missingIndexTaskIds };
};

/**
 * Reads the workspace Task Index. This is the only read path a list may use:
 * the index exists so listing never opens a task document.
 *
 * `syncOnce` is best-effort — a stale row is a worse answer than a fresh one but
 * a far better answer than failing the whole listing while offline.
 */
const readTaskIndexRowMap = async (
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId,
  options?: { sync?: boolean }
): Promise<TaskIndexRowMap> => {
  const handle = await manager.repo.openFlockDoc(getTaskIndexFlockDocId(workspaceId));
  if (options?.sync) {
    await handle.syncOnce().catch(() => undefined);
  }
  // `scan` must stay a method call: the Flock implementation reads `this`, so a
  // detached reference throws `Cannot read properties of undefined`.
  return readTaskIndexRows(handle.flock.scan({ prefix: getTaskIndexScanPrefix() }));
};

/**
 * Enumerates visible index rows and repairs metadata-discovered Task documents
 * whose projection row is entirely missing. An explicit index tombstone wins:
 * repo existence tracks physical storage, while the index tracks user-visible
 * Task lifecycle.
 */
export const listWorkspaceTaskIds = async (
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId
): Promise<TaskId[]> => {
  const indexRows = await readTaskIndexRowMap(manager, workspaceId);
  const metaTaskIds = (await listAliveRoomIds(manager, isTaskDocRoomId))
    .map(getTaskIdFromRoomId)
    .filter((taskId): taskId is TaskId => taskId !== null);
  const plan = planWorkspaceTaskEnumeration(indexRows, metaTaskIds);
  const taskIds = new Set(plan.visibleTaskIds);

  for (const taskId of plan.missingIndexTaskIds) {
    const snapshot = await readTask(manager, taskId).catch(() => null);
    if (!snapshot || snapshot.meta.taskId !== taskId) {
      continue;
    }
    taskIds.add(taskId);
    // Enumeration must still succeed if the best-effort repair cannot be
    // confirmed remotely; the next scan can retry it.
    await republishIndexRow(manager, workspaceId, snapshot).catch(() => undefined);
  }

  return [...taskIds];
};

export const readTask = async (
  manager: LoroDocumentManager,
  taskId: TaskId
): Promise<TaskSnapshot | null> =>
  withTaskMirror(manager, taskId, ({ mirror }) => {
    const state = mirror.getState() as unknown as {
      meta?: TaskDocMeta;
      body?: string;
      links?: TaskLink[];
      timeline?: TaskTimelineEntry[];
    };
    if (!state.meta?.taskId) {
      return null;
    }
    return {
      meta: state.meta,
      body: state.body ?? '',
      links: state.links ?? [],
      timeline: state.timeline ?? [],
    };
  });

export type TaskListFilter = {
  status?: readonly TaskStatus[];
  /** Exact owner match; empty string selects unassigned tasks. */
  ownerId?: string;
  hasAgent?: boolean;
  /** Case-insensitive substring of the title. */
  titleContains?: string;
  limit: number;
};

export type TaskListPage = {
  rows: TaskIndexRow[];
  /** How many tasks matched before the limit, so truncation is never silent. */
  matched: number;
};

/**
 * Filters and bounds index rows, separated from the Flock read so the selection
 * rules are testable without a document.
 *
 * Newest-updated first: an agent listing tasks is looking for the work that is
 * currently moving, and `order` (the board's manual position) means nothing
 * without the board. Ties break on taskId so a page is stable across calls.
 */
export const selectTaskIndexRows = (
  rows: TaskIndexRowMap,
  filter: TaskListFilter
): TaskListPage => {
  const needle = filter.titleContains?.trim().toLowerCase();
  const statuses = filter.status && filter.status.length > 0 ? new Set(filter.status) : null;
  const matches = listVisibleTaskIndexRows(rows).filter((row) => {
    if (statuses && !statuses.has(row.status)) {
      return false;
    }
    if (filter.ownerId !== undefined && (row.ownerId ?? '') !== filter.ownerId) {
      return false;
    }
    if (filter.hasAgent !== undefined && Boolean(row.hasAgent) !== filter.hasAgent) {
      return false;
    }
    if (needle && !row.title.toLowerCase().includes(needle)) {
      return false;
    }
    return true;
  });

  matches.sort((a, b) =>
    a.updatedAt === b.updatedAt ? a.taskId.localeCompare(b.taskId) : b.updatedAt - a.updatedAt
  );

  return { rows: matches.slice(0, filter.limit), matched: matches.length };
};

export const listTasksFromIndex = async (
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId,
  filter: TaskListFilter
): Promise<TaskListPage> =>
  selectTaskIndexRows(await readTaskIndexRowMap(manager, workspaceId, { sync: true }), filter);

async function republishIndexRow(
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId,
  snapshot: TaskSnapshot
): Promise<void> {
  const flockDocId = getTaskIndexFlockDocId(workspaceId);
  const handle = await manager.repo.openFlockDoc(flockDocId);
  const key = taskIndexKeys.task(snapshot.meta.taskId);
  const row = buildTaskIndexRow(
    snapshot.meta,
    countTaskLinks(snapshot.links),
    summarizeTaskMentions(snapshot.timeline)
  );
  const previous = parseTaskIndexRow(
    [...handle.flock.scan({ prefix: [...key] })].find((entry) => entry.key.length === key.length)
      ?.value
  );
  if (previous && JSON.stringify(previous) === JSON.stringify(row)) {
    return;
  }
  handle.flock.set([...key], row as never);
  handle.flock.commit();
  await manager.repo.flush();
  await handle.syncOnce().catch(() => undefined);
}

export type TaskAgentActor = {
  agentConfigId?: string;
  name?: string;
};

/** Labels are a set; only membership counts, not the order they arrived in. */
const sameLabelSet = (next: readonly string[], previous: readonly string[]): boolean =>
  next.length === previous.length &&
  // NUL separator: a label may contain a comma, so joining on one could make
  // two different sets compare equal.
  [...next].sort().join(' ') === [...previous].sort().join(' ');

/**
 * Compares project lists by identity rather than object shape.
 * `normalizeProjectRefForDedup` returns positional tuples, so stringifying it is
 * stable — comparing the raw refs would report a change whenever key order
 * differed between the caller's object and the one read back from the document.
 */
const sameProjectList = (next: readonly ProjectRef[], previous: readonly ProjectRef[]): boolean =>
  JSON.stringify(next.map(normalizeProjectRefForDedup)) ===
  JSON.stringify(previous.map(normalizeProjectRefForDedup));

const buildAgentActorFields = (actor: TaskAgentActor) => ({
  actorKind: 'agent' as const,
  ...(actor.agentConfigId ? { actorId: actor.agentConfigId } : {}),
  ...(actor.name ? { actorName: actor.name } : {}),
});

export type TaskCreateInput = {
  title?: string;
  body?: string;
  status?: TaskStatus;
  ownerId?: string;
  priority?: TaskPriority;
  labels?: readonly string[];
  projects?: readonly ProjectRef[];
};

/**
 * Creates a task from an agent turn.
 *
 * Attribution splits deliberately: `createdBy` is the authenticated operator
 * (the account the document belongs to, and the owner automation checks against)
 * while the `created` activity carries the agent, so the thread says which agent
 * wrote it and the ownership fields stay human.
 *
 * The `agent` field is never set here. It is the sole automation consent, so a
 * task an agent created can only start running once a person entrusts it.
 */
export const createTaskFromAgent = async (
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId,
  input: TaskCreateInput,
  actor: TaskAgentActor,
  creatorUserId: string
): Promise<TaskSnapshot | null> => {
  if (isEmptyTaskDraft(input)) {
    return null;
  }
  const taskId = randomId() as TaskId;
  const indexRows = await readTaskIndexRowMap(manager, workspaceId, { sync: true });
  const order = generateTaskOrderKeyAtEnd(
    listVisibleTaskIndexRows(indexRows).map((row) => row.order),
    Math.random
  );
  const labels = normalizeTaskLabels(input.labels ? [...input.labels] : undefined);

  const snapshot = await withTaskMirror(
    manager,
    taskId,
    async ({ mirror, syncOnce }) => {
      mirror.setState((draft: unknown) => {
        const state = draft as {
          meta: TaskDocMeta;
          body: string;
          timeline: TaskTimelineEntry[];
        };
        const now = getServerNow();
        Object.assign(state.meta, {
          taskId,
          title: deriveTaskTitle(input),
          status: input.status ?? 'backlog',
          ownerId: input.ownerId ?? creatorUserId,
          order,
          ...(input.priority ? { priority: input.priority } : {}),
          ...(labels.length > 0 ? { labels } : {}),
          ...(input.projects && input.projects.length > 0 ? { projects: [...input.projects] } : {}),
          createdAt: now,
          updatedAt: now,
          createdBy: creatorUserId,
        } satisfies TaskDocMeta);
        state.body = input.body ?? '';
        state.timeline.push({
          id: randomId(),
          kind: 'activity',
          ...buildAgentActorFields(actor),
          createdAt: now,
          activityType: 'created' satisfies TaskActivityType,
        });
      });

      await manager.repo.flush();
      await syncOnce().catch(() => undefined);

      const after = mirror.getState() as unknown as {
        meta: TaskDocMeta;
        body?: string;
        links?: TaskLink[];
        timeline?: TaskTimelineEntry[];
      };
      return {
        meta: after.meta,
        body: after.body ?? '',
        links: after.links ?? [],
        timeline: after.timeline ?? [],
      } satisfies TaskSnapshot;
    },
    { seedEmptyDocument: true }
  );

  await republishIndexRow(manager, workspaceId, snapshot);
  return snapshot;
};

export type TaskUpdateInput = {
  status?: TaskStatus;
  title?: string;
  /** Empty string unassigns. */
  ownerId?: string;
  /** `null` clears the priority (back to untriaged). */
  priority?: TaskPriority | null;
  labels?: readonly string[];
  projects?: readonly ProjectRef[];
  pullRequest?: {
    url: string;
    provider: TaskPrProvider;
    originSessionId: SessionId;
  };
};

/**
 * Agent-facing task update: every scalar property except the entrusted agent,
 * plus pull-request links.
 *
 * The body is deliberately absent — it goes through the exact-match body edit so
 * a content change lands with its size delta and originating session instead of
 * being replaced wholesale under a person's concurrent edits.
 *
 * `agent` is absent for a different reason: setting it IS the automation
 * consent, so an agent writing it would be granting itself a scheduler slot.
 *
 * CAUTION: `status`, `ownerId` and `projects` all participate in the delegated
 * automation eligibility predicate (`planTaskAutomation`), so a write here can
 * start a session on an already-entrusted task. That is intended — the person
 * consented when they set the agent field — but it is why each write records an
 * attributed activity entry.
 */
export const applyAgentTaskUpdate = async (
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId,
  taskId: TaskId,
  input: TaskUpdateInput,
  actor: TaskAgentActor
): Promise<TaskSnapshot | null> => {
  const result = await withTaskMirror(manager, taskId, async ({ mirror, syncOnce }) => {
    const before = mirror.getState() as unknown as { meta?: TaskDocMeta; links?: TaskLink[] };
    if (!before.meta?.taskId) {
      return null;
    }
    const previous = before.meta;
    const previousStatus = previous.status;
    const alreadyLinked =
      input.pullRequest !== undefined &&
      (before.links ?? []).some(
        (link) => link.url === input.pullRequest?.url && link.removedAt === undefined
      );

    mirror.setState((draft: unknown) => {
      const state = draft as {
        meta: TaskDocMeta;
        links: TaskLink[];
        timeline: TaskTimelineEntry[];
      };
      const now = getServerNow();
      const activities: TaskTimelineEntry[] = [];
      const recordActivity = (
        activityType: TaskActivityType,
        activityData?: Record<string, string>
      ) => {
        activities.push({
          id: randomId(),
          kind: 'activity',
          ...buildAgentActorFields(actor),
          createdAt: now,
          activityType,
          ...(activityData ? { activityData } : {}),
        });
      };

      if (input.status !== undefined && input.status !== previousStatus) {
        state.meta.status = input.status;
        recordActivity('status_changed', { from: previousStatus, to: input.status });
      }

      if (input.title !== undefined && input.title !== previous.title) {
        // from/to like `status_changed`, so a future renderer can show the edit
        // rather than just its result. Titles are capped at 200 chars upstream.
        state.meta.title = input.title;
        recordActivity('title_changed', { from: previous.title, to: input.title });
      }

      if (input.ownerId !== undefined && input.ownerId !== (previous.ownerId ?? '')) {
        state.meta.ownerId = input.ownerId;
        recordActivity('owner_changed', input.ownerId ? { to: input.ownerId } : {});
      }

      if (input.priority !== undefined) {
        const next = input.priority ?? undefined;
        if (next !== previous.priority) {
          if (next === undefined) {
            delete state.meta.priority;
          } else {
            state.meta.priority = next;
          }
          recordActivity('priority_changed', next ? { to: next } : {});
        }
      }

      if (input.labels !== undefined) {
        const next = normalizeTaskLabels([...input.labels]);
        // Labels are a set, so reordering the same labels is not a change —
        // otherwise an idempotent re-send would append a timeline entry.
        if (!sameLabelSet(next, previous.labels ?? [])) {
          state.meta.labels = next;
          recordActivity('labels_changed', next.length > 0 ? { to: next.join(', ') } : {});
        }
      }

      if (input.projects !== undefined) {
        const next = [...input.projects];
        // Replaced as a whole (the schema stores it as plain JSON), so the
        // activity records the count rather than a diff nobody would read. The
        // comparison still has to happen: without it a repeated identical update
        // appends to an append-only timeline and re-sorts the task to the top of
        // every newest-updated-first list.
        if (!sameProjectList(next, previous.projects ?? [])) {
          state.meta.projects = next;
          recordActivity('projects_changed', { count: String(next.length) });
        }
      }

      if (input.pullRequest && !alreadyLinked) {
        state.links.push({
          id: randomId(),
          kind: 'pr',
          provider: input.pullRequest.provider,
          url: input.pullRequest.url,
          originSessionId: input.pullRequest.originSessionId,
          ...buildAgentActorFields(actor),
          linkedAt: now,
        });
        recordActivity('pr_linked', { url: input.pullRequest.url });
      }

      if (activities.length > 0) {
        state.meta.updatedAt = now;
        state.timeline.push(...activities);
      }
    });

    await manager.repo.flush();
    await syncOnce().catch(() => undefined);

    const after = mirror.getState() as unknown as {
      meta: TaskDocMeta;
      body?: string;
      links?: TaskLink[];
      timeline?: TaskTimelineEntry[];
    };
    return {
      meta: after.meta,
      body: after.body ?? '',
      links: after.links ?? [],
      timeline: after.timeline ?? [],
    } satisfies TaskSnapshot;
  });

  if (result) {
    await republishIndexRow(manager, workspaceId, result);
  }
  return result;
};

/**
 * The exact-match decision behind `applyAgentTaskBodyEdit`, separated so the
 * refusal rules can be tested without a Loro document.
 *
 * Refusing is the point: an agent rewriting a person's task body must never
 * guess which occurrence was meant, so a stale or ambiguous `oldString` fails
 * and writes nothing.
 */
export type TaskBodyEditPlan =
  | { ok: true; nextBody: string; added: number; removed: number }
  | { ok: false; code: 'NO_MATCH'; body: string }
  | { ok: false; code: 'AMBIGUOUS_MATCH'; occurrences: number };

export const planTaskBodyEdit = (
  currentBody: string,
  edit: { oldString: string; newString: string }
): TaskBodyEditPlan => {
  let nextBody: string;
  if (edit.oldString === '') {
    // Empty match means append, which is how an agent adds a section without
    // having to quote the whole document back.
    nextBody = currentBody ? `${currentBody}\n\n${edit.newString}` : edit.newString;
  } else {
    const first = currentBody.indexOf(edit.oldString);
    if (first < 0) {
      return { ok: false, code: 'NO_MATCH', body: currentBody };
    }
    if (currentBody.indexOf(edit.oldString, first + edit.oldString.length) >= 0) {
      const occurrences = currentBody.split(edit.oldString).length - 1;
      return { ok: false, code: 'AMBIGUOUS_MATCH', occurrences };
    }
    nextBody =
      currentBody.slice(0, first) +
      edit.newString +
      currentBody.slice(first + edit.oldString.length);
  }

  const delta = nextBody.length - currentBody.length;
  return { ok: true, nextBody, added: delta > 0 ? delta : 0, removed: delta < 0 ? -delta : 0 };
};

export type TaskBodyEditResult =
  | { ok: true; snapshot: TaskSnapshot; added: number; removed: number }
  | { ok: false; code: 'TASK_NOT_FOUND' }
  | { ok: false; code: 'NO_MATCH'; body: string }
  | { ok: false; code: 'AMBIGUOUS_MATCH'; occurrences: number };

/**
 * Applies an exact-match body edit, the same contract as an editor's Edit tool.
 *
 * A stale `oldString` fails rather than guessing, and the failure returns the
 * current body so the caller can retry against what is actually there.
 */
export const applyAgentTaskBodyEdit = async (
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId,
  taskId: TaskId,
  edit: { oldString: string; newString: string },
  actor: TaskAgentActor,
  originSessionId?: SessionId
): Promise<TaskBodyEditResult> => {
  const result = await withTaskMirror(manager, taskId, async ({ mirror, syncOnce }) => {
    const before = mirror.getState() as unknown as { meta?: TaskDocMeta; body?: string };
    if (!before.meta?.taskId) {
      return { ok: false, code: 'TASK_NOT_FOUND' } as const;
    }
    const currentBody = before.body ?? '';

    const plan = planTaskBodyEdit(currentBody, edit);
    if (!plan.ok) {
      return plan;
    }
    const { nextBody, added, removed } = plan;

    mirror.setState((draft: unknown) => {
      const state = draft as {
        meta: TaskDocMeta;
        body: string;
        timeline: TaskTimelineEntry[];
      };
      const now = getServerNow();
      state.body = nextBody;
      state.meta.updatedAt = now;
      state.timeline.push({
        id: randomId(),
        kind: 'activity',
        ...buildAgentActorFields(actor),
        createdAt: now,
        activityType: 'body_edited' satisfies TaskActivityType,
        activityData: { added: String(added), removed: String(removed) },
        ...(originSessionId ? { originSessionId } : {}),
      });
    });

    await manager.repo.flush();
    await syncOnce().catch(() => undefined);

    const after = mirror.getState() as unknown as {
      meta: TaskDocMeta;
      body?: string;
      links?: TaskLink[];
      timeline?: TaskTimelineEntry[];
    };
    return {
      ok: true,
      snapshot: {
        meta: after.meta,
        body: after.body ?? '',
        links: after.links ?? [],
        timeline: after.timeline ?? [],
      },
      added,
      removed,
    } as const;
  });

  if (result.ok) {
    await republishIndexRow(manager, workspaceId, result.snapshot);
  }
  return result;
};

export const appendAgentTaskComment = async (
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId,
  taskId: TaskId,
  input: { body: string; originSessionId?: SessionId; mentions?: string[] },
  actor: TaskAgentActor
): Promise<boolean> => {
  const snapshot = await withTaskMirror(manager, taskId, async ({ mirror, syncOnce }) => {
    const before = mirror.getState() as unknown as { meta?: TaskDocMeta };
    if (!before.meta?.taskId) {
      return null;
    }
    mirror.setState((draft: unknown) => {
      const state = draft as { meta: TaskDocMeta; timeline: TaskTimelineEntry[] };
      state.timeline.push({
        id: randomId(),
        kind: 'comment',
        ...buildAgentActorFields(actor),
        createdAt: getServerNow(),
        body: input.body,
        ...(input.mentions && input.mentions.length > 0 ? { mentions: input.mentions } : {}),
        ...(input.originSessionId ? { originSessionId: input.originSessionId } : {}),
      });
      state.meta.updatedAt = getServerNow();
    });
    await manager.repo.flush();
    await syncOnce().catch(() => undefined);
    const after = mirror.getState() as unknown as TaskSnapshot;
    return after.meta?.taskId ? after : null;
  });
  if (!snapshot) {
    return false;
  }
  // The index carries lastCommentAt and mentionedUserIds, so skipping the
  // republish here left an agent's report invisible: no unread badge, no change
  // in the list. Delegated runs are told to report by commenting, which makes
  // this the one path where the report is the only signal a human gets.
  await republishIndexRow(manager, workspaceId, snapshot);
  return true;
};

export type TaskSessionLinkInput = {
  sessionId: SessionId;
  origin: TaskSessionLinkOrigin;
  parentSessionId?: SessionId;
};

/**
 * Links a session to a task from the CLI. Used for spawn inheritance: a session
 * created by an agent that is itself working on a task belongs to that task.
 */
export const linkTaskSessionFromCli = async (
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId,
  taskId: TaskId,
  input: TaskSessionLinkInput,
  actor: TaskAgentActor
): Promise<void> => {
  const result = await withTaskMirror(manager, taskId, async ({ mirror, syncOnce }) => {
    const before = mirror.getState() as unknown as { meta?: TaskDocMeta; links?: TaskLink[] };
    if (!before.meta?.taskId) {
      return null;
    }
    if (
      (before.links ?? []).some(
        (link) => link.sessionId === input.sessionId && link.removedAt === undefined
      )
    ) {
      return null;
    }
    mirror.setState((draft: unknown) => {
      const state = draft as {
        meta: TaskDocMeta;
        links: TaskLink[];
        timeline: TaskTimelineEntry[];
      };
      const now = getServerNow();
      state.links.push({
        id: randomId(),
        kind: 'session',
        sessionId: input.sessionId,
        origin: input.origin,
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        ...buildAgentActorFields(actor),
        linkedAt: now,
      });
      state.timeline.push({
        id: randomId(),
        kind: 'activity',
        ...buildAgentActorFields(actor),
        createdAt: now,
        activityType: 'session_linked',
        activityData: { origin: input.origin },
      });
      state.meta.updatedAt = now;
    });
    await manager.repo.flush();
    await syncOnce().catch(() => undefined);
    const after = mirror.getState() as unknown as {
      meta: TaskDocMeta;
      body?: string;
      links?: TaskLink[];
      timeline?: TaskTimelineEntry[];
    };
    return {
      meta: after.meta,
      body: after.body ?? '',
      links: after.links ?? [],
      timeline: after.timeline ?? [],
    } satisfies TaskSnapshot;
  });

  if (result) {
    await republishIndexRow(manager, workspaceId, result);
  }
};
