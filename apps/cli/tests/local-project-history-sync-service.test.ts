import { describe, expect, it, vi } from 'vitest';
import { getExternalAcpHistoryImportKey, getSessionRoomId } from '@lody/shared';
import type {
  ACPSessionId,
  ExternalAcpHistorySyncMeta,
  LocalProjectHistoryCatalogItem,
  LocalProjectId,
  MachineId,
  SessionHistoryInput,
  SessionId,
  SessionMeta,
} from '@lody/shared';

import {
  buildExistingHistorySessionIndex,
  compareCatalogItems,
  decideHistoryConflictResolution,
  decideHistoryRefresh,
  getHistoryCatalogStatus,
  LocalProjectHistorySyncService,
  selectLatestCatalogItems,
} from '../src/lib/local-project-history-sync-service';

const machineId = 'machine-1' as MachineId;
const localProjectId = 'project-1' as LocalProjectId;
const provider = { cliType: 'builtin', agentType: 'codex' } as const;

function externalHistory(overrides: Partial<ExternalAcpHistorySyncMeta> = {}) {
  return {
    provider: { cliType: 'builtin', agentType: 'codex' },
    source: 'local-acp-history',
    replayDigest: 'digest-old',
    importedTurnCount: 2,
    importedTurnHashes: ['hash-1', 'hash-2'],
    lastSyncAt: 1,
    ...overrides,
  } satisfies ExternalAcpHistorySyncMeta;
}

function sessionMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'session-1' as SessionId,
    machineId,
    createdAt: '2026-05-01T00:00:00.000Z',
    userId: 'user-1',
    isArchived: false,
    cliType: provider.cliType,
    agentType: provider.agentType,
    project: { kind: 'local', localProjectId },
    externalHistory: {
      provider,
      source: 'local-acp-history',
      sourceAcpSessionId: 'acp-1' as ACPSessionId,
      importedTurnCount: 0,
      importedTurnHashes: [],
      lastSyncAt: 1,
      status: 'metadata_only',
    },
    ...overrides,
  };
}

function historyEntry(overrides: Partial<SessionHistoryInput> = {}): SessionHistoryInput {
  return {
    id: 'turn-1',
    role: 'user',
    items: [{ type: 'text', text: 'hello' }] as unknown as SessionHistoryInput['items'],
    timestamp: '2026-05-01T00:00:00.000Z',
    status: 'handled',
    read: true,
    finished: true,
    fileDiff: [],
    ...overrides,
  };
}

function materializedReplay(
  overrides: Partial<{
    history: SessionHistoryInput[];
    turnHashes: string[];
    replayDigest: string;
    droppedNotifications: number;
  }> = {}
) {
  return {
    history: [historyEntry()],
    turnHashes: ['hash-1'],
    replayDigest: 'digest-new',
    droppedNotifications: 0,
    ...overrides,
  };
}

