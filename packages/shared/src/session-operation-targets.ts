import type { LoroRepo } from 'loro-repo';
import { getSessionIdFromRoomId, SESSION_DOC_PREFIX } from './index';
import { isLoroRepoDocDeleted } from './repo-doc-meta';
import { collectSessionArchiveTargets } from './session-archive-targets';
import type { SessionId } from './ids';
import type { SessionMeta } from './schema';

export type SessionOperation = 'archive' | 'restore' | 'delete';

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
  const root = sessions.find((session) => session.id === sessionId);
  if (!root) throw new Error(`Session metadata missing for ${sessionId}`);

  const descendants =
    operation === 'archive'
      ? collectSessionArchiveTargets(sessionId, sessions)
      : sessions.filter(
          (session) => session.id !== sessionId && session.parentSessionId === sessionId
        );
  return [root, ...descendants];
}
