import {
  isCoordinatorSession,
  normalizeCoordinatorWorkItemsMap,
  resolveSessionPrimaryPullRequest,
  resolveSessionPullRequestViews,
  type CoordinatorCollaborationMode,
  type CoordinatorExternalRef,
  type CoordinatorWorkItemDoc,
  type MachineId,
  type SessionMeta,
  type SessionPullRequestView,
  type SessionStatus,
} from '@lody/shared';
import type { SessionSendState } from '@/lib/session-send-status';
import { getEffectiveSessionActivitySummary } from '@/components/sessions/session-list-rows';
import { isSessionInMyScope } from '@/lib/session-visibility';

/**
 * A project as the project-mode prototype knows it: the sidebar's existing
 * project groups, one local project on one machine or one GitHub repository.
 */
export type CoordinatorProjectKey =
  | { kind: 'local'; machineId: MachineId; localProjectId: string }
  | { kind: 'github'; repoFullName: string };

export const coordinatorProjectKeyId = (key: CoordinatorProjectKey): string =>
  key.kind === 'local'
    ? `local:${key.machineId}:${key.localProjectId}`
    : `github:${key.repoFullName.trim().toLowerCase()}`;

/** The project a conversation belongs to, or `null` for a plain chat. */
export function getSessionCoordinatorProjectKey(
  session: Pick<SessionMeta, 'project' | 'machineId' | 'repoFullName'>
): CoordinatorProjectKey | null {
  const project = session.project;
  if (project?.kind === 'local') {
    return {
      kind: 'local',
      machineId: session.machineId,
      localProjectId: project.localProjectId,
    };
  }
  const rawRepo =
    project?.kind === 'github' ? project.repoFullName : (session.repoFullName ?? undefined);
  const repoFullName = rawRepo?.trim();
  return repoFullName ? { kind: 'github', repoFullName } : null;
}

export function isSessionInCoordinatorProject(
  session: Pick<SessionMeta, 'project' | 'machineId' | 'repoFullName'>,
  key: CoordinatorProjectKey
): boolean {
  const own = getSessionCoordinatorProjectKey(session);
  return own !== null && coordinatorProjectKeyId(own) === coordinatorProjectKeyId(key);
}

/**
 * The conversation a project is bound to: one per person per project. The
 * binding is the newest unarchived coordinator this user created there, so it
 * does not move with activity; it changes only when the user starts another
 * coordinator for the project ("Change coordinator").
 */
export function findProjectCoordinatorSession(
  sessions: readonly SessionMeta[],
  key: CoordinatorProjectKey,
  userId: string | null | undefined
): SessionMeta | null {
  let best: SessionMeta | null = null;
  for (const session of sessions) {
    if (session.isArchived || session.parentSessionId) continue;
    if (!isCoordinatorSession(session)) continue;
    if (!userId || session.userId !== userId) continue;
    if (!isSessionInCoordinatorProject(session, key)) continue;
    if (!best || createdTime(session) > createdTime(best)) best = session;
  }
  return best;
}

const createdTime = (session: SessionMeta): number => Date.parse(session.createdAt) || 0;

export function resolveEffectiveWorkItemId(
  session: Pick<SessionMeta, 'id' | 'workItemId'>
): string {
  const explicit = session.workItemId?.trim();
  return explicit && explicit.length > 0 ? explicit : session.id;
}

/**
 * Ordered pull requests associated with one conversation: primary PR first,
 * followed by remaining associated PRs across any repository (newest first).
 */
export function resolveOrderedSessionPullRequests(session: SessionMeta): SessionPullRequestView[] {
  const all = resolveSessionPullRequestViews(session);
  if (all.length <= 1) return all;
  const primary = resolveSessionPrimaryPullRequest(session);
  const out: SessionPullRequestView[] = [];
  const seen = new Set<string>();
  const push = (view: SessionPullRequestView | null) => {
    if (!view) return;
    const key = view.url.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(view);
  };
  push(primary);
  for (let i = all.length - 1; i >= 0; i -= 1) {
    push(all[i]!);
  }
  return out;
}

