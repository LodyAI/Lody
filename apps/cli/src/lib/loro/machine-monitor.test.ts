import { describe, expect, it, vi } from 'vitest';
import { EphemeralStore, type Value } from 'loro-crdt';
import {
  getMachineMonitorObserverKey,
  getServerNow,
  parseMachineMonitorStates,
  type MachineId,
  type MachineMonitorObserverState,
  type MachineMonitorSnapshot,
  type WorkspaceId,
} from '@lody/shared';
import { CliMachineMonitorRuntime } from './machine-monitor';

const MACHINE_ID = 'machine-1' as MachineId;

describe('CliMachineMonitorRuntime local data plane', () => {
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

function observer(machineId: string, expiresAtMs: number, forceSampleAtMs: number | null) {
  return {
    kind: 'observer' as const,
    protocolVersion: 1 as const,
    machineId: machineId as MachineId,
    observerId: `observer-${machineId}`,
    updatedAtMs: 10,
    expiresAtMs,
    forceSampleAtMs,
  };
}

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
