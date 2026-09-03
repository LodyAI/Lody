import { describe, expect, it, vi } from 'vitest';
import { getSessionRoomId, parseSessionNotification } from '@lody/shared';
import type {
  ACPSessionId,
  AcpSessionNotification,
  ExternalAcpHistorySyncMeta,
  LocalProjectId,
  MachineId,
  SessionHistoryInput,
  SessionId,
  SessionMeta,
} from '@lody/shared';
import { HASH_VERSION, hashHistoryEntry, hashText, materializeReplay } from '@lody/history-import';

import { LocalProjectHistorySyncService } from '../src/lib/local-project-history-sync-service';
import { loadHistorySessionReplay } from '../src/lib/history-session-catalog-client';

vi.mock('../src/lib/history-session-catalog-client', () => ({
  listHistorySessionsForLocalProject: vi.fn(),
  loadHistorySessionReplay: vi.fn(),
}));

const machineId = 'machine-1' as MachineId;
const localProjectId = 'project-1' as LocalProjectId;
const provider = { cliType: 'builtin', agentType: 'codex' } as const;

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
    hashVersion: number;
  }> = {}
) {
  return {
    history: [historyEntry()],
    turnHashes: ['hash-1'],
    replayDigest: 'digest-new',
    droppedNotifications: 0,
    hashVersion: 2,
    ...overrides,
  };
}
describe('history import persistence', () => {
  function createHarness(options: { failMetaWrite?: boolean; remoteSyncConfirmed?: boolean } = {}) {
    let storedHistory: SessionHistoryInput[] = [];
    let importedTurnHashes: string[] = [];
    const calls: string[] = [];
    const sessionDoc = {
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
    expect(harness.sessionDoc.setExternalHistoryCursor).toHaveBeenCalledWith({
      importedTurnHashes: ['hash-1'],
      hashVersion: 2,
    });
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

const REPLAY_NOW = '2026-05-14T00:00:00.000Z';
const acpSessionId = 'acp-1' as ACPSessionId;

function makeNotification(update: unknown): AcpSessionNotification {
  return parseSessionNotification({ sessionId: acpSessionId, update });
}

/** Two turns (user, assistant with a tool call) followed by one more user turn. */
function replayNotificationsPrefix(): AcpSessionNotification[] {
  return [
    makeNotification({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'inspect repo' },
    }),
    makeNotification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      kind: 'read',
      title: 'Read package.json',
      status: 'completed',
      rawInput: { path: 'package.json' },
      rawOutput: { output: '{ "name": "lody" }' },
    }),
    makeNotification({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Done.' },
    }),
  ];
}

function replayNotificationsFull(): AcpSessionNotification[] {
  return [
    ...replayNotificationsPrefix(),
    makeNotification({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'continue' },
    }),
  ];
}

function materialize(notifications: AcpSessionNotification[]) {
  return materializeReplay({
    provider,
    acpSessionId,
    replayNotifications: notifications,
    userId: 'user-1',
    nowIso: REPLAY_NOW,
  });
}

/** The cursor an old (pre-hashVersion) CLI would have written: v1 hashes, no version. */
function v1Cursor(history: readonly SessionHistoryInput[]) {
  const importedTurnHashes = history.map(hashHistoryEntry);
  return { importedTurnHashes, replayDigest: hashText(importedTurnHashes.join('\n')) };
}

