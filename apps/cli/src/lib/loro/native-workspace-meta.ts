import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { META_ROOM } from '@loro-dev/loro-repo-client';
import { Flock } from '@loro-dev/flock-wasm';
import {
  ExternalMetadataNotCommittedError,
  type ExternalDocsAdapter,
  type ExternalFlockDocsAdapter,
  type LoroRepo,
  type StorageAdapter,
} from 'loro-repo';
import {
  isNativeDocId,
  isNativeFlockDocId,
  ownedLegacyFlockDocIds,
} from '@lody/shared/native-workspace-meta-ipc';
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
  createNativeDocs,
  createNativeRemoteHistoryPort,
  listNativeDocIds,
  unpublishLegacyDoc,
} from '@lody/shared/node/native-docs';
import { createRemoteLoroHistoryReader, readRemoteLatestGoal } from '@lody/shared/session-data';
import type { MessageQueueItem } from '@lody/shared';
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
): Promise<{
  meta: NativeWorkspaceMeta;
  flockDocs: ExternalFlockDocsAdapter;
  docs: ExternalDocsAdapter;
}> {
  const { client } = await connectNativeRepo({ launcher: cliNativeRepoHostLauncher });
  const stored = (await legacyStorage.inventory?.())?.flockDocIds ?? [];
  const results = [
    await importLegacyRoom(client, workspaceId, META_ROOM, CLI_SOURCE, async () => {
      const legacy = await legacyStorage.loadMeta();
      return legacy?.exportJson() as LegacyFlockBundle | undefined;
    }),
  ];
  for (const id of ownedLegacyFlockDocIds(workspaceId, stored))
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
      (id) => isNativeFlockDocId(workspaceId, id),
      (file) => Flock.fromFile(file).exportJson()
    ),
    // Session bodies migrate lazily, per document, on first native open.
    docs: createNativeDocs(client, workspaceId, isNativeDocId, {
      source: CLI_SOURCE,
      async load(docId) {
        const legacy = await legacyStorage.loadDoc(docId);
        if (!legacy) return undefined;
        return {
          snapshot: legacy.export({ mode: 'snapshot' }),
          version: Object.fromEntries(legacy.oplogVersion().toJSON()),
        };
      },
    }),
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
  legacyStorage: StorageAdapter,
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
    // The Meta Flock registry (now written back) lists documents created natively too.
    const registered = (await legacyRepo.listFlockDoc()).map((row) => row.flockDocId);
    for (const id of ownedLegacyFlockDocIds(workspaceId, registered)) {
      const handle = await legacyRepo.openFlockDoc(id);
      // Idempotent: a registered document without a native room exports empty.
      await client.createRoom(workspaceId, flockRoom(id), 'plaintext');
      handle.flock.importFile((await client.exportFlockRaw(workspaceId, flockRoom(id))).bytes);
      await legacyRepo.persistFlockDocNow(id, handle.flock);
      await unpublishLegacyRoom(client, workspaceId, flockRoom(id), CLI_SOURCE);
    }
    // Session bodies with native state: migrated from any replica or written natively.
    // This runs before the repo opens any document, so the native export is
    // journaled as a Loro update (an idempotent merge) without loading every body.
    for (const docId of await listNativeDocIds(client, workspaceId)) {
      if (!isNativeDocId(docId)) continue;
      const room = { kind: 'loro_doc' as const, id: docId };
      const { bytes } = await client.exportLoroRaw(workspaceId, room);
      await legacyStorage.save({ type: 'doc-update', docId, update: bytes });
      await unpublishLegacyDoc(client, workspaceId, docId, CLI_SOURCE);
    }
    await unpublishLegacyRoom(client, workspaceId, META_ROOM, CLI_SOURCE);
    await rm(marker, { force: true });
    logger.info(`[${workspaceId}] Native Workspace Meta written back to the legacy replica`);
  } finally {
    await connection.close();
  }
}

/**
 * Read-only access to an idle native Session without a replica: bounded history
 * reads and the queue root, served by the engine on the shared connection.
 * Nothing here writes, arms auto-seen or enters the session cache.
 */
export async function openNativeSessionReader(workspaceId: string, roomId: string) {
  const { client } = await connectNativeRepo({ launcher: cliNativeRepoHostLauncher });
  const port = createNativeRemoteHistoryPort(client, workspaceId, roomId);
  const history = createRemoteLoroHistoryReader(port);
  return {
    history,
    readHistoryDirectory: async (from: number, to: number) => history.readDirectory(from, to),
    getMessageQueue: async () => {
      const value = await port.readPath(['mq']);
      return (Array.isArray(value) ? value : []) as readonly MessageQueueItem[];
    },
    readLatestGoal: async () => readRemoteLatestGoal(port),
    /** The document's `session` metadata root, as `SessionDocument.getMetaState`. */
    getMetaState: async () =>
      (await port.readPath(['session'])) as Record<string, unknown> | undefined,
  };
}