export function hasMultiplePullRequestRepos(
  pullRequests: readonly SessionPullRequestView[]
): boolean {
  if (pullRequests.length <= 1) return false;
  let firstRepo: string | null = null;
  for (const pr of pullRequests) {
    const repo = pr.repoFullName?.trim().toLowerCase() || null;
    if (!repo) continue;
    if (firstRepo === null) {
      firstRepo = repo;
    } else if (repo !== firstRepo) {
      return true;
    }
  }
  return false;
}

/**
 * Task states, in the order the user should look at them. "Needs you" is a
 * pending permission or question, or an input that failed to send. A finished
 * task waits for the user's review ("To review") until the user accepts it; new
 * activity after acceptance sends it back to review.
 */
export type ProjectBoardBucket = 'needsYou' | 'working' | 'review' | 'accepted';
export const PROJECT_BOARD_BUCKETS: readonly ProjectBoardBucket[] = [
  'needsYou',
  'working',
  'review',
  'accepted',
];

export type ProjectBoardSessionMember = {
  session: SessionMeta;
  role: string | null;
  bucket: ProjectBoardBucket;
  isWorking: boolean;
  isWaitingPermission: boolean;
  hasUnreadMessages: boolean;
  sendState: SessionSendState | null;
  latestMessageAt: number;
  pullRequests: readonly SessionPullRequestView[];
};

export type ProjectBoardRow = {
  workItemId: string;
  workItemTitle: string | null;
  collaborationMode: CoordinatorCollaborationMode;
  externalRefs: readonly CoordinatorExternalRef[];
  members: readonly ProjectBoardSessionMember[];
  session: SessionMeta;
  bucket: ProjectBoardBucket;
  /** `T<n>` for a work item this coordinator opened, in creation order. */
  taskNumber: number | null;
  /** In the project but not opened by this coordinator. */
  createdManually: boolean;
  isWorking: boolean;
  isWaitingPermission: boolean;
  hasUnreadMessages: boolean;
  sendState: SessionSendState | null;
  latestMessageAt: number;
  pullRequest: SessionPullRequestView | null;
  pullRequests: readonly SessionPullRequestView[];
};

export type ProjectBoard = Record<ProjectBoardBucket, ProjectBoardRow[]>;

const isOpenedBy = (session: SessionMeta, coordinatorSessionId: string | null): boolean =>
  coordinatorSessionId !== null &&
  (session.openedBySessionId === coordinatorSessionId ||
    session.openedByRootSessionId === coordinatorSessionId);

/**
 * Stable task numbers: every `WorkItem` (implicit solo session or multi-session
 * group) the coordinator opened, archived ones included, numbered by earliest
 * creation time so adding a reviewer or collaborator session to an existing
 * work item never shifts `T<n>` numbers.
 *
 * Indexes both `workItemId -> number` and `memberSessionId -> number`.
 */
export function buildCoordinatorTaskNumbers(
  sessions: readonly SessionMeta[],
  coordinatorSessionId: string | null,
  workItems?: Readonly<Record<string, CoordinatorWorkItemDoc>>
): Map<string, number> {
  const groups = new Map<string, { earliestMs: number; memberIds: string[] }>();
  for (const session of sessions) {
    if (session.parentSessionId || !isOpenedBy(session, coordinatorSessionId)) continue;
    const workItemId = resolveEffectiveWorkItemId(session);
    const ts = createdTime(session);
    const existing = groups.get(workItemId);
    if (existing) {
      if (ts > 0 && (existing.earliestMs === 0 || ts < existing.earliestMs)) {
        existing.earliestMs = ts;
      }
      existing.memberIds.push(session.id);
    } else {
      const docCreated = workItems?.[workItemId]?.createdAt;
      const initialEarliest =
        ts > 0 ? ts : typeof docCreated === 'number' && docCreated > 0 ? docCreated : 0;
      groups.set(workItemId, { earliestMs: initialEarliest, memberIds: [session.id] });
    }
  }

  const ordered = [...groups.entries()].sort(
    ([idA, a], [idB, b]) => a.earliestMs - b.earliestMs || idA.localeCompare(idB)
  );
  const result = new Map<string, number>();
  ordered.forEach(([workItemId, group], index) => {
    const explicitNum = workItems?.[workItemId]?.taskNumber;
    const num =
      typeof explicitNum === 'number' && Number.isSafeInteger(explicitNum) && explicitNum > 0
        ? explicitNum
        : index + 1;
    result.set(workItemId, num);
    for (const memberId of group.memberIds) {
      result.set(memberId, num);
    }
  });
  return result;
}

