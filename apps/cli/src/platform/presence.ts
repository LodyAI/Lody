import { Cause, Effect, Layer } from 'effect';
import { v4 as uuid } from 'uuid';
import { EphemeralStoreAdaptor } from '@loro-dev/streams-crdt/loro';
import {
  EphemeralAuth,
  EphemeralDiagnostics,
  EphemeralReleaseFailure,
  makeEphemeralStream,
} from '@loro-dev/streams-crdt/effect';
import {
  createLoroStreamUrl,
  getLoroMetaStreamId,
  getLoroStreamsPresenceBaseUrl,
  getServerTimeOffset,
  LORO_STREAMS_BUCKET_ID,
  toLodyPresenceStreamUrl,
  type LodyPresenceInstanceId,
} from '@lody/shared';
import { PresenceHost, PresenceTransport } from '@/lib/loro/workspace-presence';
import { getCliHttpFetch } from '@/utils/http-transport';
import type { Logger } from '@/utils/logger';
import { formatSafeLogFields } from './logger';

/** Published SDK owns all network tasks; this layer only supplies capabilities and safe local logs. */
export const presencePlatformLayer = (logger: Logger, fetchImpl = getCliHttpFetch({ logger })) =>
  Layer.merge(
    Layer.succeed(PresenceHost, {
      instanceId: () => uuid() as LodyPresenceInstanceId,
      serverOffsetMs: getServerTimeOffset,
      report: (workspaceId, event) => {
        const level =
          event.stage === 'heartbeat' || event.stage === 'barrier'
            ? 'trace'
            : event.stage === 'stall' || event.stage === 'retry'
              ? 'warn'
              : 'debug';
        logger[level](
          `[${workspaceId}] Loro presence${formatSafeLogFields({
            stage: event.stage,
            generation: event.generation,
            attempt: event.attempt,
            ageMs: event.ageMs,
            code: event.code,
            room: event.stats?.status,
            pendingLocalCount: event.stats?.pendingLocalCount,
            physicalEntries: event.stats?.physicalEntries,
            queuedBytes: event.stats?.queuedBytes,
            releasePending: event.stats?.releasePending,
          })}`
        );
      },
    }),
    Layer.succeed(PresenceTransport, {
      isReleaseFailure: (cause) =>
        cause.reasons.some(
          (reason) =>
            (Cause.isFailReason(reason) && reason.error instanceof EphemeralReleaseFailure) ||
            (Cause.isDieReason(reason) && reason.defect instanceof EphemeralReleaseFailure)
        ),
      create: (workspaceId, store, options, generation) =>
        Effect.gen(function* () {
          if (
            options.encryptedPresence &&
            (!options.bucketId || options.bucketId === LORO_STREAMS_BUCKET_ID)
          )
            return yield* Effect.die(new Error('e2ee_presence_configuration'));
          const encrypted = options.encryptedPresence
            ? yield* options.encryptedPresence(store)
            : undefined;
          const stream = yield* makeEphemeralStream({
            streamUrl: toLodyPresenceStreamUrl(
              createLoroStreamUrl({
                bucketId: options.bucketId ?? LORO_STREAMS_BUCKET_ID,
                streamId: getLoroMetaStreamId(workspaceId),
                baseUrl: getLoroStreamsPresenceBaseUrl(
                  options.streamsBaseUrl,
                  undefined,
                  options.shardHostSuffix
                ),
              })
            ),
            adaptor: encrypted?.adaptor ?? EphemeralStoreAdaptor(store),
            fetch: fetchImpl,
          }).pipe(
            Effect.provideService(EphemeralAuth, { getToken: (context) => options.auth(context) }),
            Effect.provideService(EphemeralDiagnostics, {
              emit: (event) =>
                Effect.sync(() => {
                  const level = event.code ? 'debug' : 'trace';
                  logger[level](
                    `[${workspaceId}] Loro presence SDK${formatSafeLogFields({
                      generation,
                      stage: event.stage,
                      room: event.status,
                      code: event.code,
                      pendingLocalCount: event.pendingLocalCount,
                      physicalEntries: event.physicalEntries,
                      queuedBytes: event.queuedBytes,
                    })}`
                  );
                }),
            })
          );
          if (encrypted) yield* Effect.addFinalizer(() => encrypted.retire);
          return encrypted
            ? {
                get stats() {
                  return stream.stats;
                },
                join: stream.join,
                rejoin: stream.rejoin,
                close: encrypted.retire.pipe(Effect.andThen(stream.close)),
                retryRelease: stream.retryRelease,
              }
            : stream;
        }),
    })
  );
