import { createHash } from 'crypto';
import { v4 as uuidV4 } from 'uuid';
import type { SessionInfo } from '@agentclientprotocol/sdk';
import { z } from 'zod';

import {
  type ACPSessionId,
  type ExternalAcpHistorySyncMeta,
  getMachineRoomId,
  type LocalProjectHistoryCatalogItem,
  type LocalProjectHistoryCatalogResult,
  type LocalProjectHistoryConflictResolveResult,
  type LocalProjectHistoryImportResult,
  type LocalProjectHistorySyncSummary,
  type LocalProjectHistoryProvider,
  type LocalProjectId,
  type MachineId,
  type SessionHistoryInput,
  type SessionExternalHistoryCursorDocState,
  type SessionMeta,
  type WorkspaceId,
  buildHistoryReplayImport,
  HistoryEntryWriteSchema,
  parseHistoryWrite,
  getExternalAcpHistoryImportKey,
  getLocalProjectHistoryProviderKey,
  getServerNow,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  isSessionDocRoomId,
  isActiveSessionStatus,
  isSessionHistoryPendingForDispatch,
  sanitizeLodyInternalInstructions,
  SessionStatusFactory,
  type ProjectRef,
  type SessionId,
} from '@lody/shared';

import type { LoroDocumentManager, SessionDocument } from '@/lib/loro/doc';
import { readMachineLocalProjects, upsertMachineLocalProject } from '@/lib/local-project-meta';
import {
  listHistorySessionsForLocalProject,
  loadHistorySessionReplay,
  MAX_LOCAL_PROJECT_HISTORY_CATALOG_SESSIONS,
} from './history-session-catalog-client';
import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';

const syncLeases = new Set<string>();

// In-process serializer for machineRoomId-scoped catalog writes. History rows
// are stored in machine Flock localProject entries, but each provider still does
// a read-modify-write for its nested catalog. Two concurrent providers operating
// on the same machine could otherwise clobber each other's history fields.
//
// Per-process only; cross-process races on the same machineRoomId remain
// possible but require simultaneous CLI processes for the same machine, which
// is not the normal mode of operation.
const machineCatalogWriteChains = new Map<string, Promise<unknown>>();

async function withMachineCatalogWriteLock<T>(
  machineRoomId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = machineCatalogWriteChains.get(machineRoomId);
  const current = (async () => {
    if (prev) {
      await prev.catch(() => {
        // swallow prior errors — they belong to other callers, not us
      });
    }
    return fn();
  })();
  machineCatalogWriteChains.set(machineRoomId, current);
  try {
    return await current;
  } finally {
    if (machineCatalogWriteChains.get(machineRoomId) === current) {
      machineCatalogWriteChains.delete(machineRoomId);
    }
  }
}

type ExistingHistorySession = {
  sessionId: SessionId;
  meta: SessionMeta;
};

export type MaterializedReplay = {
  history: SessionHistoryInput[];
  turnHashes: string[];
  replayDigest: string;
  droppedNotifications: number;
  /** Canonical-hash version `turnHashes`/`replayDigest` were computed with. */
  hashVersion: number;
};

type HistoryCatalogSnapshot = {
  sessions: SessionInfo[];
  existingByImportKey: Map<string, ExistingHistorySession>;
};

class HistoryRefreshConflict extends Error {}

export type HistoryRefreshDecision =
  | { status: 'skipped'; reason: 'digest_match' | 'empty_suffix'; appendFromIndex?: number }
  | { status: 'refreshed'; reason: 'prefix_append'; appendFromIndex: number }
  | {
      status: 'conflicted';
      reason: 'prefix_mismatch' | 'local_history_has_untracked_suffix';
    };

export type HistoryConflictResolutionDecision =
  | { status: 'replace' }
  | { status: 'already_resolved' }
  | {
      status: 'blocked';
      reason:
        | 'source_replay_empty'
        | 'source_replay_dropped_notifications'
        | 'source_replay_behind_import_cursor'
        | 'session_has_pending_local_turn'
        | 'not_sync_conflict';
    };

function emptySummary(): LocalProjectHistorySyncSummary {
  return {
    listed: 0,
    imported: 0,
    refreshed: 0,
    skipped: 0,
    conflicted: 0,
    failed: 0,
    failures: [],
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Canonical-hash versions. v1 hashed `{ role, items, plan }` verbatim; v2 hashes a
 * canonical item form so a sealed tool_call skeleton
 * (`{ type, kind, status, title?, locations?, ref }`) and the full tool_call shape it
 * was sealed from produce the same hash. A stored cursor without a `hashVersion` is v1,
 * written by a CLI that predates skeletons.
 */
export const HASH_VERSION_V1 = 1;
export const HASH_VERSION_V2 = 2;
/** Version new imports write. */
export const HASH_VERSION = HASH_VERSION_V2;

// Both stored legacy items and parsed new items are hashed as opaque content.
type HistoryHashInput = {
  role: SessionHistoryInput['role'];
  items?: readonly unknown[];
  plan?: readonly unknown[];
};

/** v1 (legacy) hash input: only the parts of an entry that come from the source transcript. */
function normalizeHistoryEntryForHash(entry: HistoryHashInput): unknown {
  return {
    role: entry.role,
    items: entry.items ?? [],
    plan: entry.plan ?? [],
  };
}

export function hashHistoryEntry(entry: HistoryHashInput): string {
  return hashText(stableJson(normalizeHistoryEntryForHash(entry)));
}

/**
 * Keys stripped from every item in the v2 canonical form. These are either
 * import-time/runtime-only annotations or fields a sealed tool_call skeleton omits, so
 * hashing them would make the same transcript hash differently once its turns are sealed.
 */
const VOLATILE_ITEM_KEYS_V2: ReadonlySet<string> = new Set([
  'toolCallId',
  'content',
  'rawInput',
  'rawOutput',
  'ref',
  'activityKind',
  'permissionRequest',
  'toolName',
  'schedulingTimeZone',
  'turnId',
  'isLatest',
  'startedAt',
  'endedAt',
  'startedAtEpochSeconds',
  'endedAtEpochSeconds',
]);

const isHashRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * v2 canonical form of a tool_call item: exactly the fields a sealed skeleton keeps,
 * minus `ref`. `title: null` (ACP "no title") is treated as absent so null, undefined and
 * missing hash identically.
 */
function canonicalizeToolCallItemForHashV2(item: Record<string, unknown>): Record<string, unknown> {
  const canonical: Record<string, unknown> = { type: 'tool_call' };
  if (typeof item.title === 'string') canonical.title = item.title;
  if (item.kind !== undefined) canonical.kind = item.kind;
  if (item.status !== undefined) canonical.status = item.status;
  if (item.locations !== undefined) canonical.locations = item.locations;
  return canonical;
}

function canonicalizeItemForHashV2(item: unknown): unknown {
  if (!isHashRecord(item)) return item;
  if (item.type === 'text' || item.type === 'thought') {
    // `spans` are mention regions derived from `text`; they add no transcript content.
    return { type: item.type, text: item.text };
  }
  if (item.type === 'tool_call') return canonicalizeToolCallItemForHashV2(item);
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(item)) {
    if (VOLATILE_ITEM_KEYS_V2.has(key) || item[key] === undefined) continue;
    canonical[key] = item[key];
  }
  return canonical;
}

/** v2 counterpart of the v1 normalizer: same entry shape, each item canonicalized. */
function normalizeHistoryEntryForHashV2(entry: HistoryHashInput): unknown {
  return {
    role: entry.role,
    items: (entry.items ?? []).map(canonicalizeItemForHashV2),
    plan: entry.plan ?? [],
  };
}

export function hashHistoryEntryV2(entry: HistoryHashInput): string {
  return hashText(stableJson(normalizeHistoryEntryForHashV2(entry)));
}

/**
 * Hash one entry with an explicit canonical version. Used when comparing a new replay
 * against a stored cursor written by an older CLI, so an upgrade never looks like a
 * conflict.
 */
export function hashHistoryEntryForVersion(entry: HistoryHashInput, version: number): string {
  if (version === HASH_VERSION_V1) return hashHistoryEntry(entry);
  if (version === HASH_VERSION_V2) return hashHistoryEntryV2(entry);
  throw new Error(`Unsupported history hash version: ${version}`);
}

/** Cursors written before the field existed are v1. */
export function resolveStoredHashVersion(source: { hashVersion?: number } | undefined): number {
  return source?.hashVersion ?? HASH_VERSION_V1;
}

export function materializeReplay(args: {
  provider: LocalProjectHistoryProvider;
  acpSessionId: ACPSessionId;
  replayNotifications: Parameters<typeof buildHistoryReplayImport>[0];
  userId: string;
}): MaterializedReplay {
  let tempId = 0;
  const nowIso = new Date(getServerNow()).toISOString();
  const providerKey = getLocalProjectHistoryProviderKey(args.provider);
  const replay = buildHistoryReplayImport(args.replayNotifications, {
    provider: args.provider,
    acpSessionId: args.acpSessionId,
    userId: args.userId,
    now: () => nowIso,
    createId: () => `${providerKey}:${args.acpSessionId}:tmp:${tempId++}`,
    mode: 'imported_snapshot',
  });
  const turnHashes = replay.history.map(hashHistoryEntryV2);
  const history = replay.history.map((entry, index) => ({
    ...entry,
    id: `${providerKey}:${args.acpSessionId}:turn:${index}:${turnHashes[index]!.slice(0, 16)}`,
  }));

  return {
    history,
    turnHashes,
    replayDigest: hashText(turnHashes.join('\n')),
    droppedNotifications: replay.droppedNotifications,
    hashVersion: HASH_VERSION,
  };
}

function isPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  if (prefix.length > value.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] !== value[index]) {
      return false;
    }
  }
  return true;
}

