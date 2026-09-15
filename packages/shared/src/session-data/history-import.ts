import { z } from 'zod';
import { sha256Hex } from '../incremental-sha256';
import type { SessionTurn } from './domain';

/**
 * Canonical-hash versions. v1 hashed `{ role, items, plan }` verbatim; v2 hashes a
 * canonical item form so a sealed tool_call skeleton
 * (`{ type, kind, status, title?, locations?, ref }`) and the full tool_call shape it
 * was sealed from produce the same hash. A stored cursor without a `hashVersion` is v1,
 * written before skeletons existed.
 */
export const HASH_VERSION_V1 = 1;
export const HASH_VERSION_V2 = 2;
/** Version new imports write. */
export const HASH_VERSION = HASH_VERSION_V2;

/** Source identity hashes and the stored-content baseline are separate. */
export type HistoryImportCursor = {
  importedTurnHashes?: string[];
  /**
   * Canonical-hash version `importedTurnHashes` were computed with. Absent means v1
   * (written before hash versions existed). It is deliberately independent of the sync
   * metadata's own version: a conflict marker may advance only the metadata, and a v1
   * cursor must never be read as v2 (that manufactures a false prefix_mismatch).
   */
  hashVersion?: number;
  storedHistoryBaseline?: string;
};
export type HistoryImportMetadata = {
  importedTurnHashes?: readonly string[];
  importedTurnCount: number;
  replayDigest?: string;
  /**
   * Canonical-hash version `replayDigest` was computed with. Absent means v1. It
   * versions the digest only; the session doc cursor carries its own version for
   * `importedTurnHashes`.
   */
  hashVersion?: number;
  status?: string;
};
export type HistoryImportReplay = {
  history: readonly SessionTurn[];
  turnHashes: readonly string[];
  replayDigest: string;
  droppedNotifications: number;
  /** Canonical-hash version `turnHashes`/`replayDigest` were computed with. */
  hashVersion: number;
};
export type HistoryImportInput = {
  replay: HistoryImportReplay;
} & (
  | { mode: 'initialize' }
  | {
      mode: 'refresh' | 'resolve-conflict';
      externalHistory: HistoryImportMetadata;
    }
);
export class HistoryImportRefused extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export const HistoryImportCursorSchema = z.object({
  importedTurnHashes: z.array(z.string()).optional(),
  // Declared explicitly: Zod strips undeclared keys at this boundary, and dropping
  // the version would silently reinterpret v2 cursor hashes as v1.
  hashVersion: z.number().optional(),
  storedHistoryBaseline: z.string().optional(),
});

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
  return sha256Hex(new TextEncoder().encode(value));
}

