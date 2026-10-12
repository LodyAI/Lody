import { describe, expect, it } from 'vitest';
import type { MachineId, SessionId, SessionMcpAppRequest } from '@lody/shared';
import { createMcpAppHostActions } from '../src/hooks/use-mcp-app-host';

const sessionId = 'session-1' as SessionId;

const createRuntime = (meta: Record<string, unknown> | undefined) => {
  const routed: Array<{ machineId: MachineId; request: SessionMcpAppRequest }> = [];
  const runtime = {
    repo: { getDocMeta: async () => (meta ? { meta } : undefined) },
    requestSessionMcpApp: async (machineId: MachineId, request: SessionMcpAppRequest) => {
      routed.push({ machineId, request });
      return {
        type: 'session/mcp-app_response' as const,
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        ok: true as const,
        result: { content: [{ type: 'text', text: 'expanded' }] },
      };
    },
  };
  return { runtime, routed };
};

describe('createMcpAppHostActions', () => {
  it('routes app requests to the session machine as the viewing user', async () => {
    const { runtime, routed } = createRuntime({ machineId: 'machine-1', userId: 'owner' });
    const actions = createMcpAppHostActions(runtime as never, 'viewer');

    await expect(actions.mcpAppCallTool(sessionId, 'call-1', 'expand', { id: 7 })).resolves.toEqual(
      { ok: true, value: { content: [{ type: 'text', text: 'expanded' }] } }
    );
    await actions.mcpAppReadResource(sessionId, 'call-1', 'ui://apps/graph');

    expect(routed).toEqual([
      {
        machineId: 'machine-1',
        request: {
          op: 'tool_call',
          sessionId,
          toolCallId: 'call-1',
          userId: 'viewer',
          name: 'expand',
          arguments: { id: 7 },
        },
      },
      {
        machineId: 'machine-1',
        request: {
          op: 'resource_read',
          sessionId,
          toolCallId: 'call-1',
          userId: 'viewer',
          uri: 'ui://apps/graph',
        },
      },
    ]);
  });

  it('reports a session without a machine as unavailable', async () => {
    const { runtime, routed } = createRuntime({ userId: 'owner' });
    const actions = createMcpAppHostActions(runtime as never, 'viewer');

    await expect(actions.mcpAppLoad(sessionId, 'call-1')).resolves.toMatchObject({
      ok: false,
      code: 'MCP_APP_UNAVAILABLE',
    });
    expect(routed).toEqual([]);
  });
});