function resolveImportedTurnHashes(
  externalHistory: ExternalAcpHistorySyncMeta,
  importedTurnHashes?: readonly string[]
): readonly string[] {
  return importedTurnHashes ?? externalHistory.importedTurnHashes ?? [];
}

const StoredHistoryBaselineSchema = z.object({
  version: z.literal(1),
  // Absent on baselines written before hash versions; those are v1 and must not be
  // interpreted against a v2 source.
  hashVersion: z.number().optional(),
  sourceDigest: z.string(),
  turnHashes: z.array(z.string()),
});

function storedBaselineHashes(
  cursor: SessionExternalHistoryCursorDocState | undefined,
  sourceHashes: readonly string[]
): readonly string[] {
  // Old clients may advance only source hashes, leaving the new field stale.
  // Never interpret that stale baseline against the independently changing meta digest.
  if (cursor?.storedHistoryBaseline && cursor.importedTurnHashes) {
    try {
      const parsed = StoredHistoryBaselineSchema.safeParse(
        JSON.parse(cursor.storedHistoryBaseline)
      );
      if (
        parsed.success &&
        parsed.data.hashVersion === resolveStoredHashVersion(cursor) &&
        areStringArraysEqual(cursor.importedTurnHashes, sourceHashes) &&
        parsed.data.sourceDigest === hashText(sourceHashes.join('\n')) &&
        parsed.data.turnHashes.length === sourceHashes.length
      )
        return parsed.data.turnHashes;
    } catch {
      // Unknown/corrupt baseline falls back to exact legacy comparison, never sanitization.
    }
  }
  return sourceHashes;
}

function createImportCursor(
  sourceHashes: readonly string[],
  stored: readonly SessionHistoryInput[],
  hashVersion: number
): SessionExternalHistoryCursorDocState {
  return {
    importedTurnHashes: [...sourceHashes],
    hashVersion,
    storedHistoryBaseline: JSON.stringify({
      version: 1,
      hashVersion,
      sourceDigest: hashText(sourceHashes.join('\n')),
      turnHashes: stored.map((entry) => hashHistoryEntryForVersion(entry, hashVersion)),
    } satisfies z.infer<typeof StoredHistoryBaselineSchema>),
  };
}

/**
 * Subset of a materialized replay the decisions need to recompute hashes in the stored
 * cursor's version. `hashVersion` may be absent in legacy fixtures; absent means "already
 * in the stored version" (no recomputation).
 */
export type MaterializedReplayHashSource = Pick<MaterializedReplay, 'history'> & {
  hashVersion?: number;
};

/**
 * Express a replay's digest/turn hashes in an explicit canonical version. When the replay
 * was materialized with a newer canonical form than the stored cursor (a v1 cursor from an
 * older CLI versus a v2 replay), the stored-version hashes are recomputed from the replay
 * history so an upgrade never produces a false conflict. Recomputation changes hashes but
 * never the turn count, so `appendFromIndex` still indexes the materialized history.
 */
function resolveReplayHashesForStoredVersion(args: {
  replayDigest: string;
  turnHashes: readonly string[];
  replayHashVersion: number;
  storedHashVersion: number;
  replayHistory?: readonly SessionHistoryInput[];
}): { replayDigest: string; turnHashes: readonly string[] } {
  if (args.replayHashVersion === args.storedHashVersion) {
    return { replayDigest: args.replayDigest, turnHashes: args.turnHashes };
  }
  if (!args.replayHistory) {
    throw new Error(
      'History decisions need the materialized replay history to compare a ' +
        `v${args.replayHashVersion} replay against a v${args.storedHashVersion} stored cursor.`
    );
  }
  const turnHashes = args.replayHistory.map((entry) =>
    hashHistoryEntryForVersion(entry, args.storedHashVersion)
  );
  return { replayDigest: hashText(turnHashes.join('\n')), turnHashes };
}