// Both stored legacy items and parsed new items are hashed as opaque content.
type HistoryHashInput = {
  role: SessionTurn['role'];
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
 * In particular v2 excludes the tool payload (`content`/`rawInput`/`rawOutput`) from the
 * identity comparison: a source-side change that only alters tool output does NOT trigger
 * a refresh. That is a deliberate tradeoff — payload bytes are not transcript identity.
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
 * against a stored cursor written by an older client, so an upgrade never looks like a
 * conflict. An unknown version throws: never guess which canonical form was meant.
 */
export function hashHistoryEntryForVersion(entry: HistoryHashInput, version: number): string {
  if (version === HASH_VERSION_V1) return hashHistoryEntry(entry);
  if (version === HASH_VERSION_V2) return hashHistoryEntryV2(entry);
  throw new Error(`Unsupported history hash version: ${version}`);
}

/** Cursors and metadata written before the field existed are v1. */
export function resolveStoredHashVersion(source: { hashVersion?: number } | undefined): number {
  return source?.hashVersion ?? HASH_VERSION_V1;
}

/**
 * Version paired with the EFFECTIVE source hashes: the cursor's own when it carries
 * `importedTurnHashes`, otherwise the sync metadata's (whose legacy hash list is being
 * used instead). Pairing version with the wrong holder reinterprets the hashes.
 */
export function resolveImportHashVersion(
  externalHistory: HistoryImportMetadata,
  cursor: HistoryImportCursor | undefined
): number {
  return resolveStoredHashVersion(
    cursor?.importedTurnHashes !== undefined ? cursor : externalHistory
  );
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

export function resolveImportedTurnHashes(
  externalHistory: HistoryImportMetadata,
  importedTurnHashes?: readonly string[]
): readonly string[] {
  return importedTurnHashes ?? externalHistory.importedTurnHashes ?? [];
}

const StoredHistoryBaselineSchema = z.object({
  version: z.literal(1),
  // Absent on baselines written before hash versions; those are v1 and must not be
  // interpreted against a v2 cursor.
  hashVersion: z.number().optional(),
  sourceDigest: z.string(),
  turnHashes: z.array(z.string()),
});

export function storedBaselineHashes(
  cursor: HistoryImportCursor | undefined,
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
        // A baseline written before hash versions existed has no `hashVersion` field
        // and is v1. Comparing it directly against the cursor version rejected every
        // genuine old baseline (`undefined !== 1`), which discarded the projected
        // stored history and turned a normal append into a conflict. The baseline is
        // still bound to its own version, so a v1 baseline against a v2 cursor (or
        // vice versa) is correctly ignored.
        (parsed.data.hashVersion ?? HASH_VERSION_V1) === resolveStoredHashVersion(cursor) &&
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

export function createImportCursor(
  sourceHashes: readonly string[],
  stored: readonly SessionTurn[],
  hashVersion: number
): HistoryImportCursor {
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
export type HistoryImportReplayHashSource = {
  history: readonly SessionTurn[];
  hashVersion?: number;
};

/**
 * Express a replay's digest/turn hashes in an explicit canonical version. When the replay
 * was materialized with a newer canonical form than the stored cursor (a v1 cursor from an
 * older client versus a v2 replay), the stored-version hashes are recomputed from the
 * replay history so an upgrade never produces a false conflict. Recomputation changes
 * hashes but never the turn count, so `appendFromIndex` still indexes the materialized
 * history. Without the replay history there is nothing safe to compare: throw.
 */
function resolveReplayHashesForStoredVersion(args: {
  replayDigest: string;
  turnHashes: readonly string[];
  replayHashVersion: number;
  storedHashVersion: number;
  replayHistory?: readonly SessionTurn[];
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

/** Hash locally stored turns in the version of the stored sync cursor. */
export function hashHistoryForStoredVersion(
  history: readonly SessionTurn[],
  hashVersion: number
): string[] {
  return history.map((entry) => hashHistoryEntryForVersion(entry, hashVersion));
}

export function decideHistoryRefresh(args: {
  externalHistory: HistoryImportMetadata;
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
  materialized?: HistoryImportReplayHashSource;
  /**
   * Version of `replayDigest`/`turnHashes`. Production callers always carry it:
   * `HistoryImportReplay.hashVersion` is required and `planHistoryImport` passes the
   * materialized replay through. The fallback to the stored version exists ONLY for
   * legacy test doubles that compare opaque same-version placeholder hashes — by
   * omitting both this and `materialized`, a caller asserts its hashes are already
   * expressed in the stored version. There is no other "guess the version" path:
   * a mismatch with replay history recomputes, and one without it throws.
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
  const replayHashVersion =
    args.replayHashVersion ?? args.materialized?.hashVersion ?? storedHashVersion;
  const replay = resolveReplayHashesForStoredVersion({
    replayDigest: args.replayDigest,
    turnHashes: args.turnHashes,
    replayHashVersion,
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
          replayHashVersion,
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
    const appendFromIndex = args.currentHistoryHashes.length;
    return replay.turnHashes.length > appendFromIndex
      ? { status: 'refreshed', reason: 'prefix_append', appendFromIndex }
      : { status: 'skipped', reason: 'empty_suffix', appendFromIndex };
  }

  const appendFromIndex = args.externalHistory.importedTurnCount;
  return replay.turnHashes.length > appendFromIndex
    ? { status: 'refreshed', reason: 'prefix_append', appendFromIndex }
    : { status: 'skipped', reason: 'empty_suffix', appendFromIndex };
}

export function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && isPrefix(left, right);
}

export function decideHistoryConflictResolution(args: {
  externalHistory: HistoryImportMetadata;
  /** Stored cursor hashes, paired with importedTurnHashVersion when supplied. */
  importedTurnHashes?: readonly string[];
  /** Version paired with the explicit cursor hashes; metadata may advance separately. */
  importedTurnHashVersion?: number;
  materialized: Pick<
    HistoryImportReplay,
    'history' | 'turnHashes' | 'replayDigest' | 'droppedNotifications'
  > & {
    /**
     * Version of `turnHashes`/`replayDigest`. Absent means "already in the stored
     * version" (legacy callers); a real `HistoryImportReplay` always carries it.
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
  // A conflict marker advances only the metadata; compare its digest in its own version
  // so a v1 doc cursor is not misread as v2.
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

/** Pure decision over the store's commit-time observations, never caller callbacks. */
export function planHistoryImport(
  input: HistoryImportInput,
  history: readonly SessionTurn[],
  cursor: HistoryImportCursor | undefined,
  projectedTurnHashes: readonly string[],
  hasPendingDispatch: boolean
): { turns: readonly SessionTurn[]; appended: number } {
  if (input.mode === 'initialize') {
    if (history.length !== 0 || (cursor?.importedTurnHashes?.length ?? 0) !== 0)
      throw new HistoryImportRefused('not_empty');
    return { turns: input.replay.history, appended: input.replay.history.length };
  }
  const sourceHashes = resolveImportedTurnHashes(input.externalHistory, cursor?.importedTurnHashes);
  // The effective source hashes' own version governs every comparison here: current
  // stored hashes, the projected suffix, and the recomputed replay. The metadata digest
  // keeps its independent version inside the decisions.
  const storedHashVersion = resolveImportHashVersion(input.externalHistory, cursor);
  const storedHistoryHashes = storedBaselineHashes(cursor, sourceHashes);
  if (input.mode === 'resolve-conflict') {
    const decision = decideHistoryConflictResolution({
      externalHistory: input.externalHistory,
      importedTurnHashes: sourceHashes,
      importedTurnHashVersion: storedHashVersion,
      storedHistoryHashes,
      materialized: input.replay,
      currentHistoryHashes: hashHistoryForStoredVersion(history, storedHashVersion),
      currentHistoryHasPendingDispatch: hasPendingDispatch,
    });
    if (decision.status !== 'replace')
      throw new HistoryImportRefused(
        decision.status === 'blocked' ? decision.reason : 'already_resolved'
      );
    return { turns: input.replay.history, appended: input.replay.history.length };
  }
  const decision = decideHistoryRefresh({
    externalHistory: input.externalHistory,
    importedTurnHashes: sourceHashes,
    importedTurnHashVersion: storedHashVersion,
    replayDigest: input.replay.replayDigest,
    turnHashes: input.replay.turnHashes,
    materialized: input.replay,
    currentHistoryHashes: hashHistoryForStoredVersion(history, storedHashVersion),
    storedHistoryHashes,
    projectedTurnHashes: [...sourceHashes, ...projectedTurnHashes.slice(sourceHashes.length)],
  });
  if (decision.status === 'conflicted') throw new HistoryImportRefused(decision.reason);
  const suffix = input.replay.history.slice(decision.appendFromIndex);
  return { turns: [...history, ...suffix], appended: suffix.length };
}
