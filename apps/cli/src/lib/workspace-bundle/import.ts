import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroDoc } from 'loro-crdt';
import type { JsonObject, LoroRepo } from 'loro-repo';
import { z } from 'zod';
import type { OpenBundle } from './bundle-file';
import { authorizeFlockChanges } from './authorize';
import { classifyRoom, KNOWN_CODECS, MACHINE_CODECS, META_ROOM_ID } from './codecs';
import {
  applyPostImportWrites,
  crossWorkspaceRowWithheld,
  mapMetaKey,
  mapRoomId,
} from './cross-workspace';
import type { BundleGap, RoomEntry } from './manifest';

export class ImportRefusedError extends Error {
  override readonly name = 'ImportRefusedError';
}

export const IMPORT_ROLES = ['owner', 'admin'] as const;

export type RowChanges = { added: number; updated: number; deleted: number };
export type RoomPlan = {
  /** Source room id from the bundle. */
  id: string;
  /** Room id written in the target workspace. */
  targetId: string;
  codec: string;
  model: RoomEntry['model'];
  action: 'merge' | 'skip';
  /** For merges: whether the target lacks the room, already covers it, or gains changes. */
  state?: 'new' | 'unchanged' | 'merge';
  reason?: 'unrelated-same-id' | 'deleted-in-target' | 'machine-room' | 'unauthorized';
  detail?: string;
  rows?: RowChanges;
};
export type ImportPlan = {
  digest: string;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  rooms: RoomPlan[];
  gaps: BundleGap[];
};

export type PlanWorkspaceImportInput = {
  bundle: OpenBundle;
  repo: LoroRepo<JsonObject>;
  workspaceId: string;
  /** The importer's workspace role, from the authority that applies to this workspace. */
  role: string;
  /** The importer; existing rows may change only where this user could change them. */
  actorUserId: string;
};

function versionMap(doc: LoroDoc): Map<string, number> {
  return new Map(doc.oplogVersion().toJSON());
}

/**
 * Merges raw Flock file bytes into `target`, keeping every entry's original clock.
 * `skip` withholds entries (for example the Meta rows of a document that is not
 * imported); withheld entries are never written, not written then deleted.
 */
export type RowPolicy = {
  /** Withholds an entry: it is never written, not written then deleted. */
  skip?: (key: readonly unknown[]) => boolean;
  /** Rewrites an entry's key; its value and clock are kept. */
  mapKey?: (key: readonly unknown[]) => unknown[];
};

/**
 * Merges raw Flock file bytes into `target`, keeping every entry's original clock.
 * Without a policy the file is imported as is.
 */
export async function mergeFlockBytes(
  target: Flock,
  bytes: Uint8Array,
  policy: RowPolicy = {}
): Promise<void> {
  const { skip, mapKey } = policy;
  if (!skip && !mapKey) {
    target.importFile(bytes);
    return;
  }
  const source = Flock.fromFile(bytes).exportJson();
  const entries: typeof source.entries = {};
  for (const [encoded, record] of Object.entries(source.entries)) {
    const key = JSON.parse(encoded) as unknown[];
    if (skip?.(key)) continue;
    entries[mapKey ? JSON.stringify(mapKey(key)) : encoded] = record;
  }
  target.importJson({ version: source.version, entries });
}

/** Meta rows of machine records: they describe one machine and never cross workspaces. */
function metaRowIsMachineScoped(key: readonly unknown[], workspaceId: string): boolean {
  if (typeof key[1] !== 'string' || !['e', 'm', 'ef', 'efx'].includes(String(key[0]))) return false;
  const room = classifyRoom(key[1], workspaceId);
  return room.kind === 'room' && MACHINE_CODECS.has(room.codec);
}

/** Meta rows that belong to one document or named Flock id. */
export function metaRowBelongsTo(key: readonly unknown[], ids: ReadonlySet<string>): boolean {
  return (
    (key[0] === 'e' || key[0] === 'm' || key[0] === 'ef' || key[0] === 'efx') &&
    typeof key[1] === 'string' &&
    ids.has(key[1])
  );
}

