import type {
  RemoteCursorStore,
  SnapshotCodec,
  SnapshotUploadOptions,
} from '@loro-dev/streams-crdt';
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
import {
  StreamsTransportAdapter,
  createRepoStreamsPersistence,
  type StreamsRoomPayloadProtectionResolver,
} from 'loro-repo/transport/streams';

/** Transport configuration, not a persisted workspace mode or an E2EE capability verdict. */
export type WorkspaceStreamsContent =
  | { mode: 'plaintext' }
  | {
      mode: 'protected';
      /** Trusted application identity; never derive it from a packet or routing URL. */
      namespace: string;
      /** Every Meta, document and named Flock room must select protected content. */
      resolve: StreamsRoomPayloadProtectionResolver;
      /** Explicit admission is required; protection never inherits the plaintext allow gate. */
      snapshotUpload: SnapshotUploadOptions;
      /** Compression only. The SDK protects both updates and snapshots with the provider. */
      snapshotCodec?: SnapshotCodec;
    };

export class WorkspaceStreamsConfigurationError extends Error {
  override readonly name = 'WorkspaceStreamsConfigurationError';
}

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
  /** Omission preserves the existing ordinary-workspace transport. */
  content?: WorkspaceStreamsContent;
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
): StreamsTransportAdapter => {
  const content = options.content;
  if (content !== undefined && content?.mode !== 'plaintext' && content?.mode !== 'protected') {
    throw new WorkspaceStreamsConfigurationError('Unsupported workspace Streams content mode');
  }
  if (
    content?.mode === 'protected' &&
    (typeof content.namespace !== 'string' ||
      content.namespace.length === 0 ||
      typeof content.resolve !== 'function' ||
      typeof content.snapshotUpload?.canUpload !== 'function' ||
      (content.snapshotCodec !== undefined &&
        (typeof content.snapshotCodec?.compress !== 'function' ||
          typeof content.snapshotCodec?.decompress !== 'function')))
  ) {
    throw new WorkspaceStreamsConfigurationError('Incomplete workspace Streams content protection');
  }

  return new StreamsTransportAdapter({
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
    snapshotCodec:
      content?.mode === 'protected'
        ? (content.snapshotCodec ?? streamsSnapshotCodec)
        : streamsSnapshotCodec,
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
  });
};
