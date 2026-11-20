import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { META_ROOM } from '@loro-dev/loro-repo-client';
import { ExternalMetadataNotCommittedError, type LoroRepo, type StorageAdapter } from 'loro-repo';
import {
  connectNativeRepo,
  isNativeWorkspaceMetaEnabled,
  type NativeRepoHostLauncher,
} from '@lody/shared/node/native-repo';
import {
  createNativeWorkspaceMeta,
  importLegacyMeta,
  unpublishLegacyMeta,
  type LegacyFlockBundle,
  type NativeWorkspaceMeta,
} from '@lody/shared/node/native-workspace-meta';
import { getCliPlatformKind } from '@/lib/cli-platform';
import { getCliNodeExecutable } from '@/lib/managed-daemon-release';
import type { Logger } from '@/utils/logger';

const HOST_ENTRY = 'native-repo-host.js';
const CLI_SOURCE = 'cli-sqlite';

/** Next to the legacy SQLite store: native Meta holds this replica's data. */
const publishedMarker = (legacyDbPath: string) =>
  path.join(path.dirname(legacyDbPath), 'native-meta-published');

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
  legacyDbPath: string,
  logger: Logger
): Promise<NativeWorkspaceMeta> {
  const { client } = await connectNativeRepo({ launcher: cliNativeRepoHostLauncher });
  const result = await importLegacyMeta(client, workspaceId, CLI_SOURCE, async () => {
    const legacy = await legacyStorage.loadMeta();
    return legacy?.exportJson() as LegacyFlockBundle | undefined;
  });
  await writeFile(publishedMarker(legacyDbPath), workspaceId);
  logger.info(`[${workspaceId}] Native Workspace Meta: legacy CLI source ${result}`);
  return createNativeWorkspaceMeta(
    client,
    workspaceId,
    (reason) => new ExternalMetadataNotCommittedError(reason)
  );
}

/**
 * Flag-off after native use: merge the native room (complete Flock export with
 * clocks and tombstones) back into the legacy replica, then return the source to
 * legacy ownership. Renderers receive it through the local data plane. Native
 * mode has no released data, so this is a development switch-back, not a
 * compatibility path; a failure keeps the marker and retries on next start.
 */
export async function writeBackNativeWorkspaceMeta(
  workspaceId: string,
  legacyRepo: LoroRepo,
  legacyDbPath: string,
  logger: Logger
): Promise<void> {
  const marker = publishedMarker(legacyDbPath);
  if (getCliPlatformKind() !== 'local' || !existsSync(marker)) return;
  const connection = await connectNativeRepo({ launcher: cliNativeRepoHostLauncher });
  try {
    const { bytes } = await connection.client.exportFlockRaw(workspaceId, META_ROOM);
    legacyRepo.getMeta().importFile(bytes);
    await legacyRepo.persistMetaNow();
    await unpublishLegacyMeta(connection.client, workspaceId, CLI_SOURCE);
    await rm(marker, { force: true });
    logger.info(`[${workspaceId}] Native Workspace Meta written back to the legacy replica`);
  } finally {
    await connection.close();
  }
}
