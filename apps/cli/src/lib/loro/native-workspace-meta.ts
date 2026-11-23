import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { META_ROOM, RepoRpcError, type RepoClient } from '@loro-dev/loro-repo-client';
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
  isNativePreviewCommentDocId,
  ownedLegacyFlockDocIds,
} from '@lody/shared/native-workspace-meta-ipc';
import {
  connectNativeRepo,
  importLegacyRoom,
  isNativeEncryptedWorkspaceEnabled,
  isNativeWorkspaceMetaEnabled,
  nativeRepoDataDir,
  clearMigrationMarkers,
  type LegacyFlockBundle,
  type NativeRepoHostLauncher,
} from '@lody/shared/node/native-repo';
import { createNativeFlockDocs } from '@lody/shared/node/native-flock-docs';
import {
  finishNativeWipe,
  nativeEncryptedPendingUpload,
  nativeLocalIdentities,
  nativePendingWipeMarker,
} from '@lody/shared/node/native-encrypted-workspace';
import {
  createNativeDocs,
  createNativeRemoteHistoryPort,
  importLegacyDoc,
  listNativeDocIds,
} from '@lody/shared/node/native-docs';
import {
  createRemoteLoroHistoryReader,
  readRemoteHistoryTranscript,
  readRemoteLatestGoal,
  readSessionHistory,
  shareObservation,
} from '@lody/shared/session-data';
import type { MessageQueueItem, SessionHistoryInput } from '@lody/shared';
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

/**
 * Local unencrypted workspaces, or (phase 1 of specs/native-engine-cloud-e2ee.md)
 * cloud encrypted workspaces with both switches on. Cloud plaintext workspaces
 * stay legacy; the OSS desktop has no cloud Meta.
 */
export const usesNativeWorkspaceMeta = (encrypted: boolean) =>
  isNativeWorkspaceMetaEnabled() &&
  (encrypted
    ? getCliPlatformKind() === 'cloud' && isNativeEncryptedWorkspaceEnabled()
    : getCliPlatformKind() === 'local');

/**
 * Whether one workspace runs on the native engine: the switches, except that an
 * encrypted workspace whose namespace still holds rows not yet uploaded stays
 * native until they are (`nativeEncryptedPendingUpload`).
 */
export async function usesNativeWorkspaceMetaFor(
  workspaceId: string,
  encrypted: boolean,
  logger: Logger
): Promise<boolean> {
  if (usesNativeWorkspaceMeta(encrypted)) return true;
  if (!encrypted || getCliPlatformKind() !== 'cloud') return false;
  const pending = await nativeEncryptedPendingUpload(
    nativeRepoDataDir('cloud'),
    workspaceId,
    connectCliNativeRepo
  ).catch(() => 0);
  if (pending > 0)
    logger.warn(
      `[${workspaceId}] Native engine switch is off, but ${pending} rows are not uploaded yet; ` +
        'the workspace stays native until they are'
    );
  return pending > 0;
}

/** This installation's engine: one per platform, shared with the desktop. */
const connectCliNativeRepo = () =>
  connectNativeRepo({
    launcher: cliNativeRepoHostLauncher,
    dataDir: nativeRepoDataDir(getCliPlatformKind()),
  });

/**
 * Finishes the native wipe of a member-removed workspace, which never attaches
 * again. Connects only when this workspace's pending-wipe marker exists.
 */
