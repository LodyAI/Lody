import { updateTestHistory } from '../../../tests/history-port-fixture';
import { describe, expect, it, vi } from 'vitest';
import {
  getMachineMonitorObserverKey,
  getServerNow,
  getSessionRoomId,
  parseMachineMonitorStates,
  SessionStatusFactory,
  type MachineId,
  type MachineMonitorObserverState,
  type MachineMonitorSnapshot,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import { EphemeralStore, LoroDoc, LoroList, LoroMap, type Value } from 'loro-crdt';
import type { LoroRepo } from 'loro-repo';
import type { Logger } from '@/utils/logger';
import { SessionDocument } from './doc';
import { CliMachineMonitorRuntime } from './machine-monitor';
import { composeTestSessionDoc } from '../../../tests/session-doc-fixture';

const historyEntry = (id: string, role: 'user' | 'assistant') => ({
  id,
  timestamp: '2026-08-29T00:00:00.000Z',
  role,
  fileDiff: [],
});

const createDocument = () => {
  const doc = new SessionDocument(
    {} as LoroRepo,
    'session-runtime-config' as SessionId,
    async () => {},
    {
      debug: vi.fn(),
      trace: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger
  );
  // Compose the production storage entry and seed the initial user turn
  // through the shared writer, matching how `init()` sees a persisted doc.
  composeTestSessionDoc(doc, { history: [historyEntry('turn-1', 'user')] });
  return doc;
};

describe('SessionDocument ACP runtime config', () => {
  it('keeps commands within one runtime across turns, clears them, and replaces the runtime', async () => {
    const doc = createDocument();
    await doc.applyAcpRuntimeConfigPatch('turn-1', {
      acpSessionId: 'acp-1' as never,
      availableCommands: [{ name: 'review-a', description: 'Review A' }],
    });
    expect(
      await doc.applyAcpRuntimeConfigPatch('turn-1', {
        acpSessionId: 'acp-1' as never,
        availableCommands: [{ name: 'review-a', description: 'Review A' }],
      })
    ).toBe(false);
    await updateTestHistory(doc, (history) => [...history, historyEntry('turn-2', 'user')]);
    await doc.applyAcpRuntimeConfigPatch('turn-2', {
      acpSessionId: 'acp-1' as never,
      modelId: 'model-b',
    });
    expect(doc.mirror?.getState().acpRuntimeConfig?.availableCommands).toEqual([
      { name: 'review-a', description: 'Review A' },
    ]);
    expect(
      await doc.applyAcpRuntimeConfigPatch('turn-1', {
        acpSessionId: 'acp-1' as never,
        availableCommands: [{ name: 'stale' }],
      })
    ).toBe(false);
    await doc.applyAcpRuntimeConfigPatch('turn-2', {
      acpSessionId: 'acp-1' as never,
      availableCommands: [],
    });
    expect(doc.mirror?.getState().acpRuntimeConfig?.availableCommands).toEqual([]);
    expect(
      await doc.applyAcpRuntimeConfigPatch('turn-2', {
        acpSessionId: 'acp-1' as never,
        availableCommands: [],
      })
    ).toBe(false);
    await doc.applyAcpRuntimeConfigPatch('turn-2', {
      acpSessionId: 'acp-2' as never,
      availableCommands: [{ name: 'review-b' }],
    });
    expect(doc.mirror?.getState().acpRuntimeConfig?.availableCommands).toEqual([
      { name: 'review-b' },
    ]);
    await doc.applyAcpRuntimeConfigPatch('turn-2', { acpSessionId: 'acp-3' as never });
    expect(doc.mirror?.getState().acpRuntimeConfig?.availableCommands).toBeUndefined();
  });

  it('applies out-of-turn commands only to the snapshot of the same runtime', async () => {
    const doc = createDocument();
    const commands = (name: string) => ({
      acpSessionId: 'acp-1' as never,
      availableCommands: [{ name }],
    });
    // Before any run-config snapshot exists the next turn's capture carries the list.
    expect(await doc.applyAcpRuntimeConfigPatchToCurrentSnapshot(commands('early'))).toBe(false);
    expect(doc.mirror?.getState().acpRuntimeConfig?.availableCommands).toBeUndefined();

    await doc.applyAcpRuntimeConfigPatch('turn-1', {
      acpSessionId: 'acp-1' as never,
      modelId: 'm',
    });
    expect(await doc.applyAcpRuntimeConfigPatchToCurrentSnapshot(commands('goal'))).toBe(true);
    expect(doc.mirror?.getState().acpRuntimeConfig).toMatchObject({
      basedOnUserTurnId: 'turn-1',
      modelId: 'm',
      availableCommands: [{ name: 'goal' }],
    });

    expect(
      await doc.applyAcpRuntimeConfigPatchToCurrentSnapshot({
        acpSessionId: 'acp-old' as never,
        availableCommands: [{ name: 'stale' }],
      })
    ).toBe(false);
    // A newer user turn whose run config has not been captured yet is not overwritten.
    await updateTestHistory(doc, (history) => [...history, historyEntry('turn-2', 'user')]);
    expect(await doc.applyAcpRuntimeConfigPatchToCurrentSnapshot(commands('late'))).toBe(false);
    expect(doc.mirror?.getState().acpRuntimeConfig?.availableCommands).toEqual([{ name: 'goal' }]);
  });

  it('never persists sensitive option ids even when a caller passes them directly', async () => {
    const doc = createDocument();

    expect(
      await doc.applyAcpRuntimeConfigPatch('turn-1', {
        acpSessionId: 'acp-sensitive' as never,
        configOptionValues: {
          api_token: 'secret-value',
          credential: 'also-secret',
          reasoning_effort: 'high',
        },
      })
    ).toBe(true);
    expect(doc.mirror?.getState().acpRuntimeConfig).toEqual({
      acpSessionId: 'acp-sensitive',
      basedOnUserTurnId: 'turn-1',
      revision: 1,
      configOptionValues: { reasoning_effort: 'high' },
    });
  });
});

describe('SessionDocument status metadata', () => {
  const createLogger = (): Logger =>
    ({
      debug: vi.fn(),
      trace: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }) as unknown as Logger;

  const createSessionDocument = (
    repo: Partial<LoroRepo>,
    unloadDocRoom: (docId: string) => Promise<void> = async () => {},
    loroDoc?: LoroDoc
  ): SessionDocument => {
    const doc = new SessionDocument(
      repo as LoroRepo,
      'session-status-1' as SessionId,
      unloadDocRoom,
      createLogger()
    );
    composeTestSessionDoc(doc, loroDoc ? { doc: loroDoc } : undefined);
    return doc;
  };

  it('rolls child lastMessageAt up to the parent session', async () => {
    const parentSessionId = 'parent-session-1' as SessionId;
    const childRoomId = getSessionRoomId('session-status-1' as SessionId);
    const parentRoomId = getSessionRoomId(parentSessionId);
    const upsertDocMeta = vi.fn(async () => {});
    const doc = createSessionDocument({
      getDocMeta: vi.fn(async (roomId: string) => {
        if (roomId === childRoomId) {
          return { meta: { parentSessionId } };
        }
        if (roomId === parentRoomId) {
          return { meta: { lastMessageAt: 1_000 } };
        }
        return { meta: {} };
      }),
      upsertDocMeta,
    });

    await doc.setLastMessageAt(2_000);

    expect(upsertDocMeta).toHaveBeenCalledWith(doc.roomId, {
      lastMessageAt: 2_000,
    });
    expect(upsertDocMeta).toHaveBeenCalledWith(parentRoomId, {
      lastMessageAt: 2_000,
    });
  });

  it('does not move parent lastMessageAt backwards', async () => {
    const parentSessionId = 'parent-session-1' as SessionId;
    const childRoomId = getSessionRoomId('session-status-1' as SessionId);
    const parentRoomId = getSessionRoomId(parentSessionId);
    const upsertDocMeta = vi.fn(async () => {});
    const doc = createSessionDocument({
      getDocMeta: vi.fn(async (roomId: string) => {
        if (roomId === childRoomId) {
          return { meta: { parentSessionId } };
        }
        if (roomId === parentRoomId) {
          return { meta: { lastMessageAt: 3_000 } };
        }
        return { meta: {} };
      }),
      upsertDocMeta,
    });

    await doc.setLastMessageAt(2_000);

    expect(upsertDocMeta).toHaveBeenCalledWith(doc.roomId, {
      lastMessageAt: 2_000,
    });
    expect(upsertDocMeta).not.toHaveBeenCalledWith(parentRoomId, expect.anything());
  });

  it('resets initializing status to idle during destroy without publishing presence', async () => {
    const upsertDocMeta = vi.fn(async () => {});
    const unloadDoc = vi.fn(async () => {});
    const unloadDocRoom = vi.fn(async () => {});
    const doc = createSessionDocument(
      {
        getDocMeta: vi.fn(async () => ({
          meta: {
            machineId: 'machine-1',
            status: SessionStatusFactory.initializing(),
          },
        })),
        unloadDoc,
        upsertDocMeta,
      },
      unloadDocRoom
    );

    await doc.destroy();

    expect(upsertDocMeta).toHaveBeenCalledWith(
      doc.roomId,
      expect.objectContaining({
        status: SessionStatusFactory.idle(),
      })
    );
    expect(unloadDocRoom).toHaveBeenCalledWith(doc.roomId);
    expect(unloadDoc).not.toHaveBeenCalled();
  });
});

describe('SessionDocument.appendUserTurn', () => {
  it('opens old malformed notices without sanitizing stored history', () => {
    const loro = new LoroDoc();
    const row = loro.getList('history').pushContainer(new LoroMap());
    row.set('id', 'legacy');
    row.set('role', 'assistant');
    row.set('timestamp', 'synthetic');
    const notice = row.setContainer('items', new LoroList()).pushContainer(new LoroMap());
    notice.set('type', 'system_notice');
    notice.set('name', 'future_notice');
    notice.set('meta', 42);
    loro.commit();
    const version = loro.version().toJSON();
    const history = loro.getList('history').toJSON();
    const doc = new SessionDocument(
      {} as LoroRepo,
      'session-append-1' as SessionId,
      async () => {},
      {
        debug: vi.fn(),
        trace: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as Logger
    );
    composeTestSessionDoc(doc, { doc: loro });
    expect(loro.version().toJSON()).toEqual(version);
    expect(loro.getList('history').toJSON()).toEqual(history);
    doc.mirror?.dispose();
  });
});

describe('CliMachineMonitorRuntime local data plane', () => {
  const MACHINE_ID = 'machine-1' as MachineId;

  function snapshot(): MachineMonitorSnapshot {
    const resource = {
      memoryBytes: 1,
      cpuCores: 0,
      cpuPercentOfMachine: 0,
      processCount: 1,
      memoryKind: 'rss' as const,
      quality: 'exact-process' as const,
    };
    return {
      kind: 'snapshot',
      protocolVersion: 1,
      machineId: MACHINE_ID,
      instanceId: 'instance-1',
      updatedAtMs: 1,
      sampleWindowMs: 1,
      platform: 'linux',
      cpuLogicalCores: 1,
      effectiveMemoryBytes: 1,
      availableMemoryBytes: 1,
      sessionAccounting: 'process-tree',
      cliControlPlane: resource,
      sessionsAggregate: resource,
      sessions: [],
      sessionsTruncated: false,
      warnings: [],
    };
  }

  it('samples for a local observer without attaching cloud Streams', async () => {
    const runtime = new CliMachineMonitorRuntime({
      workspaceId: 'workspace-1' as WorkspaceId,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const sample = vi.fn(async () => snapshot());
    runtime.configure(MACHINE_ID, sample);
    const observerStore = new EphemeralStore(30_000);
    const nowMs = getServerNow();
    const state: MachineMonitorObserverState = {
      kind: 'observer',
      protocolVersion: 1,
      machineId: MACHINE_ID,
      observerId: 'local-renderer',
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + 30_000,
      forceSampleAtMs: null,
    };
    observerStore.set(
      getMachineMonitorObserverKey(MACHINE_ID, state.observerId),
      state as unknown as Value
    );

    runtime.applyLocalState(observerStore.encodeAll());
    await vi.waitFor(() => expect(sample).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      const copy = new EphemeralStore(30_000);
      copy.apply(runtime.encodeLocalState());
      const states = parseMachineMonitorStates(copy.getAllStates());
      copy.destroy();
      expect(Object.values(states)).toContainEqual(snapshot());
    });

    observerStore.destroy();
    await runtime.stop();
  });
});
