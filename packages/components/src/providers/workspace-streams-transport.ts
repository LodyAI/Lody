import { createWorkspaceStreamsTransportAdapter } from '@lody/shared/workspace-streams-persistence';
import { streamsSnapshotCodec } from '@lody/shared/streams-snapshot-codec';
import type { IncompleteRecoveryStore, RemoteCursorStore } from '@loro-dev/streams-crdt';
import { createLoroSyncErrorTools } from '@lody/shared/loro-sync-errors';
import { RepoSyncError, RepoTransportError } from 'loro-repo';
import {
  createLoroStreamUrl,
  loroStreamsWebSocketOptions,
  getLoroMetaStreamId,
  getLoroStreamIdForDocId,
  getLoroStreamsShardUrls,
  LORO_STREAMS_BUCKET_ID,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';
import {
  StreamsTransportAdapter,
  createRepoStreamsPersistence,
  type StreamsRoomPayloadProtectionResolver,
} from 'loro-repo/transport/streams';

import {
  WorkspaceStreamsConfigurationError,
  type WorkspaceStreamsContent,
} from '@lody/shared/workspace-streams-content';
export {
  WorkspaceStreamsConfigurationError,
  type WorkspaceStreamsContent,
} from '@lody/shared/workspace-streams-content';

const { getLoroSyncDiagnostic } = createLoroSyncErrorTools({ RepoSyncError, RepoTransportError });

export type WorkspaceStreamsTransportOptions = {
  repo: LoroRepo;
  recoverFlockCheckpointsOnTimeout?: boolean;
  /** Runtime-owned budget identity; never contains or shares a replica cursor. */
  incompleteRecoveryScope?: object;
  incompleteRecoveryStore?: IncompleteRecoveryStore;
  workspaceId: WorkspaceId;
  /**
   * LoroDoc room cursors only. Meta and named Flock progress is replica-bound:
   * the repo's IndexedDB restores each checkpoint with the data it covers, so a
   * window or tab never resumes past state its own replica lacks.
   */
  documentRemoteCursorStore: RemoteCursorStore;
  auth: ConstructorParameters<typeof StreamsTransportAdapter>[0]['auth'];
  streamsBaseUrl: string;
  webSocketEnabled?: boolean;
  shardHostSuffix: string | undefined;
  /** Explicit transport policy, separate from workspace admission evidence. */
  content: WorkspaceStreamsContent;
  bucketId?: string;
};

/** The key under which the transport checkpoints this workspace's Meta room. */
export const getWorkspaceMetaStreamUrl = (
  workspaceId: WorkspaceId,
  streamsBaseUrl: string,
  bucketId: string = LORO_STREAMS_BUCKET_ID
): string =>
  createLoroStreamUrl({
    bucketId,
    streamId: getLoroMetaStreamId(workspaceId),
    baseUrl: streamsBaseUrl,
  });

/** The document URL built from the same bucket and room mapping as the transport. */
export const getWorkspaceDocStreamUrl = (
  workspaceId: WorkspaceId,
  docId: string,
  streamsBaseUrl: string,
  bucketId: string = LORO_STREAMS_BUCKET_ID
): string =>
  createLoroStreamUrl({
    bucketId,
    streamId: getLoroStreamIdForDocId(workspaceId, docId),
    baseUrl: streamsBaseUrl,
  });

/** The renderer's durable Streams transport for one workspace repo. */
export const createWorkspaceStreamsTransport = (
  options: WorkspaceStreamsTransportOptions
): StreamsTransportAdapter => {
  const content = options.content;
  if (content?.mode !== 'plaintext' && content?.mode !== 'protected') {
    throw new WorkspaceStreamsConfigurationError('Unsupported workspace Streams content mode');
  }
  if (
    content?.mode === 'protected' &&
    (!options.bucketId ||
      typeof content.namespace !== 'string' ||
      content.namespace.length === 0 ||
      typeof content.resolve !== 'function' ||
      typeof content.snapshotUpload?.canUpload !== 'function' ||
      (content.snapshotCodec !== undefined &&
        (typeof content.snapshotCodec?.compress !== 'function' ||
          typeof content.snapshotCodec?.decompress !== 'function')))
  ) {
    throw new WorkspaceStreamsConfigurationError('Incomplete workspace Streams content protection');
  }

  return createWorkspaceStreamsTransportAdapter(
    (persistence) =>
      new StreamsTransportAdapter({
        incompleteRecoveryScope: options.incompleteRecoveryScope,
        incompleteRecoveryStore: options.incompleteRecoveryStore,
        diagnostics: (event) => {
          const diagnostic = getLoroSyncDiagnostic(event);
          if (diagnostic) {
            console[diagnostic.level]('[loro-streams] transport failure', {
              workspaceId: options.workspaceId,
              ...diagnostic,
            });
          }
        },
        bucketId: options.bucketId ?? LORO_STREAMS_BUCKET_ID,
        metaStreamId: getLoroMetaStreamId(options.workspaceId),
        docStreamId: (docId) => getLoroStreamIdForDocId(options.workspaceId, docId),
        flockDocStreamId: (flockDocId) => flockDocId,
        auth: options.auth,
        snapshotCodec:
          content?.mode === 'protected'
            ? (content.snapshotCodec ?? streamsSnapshotCodec)
            : streamsSnapshotCodec,
        ...loroStreamsWebSocketOptions(
          options.webSocketEnabled === true,
          options.streamsBaseUrl,
          options.workspaceId
        ),
        baseUrl: options.streamsBaseUrl,
        shardUrls: getLoroStreamsShardUrls(options.streamsBaseUrl, options.shardHostSuffix),
        snapshotUpload:
          content?.mode === 'protected' ? content.snapshotUpload : { canUpload: async () => true },
        ...(content?.mode === 'protected'
          ? {
              payloadProtectionNamespace: content.namespace,
              payloadProtection: ((room) => {
                const selection = content.resolve(room);
                if (selection?.mode !== 'protected') {
                  throw new WorkspaceStreamsConfigurationError(
                    'Workspace Streams room requires content protection'
                  );
                }
                return selection;
              }) satisfies StreamsRoomPayloadProtectionResolver,
            }
          : { payloadProtection: undefined }),
        persistence,
      }),
    {
      auth: options.auth,
      owner: options.incompleteRecoveryScope ?? options.repo,
      persistence: createRepoStreamsPersistence(options.repo, {
        documentRemoteCursorStore: options.documentRemoteCursorStore,
      }),
      recoverFlockCheckpointsOnTimeout: options.recoverFlockCheckpointsOnTimeout,
    }
  );
};
