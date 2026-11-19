import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { META_ROOM } from '@loro-dev/loro-repo-client';
import { Flock } from '@loro-dev/flock-wasm';
import {
  ExternalMetadataNotCommittedError,
  type ExternalFlockDocsAdapter,
  type LoroRepo,
  type StorageAdapter,
} from 'loro-repo';
import { nativeFlockDocIds } from '@lody/shared/native-workspace-meta-ipc';
import {
  connectNativeRepo,
  importLegacyRoom,
  isNativeWorkspaceMetaEnabled,
  unpublishLegacyRoom,
  type LegacyFlockBundle,
  type NativeRepoHostLauncher,
} from '@lody/shared/node/native-repo';
import { createNativeFlockDocs } from '@lody/shared/node/native-flock-docs';
import {
  createNativeWorkspaceMeta,
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

const flockRoom = (id: string) => ({ kind: 'flock' as const, id });

/**
 * Opens native Meta and the owned named Flock documents for one workspace on
 * the process-wide connection. The CLI replicas are frozen by construction: in
 * this mode their legacy copies are never opened for writing, so each export is
 * final when imported.
 */
export async function openNativeWorkspaceMeta(
  workspaceId: string,
  legacyStorage: StorageAdapter,
  legacyDbPath: string,
  logger: Logger
): Promise<{ meta: NativeWorkspaceMeta; flockDocs: ExternalFlockDocsAdapter }> {
  const { client } = await connectNativeRepo({ launcher: cliNativeRepoHostLauncher });
  const owned = nativeFlockDocIds(workspaceId);
  const results = [
    await importLegacyRoom(client, workspaceId, META_ROOM, CLI_SOURCE, async () => {
      const legacy = await legacyStorage.loadMeta();
      return legacy?.exportJson() as LegacyFlockBundle | undefined;
    }),
  ];
  for (const id of owned)
    results.push(
      await importLegacyRoom(client, workspaceId, flockRoom(id), CLI_SOURCE, async () => {
        const legacy = await legacyStorage.loadFlockDoc?.(id);
        return legacy?.exportJson() as LegacyFlockBundle | undefined;
      })
    );
  await writeFile(publishedMarker(legacyDbPath), workspaceId);
  logger.info(`[${workspaceId}] Native Workspace Meta: legacy CLI sources ${results.join(', ')}`);
  return {
    meta: createNativeWorkspaceMeta(
      client,
      workspaceId,
      (reason) => new ExternalMetadataNotCommittedError(reason)
    ),
    flockDocs: createNativeFlockDocs(
      client,
      workspaceId,
      (id) => owned.includes(id),
      (file) => Flock.fromFile(file).exportJson()
    ),
  };
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
    const { client } = connection;
    legacyRepo.getMeta().importFile((await client.exportFlockRaw(workspaceId, META_ROOM)).bytes);
    await legacyRepo.persistMetaNow();
    for (const id of nativeFlockDocIds(workspaceId)) {
      const handle = await legacyRepo.openFlockDoc(id);
      handle.flock.importFile((await client.exportFlockRaw(workspaceId, flockRoom(id))).bytes);
      await legacyRepo.persistFlockDocNow(id, handle.flock);
      await unpublishLegacyRoom(client, workspaceId, flockRoom(id), CLI_SOURCE);
    }
    await unpublishLegacyRoom(client, workspaceId, META_ROOM, CLI_SOURCE);
    await rm(marker, { force: true });
    logger.info(`[${workspaceId}] Native Workspace Meta written back to the legacy replica`);
  } finally {
    await connection.close();
  }
}
