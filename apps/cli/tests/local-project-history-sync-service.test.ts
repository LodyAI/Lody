import { describe, expect, it, vi } from 'vitest';
import { getSessionRoomId } from '@lody/shared';
import type {
  ACPSessionId,
  LocalProjectId,
  MachineId,
  SessionHistoryInput,
  SessionId,
  SessionMeta,
} from '@lody/shared';

import { LocalProjectHistorySyncService } from '../src/lib/local-project-history-sync-service';

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