describe('decideHistoryRefresh', () => {
  it('skips when replay digest is unchanged', () => {
    expect(
      decideHistoryRefresh({
        externalHistory: externalHistory(),
        replayDigest: 'digest-old',
        turnHashes: ['hash-1', 'hash-2'],
      })
    ).toEqual({ status: 'skipped', reason: 'digest_match' });
  });

  it('appends only the replay suffix when the old hashes are a prefix', () => {
    expect(
      decideHistoryRefresh({
        externalHistory: externalHistory(),
        replayDigest: 'digest-new',
        turnHashes: ['hash-1', 'hash-2', 'hash-3'],
        currentHistoryHashes: ['hash-1', 'hash-2'],
      })
    ).toEqual({
      status: 'refreshed',
      reason: 'prefix_append',
      appendFromIndex: 2,
    });
  });

  it('hydrates all replay turns for metadata-only imports', () => {
    expect(
      decideHistoryRefresh({
        externalHistory: externalHistory({
          importedTurnCount: 0,
          importedTurnHashes: [],
          replayDigest: undefined,
          status: 'metadata_only',
        }),
        replayDigest: 'digest-new',
        turnHashes: ['hash-1', 'hash-2'],
        currentHistoryHashes: [],
      })
    ).toEqual({
      status: 'refreshed',
      reason: 'prefix_append',
      appendFromIndex: 0,
    });
  });

  it('conflicts instead of silently merging when replay prefix does not match', () => {
    expect(
      decideHistoryRefresh({
        externalHistory: externalHistory(),
        replayDigest: 'digest-new',
        turnHashes: ['hash-1', 'different-hash'],
      })
    ).toEqual({ status: 'conflicted', reason: 'prefix_mismatch' });
  });

  it('uses session doc cursor hashes when new meta no longer stores hashes', () => {
    expect(
      decideHistoryRefresh({
        externalHistory: externalHistory({ importedTurnHashes: undefined }),
        importedTurnHashes: ['hash-1', 'hash-2'],
        replayDigest: 'digest-new',
        turnHashes: ['hash-1', 'different-hash'],
      })
    ).toEqual({ status: 'conflicted', reason: 'prefix_mismatch' });
  });

  it('conflicts when local history has an untracked suffix', () => {
    expect(
      decideHistoryRefresh({
        externalHistory: externalHistory(),
        replayDigest: 'digest-new',
        turnHashes: ['hash-1', 'hash-2', 'hash-3'],
        currentHistoryHashes: ['hash-1', 'hash-2', 'local-only'],
      })
    ).toEqual({
      status: 'conflicted',
      reason: 'local_history_has_untracked_suffix',
    });
  });

  it('does not conflict when local history already matches a replay prefix past the stored cursor', () => {
    expect(
      decideHistoryRefresh({
        externalHistory: externalHistory(),
        replayDigest: 'digest-new',
        turnHashes: ['hash-1', 'hash-2', 'hash-3'],
        currentHistoryHashes: ['hash-1', 'hash-2', 'hash-3'],
      })
    ).toEqual({
      status: 'skipped',
      reason: 'empty_suffix',
      appendFromIndex: 3,
    });
  });

  it('does not silently restore turns deleted from the imported prefix', () => {
    expect(
      decideHistoryRefresh({
        externalHistory: externalHistory({
          importedTurnCount: 3,
          importedTurnHashes: ['hash-1', 'hash-2', 'hash-3'],
        }),
        replayDigest: 'digest-new',
        turnHashes: ['hash-1', 'hash-2', 'hash-3', 'hash-4'],
        currentHistoryHashes: ['hash-1', 'hash-2'],
      })
    ).toEqual({
      status: 'conflicted',
      reason: 'local_history_has_untracked_suffix',
    });
  });
});

describe('decideHistoryConflictResolution', () => {
  it('allows replacing a conflict with the latest source replay', () => {
    expect(
      decideHistoryConflictResolution({
        externalHistory: externalHistory({ status: 'sync_conflict' }),
        materialized: materializedReplay({
          turnHashes: ['hash-1', 'hash-2', 'hash-3'],
          replayDigest: 'digest-new',
        }),
        currentHistoryHashes: ['hash-1', 'hash-2', 'local-only'],
        currentHistoryHasPendingDispatch: false,
      })
    ).toEqual({ status: 'replace' });
  });

  it('treats a repeated resolve as an idempotent no-op when current history already matches', () => {
    expect(
      decideHistoryConflictResolution({
        externalHistory: externalHistory({
          status: 'synced',
          replayDigest: 'digest-new',
          importedTurnHashes: ['hash-1'],
          importedTurnCount: 1,
        }),
        materialized: materializedReplay(),
        currentHistoryHashes: ['hash-1'],
        currentHistoryHasPendingDispatch: false,
      })
    ).toEqual({ status: 'already_resolved' });
  });

  it('uses session doc cursor hashes for repeated resolve after hashes leave meta', () => {
    expect(
      decideHistoryConflictResolution({
        externalHistory: externalHistory({
          status: 'synced',
          replayDigest: 'digest-new',
          importedTurnHashes: undefined,
          importedTurnCount: 1,
        }),
        importedTurnHashes: ['hash-1'],
        materialized: materializedReplay(),
        currentHistoryHashes: ['hash-1', 'local-only'],
        currentHistoryHasPendingDispatch: false,
      })
    ).toEqual({ status: 'blocked', reason: 'not_sync_conflict' });
  });

  it('blocks repeated resolve after local history changed again', () => {
    expect(
      decideHistoryConflictResolution({
        externalHistory: externalHistory({
          status: 'synced',
          replayDigest: 'digest-new',
          importedTurnHashes: ['hash-1'],
          importedTurnCount: 1,
        }),
        materialized: materializedReplay(),
        currentHistoryHashes: ['hash-1', 'local-only'],
        currentHistoryHasPendingDispatch: false,
      })
    ).toEqual({ status: 'blocked', reason: 'not_sync_conflict' });
  });

  it('blocks empty source replay before destructive replacement', () => {
    expect(
      decideHistoryConflictResolution({
        externalHistory: externalHistory({ status: 'sync_conflict' }),
        materialized: materializedReplay({
          history: [],
          turnHashes: [],
          replayDigest: 'empty',
        }),
        currentHistoryHashes: ['hash-1', 'hash-2'],
        currentHistoryHasPendingDispatch: false,
      })
    ).toEqual({ status: 'blocked', reason: 'source_replay_empty' });
  });

  it('blocks source replay with dropped notifications before destructive replacement', () => {
    expect(
      decideHistoryConflictResolution({
        externalHistory: externalHistory({ status: 'sync_conflict' }),
        materialized: materializedReplay({ droppedNotifications: 1 }),
        currentHistoryHashes: ['hash-1', 'hash-2'],
        currentHistoryHasPendingDispatch: false,
      })
    ).toEqual({
      status: 'blocked',
      reason: 'source_replay_dropped_notifications',
    });
  });

  it('blocks source replay shorter than the previously imported cursor', () => {
    expect(
      decideHistoryConflictResolution({
        externalHistory: externalHistory({ status: 'sync_conflict' }),
        materialized: materializedReplay({
          turnHashes: ['hash-1'],
          replayDigest: 'digest-short',
        }),
        currentHistoryHashes: ['hash-1', 'hash-2'],
        currentHistoryHasPendingDispatch: false,
      })
    ).toEqual({
      status: 'blocked',
      reason: 'source_replay_behind_import_cursor',
    });
  });

  it('blocks replacement while current history has a pending local turn', () => {
    expect(
      decideHistoryConflictResolution({
        externalHistory: externalHistory({ status: 'sync_conflict' }),
        materialized: materializedReplay({
          turnHashes: ['hash-1', 'hash-2', 'hash-3'],
          replayDigest: 'digest-new',
        }),
        currentHistoryHashes: ['hash-1', 'hash-2', 'local-only'],
        currentHistoryHasPendingDispatch: true,
      })
    ).toEqual({
      status: 'blocked',
      reason: 'session_has_pending_local_turn',
    });
  });
});

