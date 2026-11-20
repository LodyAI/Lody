import { getSessionRoomId, isLoroRepoDocDeleted, type SessionMeta } from '@lody/shared';
import { Effect } from 'effect';
import type { SessionDocument, LoroDocumentManager } from '../lib/loro/doc';
import { createSessionBackend } from './session-backend';
import {
  awaitNativeWorkSettlement,
  publishTurnCompletion,
  type NativeWorkSettlement,
  type NativeWorkWatch,
} from './turn-completion';

/**
 * @deprecated Promise host adapter for the same execution owner as below. The wait is
 * not completion bookkeeping: it holds no write and ends with the agent or the signal.
 */
export const awaitNativeWorkSettlementLegacy = (
  watch: NativeWorkWatch,
  signal: AbortSignal
): Promise<NativeWorkSettlement> => Effect.runPromise(awaitNativeWorkSettlement(watch), { signal });

/**
 * @deprecated Promise host adapter. Remove when Session execution and history owners
 * consume native effects. The execution service retains this Promise in its host drain.
 */
export const publishTurnCompletionLegacy = (options: {
  completedAt: number;
  sessionDoc: SessionDocument;
  workspaceDocument: Pick<LoroDocumentManager, 'getRemoteStreamsGeneration'> &
    Partial<Pick<LoroDocumentManager, 'getOrCreateSessionDoc' | 'isSessionDocCleaning' | 'repo'>>;
  signal: AbortSignal;
  notify: () => Promise<void>;
}): Promise<void> => {
  const { sessionDoc, workspaceDocument } = options;
  const fromPromise = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => cause });
  const isDocLive = (doc: SessionDocument): boolean =>
    !doc.isDestroyed && !workspaceDocument.isSessionDocCleaning?.(doc.sessionId);
  return Effect.runPromise(
    Effect.gen(function* () {
      const remoteGeneration = workspaceDocument.getRemoteStreamsGeneration();
      let currentDoc: SessionDocument | null = sessionDoc;
      let currentBackend = isDocLive(sessionDoc)
        ? yield* fromPromise(() => createSessionBackend(sessionDoc))
        : null;
      const isClosedSessionMeta = async (doc: SessionDocument): Promise<boolean> => {
        if (!workspaceDocument.repo?.getDocMeta) return false;
        const roomId = doc.roomId || getSessionRoomId(doc.sessionId);
        const meta = await workspaceDocument.repo.getDocMeta(roomId);
        return (
          isLoroRepoDocDeleted(meta) ||
          Boolean((meta?.meta as Partial<SessionMeta> | undefined)?.isArchived)
        );
      };
      const reacquireLiveDoc = async (): Promise<{
        doc: SessionDocument;
        backend: Awaited<ReturnType<typeof createSessionBackend>>;
      } | null> => {
        const probe = currentDoc ?? sessionDoc;
        if (!workspaceDocument.getOrCreateSessionDoc) {
          const backend = currentBackend ?? (await createSessionBackend(probe));
          currentDoc = probe;
          currentBackend = backend;
          return { doc: probe, backend };
        }
        if (await isClosedSessionMeta(probe)) {
          currentDoc = null;
          currentBackend = null;
          return null;
        }
        const liveDoc = await workspaceDocument.getOrCreateSessionDoc(probe.sessionId);
        const backend = await createSessionBackend(liveDoc);
        currentDoc = liveDoc;
        currentBackend = backend;
        return { doc: liveDoc, backend };
      };
      yield* publishTurnCompletion({
        persist: fromPromise(() =>
          currentDoc && currentBackend && isDocLive(currentDoc)
            ? currentBackend.flushLocalWrites()
            : reacquireLiveDoc().then((live) => live?.backend.flushLocalWrites())
        ),
        // This ends only a read waiter. Repo/backend owners retain raw synchronization;
        // no publication is chained onto its Promise after the Effect deadline.
        confirm: fromPromise(async () => {
          if (remoteGeneration === undefined) return true;
          if (workspaceDocument.getRemoteStreamsGeneration() !== remoteGeneration) return false;
          const backend =
            currentDoc && currentBackend && isDocLive(currentDoc)
              ? currentBackend
              : (await reacquireLiveDoc())?.backend;
          if (!backend) return true;
          const synced = await backend.waitUntilSynced({ timeoutMs: 4_000 });
          return synced && workspaceDocument.getRemoteStreamsGeneration() === remoteGeneration;
        }),
        publishUnread: fromPromise(() =>
          currentDoc && isDocLive(currentDoc)
            ? currentDoc.setLastMessageAt(options.completedAt)
            : reacquireLiveDoc().then((live) =>
                live ? live.doc.setLastMessageAt(options.completedAt) : undefined
              )
        ),
        notify: fromPromise(() => {
          if (!currentDoc) return Promise.resolve();
          if (isDocLive(currentDoc)) return options.notify();
          return isClosedSessionMeta(currentDoc).then((closed) =>
            closed ? undefined : options.notify()
          );
        }),
      });
    }),
    { signal: options.signal }
  );
};
