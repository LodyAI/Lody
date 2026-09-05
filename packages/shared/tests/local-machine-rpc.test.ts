import { describe, expect, it } from 'vitest';
import {
  LocalMachineRpcResponseSchema,
  safeParseLocalMachineRpcRequest,
} from '../src/local-machine-rpc';

describe('local Machine RPC', () => {
  it.each([
    {
      method: 'session/get-active-invocation-context',
      params: { sessionId: 'session-1' },
    },
    {
      method: 'session/fork',
      params: {
        sourceSessionId: 'session-1',
        sourceTurnId: 'assistant-1',
        targetSessionId: 'session-side-1',
        requestedByUserId: 'user-1',
        targetPlacement: 'side-panel',
      },
    },
    {
      method: 'session/dispatch-turn',
      params: {
        sessionId: 'session-1',
        userTurnId: 'turn-1',
        userId: 'user-1',
        timestamp: '2026-07-13T00:00:00.000Z',
        inputConfig: { prompt: 'hello' },
      },
    },
    {
      method: 'session/steer',
      params: {
        sessionId: 'session-1',
        expectedTurnId: 'assistant:turn-0',
        userTurnId: 'turn-1',
        userId: 'user-1',
        timestamp: '2026-07-13T00:00:00.000Z',
        inputConfig: { prompt: 'guide' },
      },
    },
    {
      method: 'session/prepare',
      params: {
        preparationId: 'prepare-1',
        sessionId: 'session-1',
        requestedByUserId: 'user-1',
        agentConfigId: 'config-1',
        cliType: 'builtin',
        agentType: 'codex',
        project: {
          kind: 'local',
          localProjectId: 'project-1',
          useWorktree: false,
        },
        runConfig: {
          modeId: 'agent',
          modelId: 'gpt-5',
          configOptionValues: {
            effort: 'high',
            fast: true,
          },
        },
      },
    },
    {
      method: 'session/prepare-cancel',
      params: {
        preparationId: 'prepare-1',
        sessionId: 'session-1',
        requestedByUserId: 'user-1',
      },
    },
    {
      method: 'session/preview-endpoint-acquire',
      params: {
        sessionId: 'session-1',
        requestedByUserId: 'user-1',
        target: { protocol: 'http', host: '127.0.0.1', port: 5173 },
      },
    },
    {
      method: 'session/preview-endpoint-release',
      params: { sessionId: 'session-1', endpointId: 'endpoint-1' },
    },
    {
      method: 'file/preview-local',
      params: { v: 3, sessionId: 'session-1', path: '/Users/me/Documents/notes.md' },
    },
  ])('accepts $method requests', ({ method, params }) => {
    const result = safeParseLocalMachineRpcRequest(
      JSON.stringify({
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        method,
        params,
      })
    );

    expect(result).toEqual({
      success: true,
      data: {
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        method,
        params,
      },
    });
  });

  it('accepts session terminate requests', () => {
    const result = safeParseLocalMachineRpcRequest(
      JSON.stringify({
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        method: 'session/terminate',
        params: { sessionId: 'session-1' },
        timeoutMs: 5_000,
      })
    );

    expect(result).toEqual({
      success: true,
      data: {
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        method: 'session/terminate',
        params: { sessionId: 'session-1' },
        timeoutMs: 5_000,
      },
    });
  });

  it('rejects extra terminate request fields', () => {
    const result = safeParseLocalMachineRpcRequest(
      JSON.stringify({
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        method: 'session/terminate',
        params: { sessionId: 'session-1', pid: 123 },
      })
    );

    expect(result.success).toBe(false);
  });

  it('rejects draft content and environment variables in session preparation', () => {
    const result = safeParseLocalMachineRpcRequest(
      JSON.stringify({
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        method: 'session/prepare',
        params: {
          preparationId: 'prepare-1',
          sessionId: 'session-1',
          requestedByUserId: 'user-1',
          agentConfigId: 'config-1',
          cliType: 'builtin',
          agentType: 'codex',
          prompt: 'private draft',
          env: { API_KEY: 'secret' },
        },
      })
    );

    expect(result.success).toBe(false);
  });

  it('drops sensitive ACP option values from session preparation', () => {
    const result = safeParseLocalMachineRpcRequest(
      JSON.stringify({
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        method: 'session/prepare',
        params: {
          preparationId: 'prepare-1',
          sessionId: 'session-1',
          requestedByUserId: 'user-1',
          agentConfigId: 'config-1',
          cliType: 'builtin',
          agentType: 'codex',
          runConfig: {
            configOptionValues: {
              effort: 'high',
              api_key: 'private',
              authToken: 'private',
            },
          },
        },
      })
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        params: {
          runConfig: {
            configOptionValues: {
              effort: 'high',
            },
          },
        },
      },
    });
  });

  it('requires acquired preview endpoints to identify their bound target', () => {
    const response = {
      ok: true,
      result: {
        type: 'session/preview-endpoint-acquire_response',
        sessionId: 'session-1',
        success: true,
        endpoint: {
          endpointId: 'endpoint-1',
          kind: 'local-proxy',
          viewerUrl: 'http://127.0.0.1:64000/?__lody_local_preview_token=token',
          target: { protocol: 'http', host: '127.0.0.1', port: 5173 },
          capabilities: { visualAnnotation: true, shareable: false },
          createdAt: 1,
        },
      },
    };

    expect(LocalMachineRpcResponseSchema.safeParse(response).success).toBe(true);
    const endpointWithoutTarget = {
      ...response,
      result: {
        ...response.result,
        endpoint: { ...response.result.endpoint, target: undefined },
      },
    };
    expect(LocalMachineRpcResponseSchema.safeParse(endpointWithoutTarget).success).toBe(false);
  });

  it('validates active invocation identity and its frozen input config', () => {
    expect(
      LocalMachineRpcResponseSchema.safeParse({
        ok: true,
        result: {
          type: 'session/active-invocation-context',
          sessionId: 'session-1',
          active: true,
          requesterUserId: 'user-b',
          sourceTurnId: 'turn-b',
          inputConfig: { chainDepth: 1, taskToolsEnabled: true },
        },
      }).success
    ).toBe(true);
    expect(
      LocalMachineRpcResponseSchema.safeParse({
        ok: true,
        result: {
          type: 'session/active-invocation-context',
          sessionId: 'session-1',
          active: true,
          requesterUserId: 'user-b',
        },
      }).success
    ).toBe(false);
  });
});
