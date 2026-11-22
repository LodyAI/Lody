import { createSessionMirror } from '@lody/shared/session-mirror';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroDoc } from 'loro-crdt';
import type { JsonObject, LoroRepo } from 'loro-repo';
import { z } from 'zod';
import {
  type ScheduleImportFence,
  type SessionHistoryInput,
  type SessionImportFence,
} from '@lody/shared';
import type { BundleKind, BundleSkipReason } from '@lody/shared/workspace-bundle-control';
import { atomicJson } from '../fs-atomic';
import type { OpenBundle } from './bundle-file';
import { authorizeFlockChanges } from './authorize';
import {
  classifyRoom,
  codecTraits,
  KNOWN_CODECS,
  META_ROOM_ID,
  ROOST_ROOM_PREFIX,
  roomMatchesId,
} from './codecs';
import {
  crossWorkspaceRowWithheld,
  mapMetaKey,
  mapRoomId,
  scheduleImportFence,
  sessionImportFence,
} from './cross-workspace';
import type { BundleGap, RoomEntry } from './manifest';
import { withDoc, withFlock } from './repo-leases';

type ImportFence = SessionImportFence | ScheduleImportFence;

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
  /** What a person calls this kind of data, and whether it counts as one of their items. */
  kind: BundleKind;
  counted: boolean;
  action: 'merge' | 'skip';
  /** For merges: whether the target lacks the room, already covers it, or gains changes. */
  state?: 'new' | 'unchanged' | 'merge';
  reason?: BundleSkipReason;
  detail?: string;
  rows?: RowChanges;
  /** What a person calls this item (conversation or schedule title, machine name). */
  label?: string;
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

export type RowPolicy = {
  /** Withholds an entry: it is never written, not written then deleted. */
  skip?: (key: readonly unknown[]) => boolean;
  /** Rewrites an entry's key; its value and clock are kept. */
  mapKey?: (key: readonly unknown[]) => unknown[];
};

/** Merges raw Flock file bytes into `target`, keeping every entry's original clock. */
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

/** The document or named Flock id a Meta row belongs to, if it is a per-id row. */
function metaRowDocId(key: readonly unknown[]): string | undefined {
  return (key[0] === 'e' || key[0] === 'm' || key[0] === 'ef' || key[0] === 'efx') &&
    typeof key[1] === 'string'
    ? key[1]
    : undefined;
}

