import { describe, expect, it, vi } from 'vitest';
import { LodyFleet } from '../src/lib/lody-fleet';
import { Lody } from '../src/lib/lody';
import { MachineRuntime } from '../src/lib/machine-runtime';
import { stopLocalTerminalServer } from '../src/lib/local-terminal-server';

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
  const workspaceWatchCoordinator = { dispose: vi.fn(async () => {}) };
  const cloudPort = { dispose: vi.fn(async () => {}) };
  const terminalPtyService = { closeAll: vi.fn(), stopAdmission: vi.fn() };
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
    workspaceWatchCoordinator,
    cloudPort,
    terminalPtyService,
  });
  return { fleet, runtimes, workspaceWatchCoordinator, cloudPort, terminalPtyService };
}

describe('fleet process shutdown ownership', () => {
  it('aggregates forced PTY failure after also attempting workspace cleanup', async () => {
    const entry = runtime('force-failures');
    const ptyFailure = new Error('PTY kill refused');
    const workspaceFailure = new Error('workspace force refused');
    entry.lody.forceTerminateSessions.mockRejectedValueOnce(workspaceFailure);
    const { fleet, terminalPtyService } = fixture([entry]);
    terminalPtyService.closeAll.mockImplementationOnce(() => {
      throw ptyFailure;
    });
    await expect(fleet.forceTerminateSessions()).rejects.toMatchObject({
      errors: [ptyFailure, workspaceFailure],
    });
    expect(terminalPtyService.stopAdmission).toHaveBeenCalledOnce();
    expect(entry.lody.forceTerminateSessions).toHaveBeenCalledOnce();
    await fleet.forceTerminateSessions();
    expect(terminalPtyService.closeAll).toHaveBeenCalledTimes(2);
  });

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
      'Forced fleet process cleanup failed'
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

it('closes independent PTYs after workspace failure while retaining shared retry dependencies', async () => {
  const entry = runtime('retry-dependencies');
  const workspaceFailure = new Error('workspace producer cleanup failed');
  entry.lody.cleanup.mockRejectedValueOnce(workspaceFailure).mockResolvedValue(undefined);
  const { fleet, runtimes, terminalPtyService, workspaceWatchCoordinator, cloudPort } = fixture([
    entry,
  ]);
  await expect(fleet.shutdown()).rejects.toMatchObject({ errors: [workspaceFailure] });
  expect(terminalPtyService.closeAll).toHaveBeenCalledTimes(1);
  expect(runtimes.get(entry.workspace.id)).toBe(entry);
  expect(workspaceWatchCoordinator.dispose).not.toHaveBeenCalled();
  expect(cloudPort.dispose).not.toHaveBeenCalled();
  entry.lody.cleanup.mockImplementation(async () => {
    expect(workspaceWatchCoordinator.dispose).not.toHaveBeenCalled();
    expect(cloudPort.dispose).not.toHaveBeenCalled();
  });
  await fleet.shutdown();
  expect(runtimes.size).toBe(0);
  expect(terminalPtyService.closeAll).toHaveBeenCalledTimes(2);
  expect(workspaceWatchCoordinator.dispose).toHaveBeenCalledTimes(1);
  expect(cloudPort.dispose).toHaveBeenCalledTimes(1);
});

it('reports independent PTY and workspace failures together and permits retry', async () => {
  const entry = runtime('multiple-failures');
  const workspaceFailure = new Error('workspace failure');
  const ptyFailure = new Error('PTY failure');
  entry.lody.cleanup.mockRejectedValueOnce(workspaceFailure);
  const { fleet, runtimes, terminalPtyService } = fixture([entry]);
  terminalPtyService.closeAll.mockImplementationOnce(() => {
    throw ptyFailure;
  });
  await expect(fleet.shutdown()).rejects.toMatchObject({ errors: [workspaceFailure, ptyFailure] });
  expect(runtimes.get(entry.workspace.id)).toBe(entry);
  await fleet.shutdown();
  expect(entry.lody.cleanup).toHaveBeenCalledTimes(2);
  expect(runtimes.size).toBe(0);
  expect(terminalPtyService.closeAll).toHaveBeenCalledTimes(2);
});

it('waits for admitted terminal opens before the PTY close snapshot even if a workspace fails', async () => {
  let finishEndpoint = () => {};
  const endpoint = new Promise<void>((resolve) => {
    finishEndpoint = resolve;
  });
  vi.mocked(stopLocalTerminalServer).mockReturnValueOnce(endpoint);
  const entry = runtime('pending-terminal');
  entry.lody.cleanup.mockRejectedValueOnce(new Error('workspace failure'));
  const { fleet, terminalPtyService } = fixture([entry]);
  const shutdown = expect(fleet.shutdown()).rejects.toThrow('Workspace cleanup failed');
  await vi.waitFor(() => expect(entry.lody.cleanup).toHaveBeenCalledOnce());
  expect(terminalPtyService.closeAll).not.toHaveBeenCalled();
  finishEndpoint();
  await shutdown;
  expect(terminalPtyService.closeAll).toHaveBeenCalledOnce();
});

it('attempts every eligible shared disposer even when an earlier disposer fails', async () => {
  const { fleet, terminalPtyService, workspaceWatchCoordinator, cloudPort } = fixture([]);
  const watcherFailure = new Error('watcher failure');
  const cloudFailure = new Error('cloud failure');
  workspaceWatchCoordinator.dispose.mockRejectedValueOnce(watcherFailure);
  cloudPort.dispose.mockRejectedValueOnce(cloudFailure);
  await expect(fleet.shutdown()).rejects.toMatchObject({ errors: [watcherFailure, cloudFailure] });
  expect(terminalPtyService.closeAll).toHaveBeenCalledTimes(1);
  expect(cloudPort.dispose).toHaveBeenCalledTimes(1);
  await fleet.shutdown();
  expect(workspaceWatchCoordinator.dispose).toHaveBeenCalledTimes(2);
  expect(cloudPort.dispose).toHaveBeenCalledTimes(2);
});

it('reports local endpoint stop failure after closing independent and shared resources', async () => {
  const endpointFailure = new Error('terminal endpoint failure');
  vi.mocked(stopLocalTerminalServer).mockRejectedValueOnce(endpointFailure);
  const { fleet, terminalPtyService, workspaceWatchCoordinator, cloudPort } = fixture([]);
  await expect(fleet.shutdown()).rejects.toMatchObject({ errors: [endpointFailure] });
  expect(terminalPtyService.closeAll).toHaveBeenCalledTimes(1);
  expect(workspaceWatchCoordinator.dispose).toHaveBeenCalledTimes(1);
  expect(cloudPort.dispose).toHaveBeenCalledTimes(1);
  await fleet.shutdown();
});
