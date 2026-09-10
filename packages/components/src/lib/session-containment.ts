import type { SessionId, SessionMeta } from '@lody/shared';

/** Return the Session and every child Tab contained by its `parentSessionId` subtree. */
export function collectSessionContainmentIds(
  sessionId: SessionId,
  sessions: readonly SessionMeta[]
): SessionId[] {
  const childrenBySessionId = new Map<SessionId, SessionId[]>();

  for (const session of sessions) {
    if (session.parentSessionId === undefined) continue;
    const children = childrenBySessionId.get(session.parentSessionId);
    if (children) children.push(session.id);
    else childrenBySessionId.set(session.parentSessionId, [session.id]);
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