function covers(target: Map<string, number>, source: Map<string, number>): boolean {
  for (const [peer, counter] of source) if ((target.get(peer) ?? 0) < counter) return false;
  return true;
}

function flockRows(flock: Flock): Map<string, unknown> {
  const rows = new Map<string, unknown>();
  for (const row of flock.scan()) rows.set(JSON.stringify(row.key), row.value);
  return rows;
}

function diffFlock(before: Flock, after: Flock): RowChanges {
  const a = flockRows(before);
  const b = flockRows(after);
  const changes = { added: 0, updated: 0, deleted: 0 };
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const was = a.get(key);
    const now = b.get(key);
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    if (was === undefined) changes.added += 1;
    else if (now === undefined) changes.deleted += 1;
    else changes.updated += 1;
  }
  return changes;
}

const noChanges = (rows: RowChanges) => rows.added + rows.updated + rows.deleted === 0;

/**
 * Verifies, admits and dry-runs an import. Nothing is written: every merge is computed
 * on detached copies of the target's rooms.
 */
export async function planWorkspaceImport(input: PlanWorkspaceImportInput): Promise<ImportPlan> {
  const { bundle, repo, workspaceId } = input;
  if (!(IMPORT_ROLES as readonly string[]).includes(input.role))
    throw new ImportRefusedError('Only workspace owners and admins can import a workspace bundle');
  const { manifest } = bundle;
  const unknown = manifest.rooms.filter((room) => !KNOWN_CODECS.has(room.codec));
  if (unknown.length > 0)
    throw new ImportRefusedError(
      `This bundle contains data this Lody cannot import: ${[...new Set(unknown.map((room) => room.codec))].join(', ')}`
    );
  const metaEntry = manifest.rooms.find((room) => room.id === META_ROOM_ID);
  if (!metaEntry) throw new ImportRefusedError('Bundle has no workspace metadata');
  const sourceWorkspaceId = manifest.source.workspaceId;
  const crossWorkspace = sourceWorkspaceId !== workspaceId;
  const targetIdOf = (id: string) => mapRoomId(id, sourceWorkspaceId, workspaceId);
  const metaPolicy = (withheld: ReadonlySet<string>): RowPolicy => ({
    skip: (key) =>
      metaRowBelongsTo(key, withheld) || (crossWorkspace && metaRowIsMachineScoped(key, sourceWorkspaceId)),
    ...(crossWorkspace ? { mapKey: (key) => mapMetaKey(key, sourceWorkspaceId, workspaceId) } : {}),
  });

  const metaBytes = await bundle.readRoom(metaEntry);
  const targetMeta = Flock.fromFile(repo.getMeta().exportFile());
  // Existence after a full merge decides which bodies may be written at all.
  const provisional = Flock.fromFile(repo.getMeta().exportFile());
  await mergeFlockBytes(provisional, metaBytes, metaPolicy(new Set()));

  const rooms: RoomPlan[] = [];
  for (const entry of manifest.rooms) {
    if (entry.model === 'meta') continue;
    const targetId = targetIdOf(entry.id);
    const base = { id: entry.id, targetId, codec: entry.codec, model: entry.model };
    if (crossWorkspace && MACHINE_CODECS.has(entry.codec)) {
      rooms.push({ ...base, action: 'skip', reason: 'machine-room' });
      continue;
    }
    const existenceKey = entry.model === 'flock' ? 'ef' : 'e';
    if (provisional.get([existenceKey, targetId]) !== true) {
      rooms.push({ ...base, action: 'skip', reason: 'deleted-in-target' });
      continue;
    }
    const bytes = await bundle.readRoom(entry);
    if (entry.model === 'loro') {
      const incoming = new LoroDoc();
      incoming.import(bytes);
      const current = await repo.openDetachedDoc(targetId);
      const target = versionMap(current);
      const source = versionMap(incoming);
      if (target.size === 0) {
        rooms.push({ ...base, action: 'merge', state: 'new' });
      } else if (![...source.keys()].some((peer) => target.has(peer))) {
        rooms.push({ ...base, action: 'skip', reason: 'unrelated-same-id' });
      } else {
        rooms.push({ ...base, action: 'merge', state: covers(target, source) ? 'unchanged' : 'merge' });
      }
      continue;
    }
    const current = await repo.openDetachedFlockDoc(targetId);
    const merged = Flock.fromFile(current.exportFile());
    await mergeFlockBytes(merged, bytes, roomPolicy(entry.codec, crossWorkspace));
    const rows = diffFlock(current, merged);
    const violation = authorizeFlockChanges(entry.codec, current, merged, {
      actorUserId: input.actorUserId,
      ...machineOwner(targetMeta, entry.codec, targetId, workspaceId),
    });
    if (violation) {
      rooms.push({ ...base, action: 'skip', reason: 'unauthorized', detail: violation, rows });
      continue;
    }
    rooms.push({
      ...base,
      action: 'merge',
      state: current.isEmpty() ? 'new' : noChanges(rows) ? 'unchanged' : 'merge',
      rows,
    });
  }

  // Skipped rooms keep the target's own Meta rows for their ids.
  const mergedMeta = Flock.fromFile(repo.getMeta().exportFile());
  await mergeFlockBytes(mergedMeta, metaBytes, metaPolicy(withheldMetaIds(rooms)));
  const metaRows = diffFlock(targetMeta, mergedMeta);
  rooms.push({
    id: metaEntry.id,
    targetId: metaEntry.id,
    codec: metaEntry.codec,
    model: 'meta',
    action: 'merge',
    state: noChanges(metaRows) ? 'unchanged' : 'merge',
    rows: metaRows,
  });
  return {
    digest: manifest.digest,
    sourceWorkspaceId,
    targetWorkspaceId: workspaceId,
    rooms: orderForWrite(rooms),
    gaps: manifest.gaps,
  };
}

