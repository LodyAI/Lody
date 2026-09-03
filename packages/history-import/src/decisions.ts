import {
  isSessionHistoryPendingForDispatch,
  type ExternalAcpHistorySyncMeta,
  type SessionHistoryInput,
} from '@lody/shared';

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

export function decideHistoryRefresh(args: {
  externalHistory: ExternalAcpHistorySyncMeta;
  importedTurnHashes?: readonly string[];
  replayDigest: string;
  turnHashes: readonly string[];
  currentHistoryHashes?: readonly string[];
}): HistoryRefreshDecision {
  if (args.replayDigest === args.externalHistory.replayDigest) {
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
    if (!isPrefix(args.currentHistoryHashes, args.turnHashes)) {
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

export function decideHistoryConflictResolution(args: {
  externalHistory: ExternalAcpHistorySyncMeta;
  importedTurnHashes?: readonly string[];
  materialized: Pick<
    MaterializedReplay,
    'history' | 'turnHashes' | 'replayDigest' | 'droppedNotifications'
  >;
  currentHistoryHashes: readonly string[];
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
    (areStringArraysEqual(args.currentHistoryHashes, importedTurnHashes) ||
      (args.externalHistory.replayDigest === args.materialized.replayDigest &&
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
