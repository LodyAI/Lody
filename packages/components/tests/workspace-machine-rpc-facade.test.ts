import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  type MachineId,
  type McpServerId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import { createWorkspaceMachineRpcFacade } from '../src/providers/workspace-machine-rpc-facade';
import { mintPreviewControlProof } from '../src/lib/preview-control-api';

vi.mock('../src/lib/preview-control-api', () => ({ mintPreviewControlProof: vi.fn() }));

const workspaceId = 'workspace-1' as WorkspaceId;
const localMachineId = 'machine-local' as MachineId;
const remoteMachineId = 'machine-remote' as MachineId;
const sessionId = 'session-1' as SessionId;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('createWorkspaceMachineRpcFacade', () => {
  it.each([undefined, {}, { previewControl: 0 }])(
    'rejects unsupported remote preview control before handshake or authorization (%j)',
    async (protocolCapabilities) => {
      const facade = createWorkspaceMachineRpcFacade({
        workspaceId,
        getMachineProtocolCapabilities: async () => protocolCapabilities,
        targetRouter: {
          getPlaneForMachine: () => 'cloud',
          resolvePlaneForMachine: async () => 'cloud',
        },
        getMachineRpcClient: async () =>
          ({
            requestPreviewControl: () => {
              throw new Error('Unexpected handshake');
            },
            requestSessionPreviewStatus: () => {
              throw new Error('Unexpected preview RPC');
            },
          }) as never,
      });
      await expect(
        facade.requestSessionPreviewStatus(remoteMachineId, sessionId, 'owner')
      ).resolves.toMatchObject({
        success: false,
        message: 'Update this machine to manage remote previews.',
      });
      expect(mintPreviewControlProof).not.toHaveBeenCalled();
    }
  );

  it('uses the dedicated handshake nonce for remote preview proof, without machine status', async () => {
    const runtimeNonce = '00000000-0000-4000-8000-000000000001';
    vi.mocked(mintPreviewControlProof).mockImplementation(async (intent, token) => {
      expect(token).toBe('test-login-token');
      expect(intent).toMatchObject({
        workspaceId,
        machineId: remoteMachineId,
        sessionId,
        requesterUserId: 'owner',
        runtimeNonce,
        operation: { action: 'status', renewEndpointId: 'endpoint-1' },
      });
      return {
        runtimeNonce: intent.runtimeNonce,
        requestId: intent.requestId,
        requestToken: 'test-proof',
      };
    });
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getSessionToken: () => 'test-login-token',
      getMachineProtocolCapabilities: async () => CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      getMachineRpcClient: async () =>
        ({
          requestMachineStatus: () => {
            throw new Error('Unexpected machine status');
          },
          requestPreviewControl: async () => ({ success: true, runtimeNonce }),
          requestSessionPreviewStatus: async (request: {
            proof: { runtimeNonce: string; requestToken: string };
          }) => {
            expect(request.proof).toMatchObject({ runtimeNonce, requestToken: 'test-proof' });
            return {
              type: 'session/preview-status_response',
              sessionId,
              success: true,
              connection: { status: 'closed', closedReason: 'idle_timeout' },
            };
          },
        }) as never,
    });
    await expect(
      facade.requestSessionPreviewStatus(remoteMachineId, sessionId, 'owner', {
        renewEndpointId: 'endpoint-1',
      })
    ).resolves.toMatchObject({
      success: true,
      connection: { status: 'closed', closedReason: 'idle_timeout' },
    });
  });

  it.each([null, { success: false, error: 'handshake unavailable' }])(
    'does not mint authorization after a failed handshake (%j)',
    async (handshake) => {
      const facade = createWorkspaceMachineRpcFacade({
        workspaceId,
        getMachineProtocolCapabilities: async () => CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
        targetRouter: {
          getPlaneForMachine: () => 'cloud',
          resolvePlaneForMachine: async () => 'cloud',
        },
        getMachineRpcClient: async () =>
          ({
            requestPreviewControl: async () => handshake,
            requestSessionPreviewStatus: () => {
              throw new Error('Unexpected preview RPC');
            },
          }) as never,
      });
      await expect(
        facade.requestSessionPreviewStatus(remoteMachineId, sessionId, 'owner')
      ).resolves.toMatchObject({
        success: false,
        message: handshake?.error ?? 'The machine did not provide preview control authorization.',
      });
      expect(mintPreviewControlProof).not.toHaveBeenCalled();
    }
  );

  it('controls a local preview without a login token or cloud proof', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('Unexpected cloud HTTP');
    });
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      ipc: {
        invoke: async (_channel: string, request: { method: string; params: object }) => {
          expect(request.method).toBe('session/preview-status');
          expect(request.params).toEqual({
            sessionId,
            requestedByUserId: 'local-owner',
            renewEndpointId: undefined,
          });
          return {
            ok: true,
            result: {
              type: 'session/preview-status_response',
              sessionId,
              success: true,
              connection: { status: 'closed', closedReason: 'idle_timeout' },
            },
          };
        },
      },
    });
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      targetRouter: {
        getPlaneForMachine: () => 'local',
        resolvePlaneForMachine: async () => 'local',
      },
      getMachineRpcClient: async () => {
        throw new Error('Unexpected cloud RPC');
      },
    });
    await expect(
      facade.requestSessionPreviewStatus(localMachineId, sessionId, 'local-owner')
    ).resolves.toMatchObject({
      success: true,
      connection: { status: 'closed', closedReason: 'idle_timeout' },
    });
  });

  it('sends iOS Simulator control to this machine without a login token, proof or cloud', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('Unexpected cloud HTTP');
    });
    const requests: unknown[] = [];
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      ipc: {
        invoke: async (_channel: string, request: { method: string; params: object }) => {
          requests.push(request);
          return {
            ok: true,
            result: {
              type: 'ios-simulator/control_response',
              sessionId,
              success: true,
              devices: [],
            },
          };
        },
      },
    });
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => undefined,
      targetRouter: {
        getPlaneForMachine: () => 'local',
        resolvePlaneForMachine: async () => 'local',
      },
      getMachineRpcClient: async () => {
        throw new Error('Unexpected cloud RPC');
      },
    });
    await expect(
      facade.requestIosSimulatorControl({
        machineId: localMachineId,
        sessionId,
        requestedByUserId: 'local-owner',
        command: { action: 'list' },
      })
    ).resolves.toMatchObject({ success: true, devices: [] });
    expect(requests).toMatchObject([
      {
        method: 'ios-simulator/control',
        params: { sessionId, requestedByUserId: 'local-owner', command: { action: 'list' } },
      },
    ]);
    expect(mintPreviewControlProof).not.toHaveBeenCalled();
  });

  it('signs the exact remote iOS Simulator command with the preview handshake nonce', async () => {
    const runtimeNonce = '00000000-0000-4000-8000-000000000002';
    const command = { action: 'stop', operationId: 'op-7' } as const;
    vi.mocked(mintPreviewControlProof).mockImplementation(async (intent) => {
      expect(intent).toMatchObject({
        machineId: remoteMachineId,
        sessionId,
        requesterUserId: 'owner',
        runtimeNonce,
        operation: { action: 'ios-simulator', command },
      });
      return { runtimeNonce, requestId: intent.requestId, requestToken: 'sim-proof' };
    });
    const sent: unknown[] = [];
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getSessionToken: () => 'test-login-token',
      getMachineProtocolCapabilities: async () => ({
        ...CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
        previewControl: 1,
        iosSimulator: 1,
      }),
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      getMachineRpcClient: async () =>
        ({
          requestPreviewControl: async () => ({ success: true, runtimeNonce }),
          requestIosSimulatorControl: async (request: unknown) => {
            sent.push(request);
            return { type: 'ios-simulator/control_response', sessionId, success: true };
          },
        }) as never,
    });
    await expect(
      facade.requestIosSimulatorControl({
        machineId: remoteMachineId,
        sessionId,
        requestedByUserId: 'owner',
        command,
      })
    ).resolves.toMatchObject({ success: true });
    expect(sent).toMatchObject([
      {
        sessionId,
        requestedByUserId: 'owner',
        command,
        proof: { runtimeNonce, requestToken: 'sim-proof' },
      },
    ]);
  });

  it('reports a remote Mac without the iOS Simulator protocol before any handshake', async () => {
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => ({ previewControl: 1 }),
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      getMachineRpcClient: async () =>
        ({
          requestPreviewControl: () => {
            throw new Error('Unexpected handshake');
          },
          requestIosSimulatorControl: () => {
            throw new Error('Unexpected simulator RPC');
          },
        }) as never,
    });
    await expect(
      facade.requestIosSimulatorControl({
        machineId: remoteMachineId,
        sessionId,
        requestedByUserId: 'owner',
        command: { action: 'list' },
      })
    ).resolves.toMatchObject({ success: false, error: 'unsupported' });
    expect(mintPreviewControlProof).not.toHaveBeenCalled();
  });

  it('keeps Pi discovery success and failure on the local machine route', async () => {
    const discovery = { version: 1, agentDir: '/fixture/pi', extensions: [], warnings: [] };
    let failed = false;
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      ipc: {
        invoke: async () =>
          failed
            ? { ok: false, error: 'Local failure' }
            : { ok: true, result: { success: true, discovery } },
      },
    });
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      targetRouter: {
        getPlaneForMachine: () => 'local',
        resolvePlaneForMachine: async () => 'local',
      },
      getMachineProtocolCapabilities: async () => ({ piExtensions: 1 }),
      getMachineRpcClient: async () => {
        throw new Error('Unexpected cloud route');
      },
    });
    expect(await facade.requestMachinePiExtensions(localMachineId)).toEqual({
      success: true,
      discovery,
    });
    failed = true;
    expect(await facade.requestMachinePiExtensions(localMachineId)).toEqual({
      success: false,
      error: 'Local failure',
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
    const resolvePlaneForMachine = vi.fn(async () => {
      throw new Error('Unexpected route resolution');
    });
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      targetRouter: {
        getPlaneForMachine: () => 'local',
        resolvePlaneForMachine,
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
    expect(resolvePlaneForMachine).not.toHaveBeenCalled();
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
        resolvePlaneForMachine: vi.fn(async () => 'local' as const),
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
        resolvePlaneForMachine: vi.fn(async () => 'local' as const),
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
        resolvePlaneForMachine: vi.fn(async () => 'cloud' as const),
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

describe('local MCP discovery routing', () => {
  const server = {
    id: 'test' as McpServerId,
    name: 'Test',
    transport: 'stdio' as const,
    connection: { transport: 'stdio' as const, command: 'synthetic' },
    createdAt: 1,
    updatedAt: 1,
  };
  it.each([true, false])(
    'gates local inventory by daemon capability (supported=%s)',
    async (supported) => {
      const inventory = { type: 'mcp/tools', tools: [{ name: 'read_file' }] };
      vi.stubGlobal('window', {
        __LODY_ELECTRON__: true,
        ipc: {
          invoke: async () => {
            if (!supported) throw new Error('Unexpected local RPC');
            return { ok: true, result: inventory };
          },
        },
      });
      const facade = createWorkspaceMachineRpcFacade({
        workspaceId,
        getMachineProtocolCapabilities: async () =>
          supported ? CURRENT_MACHINE_PROTOCOL_CAPABILITIES : undefined,
        targetRouter: {
          getPlaneForMachine: () => 'local',
          resolvePlaneForMachine: async () => 'local',
        },
        getMachineRpcClient: async () => {
          throw new Error('Unexpected remote RPC');
        },
      });
      const result = facade.requestLocalMcpTools(localMachineId, server);
      if (supported) await expect(result).resolves.toEqual(inventory);
      else await expect(result).rejects.toThrow('requires a supported local daemon');
    }
  );
});

describe('memory provider routing', () => {
  const request = { action: 'list', providerId: 'nowledge-mem' } as const;
  const inventory = {
    type: 'machine/memory',
    status: 'ready',
    memories: [{ id: 'reviewer', name: 'Reviewer' }],
  } as const;
  it.each(['local', 'cloud'] as const)(
    'returns identities from the selected %s machine',
    async (plane) => {
      const machineId = plane === 'local' ? localMachineId : remoteMachineId;
      vi.stubGlobal('window', {
        __LODY_ELECTRON__: true,
        ipc: {
          invoke: async (
            _channel: string,
            envelope: { machineId: MachineId; method: string; params: unknown }
          ) => {
            if (plane !== 'local') throw new Error('Unexpected local RPC');
            expect(envelope).toMatchObject({
              machineId,
              method: 'machine/memory',
              params: request,
            });
            return { ok: true, result: inventory };
          },
        },
      });
      const facade = createWorkspaceMachineRpcFacade({
        workspaceId,
        getMachineProtocolCapabilities: async () => CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
        targetRouter: {
          getPlaneForMachine: () => plane,
          resolvePlaneForMachine: async () => plane,
        },
        getMachineRpcClient: async (target) => {
          if (plane !== 'cloud') throw new Error('Unexpected remote RPC');
          expect(target).toBe(remoteMachineId);
          return {
            requestMemoryProvider: async (params: unknown) => {
              expect(params).toEqual(request);
              return inventory;
            },
          } as never;
        },
      });
      await expect(facade.requestMemoryProvider(machineId, request)).resolves.toEqual(inventory);
    }
  );
  it.each([undefined, { memoryProviders: 0 }, { memoryProviders: 0.5 }])(
    'rejects unsupported capabilities %j before routing a command',
    async (protocolCapabilities) => {
      const facade = createWorkspaceMachineRpcFacade({
        workspaceId,
        getMachineProtocolCapabilities: async () => protocolCapabilities,
        targetRouter: {
          getPlaneForMachine: () => 'cloud',
          resolvePlaneForMachine: async () => 'cloud',
        },
        getMachineRpcClient: async () => {
          throw new Error('Unexpected RPC');
        },
      });
      await expect(facade.requestMemoryProvider(remoteMachineId, request)).resolves.toMatchObject({
        status: 'error',
        error: 'Update this machine to use memory providers.',
        memories: [],
      });
    }
  );
  it('returns local failure without falling back to a remote machine', async () => {
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      ipc: {
        invoke: async () => ({ ok: false, error: 'local service unavailable' }),
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
        throw new Error('Unexpected remote RPC');
      },
    });
    await expect(facade.requestMemoryProvider(localMachineId, request)).resolves.toMatchObject({
      status: 'error',
      error: 'local service unavailable',
      memories: [],
    });
  });
});
