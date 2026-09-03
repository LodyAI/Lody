import {
  getLocalProjectHistoryProviderKey,
  type ACPSessionId,
  type AcpSessionNotification,
  type LocalProjectHistoryProvider,
  type SessionHistoryInput,
} from '@lody/shared';

import { hashHistoryEntry, hashText } from './hashing';
import { buildHistoryReplayImport } from './replay-import';

export type MaterializedReplay = {
  history: SessionHistoryInput[];
  turnHashes: string[];
  replayDigest: string;
  droppedNotifications: number;
};

export type MaterializeReplayArgs = {
  provider: LocalProjectHistoryProvider;
  acpSessionId: ACPSessionId;
  replayNotifications: AcpSessionNotification[];
  userId: string;
  /** Injected for tests; defaults to the wall clock. */
  nowIso?: string;
};

/**
 * Turn a provider replay into the exact history rows an imported session doc
 * holds, plus the hashes the refresh/conflict decisions compare.
 *
 * Entry ids are content-addressed (`provider:acpSession:turn:index:hashPrefix`)
 * so re-importing the same transcript reuses the same Loro list keys instead of
 * rewriting every row.
 */
export function materializeReplay(args: MaterializeReplayArgs): MaterializedReplay {
  let tempId = 0;
  const nowIso = args.nowIso ?? new Date().toISOString();
  const providerKey = getLocalProjectHistoryProviderKey(args.provider);
  const replay = buildHistoryReplayImport(args.replayNotifications, {
    provider: args.provider,
    acpSessionId: args.acpSessionId,
    userId: args.userId,
    now: () => nowIso,
    createId: () => `${providerKey}:${args.acpSessionId}:tmp:${tempId++}`,
    mode: 'imported_snapshot',
  });
  const turnHashes = replay.history.map(hashHistoryEntry);
  const history = replay.history.map((entry, index) => ({
    ...entry,
    id: `${providerKey}:${args.acpSessionId}:turn:${index}:${turnHashes[index]!.slice(0, 16)}`,
  }));

  return {
    history,
    turnHashes,
    replayDigest: hashText(turnHashes.join('\n')),
    droppedNotifications: replay.droppedNotifications,
  };
}
