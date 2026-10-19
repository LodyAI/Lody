import { subscribeSessionChanges } from '@/lib/loro/doc';
import { createSessionBackend } from '@/session/session-backend';
import {
  getServerNow,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { Effect, Layer } from 'effect';
import { CoordinatorPorts, type CoordinatorHistory } from '../coordinator-ports';
import type { OperationInboxLegacy } from '../inbox/legacy';
import type { LodyOperationCoordinatorOptions } from '../operation-coordinator';
import type { LodyOperationStore } from '../operation-store';

/** Named upstream adapter: Session/history/materialization are not yet native dependencies. */
export const coordinatorSessionsLayer = (
  options: LodyOperationCoordinatorOptions,
  store: LodyOperationStore,
  inbox: OperationInboxLegacy,
  active: () => boolean,
  runSignal: (effect: Effect.Effect<void>) => void,
  controllers: Map<string, AbortController>,
  rawWork: Set<Promise<unknown>>,
  claimToken: string
) => {
  const io = <A>(f: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: (signal) => {
        const raw = f(signal);
        rawWork.add(raw);
        void raw.finally(() => rawWork.delete(raw)).catch(() => undefined);
        return raw;
      },
      catch: (cause) => cause,
    });
  const metadata = (id: SessionId) =>
    io(async () => {
      const record = await options.workspaceDocument.repo.getDocMeta(getSessionRoomId(id));
      return record?.meta && !isLoroRepoDocDeleted(record)
        ? { meta: record.meta as SessionMeta }
        : undefined;
    });
  return Layer.succeed(CoordinatorPorts, {
    active,
    now: options.now ?? getServerNow,
    claimToken,
    metadata,
    execution: (id) => options.executionService.getExecutionSnapshot(id),
    operation: (key) =>
      Effect.sync(() => {
        const controller = controllers.get(key) ?? new AbortController();
        controllers.set(key, controller);
        return { signal: controller.signal };
      }),
    cancelInactive: (keys) =>
      Effect.sync(() => {
        for (const [key, controller] of controllers)
          if (!keys.has(key)) {
            controller.abort();
            controllers.delete(key);
          }
      }),
    receipts: Effect.try({
      try: () => store.inbox.historyReceipts(options.workspaceId),
      catch: (cause) => cause,
    }),
    wakeInbox: io(() => inbox.wake()),
    session: (id) =>
      io(async () => {
        const record = await options.workspaceDocument.repo.getDocMeta(getSessionRoomId(id));
        if (!record?.meta || isLoroRepoDocDeleted(record))
          throw new Error('Session state unavailable');
        const doc = await options.workspaceDocument.getOrCreateSessionDoc(id);
        const backend = await createSessionBackend(doc, record.meta as SessionMeta);
        return {
          meta: record.meta as SessionMeta,
          readTurn: (turn) => io(() => backend.readTurn(turn)),
          readTurnOutput: (turn) => io(() => backend.readTurnOutput(turn)),
          applyHistoryAction: (action) => io(() => backend.applyHistoryAction(action)),
          flushLocalWrites: io(() => backend.flushLocalWrites()),
          observe: (wake) =>
            Effect.sync(() => {
              const detach = subscribeSessionChanges(doc, () => runSignal(wake), backend);
              let closed = false;
              return Effect.sync(() => {
                if (!closed) {
                  detach();
                  closed = true;
                }
              });
            }),
        } satisfies CoordinatorHistory;
      }),
    confirmReadable: (id, reason) =>
      io(() =>
        options.confirmTargetReadable
          ? options.confirmTargetReadable(getSessionRoomId(id), reason)
          : options.workspaceDocument.syncRemoteDocOrThrow(getSessionRoomId(id), { reason })
      ),
    materialize: (operation, item, index) =>
      io(() => {
        const key = operation.requesterSessionId + '\0' + operation.operationId;
        const controller = controllers.get(key);
        if (!controller) throw new Error('Operation materialization has no resource owner');
        if (!active() || controller.signal.aborted) return Promise.resolve();
        return options.materializeTarget(operation, item, index, controller.signal);
      }),
    warn: (message, cause) =>
      Effect.sync(() =>
        options.logger.warn(`${message}${cause === undefined ? '' : `: ${String(cause)}`}`)
      ),
  });
};
