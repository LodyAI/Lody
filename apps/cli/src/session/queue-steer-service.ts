import { Context, Effect, Layer } from 'effect';
import {
  getServerNow,
  normalizeSessionTurnInputConfig,
  queueItemRevision,
  resolveSessionHistoryStatus,
  type SessionId,
  type SessionQueueSteerResponse,
  type SessionQueueMutation,
  type SessionQueueMutationResponse,
} from '@lody/shared';
import { readSessionHistory } from '@lody/shared/session-data';
import { hasActiveMessageQueueEditingLease, type SessionDocument } from '@/lib/loro/doc';
import { formatErrorMessage } from '@/utils/format-error';
import { ActiveTurnSteerPort, PersistenceFailure } from './active-turn-steer-port';
import { buildQueuedMessageUserTurn } from './queued-message-turn';
import {
  isQueueSteerMarkerOwnedBy,
  type QueueSteerOperationMarker,
} from './session-queue-steer-operation-store';
import type { SessionExecutionServiceDeps } from './session-execution-service';

type Request = { sessionId: SessionId; expectedTurnId: string; queueItemId: string };
type Marker = QueueSteerOperationMarker;
type Recovery = SessionQueueSteerResponse | 'deferred' | null;
type Deps = Pick<
  SessionExecutionServiceDeps,
  | 'workspaceId'
  | 'machineId'
  | 'workspaceDocument'
  | 'queueSteerOperationStore'
  | 'recordChatFailure'
  | 'logger'
> & {
  requeue(
    sessionId: SessionId,
    userTurnId: string
  ): Promise<'requeued' | 'not-requeueable' | 'requeue-failed'>;
  failTurn(sessionId: SessionId, doc: SessionDocument, userTurnId: string): Promise<void>;
};

const persist = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new PersistenceFailure({ cause, message: formatErrorMessage(cause) }),
  });

const respond = (
  request: Pick<Request, 'sessionId' | 'queueItemId'>,
  disposition: SessionQueueSteerResponse['disposition'],
  details: { userTurnId?: string; error?: string } = {}
): SessionQueueSteerResponse => ({
  type: 'session/queue-steer_response',
  sessionId: request.sessionId,
  queueItemId: request.queueItemId,
  accepted: disposition === 'accepted',
  disposition,
  ...details,
});

/** Callers serialize these effects with the execution owner's session mutation queue. */
export class QueueSteerService extends Context.Tag('lody/QueueSteerService')<
  QueueSteerService,
  {
    steerQueueItem(request: Request): Effect.Effect<SessionQueueSteerResponse>;
    recover(
      sessionId: SessionId,
      doc: SessionDocument
    ): Effect.Effect<Recovery, PersistenceFailure>;
    mutate(request: SessionQueueMutation): Effect.Effect<SessionQueueMutationResponse>;
  }