/** Accepted only while nothing happened in the task after the user accepted it. */
export function isCoordinatorTaskAccepted(
  session: Pick<SessionMeta, 'coordinatorTaskAcceptedAt'>,
  latestMessageAt: number
): boolean {
  const acceptedAt = session.coordinatorTaskAcceptedAt;
  return typeof acceptedAt === 'number' && acceptedAt >= latestMessageAt;
}

export function resolveOwnerSessionForPullRequest(
  row: Pick<ProjectBoardRow, 'session'> & Partial<Pick<ProjectBoardRow, 'members'>>,
  prUrl: string
): string {
  const target = prUrl.trim().toLowerCase();
  for (const member of row.members ?? []) {
    if (member.pullRequests.some((pr) => pr.url.trim().toLowerCase() === target)) {
      return member.session.id;
    }
  }
  return row.session.id;
}

/**
 * Every work item the coordinator opened (wherever its member conversations run),
 * grouped by `workItemId` and bucketed by derived status. Single-conversation
 * tasks form implicit 1-member rows; multi-conversation tasks aggregate member
 * statuses, unread flags, and pull requests across repositories.
 */
export function buildProjectBoard(options: {
  sessions: readonly SessionMeta[];
  childSessionsByParent: Map<string, SessionMeta[]>;
  project: CoordinatorProjectKey | null;
  coordinatorSessionId: string | null;
  currentUserId: string | null | undefined;
  liveSessionStatuses: ReadonlyMap<string, SessionStatus>;
  sendStates: Readonly<Record<string, SessionSendState>>;
  workItems?: Readonly<Record<string, CoordinatorWorkItemDoc>> | null;
  /** Every session including archived ones, so accepted (archived) tasks keep their numbers. */
  numberingSessions?: readonly SessionMeta[];
  /** Include non-accepted archived tasks too (used by coordinator conversation history strips so archived tasks keep their title, number and state). */
  includeArchived?: boolean;
}): ProjectBoard {
  const board: ProjectBoard = { needsYou: [], working: [], review: [], accepted: [] };
  const { coordinatorSessionId } = options;
  const normalizedWorkItems = options.workItems
    ? normalizeCoordinatorWorkItemsMap(options.workItems)
    : {};
  const taskNumbers = buildCoordinatorTaskNumbers(
    options.numberingSessions ?? options.sessions,
    coordinatorSessionId,
    normalizedWorkItems
  );

  const membersByWorkItem = new Map<string, ProjectBoardSessionMember[]>();

  for (const session of options.sessions) {
    if (session.parentSessionId) continue;
    if (session.id === coordinatorSessionId) continue;
    if (!isSessionInMyScope(session, options.currentUserId)) continue;
    if (isCoordinatorSession(session)) continue;
    if (!isOpenedBy(session, coordinatorSessionId)) continue;
    const workItemId = resolveEffectiveWorkItemId(session);
    const workItemDoc = normalizedWorkItems[workItemId];
    const isAcceptedArchive =
      Boolean(session.isArchived) &&
      (typeof session.coordinatorTaskAcceptedAt === 'number' ||
        typeof workItemDoc?.acceptedAt === 'number');
    if (session.isArchived && !isAcceptedArchive && !options.includeArchived) continue;
    const activity = getEffectiveSessionActivitySummary(
      session,
      options.childSessionsByParent,
      options.liveSessionStatuses
    );
    const sendState = options.sendStates[session.id] ?? null;
    const needsYou =
      sendState === 'failed' ||
      activity.isWaitingPermission ||
      typeof session.awaitingUserSince === 'number';
    const memberBucket: ProjectBoardBucket = session.isArchived
      ? 'accepted'
      : needsYou
        ? 'needsYou'
        : activity.isWorking || sendState === 'sending'
          ? 'working'
          : isCoordinatorTaskAccepted(session, activity.latestMessageAt)
            ? 'accepted'
            : 'review';
    const memberPullRequests = resolveOrderedSessionPullRequests(session);
    const list = membersByWorkItem.get(workItemId) ?? [];
    list.push({
      session,
      role: session.workItemRole?.trim() || null,
      bucket: memberBucket,
      isWorking: activity.isWorking,
      isWaitingPermission: activity.isWaitingPermission,
      hasUnreadMessages: activity.hasUnreadMessages,
      sendState,
      latestMessageAt: activity.latestMessageAt,
      pullRequests: memberPullRequests,
    });
    membersByWorkItem.set(workItemId, list);
  }

  for (const [workItemId, rawMembers] of membersByWorkItem) {
    const members = [...rawMembers].sort(
      (a, b) =>
        createdTime(a.session) - createdTime(b.session) || a.session.id.localeCompare(b.session.id)
    );
    const lead = members[0]!;
    const workItemDoc = normalizedWorkItems[workItemId];
    const latestMessageAt = Math.max(...members.map((m) => m.latestMessageAt));
    const isWorking = members.some((m) => m.isWorking);
    const isWaitingPermission = members.some((m) => m.isWaitingPermission);
    const hasUnreadMessages = members.some((m) => m.hasUnreadMessages);
    const sendState: SessionSendState | null = members.some((m) => m.sendState === 'failed')
      ? 'failed'
      : members.some((m) => m.sendState === 'sending')
        ? 'sending'
        : (lead.sendState ?? null);

    const groupAcceptedByTimestamp =
      typeof workItemDoc?.acceptedAt === 'number' && workItemDoc.acceptedAt >= latestMessageAt;
    const bucket: ProjectBoardBucket = members.some((m) => m.bucket === 'needsYou')
      ? 'needsYou'
      : members.some((m) => m.bucket === 'working')
        ? 'working'
        : groupAcceptedByTimestamp || members.every((m) => m.bucket === 'accepted')
          ? 'accepted'
          : 'review';

    const pullRequests: SessionPullRequestView[] = [];
    const seenPrUrls = new Set<string>();
    for (const member of members) {
      for (const pr of member.pullRequests) {
        const key = pr.url.trim().toLowerCase();
        if (!key || seenPrUrls.has(key)) continue;
        seenPrUrls.add(key);
        pullRequests.push(pr);
      }
    }

    const workItemTitle =
      workItemDoc?.title?.trim() ||
      (members.length === 1
        ? lead.session.title?.trim() || null
        : lead.session.title?.trim() || null);

    board[bucket].push({
      workItemId,
      workItemTitle,
      collaborationMode: workItemDoc?.mode ?? 'delegated',
      externalRefs: workItemDoc?.externalRefs ?? [],
      members,
      session: lead.session,
      bucket,
      taskNumber: taskNumbers.get(workItemId) ?? taskNumbers.get(lead.session.id) ?? null,
      createdManually: false,
      isWorking,
      isWaitingPermission,
      hasUnreadMessages,
      sendState,
      latestMessageAt,
      pullRequest: pullRequests[0] ?? null,
      pullRequests,
    });
  }

  for (const bucket of PROJECT_BOARD_BUCKETS) {
    board[bucket].sort((a, b) => b.latestMessageAt - a.latestMessageAt);
  }
  return board;
}