export function decideHistoryRefresh(args: {
  externalHistory: ExternalAcpHistorySyncMeta;
  /**
   * Stored cursor hashes. Pass their own version alongside them when the hashes come from
   * the session doc rather than the sync metadata.
   */
  importedTurnHashes?: readonly string[];
  /** Version paired with the explicit cursor hashes; metadata may advance separately. */
  importedTurnHashVersion?: number;
  replayDigest: string;
  turnHashes: readonly string[];
  /**
   * The materialized replay `replayDigest`/`turnHashes` came from. Pass it whenever the
   * replay's `hashVersion` may differ from the stored cursor's version.
   */
  materialized?: MaterializedReplayHashSource;
  /**
   * Version of `replayDigest`/`turnHashes`. Defaults to `materialized.hashVersion`, or to
   * the stored version when no materialized replay is passed (legacy callers compared
   * same-version hashes).
   */
  replayHashVersion?: number;
  /**
   * Hashes of the locally stored turns. Callers must compute these with the STORED hash
   * version, since they are compared against stored-version replay hashes here.
   */
  currentHistoryHashes?: readonly string[];
  storedHistoryHashes?: readonly string[];
  projectedTurnHashes?: readonly string[];
}): HistoryRefreshDecision {
  const metadataHashVersion = resolveStoredHashVersion(args.externalHistory);
  const storedHashVersion = args.importedTurnHashVersion ?? metadataHashVersion;
  const replay = resolveReplayHashesForStoredVersion({
    replayDigest: args.replayDigest,
    turnHashes: args.turnHashes,
    replayHashVersion:
      args.replayHashVersion ?? args.materialized?.hashVersion ?? storedHashVersion,
    storedHashVersion,
    replayHistory: args.materialized?.history,
  });
  // The metadata digest is paired with the metadata's own version, which may have advanced
  // independently of the doc cursor.
  const metadataReplay =
    metadataHashVersion === storedHashVersion
      ? replay
      : resolveReplayHashesForStoredVersion({
          replayDigest: args.replayDigest,
          turnHashes: args.turnHashes,
          replayHashVersion:
            args.replayHashVersion ?? args.materialized?.hashVersion ?? metadataHashVersion,
          storedHashVersion: metadataHashVersion,
          replayHistory: args.materialized?.history,
        });
  if (
    !args.currentHistoryHashes &&
    metadataReplay.replayDigest === args.externalHistory.replayDigest
  ) {
    return { status: 'skipped', reason: 'digest_match' };
  }

  const importedTurnHashes = resolveImportedTurnHashes(
    args.externalHistory,
    args.importedTurnHashes
  );
  if (!isPrefix(importedTurnHashes, replay.turnHashes)) {
    return { status: 'conflicted', reason: 'prefix_mismatch' };
  }

  if (args.currentHistoryHashes) {
    const appendFromIndex = args.currentHistoryHashes.length;
    // A caller-supplied projection is already expressed in the stored version. Default to
    // the same-version replay hashes (identity when versions match).
    const projectedTurnHashes = args.projectedTurnHashes ?? replay.turnHashes;
    const expected = args.storedHistoryHashes
      ? [...args.storedHistoryHashes, ...projectedTurnHashes.slice(importedTurnHashes.length)]
      : projectedTurnHashes;
    if (
      args.currentHistoryHashes.length < importedTurnHashes.length ||
      !isPrefix(args.currentHistoryHashes, expected)
    ) {
      return { status: 'conflicted', reason: 'local_history_has_untracked_suffix' };
    }
    return replay.turnHashes.length > appendFromIndex
      ? { status: 'refreshed', reason: 'prefix_append', appendFromIndex }
      : { status: 'skipped', reason: 'empty_suffix', appendFromIndex };
  }

  const appendFromIndex = args.externalHistory.importedTurnCount;
  return replay.turnHashes.length > appendFromIndex
    ? { status: 'refreshed', reason: 'prefix_append', appendFromIndex }
    : { status: 'skipped', reason: 'empty_suffix', appendFromIndex };
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && isPrefix(left, right);
}

async function readSessionImportedTurnHashes(
  sessionDoc: SessionDocument,
  externalHistory: ExternalAcpHistorySyncMeta
): Promise<{ importedTurnHashes: readonly string[]; importedTurnHashVersion: number }> {
  const cursor = await sessionDoc.getExternalHistoryCursor();
  return {
    importedTurnHashes: resolveImportedTurnHashes(externalHistory, cursor?.importedTurnHashes),
    importedTurnHashVersion: resolveStoredHashVersion(
      cursor?.importedTurnHashes !== undefined ? cursor : externalHistory
    ),
  };
}

/** Hash locally stored turns in the version of the stored sync cursor. */
function hashHistoryForStoredVersion(
  history: readonly SessionHistoryInput[],
  hashVersion: number
): string[] {
  return history.map((entry) => hashHistoryEntryForVersion(entry, hashVersion));
}

function hasPendingDispatchHistory(history: readonly SessionHistoryInput[]): boolean {
  return history.some((entry) => isSessionHistoryPendingForDispatch(entry));
}

export function decideHistoryConflictResolution(args: {
  externalHistory: ExternalAcpHistorySyncMeta;
  /** Stored cursor hashes, paired with importedTurnHashVersion when supplied. */
  importedTurnHashes?: readonly string[];
  /** Version paired with the explicit cursor hashes; metadata may advance separately. */
  importedTurnHashVersion?: number;
  materialized: Pick<
    MaterializedReplay,
    'history' | 'turnHashes' | 'replayDigest' | 'droppedNotifications'
  > & {
    /**
     * Version of `turnHashes`/`replayDigest`. Absent means "already in the stored
     * version" (legacy callers); a real `MaterializedReplay` always carries it.
     */
    hashVersion?: number;
  };
  currentHistoryHashes: readonly string[];
  storedHistoryHashes?: readonly string[];
  currentHistoryHasPendingDispatch: boolean;
}): HistoryConflictResolutionDecision {
  if (args.currentHistoryHasPendingDispatch) {
    return { status: 'blocked', reason: 'session_has_pending_local_turn' };
  }

  const metadataHashVersion = resolveStoredHashVersion(args.externalHistory);
  const storedHashVersion = args.importedTurnHashVersion ?? metadataHashVersion;
  const replay = resolveReplayHashesForStoredVersion({
    replayDigest: args.materialized.replayDigest,
    turnHashes: args.materialized.turnHashes,
    replayHashVersion: args.materialized.hashVersion ?? storedHashVersion,
    storedHashVersion,
    replayHistory: args.materialized.history,
  });
  // `markConflict` advances only the metadata; compare its digest in its own version so a
  // v1 doc cursor is not misread as v2.
  const metadataReplay =
    metadataHashVersion === storedHashVersion
      ? replay
      : resolveReplayHashesForStoredVersion({
          replayDigest: args.materialized.replayDigest,
          turnHashes: args.materialized.turnHashes,
          replayHashVersion: args.materialized.hashVersion ?? metadataHashVersion,
          storedHashVersion: metadataHashVersion,
          replayHistory: args.materialized.history,
        });

  const importedTurnHashes = resolveImportedTurnHashes(
    args.externalHistory,
    args.importedTurnHashes
  );
  const alreadyResolved =
    args.externalHistory.status !== 'sync_conflict' &&
    (areStringArraysEqual(
      args.currentHistoryHashes,
      args.storedHistoryHashes ?? importedTurnHashes
    ) ||
      (!args.storedHistoryHashes &&
        args.externalHistory.replayDigest === metadataReplay.replayDigest &&
        areStringArraysEqual(args.currentHistoryHashes, replay.turnHashes)));
  if (alreadyResolved) {
    return { status: 'already_resolved' };
  }

  if (args.externalHistory.status !== 'sync_conflict') {
    return { status: 'blocked', reason: 'not_sync_conflict' };
  }

  if (args.materialized.droppedNotifications > 0) {
    return { status: 'blocked', reason: 'source_replay_dropped_notifications' };
  }

  if (args.materialized.history.length === 0) {
    return { status: 'blocked', reason: 'source_replay_empty' };
  }

  if (replay.turnHashes.length < importedTurnHashes.length) {
    return { status: 'blocked', reason: 'source_replay_behind_import_cursor' };
  }

  return { status: 'replace' };
}

