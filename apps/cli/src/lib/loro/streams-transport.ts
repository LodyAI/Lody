import { ProcessDocumentRemoteCursorStore } from './sqlite-repo-store';
import { createWorkspaceStreamsTransportAdapter } from '@lody/shared/workspace-streams-persistence';
import { streamsSnapshotCodec } from '@lody/shared/streams-snapshot-codec';
import {
  WorkspaceStreamsConfigurationError,
  type WorkspaceStreamsContent,
} from '@lody/shared/workspace-streams-content';
import type { IncompleteRecoveryStore, RemoteCursorStore } from '@loro-dev/streams-crdt';
import { createLoroSyncErrorTools } from '@lody/shared/loro-sync-errors';
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
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';
import {
  StreamsTransportAdapter,
  createRepoStreamsPersistence,
  type StreamsRoomPayloadProtectionResolver,
} from 'loro-repo/transport/streams';
import type { Logger } from '@/utils/logger';
import type { LoroStreamsTokenProviderLegacy } from '@lody/platform';
import { prepareCliStreamsGatewayBaseUrl } from './streams-access';

const { getLoroSyncDiagnostic, formatLoroSyncError } = createLoroSyncErrorTools({
  RepoSyncError,
  RepoTransportError,
});
registerLoroSyncErrorFormatter(formatLoroSyncError);

class CliStreamsTransportAdapter extends StreamsTransportAdapter {
  constructor(
    options: ConstructorParameters<typeof StreamsTransportAdapter>[0],
    private readonly documentCursors: RemoteCursorStore,
    private readonly documentStreamId: (docId: string) => string
  ) {
    super(options);
  }

  override syncDoc(...args: Parameters<StreamsTransportAdapter['syncDoc']>) {
    this.bindDocument(args[0], args[1]);
    return super.syncDoc(...args);
  }

  override joinDocRoom(...args: Parameters<StreamsTransportAdapter['joinDocRoom']>) {
    this.bindDocument(args[0], args[1]);
    return super.joinDocRoom(...args);
  }

  private bindDocument(docId: string, doc: Parameters<StreamsTransportAdapter['syncDoc']>[1]) {
    if (this.documentCursors instanceof ProcessDocumentRemoteCursorStore) {
      this.documentCursors.bindDocument(this.documentStreamId(docId), doc);
    }
  }
}

export type CliStreamsTransport = {
  adapter: StreamsTransportAdapter;
  gatewayBaseUrl: string;
  tokenProvider: LoroStreamsTokenProviderLegacy;
};

export async function createCliStreamsTransport(args: {
  content: WorkspaceStreamsContent;
  /** Protected content must name its dedicated bucket explicitly. */
  bucketId?: string;
  workspaceId: WorkspaceId;
  tokenProvider: LoroStreamsTokenProviderLegacy;
  repo: LoroRepo;
  /** Owner bound to the manager's replica/account/content lifetime. */
  incompleteRecoveryScope?: object;
  incompleteRecoveryStore?: IncompleteRecoveryStore;
  /**
   * LoroDoc room cursors only. Meta and named Flock cursors are replica-bound:
   * `SqliteRepoStore` restores each one in the same transaction as the data it
   * covers, so a process can never resume past state its own replica lacks.
   */
  documentRemoteCursorStore: RemoteCursorStore;
  logger: Logger;
}): Promise<CliStreamsTransport> {
  const content = args.content;
  if (content?.mode !== 'plaintext' && content?.mode !== 'protected')
    throw new WorkspaceStreamsConfigurationError('Unsupported workspace Streams content mode');
  if (
    content.mode === 'protected' &&
    (!args.bucketId ||
      args.bucketId === LORO_STREAMS_BUCKET_ID ||
      !content.namespace ||
      typeof content.resolve !== 'function' ||
      typeof content.snapshotUpload?.canUpload !== 'function')
  )
    throw new WorkspaceStreamsConfigurationError('Incomplete workspace Streams content protection');
  const tokenProvider = args.tokenProvider;
  const gatewayBaseUrl = await prepareCliStreamsGatewayBaseUrl(tokenProvider);
  const auth = tokenProvider.createAuthCallback();

  return {
    gatewayBaseUrl,
    tokenProvider,
    adapter: createWorkspaceStreamsTransportAdapter(
      (persistence) =>
        new CliStreamsTransportAdapter(
          {
            incompleteRecoveryScope: args.incompleteRecoveryScope,
            incompleteRecoveryStore: args.incompleteRecoveryStore,
            diagnostics: (event) => {
              const diagnostic = getLoroSyncDiagnostic(event);
              if (diagnostic) {
                args.logger[diagnostic.level]('[loro-streams] transport failure', {
                  workspaceId: args.workspaceId,
                  ...diagnostic,
                });
              }
            },
            bucketId: args.bucketId ?? LORO_STREAMS_BUCKET_ID,
            metaStreamId: getLoroMetaStreamId(args.workspaceId),
            docStreamId: (docId) => getLoroStreamIdForDocId(args.workspaceId, docId),
            flockDocStreamId: (flockDocId) => flockDocId,
            flockDocStreamTtlMs: (flockDocId) =>
              isCodeCollabFileIndexFlockDocId(flockDocId) ||
              isCodeCollabFileIndexSignalFlockDocId(flockDocId)
                ? CODE_COLLAB_FILE_INDEX_FLOCK_TTL_MS
                : undefined,
            auth,
            snapshotCodec:
              content.mode === 'protected'
                ? (content.snapshotCodec ?? streamsSnapshotCodec)
                : streamsSnapshotCodec,
            baseUrl: gatewayBaseUrl,
            shardUrls: getLoroStreamsShardUrls(gatewayBaseUrl, tokenProvider.getShardHostSuffix()),
            snapshotUpload:
              content.mode === 'protected'
                ? content.snapshotUpload
                : {
                    canUpload: async () => true,
                    debounceMs: 5_000,
                  },
            ...(content.mode === 'protected'
              ? {
                  payloadProtectionNamespace: content.namespace,
                  payloadProtection: ((room) => {
                    const selected = content.resolve(room);
                    if (selected?.mode !== 'protected')
                      throw new WorkspaceStreamsConfigurationError(
                        'Workspace Streams room requires content protection'
                      );
                    return selected;
                  }) satisfies StreamsRoomPayloadProtectionResolver,
                }
              : { payloadProtection: undefined }),
            persistence,
          },
          args.documentRemoteCursorStore,
          (docId) => getLoroStreamIdForDocId(args.workspaceId, docId)
        ),
      {
        auth,
        owner: args.incompleteRecoveryScope ?? args.repo,
        persistence: createRepoStreamsPersistence(args.repo, {
          documentRemoteCursorStore: args.documentRemoteCursorStore,
        }),
        recoverFlockCheckpointsOnTimeout: true,
      }
    ),
  };
}
