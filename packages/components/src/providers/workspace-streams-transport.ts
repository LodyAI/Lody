import type { RemoteCursorStore } from '@loro-dev/streams-crdt';
import { createLoroSyncErrorTools } from '@lody/shared/loro-sync-errors';
import { RepoSyncError, RepoTransportError } from 'loro-repo';
import {
  createLoroStreamUrl,
  getLoroMetaStreamId,
  getLoroStreamIdForDocId,
  getLoroStreamsShardUrls,
  LORO_STREAMS_BUCKET_ID,
  streamsSnapshotCodec,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';
import { StreamsTransportAdapter, createRepoStreamsPersistence } from 'loro-repo/transport/streams';

const { getLoroSyncDiagnostic } = createLoroSyncErrorTools({ RepoSyncError, RepoTransportError });

export type WorkspaceStreamsTransportOptions = {
  repo: LoroRepo;
  workspaceId: WorkspaceId;
  /**
   * LoroDoc room cursors only. Meta and named Flock progress is replica-bound:
   * the repo's IndexedDB restores each checkpoint with the data it covers, so a
   * window or tab never resumes past state its own replica lacks.
   */
  documentRemoteCursorStore: RemoteCursorStore;
  auth: ConstructorParameters<typeof StreamsTransportAdapter>[0]['auth'];
  streamsBaseUrl: string;
  shardHostSuffix: string | undefined;
};

/** The key under which the transport checkpoints this workspace's Meta room. */
export const getWorkspaceMetaStreamUrl = (
  workspaceId: WorkspaceId,
  streamsBaseUrl: string
): string =>
  createLoroStreamUrl({
    bucketId: LORO_STREAMS_BUCKET_ID,
    streamId: getLoroMetaStreamId(workspaceId),
    baseUrl: streamsBaseUrl,
  });

/** The renderer's durable Streams transport for one workspace repo. */
export const createWorkspaceStreamsTransport = (
  options: WorkspaceStreamsTransportOptions
): StreamsTransportAdapter =>
  new StreamsTransportAdapter({
    diagnostics: (event) => {
      const diagnostic = getLoroSyncDiagnostic(event);
      if (diagnostic) {
        console[diagnostic.level]('[loro-streams] transport failure', {
          workspaceId: options.workspaceId,
          ...diagnostic,
        });
      }
    },
    bucketId: LORO_STREAMS_BUCKET_ID,
    metaStreamId: getLoroMetaStreamId(options.workspaceId),
    docStreamId: (docId) => getLoroStreamIdForDocId(options.workspaceId, docId),
    flockDocStreamId: (flockDocId) => flockDocId,
    auth: options.auth,
    // Every cursor save first awaits that resource's own durability barrier.
    persistence: createRepoStreamsPersistence(options.repo, {
      documentRemoteCursorStore: options.documentRemoteCursorStore,
    }),
    snapshotCodec: streamsSnapshotCodec,
    baseUrl: options.streamsBaseUrl,
    shardUrls: getLoroStreamsShardUrls(options.streamsBaseUrl, options.shardHostSuffix),
    snapshotUpload: {
      canUpload: async () => true,
    },
  });
