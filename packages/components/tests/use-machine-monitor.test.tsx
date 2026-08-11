// @vitest-environment jsdom

import { act } from 'react';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { MachineId, MachineMonitorSnapshot, WorkspaceId } from '@lody/shared';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { useMachineMonitor } from '../src/hooks/use-machine-monitor';

const machineId = 'machine-test' as MachineId;
const resource = {
  memoryBytes: 128,
  cpuCores: 0.1,
  cpuPercentOfMachine: 1,
  processCount: 1,
  memoryKind: 'rss' as const,
  quality: 'exact-process' as const,
};
const snapshot: MachineMonitorSnapshot = {
  kind: 'snapshot',
  protocolVersion: 1,
  machineId,
  instanceId: 'cli-test',
  updatedAtMs: 42,
  sampleWindowMs: 2_000,
  platform: 'darwin',
  cpuLogicalCores: 8,
  deviceCpuCores: 1,
  effectiveMemoryBytes: 1_024,
  availableMemoryBytes: 512,
  sessionAccounting: 'process-tree',
  cliControlPlane: resource,
  sessionsAggregate: resource,
  sessions: [],
  sessionsTruncated: false,
  warnings: [],
};

function MonitorProbe({ selected }: { selected: boolean }) {
  const monitor = useMachineMonitor({
    machineId: selected ? machineId : null,
    enabled: selected,
    online: selected,
  });
  return <div data-testid="snapshot">{monitor.snapshot?.updatedAtMs ?? 'none'}</div>;
}

describe('useMachineMonitor', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let emit: ((snapshot: MachineMonitorSnapshot | null) => void) | undefined;
  const store = createStore();

  const renderProbe = async (selected: boolean) => {
    await act(async () => {
      root?.render(
        <Provider store={store}>
          <MonitorProbe selected={selected} />
        </Provider>
      );
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    emit = undefined;
    store.set(runtimeAtom, {
      workspaceId: 'workspace-test' as WorkspaceId,
      workspaceSlug: 'workspace-test',
      subscribeMachineMonitor: (_machineId, listener) => {
        emit = listener;
        return vi.fn();
      },
      forceMachineMonitorSample: vi.fn(),
    } as unknown as WorkspaceRuntime);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    store.set(runtimeAtom, null);
  });

  it('reuses the last snapshot when the same machine is expanded again', async () => {
    await renderProbe(true);
    await act(async () => emit?.(snapshot));
    expect(container?.textContent).toBe('42');

    await renderProbe(false);
    expect(container?.textContent).toBe('none');

    await renderProbe(true);
    expect(container?.textContent).toBe('42');
  });
});
