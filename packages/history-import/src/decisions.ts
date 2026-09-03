import {
  isSessionHistoryPendingForDispatch,
  type ExternalAcpHistorySyncMeta,
  type SessionHistoryInput,
} from '@lody/shared';

import { HASH_VERSION_V1, hashHistoryEntryForVersion, hashText } from './hashing';
import type { MaterializedReplay } from './materialize';

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

export function isPrefix(prefix: readonly string[], value: readonly string[]): boolean {
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

export function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && isPrefix(left, right);
}

export function resolveImportedTurnHashes(
  externalHistory: ExternalAcpHistorySyncMeta,
  importedTurnHashes?: readonly string[]
): readonly string[] {
  return importedTurnHashes ?? externalHistory.importedTurnHashes ?? [];
}

export function hasPendingDispatchHistory(history: readonly SessionHistoryInput[]): boolean {
  return history.some((entry) => isSessionHistoryPendingForDispatch(entry));
}

/**
 * Canonical-hash version of a stored cursor. Cursors written before
 * `ExternalAcpHistorySyncMeta.hashVersion` existed are v1.
 */
export function resolveStoredHashVersion(
  externalHistory: Pick<ExternalAcpHistorySyncMeta, 'hashVersion'>
): number {
  return externalHistory.hashVersion ?? HASH_VERSION_V1;
}

/**
 * Subset of a materialized replay the decisions need to recompute hashes in
 * the stored cursor's version. `hashVersion` may be absent in legacy test
 * fixtures; absent means "already in the stored version" (no recomputation).
 */
export type MaterializedReplayHashSource = Pick<MaterializedReplay, 'history'> & {
  hashVersion?: number;
};

/**
 * Express a replay's digest/turn hashes in the stored cursor's version. When
 * the replay was materialized with a newer canonical form than the stored
 * cursor (a v1 cursor from an older CLI vs a v2 replay), the stored-version
 * hashes are recomputed from the replay history so the upgrade never produces
 * a false conflict. Recomputation changes hashes but never the turn count, so
 * `appendFromIndex` still indexes the materialized history.
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
   * Stored cursor hashes, in the stored cursor's version
   * (`externalHistory.hashVersion ?? 1`). The session doc cursor carries the
   * same version in its own `hashVersion` field.
   */
  importedTurnHashes?: readonly string[];
  replayDigest: string;
  turnHashes: readonly string[];
  /**
   * The materialized replay `replayDigest`/`turnHashes` came from. Pass it
   * whenever the replay's `hashVersion` may differ from the stored cursor's
   * version so the comparison can be recomputed in the stored version.
   */
  materialized?: MaterializedReplayHashSource;
  /**
   * Version of `replayDigest`/`turnHashes`. Defaults to
   * `materialized.hashVersion`, or to the stored version when no materialized
   * replay is passed (legacy callers always compared same-version hashes).
   */
  replayHashVersion?: number;
  /**
   * Hashes of the locally stored turns. Callers must compute these with the
   * STORED hash version (`hashHistoryEntryForVersion(entry, storedVersion)`),
   * since they are compared against stored-version replay hashes here.
   */
  currentHistoryHashes?: readonly string[];
}): HistoryRefreshDecision {
  const storedHashVersion = resolveStoredHashVersion(args.externalHistory);
  const replay = resolveReplayHashesForStoredVersion({
    replayDigest: args.replayDigest,
    turnHashes: args.turnHashes,
    replayHashVersion:
      args.replayHashVersion ?? args.materialized?.hashVersion ?? storedHashVersion,
    storedHashVersion,
    replayHistory: args.materialized?.history,
  });

  if (replay.replayDigest === args.externalHistory.replayDigest) {
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
    if (!isPrefix(args.currentHistoryHashes, replay.turnHashes)) {
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

export function decideHistoryConflictResolution(args: {
  externalHistory: ExternalAcpHistorySyncMeta;
  /**
   * Stored cursor hashes, in the stored cursor's version
   * (`externalHistory.hashVersion ?? 1`).
   */
  importedTurnHashes?: readonly string[];
  materialized: Pick<
    MaterializedReplay,
    'history' | 'turnHashes' | 'replayDigest' | 'droppedNotifications'
  > & {
    /**
     * Version of `turnHashes`/`replayDigest`. Absent means "already in the
     * stored version" (legacy callers); a real `MaterializedReplay` always
     * carries it.
     */
    hashVersion?: number;
  };
  /**
   * Hashes of the locally stored turns, computed with the STORED hash version
   * (`hashHistoryEntryForVersion(entry, storedVersion)`).
   */
  currentHistoryHashes: readonly string[];
  currentHistoryHasPendingDispatch: boolean;
}): HistoryConflictResolutionDecision {
  if (args.currentHistoryHasPendingDispatch) {
    return { status: 'blocked', reason: 'session_has_pending_local_turn' };
  }

  const storedHashVersion = resolveStoredHashVersion(args.externalHistory);
  const replay = resolveReplayHashesForStoredVersion({
    replayDigest: args.materialized.replayDigest,
    turnHashes: args.materialized.turnHashes,
    replayHashVersion: args.materialized.hashVersion ?? storedHashVersion,
    storedHashVersion,
    replayHistory: args.materialized.history,
  });

  const importedTurnHashes = resolveImportedTurnHashes(
    args.externalHistory,
    args.importedTurnHashes
  );
  const alreadyResolved =
    args.externalHistory.status !== 'sync_conflict' &&
    (areStringArraysEqual(args.currentHistoryHashes, importedTurnHashes) ||
      (args.externalHistory.replayDigest === replay.replayDigest &&
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

export function formatHistoryConflictResolutionBlocker(
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