describe('history refresh with mixed hash versions', () => {
  const sessionId = 'session-1' as SessionId;

  function createRefreshHarness(args: {
    storedCursor: { importedTurnHashes: string[] };
    storedHistory: SessionHistoryInput[];
  }) {
    let storedHistory = [...args.storedHistory];
    const sessionDoc = {
      getExternalHistoryCursor: vi.fn(async () => ({ ...args.storedCursor })),
      setExternalHistoryCursor: vi.fn(async () => undefined),
      getHistory: vi.fn(async () => [...storedHistory]),
      updateHistory: vi.fn(
        async (update: (history: SessionHistoryInput[]) => SessionHistoryInput[]) => {
          storedHistory = update(storedHistory);
        }
      ),
      waitUntilSynced: vi.fn(async () => true),
    };
    const upsertDocMeta = vi.fn(async () => undefined);
    const manager = {
      repo: { upsertDocMeta, deleteDoc: vi.fn(async () => undefined) },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      cleanSessionDoc: vi.fn(async () => undefined),
    };
    const service = new LocalProjectHistorySyncService(
      manager as never,
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      { workspaceId: 'workspace-1' as never, machineId, userId: 'user-1' },
      provider
    );
    const refreshExistingSession = (
      service as unknown as {
        refreshExistingSession(args: {
          existing: { sessionId: SessionId; meta: SessionMeta };
          info: { sessionId: string; title: string; updatedAt: string };
          acpSessionId: ACPSessionId;
          rootPath: string;
        }): Promise<'refreshed' | 'skipped' | 'conflicted'>;
      }
    ).refreshExistingSession.bind(service);

    return {
      refreshExistingSession,
      sessionDoc,
      upsertDocMeta,
      getStoredHistory: () => storedHistory,
    };
  }

  function v1ExternalHistory(stored: { replayDigest: string }, importedTurnCount: number) {
    return {
      provider,
      source: 'local-acp-history',
      sourceAcpSessionId: acpSessionId,
      replayDigest: stored.replayDigest,
      importedTurnCount,
      lastSyncAt: 1,
      status: 'synced',
    } satisfies ExternalAcpHistorySyncMeta;
  }

  function existingSession(externalHistory: ExternalAcpHistorySyncMeta) {
    const meta = {
      id: sessionId,
      machineId,
      createdAt: '2026-05-01T00:00:00.000Z',
      userId: 'user-1',
      isArchived: false,
      cliType: provider.cliType,
      agentType: provider.agentType,
      project: { kind: 'local', localProjectId },
      externalHistory,
    } as SessionMeta;
    return { sessionId, meta };
  }

  const refreshArgs = (externalHistory: ExternalAcpHistorySyncMeta) => ({
    existing: existingSession(externalHistory),
    info: {
      sessionId: 'acp-1',
      title: 'Imported conversation',
      updatedAt: '2026-05-15T00:00:00.000Z',
    },
    acpSessionId,
    rootPath: '/root',
  });

  it('matches a v1 cursor written by an old CLI against a v2 replay without conflict', async () => {
    const replay = materialize(replayNotificationsFull());
    const stored = v1Cursor(replay.history);
    const harness = createRefreshHarness({
      storedCursor: { importedTurnHashes: stored.importedTurnHashes },
      storedHistory: replay.history,
    });
    vi.mocked(loadHistorySessionReplay).mockResolvedValue(replayNotificationsFull());

    const result = await harness.refreshExistingSession(
      refreshArgs(v1ExternalHistory(stored, replay.turnHashes.length))
    );

    expect(result).toBe('skipped');
    // The cursor is upgraded in place to the v2 hashes the new meta records.
    expect(harness.sessionDoc.setExternalHistoryCursor).toHaveBeenCalledWith({
      importedTurnHashes: replay.turnHashes,
      hashVersion: HASH_VERSION,
    });
    expect(harness.upsertDocMeta).toHaveBeenCalledWith(
      getSessionRoomId(sessionId),
      expect.objectContaining({
        externalHistory: expect.objectContaining({
          status: 'synced',
          hashVersion: HASH_VERSION,
          replayDigest: replay.replayDigest,
        }),
      })
    );
  });

  it('appends the replay suffix against a v1 stored prefix instead of conflicting', async () => {
    const prefixReplay = materialize(replayNotificationsPrefix());
    const fullReplay = materialize(replayNotificationsFull());
    const stored = v1Cursor(prefixReplay.history);
    const harness = createRefreshHarness({
      storedCursor: { importedTurnHashes: stored.importedTurnHashes },
      storedHistory: prefixReplay.history,
    });
    vi.mocked(loadHistorySessionReplay).mockResolvedValue(replayNotificationsFull());

    const result = await harness.refreshExistingSession(
      refreshArgs(v1ExternalHistory(stored, prefixReplay.turnHashes.length))
    );

    expect(result).toBe('refreshed');
    // Only the new suffix turn was appended to the locally stored prefix. (The
    // suffix row carries the service's own import-time timestamp, so compare
    // transcript content, not the injected-clock fields.)
    const storedHistory = harness.getStoredHistory();
    expect(storedHistory.slice(0, prefixReplay.history.length)).toEqual(prefixReplay.history);
    expect(storedHistory).toHaveLength(fullReplay.history.length);
    expect(storedHistory.at(-1)).toMatchObject({
      role: 'user',
      items: [{ type: 'text', text: 'continue' }],
    });
    expect(harness.sessionDoc.setExternalHistoryCursor).toHaveBeenCalledWith({
      importedTurnHashes: fullReplay.turnHashes,
      hashVersion: HASH_VERSION,
    });
    expect(harness.upsertDocMeta).toHaveBeenCalledWith(
      getSessionRoomId(sessionId),
      expect.objectContaining({
        externalHistory: expect.objectContaining({
          status: 'synced',
          hashVersion: HASH_VERSION,
        }),
      })
    );
  });
});
