import type {
  LocalProjectHistoryProvider,
  MachineId,
  PrStatus,
  SessionPullRequestCiState,
  SessionPullRequestReadiness,
  SessionMeta,
  SessionStatus,
} from '@lody/shared';
import {
  deriveSessionPullRequestReadiness,
  getSessionPullRequestLegacyFields,
  parseGitHubPrNumber,
  resolveProjectGitHubRepo,
} from '@lody/shared';
import type { SessionListRow, SessionListRowOwner } from '@/components/session-list';
import { getLineChangeDeltaForScope, type LineChangeScope } from '@/lib/file-change-category';

export type SessionListScope = 'my' | 'team';

export type WorkspaceMember = {
  userId: string;
  user?: {
    name?: string | null;
    image?: string | null;
  } | null;
};

export type BuildSessionListRowsOptions = {
  scope: SessionListScope;
  currentUserId: string | null | undefined;
  defaultTitle: string;
  /** Set of online machine IDs - sessions with machines not in this set are considered offline */
  onlineMachineIds?: ReadonlySet<MachineId>;
  /** Workspace members for resolving owner info (used in team scope) */
  members?: WorkspaceMember[];
  lineChangeScope?: LineChangeScope;
  liveSessionStatuses?: ReadonlyMap<string, SessionStatus>;
  /**
   * Precise opener id → sidebar row id to nest under. The sidebar already
   * memoizes one over the same `allSessions` for its other lists and the
   * keyboard nav model; pass it in rather than indexing every session twice.
   * Omitted callers get one built here from `allSessions`.
   */
  resolveOpenerRowId?: (openerSessionId: string | null | undefined) => string | null;
};

function normalizeString(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseTimestamp(value: number | string | Date | null | undefined): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) return asNumber;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Group non-archived child sessions by their parentSessionId. Used to roll up
 * sub-session timestamps (and status) into the parent that the sidebar shows.
 */
export function buildChildSessionsByParent(
  allSessions: SessionMeta[] | undefined
): Map<string, SessionMeta[]> {
  const map = new Map<string, SessionMeta[]>();
  if (!allSessions) return map;
  for (const s of allSessions) {
    if (s.parentSessionId && !s.isArchived) {
      const existing = map.get(s.parentSessionId);
      if (existing) existing.push(s);
      else map.set(s.parentSessionId, [s]);
    }
  }
  return map;
}

/**
 * Resolves a PRECISE opener id (`SessionMeta.openedBySessionId`) to the session
 * whose sidebar ROW should host the nested indentation.
 *
 * An agent running inside a child Tab Session (`parentSessionId` set) can call
 * `lody_session_create`, and the created independent Session then records that
 * child Tab as its opener. Child Tabs are deliberately absent from every sidebar
 * list (`sessionListAtom` filters `parentSessionId`), so the precise opener has
 * no row to nest under and the Session would fall back to top-level — visually
 * detached from the work that spawned it.
 *
 * So nesting walks UP the `parentSessionId` chain to the root Session, which is
 * the one the sidebar actually renders. This is presentation only: the precise
 * `openedBySessionId` is never rewritten. Navigation pairs this root result
 * with that precise id, so "Go to Opener Session" and the Session's "Opened
 * by" entry open the root route and restore the exact child Tab.
 *
 * Returns the opener id unchanged when it is already a root, or when the session
 * cache has no entry for it — an unknown opener still resolves to itself, so the
 * tree's existing orphan fallback decides what happens.
 */
export function resolveSidebarOpenerRowId(
  openerSessionId: string | null | undefined,
  sessionsById: ReadonlyMap<string, SessionMeta>
): string | null {
  const openerId = normalizeString(openerSessionId);
  if (!openerId) return null;
  let current = openerId;
  const seen = new Set<string>([current]);
  for (;;) {
    const meta = sessionsById.get(current);
    const parentId = normalizeString(meta?.parentSessionId);
    // No parent (or the parent is unknown / already visited) → this is the row.
    if (!parentId || seen.has(parentId)) return current;
    seen.add(parentId);
    current = parentId;
  }
}

/**
 * Index every known session by id so {@link resolveSidebarOpenerRowId} can walk
 * the `parentSessionId` chain. Callers pass the FULL active-session list
 * (children included) — the child Tabs are exactly what the sidebar rows omit.
 */
export function buildSessionMetaById(
  allSessions: SessionMeta[] | undefined
): Map<string, SessionMeta> {
  const map = new Map<string, SessionMeta>();
  if (!allSessions) return map;
  for (const session of allSessions) map.set(session.id, session);
  return map;
}

/**
 * Ready-made resolver: precise opener id → sidebar row id to nest under.
 * Shared by every sidebar list so they agree on where a Session lands.
 */
