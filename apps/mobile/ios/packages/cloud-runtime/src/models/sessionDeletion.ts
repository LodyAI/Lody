import type { Session } from './catalog.ts';

// Match Lody's delete operation: contained tabs, not independently opened sessions.
export function sessionDeletionTargets(sessions: Session[], sessionId: string) {
  return sessions.filter(
    (session) =>
      session.id === sessionId || session.parentSessionId === sessionId,
  );
}

export function sessionDeletionBlocked(sessions: Session[]) {
  return sessions.some(
    (session) =>
      !session.archived &&
      !['idle', 'pending', 'completed', 'error'].includes(session.status),
  );
}