function formatHistoryConflictResolutionBlocker(
  decision: Extract<HistoryConflictResolutionDecision, { status: 'blocked' }>
): string {
  switch (decision.reason) {
    case 'source_replay_empty':
      return 'Cannot replace history because the latest source replay produced no turns.';
    case 'source_replay_dropped_notifications':
      return 'Cannot replace history because the latest source replay contains unsupported or malformed notifications.';
    case 'source_replay_behind_import_cursor':
      return 'Cannot replace history because the latest source replay is shorter than the last imported cursor.';
    case 'session_has_pending_local_turn':
      return 'Cannot replace history while the imported session has a pending local turn.';
    case 'not_sync_conflict':
      return 'Only sessions currently marked as history sync conflicts can be re-imported.';
  }
  return 'Cannot replace history because the conflict resolution state is invalid.';
}

async function listWorkspaceSessionMetas(
  manager: LoroDocumentManager
): Promise<Array<{ sessionId: SessionId; meta: SessionMeta }>> {
  const scanner = manager.repo.getMeta();
  if (!scanner) {
    return [];
  }

  const roomIds = new Set<string>();
  for (const row of await scanner.scan({ prefix: ['m'] })) {
    const key = row.key;
    if (!Array.isArray(key) || key.length < 2) {
      continue;
    }
    const roomId = key[1];
    if (typeof roomId === 'string' && isSessionDocRoomId(roomId)) {
      roomIds.add(roomId);
    }
  }

  const metas = await Promise.all(
    [...roomIds].map(async (roomId) => {
      const record = await manager.repo.getDocMeta(roomId);
      if (!record?.meta || isLoroRepoDocDeleted(record)) {
        return null;
      }
      const sessionId = roomId.slice('session-'.length) as SessionId;
      return { sessionId, meta: record.meta as SessionMeta };
    })
  );
  return metas.filter((meta): meta is { sessionId: SessionId; meta: SessionMeta } => meta !== null);
}

export function buildExistingHistorySessionIndex(
  metas: Array<{ sessionId: SessionId; meta: SessionMeta }>,
  machineId: MachineId,
  provider: LocalProjectHistoryProvider,
  localProjectId: LocalProjectId
): Map<string, ExistingHistorySession> {
  const index = new Map<string, ExistingHistorySession>();
  const providerKey = getLocalProjectHistoryProviderKey(provider);
  const sortedMetas = [...metas].sort((left, right) => {
    const leftCreatedAt = Date.parse(left.meta.createdAt);
    const rightCreatedAt = Date.parse(right.meta.createdAt);
    const createdAtDiff =
      (Number.isFinite(leftCreatedAt) ? leftCreatedAt : 0) -
      (Number.isFinite(rightCreatedAt) ? rightCreatedAt : 0);
    if (createdAtDiff !== 0) return createdAtDiff;
    return left.sessionId.localeCompare(right.sessionId);
  });
  for (const entry of sortedMetas) {
    if (entry.meta.machineId !== machineId) continue;
    if (entry.meta.cliType !== provider.cliType) continue;
    if (entry.meta.agentType !== provider.agentType) continue;
    if (entry.meta.project?.kind !== 'local') continue;
    if (entry.meta.project.localProjectId !== localProjectId) continue;
    const acpSessionIds = new Set<string>();
    if (
      entry.meta.externalHistory &&
      getLocalProjectHistoryProviderKey(entry.meta.externalHistory.provider) === providerKey
    ) {
      const sourceAcpSessionId = entry.meta.externalHistory.sourceAcpSessionId;
      if (sourceAcpSessionId) {
        acpSessionIds.add(sourceAcpSessionId);
      }
      if (entry.meta.acpSessionId && entry.meta.acpSessionId !== sourceAcpSessionId) {
        acpSessionIds.add(entry.meta.acpSessionId);
      }
    } else if (entry.meta.acpSessionId) {
      acpSessionIds.add(entry.meta.acpSessionId);
    }
    for (const acpSessionId of acpSessionIds) {
      const importKey = getExternalAcpHistoryImportKey({
        machineId,
        localProjectId,
        provider,
        sourceAcpSessionId: acpSessionId,
      });
      if (!index.has(importKey)) {
        index.set(importKey, entry);
      }
    }
  }
  return index;
}

function getProviderLabel(provider: LocalProjectHistoryProvider): string {
  return getLocalProjectHistoryProviderKey(provider);
}

function getHistoryImportKey(args: {
  machineId: MachineId;
  localProjectId: LocalProjectId;
  provider: LocalProjectHistoryProvider;
  acpSessionId: string;
}): string {
  return getExternalAcpHistoryImportKey({
    machineId: args.machineId,
    localProjectId: args.localProjectId,
    provider: args.provider,
    sourceAcpSessionId: args.acpSessionId,
  });
}

const MAX_IMPORTED_SESSION_TITLE_CHARS = 80;

function resolveSessionTitle(info: SessionInfo, provider: LocalProjectHistoryProvider): string {
  // Provider titles are usually derived from the first recorded user message,
  // which can carry Lody-appended instruction tails.
  const cleaned = info.title?.trim() ? sanitizeLodyInternalInstructions(info.title) : '';
  const title = cleaned.replace(/\s+/g, ' ').trim().slice(0, MAX_IMPORTED_SESSION_TITLE_CHARS);
  return title || `${getProviderLabel(provider)} session`;
}

