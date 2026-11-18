import { requirePlaintextWorkspaceStreamsContent } from '@lody/shared/workspace-streams-content';
import { LoroDoc, VersionVector } from 'loro-crdt';
import { base64ToBytes } from '@lody/shared/local-loro-data-plane';
import {
  LocalLoroTransportAdapter,
  type LocalLoroDataPlaneConnection,
} from '@lody/shared/local-loro-transport';
import {
  InMemoryRemoteCursorStore,
  type JsonObject,
  type StreamsCrdtOptions,
} from '@loro-dev/streams-crdt';
import { createLoroDocAdapter, StreamsCrdt } from '@loro-dev/streams-crdt/loro';
import { streamsSnapshotCodec } from '@lody/shared/streams-snapshot-codec';
import {
  readEagerSyncSnapshot,
  writeEagerSyncSnapshot,
  type EagerSyncSnapshot,
} from './eager-sync-snapshot-cache';
import { coveredEagerSyncCursor } from './eager-sync-checkpoint';
import type { EagerSyncAuthContext, EagerSyncWorkerInput } from './eager-sync-worker-protocol';

export async function runEagerSyncWorkerTask(
  request: Extract<EagerSyncWorkerInput, { type: 'start' }>,
  deps: {
    connection: LocalLoroDataPlaneConnection;
    auth(context?: EagerSyncAuthContext): Promise<string | undefined>;
    readSnapshot?: typeof readEagerSyncSnapshot;
    writeSnapshot?: typeof writeEagerSyncSnapshot;
    now?: () => number;
    fetch?: StreamsCrdtOptions<Record<string, number>>['fetch'];
  }
) {
  requirePlaintextWorkspaceStreamsContent(request.content);
  const cached = await (deps.readSnapshot ?? readEagerSyncSnapshot)(request.scope, request.roomId);
  if (cached?.plane === request.transport.plane && cached.lastMessageAt >= request.lastMessageAt) {
    return 'synced' as const;
  }
  // No Session store or Mirror is constructed in this worker. All document
  // import/export and snapshot encoding stay off the renderer thread.
  const doc = new LoroDoc();
  let transport: LocalLoroTransportAdapter | StreamsCrdt<JsonObject> | undefined;
  let subscription: ReturnType<LocalLoroTransportAdapter['joinDocRoom']> | undefined;
  const disposers: Array<() => void> = [];
  const cursors = new InMemoryRemoteCursorStore();
  let cloudCheckpoint: EagerSyncSnapshot['cloudCheckpoint'];
  try {
    if (cached?.plane === request.transport.plane) {
      doc.import(new Uint8Array(await cached.snapshot.arrayBuffer()));
    }
    let localCatchUp: Promise<void> | undefined;
    if (request.transport.plane === 'local') {
      // For large docs the daemon sends `joined` BEFORE the update chunks.
      // The adapter's first-sync signal only acknowledges the join. Keep the
      // room alive until the advertised version is actually in our document.
      localCatchUp = new Promise<void>((resolve) => {
        let target: VersionVector | undefined;
        const check = () => {
          if (!target) return;
          const comparison = doc.oplogVersion().compare(target);
          if (comparison !== undefined && comparison >= 0) resolve();
        };
        disposers.push(doc.subscribe(check));
        disposers.push(
          deps.connection.onMessage((message) => {
            if (
              message.type === 'joined' &&
              message.workspaceId === request.workspaceId &&
              message.peerId === request.peerId &&
              message.room.scope === 'doc' &&
              message.room.docId === request.roomId &&
              message.serverVersion
            ) {
              target = VersionVector.decode(base64ToBytes(message.serverVersion));
              check();
            }
          })
        );
      });
    }
    if (request.transport.plane === 'local') {
      transport = new LocalLoroTransportAdapter({
        workspaceId: request.workspaceId,
        peerId: request.peerId,
        connection: deps.connection,
      });
      subscription = transport.joinDocRoom(request.roomId, doc);
      await subscription.firstSyncedWithRemote;
      await localCatchUp;
      subscription.unsubscribe();
      subscription = undefined;
    } else {
      const { streamUrl, shardUrls } = request.transport;
      const restoredCursor = coveredEagerSyncCursor(
        cached,
        request.scope,
        request.roomId,
        streamUrl,
        doc
      );
      if (restoredCursor) await cursors.save(restoredCursor);
      transport = new StreamsCrdt({
        streamUrl,
        shardUrls,
        adapter: createLoroDocAdapter(doc),
        auth: deps.auth,
        fetch: deps.fetch,
        snapshotCodec: streamsSnapshotCodec,
        // This store is task-local. No durable cursor changes until the final
        // snapshot and progress commit together; failed tasks retain the old row.
        remoteCursorStore: cursors,
        createStreamIfMissing: false,
        snapshotUpload: { canUpload: async () => false },
      });
      const result = await transport.catchup();
      if (!result.ok) {
        // Exhausting the recovery budget still means missing dependencies. An
        // existing checkpoint must not shorten this room's download backoff.
        if (result.error.code === 'apply_incomplete') return 'apply_incomplete' as const;
        throw result.error;
      }
      const cursor = await cursors.load(streamUrl);
      if (cursor)
        cloudCheckpoint = {
          format: 1,
          snapshotVersion: Object.fromEntries(doc.oplogVersion().toJSON()),
          cursor,
        };
    }
    // A snapshot excludes unresolved imports. Never certify missing data or
    // advance activity progress, even if the transport reports catch-up complete.
    if (doc.exportPendingUpdates() !== undefined) {
      return 'apply_incomplete' as const;
    }
    const snapshot = new Blob([doc.export({ mode: 'snapshot' }).slice().buffer]);
    const stored = await (deps.writeSnapshot ?? writeEagerSyncSnapshot)({
      scope: request.scope,
      roomId: request.roomId,
      plane: request.transport.plane,
      lastMessageAt: request.lastMessageAt,
      savedAt: (deps.now ?? Date.now)(),
      snapshot,
      ...(cloudCheckpoint ? { cloudCheckpoint } : {}),
    });
    return stored ? ('synced' as const) : ('cache_rejected' as const);
  } finally {
    for (const dispose of disposers) dispose();
    subscription?.unsubscribe();
    try {
      await transport?.close();
    } finally {
      doc.free();
    }
  }
}
