import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExternalMetadataNotCommittedError, type StorageAdapter } from 'loro-repo';
import {
  connectNativeRepo,
  isNativeWorkspaceMetaEnabled,
  type NativeRepoHostLauncher,
} from '@lody/shared/node/native-repo';
import {
  createNativeWorkspaceMeta,
  importLegacyMeta,
  type LegacyFlockBundle,
  type NativeWorkspaceMeta,
} from '@lody/shared/node/native-workspace-meta';
import { getCliPlatformKind } from '@/lib/cli-platform';
import { getCliNodeExecutable } from '@/lib/managed-daemon-release';
import type { Logger } from '@/utils/logger';

const HOST_ENTRY = 'native-repo-host.js';

/** The emitted sibling entry; chunked modules resolve it from their parent. */
function cliNativeRepoHostLauncher(): NativeRepoHostLauncher {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entry = [here, path.dirname(here)]
    .map((dir) => path.join(dir, HOST_ENTRY))
    .find((candidate) => existsSync(candidate));
  if (!entry) throw new Error(`native_repo_host_missing: ${HOST_ENTRY} is not built`);
  return { command: getCliNodeExecutable(), args: [entry] };
}

/** Local, unencrypted workspaces only; the OSS desktop has no cloud Meta. */
export const usesNativeWorkspaceMeta = (encrypted: boolean) =>
  !encrypted && getCliPlatformKind() === 'local' && isNativeWorkspaceMetaEnabled();

/**
 * Opens native Meta for one workspace on the process-wide connection. The CLI
 * replica is frozen by construction: in this mode its legacy Meta is never
 * opened for writing, so its export is final when imported.
 */
export async function openNativeWorkspaceMeta(
  workspaceId: string,
  legacyStorage: StorageAdapter,
  logger: Logger
): Promise<NativeWorkspaceMeta> {
  const { client } = await connectNativeRepo({ launcher: cliNativeRepoHostLauncher });
  const result = await importLegacyMeta(client, workspaceId, 'cli-sqlite', async () => {
    const legacy = await legacyStorage.loadMeta();
    return legacy?.exportJson() as LegacyFlockBundle | undefined;
  });
  logger.info(`[${workspaceId}] Native Workspace Meta: legacy CLI source ${result}`);
  return createNativeWorkspaceMeta(
    client,
    workspaceId,
    (reason) => new ExternalMetadataNotCommittedError(reason)
  );
}
