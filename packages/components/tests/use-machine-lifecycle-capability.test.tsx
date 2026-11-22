// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { MachineId, MachineLifecycleCapability } from '@lody/shared';

const ports = vi.hoisted(() => ({ runtime: null as unknown, runtimeAtom: {}, workspaceAtom: {} }));
vi.mock('@/atoms/runtime', () => ({ activeWorkspaceRuntimeAtom: ports.runtimeAtom }));
vi.mock('@/atoms/workspace-context', () => ({ currentWorkspaceIdAtom: ports.workspaceAtom }));
vi.mock('jotai', () => ({
  useAtomValue: (atom: unknown) => (atom === ports.runtimeAtom ? ports.runtime : 'workspace'),
}));
import { useMachineLifecycleCapability } from '../src/hooks/use-machine-lifecycle-capability';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const legacyParams = z.object({ includeDisk: z.literal(true).optional() }).strict();
const lifecycle: MachineLifecycleCapability = {
  launchMode: 'daemon',
  canRemoteRestart: true,
  canRemoteUpgrade: true,
};
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

it.each([false, true])(
  'preserves old-daemon restart across strict status rejection, advertised extension=%s',
  async (advertised) => {
    vi.useFakeTimers();
    const controls: Record<string, unknown>[] = [];
    let settle: (value: unknown) => void = () => {};
    ports.runtime = {
      waitForMachineStatusResponse: () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
      sendControl: (message: Record<string, unknown>) => {
        controls.push(message);
        const { type: _type, machineId: _machine, workspaceId: _workspace, ...params } = message;
        const accepted = legacyParams.safeParse(params).success;
        settle(
          accepted ? { success: true, lifecycle } : { success: false, error: 'unrecognized_keys' }
        );
      },
    };
    let observed: MachineLifecycleCapability | null = null;
    const receive = () => {};
    function Probe() {
      observed = useMachineLifecycleCapability({
        machineId: 'machine' as MachineId,
        enabled: true,
        supportsUpdateStatus: advertised,
        onUpdateStatus: receive,
      });
      return null;
    }
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Probe />));
    expect(controls[0]).not.toHaveProperty('includeDaemonUpdate');
    expect(observed).toEqual(lifecycle);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(observed).toEqual(lifecycle);
    if (advertised) expect(controls[1]).toHaveProperty('includeDaemonUpdate', true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(controls.at(-1)).not.toHaveProperty('includeDaemonUpdate');
    expect(observed).toEqual(lifecycle);
  }
);