function parseUpdatedAtMs(updatedAt: string | undefined): number {
  if (!updatedAt) return 0;
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Exported only for unit tests; do not call from outside this module.
export function compareCatalogItems(
  left: LocalProjectHistoryCatalogItem,
  right: LocalProjectHistoryCatalogItem
): number {
  const leftUpdatedAt = parseUpdatedAtMs(left.updatedAt);
  const rightUpdatedAt = parseUpdatedAtMs(right.updatedAt);
  if (leftUpdatedAt !== rightUpdatedAt) {
    return rightUpdatedAt - leftUpdatedAt;
  }
  return left.title.localeCompare(right.title);
}

export function selectLatestCatalogItems(
  items: readonly LocalProjectHistoryCatalogItem[]
): LocalProjectHistoryCatalogItem[] {
  return [...items].sort(compareCatalogItems).slice(0, MAX_LOCAL_PROJECT_HISTORY_CATALOG_SESSIONS);
}

export function getHistoryCatalogStatus(existing?: {
  meta: SessionMeta;
}): LocalProjectHistoryCatalogItem['status'] {
  if (!existing) return 'available';
  if (existing.meta.externalHistory?.status === 'metadata_only') return 'available';
  return existing.meta.externalHistory?.status === 'sync_conflict' ? 'sync_conflict' : 'imported';
}

function buildCatalogItem(
  provider: LocalProjectHistoryProvider,
  info: SessionInfo,
  existing?: ExistingHistorySession
): LocalProjectHistoryCatalogItem {
  const acpSessionId = info.sessionId;
  return {
    acpSessionId,
    title: resolveSessionTitle(info, provider),
    updatedAt: info.updatedAt ?? undefined,
    importedSessionId: existing?.sessionId,
    status: getHistoryCatalogStatus(existing),
  };
}

function shouldSkipBySourceUpdatedAt(
  info: SessionInfo,
  externalHistory: ExternalAcpHistorySyncMeta
): boolean {
  if (externalHistory.status === 'metadata_only') {
    return false;
  }
  if (!info.updatedAt || !externalHistory.sourceUpdatedAt) {
    return false;
  }
  const next = Date.parse(info.updatedAt);
  const current = Date.parse(externalHistory.sourceUpdatedAt);
  return Number.isFinite(next) && Number.isFinite(current) && next <= current;
}

function resolveSourceUpdatedAtMs(info: SessionInfo, fallback: number): number {
  if (!info.updatedAt) {
    return fallback;
  }
  const parsed = Date.parse(info.updatedAt);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildExternalHistoryMeta(args: {
  provider: LocalProjectHistoryProvider;
  sourceAcpSessionId: ACPSessionId;
  sourceUpdatedAt?: string | null;
  materialized: MaterializedReplay;
  status?: ExternalAcpHistorySyncMeta['status'];
  conflictReason?: string;
}): ExternalAcpHistorySyncMeta {
  return {
    provider: args.provider,
    source: 'local-acp-history',
    sourceAcpSessionId: args.sourceAcpSessionId,
    sourceUpdatedAt: args.sourceUpdatedAt ?? undefined,
    replayDigest: args.materialized.replayDigest,
    // Versions the digest only. The doc cursor versions its own importedTurnHashes.
    hashVersion: args.materialized.hashVersion,
    importedTurnCount: args.materialized.turnHashes.length,
    lastSyncAt: getServerNow(),
    status: args.status ?? 'synced',
    conflictReason: args.conflictReason,
  };
}

export class LocalProjectHistorySyncService {
  private readonly provider: LocalProjectHistoryProvider;
  private readonly providerKey: string;

  constructor(
    private readonly manager: LoroDocumentManager,
    private readonly logger: Logger,
    private readonly context: {
      workspaceId: WorkspaceId;
      machineId: MachineId;
      userId: string;
    },
    provider: LocalProjectHistoryProvider
  ) {
    this.provider = provider;
    this.providerKey = getLocalProjectHistoryProviderKey(provider);
  }

  async syncLocalProject(args: {
    localProjectId: LocalProjectId;
    rootPath: string;
  }): Promise<LocalProjectHistoryCatalogResult> {
    const leaseKey =
      `${this.providerKey}:${this.context.workspaceId}:` +
      `${this.context.machineId}:${args.localProjectId}`;
    if (syncLeases.has(leaseKey)) {
      throw new Error(
        `${getProviderLabel(this.provider)} history sync is already running for this local project`
      );
    }
    syncLeases.add(leaseKey);
    try {
      return await this.syncLocalProjectInner(args);
    } finally {
      syncLeases.delete(leaseKey);
    }
  }

  private async syncLocalProjectInner(args: {
    localProjectId: LocalProjectId;
    rootPath: string;
  }): Promise<LocalProjectHistoryCatalogResult> {
    const snapshot = await this.listCatalogSnapshot(args);
    return await this.writeCatalogResult({
      localProjectId: args.localProjectId,
      sessions: snapshot.sessions,
      existingByImportKey: snapshot.existingByImportKey,
    });
  }

  async importLocalProjectSessions(args: {
    localProjectId: LocalProjectId;
    rootPath: string;
    acpSessionIds: string[];
  }): Promise<LocalProjectHistoryImportResult> {
    const leaseKey =
      `${this.providerKey}:${this.context.workspaceId}:` +
      `${this.context.machineId}:${args.localProjectId}`;
    if (syncLeases.has(leaseKey)) {
      throw new Error(
        `${getProviderLabel(this.provider)} history sync is already running for this local project`
      );
    }
    syncLeases.add(leaseKey);
    try {
      return await this.importLocalProjectSessionsInner(args);
    } finally {
      syncLeases.delete(leaseKey);
    }
  }

  async resolveHistoryConflict(args: {
    localProjectId: LocalProjectId;
    rootPath: string;
    sessionId: SessionId;
    acpSessionId: string;
  }): Promise<LocalProjectHistoryConflictResolveResult> {
    const leaseKey =
      `${this.providerKey}:${this.context.workspaceId}:` +
      `${this.context.machineId}:${args.localProjectId}`;
    if (syncLeases.has(leaseKey)) {
      throw new Error(
        `${getProviderLabel(this.provider)} history sync is already running for this local project`
      );
    }
    syncLeases.add(leaseKey);
    try {
      return await this.resolveHistoryConflictInner(args);
    } finally {
      syncLeases.delete(leaseKey);
    }
  }

  private async importLocalProjectSessionsInner(args: {
    localProjectId: LocalProjectId;
    rootPath: string;
    acpSessionIds: string[];
  }): Promise<LocalProjectHistoryImportResult> {
    const summary = emptySummary();
    const selectedIds = [...new Set(args.acpSessionIds)];
    summary.listed = selectedIds.length;
    const snapshot = await this.listCatalogSnapshot({
      ...args,
      requiredSessionIds: selectedIds,
    });
    const infoByAcpSessionId = new Map(snapshot.sessions.map((info) => [info.sessionId, info]));
    const project: ProjectRef = { kind: 'local', localProjectId: args.localProjectId };

    for (const selectedId of selectedIds) {
      const acpSessionId = selectedId as unknown as ACPSessionId;
      const info = infoByAcpSessionId.get(selectedId);
      try {
        if (!info) {
          throw new Error(
            `${getProviderLabel(this.provider)} session was not found in the local project catalog`
          );
        }

        const importKey = getHistoryImportKey({
          machineId: this.context.machineId,
          localProjectId: args.localProjectId,
          provider: this.provider,
          acpSessionId: selectedId,
        });
        const existing =
          (await this.findExistingHistorySession(args.localProjectId, selectedId)) ??
          snapshot.existingByImportKey.get(importKey);
        if (!existing) {
          const replayNotifications = await loadHistorySessionReplay({
            provider: this.provider,
            rootPath: args.rootPath,
            acpSessionId,
            logger: this.logger,
          });
          const materialized = materializeReplay({
            provider: this.provider,
            acpSessionId,
            replayNotifications,
            userId: this.context.userId,
          });
          const importedSession = await this.importNewSession({
            info,
            acpSessionId,
            project,
            materialized,
          });
          snapshot.existingByImportKey.set(importKey, importedSession);
          summary.imported += 1;
          continue;
        }

        snapshot.existingByImportKey.set(importKey, existing);
        const status = await this.refreshExistingSession({
          existing,
          info,
          acpSessionId,
          rootPath: args.rootPath,
        });
        summary[status] += 1;
      } catch (error) {
        summary.failed += 1;
        summary.failures.push({
          acpSessionId,
          message: formatErrorMessage(error),
        });
        this.logger.warn(
          `[${this.providerKey}-history-sync] Failed to import ${getProviderLabel(
            this.provider
          )} session ${acpSessionId}: ${formatErrorMessage(error)}`
        );
      }
    }

    const catalog = await this.writeCatalogResult({
      localProjectId: args.localProjectId,
      sessions: snapshot.sessions,
      existingByImportKey: snapshot.existingByImportKey,
    });
    return { summary, catalog };
  }

  private async resolveHistoryConflictInner(args: {
    localProjectId: LocalProjectId;
    rootPath: string;
    sessionId: SessionId;
    acpSessionId: string;
  }): Promise<LocalProjectHistoryConflictResolveResult> {
    const snapshot = await this.listCatalogSnapshot({
      ...args,
      requiredSessionIds: [args.acpSessionId],
    });
    const info = snapshot.sessions.find((session) => session.sessionId === args.acpSessionId);
    if (!info) {
      throw new Error(
        `${getProviderLabel(this.provider)} session was not found in the local project catalog`
      );
    }

    const importKey = getHistoryImportKey({
      machineId: this.context.machineId,
      localProjectId: args.localProjectId,
      provider: this.provider,
      acpSessionId: args.acpSessionId,
    });
    const finishResolved = async (
      meta: SessionMeta
    ): Promise<LocalProjectHistoryConflictResolveResult> => {
      snapshot.existingByImportKey.set(importKey, { sessionId: args.sessionId, meta });
      const catalog = await this.writeCatalogResult({
        localProjectId: args.localProjectId,
        sessions: snapshot.sessions,
        existingByImportKey: snapshot.existingByImportKey,
      });
      return {
        sessionId: args.sessionId,
        acpSessionId: args.acpSessionId,
        status: 'resolved',
        catalog,
      };
    };
    const indexedExisting = snapshot.existingByImportKey.get(importKey);
    if (!indexedExisting || indexedExisting.sessionId !== args.sessionId) {
      throw new Error('Imported session no longer matches the selected ACP history session.');
    }

    const roomId = getSessionRoomId(args.sessionId);
    const record = await this.manager.repo.getDocMeta(roomId);
    if (!record?.meta || isLoroRepoDocDeleted(record)) {
      throw new Error('Imported session was deleted.');
    }
    const meta = record.meta as SessionMeta;
    if (!this.isMatchingHistorySession(meta, args.localProjectId, args.acpSessionId)) {
      throw new Error('Imported session metadata no longer matches the selected ACP history.');
    }
    if (isActiveSessionStatus(meta.status)) {
      throw new Error('Cannot replace history while the imported session is active.');
    }

    const sessionDoc = await this.manager.getOrCreateSessionDoc(args.sessionId);
    const currentHistoryBeforeReplay = await sessionDoc.getHistory();
    if (hasPendingDispatchHistory(currentHistoryBeforeReplay)) {
      throw new Error(
        'Cannot replace history while the imported session has a pending local turn.'
      );
    }
    const existingExternalHistory = meta.externalHistory;
    if (!existingExternalHistory) {
      throw new Error('Imported session metadata no longer matches the selected ACP history.');
    }
    if (existingExternalHistory.status !== 'sync_conflict') {
      const cursor = await sessionDoc.getExternalHistoryCursor();
      const { importedTurnHashes, importedTurnHashVersion } = await readSessionImportedTurnHashes(
        sessionDoc,
        existingExternalHistory
      );
      if (
        areStringArraysEqual(
          hashHistoryForStoredVersion(currentHistoryBeforeReplay, importedTurnHashVersion),
          storedBaselineHashes(cursor, importedTurnHashes)
        )
      ) {
        return finishResolved(meta);
      }
      throw new Error(
        formatHistoryConflictResolutionBlocker({
          status: 'blocked',
          reason: 'not_sync_conflict',
        })
      );
    }

    const acpSessionId = args.acpSessionId as unknown as ACPSessionId;
    const replayNotifications = await loadHistorySessionReplay({
      provider: this.provider,
      rootPath: args.rootPath,
      acpSessionId,
      logger: this.logger,
    });
    const materialized = materializeReplay({
      provider: this.provider,
      acpSessionId,
      replayNotifications,
      userId: this.context.userId,
    });

    const latestRecord = await this.manager.repo.getDocMeta(roomId);
    if (!latestRecord?.meta || isLoroRepoDocDeleted(latestRecord)) {
      throw new Error('Imported session was deleted.');
    }
    const latestMeta = latestRecord.meta as SessionMeta;
    if (!this.isMatchingHistorySession(latestMeta, args.localProjectId, args.acpSessionId)) {
      throw new Error('Imported session metadata no longer matches the selected ACP history.');
    }
    if (isActiveSessionStatus(latestMeta.status)) {
      throw new Error('Cannot replace history while the imported session is active.');
    }
    const latestExternalHistory = latestMeta.externalHistory;
    if (!latestExternalHistory) {
      throw new Error('Imported session metadata no longer matches the selected ACP history.');
    }

    const {
      importedTurnHashes: latestImportedTurnHashes,
      importedTurnHashVersion: latestImportedTurnHashVersion,
    } = await readSessionImportedTurnHashes(sessionDoc, latestExternalHistory);
    const latestCursor = await sessionDoc.getExternalHistoryCursor();
    const latestHistory = await sessionDoc.getHistory();
    const decision = decideHistoryConflictResolution({
      externalHistory: latestExternalHistory,
      importedTurnHashes: latestImportedTurnHashes,
      importedTurnHashVersion: latestImportedTurnHashVersion,
      materialized,
      currentHistoryHashes: hashHistoryForStoredVersion(
        latestHistory,
        latestImportedTurnHashVersion
      ),
      storedHistoryHashes: storedBaselineHashes(latestCursor, latestImportedTurnHashes),
      currentHistoryHasPendingDispatch: hasPendingDispatchHistory(latestHistory),
    });
    if (decision.status === 'blocked') {
      throw new Error(formatHistoryConflictResolutionBlocker(decision));
    }
    if (decision.status === 'already_resolved') {
      return finishResolved(latestMeta);
    }

    const nextExternalHistory = buildExternalHistoryMeta({
      provider: this.provider,
      sourceAcpSessionId: acpSessionId,
      sourceUpdatedAt: info.updatedAt,
      materialized,
    });
    const lastMessageAt = resolveSourceUpdatedAtMs(info, getServerNow());

    await sessionDoc.updateHistoryAndCursor(
      (history, cursor) => {
        const sourceHashes = resolveImportedTurnHashes(
          latestExternalHistory,
          cursor?.importedTurnHashes
        );
        // The cursor's own version governs the comparison; metadata may have advanced.
        const storedHashVersion = resolveStoredHashVersion(
          cursor?.importedTurnHashes !== undefined ? cursor : latestExternalHistory
        );
        const writeTimeDecision = decideHistoryConflictResolution({
          externalHistory: latestExternalHistory,
          importedTurnHashes: sourceHashes,
          importedTurnHashVersion: storedHashVersion,
          storedHistoryHashes: storedBaselineHashes(cursor, sourceHashes),
          materialized,
          currentHistoryHashes: hashHistoryForStoredVersion(history, storedHashVersion),
          currentHistoryHasPendingDispatch: hasPendingDispatchHistory(history),
        });
        if (writeTimeDecision.status !== 'replace') {
          const message =
            writeTimeDecision.status === 'blocked'
              ? formatHistoryConflictResolutionBlocker(writeTimeDecision)
              : 'History conflict was already resolved before replacement.';
          throw new Error(message);
        }
        return materialized.history;
      },
      (stored) => createImportCursor(materialized.turnHashes, stored, materialized.hashVersion)
    );
    await this.manager.repo.upsertDocMeta(roomId, {
      origin: 'external-acp',
      lastMessageAt,
      externalHistory: nextExternalHistory,
    } satisfies Partial<SessionMeta>);

    const synced = await sessionDoc.waitUntilSynced();
    if (!synced) {
      throw new Error(
        `Replaced history for ${args.sessionId} did not confirm sync before timeout.`
      );
    }

    return finishResolved({
      ...latestMeta,
      origin: 'external-acp',
      lastMessageAt,
      externalHistory: nextExternalHistory,
    });
  }

  private async listCatalogSnapshot(args: {
    localProjectId: LocalProjectId;
    rootPath: string;
    requiredSessionIds?: readonly string[];
  }): Promise<HistoryCatalogSnapshot> {
    const catalog = await listHistorySessionsForLocalProject({
      provider: this.provider,
      rootPath: args.rootPath,
      logger: this.logger,
      requiredSessionIds: args.requiredSessionIds,
    });

    const sessionMetas = await listWorkspaceSessionMetas(this.manager);
    const existingByImportKey = buildExistingHistorySessionIndex(
      sessionMetas,
      this.context.machineId,
      this.provider,
      args.localProjectId
    );

    return { sessions: catalog.sessions, existingByImportKey };
  }

  private async findExistingHistorySession(
    localProjectId: LocalProjectId,
    acpSessionId: string
  ): Promise<ExistingHistorySession | undefined> {
    const importKey = getHistoryImportKey({
      machineId: this.context.machineId,
      localProjectId,
      provider: this.provider,
      acpSessionId,
    });
    const sessionMetas = await listWorkspaceSessionMetas(this.manager);
    return buildExistingHistorySessionIndex(
      sessionMetas,
      this.context.machineId,
      this.provider,
      localProjectId
    ).get(importKey);
  }

  private isMatchingHistorySession(
    meta: SessionMeta,
    localProjectId: LocalProjectId,
    acpSessionId: string
  ): boolean {
    if (meta.machineId !== this.context.machineId) return false;
    if (meta.cliType !== this.provider.cliType) return false;
    if (meta.agentType !== this.provider.agentType) return false;
    if (meta.project?.kind !== 'local') return false;
    if (meta.project.localProjectId !== localProjectId) return false;
    if (
      !meta.externalHistory ||
      getLocalProjectHistoryProviderKey(meta.externalHistory.provider) !== this.providerKey
    ) {
      return false;
    }
    return meta.externalHistory.sourceAcpSessionId === acpSessionId;
  }

  private async writeCatalogResult(args: {
    localProjectId: LocalProjectId;
    sessions: SessionInfo[];
    existingByImportKey: Map<string, ExistingHistorySession>;
  }): Promise<LocalProjectHistoryCatalogResult> {
    const lastListedAt = Math.round(getServerNow());
    const sessions = selectLatestCatalogItems(
      args.sessions.map((info) =>
        buildCatalogItem(
          this.provider,
          info,
          args.existingByImportKey.get(
            getHistoryImportKey({
              machineId: this.context.machineId,
              localProjectId: args.localProjectId,
              provider: this.provider,
              acpSessionId: info.sessionId,
            })
          )
        )
      )
    );

    const catalog = {
      listed: sessions.length,
      lastListedAt,
      sessions,
    };

    const machineRoomId = getMachineRoomId(this.context.machineId);
    // Serialize the read-modify-write of the project row so concurrent providers
    // on the same machine cannot snapshot the same project and clobber each other's
    // nested history fields.
    await withMachineCatalogWriteLock(machineRoomId, async () => {
      const existing = await readMachineLocalProjects(
        this.manager.repo,
        this.context.workspaceId,
        this.context.machineId
      );
      const previous = existing[args.localProjectId];
      if (!previous) {
        return;
      }
      await upsertMachineLocalProject(
        this.manager.repo,
        this.context.workspaceId,
        this.context.machineId,
        {
          ...previous,
          history: {
            ...(previous.history ?? {}),
            [this.providerKey]: {
              lastListedAt,
              sessions: Object.fromEntries(sessions.map((item) => [item.acpSessionId, item])),
            },
          },
        },
        lastListedAt,
        { sync: this.manager, reason: 'local-project-history-sync' }
      );
    });

    return catalog;
  }

  private async importNewSession(args: {
    info: SessionInfo;
    acpSessionId: ACPSessionId;
    project: ProjectRef;
    materialized: MaterializedReplay;
  }): Promise<ExistingHistorySession> {
    const sessionId = uuidV4() as SessionId;
    const roomId = getSessionRoomId(sessionId);
    const nowMs = getServerNow();
    const lastMessageAt = resolveSourceUpdatedAtMs(args.info, nowMs);
    const meta: SessionMeta = {
      id: sessionId,
      machineId: this.context.machineId,
      createdAt: new Date(nowMs).toISOString(),
      userId: this.context.userId,
      status: SessionStatusFactory.idle(),
      isArchived: false,
      origin: 'external-acp',
      cliType: this.provider.cliType,
      agentType: this.provider.agentType,
      project: args.project,
      title: resolveSessionTitle(args.info, this.provider),
      // Imported titles are placeholders derived from provider data; allow the title
      // generator to replace them later, same as web-created draft titles.
      titleSource: 'draft',
      lastMessageAt,
      externalHistory: buildExternalHistoryMeta({
        provider: this.provider,
        sourceAcpSessionId: args.acpSessionId,
        sourceUpdatedAt: args.info.updatedAt,
        materialized: args.materialized,
      }),
    };

    try {
      const sessionDoc = await this.manager.getOrCreateSessionDoc(sessionId);
      await sessionDoc.updateHistoryAndCursor(
        () => args.materialized.history,
        (stored) =>
          createImportCursor(args.materialized.turnHashes, stored, args.materialized.hashVersion)
      );
      await this.manager.repo.upsertDocMeta(roomId, meta);
      const synced = await sessionDoc.waitUntilSynced();
      if (!synced) {
        this.logger.warn(
          `[${this.providerKey}-history-sync] Imported history for ${sessionId} did not ` +
            'confirm remote sync before unload; it remains locally durable and will retry sync.'
        );
      }
    } catch (error) {
      await this.manager.repo.deleteDoc(roomId).catch((cleanupError) => {
        this.logger.warn(
          `[${this.providerKey}-history-sync] Failed to delete incomplete imported session ` +
            `${sessionId}: ${formatErrorMessage(cleanupError)}`
        );
      });
      await this.manager
        .cleanSessionDoc(sessionId, { preserveStatus: true })
        .catch((cleanupError) => {
          this.logger.warn(
            `[${this.providerKey}-history-sync] Failed to unload incomplete imported session ` +
              `${sessionId}: ${formatErrorMessage(cleanupError)}`
          );
        });
      throw error;
    }
    await this.manager
      .cleanSessionDoc(sessionId, { preserveStatus: true })
      .catch((cleanupError) => {
        this.logger.warn(
          `[${this.providerKey}-history-sync] Failed to unload imported session ` +
            `${sessionId}: ${formatErrorMessage(cleanupError)}`
        );
      });
    return { sessionId, meta };
  }

  private async refreshExistingSession(args: {
    existing: ExistingHistorySession;
    info: SessionInfo;
    acpSessionId: ACPSessionId;
    rootPath: string;
  }): Promise<'refreshed' | 'skipped' | 'conflicted'> {
    const externalHistory = args.existing.meta.externalHistory;
    if (
      !externalHistory ||
      getLocalProjectHistoryProviderKey(externalHistory.provider) !== this.providerKey
    ) {
      return 'skipped';
    }
    if (shouldSkipBySourceUpdatedAt(args.info, externalHistory)) {
      return 'skipped';
    }

    const replayNotifications = await loadHistorySessionReplay({
      provider: this.provider,
      rootPath: args.rootPath,
      acpSessionId: args.acpSessionId,
      logger: this.logger,
    });
    const materialized = materializeReplay({
      provider: this.provider,
      acpSessionId: args.acpSessionId,
      replayNotifications,
      userId: this.context.userId,
    });
    const sessionDoc = await this.manager.getOrCreateSessionDoc(args.existing.sessionId);
    let appended = 0;
    try {
      await sessionDoc.updateHistoryAndCursor(
        (history, cursor) => {
          const importedTurnHashes = resolveImportedTurnHashes(
            externalHistory,
            cursor?.importedTurnHashes
          );
          // Pair the comparison with the cursor's own version: metadata may have advanced.
          const storedHashVersion = resolveStoredHashVersion(
            cursor?.importedTurnHashes !== undefined ? cursor : externalHistory
          );
          // Check the actual state inside the synchronous write boundary. A matching
          // metadata digest must not bless local edits or an independently stale cursor.
          const decision = decideHistoryRefresh({
            externalHistory,
            importedTurnHashes,
            importedTurnHashVersion: storedHashVersion,
            replayDigest: materialized.replayDigest,
            turnHashes: materialized.turnHashes,
            materialized,
            currentHistoryHashes: hashHistoryForStoredVersion(history, storedHashVersion),
            storedHistoryHashes: storedBaselineHashes(cursor, importedTurnHashes),
            // Only project the new source suffix, never existing storage or the
            // already imported source prefix. A peer's body may arrive before
            // its cursor; its exact projected suffix must remain resumable.
            projectedTurnHashes: [
              ...importedTurnHashes,
              ...materialized.history
                .slice(importedTurnHashes.length)
                .map((entry) =>
                  hashHistoryEntryForVersion(
                    parseHistoryWrite(HistoryEntryWriteSchema, entry),
                    storedHashVersion
                  )
                ),
            ],
          });
          if (decision.status === 'conflicted') throw new HistoryRefreshConflict(decision.reason);
          const suffix = materialized.history.slice(decision.appendFromIndex);
          appended = suffix.length;
          return [...history, ...suffix];
        },
        (stored) => createImportCursor(materialized.turnHashes, stored, materialized.hashVersion)
      );
    } catch (error) {
      if (!(error instanceof HistoryRefreshConflict)) throw error;
      await this.markConflict(args.existing.sessionId, args.info, materialized, error.message);
      // Wait for the conflict marker to reach Streams before unloading the doc
      // handle. If we unload too early, the conflict state can remain
      // local-cache only and the user sees an "imported" session while other
      // clients keep seeing the stale state.
      const synced = await sessionDoc.waitUntilSynced();
      if (!synced) {
        this.logger.debug(
          `[${this.providerKey}-history-sync] Conflict marker for ${
            args.existing.sessionId
          } did not confirm sync before unload; clients may see the previous state until next sync.`
        );
      }
      await this.manager.cleanSessionDoc(args.existing.sessionId, { preserveStatus: true });
      return 'conflicted';
    }

    await this.manager.repo.upsertDocMeta(getSessionRoomId(args.existing.sessionId), {
      origin: 'external-acp',
      lastMessageAt: resolveSourceUpdatedAtMs(args.info, getServerNow()),
      externalHistory: buildExternalHistoryMeta({
        provider: this.provider,
        sourceAcpSessionId: args.acpSessionId,
        sourceUpdatedAt: args.info.updatedAt,
        materialized,
      }),
    } satisfies Partial<SessionMeta>);
    // Wait for the appended history and updated cursor to reach Streams before
    // unloading. Otherwise the new turns may live only in this process's local
    // cache, and a refresh from another client will see the prior cursor and
    // think the import never happened.
    const synced = await sessionDoc.waitUntilSynced();
    if (!synced) {
      this.logger.debug(
        `[${this.providerKey}-history-sync] Appended history for ${
          args.existing.sessionId
        } did not confirm sync before unload; ` +
          'other clients may see the previous state until next sync.'
      );
    }
    await this.manager.cleanSessionDoc(args.existing.sessionId, { preserveStatus: true });
    return externalHistory.status === 'metadata_only' || appended > 0 ? 'refreshed' : 'skipped';
  }

  private async markConflict(
    sessionId: SessionId,
    info: SessionInfo,
    materialized: MaterializedReplay,
    reason: string
  ): Promise<void> {
    await this.manager.repo.upsertDocMeta(getSessionRoomId(sessionId), {
      origin: 'external-acp',
      externalHistory: buildExternalHistoryMeta({
        provider: this.provider,
        sourceAcpSessionId: info.sessionId as unknown as ACPSessionId,
        sourceUpdatedAt: info.updatedAt,
        materialized,
        status: 'sync_conflict',
        conflictReason: reason,
      }),
    } satisfies Partial<SessionMeta>);
  }
}