export function buildSidebarOpenerRowResolver(
  allSessions: SessionMeta[] | undefined
): (openerSessionId: string | null | undefined) => string | null {
  const sessionsById = buildSessionMetaById(allSessions);
  return (openerSessionId) => resolveSidebarOpenerRowId(openerSessionId, sessionsById);
}

/**
 * Effective "last activity" timestamp for a session as it appears in the sidebar:
 * the max of the session's own `lastMessageAt` and every child's `lastMessageAt`.
 * Falls back to the session's `createdAt` when nothing has been recorded yet.
 *
 * Returns a numeric timestamp suitable for both sorting and feeding into the
 * relative-time formatters (which accept `number | string | Date`).
 */
export function getEffectiveLatestMessageAt(
  session: SessionMeta,
  childSessionsByParent?: Map<string, SessionMeta[]>
): number {
  let maxMs = parseTimestamp(session.lastMessageAt) ?? parseTimestamp(session.createdAt) ?? 0;
  const children = childSessionsByParent?.get(session.id);
  if (children) {
    for (const child of children) {
      const childMs = parseTimestamp(child.lastMessageAt) ?? parseTimestamp(child.createdAt) ?? 0;
      if (childMs > maxMs) maxMs = childMs;
    }
  }
  return maxMs;
}

function sessionHasUnreadMessages(session: SessionMeta): boolean {
  const lastMessageAt = parseTimestamp(session.lastMessageAt);
  if (lastMessageAt === null) return false;
  const lastReadAt = parseTimestamp(session.lastReadAt);
  return lastReadAt === null || lastMessageAt > lastReadAt;
}

export type EffectiveSessionActivitySummary = {
  status: Exclude<SessionStatus['type'], 'idle'> | null;
  isWorking: boolean;
  isWaitingPermission: boolean;
  hasUnreadMessages: boolean;
  latestMessageAt: number;
};

type ActiveSessionStatus = EffectiveSessionActivitySummary['status'];

function mergeActiveSessionStatus(
  current: ActiveSessionStatus,
  candidate: SessionStatus | null | undefined
): ActiveSessionStatus {
  if (!candidate || candidate.type === 'idle') return current;
  if (candidate.type === 'requestPermission' || current === 'requestPermission') {
    return 'requestPermission';
  }
  if (candidate.type === 'running' || current === 'running') return 'running';
  return 'initializing';
}

export function getEffectiveSessionActivitySummary(
  session: SessionMeta,
  childSessionsByParent?: Map<string, SessionMeta[]>,
  liveSessionStatuses?: ReadonlyMap<string, SessionStatus>
): EffectiveSessionActivitySummary {
  const liveStatus = liveSessionStatuses?.get(session.id);
  // Sidebar working state is live presence only. A goal may remain active while
  // quiescent, and meta dispatch pointers can be stale in this client — deriving
  // a spinner from either shows sessions as working long after the prompt finished.
  let status = mergeActiveSessionStatus(null, liveStatus);
  let isWorking = liveStatus != null;
  let hasUnreadMessages = sessionHasUnreadMessages(session);
  let latestMessageAt =
    parseTimestamp(session.lastMessageAt) ?? parseTimestamp(session.createdAt) ?? 0;

  const children = childSessionsByParent?.get(session.id);
  if (children) {
    for (const child of children) {
      const childLiveStatus = liveSessionStatuses?.get(child.id);
      status = mergeActiveSessionStatus(status, childLiveStatus);
      if (childLiveStatus != null) isWorking = true;
      if (!hasUnreadMessages && sessionHasUnreadMessages(child)) {
        hasUnreadMessages = true;
      }
      const childMs = parseTimestamp(child.lastMessageAt) ?? parseTimestamp(child.createdAt) ?? 0;
      if (childMs > latestMessageAt) {
        latestMessageAt = childMs;
      }
    }
  }

  return {
    status,
    isWorking,
    isWaitingPermission: status === 'requestPermission',
    hasUnreadMessages,
    latestMessageAt,
  };
}

export type EffectiveProjectActivitySummary = {
  status: ActiveSessionStatus;
  hasUnreadMessages: boolean;
};

/** Aggregate live activity for a local-project sidebar row. */
export function getEffectiveProjectActivitySummary(
  sessions: SessionMeta[],
  childSessionsByParent?: Map<string, SessionMeta[]>,
  liveSessionStatuses?: ReadonlyMap<string, SessionStatus>
): EffectiveProjectActivitySummary {
  let status: EffectiveProjectActivitySummary['status'] = null;
  let hasUnreadMessages = false;

  for (const session of sessions) {
    for (const candidate of [session, ...(childSessionsByParent?.get(session.id) ?? [])]) {
      status = mergeActiveSessionStatus(status, liveSessionStatuses?.get(candidate.id));
      if (!hasUnreadMessages && sessionHasUnreadMessages(candidate)) hasUnreadMessages = true;
    }
  }

  return { status, hasUnreadMessages };
}