describe('buildExistingHistorySessionIndex', () => {
  it('indexes imported ACP history by provider, machine, project, and source session', () => {
    const importKey = getExternalAcpHistoryImportKey({
      machineId,
      localProjectId,
      provider,
      sourceAcpSessionId: 'acp-1',
    });
    const index = buildExistingHistorySessionIndex(
      [
        {
          sessionId: 'session-1' as SessionId,
          meta: sessionMeta(),
        },
      ],
      machineId,
      provider,
      localProjectId
    );

    expect(index.get(importKey)?.sessionId).toBe('session-1');
  });

  it('does not treat the same ACP session in a different local project as imported', () => {
    const importKey = getExternalAcpHistoryImportKey({
      machineId,
      localProjectId,
      provider,
      sourceAcpSessionId: 'acp-1',
    });
    const index = buildExistingHistorySessionIndex(
      [
        {
          sessionId: 'session-2' as SessionId,
          meta: sessionMeta({
            id: 'session-2' as SessionId,
            project: { kind: 'local', localProjectId: 'project-2' as LocalProjectId },
          }),
        },
      ],
      machineId,
      provider,
      localProjectId
    );

    expect(index.has(importKey)).toBe(false);
  });

  it('keeps a stable canonical session when duplicate imported sessions exist', () => {
    const importKey = getExternalAcpHistoryImportKey({
      machineId,
      localProjectId,
      provider,
      sourceAcpSessionId: 'acp-1',
    });
    const index = buildExistingHistorySessionIndex(
      [
        {
          sessionId: 'newer-session' as SessionId,
          meta: sessionMeta({
            id: 'newer-session' as SessionId,
            createdAt: '2026-05-02T00:00:00.000Z',
          }),
        },
        {
          sessionId: 'older-session' as SessionId,
          meta: sessionMeta({
            id: 'older-session' as SessionId,
            createdAt: '2026-05-01T00:00:00.000Z',
          }),
        },
      ],
      machineId,
      provider,
      localProjectId
    );

    expect(index.get(importKey)?.sessionId).toBe('older-session');
  });
});