/** Meta rows a merge writes; plan and apply share it so the plan matches the write. */
function metaPolicy(
  sourceWorkspaceId: string,
  targetWorkspaceId: string,
  withheld: ReadonlySet<string>
): RowPolicy {
  const crossWorkspace = sourceWorkspaceId !== targetWorkspaceId;
  return {
    skip: (key) => {
      const docId = metaRowDocId(key);
      if (docId === undefined) return false;
      if (withheld.has(docId)) return true;
      if (!crossWorkspace) return false;
      const room = classifyRoom(docId, sourceWorkspaceId);
      return room.kind === 'room' && codecTraits(room.codec)?.machine === true;
    },
    ...(crossWorkspace
      ? { mapKey: (key) => mapMetaKey(key, sourceWorkspaceId, targetWorkspaceId) }
      : {}),
  };
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

/** Verifies, admits and dry-runs an import on detached copies; writes nothing. */
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
  const sourceWorkspaceId = manifest.source.workspaceId;
  const mislabelled = manifest.rooms.filter((room) => !roomMatchesId(room, sourceWorkspaceId));
  if (mislabelled.length > 0)
    throw new ImportRefusedError(
      `This bundle labels rooms inconsistently: ${mislabelled.map((room) => room.id).join(', ')}`
    );
  const metaEntry = manifest.rooms.find((room) => room.id === META_ROOM_ID);
  if (!metaEntry) throw new ImportRefusedError('Bundle has no workspace metadata');
  const crossWorkspace = sourceWorkspaceId !== workspaceId;
  const targetIdOf = (id: string) => mapRoomId(id, sourceWorkspaceId, workspaceId);

  const metaBytes = await bundle.readRoom(metaEntry);
  const targetMetaBytes = repo.getMeta().exportFile();
  const targetMeta = Flock.fromFile(targetMetaBytes);
  // Existence after a full merge decides which bodies may be written at all.
  const provisional = Flock.fromFile(targetMetaBytes);
  await mergeFlockBytes(
    provisional,
    metaBytes,
    metaPolicy(sourceWorkspaceId, workspaceId, new Set())
  );

  const titles = new Map<string, string>();
  const rooms: RoomPlan[] = [];
  for (const entry of manifest.rooms) {
    if (entry.model === 'meta') continue;
    const traits = codecTraits(entry.codec);
    if (!traits) throw new ImportRefusedError(`Unknown bundle codec: ${entry.codec}`);
    const isRoost = entry.model === 'roost';
    const targetId = isRoost ? entry.id.slice(ROOST_ROOM_PREFIX.length) : targetIdOf(entry.id);
    const base = {
      id: entry.id,
      targetId,
      codec: entry.codec,
      model: entry.model,
      kind: traits.kind,
      counted: traits.counted,
    };
    if (crossWorkspace && traits.machine) {
      rooms.push({ ...base, action: 'skip', reason: 'machine-room' });
      continue;
    }
    // Rewritten Roost turns never merge into a conversation the target already has.
    if (isRoost && targetMeta.get(['e', targetId]) !== undefined) {
      rooms.push({ ...base, action: 'skip', reason: 'roost-exists' });
      continue;
    }
    const existenceKey = entry.model === 'flock' ? 'ef' : 'e';
    if (provisional.get([existenceKey, targetId]) !== true) {
      rooms.push({ ...base, action: 'skip', reason: 'deleted-in-target' });
      continue;
    }
    if (isRoost) {
      rooms.push({ ...base, action: 'merge', state: 'new' });
      continue;
    }
    const bytes = await bundle.readRoom(entry);
    if (entry.model === 'loro') {
      const incoming = new LoroDoc();
      incoming.import(bytes);
      const definitionTitle = incoming.getMap('definition').get('title');
      if (typeof definitionTitle === 'string' && definitionTitle)
        titles.set(entry.id, definitionTitle);
      const target = versionMap(await repo.openDetachedDoc(targetId));
      const source = versionMap(incoming);
      if (target.size === 0) {
        rooms.push({ ...base, action: 'merge', state: 'new' });
      } else if (![...source.keys()].some((peer) => target.has(peer))) {
        rooms.push({ ...base, action: 'skip', reason: 'unrelated-same-id' });
      } else {
        rooms.push({
          ...base,
          action: 'merge',
          state: covers(target, source) ? 'unchanged' : 'merge',
        });
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

  // Name each item as the bundle does; the target's own copy may be a different item.
  const sourceMeta = Flock.fromFile(metaBytes);
  for (const room of rooms) {
    const label =
      roomLabel(room.id, sourceMeta, titles, sourceWorkspaceId) ??
      roomLabel(room.id, provisional, titles, sourceWorkspaceId);
    if (label) room.label = label;
  }

  // Skipped rooms keep the target's own Meta rows for their ids.
  const mergedMeta = Flock.fromFile(targetMetaBytes);
  await mergeFlockBytes(
    mergedMeta,
    metaBytes,
    metaPolicy(sourceWorkspaceId, workspaceId, withheldMetaIds(rooms))
  );
  const metaRows = diffFlock(targetMeta, mergedMeta);
  rooms.push({
    id: metaEntry.id,
    targetId: metaEntry.id,
    codec: metaEntry.codec,
    model: 'meta',
    kind: 'other',
    counted: false,
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

/** A readable name for a room, from the merged metadata or the bundled document. */
function roomLabel(
  roomId: string,
  meta: Flock,
  titles: ReadonlyMap<string, string>,
  sourceWorkspaceId: string
): string | undefined {
  const field = (docId: string, name: string) => {
    const value = meta.get(['m', docId, name]);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const docId = roomId.startsWith(ROOST_ROOM_PREFIX)
    ? roomId.slice(ROOST_ROOM_PREFIX.length)
    : roomId;
  const titled = titles.get(docId) ?? field(docId, 'title') ?? field(docId, 'name');
  if (titled) return titled;
  if (docId.startsWith('preview-comment-'))
    return field(`session-${docId.slice('preview-comment-'.length)}`, 'title');
  const machine = /^(?:.*:mf:|machine-)(.+)$/.exec(docId)?.[1];
  if (machine && (docId.startsWith('machine-') || docId.startsWith(`${sourceWorkspaceId}:mf:`)))
    return field(`machine-${machine}`, 'name');
  return undefined;
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
  // Roost turns are rewritten after Meta, which would otherwise restore the source backend.
  const rank = { loro: 0, flock: 1, meta: 2, roost: 3 } as const;
  return [...rooms].sort((a, b) => rank[a.model] - rank[b.model]);
}

const JournalHeaderSchema = z.object({
  version: z.literal(2),
  digest: z.string(),
  targetWorkspaceId: z.string(),
});

/** Header plus one line per merged room; a lost line only re-merges that room. */
async function readJournal(file: string, plan: ImportPlan): Promise<Set<string>> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await atomicJson(file, {
      version: 2,
      digest: plan.digest,
      targetWorkspaceId: plan.targetWorkspaceId,
    });
    return new Set();
  }
  const [header, ...lines] = text.split('\n');
  const parsed = JournalHeaderSchema.parse(JSON.parse(header ?? ''));
  if (parsed.digest !== plan.digest || parsed.targetWorkspaceId !== plan.targetWorkspaceId)
    throw new Error('Import journal belongs to another bundle or workspace');
  const done = new Set<string>();
  for (const line of lines) {
    try {
      const id = JSON.parse(line) as unknown;
      if (typeof id === 'string') done.add(id);
    } catch {
      // A torn last line is a room that was not recorded; it merges again.
    }
  }
  return done;
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

/** Merges the planned rooms; a rerun with the same bundle continues where it stopped. */
export async function applyWorkspaceImport(
  input: ApplyWorkspaceImportInput
): Promise<ImportResult> {
  const { plan, bundle, repo } = input;
  if (plan.digest !== bundle.manifest.digest)
    throw new Error('Import plan does not match this bundle');
  const crossWorkspace = plan.sourceWorkspaceId !== plan.targetWorkspaceId;
  const done = await readJournal(input.journalPath, plan);
  const entries = new Map(bundle.manifest.rooms.map((room) => [room.id, room]));
  const metaEntry = entries.get(META_ROOM_ID);
  if (!metaEntry) throw new Error('Bundle has no workspace metadata');
  const metaBytes = await bundle.readRoom(metaEntry);
  const sourceMeta = Flock.fromFile(metaBytes);
  const policy = metaPolicy(
    plan.sourceWorkspaceId,
    plan.targetWorkspaceId,
    withheldMetaIds(plan.rooms)
  );
  const result: ImportResult = { imported: 0, skipped: 0, resumed: 0 };
  const merges = plan.rooms.filter((room) => room.action === 'merge');
  result.skipped = plan.rooms.length - merges.length;
  let index = 0;
  for (const room of merges) {
    index += 1;
    if (done.has(room.id)) {
      result.resumed += 1;
      continue;
    }
    await input.checkContinue?.();
    const entry = entries.get(room.id);
    if (!entry) throw new Error(`Bundle room missing: ${room.id}`);
    const bytes = room.model === 'meta' ? metaBytes : await bundle.readRoom(entry);
    // Fences belong to the same unit as the merge, so a resumed import cannot skip them.
    // They cover what the bundle brings, also when the target already had the room.
    const fence = crossWorkspace && room.state !== 'unchanged';
    if (room.model === 'meta') {
      await mergeFlockBytes(repo.getMeta(), bytes, policy);
      await repo.persistMetaNow();
    } else if (room.model === 'loro') {
      await withDoc(repo, room.targetId, (doc) => doc.import(bytes));
      const importFence = fence
        ? await importFenceFor(room, bytes, sourceMeta, plan.targetWorkspaceId, input.actor)
        : undefined;
      if (importFence) {
        const previous = (await repo.getDocMeta(room.targetId))?.meta.importFence;
        await repo.upsertDocMeta(room.targetId, {
          importFence: mergeImportFence(previous, importFence),
        });
      }
    } else if (room.model === 'flock') {
      await withFlock(repo, room.targetId, (flock) =>
        mergeFlockBytes(flock, bytes, roomPolicy(room.codec, crossWorkspace))
      );
    } else {
      await rewriteRoostTurns(
        repo,
        room.targetId,
        bytes,
        fence ? plan.targetWorkspaceId : undefined
      );
    }
    await fs.appendFile(input.journalPath, `\n${JSON.stringify(room.id)}`);
    done.add(room.id);
    result.imported += 1;
    input.onProgress?.({ done: index, total: merges.length, roomId: room.targetId });
  }
  await writeImportReceipt(repo, plan, input.actor, input.now);
  return result;
}

/** The fence for what one bundle room brings, read from the bundle bytes alone. */
async function importFenceFor(
  room: RoomPlan,
  bytes: Uint8Array,
  sourceMeta: Flock,
  workspaceId: string,
  actor: { userId: string } | undefined
): Promise<ImportFence | undefined> {
  const incoming = new LoroDoc();
  incoming.import(bytes);
  if (room.codec === 'schedule/v1') return scheduleImportFence(incoming, workspaceId);
  if (room.codec !== 'session/v1') return undefined;
  return sessionImportFence(
    incoming,
    (field) => sourceMeta.get(['m', room.id, field]),
    workspaceId,
    actor?.userId
  );
}

/** A later import into the same workspace adds to a session fence; it never drops ids. */
function mergeImportFence(previous: unknown, next: ImportFence): ImportFence {
  if (!('turnIds' in next)) return next;
  const old = previous as Partial<SessionImportFence> | undefined;
  if (old?.workspaceId !== next.workspaceId) return next;
  const union = (a: unknown, b: readonly string[]) => [
    ...new Set([...(Array.isArray(a) ? (a as string[]) : []), ...b]),
  ];
  return {
    ...next,
    turnIds: union(old.turnIds, next.turnIds),
    queueItemIds: union(old.queueItemIds, next.queueItemIds),
  };
}

/** A row every member can see in the workspace catalog: who imported which bundle. */
async function writeImportReceipt(
  repo: LoroRepo<JsonObject>,
  plan: ImportPlan,
  actor: { userId: string } | undefined,
  now: (() => string) | undefined
): Promise<void> {
  if (!actor) return;
  await withFlock(repo, `${plan.targetWorkspaceId}:wf:workspace`, (flock) => {
    const key = ['importReceipt', plan.digest];
    if (flock.get(key) !== undefined) return;
    flock.put(key, {
      actorUserId: actor.userId,
      sourceWorkspaceId: plan.sourceWorkspaceId,
      digest: plan.digest,
      importedAt: (now ?? (() => new Date().toISOString()))(),
    });
  });
}

/** Rewrites exported Roost turns as Loro history and switches the session to Loro. */
async function rewriteRoostTurns(
  repo: LoroRepo<JsonObject>,
  docId: string,
  bytes: Uint8Array,
  fenceWorkspaceId: string | undefined
): Promise<void> {
  const turns = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  if (!Array.isArray(turns)) throw new Error(`Roost turns for ${docId} are malformed`);
  await withDoc(repo, docId, (doc) => {
    const mirror = createSessionMirror({ doc, initialState: {} });
    try {
      if (mirror.historyWriter.readStored().length === 0)
        mirror.historyWriter.update(() => turns as SessionHistoryInput[]);
    } finally {
      mirror.dispose();
    }
  });
  const patch: JsonObject = { historyBackend: 'loro' };
  if (fenceWorkspaceId) {
    // The rewritten turns came from the bundle too: extend the session's fence.
    const previous = (await repo.getDocMeta(docId))?.meta.importFence as
      | { turnIds?: string[]; queueItemIds?: string[]; importedBy?: string }
      | undefined;
    const userTurnIds = (turns as Array<{ id?: unknown; role?: unknown }>)
      .filter((turn) => turn.role === 'user' && typeof turn.id === 'string')
      .map((turn) => turn.id as string);
    patch.importFence = {
      ...previous,
      workspaceId: fenceWorkspaceId,
      turnIds: [...new Set([...(previous?.turnIds ?? []), ...userTurnIds])],
      queueItemIds: previous?.queueItemIds ?? [],
    };
  }
  await repo.upsertDocMeta(docId, patch);
}