type LatestPullRequestInfo = {
  url: string | null;
  number: number | null;
  status: PrStatus | null;
  ciState: SessionPullRequestCiState | null;
  readiness: SessionPullRequestReadiness | null;
};

export function getLatestPullRequestInfo(session: SessionMeta): LatestPullRequestInfo {
  const pullRequests = session.pullRequests ?? [];
  if (!pullRequests.length) {
    return { url: null, number: null, status: null, ciState: null, readiness: null };
  }

  const latest = pullRequests.some((pr) => getSessionPullRequestLegacyFields(pr).reportedAt)
    ? [...pullRequests].sort((a, b) =>
        (getSessionPullRequestLegacyFields(b).reportedAt ?? '').localeCompare(
          getSessionPullRequestLegacyFields(a).reportedAt ?? ''
        )
      )[0]
    : pullRequests[pullRequests.length - 1];
  const url = normalizeString(latest?.url ?? '');
  const legacy = getSessionPullRequestLegacyFields(latest);
  return {
    url: url ? url : null,
    number: legacy.number ?? (url ? parseGitHubPrNumber(url) : null),
    status: latest?.status ?? null,
    ciState: url ? (session.pullRequestState?.[url]?.s ?? null) : null,
    readiness: url ? deriveSessionPullRequestReadiness(session.pullRequestState?.[url]) : null,
  };
}

export function mapSessionMetaToSessionListRow(
  session: SessionMeta,
  defaultTitle: string,
  onlineMachineIds?: ReadonlySet<MachineId>,
  owner?: SessionListRowOwner | null,
  lineChangeScope: LineChangeScope = 'all',
  liveStatus?: SessionStatus | null,
  /**
   * Maps the precise opener to the sidebar row that should host the nesting
   * (see {@link buildSidebarOpenerRowResolver}). Omitted callers keep the
   * precise id, which is correct whenever the opener is already a root.
   */
  resolveOpenerRowId?: (openerSessionId: string | null | undefined) => string | null
): SessionListRow {
  const title = normalizeString(session.title) || defaultTitle;
  // Align with the info bar (`getSessionGitHubState`): the GitHub repo identity
  // lives on `session.project` for current writes; the legacy top-level
  // `repoFullName` is only a fallback. Reading just the legacy field
  // misclassifies GitHub sessions as chats and hides their PR from the sidebar.
  const repoFullNameRaw =
    resolveProjectGitHubRepo(session.project) ?? normalizeString(session.repoFullName);
  const branchName = normalizeString(session.branchName);
  const latestMessageAt =
    typeof session.lastMessageAt === 'number'
      ? session.lastMessageAt
      : normalizeString(typeof session.lastMessageAt === 'string' ? session.lastMessageAt : '') ||
        session.createdAt;
  const lastMessageAt = parseTimestamp(session.lastMessageAt);
  const lastReadAt = parseTimestamp(session.lastReadAt);
  const hasUnreadMessages =
    lastMessageAt !== null && (lastReadAt === null || lastMessageAt > lastReadAt);

  // A session is offline if we have online machine tracking and its machine is not in the set
  const isOffline = onlineMachineIds ? !onlineMachineIds.has(session.machineId) : false;

  const prInfo = getLatestPullRequestInfo(session);
  const diffStats = session.diffStats ?? { allChange: { add: 0, del: 0 } };
  const lineChange = getLineChangeDeltaForScope(diffStats, lineChangeScope);
  const externalHistoryProvider: LocalProjectHistoryProvider | null =
    session.origin === 'external-acp' ? (session.externalHistory?.provider ?? null) : null;

  return {
    sessionId: session.id,
    title,
    // Presentation-only provenance: the Session that created this one (MCP
    // `lody_session_create` / `lody session create` from inside a session).
    // Deliberately NOT parentSessionId — see `lib/session-opened-by-tree.ts`.
    // PRECISE: keeps the exact opener even when that opener is a child Tab with
    // no sidebar row, so navigation back to it stays truthful.
    openedBySessionId: session.openedBySessionId ?? null,
    // Sidebar row to nest under: the opener's root Session when the opener is a
    // child Tab, otherwise the opener itself. New Sessions persist that root;
    // resolving the opener meta keeps pre-existing relationships working.
    // Nesting only.
    openedByRowSessionId:
      session.openedByRootSessionId ??
      resolveOpenerRowId?.(session.openedBySessionId) ??
      session.openedBySessionId ??
      null,
    machineId: session.machineId,
    repoFullName: repoFullNameRaw ? repoFullNameRaw : null,
    branchName,
    prUrl: prInfo.url,
    prNumber: prInfo.number,
    prStatus: prInfo.status,
    prCiState: prInfo.ciState,
    prReadiness: prInfo.readiness,
    latestMessageAt,
    addedLines: lineChange.add,
    deletedLines: lineChange.del,
    isWorking: liveStatus != null,
    activityStatus: mergeActiveSessionStatus(null, liveStatus),
    hasUnreadMessages,
    isOffline,
    isWaitingPermission: liveStatus?.type === 'requestPermission',
    isPinned: Boolean(session.isPinned),
    isWorktree: Boolean(session.isWorktree),
    externalHistoryProvider,
    owner,
  };
}

