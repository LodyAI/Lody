import { isDeepStrictEqual } from 'node:util';
import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  type SessionHistory,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import type { LoroDocumentManager } from './loro/doc';

/** JSON-only preparation, persisted before any Session mutation. */
export type PreparedSessionInput = {
  sessionId: SessionId;
  meta: SessionMeta;
  userTurn: SessionHistoryInput;
  source?: SessionHistoryInput;
};

export function hasSessionDispatchEvidence(
  meta: SessionMeta,
  history: readonly SessionHistory[],
  userTurnId: string
): boolean {
  const user = history.find((entry) => entry.id === userTurnId && entry.role === 'user');
  return (
    !!user &&
    (meta.latestUserMsgId === userTurnId ||
      meta.processingUserMsgId === userTurnId ||
      meta.lastHandledUserMsgId === userTurnId ||
      user.status === 'handled' ||
      user.status === 'failed' ||
      user.status === 'canceled' ||
      history.some(
        (entry) =>
          entry.role === 'assistant' &&
          entry.userTurnId === userTurnId &&
          (entry.finished === true || typeof entry.endedAt === 'number')
      ))
  );
}

export async function isPreparedSessionDispatched(
  manager: LoroDocumentManager,
  prepared: PreparedSessionInput
): Promise<boolean> {
  const record = await manager.repo.getDocMeta(getSessionRoomId(prepared.sessionId));
  if (!record?.meta || isLoroRepoDocDeleted(record)) return false;
  const session = await manager.getOrCreateSessionDoc(prepared.sessionId);
  return hasSessionDispatchEvidence(
    record.meta as SessionMeta,
    await session.getHistory(),
    prepared.userTurn.id
  );
}

/** Replay only inserts missing records; mutable status/title and consumed turns survive. */
export async function materializePreparedSessionInput(
  manager: LoroDocumentManager,
  prepared: PreparedSessionInput
): Promise<void> {
  const roomId = getSessionRoomId(prepared.sessionId);
  const existing = await manager.repo.getDocMeta(roomId);
  if (existing && isLoroRepoDocDeleted(existing)) throw new Error('Prepared Session was deleted');
  if (existing?.meta && (existing.meta as SessionMeta).id) {
    const meta = existing.meta as SessionMeta;
    if (
      meta.id !== prepared.sessionId ||
      meta.machineId !== prepared.meta.machineId ||
      meta.userId !== prepared.meta.userId ||
      meta.agentConfigId !== prepared.meta.agentConfigId
    ) {
      throw new Error('Prepared Session identity conflict');
    }
  } else await manager.repo.upsertDocMeta(roomId, prepared.meta);
  const session = await manager.getOrCreateSessionDoc(prepared.sessionId);
  await session.updateHistory((history) => {
    const next = [...history];
    for (const entry of [prepared.source, prepared.userTurn]) {
      if (!entry) continue;
      const prior = next.find((item) => item.id === entry.id);
      if (prior) {
        if (
          prior.role !== entry.role ||
          !isDeepStrictEqual(prior.items, entry.items) ||
          !isDeepStrictEqual(
            JSON.parse(JSON.stringify(prior.inputConfig ?? {})),
            JSON.parse(JSON.stringify(entry.inputConfig ?? {}))
          )
        )
          throw new Error('Prepared Session Turn identity conflict');
      } else next.push(entry);
    }
    return next;
  });
  await manager.repo.flush();
}

/** Irreversible handoff to the ordinary dispatch watcher. Never call with stale authorization. */
export async function commitPreparedSessionDispatch(
  manager: LoroDocumentManager,
  prepared: PreparedSessionInput
): Promise<void> {
  if (await isPreparedSessionDispatched(manager, prepared)) return;
  await manager.repo.upsertDocMeta(getSessionRoomId(prepared.sessionId), {
    latestUserMsgId: prepared.userTurn.id,
    lastMissingHistoryUserMsgId: undefined,
  } satisfies Partial<SessionMeta>);
}
