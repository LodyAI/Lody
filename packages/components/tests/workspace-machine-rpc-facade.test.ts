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
  it('requires fileDownload capability before requesting paid download bytes', async () => {
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => ({}),
      getMachineRpcClient: async () => {
        throw new Error('Old daemon must not receive a download request');
      },
    });
    expect(
      await facade.requestFileDownloadChunk(remoteMachineId, {
        sessionId,
        path: 'a.bin',
        offset: 0,
      })
    ).toEqual({ status: 'error', code: 'unsupported_protocol' });
  });

  it('does not fall back to cloud for a local file download without IPC', async () => {
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => ({ fileDownload: 1 }),
      targetRouter: {
        getPlaneForMachine: () => 'local',
        resolvePlaneForMachine: async () => 'local',
      },
      getMachineRpcClient: async () => {
        throw new Error('Local files must not use cloud');
      },
    });
    expect(
      await facade.requestFileDownloadChunk(localMachineId, { sessionId, path: 'a.bin', offset: 0 })
    ).toEqual({ status: 'error', code: 'unsupported_protocol' });
  });

  it('routes authorized chunk responses with the owning session and member root', async () => {
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => ({ fileDownload: 1 }),
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      getMachineRpcClient: async () =>
        ({
          requestFileDownloadChunk: async (request: {
            ownerSessionId?: string;
            rootId?: string;
          }) => {
            if (request.ownerSessionId !== 'parent' || request.rootId !== 'member:docs')
              return { status: 'error', code: 'permission_denied' };
            return {
              status: 'ok',
              path: 'a.bin',
              revision: 'a'.repeat(64),
              offset: 0,
              sizeBytes: 1,
              data: '/w==',
            };
          },
        }) as never,
    });
    expect(
      await facade.requestFileDownloadChunk(
        remoteMachineId,
        { sessionId, path: 'a.bin', rootId: 'member:docs', offset: 0 },
        'parent'
      )
    ).toMatchObject({ status: 'ok', data: '/w==' });
  });

  it('negotiates relative-link discovery without downgrading to an ordinary preview', async () => {
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => ({}),
      getMachineRpcClient: async () => {
        throw new Error('Must not read an ambiguous path on an old daemon');
      },
    });
    expect(
      await facade.requestFilePreview(remoteMachineId, {
        sessionId,
        path: 'docs/a.md',
        resolveMarkdownLink: true,
      })
    ).toMatchObject({ status: 'error', code: 'unsupported_protocol' });
  });

  it('forwards negotiated link resolution and returns candidates without content', async () => {
    const candidates = [
      {
        path: 'nested/a.md',
        absolutePath: '/repo/nested/a.md',
        worktreeRoot: '/repo/nested',
        branch: null,
        head: 'a'.repeat(40),
        mtimeMs: 1000,
      },
    ];
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => ({ markdownFileLinks: 1 }),
      getMachineRpcClient: async () =>
        ({
          requestFilePreview: async (request: { resolveMarkdownLink?: boolean }) =>
            request.resolveMarkdownLink
              ? { status: 'resolved-link', v: 3, candidates }
              : { status: 'error', code: 'wrong_mode' },
        }) as never,
    });
    expect(
      await facade.requestFilePreview(remoteMachineId, {
        sessionId,
        path: 'a.md',
        resolveMarkdownLink: true,
      })
    ).toEqual({ status: 'resolved-link', v: 3, candidates });
  });

  it('resolves same-machine links without consulting daemon capabilities', async () => {
    const result = { status: 'resolved-link', v: 3, candidates: [{ path: 'a.md' }] };
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      ipc: {
        invoke: async (_channel: string, request: { resolveMarkdownLink?: boolean }) =>
          request.resolveMarkdownLink ? result : null,
      },
    });
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => {
        throw new Error('Daemon offline');
      },
      getMachineRpcClient: async () => {
        throw new Error('No cloud fallback');
      },
    });
    expect(
      await facade.requestFilePreview(
        localMachineId,
        { sessionId, path: 'a.md', resolveMarkdownLink: true },
        { workspaceRoot: '/repo' }
      )
    ).toEqual(result);
  });

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
        path: '/Users/me/Documents/notes.md',
        workspaceRoot: null,
      })
    );
    expect(getMachineRpcClient).not.toHaveBeenCalled();
    expect(resolvePlaneForMachine).not.toHaveBeenCalled();
  });

  it('reads local content with no daemon capability or live route, forwarding the original root', async () => {
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      ipc: {
        invoke: async (channel: string, request: unknown) => {
          expect(channel).toBe('machineRpc.previewFile');
          expect(request).toEqual({
            machineId: localMachineId,
            path: 'notes.md',
            workspaceRoot: '/project',
          });
          return { status: 'ok', content: { text: 'offline document' } };
        },
      },
    });
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      targetRouter: {
        getPlaneForMachine: () => {
          throw new Error('Daemon identity unavailable');
        },
        resolvePlaneForMachine: async () => {
          throw new Error('Daemon offline');
        },
      },
      getMachineProtocolCapabilities: async () => {
        throw new Error('No daemon metadata');
      },
      getMachineRpcClient: async () => {
        throw new Error('Unexpected cloud IO');
      },
    });
    expect(
      await facade.requestFilePreview(
        localMachineId,
        { sessionId, path: 'notes.md' },
        { workspaceRoot: '/project' }
      )
    ).toMatchObject({ status: 'ok', content: { text: 'offline document' } });
  });

  it('keeps remote file reads on the remote owner after main rejects the local target', async () => {
    vi.stubGlobal('window', { __LODY_ELECTRON__: true, ipc: { invoke: async () => null } });
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      getMachineProtocolCapabilities: async () => undefined,
      getMachineRpcClient: async (machineId) => {
        expect(machineId).toBe(remoteMachineId);
        return {
          requestFilePreview: async (request: unknown) => {
            expect(request).toMatchObject({ path: '/remote/notes.md', sessionId });
            return { status: 'ok', content: { text: 'remote document' } };
          },
        } as never;
      },
    });
    expect(
      await facade.requestFilePreview(remoteMachineId, { sessionId, path: '/remote/notes.md' })
    ).toMatchObject({ status: 'ok', content: { text: 'remote document' } });
  });

  it('sends a member-root preview to the machine with its rootId, never to the local fast path', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('the Electron fast path resolves against the main root');
    });
    vi.stubGlobal('window', { __LODY_ELECTRON__: true, ipc: { invoke } });
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      getMachineProtocolCapabilities: async () => undefined,
      getMachineRpcClient: async () =>
        ({
          requestFilePreview: async (request: unknown) => {
            expect(request).toMatchObject({ sessionId, path: 'guide.md', rootId: 'member:docs' });
            return { status: 'ok', content: { text: 'member document' } };
          },
        }) as never,
    });
    expect(
      await facade.requestFilePreview(remoteMachineId, {
        sessionId,
        path: 'guide.md',
        rootId: 'member:docs',
      })
    ).toMatchObject({ status: 'ok', content: { text: 'member document' } });
  });

  it('does not route a local filesystem failure to the cloud', async () => {
    vi.stubGlobal('window', {
      __LODY_ELECTRON__: true,
      ipc: {
        invoke: async () => {
          throw new Error('EACCES');
        },
      },
    });
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      getMachineProtocolCapabilities: async () => undefined,
      getMachineRpcClient: async () => {
        throw new Error('Unexpected cloud IO');
      },
    });
    expect(
      await facade.requestFilePreview(localMachineId, { sessionId, path: '/local/notes.md' })
    ).toMatchObject({ status: 'error', message: 'EACCES' });
  });

  it('does not fall back to a cloud preview while Electron local routing is unresolved', async () => {
    const invoke = vi.fn(async () => null);
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

  it('previews a member root on this machine through the local daemon with its rootId', async () => {
    const invoke = vi.fn(async (channel: string) => {
      expect(channel).toBe('machineRpc.send');
      return {
        ok: true as const,
        result: {
          status: 'ok',
          v: 3,
          path: 'guide.md',
          digest: { size: 6, sha256: 'a'.repeat(64) },
          content: { kind: 'text', text: 'member', encoding: 'utf8' },
        },
      };
    });
    vi.stubGlobal('window', { __LODY_ELECTRON__: true, ipc: { invoke } });
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

    await facade.requestFilePreview(
      localMachineId,
      { sessionId, path: 'guide.md', rootId: 'member:docs' },
      { ownerSessionId: sessionId }
    );
    expect(invoke).toHaveBeenCalledWith(
      'machineRpc.send',
      expect.objectContaining({
        method: 'file/preview',
        params: expect.objectContaining({ path: 'guide.md', rootId: 'member:docs' }),
      })
    );
    // Neither the main-root fast path nor a remote channel is involved.
    expect(invoke).not.toHaveBeenCalledWith('machineRpc.previewFile', expect.anything());
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

  it('uses only the explicit same-machine cancel bridge in a protected cloud-only topology', async () => {
    let bridgeAvailable = true;
    let delivered: unknown;
    const invoke = async (_channel: string, request: unknown) => {
      delivered = request;
      return bridgeAvailable
        ? { ok: true, result: { type: 'session/cancel_response', sessionId, success: true } }
        : undefined;
    };
    vi.stubGlobal('window', { __LODY_ELECTRON__: true, ipc: { invoke } });
    let networkUsed = false;
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      isLocalControlMachine: (machine) => machine === localMachineId,
      getMachineRpcClient: async () => {
        networkUsed = true;
        throw new Error('cloud RPC unavailable');
      },
    });
    expect(await facade.requestSessionCancel(localMachineId, sessionId, 'turn-1')).toMatchObject({
      success: true,
    });
    expect(delivered).toMatchObject({
      workspaceId,
      machineId: localMachineId,
      method: 'session/cancel',
    });
    bridgeAvailable = false;
    expect(await facade.requestSessionCancel(localMachineId, sessionId, 'turn-1')).toMatchObject({
      success: false,
      error: 'Local machine RPC is unavailable.',
    });
    expect(networkUsed).toBe(false);
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

describe('machine bug report client log', () => {
  const clientLog = {
    encoding: 'gzip-base64' as const,
    data: 'H4sIAAAAAAAAA8vJLC4BAQAA//8DAOKaL3oEAAAA',
    rawBytes: 4,
    compressedBytes: 28,
  };

  /** A daemon whose strict request schema predates `clientLog` refuses it outright. */
  const facadeFor = (protocolCapabilities: Record<string, number> | undefined) => {
    const received: Array<Record<string, unknown>> = [];
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => protocolCapabilities,
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      getMachineRpcClient: async () =>
        ({
          requestMachineBugReport: async (params: Record<string, unknown>) => {
            received.push(params);
            if ('clientLog' in params && !protocolCapabilities?.bugReportClientLog) {
              throw new Error('invalid_params: unrecognized key "clientLog"');
            }
            return {
              type: 'machine/bug-report_response',
              machineId: remoteMachineId,
              success: true,
              bugReportId: 'bug-1',
            };
          },
        }) as never,
    });
    return { facade, received };
  };
  const report = {
    description: 'diff sheet reloads the app',
    reporterUserId: 'owner',
    requestToken: 'proof',
    clientLog,
  };

  it('sends the client log to a daemon that advertises it', async () => {
    const { facade, received } = facadeFor(CURRENT_MACHINE_PROTOCOL_CAPABILITIES);

    await expect(facade.requestMachineBugReport(remoteMachineId, report)).resolves.toMatchObject({
      success: true,
    });
    expect(received[0]?.clientLog).toEqual(clientLog);
  });

  it.each([undefined, {}, { bugReportClientLog: 0 }])(
    'still files the report, without the client log, on an older daemon (%j)',
    async (protocolCapabilities) => {
      const { facade, received } = facadeFor(protocolCapabilities);

      await expect(facade.requestMachineBugReport(remoteMachineId, report)).resolves.toMatchObject({
        success: true,
        bugReportId: 'bug-1',
      });
      expect(received[0]).not.toHaveProperty('clientLog');
    }
  );
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
  it.each(['local', 'cloud', 'unsupported'] as const)(
    'keeps authentication configuration on the supported local route (%s)',
    async (route) => {
      const sent: unknown[] = [];
      vi.stubGlobal('window', {
        __LODY_ELECTRON__: true,
        ipc: {
          invoke: async (_channel: string, request: unknown) => {
            sent.push(request);
            return {
              ok: true,
              result: { type: 'mcp/authentication', status: 'authorized', hasCredentials: true },
            };
          },
        },
      });
      const facade = createWorkspaceMachineRpcFacade({
        workspaceId,
        getMachineProtocolCapabilities: async () =>
          route === 'unsupported' ? undefined : CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
        targetRouter: {
          getPlaneForMachine: () => (route === 'cloud' ? 'cloud' : 'local'),
          resolvePlaneForMachine: async () => (route === 'cloud' ? 'cloud' : 'local'),
        },
        getMachineRpcClient: async () => {
          throw new Error('Authentication must never reach remote RPC');
        },
      });
      const request = facade.requestLocalMcpAuthentication(localMachineId, {
        server,
        action: 'configure',
        requesterUserId: 'owner',
        authentication: { mode: 'manual', bearerToken: 'synthetic-private-token' },
      });
      if (route === 'local') {
        expect(await request).toMatchObject({ status: 'authorized', hasCredentials: true });
        expect(sent).toEqual([
          expect.objectContaining({
            method: 'mcp/authentication',
            workspaceId,
            params: expect.objectContaining({
              authentication: { mode: 'manual', bearerToken: 'synthetic-private-token' },
            }),
          }),
        ]);
      } else {
        await expect(request).rejects.toThrow('requires a supported local daemon');
        expect(sent).toEqual([]);
      }
    }
  );
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

it.each([{ operationInbox: 1 }, {}])(
  'marks UI dispatch as human only for compatible Inbox machines (%j)',
  async (caps) => {
    const received: unknown[] = [];
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => caps,
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      getMachineRpcClient: async () =>
        ({
          requestSessionDispatchTurn: async (input: unknown) => {
            received.push(input);
            return {
              type: 'session/dispatch-turn_response',
              sessionId,
              userTurnId: 'new-human',
              accepted: true,
              disposition: 'accepted',
            };
          },
        }) as never,
    });
    expect(
      await facade.requestSessionDispatchTurn(remoteMachineId, {
        sessionId,
        userTurnId: 'new-human',
        userId: 'human',
        timestamp: '2026-10-12T00:00:00Z',
        inputConfig: { prompt: 'current request' },
      })
    ).toMatchObject({ accepted: true });
    expect(received).toEqual([
      {
        sessionId,
        userTurnId: 'new-human',
        userId: 'human',
        timestamp: '2026-10-12T00:00:00Z',
        inputConfig: { prompt: 'current request' },
        timeoutMs: 15000,
        ...('operationInbox' in caps ? { inputOrigin: 'human' } : {}),
      },
    ]);
  }
);

describe('encrypted file and preview routing', () => {
  it('uses protected RPC for file contents and preview control without opening the ordinary RPC client', async () => {
    const results = new Map<string, unknown>();
    const facade = createWorkspaceMachineRpcFacade({
      workspaceId,
      getMachineProtocolCapabilities: async () => CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      targetRouter: {
        getPlaneForMachine: () => 'cloud',
        resolvePlaneForMachine: async () => 'cloud',
      },
      getMachineRpcClient: async () => {
        throw new Error('plaintext RPC must stay closed');
      },
      requestEncryptedFeature: async (request) => {
        expect(request.workspaceId).toBe(workspaceId);
        expect(request.machineId).toBe(remoteMachineId);
        results.set(request.method, request.params);
        if (request.method === 'code-collab/open-text')
          return {
            ok: true,
            result: {
              status: 'ok',
              path: 'private.ts',
              digest: 'sha256:' + '11'.repeat(32),
              text: { encoding: 'plain', text: 'private text', rawBytes: 12 },
            },
          };
        if (request.method === 'session/preview-status')
          return {
            ok: true,
            result: {
              type: 'session/preview-status_response',
              sessionId,
              success: true,
            },
          };
        throw new Error('unexpected feature');
      },
    });
    expect(
      await facade.requestCodeCollabOpenText(
        remoteMachineId,
        { sessionId, path: 'private.ts' },
        { ownerSessionId: 'parent' }
      )
    ).toMatchObject({ status: 'ok', text: { text: 'private text' } });
    expect(
      await facade.requestSessionPreviewStatus(remoteMachineId, sessionId, 'owner', {
        renewEndpointId: 'endpoint',
      })
    ).toMatchObject({ success: true });
    expect(results.get('session/preview-status')).toMatchObject({ renewEndpointId: 'endpoint' });
  });
});

it('keeps encrypted same-machine Code Collab on local IPC even when its document plane is cloud-only', async () => {
  const saved = new Map<string, string>();
  vi.stubGlobal('window', {
    __LODY_ELECTRON__: true,
    ipc: {
      invoke: async (
        channel: string,
        request: import('@lody/shared/local-machine-rpc').LocalMachineRpcRequest
      ) => {
        expect(channel).toBe('machineRpc.send');
        if (request.method !== 'code-collab/save-text' || request.params.text.encoding !== 'plain')
          throw new Error('unexpected request');
        saved.set(request.params.path, request.params.text.text);
        return { ok: true, result: { status: 'ok' } };
      },
    },
  });
  const facade = createWorkspaceMachineRpcFacade({
    workspaceId,
    getMachineProtocolCapabilities: async () => CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
    targetRouter: {
      getPlaneForMachine: () => 'cloud',
      resolvePlaneForMachine: async () => 'cloud',
    },
    isLocalControlMachine: (machine) => machine === localMachineId,
    getMachineRpcClient: async () => {
      throw new Error('plaintext network must stay closed');
    },
    requestEncryptedFeature: async () => {
      throw new Error('same-machine controls must remain offline');
    },
  });
  await facade.requestCodeCollabSaveText(localMachineId, {
    sessionId,
    requestedByUserId: 'owner',
    path: 'private.ts',
    baseDigest: 'sha256:' + '11'.repeat(32),
    text: { encoding: 'plain', text: 'local edit', rawBytes: 10 },
  });
  expect(saved.get('private.ts')).toBe('local edit');
});
