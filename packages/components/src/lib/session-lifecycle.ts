import type { SessionId, SessionMeta } from '@lody/shared';

/**
 * Return the complete lifecycle subtree rooted at `sessionId`.
 *
 * Child tabs (`parentSessionId`) share their parent's lifecycle. Sessions
 * opened by an agent (`openedBySessionId`) own their own workspace, but the
 * opener still owns their lifecycle as a subtree. `openedByRootSessionId`
 * keeps that ownership reachable when the precise opener was a child tab.
 */
export function collectSessionLifecycleIds(
  sessionId: SessionId,
  sessions: readonly SessionMeta[]
): SessionId[] {
  const childrenBySessionId = new Map<SessionId, Set<SessionId>>();

  for (const session of sessions) {
    const ownerIds = new Set(
      [session.parentSessionId, session.openedBySessionId, session.openedByRootSessionId].filter(
        (id): id is SessionId => id !== undefined
      )
    );
    for (const ownerId of ownerIds) {
      const children = childrenBySessionId.get(ownerId);
      if (children) children.add(session.id);
      else childrenBySessionId.set(ownerId, new Set([session.id]));
    }
  }

  const result: SessionId[] = [];
  const pending = [sessionId];
  const included = new Set<SessionId>();
  for (let index = 0; index < pending.length; index += 1) {
    const currentId = pending[index];
    if (currentId === undefined || included.has(currentId)) continue;
    included.add(currentId);
    result.push(currentId);
    pending.push(...(childrenBySessionId.get(currentId) ?? []));
  }
  return result;
}