describe('history import persistence', () => {
  function createHarness(options: { failMetaWrite?: boolean; remoteSyncConfirmed?: boolean } = {}) {
    let storedHistory: SessionHistoryInput[] = [];
    let importedTurnHashes: string[] = [];
    const calls: string[] = [];
    const sessionDoc = {
      updateHistoryAndCursor: vi.fn(
        async (
          update: (history: SessionHistoryInput[]) => SessionHistoryInput[],
          createCursor: (history: SessionHistoryInput[]) => { importedTurnHashes?: string[] }
        ) => {
          calls.push('history');
          storedHistory = update(storedHistory);
          calls.push('cursor');
          importedTurnHashes = createCursor(storedHistory).importedTurnHashes ?? [];
        }
      ),
      getExternalHistoryCursor: vi.fn(async () => ({ importedTurnHashes })),
      setExternalHistoryCursor: vi.fn(async (cursor: { importedTurnHashes: string[] }) => {
        calls.push('cursor');
        importedTurnHashes = cursor.importedTurnHashes;
      }),
      updateHistory: vi.fn(
        async (update: (history: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          calls.push('history');
          storedHistory = update(storedHistory);
        }
      ),
      waitUntilSynced: vi.fn(async () => options.remoteSyncConfirmed ?? true),
    };
    const upsertDocMeta = options.failMetaWrite
      ? vi.fn(async () => {
          calls.push('meta');
          throw new Error('meta write failed');
        })
      : vi.fn(async () => {
          calls.push('meta');
        });
    const deleteDoc = vi.fn(async () => undefined);
    const cleanSessionDoc = vi.fn(async () => undefined);
    const manager = {
      repo: { upsertDocMeta, deleteDoc },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      cleanSessionDoc,
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const service = new LocalProjectHistorySyncService(
      manager as never,
      logger as never,
      {
        workspaceId: 'workspace-1' as never,
        machineId,
        userId: 'user-1',
      },
      provider
    );
    const importNewSession = (
      service as unknown as {
        importNewSession(args: {
          info: { sessionId: string; title: string; updatedAt: string };
          acpSessionId: ACPSessionId;
          project: { kind: 'local'; localProjectId: LocalProjectId };
          materialized: ReturnType<typeof materializedReplay>;
        }): Promise<{ sessionId: SessionId; meta: SessionMeta }>;
      }
    ).importNewSession.bind(service);

    return {
      calls,
      cleanSessionDoc,
      deleteDoc,
      importNewSession,
      logger,
      sessionDoc,
      upsertDocMeta,
      getImportedTurnHashes: () => importedTurnHashes,
      getStoredHistory: () => storedHistory,
    };
  }

  const importArgs = () => ({
    info: {
      sessionId: 'acp-1',
      title: 'Imported conversation',
      updatedAt: '2026-05-14T00:00:00.000Z',
    },
    acpSessionId: 'acp-1' as ACPSessionId,
    project: { kind: 'local' as const, localProjectId },
    materialized: materializedReplay(),
  });

  it('persists complete history before publishing a synced session meta', async () => {
    const harness = createHarness();
    const result = await harness.importNewSession(importArgs());

    expect(harness.calls).toEqual(['history', 'cursor', 'meta']);
    expect(harness.getStoredHistory()).toEqual(importArgs().materialized.history);
    expect(harness.getImportedTurnHashes()).toEqual(['hash-1']);
    expect(harness.upsertDocMeta).toHaveBeenCalledWith(
      getSessionRoomId(result.sessionId),
      expect.objectContaining({
        externalHistory: expect.objectContaining({
          status: 'synced',
          replayDigest: 'digest-new',
          importedTurnCount: 1,
        }),
      })
    );
    expect(harness.sessionDoc.waitUntilSynced).toHaveBeenCalledOnce();
    expect(harness.cleanSessionDoc).toHaveBeenCalledWith(result.sessionId, {
      preserveStatus: true,
    });
    expect(harness.deleteDoc).not.toHaveBeenCalled();
  });

  it('deletes the newly allocated session when persistence fails', async () => {
    const harness = createHarness({ failMetaWrite: true });

    await expect(harness.importNewSession(importArgs())).rejects.toThrow('meta write failed');

    const allocatedSessionId = harness.cleanSessionDoc.mock.calls[0]?.[0] as SessionId;
    expect(harness.deleteDoc).toHaveBeenCalledWith(getSessionRoomId(allocatedSessionId));
    expect(harness.cleanSessionDoc).toHaveBeenCalledWith(allocatedSessionId, {
      preserveStatus: true,
    });
  });

  it('keeps a locally durable import when remote sync is not yet confirmed', async () => {
    const harness = createHarness({ remoteSyncConfirmed: false });

    const result = await harness.importNewSession(importArgs());

    expect(harness.deleteDoc).not.toHaveBeenCalled();
    expect(harness.cleanSessionDoc).toHaveBeenCalledWith(result.sessionId, {
      preserveStatus: true,
    });
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('remains locally durable')
    );
  });
});

describe('getHistoryCatalogStatus', () => {
  it('keeps legacy metadata-only shells available for retry', () => {
    expect(getHistoryCatalogStatus({ meta: sessionMeta() })).toBe('available');
  });

  it('marks fully synchronized imports as imported', () => {
    expect(
      getHistoryCatalogStatus({
        meta: sessionMeta({ externalHistory: externalHistory({ status: 'synced' }) }),
      })
    ).toBe('imported');
  });
});

describe('compareCatalogItems', () => {
  function item(
    overrides: Partial<LocalProjectHistoryCatalogItem> = {}
  ): LocalProjectHistoryCatalogItem {
    return {
      acpSessionId: 'acp-1',
      title: 'Untitled',
      ...overrides,
    };
  }

  it('orders by updatedAt descending (newest first)', () => {
    const older = item({ acpSessionId: 'a', updatedAt: '2026-05-01T00:00:00Z' });
    const newer = item({ acpSessionId: 'b', updatedAt: '2026-05-15T00:00:00Z' });
    const sorted = [older, newer].sort(compareCatalogItems);
    expect(sorted.map((entry) => entry.acpSessionId)).toEqual(['b', 'a']);
  });

  it('falls back to title localeCompare when updatedAt is equal', () => {
    const aaa = item({ acpSessionId: 'a', title: 'Aaa', updatedAt: '2026-05-15T00:00:00Z' });
    const zzz = item({ acpSessionId: 'b', title: 'Zzz', updatedAt: '2026-05-15T00:00:00Z' });
    const sorted = [zzz, aaa].sort(compareCatalogItems);
    expect(sorted.map((entry) => entry.title)).toEqual(['Aaa', 'Zzz']);
  });

  it('treats missing updatedAt as 0 (sorts last)', () => {
    const dated = item({ acpSessionId: 'a', updatedAt: '2026-05-15T00:00:00Z' });
    const undated = item({ acpSessionId: 'b', updatedAt: undefined });
    const sorted = [undated, dated].sort(compareCatalogItems);
    expect(sorted.map((entry) => entry.acpSessionId)).toEqual(['a', 'b']);
  });

  it('treats malformed updatedAt as 0 instead of returning NaN from the comparator', () => {
    // Date.parse on a malformed string returns NaN; an unguarded comparator
    // returns NaN which V8 collapses to 0 ordering but leaves the sort
    // unstable. We require explicit fallback to 0 so the title tie-break runs.
    const malformed = item({
      acpSessionId: 'a',
      title: 'Aaa',
      updatedAt: 'not-a-date',
    });
    const alsoMalformed = item({
      acpSessionId: 'b',
      title: 'Zzz',
      updatedAt: 'also-not-a-date',
    });
    const sorted = [alsoMalformed, malformed].sort(compareCatalogItems);
    // Title tie-break must apply when both updatedAt parse as NaN.
    expect(sorted.map((entry) => entry.title)).toEqual(['Aaa', 'Zzz']);
  });

  it('sorts a mix of valid, missing, and malformed updatedAt deterministically', () => {
    const items = [
      item({ acpSessionId: 'malformed', title: 'B', updatedAt: 'garbage' }),
      item({ acpSessionId: 'old', title: 'A', updatedAt: '2026-01-01T00:00:00Z' }),
      item({ acpSessionId: 'new', title: 'C', updatedAt: '2026-05-15T00:00:00Z' }),
      item({ acpSessionId: 'missing', title: 'A', updatedAt: undefined }),
    ];
    const sorted = [...items].sort(compareCatalogItems);
    expect(sorted.map((entry) => entry.acpSessionId)).toEqual([
      'new',
      'old',
      // 'malformed' and 'missing' both score 0; tie-break on title ('A' before 'B'):
      'missing',
      'malformed',
    ]);
  });
});

describe('selectLatestCatalogItems', () => {
  it('keeps only the newest 100 sessions', () => {
    const items = Array.from(
      { length: 101 },
      (_, index): LocalProjectHistoryCatalogItem => ({
        acpSessionId: `acp-${index}`,
        title: `Session ${index}`,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
      })
    );

    const selected = selectLatestCatalogItems(items);

    expect(selected).toHaveLength(100);
    expect(selected[0]?.acpSessionId).toBe('acp-100');
    expect(selected.at(-1)?.acpSessionId).toBe('acp-1');
    expect(selected.some((item) => item.acpSessionId === 'acp-0')).toBe(false);
  });
});