function machineOwner(
  meta: Flock,
  codec: string,
  roomId: string,
  workspaceId: string
): { machineOwnerUserId?: string } {
  if (codec !== 'machine-catalog/v1') return {};
  const machineId = roomId.slice(`${workspaceId}:mf:`.length);
  const owner = meta.get(['m', `machine-${machineId}`, 'ownerUserId']);
  return typeof owner === 'string' ? { machineOwnerUserId: owner } : {};
}

function roomPolicy(codec: string, crossWorkspace: boolean): RowPolicy {
  return crossWorkspace ? { skip: (key) => crossWorkspaceRowWithheld(codec, key) } : {};
}

/** Rooms whose Meta rows must not be merged: the target keeps its own. */
function withheldMetaIds(rooms: readonly RoomPlan[]): Set<string> {
  return new Set(
    rooms
      .filter((room) => room.action === 'skip' && room.reason !== 'deleted-in-target')
      .map((room) => room.id)
  );
}

/** Bodies first, then catalogs, then Meta, so nothing becomes visible before its body. */
function orderForWrite(rooms: RoomPlan[]): RoomPlan[] {
  const rank = { loro: 0, roost: 0, shortcuts: 1, flock: 2, meta: 3 } as const;
  return [...rooms].sort((a, b) => rank[a.model] - rank[b.model]);
}

const JournalSchema = z.object({
  version: z.literal(1),
  digest: z.string(),
  targetWorkspaceId: z.string(),
  done: z.array(z.string()),
});
type Journal = z.infer<typeof JournalSchema>;

async function readJournal(file: string, plan: ImportPlan): Promise<Journal> {
  try {
    const journal = JournalSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
    if (journal.digest !== plan.digest || journal.targetWorkspaceId !== plan.targetWorkspaceId)
      throw new Error('Import journal belongs to another bundle or workspace');
    return journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { version: 1, digest: plan.digest, targetWorkspaceId: plan.targetWorkspaceId, done: [] };
    throw error;
  }
}

async function writeJournal(file: string, journal: Journal): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(journal));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
}

export type ApplyWorkspaceImportInput = {
  plan: ImportPlan;
  bundle: OpenBundle;
  repo: LoroRepo<JsonObject>;
  journalPath: string;
  /** Checked before each room; throwing stops the import at a room boundary. */
  checkContinue?: () => Promise<void>;
  onProgress?: (progress: { done: number; total: number; roomId: string }) => void;
  /** Recorded in the visible import receipt. */
  actor?: { userId: string };
  now?: () => string;
};
export type ImportResult = { imported: number; skipped: number; resumed: number };

