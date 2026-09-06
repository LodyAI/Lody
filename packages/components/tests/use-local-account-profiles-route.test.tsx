// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId } from '@lody/shared';

import { useLocalAccountProfilesRoute } from '../src/hooks/use-local-account-profiles-route';

const mocks = vi.hoisted(() => ({
  runtime: null as null | { resolveMachineTargetPlane: ReturnType<typeof vi.fn> },
  localMachineId: 'local-machine' as string | null,
  ipc: vi.fn(),
}));
vi.mock('../src/atoms/runtime', () => ({ activeWorkspaceRuntimeAtom: 'runtime' }));
vi.mock('../src/atoms/local-probe', () => ({ localMachineIdAtom: 'local-machine' }));
vi.mock('jotai', () => ({
  useAtomValue: (atom: string) => (atom === 'runtime' ? mocks.runtime : mocks.localMachineId),
}));
vi.mock('../src/lib/electron-ipc-client', () => ({ getIpcServices: mocks.ipc }));

let root: Root;
let container: HTMLDivElement;
let rendered: boolean[];
function Surface({ machineId, enabled }: { machineId: string; enabled: boolean }) {
  const local = useLocalAccountProfilesRoute(machineId as MachineId, enabled);
  rendered.push(local);
  return local ? <button>Account controls</button> : null;
}
async function render(machineId = 'local-machine', enabled = true) {
  await act(async () => root.render(<Surface machineId={machineId} enabled={enabled} />));
}
function controlsVisible() {
  return container.querySelector('button') !== null;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__LODY_ELECTRON__', true);
  mocks.ipc.mockReturnValue({});
  mocks.runtime = { resolveMachineTargetPlane: vi.fn().mockResolvedValue('local') };
  mocks.localMachineId = 'local-machine';
  rendered = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('local account-control route', () => {
  it.each(['browser', 'missing bridge', 'missing runtime'])(
    '%s does not resolve or show controls',
    async (kind) => {
      const runtime = mocks.runtime!;
      if (kind === 'browser') vi.stubGlobal('__LODY_ELECTRON__', false);
      if (kind === 'missing bridge') mocks.ipc.mockReturnValue(null);
      if (kind === 'missing runtime') mocks.runtime = null;
      await render();
      expect(runtime.resolveMachineTargetPlane).not.toHaveBeenCalled();
      expect(controlsVisible()).toBe(false);
    }
  );

  it('waits for runtime confirmation rather than accepting a matching local probe id', async () => {
    const pending = Promise.withResolvers<'local' | 'cloud'>();
    mocks.runtime!.resolveMachineTargetPlane.mockReturnValue(pending.promise);
    await render();
    expect(controlsVisible()).toBe(false);
    expect(mocks.runtime!.resolveMachineTargetPlane).toHaveBeenCalledWith('local-machine');
    await act(async () => pending.resolve('cloud'));
    expect(controlsVisible()).toBe(false);
  });

  it('shows controls only after a local route resolves', async () => {
    const pending = Promise.withResolvers<'local'>();
    mocks.runtime!.resolveMachineTargetPlane.mockReturnValue(pending.promise);
    await render();
    expect(controlsVisible()).toBe(false);
    await act(async () => pending.resolve('local'));
    expect(controlsVisible()).toBe(true);
  });

  it('does no route work while hidden and ignores a request that completes after hiding', async () => {
    const pending = Promise.withResolvers<'local'>();
    mocks.runtime!.resolveMachineTargetPlane.mockReturnValue(pending.promise);
    await render('local-machine', false);
    expect(mocks.runtime!.resolveMachineTargetPlane).not.toHaveBeenCalled();
    await render();
    expect(mocks.runtime!.resolveMachineTargetPlane).toHaveBeenCalledTimes(1);
    await render('local-machine', false);
    await act(async () => pending.resolve('local'));
    expect(controlsVisible()).toBe(false);
    expect(mocks.runtime!.resolveMachineTargetPlane).toHaveBeenCalledTimes(1);
    await render();
    expect(controlsVisible()).toBe(true);
    expect(mocks.runtime!.resolveMachineTargetPlane).toHaveBeenCalledTimes(2);
  });

  it('never renders the previous machine route while the next target is pending', async () => {
    await render();
    expect(controlsVisible()).toBe(true);
    const pending = Promise.withResolvers<'cloud'>();
    mocks.runtime!.resolveMachineTargetPlane.mockReturnValue(pending.promise);
    rendered = [];
    await render('remote-machine');
    expect(rendered.every((local) => !local)).toBe(true);
    await act(async () => pending.resolve('cloud'));
    expect(controlsVisible()).toBe(false);
  });

  it('rejects a stale resolution after switching workspace runtimes', async () => {
    const old = Promise.withResolvers<'local'>();
    mocks.runtime!.resolveMachineTargetPlane.mockReturnValue(old.promise);
    await render();
    mocks.runtime = { resolveMachineTargetPlane: vi.fn().mockResolvedValue('cloud') };
    await render();
    await act(async () => old.resolve('local'));
    expect(controlsVisible()).toBe(false);
  });

  it('fences an already confirmed route immediately when the runtime changes', async () => {
    await render();
    const next = Promise.withResolvers<'local'>();
    mocks.runtime = { resolveMachineTargetPlane: vi.fn().mockReturnValue(next.promise) };
    rendered = [];
    await render();
    expect(rendered.every((local) => !local)).toBe(true);
    await act(async () => next.resolve('local'));
    expect(controlsVisible()).toBe(true);
  });

  it('fails closed on unavailable routes and retries when local identity resolves', async () => {
    mocks.localMachineId = null;
    mocks.runtime!.resolveMachineTargetPlane.mockRejectedValueOnce(new Error('target pending'));
    await render();
    expect(controlsVisible()).toBe(false);
    mocks.localMachineId = 'local-machine';
    await render();
    expect(controlsVisible()).toBe(true);
    expect(mocks.runtime!.resolveMachineTargetPlane).toHaveBeenCalledTimes(2);
  });
});
