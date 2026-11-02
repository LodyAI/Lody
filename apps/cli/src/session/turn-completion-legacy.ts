import { Effect } from 'effect';
import type { SessionDocument, LoroDocumentManager } from '../lib/loro/doc';
import { createSessionBackend } from './session-backend';
import { publishTurnCompletion } from './turn-completion';

/**
 * @deprecated Promise host adapter. Remove when Session execution and history owners
 * consume native effects. The execution service retains this Promise in its host drain.
 */
export const publishTurnCompletionLegacy = (options: {
  completedAt: number;
  sessionDoc: SessionDocument;
  workspaceDocument: Pick<LoroDocumentManager, 'getRemoteStreamsGeneration'>;
  signal: AbortSignal;
  notify: () => Promise<void>;
}): Promise<void> => {
  const { sessionDoc, workspaceDocument } = options;
  const fromPromise = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => cause });
  return Effect.runPromise(
    Effect.gen(function* () {
      const remoteGeneration = workspaceDocument.getRemoteStreamsGeneration();
      const backend = yield* fromPromise(() => createSessionBackend(sessionDoc));
      yield* publishTurnCompletion({
        persist: fromPromise(() => backend.flushLocalWrites()),
        // This ends only a read waiter. Repo/backend owners retain raw synchronization;
        // no publication is chained onto its Promise after the Effect deadline.
        confirm: fromPromise(async () => {
          if (remoteGeneration === undefined) return true;
          if (workspaceDocument.getRemoteStreamsGeneration() !== remoteGeneration) return false;
          const synced = await backend.waitUntilSynced({ timeoutMs: 4_000 });
          return synced && workspaceDocument.getRemoteStreamsGeneration() === remoteGeneration;
        }),
        publishUnread: fromPromise(() => sessionDoc.setLastMessageAt(options.completedAt)),
        notify: fromPromise(options.notify),
      });
    }),
    { signal: options.signal }
  );
};
