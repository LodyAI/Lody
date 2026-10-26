import { parseMachineFlockDocId } from './machine-flock';
import { getWorkspaceFlockDocId } from './workspace-flock';
import type { WorkspaceId } from './ids';
import type { SnapshotCodec, SnapshotUploadOptions } from '@loro-dev/streams-crdt';
import type { StreamsRoomIdentity, StreamsRoomPayloadProtectionResolver } from 'loro-repo/transport/streams';

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

/** Stable across devices and epochs: loro-repo includes this value in frame AAD. */
export function encryptedWorkspaceNamespace(genesisHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(genesisHash))
    throw new WorkspaceStreamsConfigurationError('Encrypted workspace genesis is invalid');
  return `lody-e2ee:${genesisHash}`;
}

/** The M2 content domain. This also validates foreign IPC room identities. */
export function encryptedWorkspaceRoom(workspaceId: string, room: StreamsRoomIdentity): { resource: string; model: 'loro' | 'flock' } {
  if (room?.kind === 'meta') return { resource: 'meta', model: 'flock' };
  if (room?.kind === 'doc' && typeof room.docId === 'string' && room.docId.length > 0 && room.docId.length <= 1000)
    return { resource: `doc:${room.docId}`, model: 'loro' };
  if (room?.kind === 'flock' && typeof room.flockDocId === 'string' && room.flockDocId.length <= 1000) {
    const machine = parseMachineFlockDocId(room.flockDocId);
    if ((machine && machine.workspaceId === workspaceId) || room.flockDocId === getWorkspaceFlockDocId(workspaceId as WorkspaceId))
      return { resource: `flock:${room.flockDocId}`, model: 'flock' };
  }
  throw new WorkspaceStreamsConfigurationError('Encrypted workspace room is unavailable');
}

/** Build a fail-closed encrypted-only selector without a plaintext default. */
export function encryptedWorkspaceResolver(workspaceId: string, provider: (room: StreamsRoomIdentity) => import('@loro-dev/streams-crdt').PayloadProtectionProvider): StreamsRoomPayloadProtectionResolver {
  return room => {
    encryptedWorkspaceRoom(workspaceId, room);
    return { mode: 'protected', config: { provider: provider(room), readPolicy: 'encrypted-only', writePolicy: 'encrypt' } };
  };
}

/** Unencrypted side channels remain unavailable until their E2EE milestones. */
export type WorkspaceRestrictedFeature = 'schedules' | 'preview-comments' | 'code-collab-index' | 'shortcuts' | 'sharing' | 'remote-preview' | 'export' | 'oss-import' | 'notification-body' | 'attachments' | 'rpc' | 'presence';
export function workspaceSupports(content: WorkspaceStreamsMode, _feature: WorkspaceRestrictedFeature): boolean {
  return content.mode === 'plaintext';
}
