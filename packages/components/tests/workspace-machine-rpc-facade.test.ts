import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineId, SessionId, WorkspaceId } from '@lody/shared';
import { createWorkspaceMachineRpcFacade } from '../src/providers/workspace-machine-rpc-facade';

const workspaceId = 'workspace-1' as WorkspaceId;
const localMachineId = 'machine-local' as MachineId;
const remoteMachineId = 'machine-remote' as MachineId;
const sessionId = 'session-1' as SessionId;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWorkspaceMachineRpcFacade', () => {
  it('uses the local-only IPC preview method without creating a cloud client', async () => {
    const invoke = vi.fn(async () => ({
      ok: true as const,
      result: {
        status: 'ok' as const,
        v: 3 as const,
        path: '/Users/me/Documents/notes.md',
        external: true,
        digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        kind: 'text' as const,
        content: { encoding: 'utf8-plain' as const, text: '# Note\n', rawBytes: 7 },
        format: { eol: 'lf' as const },
        sizeBytes: 7,
        readonly: true,
      },
    }));
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      ipc: { invoke },
    });
    const getMachineRpcClient = vi.fn();
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      targetRouter: {
        getPlaneForMachine: () => 'local',
        resolvePlaneForMachine: vi.fn(async () => 'local'),
      },
      getMachineRpcClient,
    });

    await expect(
      facade.requestFilePreview(localMachineId, {
        sessionId,
        path: '/Users/me/Documents/notes.md',
      })
    ).resolves.toMatchObject({ status: 'ok', external: true, readonly: true });
    expect(invoke).toHaveBeenCalledWith(
      'machineRpc.send',
      expect.objectContaining({
        machineId: localMachineId,
        workspaceId,
        method: 'file/preview-local',
        params: { v: 3, sessionId, path: '/Users/me/Documents/notes.md' },
      })
    );
    expect(getMachineRpcClient).not.toHaveBeenCalled();
  });

  it('does not fall back to a cloud preview while Electron local routing is unresolved', async () => {
    const invoke = vi.fn();
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      ipc: { invoke },
    });
    const getMachineRpcClient = vi.fn();
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      targetRouter: {
        getPlaneForMachine: () => null,
        resolvePlaneForMachine: vi.fn(async () => {
          throw new Error('workspace_target_identity_timeout');
        }),
      },
      getMachineRpcClient,
    });

    await expect(
      facade.requestFilePreview(localMachineId, { sessionId, path: '/tmp/local.txt' })
    ).resolves.toMatchObject({ status: 'error', code: 'transient_io' });
    expect(invoke).not.toHaveBeenCalled();
    expect(getMachineRpcClient).not.toHaveBeenCalled();
  });

  it('uses the local bridge for a file-index snapshot without creating a cloud client', async () => {
    const invoke = vi.fn(async () => ({
      ok: true as const,
      result: {
        status: 'ok' as const,
        ownerSessionId: sessionId,
        fileIndex: { 'src/local.ts': { kind: 'file' as const, change: { diff: [2, 1] as const } } },
        updatedAtMs: 123,
      },
    }));
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      ipc: { invoke },
    });
    const getMachineRpcClient = vi.fn();
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      targetRouter: {
        getPlaneForMachine: () => 'local',
        resolvePlaneForMachine: vi.fn(async () => 'local'),
      },
      getMachineRpcClient,
    });

    await expect(
      facade.requestLocalCodeCollabFileIndex(
        localMachineId,
        { sessionId },
        { ownerSessionId: sessionId }
      )
    ).resolves.toMatchObject({
      status: 'ok',
      fileIndex: { 'src/local.ts': { kind: 'file' } },
    });
    expect(invoke).toHaveBeenCalledWith(
      'machineRpc.send',
      expect.objectContaining({
        machineId: localMachineId,
        workspaceId,
        method: 'code-collab/get-file-index',
        params: { sessionId },
        ownerSessionId: sessionId,
      })
    );
    expect(getMachineRpcClient).not.toHaveBeenCalled();
  });

  it('uses the local bridge without creating a cloud client for the local machine', async () => {
    const invoke = vi.fn(async () => ({
      ok: true as const,
      result: {
        type: 'session/cancel_response' as const,
        sessionId,
        success: true,
      },
    }));
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      ipc: { invoke },
    });
    const getMachineRpcClient = vi.fn();
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      targetRouter: {
        getPlaneForMachine: () => 'local',
        resolvePlaneForMachine: vi.fn(async () => 'local'),
      },
      getMachineRpcClient,
    });

    await expect(facade.requestSessionCancel(localMachineId, sessionId, 'turn-1')).resolves.toEqual(
      {
        type: 'session/cancel_response',
        sessionId,
        success: true,
      }
    );
    expect(invoke).toHaveBeenCalledWith(
      'machineRpc.send',
      expect.objectContaining({
        machineId: localMachineId,
        workspaceId,
        method: 'session/cancel',
      })
    );
    expect(getMachineRpcClient).not.toHaveBeenCalled();
  });

  it('uses the cloud Machine RPC client for a remote machine', async () => {
    const invoke = vi.fn();
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      ipc: { invoke },
    });
    const requestSessionCancel = vi.fn(async () => ({
      type: 'session/cancel_response' as const,
      sessionId,
      success: true,
    }));
    const getMachineRpcClient = vi.fn(async () => ({ requestSessionCancel }) as never);
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: vi.fn(async () => 'cloud'),
      },
      getMachineRpcClient,
    });

    await expect(
      facade.requestSessionCancel(remoteMachineId, sessionId, 'turn-1')
    ).resolves.toEqual({
      type: 'session/cancel_response',
      sessionId,
      success: true,
    });
    expect(getMachineRpcClient).toHaveBeenCalledWith(remoteMachineId);
    expect(requestSessionCancel).toHaveBeenCalledWith({
      sessionId,
      turnId: 'turn-1',
      timeoutMs: 2_000,
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