>() {
  static layer(deps: Deps) {
    return Layer.effect(QueueSteerService, QueueSteerService.make(deps));
  }

  static make(deps: Deps) {
    return Effect.gen(function* () {
      const active = yield* ActiveTurnSteerPort;
      const receipts = new Map<string, SessionQueueSteerResponse>();
      const remember = (key: string, response: SessionQueueSteerResponse) => {
        receipts.delete(key);
        receipts.set(key, response);
        if (receipts.size > 512) {
          const oldest = receipts.keys().next().value;
          if (oldest !== undefined) receipts.delete(oldest);
        }
        return response;
      };
      const owned = (marker: Marker) =>
        isQueueSteerMarkerOwnedBy(marker, deps.workspaceId, deps.machineId);
      const flush = () =>
        persist(() => deps.workspaceDocument.persistPendingChanges('queue-steer-commit'));
      const write = (
        sessionId: SessionId,
        marker: Omit<Marker, 'workspaceId' | 'machineId' | 'sessionId' | 'updatedAt'>
      ) => {
        const durable: Marker = {
          ...marker,
          sessionId,
          workspaceId: deps.workspaceId,
          machineId: deps.machineId,
          updatedAt: getServerNow(),
        };
        return persist(() => deps.queueSteerOperationStore.record(durable)).pipe(
          Effect.as(durable)
        );
      };
      const receipt = (sessionId: SessionId, marker: Marker) =>
        marker.completedAt && marker.response
          ? respond({ sessionId, queueItemId: marker.queueItemId }, marker.response.disposition, {
              userTurnId: marker.response.userTurnId,
              error: marker.response.error,
            })
          : null;
      const complete = Effect.fn('QueueSteer.complete')(function* (
        sessionId: SessionId,
        marker: Marker,
        response: SessionQueueSteerResponse
      ) {
        yield* write(sessionId, {
          ...marker,
          completedAt: getServerNow(),
          response: {
            disposition: response.disposition,
            userTurnId: response.userTurnId,
            error: response.error,
          },
        });
        return remember(marker.operationKey, response);
      });

      // A surviving legacy row may contain an edit accepted after its history was frozen.
      // Preserve it and defer rather than silently deleting somebody else's work.
      const removeReservedRow = Effect.fn('QueueSteer.removeReservedRow')(function* (
        doc: SessionDocument,
        marker: Marker
      ) {
        const row = (yield* persist(() => doc.getMessageQueue())).find(
          (item) => item.$cid === marker.queueItemId
        );
        if (row) {
          let same = marker.queueRevision === queueItemRevision(row);
          if (!marker.queueRevision && !hasActiveMessageQueueEditingLease(row)) {
            const meta = yield* persist(() => doc.getMetaState());
            const frozen = readSessionHistory(doc.sessionData.history).find(
              (entry) => entry.id === marker.userTurnId
            );
            const candidate = meta ? buildQueuedMessageUserTurn(row, meta) : null;
            same =
              !!candidate &&
              !!frozen &&
              candidate.id === frozen.id &&
              candidate.timestamp === frozen.timestamp &&
              queueItemRevision(candidate.items) === queueItemRevision(frozen.items) &&
              queueItemRevision(normalizeSessionTurnInputConfig(candidate.inputConfig)) ===
                queueItemRevision(normalizeSessionTurnInputConfig(frozen.inputConfig));
          }
          if (!same || hasActiveMessageQueueEditingLease(row)) {
            return yield* new PersistenceFailure({
              cause: undefined,
              message:
                'The reserved queue row changed. Its edited content was preserved; delivery requires reconciliation.',
            });
          }
          yield* persist(() => doc.removeMessageQueueItem(marker.queueItemId));
        }
        yield* flush();
      });

      const fallback = Effect.fn('QueueSteer.fallback')(function* (
        sessionId: SessionId,
        doc: SessionDocument,
        marker: Marker,
        response: SessionQueueSteerResponse
      ) {
        const durable = yield* write(sessionId, {
          ...marker,
          phase: 'fallback',
          completedAt: undefined,
          response: {
            disposition: response.disposition,
            userTurnId: response.userTurnId,
            error: response.error,
          },
        });
        yield* removeReservedRow(doc, durable);
        const result = yield* persist(() => deps.requeue(sessionId, marker.userTurnId));
        if (result === 'requeue-failed') {
          return yield* new PersistenceFailure({
            cause: undefined,
            message: 'Failed to recover the reserved turn for dispatch.',
          });
        }
        yield* flush();
        return yield* complete(sessionId, durable, response);
      });

      const recoverMarker = Effect.fn('QueueSteer.recoverMarker')(function* (
        sessionId: SessionId,
        doc: SessionDocument,
        marker: Marker
      ) {
        const previous = receipt(sessionId, marker);
        if (previous) return remember(marker.operationKey, previous);
        if (!owned(marker)) return 'deferred';
        if (
          (marker.phase === 'submitting' || marker.phase === 'acknowledged') &&
          active.ownsPrompt(sessionId, marker.expectedTurnId)
        )
          return 'deferred';
        yield* persist(async () => {
          await doc.waitUntilSynced?.();
        });
        const entry = readSessionHistory(doc.sessionData.history).find(
          (item) => item.role === 'user' && item.id === marker.userTurnId
        );
        const request = { sessionId, queueItemId: marker.queueItemId };
        if (!entry) {
          if (marker.phase !== 'reserved') return 'deferred';
          return yield* complete(
            sessionId,
            marker,
            respond(request, 'error', {
              userTurnId: marker.userTurnId,
              error: 'Reservation ended before history was persisted. The message remains queued.',
            })
          );
        }
        if (marker.phase === 'reserved' || marker.phase === 'fallback') {
          return yield* fallback(
            sessionId,
            doc,
            marker,
            marker.response
              ? respond(request, marker.response.disposition, marker.response)
              : respond(request, 'error', {
                  userTurnId: marker.userTurnId,
                  error: 'The daemon restarted before submission; the reserved turn was queued.',
                })
          );
        }
        const applied =
          marker.phase === 'applied' ||
          active.activeUserTurnId(sessionId) === marker.userTurnId ||
          resolveSessionHistoryStatus(entry) === 'handled';
        const status = resolveSessionHistoryStatus(entry);
        if (
          active.activeUserTurnId(sessionId) !== marker.userTurnId &&
          status !== 'handled' &&
          status !== 'failed' &&
          status !== 'canceled'
        ) {
          yield* persist(() => deps.failTurn(sessionId, doc, marker.userTurnId));
          yield* persist(() =>
            deps.recordChatFailure(
              doc,
              'agent_disconnected',
              applied
                ? 'The daemon restarted after Steer handoff. The provider call was not replayed.'
                : 'Steer delivery could not be confirmed after restart. The provider call was not replayed.'
            )
          );
        }
        yield* removeReservedRow(doc, marker);
        return yield* complete(
          sessionId,
          applied ? { ...marker, phase: 'applied' } : marker,
          respond(request, applied ? 'accepted' : 'error', {
            userTurnId: marker.userTurnId,
            ...(applied
              ? {}
              : { error: 'Native Steer delivery is indeterminate; it was not replayed.' }),
          })
        );
      });

      const recover = (sessionId: SessionId, doc: SessionDocument) =>
        Effect.scoped(
          Effect.gen(function* () {
            const guarded = yield* Effect.either(active.guard(sessionId));
            if (guarded._tag === 'Left') return 'deferred' as const;
            const marker = yield* persist(() => deps.queueSteerOperationStore.read(sessionId));
            return marker ? yield* recoverMarker(sessionId, doc, marker) : null;
          })
        );

      const steerQueueItem = (request: Request) =>
        Effect.scoped(
          Effect.gen(function* () {
            const { sessionId, expectedTurnId, queueItemId } = request;
            const operationKey = JSON.stringify([sessionId, expectedTurnId, queueItemId]);
            const cached = receipts.get(operationKey);
            if (cached) return cached;
            yield* active.guard(sessionId);
            const doc = yield* persist(() =>
              deps.workspaceDocument.getOrCreateSessionDoc(sessionId)
            );
            const meta = yield* persist(() => doc.getMetaState());
            if (!meta)
              return respond(request, 'error', { error: 'Session metadata is unavailable.' });
            const previous = yield* persist(() => deps.queueSteerOperationStore.read(sessionId));
            if (previous) {
              if (!owned(previous)) return respond(request, 'busy');
              const previousReceipt = receipt(sessionId, previous);
              if (previous.operationKey === operationKey) {
                if (previousReceipt) return remember(operationKey, previousReceipt);
                const recovered = yield* recoverMarker(sessionId, doc, previous);
                return recovered && recovered !== 'deferred'
                  ? recovered
                  : respond(request, 'error', {
                      error: 'The previous delivery is still indeterminate.',
                    });
              }
              if (!previousReceipt)
                return respond(request, 'busy', {
                  error: 'Another queue operation is being recovered.',
                });
            }
            const target = yield* active.inspect(sessionId, expectedTurnId);
            const row = (yield* persist(() => doc.getMessageQueue())).find(
              (item) => item.$cid === queueItemId
            );
            if (!row) return respond(request, 'queue-item-missing');
            if (hasActiveMessageQueueEditingLease(row))
              return respond(request, 'queue-item-editing');
            const entry = buildQueuedMessageUserTurn(row, meta, {
              status: target.native ? 'pending_apply' : 'pending',
            });
            if (!entry) return respond(request, 'invalid-queue-item');
            if (!target.native) {
              const consumed = yield* persist(() =>
                doc.consumeMessageQueueItemAsUserTurn(queueItemId, () => entry)
              );
              if (consumed.type !== 'consumed')
                return respond(
                  request,
                  consumed.type === 'editing'
                    ? 'queue-item-editing'
                    : consumed.type === 'missing'
                      ? 'queue-item-missing'
                      : 'invalid-queue-item'
                );
              yield* flush();
              const result = yield* active.cancel(sessionId, expectedTurnId).pipe(
                Effect.as(respond(request, 'accepted', { userTurnId: entry.id })),
                Effect.catchTag('ProviderRejected', (error) =>
                  Effect.succeed(
                    respond(request, 'error', { userTurnId: entry.id, error: error.message })
                  )
                )
              );
              return remember(operationKey, result);
            }
            const inputConfig = normalizeSessionTurnInputConfig(entry.inputConfig);
            if (!inputConfig || !entry.timestamp?.trim())
              return respond(request, 'invalid-queue-item');
            const marker = yield* write(sessionId, {
              version: 2,
              operationKey,
              queueItemId,
              expectedTurnId,
              userTurnId: entry.id,
              queueRevision: queueItemRevision(row),
              phase: 'reserved',
            });
            const consumed = yield* persist(() =>
              doc.consumeMessageQueueItemAsUserTurn(
                queueItemId,
                (item) =>
                  queueItemRevision(item) === marker.queueRevision
                    ? { ...entry, userId: target.requesterUserId }
                    : null,
                { publishDispatch: false }
              )
            );
            if (consumed.type !== 'consumed') {
              return yield* complete(
                sessionId,
                marker,
                respond(
                  request,
                  consumed.type === 'editing'
                    ? 'queue-item-editing'
                    : consumed.type === 'missing'
                      ? 'queue-item-missing'
                      : 'invalid-queue-item'
                )
              );
            }
            yield* flush();
            yield* removeReservedRow(doc, marker);
            const submitting = yield* write(sessionId, { ...marker, phase: 'submitting' });
            return yield* active
              .steer({
                sessionId,
                expectedTurnId,
                turn: {
                  id: entry.id,
                  userId: target.requesterUserId,
                  timestamp: entry.timestamp,
                  inputConfig,
                },
              })
              .pipe(
                Effect.flatMap(() =>
                  flush().pipe(
                    Effect.flatMap(() => write(sessionId, { ...marker, phase: 'applied' })),
                    Effect.flatMap((applied) =>
                      complete(
                        sessionId,
                        applied,
                        respond(request, 'accepted', { userTurnId: entry.id })
                      )
                    )
                  )
                ),
                Effect.catchTag('ProviderRejected', (error) =>
                  fallback(
                    sessionId,
                    doc,
                    submitting,
                    respond(request, error.disposition, {
                      userTurnId: entry.id,
                      error: error.message,
                    })
                  )
                ),
                // Pre-submission ownership loss never cancels a newer active turn.
                Effect.catchTag('StaleTurn', (error) =>
                  fallback(
                    sessionId,
                    doc,
                    submitting,
                    respond(request, error.disposition, {
                      userTurnId: entry.id,
                      error: error.message,
                    })
                  )
                )
              );
          }).pipe(
            Effect.catchTags({
              StaleTurn: (error) =>
                Effect.succeed(respond(request, error.disposition, { error: error.message })),
              ProviderRejected: (error) =>
                Effect.succeed(respond(request, error.disposition, { error: error.message })),
              ProviderDeliveryUnknown: (error) =>
                Effect.succeed(respond(request, 'error', { error: error.message })),
              PersistenceFailure: (error) =>
                Effect.succeed(respond(request, 'error', { error: error.message })),
            })
          )
        );

      const mutate = (request: SessionQueueMutation) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* active.guard(request.sessionId);
            const doc = yield* persist(() =>
              deps.workspaceDocument.getOrCreateSessionDoc(request.sessionId)
            );
            const meta = yield* persist(() => doc.getMetaState());
            if (meta?.machineId !== deps.machineId) {
              return {
                type: 'session/queue-mutate_response' as const,
                success: false,
                error: 'This daemon does not own the queue.',
              };
            }
            const marker = yield* persist(() =>
              deps.queueSteerOperationStore.read(request.sessionId)
            );
            if (
              marker &&
              !marker.completedAt &&
              (request.mutation.kind === 'reorder' ||
                request.mutation.queueItemId === marker.queueItemId)
            ) {
              return {
                type: 'session/queue-mutate_response' as const,
                success: false,
                error: 'A queue item is reserved for Steer. Retry after recovery.',
              };
            }
            yield* persist(() => doc.mutateMessageQueue(request.mutation));
            yield* flush();
            return { type: 'session/queue-mutate_response' as const, success: true };
          }).pipe(
            Effect.catchAll((error) =>
              Effect.succeed({
                type: 'session/queue-mutate_response' as const,
                success: false,
                error: error.message,
              })
            )
          )
        );

      return { steerQueueItem, recover, mutate };
    });
  }
}
