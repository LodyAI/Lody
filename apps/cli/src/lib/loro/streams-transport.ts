import type { RemoteCursorStore } from '@loro-dev/streams-crdt';
import { createLoroSyncErrorTools, getLoroSnapshotDiagnostic } from '@lody/shared/loro-sync-errors';
import { workspaceSyncFailuresLegacy } from '@lody/shared/workspace-data/repo-legacy';
import { RepoSyncError, RepoTransportError } from 'loro-repo';
import { registerLoroSyncErrorFormatter } from '../../utils/format-error';
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
import { workspaceStreamsTransport } from '@lody/shared/workspace-data/streams';
import type { NativeWorkspaceTransport } from '@lody/shared/workspace-data/repo-legacy';
import type { LoroStreamsTokenAuth } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import type { LoroStreamsTokenProviderLegacy } from '@lody/platform';
import { prepareCliStreamsGatewayBaseUrl } from './streams-access';

const { formatLoroSyncError } = createLoroSyncErrorTools({
  RepoSyncError,
  RepoTransportError,
  nativeFailures: workspaceSyncFailuresLegacy,
});
registerLoroSyncErrorFormatter(formatLoroSyncError);

export type CliStreamsTransport = {
  adapter: NativeWorkspaceTransport;
  gatewayBaseUrl: string;
  tokenProvider: LoroStreamsTokenProviderLegacy;
};

export async function createCliStreamsTransport(args: {
  workspaceId: WorkspaceId;
  tokenProvider: LoroStreamsTokenProviderLegacy;
  auth: LoroStreamsTokenAuth;
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
    adapter: workspaceStreamsTransport(
      {
        bucketId: LORO_STREAMS_BUCKET_ID,
        metaStreamId: getLoroMetaStreamId(args.workspaceId),
        docStreamId: (docId) => getLoroStreamIdForDocId(args.workspaceId, docId),
        flockDocStreamId: (flockDocId) => flockDocId,
        flockDocStreamTtlMs: (flockDocId) =>
          isCodeCollabFileIndexFlockDocId(flockDocId) ||
          isCodeCollabFileIndexSignalFlockDocId(flockDocId)
            ? CODE_COLLAB_FILE_INDEX_FLOCK_TTL_MS
            : undefined,
        // The renderer pre-creates only the Session docs it creates. Sessions the
        // CLI or MCP creates, and Code Collab Flock docs, exist remotely only
        // once this process's first join creates them; native loro-repo
        // defaults to false, unlike the Legacy transport it replaced.
        createStreamIfMissing: true,
        snapshotCodec: streamsSnapshotCodec,
        baseUrl: gatewayBaseUrl,
        shardUrls: getLoroStreamsShardUrls(gatewayBaseUrl, tokenProvider.getShardHostSuffix()),
        snapshotUpload: {
          canUpload: async () => true,
          debounceMs: 5_000,
          onDiagnostic: (event) => {
            const diagnostic = getLoroSnapshotDiagnostic(event);
            const message = `Streams snapshot ${JSON.stringify(diagnostic)}`;
            if (event.outcome === 'failed') args.logger.warn(message);
            else args.logger.debug(message);
          },
        },
      },
      args.auth
    ),
  };
}
