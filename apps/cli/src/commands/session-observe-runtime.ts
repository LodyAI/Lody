import { Effect, Exit, Scope } from 'effect';
import { isLoroRepoDocDeleted, type SessionId, type SessionMeta } from '@lody/shared';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { createSessionBackend } from '@/session/session-backend';
import { SessionObserver, type SessionObserveEvent } from './session-observe';

const attempt = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: (error) => error });

/** Isolated read-only scope shared by single-Session and workspace observation. */
export async function acquireSessionObservation(options: {
  manager: LoroDocumentManager;
  sessionId: SessionId;
  signal: AbortSignal;
  emit: (event: SessionObserveEvent) => Promise<void>;
  onError: (error: unknown) => void;
  onRemoved?: () => void;
}) {
  const scope = Effect.runSync(Scope.make());
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  try {
    const reader = await Effect.runPromise(
      Effect.gen(function* () {
        const { manager, sessionId } = options;
        const doc = yield* Effect.acquireRelease(
          attempt(() => manager.getOrCreateSessionDoc(sessionId, { skipAutoRead: true })),
          () => Effect.promise(() => manager.cleanSessionDoc(sessionId, { preserveStatus: true }))
        );
        yield* attempt(() => doc.waitForRemoteSync());
        yield* attempt(() =>
          manager.syncRemoteDocOrThrow(doc.roomId, { reason: 'session.observe.initial' })
        );
        if (options.signal.aborted) return undefined;
        const backend = yield* attempt(() => createSessionBackend(doc));
        const observer = new SessionObserver({
          sessionId,
          history: backend.history,
          subscribeControl: (listener) => doc.subscribeControl(listener),
          async readMeta() {
            const raw = await manager.repo.getDocMeta(doc.roomId);
            if (isLoroRepoDocDeleted(raw)) return null;
            if (!raw?.meta) throw new Error(`Session metadata is unavailable: ${sessionId}`);
            return raw.meta as SessionMeta;
          },
          fresh: true,
          emit: options.emit,
          onError: options.onError,
          onRemoved: options.onRemoved,
        });
        yield* Effect.acquireRelease(Effect.succeed(observer), (owned) =>
          Effect.promise(() => owned.close())
        );
        let confirmed = true;
        let generation = 0;
        let recoveryRequested = false;
        let recovery: Promise<void> | undefined;
        const requestRecovery = () => {
          recoveryRequested = true;
          if (recovery) return;
          recovery = (async () => {
            while (recoveryRequested && !options.signal.aborted) {
              recoveryRequested = false;
              const observedGeneration = generation;
              await manager.syncMetaOrThrow({ reason: 'session.observe.reconnect:meta' });
              await manager.syncRemoteDocOrThrow(doc.roomId, {
                reason: 'session.observe.reconnect:doc',
              });
              if (
                !options.signal.aborted &&
                observedGeneration === generation &&
                doc.getDocRoomStatus() === 'joined'
              ) {
                confirmed = true;
                observer.setFreshness(true);
              }
            }
          })()
            .catch(options.onError)
            .finally(() => {
              recovery = undefined;
            });
        };
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            doc.onDocRoomStatusChange((status) => {
              if (status !== 'joined') {
                generation += 1;
                confirmed = false;
                observer.setFreshness(false);
              } else if (!confirmed) requestRecovery();
            })
          ),
          (unsubscribe) =>
            Effect.promise(async () => {
              unsubscribe();
              await recovery;
            })
        );
        yield* attempt(() => observer.start());
        return observer;
      }).pipe(Effect.provideService(Scope.Scope, scope))
    );
    if (!reader) {
      await close();
      return undefined;
    }
    return { observer: reader, close };
  } catch (error) {
    await close();
    throw error;
  }
}
