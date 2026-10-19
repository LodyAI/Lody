import type { LoroRepo } from 'loro-repo';
import { getSessionIdFromRoomId, SESSION_DOC_PREFIX } from './index';
import { isLoroRepoDocDeleted } from './repo-doc-meta';
import { collectSessionArchiveTargets } from './session-archive-targets';
import type { SessionId } from './ids';
import type { SessionMeta } from './schema';

export type SessionOperation = 'archive' | 'restore' | 'delete' | 'collaboration';

/**
 * Caller establishes source readiness before this read. Root and descendants
 * come from one Repo snapshot; later creations and UI projections are excluded.
 * A missing/deleted root or failed query rejects before the caller can mutate.
 */
export async function readSessionOperationTargets(
  repo: Pick<LoroRepo, 'listDoc'>,
  sessionId: SessionId,
  operation: SessionOperation
): Promise<[SessionMeta, ...SessionMeta[]]> {
  const entries = await repo.listDoc({ prefix: SESSION_DOC_PREFIX });
  const sessions: SessionMeta[] = [];
  for (const entry of entries) {
    if (isLoroRepoDocDeleted(entry)) continue;
    const id = getSessionIdFromRoomId(entry.docId);
    if (id === null) continue;
    sessions.push({ ...entry.meta, id } as SessionMeta);
  }
  const selected = sessions.find((session) => session.id === sessionId);
  if (!selected) throw new Error(`Session metadata missing for ${sessionId}`);

  let root: SessionMeta = selected;
  if (operation === 'collaboration') {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const visited = new Set<SessionId>();
    while (!visited.has(root.id)) {
      visited.add(root.id);
      const parentId: SessionId | undefined = root.parentSessionId ?? root.openedBySessionId;
      const parent: SessionMeta | undefined = parentId ? byId.get(parentId) : undefined;
      if (!parent || parent.isArchived || visited.has(parent.id)) break;
      root = parent;
    }
    sessionId = root.id;
  }

  const descendants =
    operation === 'archive' || operation === 'collaboration'
      ? collectSessionArchiveTargets(sessionId, sessions)
      : sessions.filter(
          (session) => session.id !== sessionId && session.parentSessionId === sessionId
        );
  return [root, ...descendants];
}

/** Read the live ancestry, including ancestors that became archived after a stop. */
export async function isSessionCollaborationStopped(
  repo: Pick<LoroRepo, 'getDocMeta'>,
  sessionId: SessionId
): Promise<boolean> {
  const visited = new Set<SessionId>();
  let current: SessionId | undefined = sessionId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const record = await repo.getDocMeta(`${SESSION_DOC_PREFIX}${current}`);
    if (!record || isLoroRepoDocDeleted(record) || !record.meta) return false;
    const meta = record.meta as SessionMeta;
    if (meta.collaborationStopped === true) return true;
    current = meta.parentSessionId ?? meta.openedBySessionId;
  }
  return false;
}
