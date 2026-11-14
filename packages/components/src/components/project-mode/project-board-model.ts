import {
  isCoordinatorSession,
  type MachineId,
  type SessionMeta,
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
 * The project's coordinator: one per person per project, so the most recently
 * active unarchived coordinator conversation this user owns in that project.
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
    if (userId && session.userId !== userId) continue;
    if (!isSessionInCoordinatorProject(session, key)) continue;
    if (!best || activityTime(session) > activityTime(best)) best = session;
  }
  return best;
}

const activityTime = (session: SessionMeta): number =>
  session.lastMessageAt ?? (Date.parse(session.createdAt) || 0);

/**
 * Board columns, in the order the user should look at them. "Needs you" is a
 * pending permission or question, or an input that failed to send; there is no
 * durable "failed turn" signal in session metadata yet.
 */
export type ProjectBoardBucket = 'needsYou' | 'working' | 'unread' | 'done';
export const PROJECT_BOARD_BUCKETS: readonly ProjectBoardBucket[] = [
  'needsYou',
  'working',
  'unread',
  'done',
];

export type ProjectBoardRow = {
  session: SessionMeta;
  bucket: ProjectBoardBucket;
  /** In the project but not opened by this coordinator. */
  createdManually: boolean;
  isWorking: boolean;
  isWaitingPermission: boolean;
  hasUnreadMessages: boolean;
  sendState: SessionSendState | null;
  latestMessageAt: number;
};

export type ProjectBoard = Record<ProjectBoardBucket, ProjectBoardRow[]>;

/**
 * Every conversation the coordinator opened (wherever it runs), plus the other
 * top-level conversations of its project, bucketed by derived status. Child
 * Tabs roll up into their root the way sidebar rows do. Only the current user's
 * own conversations are listed, as in the sidebar's "My" scope; an unknown
 * account lists none.
 */
export function buildProjectBoard(options: {
  sessions: readonly SessionMeta[];
  childSessionsByParent: Map<string, SessionMeta[]>;
  project: CoordinatorProjectKey | null;
  coordinatorSessionId: string | null;
  currentUserId: string | null | undefined;
  liveSessionStatuses: ReadonlyMap<string, SessionStatus>;
  sendStates: Readonly<Record<string, SessionSendState>>;
}): ProjectBoard {
  const board: ProjectBoard = { needsYou: [], working: [], unread: [], done: [] };
  const { coordinatorSessionId, project } = options;
  for (const session of options.sessions) {
    if (session.isArchived || session.parentSessionId) continue;
    if (session.id === coordinatorSessionId) continue;
    if (!isSessionInMyScope(session, options.currentUserId)) continue;
    // Another coordinator of the same project is a conversation of its own, not a task.
    if (isCoordinatorSession(session)) continue;
    const opened =
      coordinatorSessionId !== null &&
      (session.openedBySessionId === coordinatorSessionId ||
        session.openedByRootSessionId === coordinatorSessionId);
    const inProject = project !== null && isSessionInCoordinatorProject(session, project);
    if (!opened && !inProject) continue;
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
    const bucket: ProjectBoardBucket = needsYou
      ? 'needsYou'
      : activity.isWorking || sendState === 'sending'
        ? 'working'
        : activity.hasUnreadMessages
          ? 'unread'
          : 'done';
    board[bucket].push({
      session,
      bucket,
      createdManually: !opened,
      isWorking: activity.isWorking,
      isWaitingPermission: activity.isWaitingPermission,
      hasUnreadMessages: activity.hasUnreadMessages,
      sendState,
      latestMessageAt: activity.latestMessageAt,
    });
  }
  for (const bucket of PROJECT_BOARD_BUCKETS) {
    board[bucket].sort((a, b) => b.latestMessageAt - a.latestMessageAt);
  }
  return board;
}