/**
 * Merges the planned rooms. Each room is one CRDT merge, durable before the journal
 * records it; a rerun with the same bundle continues where it stopped.
 */
export async function applyWorkspaceImport(input: ApplyWorkspaceImportInput): Promise<ImportResult> {
  const { plan, bundle, repo } = input;
  if (plan.digest !== bundle.manifest.digest) throw new Error('Import plan does not match this bundle');
  const crossWorkspace = plan.sourceWorkspaceId !== plan.targetWorkspaceId;
  const journal = await readJournal(input.journalPath, plan);
  const done = new Set(journal.done);
  const entries = new Map(bundle.manifest.rooms.map((room) => [room.id, room]));
  const result: ImportResult = { imported: 0, skipped: 0, resumed: 0 };
  const merges = plan.rooms.filter((room) => room.action === 'merge');
  result.skipped = plan.rooms.length - merges.length;
  let index = 0;
  for (const room of merges) {
    index += 1;
    if (done.has(room.targetId)) {
      result.resumed += 1;
      continue;
    }
    await input.checkContinue?.();
    const entry = entries.get(room.id);
    if (!entry) throw new Error(`Bundle room missing: ${room.id}`);
    const bytes = await bundle.readRoom(entry);
    if (room.model === 'meta') {
      const withheld = withheldMetaIds(plan.rooms);
      await mergeFlockBytes(repo.getMeta(), bytes, {
        skip: (key) =>
          metaRowBelongsTo(key, withheld) ||
          (crossWorkspace && metaRowIsMachineScoped(key, plan.sourceWorkspaceId)),
        ...(crossWorkspace
          ? { mapKey: (key) => mapMetaKey(key, plan.sourceWorkspaceId, plan.targetWorkspaceId) }
          : {}),
      });
      await repo.persistMetaNow();
    } else if (room.model === 'loro') {
      const lease = await repo.acquireDoc(room.targetId);
      try {
        lease.doc.import(bytes);
        await repo.persistDocNow(room.targetId, lease.doc);
      } finally {
        lease.release();
      }
    } else if (room.model === 'flock') {
      const lease = await repo.acquireFlockDoc(room.targetId);
      try {
        await mergeFlockBytes(lease.flock, bytes, roomPolicy(room.codec, crossWorkspace));
        await repo.persistFlockDocNow(room.targetId, lease.flock);
      } finally {
        lease.release();
      }
    } else {
      throw new Error(`Unsupported room model: ${room.model}`);
    }
    done.add(room.targetId);
    journal.done = [...done];
    await writeJournal(input.journalPath, journal);
    result.imported += 1;
    input.onProgress?.({ done: index, total: merges.length, roomId: room.targetId });
  }
  if (crossWorkspace)
    await applyPostImportWrites(
      repo,
      merges.filter((room) => room.state === 'new' && room.model === 'loro')
    );
  await writeImportReceipt(repo, plan, input.actor, input.now);
  return result;
}

/** A row every member can see in the workspace catalog: who imported which bundle. */
async function writeImportReceipt(
  repo: LoroRepo<JsonObject>,
  plan: ImportPlan,
  actor: { userId: string } | undefined,
  now: (() => string) | undefined
): Promise<void> {
  if (!actor) return;
  const catalogId = `${plan.targetWorkspaceId}:wf:workspace`;
  const lease = await repo.acquireFlockDoc(catalogId);
  try {
    const key = ['importReceipt', plan.digest];
    if (lease.flock.get(key) !== undefined) return;
    lease.flock.put(key, {
      actorUserId: actor.userId,
      sourceWorkspaceId: plan.sourceWorkspaceId,
      digest: plan.digest,
      importedAt: (now ?? (() => new Date().toISOString()))(),
    });
    await repo.persistFlockDocNow(catalogId, lease.flock);
  } finally {
    lease.release();
  }
}
