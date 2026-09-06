import { describe, expect, it, vi } from 'vitest';
import { LodyFleet } from '../src/lib/lody-fleet';
import { Lody } from '../src/lib/lody';
import { MachineRuntime } from '../src/lib/machine-runtime';

vi.mock('@/lib/local-ipc-socket-server', async (original) => ({
  ...(await original<object>()),
  stopLocalIpcSocketServers: vi.fn(async () => {}),
}));
vi.mock('@/lib/local-terminal-server', async (original) => ({
  ...(await original<object>()),
  stopLocalTerminalServer: vi.fn(async () => {}),
}));
vi.mock('@/lib/local-loro-data-plane-server', async (original) => ({
  ...(await original<object>()),
  stopLocalLoroDataPlaneServer: vi.fn(async () => {}),
}));
vi.mock('@/mcp/lody-mcp-http-server', async (original) => ({
  ...(await original<object>()),
  stopLodyMcpHttpServer: vi.fn(async () => {}),
}));

function runtime(id: string) {
  return {
    workspace: { id },
    unsubscribeTerminalCleanup: vi.fn(),
    lody: {
      cleanup: vi.fn(async () => {}),
      forceTerminateSessions: vi.fn(async () => {}),
    },
  };
}
function fixture(entries: ReturnType<typeof runtime>[]) {
  const runtimes = new Map(entries.map((entry) => [entry.workspace.id, entry]));
  const fleet: LodyFleet = Object.assign(Object.create(LodyFleet.prototype), {
    runtimes,
    stopped: false,
    shutdownPromise: null,
    retryTimers: new Map(),
    logger: { debug: vi.fn() },
    stopRuntimeStateLoop: vi.fn(),
    memoryPressure: { stop: vi.fn() },
    cancelScheduledRemoteBridgeOffline: vi.fn(),
    clearReconcileRetry: vi.fn(),
    workspaceWatchCoordinator: { dispose: vi.fn(async () => {}) },
    cloudPort: { dispose: vi.fn(async () => {}) },
    terminalPtyService: { closeAll: vi.fn() },
  });
  return { fleet, runtimes };
}

describe('fleet process shutdown ownership', () => {
  it('starts force cleanup across workspaces while graceful cleanup is hung', async () => {
    const first = runtime('first');
    const second = runtime('second');
    let complete: () => void = () => {};
    first.lody.cleanup.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        })
    );
    second.lody.cleanup.mockRejectedValue(new Error('retryable'));
    const { fleet, runtimes } = fixture([first, second]);
    const shutdown = fleet.shutdown();
    const rejected = expect(shutdown).rejects.toThrow('Workspace cleanup failed');
    await Promise.resolve();
    await fleet.forceTerminateSessions();
    expect(first.lody.forceTerminateSessions).toHaveBeenCalledTimes(1);
    expect(second.lody.forceTerminateSessions).toHaveBeenCalledTimes(1);
    expect(runtimes.has('first')).toBe(true);
    complete();
    await rejected;
    expect(runtimes.has('first')).toBe(false);
    expect(runtimes.get('second')).toBe(second);
  });

  it('aggregates forced failures after attempting every retained runtime', async () => {
    const first = runtime('first');
    const second = runtime('second');
    first.lody.forceTerminateSessions.mockRejectedValue(new Error('refused'));
    const { fleet, runtimes } = fixture([first, second]);
    await expect(fleet.forceTerminateSessions()).rejects.toThrow(
      'Forced workspace process cleanup failed'
    );
    expect(second.lody.forceTerminateSessions).toHaveBeenCalledTimes(1);
    expect(runtimes.size).toBe(2);
    first.lody.forceTerminateSessions.mockResolvedValue(undefined);
    await fleet.forceTerminateSessions();
    expect(first.lody.forceTerminateSessions).toHaveBeenCalledTimes(2);
  });

  it('forwards forced cleanup through Lody and active machine runtime', async () => {
    const forceTerminateSessions = vi.fn(async () => {});
    const stop = vi.fn();
    const cancel = vi.fn();
    const machine: MachineRuntime = Object.assign(Object.create(MachineRuntime.prototype), {
      gcManager: { stop },
      messageProcessor: { stop },
      handler: { cancelPendingPermissionRequests: cancel },
      sessionManager: { forceTerminateSessions },
    });
    const lody: Lody = Object.assign(Object.create(Lody.prototype), { runtime: machine });
    await lody.forceTerminateSessions();
    expect(forceTerminateSessions).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

it('retries graceful cleanup of retained failures after a forced sweep', async () => {
  const entry = runtime('retry');
  entry.lody.cleanup.mockRejectedValueOnce(new Error('refused')).mockResolvedValue(undefined);
  const { fleet, runtimes } = fixture([entry]);
  await expect(fleet.shutdown()).rejects.toThrow('Workspace cleanup failed');
  expect(runtimes.get('retry')).toBe(entry);
  await fleet.forceTerminateSessions();
  await fleet.shutdown();
  expect(entry.lody.cleanup).toHaveBeenCalledTimes(2);
  expect(runtimes.size).toBe(0);
});
