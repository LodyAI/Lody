import path from 'node:path';
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

/**
 * The workspace the operation runs in. `syncRoom` brings one room up to date with
 * its remote (download before export, upload after import); it is absent on the
 * local platform, where the daemon's repo is the only replica.
 */
export type BundleWorkspace = {
  id: string;
  repo: LoroRepo<JsonObject>;
  syncRoom?: (roomId: string, model: 'meta' | 'loro' | 'flock') => Promise<void>;
};

export type BundleActor = { userId: string; machineId: string; lodyVersion: string };

function assertRole(role: string, action: 'export' | 'import'): void {
  if (!(IMPORT_ROLES as readonly string[]).includes(role))
    throw new ImportRefusedError(`Only workspace owners and admins can ${action} a workspace bundle`);
}

export type ExportSummary = { file: string; rooms: number; blobs: number; gaps: BundleGap[]; digest: string };

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
  assertRole(input.role, 'import');
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
    if (workspace.syncRoom) {
      for (const room of plan.rooms) {
        if (room.action !== 'merge' || room.state === 'unchanged') continue;
        try {
          await workspace.syncRoom(room.targetId, room.model === 'meta' ? 'meta' : room.model === 'loro' ? 'loro' : 'flock');
        } catch {
          uploadPending.push(room.targetId);
        }
      }
    }
    return { plan, result, uploadPending };
  } finally {
    await bundle.close();
  }
}
