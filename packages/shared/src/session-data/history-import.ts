import { z } from 'zod';
import { sha256Hex } from '../incremental-sha256';
import type { SessionTurn } from './domain';

/** Source identity hashes and the stored-content baseline are separate. */
export type HistoryImportCursor = {
  importedTurnHashes?: string[];
  storedHistoryBaseline?: string;
};
export type HistoryImportMetadata = {
  importedTurnHashes?: readonly string[];
  importedTurnCount: number;
  replayDigest?: string;
  status?: string;
};
export type HistoryImportReplay = {
  history: readonly SessionTurn[];
  turnHashes: readonly string[];
  replayDigest: string;
  droppedNotifications: number;
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
  stored: readonly SessionTurn[]
): HistoryImportCursor {
  return {
    importedTurnHashes: [...sourceHashes],
    storedHistoryBaseline: JSON.stringify({
      version: 1,
      sourceDigest: hashText(sourceHashes.join('\n')),
      turnHashes: stored.map(hashHistoryEntry),
    } satisfies z.infer<typeof StoredHistoryBaselineSchema>),
  };
}

export function decideHistoryRefresh(args: {
  externalHistory: HistoryImportMetadata;
  importedTurnHashes?: readonly string[];
  replayDigest: string;
  turnHashes: readonly string[];
  currentHistoryHashes?: readonly string[];
  storedHistoryHashes?: readonly string[];
  projectedTurnHashes?: readonly string[];
}): HistoryRefreshDecision {
  if (!args.currentHistoryHashes && args.replayDigest === args.externalHistory.replayDigest) {
    return { status: 'skipped', reason: 'digest_match' };
  }

  const importedTurnHashes = resolveImportedTurnHashes(
    args.externalHistory,
    args.importedTurnHashes
  );
  if (!isPrefix(importedTurnHashes, args.turnHashes)) {
    return { status: 'conflicted', reason: 'prefix_mismatch' };
  }

  if (args.currentHistoryHashes) {
    const expected = args.storedHistoryHashes
      ? [
          ...args.storedHistoryHashes,
          ...(args.projectedTurnHashes ?? args.turnHashes).slice(importedTurnHashes.length),
        ]
      : args.turnHashes;
    if (
      args.currentHistoryHashes.length < importedTurnHashes.length ||
      !isPrefix(args.currentHistoryHashes, expected)
    ) {
      return { status: 'conflicted', reason: 'local_history_has_untracked_suffix' };
    }
    const appendFromIndex = args.currentHistoryHashes.length;
    return args.turnHashes.length > appendFromIndex
      ? { status: 'refreshed', reason: 'prefix_append', appendFromIndex }
      : { status: 'skipped', reason: 'empty_suffix', appendFromIndex };
  }

  const appendFromIndex = args.externalHistory.importedTurnCount;
  return args.turnHashes.length > appendFromIndex
    ? { status: 'refreshed', reason: 'prefix_append', appendFromIndex }
    : { status: 'skipped', reason: 'empty_suffix', appendFromIndex };
}

export function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && isPrefix(left, right);
}

export function decideHistoryConflictResolution(args: {
  externalHistory: HistoryImportMetadata;
  importedTurnHashes?: readonly string[];
  materialized: Pick<
    HistoryImportReplay,
    'history' | 'turnHashes' | 'replayDigest' | 'droppedNotifications'
  >;
  currentHistoryHashes: readonly string[];
  storedHistoryHashes?: readonly string[];
  currentHistoryHasPendingDispatch: boolean;
}): HistoryConflictResolutionDecision {
  if (args.currentHistoryHasPendingDispatch) {
    return { status: 'blocked', reason: 'session_has_pending_local_turn' };
  }

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
        args.externalHistory.replayDigest === args.materialized.replayDigest &&
        areStringArraysEqual(args.currentHistoryHashes, args.materialized.turnHashes)));
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

  if (args.materialized.turnHashes.length < importedTurnHashes.length) {
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
  const storedHistoryHashes = storedBaselineHashes(cursor, sourceHashes);
  if (input.mode === 'resolve-conflict') {
    const decision = decideHistoryConflictResolution({
      externalHistory: input.externalHistory,
      importedTurnHashes: sourceHashes,
      storedHistoryHashes,
      materialized: input.replay,
      currentHistoryHashes: history.map(hashHistoryEntry),
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
    replayDigest: input.replay.replayDigest,
    turnHashes: input.replay.turnHashes,
    currentHistoryHashes: history.map(hashHistoryEntry),
    storedHistoryHashes,
    projectedTurnHashes: [...sourceHashes, ...projectedTurnHashes.slice(sourceHashes.length)],
  });
  if (decision.status === 'conflicted') throw new HistoryImportRefused(decision.reason);
  const suffix = input.replay.history.slice(decision.appendFromIndex);
  return { turns: [...history, ...suffix], appended: suffix.length };
}
