import type { LoroRepo } from 'loro-repo';
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
import { StreamsTransportAdapter } from 'loro-repo/transport/streams';
import type { Logger } from '@/utils/logger';
import type { LoroStreamsTokenProvider } from '@lody/platform';
import { prepareCliStreamsGatewayBaseUrl } from './streams-access';
import { createCliStreamsPersistence } from './streams-persistence';

export type CliStreamsTransport = {
  adapter: StreamsTransportAdapter;
  gatewayBaseUrl: string;
  tokenProvider: LoroStreamsTokenProvider;
};

export async function createCliStreamsTransport(args: {
  workspaceId: WorkspaceId;
  tokenProvider: LoroStreamsTokenProvider;
  repo: LoroRepo;
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
      persistence: createCliStreamsPersistence(args.repo),
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
