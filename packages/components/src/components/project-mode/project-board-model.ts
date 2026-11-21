import {
  isCoordinatorSession,
  resolveSessionPrimaryPullRequest,
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
    : `github:${key.repoFullName}`;

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
  const repoFullName =
    project?.kind === 'github' ? project.repoFullName : (session.repoFullName ?? undefined);
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

/**
 * Task states, in the order the user should look at them. "Needs you" is a
 * pending permission or question, or an input that failed to send; there is no
 * durable "failed turn" signal in session metadata yet. A finished task waits
 * for the user's review ("To review") until the user accepts it; new activity
 * after acceptance sends it back to review.
 */
export type ProjectBoardBucket = 'needsYou' | 'working' | 'review' | 'accepted';
export const PROJECT_BOARD_BUCKETS: readonly ProjectBoardBucket[] = [
  'needsYou',
  'working',
  'review',
  'accepted',
];

export type ProjectBoardRow = {
  session: SessionMeta;
  bucket: ProjectBoardBucket;
  /** `T<n>` for a conversation this coordinator opened, in creation order. */
  taskNumber: number | null;
  /** In the project but not opened by this coordinator. */
  createdManually: boolean;
  isWorking: boolean;
  isWaitingPermission: boolean;
  hasUnreadMessages: boolean;
  sendState: SessionSendState | null;
  latestMessageAt: number;
  pullRequest: SessionPullRequestView | null;
};

export type ProjectBoard = Record<ProjectBoardBucket, ProjectBoardRow[]>;

const isOpenedBy = (session: SessionMeta, coordinatorSessionId: string | null): boolean =>
  coordinatorSessionId !== null &&
  (session.openedBySessionId === coordinatorSessionId ||
    session.openedByRootSessionId === coordinatorSessionId);

/**
 * Stable task numbers: every conversation the coordinator opened, archived ones
 * included, numbered by creation time, so a number never moves to another task.
 */
export function buildCoordinatorTaskNumbers(
  sessions: readonly SessionMeta[],
  coordinatorSessionId: string | null
): Map<string, number> {
  const opened = sessions
    .filter((session) => !session.parentSessionId && isOpenedBy(session, coordinatorSessionId))
    .sort((a, b) => createdTime(a) - createdTime(b) || a.id.localeCompare(b.id));
  return new Map(opened.map((session, index) => [session.id, index + 1]));
}

/** Accepted only while nothing happened in the task after the user accepted it. */
export function isCoordinatorTaskAccepted(
  session: Pick<SessionMeta, 'coordinatorTaskAcceptedAt'>,
  latestMessageAt: number
): boolean {
  const acceptedAt = session.coordinatorTaskAcceptedAt;
  return typeof acceptedAt === 'number' && acceptedAt >= latestMessageAt;
}

/**
 * Every conversation the coordinator opened (wherever it runs), bucketed by
 * derived status. Accepting a task archives its session while keeping it in the
 * board's `accepted` group (collapsed by default in the UI). Child Tabs roll up
 * into their root the way sidebar rows do. Only the current user's own
 * conversations are listed, as in the sidebar's "My" scope; an unknown account
 * lists none.
 */
export function buildProjectBoard(options: {
  sessions: readonly SessionMeta[];
  childSessionsByParent: Map<string, SessionMeta[]>;
  project: CoordinatorProjectKey | null;
  coordinatorSessionId: string | null;
  currentUserId: string | null | undefined;
  liveSessionStatuses: ReadonlyMap<string, SessionStatus>;
  sendStates: Readonly<Record<string, SessionSendState>>;
  /** Every session including archived ones, so accepted (archived) tasks keep their numbers. */
  numberingSessions?: readonly SessionMeta[];
  /** Include non-accepted archived tasks too (used by coordinator conversation history strips so archived tasks keep their title, number and state). */
  includeArchived?: boolean;
}): ProjectBoard {
  const board: ProjectBoard = { needsYou: [], working: [], review: [], accepted: [] };
  const { coordinatorSessionId } = options;
  const taskNumbers = buildCoordinatorTaskNumbers(
    options.numberingSessions ?? options.sessions,
    coordinatorSessionId
  );
  for (const session of options.sessions) {
    if (session.parentSessionId) continue;
    if (session.id === coordinatorSessionId) continue;
    if (!isSessionInMyScope(session, options.currentUserId)) continue;
    if (isCoordinatorSession(session)) continue;
    if (!isOpenedBy(session, coordinatorSessionId)) continue;
    const isAcceptedArchive =
      Boolean(session.isArchived) && typeof session.coordinatorTaskAcceptedAt === 'number';
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
    const bucket: ProjectBoardBucket = session.isArchived
      ? 'accepted'
      : needsYou
        ? 'needsYou'
        : activity.isWorking || sendState === 'sending'
          ? 'working'
          : isCoordinatorTaskAccepted(session, activity.latestMessageAt)
            ? 'accepted'
            : 'review';
    board[bucket].push({
      session,
      bucket,
      taskNumber: taskNumbers.get(session.id) ?? null,
      createdManually: false,
      isWorking: activity.isWorking,
      isWaitingPermission: activity.isWaitingPermission,
      hasUnreadMessages: activity.hasUnreadMessages,
      sendState,
      latestMessageAt: activity.latestMessageAt,
      pullRequest: resolveSessionPrimaryPullRequest(session),
    });
  }
  for (const bucket of PROJECT_BOARD_BUCKETS) {
    board[bucket].sort((a, b) => b.latestMessageAt - a.latestMessageAt);
  }
  return board;
}
