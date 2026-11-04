import { Clock, Effect, Option, Queue, Stream } from 'effect';
import type { LoroRepo, RepoDocExistenceState, RepoEvent } from 'loro-repo';
import { getSessionRoomId, type SessionId } from '@lody/shared';
import { LoroStreamsRpcHandlerError } from '@lody/loro-streams-rpc';
import type { Logger } from '@/utils/logger';

export const SESSION_HISTORY_METADATA_TIMEOUT_MS = 10_000;

type OwnerState = {
  readonly existence: RepoDocExistenceState;
  readonly meta: Record<string, unknown>;
};

function describeOwnerState(state: OwnerState, sessionId: SessionId, machineId: string) {
  return {
    sessionId,
    machineId,
    observedMachineId: typeof state.meta.machineId === 'string' ? state.meta.machineId : 'unknown',
    existence: state.existence,
    historyBackend:
      state.meta.historyBackend === 'roost' || state.meta.historyBackend === 'loro'
        ? state.meta.historyBackend
        : 'unknown',
    sessionIdentity:
      state.meta.id === sessionId ? 'matching' : state.meta.id ? 'invalid' : 'pending',
  };
}

/** Readiness is independent of ownership: an incomplete catalog is not a foreign owner. */
function resolveOwner(state: OwnerState, sessionId: SessionId, machineId: string) {
  const reject = (code: string, message: string) =>
    new LoroStreamsRpcHandlerError(code, message, describeOwnerState(state, sessionId, machineId));
  if (state.existence === 'deleted') {
    return reject(
      'session_unavailable',
      'Session history is unavailable because the session was deleted.'
    );
  }
  const owner = state.meta.machineId;
  if (typeof owner === 'string' && owner.length > 0 && owner !== machineId) {
    return reject('session_owner_mismatch', 'Session history belongs to another machine.');
  }
  if (state.existence !== 'active' || !state.meta.id || !owner || !state.meta.historyBackend) {
    return undefined;
  }
  if (state.meta.id !== sessionId || owner !== machineId) {
    return reject('session_identity_mismatch', 'Session history identity is invalid.');
  }
  if (state.meta.historyBackend !== 'roost') {
    return reject('session_backend_mismatch', 'Session does not use Roost history.');
  }
  return sessionId;
}

/**
 * Metadata and Machine RPC use separate streams. Observe this session before taking
 * its snapshot, and wait for both owner and backend before opening any history store.
 * The stream scope releases the observer on success, rejection, timeout and interruption.
 */
export const awaitSessionHistoryOwner = Effect.fn('awaitSessionHistoryOwner')(function* (
  repo: Pick<LoroRepo, 'observeDocs'>,
  sessionId: SessionId,
  machineId: string,
  logger?: Pick<Logger, 'debug'>
) {
  const roomId = getSessionRoomId(sessionId);
  const startedAt = yield* Clock.currentTimeMillis;
  let latest: OwnerState = { existence: 'missing', meta: {} };
  let waiting = false;
  const states = Stream.callback<OwnerState>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let state: OwnerState = { existence: 'missing', meta: {} };
        const onEvent = (event: RepoEvent) => {
          if (event.kind === 'doc-metadata') {
            state = { ...state, meta: { ...state.meta, ...event.patch } };
          } else if (event.kind === 'doc-existence-changed') {
            // A live purge is definitive; a never-observed session remains unknown.
            state = { ...state, existence: event.to === 'missing' ? 'deleted' : event.to };
          }
          Queue.offerUnsafe(queue, state);
        };
        const observation = repo.observeDocs(onEvent, {
          query: { prefix: roomId },
          filter: {
            docIds: [roomId],
            kinds: ['doc-metadata', 'doc-existence-changed'],
            metadataFields: ['id', 'machineId', 'historyBackend'],
          },
        });
        const snapshot = observation.snapshot.find((entry) => entry.docId === roomId);
        if (snapshot) {
          state = { existence: snapshot.deleted ? 'deleted' : 'active', meta: snapshot.meta };
        }
        Queue.offerUnsafe(queue, state);
        return observation;
      }),
      (observation) => Effect.sync(() => observation.unsubscribe())
    )
  );
  return yield* states.pipe(
    Stream.tap((state) =>
      Effect.sync(() => {
        latest = state;
        if (!waiting && resolveOwner(state, sessionId, machineId) === undefined) {
          waiting = true;
          logger?.debug(
            `Session history metadata pending ${JSON.stringify(describeOwnerState(state, sessionId, machineId))}`
          );
        }
      })
    ),
    Stream.map((state) => resolveOwner(state, sessionId, machineId)),
    Stream.filter((result) => result !== undefined),
    Stream.runHead,
    Effect.flatMap((result) => {
      const owner = Option.getOrThrow(result);
      return owner instanceof LoroStreamsRpcHandlerError
        ? Effect.fail(owner)
        : Effect.succeed(owner);
    }),
    Effect.timeoutOrElse({
      duration: SESSION_HISTORY_METADATA_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new LoroStreamsRpcHandlerError(
            'session_metadata_pending',
            'Session history metadata did not reach the target machine in time; no history operation was started.',
            describeOwnerState(latest, sessionId, machineId)
          )
        ),
    }),
    Effect.tap(() =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          if (waiting)
            logger?.debug(
              `Session history metadata ready ${JSON.stringify({ ...describeOwnerState(latest, sessionId, machineId), waitedMs: now - startedAt })}`
            );
        })
      )
    ),
    Effect.tapError((error) =>
      Effect.sync(() =>
        logger?.debug(
          `Session history request refused ${JSON.stringify({ code: error.code, ...error.context })}`
        )
      )
    )
  );
});
