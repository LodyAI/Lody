import { Effect } from 'effect';
import type { LoroDoc } from 'loro-crdt';
import { make as makeWorkspaceRepo } from 'loro-repo/effect';
import { makeLocalWorkspaceTransport } from '@lody/shared/workspace-data/local-transport';
import type { LocalLoroDataPlaneConnection } from '@lody/shared/local-loro-data-plane';
import { makeStreamsTransport, StreamsAuth } from 'loro-repo/effect/streams';
import { RepoIOError } from 'loro-repo/effect';
import { streamsSnapshotCodec } from '@lody/shared/streams-snapshot-codec';
import { readEagerSyncSnapshot, writeEagerSyncSnapshot } from './eager-sync-snapshot-cache';
import type { EagerSyncAuthContext, EagerSyncWorkerInput } from './eager-sync-worker-protocol';

/** Actual IndexedDB/Blob I/O; cancellation never abandons an accepted cache write. */
const cacheIo = <A>(operation: string, run: () => Promise<A>) =>
  Effect.uninterruptible(
    Effect.tryPromise({ try: run, catch: (failure) => new RepoIOError(operation, failure) })
  );

export const runEagerSyncWorkerTask = (
  request: Extract<EagerSyncWorkerInput, { type: 'start' }>,
  deps: {
    connection: LocalLoroDataPlaneConnection;
    auth(context?: EagerSyncAuthContext): Promise<string | undefined>;
    readSnapshot?: typeof readEagerSyncSnapshot;
    writeSnapshot?: typeof writeEagerSyncSnapshot;
    now?: () => number;
  }
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cached = yield* cacheIo('read prefetch snapshot', () =>
        (deps.readSnapshot ?? readEagerSyncSnapshot)(request.scope, request.roomId)
      );
      if (
        cached?.plane === request.transport.plane &&
        cached.lastMessageAt >= request.lastMessageAt
      )
        return 'synced' as const;
      let document: LoroDoc | undefined;
      // The native Repo and every borrower finish before WASM memory is freed.
      yield* Effect.addFinalizer(() => Effect.sync(() => document?.free()));
      const repo = yield* makeWorkspaceRepo();
      const lease = yield* repo.acquireDoc(request.roomId);
      document = lease.doc;
      if (cached?.plane === request.transport.plane) {
        const snapshot = yield* cacheIo('read prefetch bytes', () => cached.snapshot.arrayBuffer());
        yield* lease.importUpdates([new Uint8Array(snapshot)]);
      }
      const transport =
        request.transport.plane === 'local'
          ? yield* makeLocalWorkspaceTransport('prefetch', {
              workspaceId: request.workspaceId,
              peerId: request.peerId,
              connection: deps.connection,
            })
          : yield* makeStreamsTransport({
              ...request.transport.options,
              id: 'prefetch',
              docStreamId: () =>
                request.transport.plane === 'cloud' ? request.transport.streamId : '',
              snapshotCodec: streamsSnapshotCodec,
              // Disposable replicas have no durable cursor and never publish snapshots.
              persistence: 'volatile',
              snapshotUpload: { canUpload: () => false },
            }).pipe(
              Effect.provideService(StreamsAuth, {
                getToken: (context, io) => io.fromPromise(() => deps.auth(context)),
              })
            );
      yield* repo.attachTransport(transport);
      const room = yield* repo.acquireRoom({ kind: 'doc', id: request.roomId });
      const synced = yield* room.sync('prefetch');
      if (synced.outcome !== 'confirmed')
        return yield* Effect.fail(new RepoIOError('prefetch unconfirmed', synced));
      // Native local sync waits for all advertised chunked state, not just the join header.
      const snapshot = new Blob([lease.doc.export({ mode: 'snapshot' }).slice().buffer]);
      const stored = yield* cacheIo('write prefetch snapshot', () =>
        (deps.writeSnapshot ?? writeEagerSyncSnapshot)({
          scope: request.scope,
          roomId: request.roomId,
          plane: request.transport.plane,
          lastMessageAt: request.lastMessageAt,
          savedAt: (deps.now ?? Date.now)(),
          snapshot,
        })
      );
      return stored ? ('synced' as const) : ('skipped' as const);
    })
  );
