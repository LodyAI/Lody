import type { SessionMeta } from '@lody/shared';

/** Existing descendants are candidates only; selection never inherits authorization. */
export function getSessionShareCandidates(
  rootId: string,
  sessions: readonly SessionMeta[]
): SessionMeta[] {
  const byParent = new Map<string, SessionMeta[]>();
  for (const session of sessions) {
    for (const parent of new Set([session.parentSessionId, session.openedBySessionId])) {
      if (!parent) continue;
      const children = byParent.get(parent) ?? [];
      children.push(session);
      byParent.set(parent, children);
    }
  }
  const seen = new Set([rootId]);
  const queue = [rootId];
  const result: SessionMeta[] = [];
  for (let index = 0; index < queue.length; index++) {
    for (const child of byParent.get(queue[index]) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      result.push(child);
      queue.push(child.id);
    }
  }
  return result;
}
