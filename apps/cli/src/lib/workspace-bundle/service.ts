import path from 'node:path';
import { mapWithConcurrency } from '../bounded-concurrency';
import type { JsonObject, LoroRepo } from 'loro-repo';
import { localSessionFileBlobs, restoreSessionFileBlobs } from './blobs';
import { createBundleWriter, openBundle } from './bundle-file';
import { META_ROOM_ID } from './codecs';
import { exportWorkspaceBundle } from './export';
import {
  applyWorkspaceImport,
  IMPORT_ROLES,
  ImportRefusedError,
  planWorkspaceImport,
  type ImportPlan,
  type ImportResult,
} from './import';
import type { BundleGap } from './manifest';

/** `syncRoom` downloads before export and uploads after import; absent locally. */
export type BundleWorkspace = {
  id: string;
  repo: LoroRepo<JsonObject>;
  syncRoom?: (roomId: string, model: 'meta' | 'loro' | 'flock') => Promise<void>;
  /** Visible turns of a Roost conversation, read through the session backend. */
  readRoostHistory?: (sessionId: string) => Promise<readonly unknown[]>;
};

export type BundleActor = { userId: string; machineId: string; lodyVersion: string };

function assertRole(role: string, action: 'export' | 'import'): void {
  if (!(IMPORT_ROLES as readonly string[]).includes(role))
    throw new ImportRefusedError(
      `Only workspace owners and admins can ${action} a workspace bundle`
    );
}

export type ExportSummary = {
  file: string;
  rooms: number;
  blobs: number;
  gaps: BundleGap[];
  digest: string;
};

export async function runWorkspaceExport(input: {
  workspace: BundleWorkspace;
  role: string;
  actor: BundleActor;
  out: string;
  now?: () => string;
}): Promise<ExportSummary> {
  assertRole(input.role, 'export');
  const now = input.now ?? (() => new Date().toISOString());
  const { workspace } = input;
  const out = path.resolve(input.out);
  const startedAt = now();
  await workspace.syncRoom?.(META_ROOM_ID, 'meta');
  const writer = await createBundleWriter(out);
  try {
    const manifest = await exportWorkspaceBundle({
      repo: workspace.repo,
      workspaceId: workspace.id,
      writer,
      source: {
        workspaceId: workspace.id,
        exporterUserId: input.actor.userId,
        exporterMachineId: input.actor.machineId,
        lodyVersion: input.actor.lodyVersion,
        startedAt,
      },
      ...(workspace.syncRoom ? { prepareRoom: workspace.syncRoom } : {}),
      sessionBlobs: localSessionFileBlobs(workspace.id),
      ...(workspace.readRoostHistory ? { roostHistory: workspace.readRoostHistory } : {}),
      now,
    });
    return {
      file: out,
      rooms: manifest.rooms.length,
      blobs: manifest.blobs.length,
      gaps: manifest.gaps,
      digest: manifest.digest,
    };
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

/** Roost turns are rewritten into their session document, so they sync as Loro. */
/** Same bound as `lody export`: uploads are network-bound but must not flood Streams. */
const UPLOAD_CONCURRENCY = 4;
const SYNC_MODEL = { meta: 'meta', loro: 'loro', flock: 'flock', roost: 'loro' } as const;

export type ImportOutcome = {
  plan: ImportPlan;
  result?: ImportResult;
  /** Rooms merged locally whose upload did not complete; normal sync retries them. */
  uploadPending: string[];
};

export async function runWorkspaceImport(input: {
  workspace: BundleWorkspace;
  role: string;
  actor: BundleActor;
  file: string;
  /** Directory holding resumable import journals. */
  journalDir: string;
  dryRun?: boolean;
  now?: () => string;
}): Promise<ImportOutcome> {
  // The planner refuses roles that may not import, before anything is written.
  const { workspace } = input;
  const bundle = await openBundle(path.resolve(input.file));
  try {
    await bundle.verifyAll();
    await workspace.syncRoom?.(META_ROOM_ID, 'meta');
    const plan = await planWorkspaceImport({
      bundle,
      repo: workspace.repo,
      workspaceId: workspace.id,
      role: input.role,
      actorUserId: input.actor.userId,
    });
    if (input.dryRun) return { plan, uploadPending: [] };
    const result = await applyWorkspaceImport({
      plan,
      bundle,
      repo: workspace.repo,
      journalPath: path.join(input.journalDir, `${workspace.id}-${plan.digest}.json`),
      actor: { userId: input.actor.userId },
      ...(input.now ? { now: input.now } : {}),
    });
    await restoreSessionFileBlobs({ bundle, plan });
    const uploadPending: string[] = [];
    const syncRoom = workspace.syncRoom;
    if (syncRoom) {
      const changed = plan.rooms.filter(
        (room) => room.action === 'merge' && room.state !== 'unchanged'
      );
      const uploaded = await mapWithConcurrency(changed, UPLOAD_CONCURRENCY, (room) =>
        syncRoom(room.targetId, SYNC_MODEL[room.model]).then(
          () => true,
          () => false
        )
      );
      changed.forEach((room, index) => {
        if (!uploaded[index]) uploadPending.push(room.targetId);
      });
    }
    return { plan, result, uploadPending };
  } finally {
    await bundle.close();
  }
}
