import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  type MachineId,
  type SessionId,
  type SessionMcpAppErrorCode,
  type SessionMcpAppOp,
  type SessionMcpAppRequest,
  type SessionMcpAppResultByOp,
  type SessionMeta,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { activeWorkspaceRuntimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';

export type McpAppHostResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SessionMcpAppErrorCode; error: string };

export type McpAppHostActions = {
  mcpAppLoad: (
    sessionId: SessionId,
    toolCallId: string
  ) => Promise<McpAppHostResult<SessionMcpAppResultByOp['load']>>;
  mcpAppReadResource: (
    sessionId: SessionId,
    toolCallId: string,
    uri: string
  ) => Promise<McpAppHostResult<SessionMcpAppResultByOp['resource_read']>>;
  mcpAppCallTool: (
    sessionId: SessionId,
    toolCallId: string,
    name: string,
    args?: Record<string, unknown>
  ) => Promise<McpAppHostResult<SessionMcpAppResultByOp['tool_call']>>;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const unavailable = (error: string) => ({ ok: false, code: 'MCP_APP_UNAVAILABLE', error }) as const;

/**
 * Requests run as the viewing user (the target daemon verifies machine access),
 * on the machine that owns the session. Results were validated by the daemon.
 */
export function createMcpAppHostActions(
  runtime: Pick<WorkspaceRuntime, 'repo' | 'requestSessionMcpApp'> | null,
  viewerUserId: string | null
): McpAppHostActions {
  const send = async <Op extends SessionMcpAppOp>(
    request: DistributiveOmit<Extract<SessionMcpAppRequest, { op: Op }>, 'userId'>
  ): Promise<McpAppHostResult<SessionMcpAppResultByOp[Op]>> => {
    if (!runtime) return unavailable('Workspace runtime is not ready.');
    const existing = await runtime.repo.getDocMeta(
      getSessionRoomId(request.sessionId as SessionId)
    );
    const meta = isLoroRepoDocDeleted(existing)
      ? undefined
      : (existing?.meta as SessionMeta | undefined);
    const machineId = meta?.machineId as MachineId | undefined;
    const userId = viewerUserId ?? meta?.userId;
    if (!machineId || !userId) return unavailable('The session has no machine to serve the app.');
    const response = await runtime.requestSessionMcpApp(machineId, {
      ...request,
      userId,
    } as SessionMcpAppRequest);
    return response.ok
      ? { ok: true, value: response.result as SessionMcpAppResultByOp[Op] }
      : { ok: false, code: response.code, error: response.error };
  };
  return {
    mcpAppLoad: (sessionId, toolCallId) => send<'load'>({ op: 'load', sessionId, toolCallId }),
    mcpAppReadResource: (sessionId, toolCallId, uri) =>
      send<'resource_read'>({ op: 'resource_read', sessionId, toolCallId, uri }),
    mcpAppCallTool: (sessionId, toolCallId, name, args) =>
      send<'tool_call'>({
        op: 'tool_call',
        sessionId,
        toolCallId,
        name,
        ...(args ? { arguments: args } : {}),
      }),
  };
}

/** MCP App host actions for the active workspace; stable while runtime and user are. */
export function useMcpAppHost(): McpAppHostActions {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const viewerUserId = useAtomValue(userAtom)?.id ?? null;
  return useMemo(() => createMcpAppHostActions(runtime, viewerUserId), [runtime, viewerUserId]);
}
