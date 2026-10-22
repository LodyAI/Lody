import type { SnapshotCodec, SnapshotUploadOptions } from '@loro-dev/streams-crdt';
import type { StreamsRoomPayloadProtectionResolver } from 'loro-repo/transport/streams';

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

/** A cloneable mode marker for paths that cannot yet protect content. */
export type WorkspaceStreamsMode = Pick<WorkspaceStreamsContent, 'mode'>;

/** Reject before any cache, authentication, or transport side effect. */
export function requirePlaintextWorkspaceStreamsContent(content: WorkspaceStreamsMode): void {
  if (content?.mode !== 'plaintext') {
    throw new WorkspaceStreamsConfigurationError('Encrypted workspace does not support this operation');
  }
}
