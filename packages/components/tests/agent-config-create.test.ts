import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import {
  machineFlockKeys,
  serializeMachineFlockKey,
  type AgentConfigId,
  type MachineFlockKey,
  type MachineFlockScanRow,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';

import {
  cmdCreateAgentConfigAtom,
  cmdCreateAgentConfigIfAbsentAtom,
  getAllAgentConfigAtom,
} from '../src/atoms/agents';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms/workspace-context';

function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}

describe('cmdCreateAgentConfigAtom', () => {
  it('authors the machine flock row through the writer and updates agent config atoms without waiting for sync', async () => {
    const store = createStore();
    const workspaceId = 'workspace-agent-config-create-test' as WorkspaceId;
    const workspaceSlug = 'workspace-agent-config-create-test';
    const machineId = 'machine-agent-config-create-test' as MachineId;
    const rows = new Map<string, MachineFlockScanRow>();
    const fakeFlock = {
      scan: vi.fn(() => rows.values()),
      set: vi.fn((key: MachineFlockKey, value: unknown) => {
        rows.set(serializeMachineFlockKey(key), { key, value });
      }),
      delete: vi.fn((key: MachineFlockKey) => {
        rows.delete(serializeMachineFlockKey(key));
      }),
      commit: vi.fn(),
    };
    const flush = vi.fn(() => never());
    const openFlockDoc = vi.fn(async () => ({
      flock: fakeFlock,
      syncOnce: vi.fn(() => never()),
      joinRoom: vi.fn(),
    }));

    // The write is authored through the writer seam. In this direct-mode mock the
    // writer applies the row into the same fake flock the read-back reads, so the
    // agent-config atom converges without awaiting any remote sync.
    const flockRowPut = vi.fn(async (_docId: string, key: MachineFlockKey, value: unknown) => {
      rows.set(serializeMachineFlockKey(key), { key, value });
    });

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc, flush },
      writer: { flockRowPut } as unknown as WorkspaceRuntime['writer'],
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const createPromise = store.set(cmdCreateAgentConfigAtom, {
      id: 'config-immediate-acp' as AgentConfigId,
      machineId,
      name: 'Immediate ACP Provider',
      description: undefined,
      cliType: 'custom',
      agentType: 'custom-immediate-acp',
      customAcp: { command: 'node', args: ['server.js'] },
      env: { API_KEY: 'test' },
      prompt: 'use this provider',
    });

    const result = await Promise.race([
      createPromise.then((agentId) => ({ status: 'created' as const, agentId })),
      new Promise<{ status: 'timed-out' }>((resolve) => {
        setTimeout(() => resolve({ status: 'timed-out' }), 20);
      }),
    ]);

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    const createdId = result.agentId as AgentConfigId;
    const rowId = serializeMachineFlockKey(machineFlockKeys.agentConfig(createdId));
    const createdRow = rows.get(rowId);

    expect(flockRowPut).toHaveBeenCalledWith(
      `${workspaceId}:mf:${machineId}`,
      machineFlockKeys.agentConfig(createdId),
      expect.objectContaining({ id: createdId, machineId })
    );
    expect(createdRow?.value).toMatchObject({
      id: createdId,
      machineId,
      name: 'Immediate ACP Provider',
      cliType: 'custom',
      agentType: 'custom-immediate-acp',
      customAcp: { command: 'node', args: ['server.js'] },
      env: { API_KEY: 'test' },
      prompt: 'use this provider',
    });

    expect(store.get(getAllAgentConfigAtom)).toEqual([
      expect.objectContaining({
        id: createdId,
        machineId,
        name: 'Immediate ACP Provider',
      }),
    ]);
  });
});

describe('cmdCreateAgentConfigIfAbsentAtom', () => {
  it('keeps an existing row unchanged when an idempotent create is retried', async () => {
    const store = createStore();
    const workspaceId = 'workspace-agent-config-create-if-absent' as WorkspaceId;
    const workspaceSlug = 'workspace-agent-config-create-if-absent';
    const machineId = 'machine-agent-config-create-if-absent' as MachineId;
    const configId = 'builtin-pi:machine-agent-config-create-if-absent' as AgentConfigId;
    const key = machineFlockKeys.agentConfig(configId);
    const existing = {
      id: configId,
      machineId,
      name: 'My managed Pi',
      description: undefined,
      cliType: 'builtin' as const,
      agentType: 'pi',
      env: { PI_CODING_AGENT_DIR: '/synthetic/profile' },
    };
    const rows = new Map<string, MachineFlockScanRow>([
      [serializeMachineFlockKey(key), { key, value: existing }],
    ]);
    const openFlockDoc = vi.fn(async () => ({
      flock: { scan: vi.fn(() => rows.values()) },
      syncOnce: vi.fn(() => never()),
      joinRoom: vi.fn(),
    }));
    const flockRowPutIfAbsent = vi.fn(async () => ({ inserted: false, value: existing }));

    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug,
      repo: { openFlockDoc, flush: vi.fn(() => never()) },
      writer: { flockRowPutIfAbsent } as unknown as WorkspaceRuntime['writer'],
    } as unknown as WorkspaceRuntime);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, workspaceSlug);

    const result = await store.set(cmdCreateAgentConfigIfAbsentAtom, {
      ...existing,
      name: 'Pi',
      env: {},
    });

    expect(result).toEqual({ id: configId, inserted: false });
    expect(flockRowPutIfAbsent).toHaveBeenCalledWith(
      `${workspaceId}:mf:${machineId}`,
      key,
      expect.objectContaining({ id: configId, name: 'Pi', env: {} })
    );
    expect(store.get(getAllAgentConfigAtom)).toEqual([existing]);
  });
});
