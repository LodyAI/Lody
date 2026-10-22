import type { SessionMeta } from './schema';
import type { SessionId } from './ids';

/** Archive contained Tabs only; opened-by provenance is not lifecycle ownership. */
export function collectSessionArchiveTargets(
  sessionId: SessionId,
  sessions: readonly SessionMeta[]
): SessionMeta[] {
  return collectDescendants(sessionId, sessions, (session) => session.parentSessionId);
}

/**
 * Contained Tabs plus every Session opened from this tree, recursively. Archive
 * follows these only when the user explicitly chose to include them.
 */
export function collectSessionTreeTargets(
  sessionId: SessionId,
  sessions: readonly SessionMeta[]
): SessionMeta[] {
  return collectDescendants(
    sessionId,
    sessions,
    (session) => session.parentSessionId ?? session.openedBySessionId
  );
}

function collectDescendants(
  sessionId: SessionId,
  sessions: readonly SessionMeta[],
  ownerOf: (session: SessionMeta) => SessionId | undefined
): SessionMeta[] {
  const children = new Map<SessionId, SessionMeta[]>();
  for (const session of sessions) {
    const owner = ownerOf(session);
    if (!owner) continue;
    const siblings = children.get(owner) ?? [];
    siblings.push(session);
    children.set(owner, siblings);
  }
  const visited = new Set<SessionId>([sessionId]);
  const targets: SessionMeta[] = [];
  for (const parentId of visited) {
    for (const child of children.get(parentId) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      targets.push(child);
    }
  }
  return targets;
}
