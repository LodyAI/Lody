import type { SessionMeta } from './schema';
import type { SessionId } from './ids';

/** Archive descendants without turning provenance into deletion ownership. */
export function collectSessionArchiveTargets(
  sessionId: SessionId,
  sessions: readonly SessionMeta[]
): SessionMeta[] {
  const children = new Map<SessionId, SessionMeta[]>();
  for (const session of sessions) {
    const owner = session.parentSessionId ?? session.openedBySessionId;
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
