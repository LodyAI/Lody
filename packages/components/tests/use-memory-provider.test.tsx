// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { MachineId, MemoryProviderResponse } from '@lody/shared';
const state = vi.hoisted(() => ({ runtime: {} as unknown }));
vi.mock('jotai', () => ({ useAtomValue: () => state.runtime }));
vi.mock('@/atoms/runtime', () => ({ activeWorkspaceRuntimeAtom: {} }));
import { useMemoryProvider } from '../src/hooks/use-memory-provider';

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
});

it('discards a late reply after switching machines and refreshes the selected machine after creation', async () => {
  const pending = new Map<string, (value: MemoryProviderResponse) => void>();
  state.runtime = {
    requestMemoryProvider: (machineId: string) =>
      new Promise<MemoryProviderResponse>((resolve) => pending.set(machineId, resolve)),
  };
  let snapshot: ReturnType<typeof useMemoryProvider> | undefined;
  function Harness({ machine }: { machine: string }) {
    snapshot = useMemoryProvider(machine as MachineId, 'nowledge-mem', true);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  await act(async () => root.render(<Harness machine="a" />));
  await act(async () => root.render(<Harness machine="b" />));
  const result = (id: string): MemoryProviderResponse => ({
    type: 'machine/memory',
    status: 'ready',
    memories: [{ id, name: id }],
  });
  await act(async () => pending.get('a')?.(result('old')));
  expect(snapshot?.result).toBeUndefined();
  expect(snapshot?.busy).toBe(true);
  await act(async () => pending.get('b')?.(result('current')));
  expect(snapshot?.result?.memories.map((value) => value.id)).toEqual(['current']);
  let creation: Promise<MemoryProviderResponse | undefined> | undefined;
  await act(async () => {
    creation = snapshot?.create({ id: 'created' });
  });
  await act(async () => {
    pending.get('b')?.(result('created'));
    await creation;
  });
  expect(snapshot?.result?.memories.map((value) => value.id)).toEqual(['created']);
});