/**
 * Aggregate child session status into a parent task list entry.
 * If any child is working/waiting-permission/has-unread, the parent reflects that.
 * `latestMessageAt` is rolled up to the max of the parent and all children, so
 * sidebar sorting and the displayed timestamp reflect activity on any sub-tab.
 */
function aggregateChildStatus(
  session: SessionMeta,
  task: SessionListRow,
  childSessionsByParent: Map<string, SessionMeta[]>,
  liveSessionStatuses?: ReadonlyMap<string, SessionStatus>
): SessionListRow {
  if (!childSessionsByParent.has(session.id)) return task;

  const activity = getEffectiveSessionActivitySummary(
    session,
    childSessionsByParent,
    liveSessionStatuses
  );
  const taskLatestMessageAtMs = parseTimestamp(task.latestMessageAt) ?? 0;
  const latestMessageAt =
    activity.latestMessageAt > taskLatestMessageAtMs
      ? activity.latestMessageAt
      : task.latestMessageAt;

  if (
    activity.isWorking === task.isWorking &&
    activity.status === task.activityStatus &&
    activity.isWaitingPermission === task.isWaitingPermission &&
    activity.hasUnreadMessages === task.hasUnreadMessages &&
    latestMessageAt === task.latestMessageAt
  ) {
    return task;
  }

  return {
    ...task,
    activityStatus: activity.status,
    isWorking: activity.isWorking,
    isWaitingPermission: activity.isWaitingPermission,
    hasUnreadMessages: activity.hasUnreadMessages,
    latestMessageAt,
  };
}

export function buildSessionListRows(
  sessions: SessionMeta[],
  options: BuildSessionListRowsOptions,
  allSessions?: SessionMeta[]
): SessionListRow[] {
  const {
    scope,
    currentUserId,
    defaultTitle,
    onlineMachineIds,
    members,
    lineChangeScope = 'all',
    liveSessionStatuses,
  } = options;

  // Build child session lookup for status aggregation
  const childSessionsByParent = buildChildSessionsByParent(allSessions);
  // `allSessions` is the only place child Tabs are visible, so it is also the
  // only place the opener→row mapping can be resolved.
  const resolveOpenerRowId =
    options.resolveOpenerRowId ?? buildSidebarOpenerRowResolver(allSessions);

  // Build a map of userId to owner info for efficient lookup
  const membersByUserId = new Map<string, SessionListRowOwner>();
  if (members) {
    for (const member of members) {
      if (member.user) {
        membersByUserId.set(member.userId, {
          name: member.user.name,
          image: member.user.image,
        });
      }
    }
  }

  // Owner attribution (the row author avatar + hover-card Author row) is only
  // meaningful on a multi-member workspace: with a single member every task is
  // "always you", so resolving an owner there would just repeat the current user.
  const isMultiMemberWorkspace = membersByUserId.size > 1;

  const getOwner = (userId: string): SessionListRowOwner | null => {
    if (!isMultiMemberWorkspace) return null;
    return membersByUserId.get(userId) ?? null;
  };

  const mapAndAggregate = (
    session: SessionMeta,
    owner?: SessionListRowOwner | null
  ): SessionListRow => {
    const task = mapSessionMetaToSessionListRow(
      session,
      defaultTitle,
      onlineMachineIds,
      owner,
      lineChangeScope,
      liveSessionStatuses?.get(session.id) ?? null,
      resolveOpenerRowId
    );
    return aggregateChildStatus(session, task, childSessionsByParent, liveSessionStatuses);
  };

  if (scope === 'my') {
    if (!currentUserId) {
      return [];
    }
    return sessions
      .filter((session) => session.userId === currentUserId)
      .map((session) => mapAndAggregate(session));
  }

  // For team scope, include owner info
  return sessions.map((session) => mapAndAggregate(session, getOwner(session.userId)));
}
