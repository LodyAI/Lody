import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  type MachineId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import { createWorkspaceMachineRpcFacade } from '../src/providers/workspace-machine-rpc-facade';

const workspaceId = 'workspace-1' as WorkspaceId;
const localMachineId = 'machine-local' as MachineId;
const remoteMachineId = 'machine-remote' as MachineId;
const sessionId = 'session-1' as SessionId;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWorkspaceMachineRpcFacade', () => {
  it.each([
    'snapshot-missing',
    'meta-missing',
    'wrong-machine',
    'revoked-during-meta-read',
    'route-missing',
  ] as const)('fails both session controls closed for %s', async (scenario) => {
    let authorization =
      scenario === 'snapshot-missing'
        ? null
        : {
            visibleMachineIds: new Set([remoteMachineId]),
            visibleLocalProjectKeys: new Set<string>(),
          };
    const getMachineRpcClient = vi.fn(async () => {
      throw new Error('Remote client must not be created');
    });
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      getSessionControlAuthorization: () => authorization,
      getSessionMeta: async () => {
        if (scenario === 'revoked-during-meta-read') authorization = null;
        return scenario === 'meta-missing'
          ? undefined
          : {
              machineId: scenario === 'wrong-machine' ? localMachineId : remoteMachineId,
            };
      },
      targetRouter: {
        getPlaneForMachine: () => (scenario === 'route-missing' ? null : 'cloud'),
        resolvePlaneForMachine: async () => null,
      },
      getMachineRpcClient,
    });
    const error =
      scenario === 'route-missing'
        ? 'Session control routing is unavailable.'
        : 'Source authorization for this session is unavailable or denied.';
    expect(
      await facade.requestSessionQueueSteer(remoteMachineId, {
        sessionId,
        queueItemId: 'C',
        expectedTurnId: 'T',
      })
    ).toMatchObject({ accepted: false, error });
    expect(
      await facade.requestSessionQueueMutation(remoteMachineId, {
        sessionId,
        mutation: { kind: 'remove', queueItemId: 'C', expectedRevision: '{}' },
      })
    ).toMatchObject({ success: false, error });
    expect(getMachineRpcClient).not.toHaveBeenCalled();
  });
  it.each([undefined, { queueItemSteer: 1 }])(
    'disables every old-daemon queue row for %j',
    async (capabilities) => {
      const facade = createWorkspaceMachineRpcFacade({
        workspaceId,
        getMachineProtocolCapabilities: async () => capabilities,
        targetRouter: {
          getPlaneForMachine: () => 'cloud',
          resolvePlaneForMachine: async () => 'cloud',
        },
        getMachineRpcClient: async () => {
          throw new Error('Legacy delivery must not run');
        },
      });
      for (const queueItemId of ['A', 'B', 'C']) {
        await expect(
          facade.requestSessionQueueSteer(remoteMachineId, {
            sessionId,
            expectedTurnId: 'active',
            queueItemId,
          })
        ).resolves.toMatchObject({ accepted: false, disposition: 'unsupported', queueItemId });
      }
    }
  );

  it('returns a queue mutation failure from local IPC without trying remote delivery', async () => {
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      ipc: {
        invoke: async () => ({
          ok: true,
          result: {
            type: 'session/queue-mutate_response',
            success: false,
            error: 'Row is reserved',
          },
        }),
      },
    });
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      targetRouter: {
        getPlaneForMachine: () => 'local',
        resolvePlaneForMachine: async () => 'local',
      },
      getMachineRpcClient: async () => {
        throw new Error('Must not use remote');
      },
    });
    await expect(
      facade.requestSessionQueueMutation(localMachineId, {
        sessionId,
        mutation: { kind: 'remove', queueItemId: 'C', expectedRevision: '{}' },
      })
    ).resolves.toMatchObject({ success: false, error: 'Row is reserved' });
  });
  it('sends queued Steer as one exact local daemon operation', async () => {
    const invoke = vi.fn(async () => ({
      ok: true as const,
      result: {
        type: 'session/queue-steer_response' as const,
        sessionId,
        queueItemId: 'queue-C',
        userTurnId: 'user-C',
        accepted: true,
        disposition: 'accepted' as const,
      },
    }));
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      ipc: { invoke },
    });
    const getMachineRpcClient = vi.fn();
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      targetRouter: {
        getPlaneForMachine: () => 'local',
        resolvePlaneForMachine: vi.fn(async () => 'local'),
      },
      getMachineRpcClient,
    });

    await expect(
      facade.requestSessionQueueSteer(localMachineId, {
        sessionId,
        expectedTurnId: 'assistant-active',
        queueItemId: 'queue-C',
      })
    ).resolves.toMatchObject({ accepted: true, queueItemId: 'queue-C' });
    expect(invoke).toHaveBeenCalledWith(
      'machineRpc.send',
      expect.objectContaining({
        machineId: localMachineId,
        workspaceId,
        method: 'session/queue-steer',
        params: {
          sessionId,
          expectedTurnId: 'assistant-active',
          queueItemId: 'queue-C',
        },
      })
    );
    expect(getMachineRpcClient).not.toHaveBeenCalled();
  });

  it('does not send the exact queue RPC when an older daemon omits its capability', async () => {
    const getMachineRpcClient = vi.fn(async () => {
      throw new Error('Unexpected RPC');
    });
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => undefined,
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      getMachineRpcClient,
    });

    await expect(
      facade.requestSessionQueueSteer(remoteMachineId, {
        sessionId,
        expectedTurnId: 'assistant-active',
        queueItemId: 'queue-C',
      })
    ).resolves.toMatchObject({ accepted: false, disposition: 'unsupported' });
    expect(getMachineRpcClient).not.toHaveBeenCalled();
  });

  it('fails closed before remote queue Steer when source authorization is unavailable', async () => {
    const requestSessionQueueSteer = vi.fn();
    const getMachineRpcClient = vi.fn(async () => ({ requestSessionQueueSteer }));
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      getSessionControlAuthorization: () => null,
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      getMachineRpcClient,
    });

    await expect(
      facade.requestSessionQueueSteer(remoteMachineId, {
        sessionId,
        expectedTurnId: 'assistant-active',
        queueItemId: 'queue-C',
      })
    ).resolves.toMatchObject({ accepted: false, disposition: 'error' });
    expect(getMachineRpcClient).not.toHaveBeenCalled();
  });

  it('sends remote queue Steer only for a source-authorized machine and carries no identity claim', async () => {
    const requestSessionQueueSteer = vi.fn(async () => ({
      type: 'session/queue-steer_response' as const,
      sessionId,
      queueItemId: 'queue-C',
      userTurnId: 'user-C',
      accepted: true,
      disposition: 'accepted' as const,
    }));
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      getSessionMeta: async () => ({ machineId: remoteMachineId }),
      getSessionControlAuthorization: () => ({
        visibleMachineIds: new Set([remoteMachineId]),
        visibleLocalProjectKeys: new Set(),
      }),
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      getMachineRpcClient: async () => ({ requestSessionQueueSteer }) as never,
    });

    await expect(
      facade.requestSessionQueueSteer(remoteMachineId, {
        sessionId,
        expectedTurnId: 'assistant-active',
        queueItemId: 'queue-C',
      })
    ).resolves.toMatchObject({ accepted: true });
    expect(requestSessionQueueSteer).toHaveBeenCalledWith({
      sessionId,
      expectedTurnId: 'assistant-active',
      queueItemId: 'queue-C',
      timeoutMs: 5_000,
    });
  });

  it('never sends a scoped cancel to a daemon without the scoped-cancel protocol', async () => {
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => undefined,
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      getMachineRpcClient: async () => {
        throw new Error('Unexpected RPC');
      },
    });
    expect(
      await facade.requestSessionCancel(remoteMachineId, sessionId, 'turn-1', {
        subagentTaskId: 'child-1',
      })
    ).toMatchObject({
      success: false,
      error: 'This machine does not support individual subagent cancellation.',
    });
  });
  it('uses the local-only IPC preview method without creating a cloud client', async () => {
    const invoke = vi.fn(async () => ({
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
    }));
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      ipc: { invoke },
    });
    const getMachineRpcClient = vi.fn();
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
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
      'machineRpc.previewFile',
      expect.objectContaining({
        machineId: localMachineId,
        workspaceId,
        method: 'file/resolve-local',
        params: { v: 3, sessionId, path: '/Users/me/Documents/notes.md' },
      })
    );
    expect(getMachineRpcClient).not.toHaveBeenCalled();
  });

  it('reports an unsupported local daemon without requesting resource IO or cloud fallback', async () => {
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      ipc: {
        invoke: async () => {
          throw new Error('Unexpected IPC');
        },
      },
    });
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      targetRouter: {
        getPlaneForMachine: () => 'local',
        resolvePlaneForMachine: async () => 'local',
      },
      getMachineProtocolCapabilities: async () => undefined,
      getMachineRpcClient: async () => {
        throw new Error('Unexpected cloud IO');
      },
    });
    expect(
      await facade.requestFilePreview(localMachineId, { sessionId, path: 'large.txt' })
    ).toMatchObject({
      status: 'error',
      retryable: false,
      message: expect.stringContaining('does not support file resources'),
    });
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
      getMachineProtocolCapabilities: async () => CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
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
      getMachineProtocolCapabilities: async () => CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
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
      getMachineProtocolCapabilities: async () => CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
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
      getMachineProtocolCapabilities: async () => CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
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
