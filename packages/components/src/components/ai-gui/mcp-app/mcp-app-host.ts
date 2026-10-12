import { createContext } from 'react';
import type { McpAppToolCall, MessageContent, SessionId } from '@lody/shared';
import type { McpAppHostActions, McpAppHostResult } from '@/hooks/use-mcp-app-host';

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;

/**
 * Electron main serves the sandbox proxy from this dedicated scheme
 * (`apps/electron/src/main/services/mcp-app-sandbox.ts`). A `srcdoc`,
 * `blob:` or `data:` frame would inherit the renderer CSP and never run the
 * app's inline scripts.
 */
export const MCP_APP_SANDBOX_URL = 'lody-mcp-app://sandbox/';

export type McpAppLoadResult = {
  toolInput: Record<string, unknown>;
  toolResult: Record<string, unknown> | null;
};

/** What a conversation grants MCP App cards: the originating session's agent, and nothing else. */
export type McpAppHost = {
  sandboxUrl: string;
  load: (toolCallId: string) => Promise<McpAppLoadResult>;
  readResource: (toolCallId: string, uri: string) => Promise<{ contents: unknown[] }>;
  callTool: (
    toolCallId: string,
    name: string,
    args: Record<string, unknown> | undefined
  ) => Promise<Record<string, unknown>>;
};

const unwrap = async <T>(pending: Promise<McpAppHostResult<T>>): Promise<T> => {
  const result = await pending;
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

/** Scopes the session's Machine RPC actions to one conversation. */
export const createMcpAppHost = (sessionId: SessionId, actions: McpAppHostActions): McpAppHost => ({
  sandboxUrl: MCP_APP_SANDBOX_URL,
  load: async (toolCallId) => {
    const loaded = await unwrap(actions.mcpAppLoad(sessionId, toolCallId));
    return { toolInput: loaded.toolInput, toolResult: loaded.toolResult };
  },
  readResource: (toolCallId, uri) => unwrap(actions.mcpAppReadResource(sessionId, toolCallId, uri)),
  callTool: (toolCallId, name, args) =>
    unwrap(actions.mcpAppCallTool(sessionId, toolCallId, name, args)),
});

/** Absent (shares, read-only replay, non-Electron hosts) means cards show "App unavailable". */
export const McpAppHostContext = createContext<McpAppHost | null>(null);

/** A failed call has no app to show; it keeps the ordinary tool row. */
export const getRenderableMcpApp = (toolCall: ToolCallMessage): McpAppToolCall | null =>
  toolCall.mcpApp && toolCall.status !== 'failed' ? toolCall.mcpApp : null;

export const humanizeMcpServerName = (server: string): string =>
  server
    .split(/[_\-.\s]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ') || server;
