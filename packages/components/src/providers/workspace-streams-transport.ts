import type {
  RemoteCursorStore,
  SnapshotCodec,
  SnapshotUploadOptions,
} from '@loro-dev/streams-crdt';
import {
  createLoroStreamUrl,
  getLoroMetaStreamId,
  getLoroStreamIdForDocId,
  getLoroStreamsShardUrls,
  LORO_STREAMS_BUCKET_ID,
  streamsSnapshotCodec,
  type WorkspaceId,
} from '@lody/shared';
import type { WorkspaceRepoLegacy } from '@lody/shared/workspace-data/repo-legacy';
import type { LoroStreamsTokenAuth } from '@lody/shared';
import { workspaceStreamsTransport } from '@lody/shared/workspace-data/streams';
import { getLoroSnapshotDiagnostic } from '@lody/shared/loro-sync-errors';
import { type StreamsRoomPayloadProtectionResolver } from 'loro-repo/effect/streams';

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

export type WorkspaceStreamsTransportOptions = {
  repo: WorkspaceRepoLegacy;
  workspaceId: WorkspaceId;
  /**
   * LoroDoc room cursors only. Meta and named Flock progress is replica-bound:
   * the repo's IndexedDB restores each checkpoint with the data it covers, so a
   * window or tab never resumes past state its own replica lacks.
   */
  documentRemoteCursorStore: RemoteCursorStore;
  auth: LoroStreamsTokenAuth;
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
export const createWorkspaceStreamsTransport = (options: WorkspaceStreamsTransportOptions) => {
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

  return workspaceStreamsTransport(
    {
      bucketId: LORO_STREAMS_BUCKET_ID,
      metaStreamId: getLoroMetaStreamId(options.workspaceId),
      docStreamId: (docId) => getLoroStreamIdForDocId(options.workspaceId, docId),
      flockDocStreamId: (flockDocId) => flockDocId,
      snapshotCodec:
        content?.mode === 'protected'
          ? (content.snapshotCodec ?? streamsSnapshotCodec)
          : streamsSnapshotCodec,
      baseUrl: options.streamsBaseUrl,
      shardUrls: getLoroStreamsShardUrls(options.streamsBaseUrl, options.shardHostSuffix),
      snapshotUpload: {
        ...(content?.mode === 'protected'
          ? content.snapshotUpload
          : { canUpload: async () => true }),
        onDiagnostic: (event) => {
          try {
            const diagnostic = getLoroSnapshotDiagnostic(event);
            if (event.outcome === 'failed') console.warn('Streams snapshot', diagnostic);
            else console.debug('Streams snapshot', diagnostic);
          } catch {
            // A diagnostic sink cannot interrupt upload or the configured observer.
          }
          return content?.mode === 'protected'
            ? content.snapshotUpload.onDiagnostic?.(event)
            : undefined;
        },
      },
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
    },
    options.auth
  );
};
