import type { RemoteCursorStore } from '@loro-dev/streams-crdt';
import {
  CODE_COLLAB_FILE_INDEX_FLOCK_TTL_MS,
  getLoroMetaStreamId,
  getLoroStreamIdForDocId,
  getLoroStreamsShardUrls,
  isCodeCollabFileIndexFlockDocId,
  isCodeCollabFileIndexSignalFlockDocId,
  LORO_STREAMS_BUCKET_ID,
  streamsSnapshotCodec,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';
import { StreamsTransportAdapter, createRepoStreamsPersistence } from 'loro-repo/transport/streams';
import type { Logger } from '@/utils/logger';
import type { LoroStreamsTokenProvider } from '@lody/platform';
import { prepareCliStreamsGatewayBaseUrl } from './streams-access';

export type CliStreamsTransport = {
  adapter: StreamsTransportAdapter;
  gatewayBaseUrl: string;
  tokenProvider: LoroStreamsTokenProvider;
};

export async function createCliStreamsTransport(args: {
  workspaceId: WorkspaceId;
  tokenProvider: LoroStreamsTokenProvider;
  repo: LoroRepo;
  /**
   * LoroDoc room cursors only. Meta and named Flock cursors are replica-bound:
   * `SqliteRepoStore` restores each one in the same transaction as the data it
   * covers, so a process can never resume past state its own replica lacks.
   */
  documentRemoteCursorStore: RemoteCursorStore;
  logger: Logger;
}): Promise<CliStreamsTransport> {
  const tokenProvider = args.tokenProvider;
  const gatewayBaseUrl = await prepareCliStreamsGatewayBaseUrl(tokenProvider);

  return {
    gatewayBaseUrl,
    tokenProvider,
    adapter: new StreamsTransportAdapter({
      bucketId: LORO_STREAMS_BUCKET_ID,
      metaStreamId: getLoroMetaStreamId(args.workspaceId),
      docStreamId: (docId) => getLoroStreamIdForDocId(args.workspaceId, docId),
      flockDocStreamId: (flockDocId) => flockDocId,
      flockDocStreamTtlMs: (flockDocId) =>
        isCodeCollabFileIndexFlockDocId(flockDocId) ||
        isCodeCollabFileIndexSignalFlockDocId(flockDocId)
          ? CODE_COLLAB_FILE_INDEX_FLOCK_TTL_MS
          : undefined,
      auth: tokenProvider.createAuthCallback(),
      // Every cursor save first awaits the covered resource's durability
      // barrier (`persistMetaNow` / `persistDocNow` / `persistFlockDocNow`).
      persistence: createRepoStreamsPersistence(args.repo, {
        documentRemoteCursorStore: args.documentRemoteCursorStore,
      }),
      snapshotCodec: streamsSnapshotCodec,
      baseUrl: gatewayBaseUrl,
      shardUrls: getLoroStreamsShardUrls(gatewayBaseUrl, tokenProvider.getShardHostSuffix()),
      snapshotUpload: {
        canUpload: async () => true,
        debounceMs: 5_000,
      },
    }),
  };
}
