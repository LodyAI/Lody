import type { LoroRepo } from 'loro-repo';
import type { WorkspaceId } from '@lody/shared';
import type { LocalNativeFileIndexSource } from '@lody/shared/local-loro-data-plane-server';
import type { CodeCollabPublicationStore } from './code-collab-publication-store';
import type { CodeCollabV2FileIndexPublication } from './code-collab-v2-service';

/** Trusted Node composition only. A selected owner never falls back on errors.
 * File operations and the first snapshot remain owned by Machine RPC. */
export interface CodeCollabFileIndexBackend {
  readonly source: LocalNativeFileIndexSource;
  store(ownerSessionId: string): Promise<CodeCollabPublicationStore>;
  ownsRoom(roomId: string): Promise<boolean>;
  markPublished(
    ownerSessionId: string,
    publication: CodeCollabV2FileIndexPublication
  ): void | Promise<void>;
  close(): Promise<void>;
}

/** Invoked only for an ordinary Cloud daemon, before its data plane/transport.
 * The private composition supplies authorization; this port contains no tokens. */
export type CodeCollabFileIndexBackendFactory = ((input: {
  readonly repo: LoroRepo;
  readonly workspaceId: WorkspaceId;
  readonly accountId: string;
  readonly machineId?: string;
}) => Promise<CodeCollabFileIndexBackend | null>) & { readonly authorityId?: string };