export async function finishPendingNativeWipe(workspaceId: string) {
  const dataDir = nativeRepoDataDir(getCliPlatformKind());
  const pendingWipe = nativePendingWipeMarker(dataDir, workspaceId);
  if (!(await pendingWipe.read())) return;
  const { client } = await connectCliNativeRepo();
  const identities = nativeLocalIdentities(dataDir, workspaceId);
  await finishNativeWipe({ client, workspaceId, pendingWipe, identities });
}

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
  logger: Logger,
  /**
   * An encrypted workspace's verified runtime, attached before any room exists.
   * Its rooms are encrypted and arrive from the content bucket, never imported:
   * the legacy replica's copies are the same cloud rooms.
   */
  encrypted?: { attachNativeEngine(client: RepoClient, dataDir: string): Promise<void> }
): Promise<{
  meta: NativeWorkspaceMeta;
  flockDocs: ExternalFlockDocsAdapter;
  docs: ExternalDocsAdapter;
}> {
  const { client, dataDir } = await connectCliNativeRepo();
  if (encrypted) {
    await encrypted.attachNativeEngine(client, dataDir);
    logger.info(
      `[${workspaceId}] Native Workspace Meta: encrypted, synced from the content bucket`
    );
    return nativeAdapters(client, workspaceId);
  }
  const inventory = await legacyStorage.inventory?.();
  const stored = inventory?.flockDocIds ?? [];
  const loadLegacyDoc = async (docId: string) => {
    const legacy = await legacyStorage.loadDoc(docId);
    if (!legacy) return undefined;
    return {
      snapshot: legacy.export({ mode: 'snapshot' }),
      version: Object.fromEntries(legacy.oplogVersion().toJSON()),
    };
  };
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
  let rendererDocsImported = 0;
  for (const docId of inventory?.docIds ?? [])
    if (
      isNativePreviewCommentDocId(docId) &&
      (await importLegacyDoc(client, workspaceId, docId, CLI_SOURCE, () =>
        loadLegacyDoc(docId)
      )) === 'imported'
    )
      rendererDocsImported += 1;
  await writeFile(publishedMarker(legacyDbPath), workspaceId);
  logger.info(
    `[${workspaceId}] Native Workspace Meta: legacy CLI sources ${results.join(', ')}; ` +
      `${rendererDocsImported} renderer-only documents imported`
  );
  return nativeAdapters(client, workspaceId, { source: CLI_SOURCE, load: loadLegacyDoc });
}

function nativeAdapters(
  client: RepoClient,
  workspaceId: string,
  legacy?: Parameters<typeof createNativeDocs>[3]
) {
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
    docs: createNativeDocs(client, workspaceId, isNativeDocId, legacy),
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
  const connection = await connectCliNativeRepo();
  try {
    const { client } = connection;
    legacyRepo.getMeta().importFile((await client.exportFlockRaw(workspaceId, META_ROOM)).bytes);
    await legacyRepo.persistMetaNow();
    const registered = (await legacyRepo.listFlockDoc()).map((row) => row.flockDocId);
    for (const id of ownedLegacyFlockDocIds(workspaceId, registered)) {
      const handle = await legacyRepo.openFlockDoc(id);
      await client.createRoom(workspaceId, flockRoom(id), 'plaintext');
      handle.flock.importFile((await client.exportFlockRaw(workspaceId, flockRoom(id))).bytes);
      await legacyRepo.persistFlockDocNow(id, handle.flock);
    }
    const docIds = new Set(await listNativeDocIds(client, workspaceId));
    for (const row of await legacyRepo.listDoc()) docIds.add(row.docId);
    for (const docId of docIds) {
      if (!isNativeDocId(docId)) continue;
      const room = { kind: 'loro_doc' as const, id: docId };
      const exported = await client.exportLoroRaw(workspaceId, room).catch((error: unknown) => {
        if (error instanceof RepoRpcError && error.code === 'room_not_found') return undefined;
        throw error;
      });
      if (!exported) continue;
      await legacyStorage.save({ type: 'doc-update', docId, update: exported.bytes });
    }
    await clearMigrationMarkers(client, workspaceId);
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
  const { client } = await connectCliNativeRepo();
  const port = shareObservation(createNativeRemoteHistoryPort(client, workspaceId, roomId));
  const history = createRemoteLoroHistoryReader(port);
  return {
    history,
    readHistoryDirectory: async (from: number, to: number) => history.readDirectory(from, to),
    readTurn: async (turnId: string) => history.readTurn(turnId),
    /** Every turn in one consistent read, as `SessionBackend.readHistory`. */
    readHistory: async () => {
      const all = await history.readAll();
      return readSessionHistory({ readAll: () => all }) as SessionHistoryInput[];
    },
    readHistoryTranscript: async (options: { limit?: number; reverse?: boolean }) =>
      readRemoteHistoryTranscript(port, options),
    getMessageQueue: async () => {
      const value = await port.readPath(['mq']);
      return (Array.isArray(value) ? value : []) as readonly MessageQueueItem[];
    },
    readLatestGoal: async () => readRemoteLatestGoal(port),
    /** The document's `session` metadata root, as `SessionDocument.getMetaState`. */
    getMetaState: async () =>
      (await port.readPath(['session'])) as Record<string, unknown> | undefined,
    /** Fires when a root other than `history` changes, as `SessionDocument.subscribeControl`. */
    subscribeControl: (listener: () => void) => {
      const observation = port.observePaths((event) => {
        if (event.kind === 'reset' || event.changes.some((change) => change.path[0] !== 'history'))
          listener();
      });
      return () => observation.close();
    },
  };
}
