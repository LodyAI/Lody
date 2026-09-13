import { LoroDoc, VersionVector } from 'loro-crdt';
import { base64ToBytes } from '@lody/shared/local-loro-data-plane';
import {
  LocalLoroTransportAdapter,
  type LocalLoroDataPlaneConnection,
} from '@lody/shared/local-loro-transport';
import { StreamsTransportAdapter } from 'loro-repo/transport/streams';
import { streamsSnapshotCodec } from '@lody/shared/streams-snapshot-codec';
import { readEagerSyncSnapshot, writeEagerSyncSnapshot } from './eager-sync-snapshot-cache';
import type { EagerSyncWorkerInput } from './eager-sync-worker-protocol';

export async function runEagerSyncWorkerTask(
  request: Extract<EagerSyncWorkerInput, { type: 'start' }>,
  deps: {
    connection: LocalLoroDataPlaneConnection;
    auth(context?: { reason: string }): Promise<string | undefined>;
    readSnapshot?: typeof readEagerSyncSnapshot;
    writeSnapshot?: typeof writeEagerSyncSnapshot;
    now?: () => number;
  }
) {
  const cached = await (deps.readSnapshot ?? readEagerSyncSnapshot)(request.scope, request.roomId);
  if (cached?.plane === request.transport.plane && cached.lastMessageAt >= request.lastMessageAt) {
    return 'synced' as const;
  }
  // No Session store or Mirror is constructed in this worker. All document
  // import/export and snapshot encoding stay off the renderer thread.
  const doc = new LoroDoc();
  let transport: LocalLoroTransportAdapter | StreamsTransportAdapter | undefined;
  let subscription: ReturnType<LocalLoroTransportAdapter['joinDocRoom']> | undefined;
  const disposers: Array<() => void> = [];
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
    transport =
      request.transport.plane === 'local'
        ? new LocalLoroTransportAdapter({
            workspaceId: request.workspaceId,
            peerId: request.peerId,
            connection: deps.connection,
          })
        : new StreamsTransportAdapter({
            ...request.transport.options,
            docStreamId: () =>
              request.transport.plane === 'cloud' ? request.transport.streamId : '',
            auth: deps.auth,
            snapshotCodec: streamsSnapshotCodec,
            // No shared cursor: this disposable replica must bootstrap from its
            // own snapshot. It never publishes compaction snapshots remotely.
            snapshotUpload: { canUpload: async () => false },
          });
    subscription = transport.joinDocRoom(request.roomId, doc);
    await subscription.firstSyncedWithRemote;
    await localCatchUp;
    subscription.unsubscribe();
    subscription = undefined;
    const snapshot = new Blob([doc.export({ mode: 'snapshot' }).slice().buffer]);
    const stored = await (deps.writeSnapshot ?? writeEagerSyncSnapshot)({
      scope: request.scope,
      roomId: request.roomId,
      plane: request.transport.plane,
      lastMessageAt: request.lastMessageAt,
      savedAt: (deps.now ?? Date.now)(),
      snapshot,
    });
    return stored ? ('synced' as const) : ('skipped' as const);
  } finally {
    for (const dispose of disposers) dispose();
    subscription?.unsubscribe();
    await transport?.close();
    doc.free();
  }
}
