import { z } from 'zod';
import type {
  LodyMcpAppLoadResponse,
  LodyMcpAppResourceReadResponse,
  LodyMcpAppToolCallResponse,
} from 'acp-extension-core';

/**
 * MCP Apps hosting (SEP-1865). History keeps only this descriptor; the HTML,
 * tool input and tool result stay with the agent and are fetched on demand
 * through `session/mcp-app`, so large or sensitive payloads never enter the CRDT.
 */
const McpAppFieldSchema = z.string().min(1).max(2048);

export const McpAppToolCallSchema = z.object({
  server: McpAppFieldSchema,
  tool: McpAppFieldSchema,
  resourceUri: McpAppFieldSchema.refine((uri) => uri.startsWith('ui://'), 'Expected a ui:// URI'),
  // A newer peer's value must not discard the descriptor that makes the card render.
  appName: McpAppFieldSchema.optional().catch(undefined),
  preferredDisplayMode: z.enum(['inline', 'fullscreen']).optional().catch(undefined),
});
export type McpAppToolCall = z.infer<typeof McpAppToolCallSchema>;

const McpAppToolCallMetaSchema = McpAppToolCallSchema.extend({ version: z.literal(1) });

/** Reads `_meta.lody.mcpApp` from an ACP tool call; invalid descriptors are ignored. */
export const parseMcpAppToolCallMeta = (meta: unknown): McpAppToolCall | undefined => {
  const lody = (meta as { lody?: { mcpApp?: unknown } } | null | undefined)?.lody;
  const parsed = McpAppToolCallMetaSchema.safeParse(lody?.mcpApp);
  if (!parsed.success) return undefined;
  const { server, tool, resourceUri, appName, preferredDisplayMode } = parsed.data;
  return {
    server,
    tool,
    resourceUri,
    ...(appName !== undefined ? { appName } : {}),
    ...(preferredDisplayMode !== undefined ? { preferredDisplayMode } : {}),
  };
};

/**
 * Measured on the JSON-serialized result. A real app's single-file HTML was
 * 7,091,831 bytes before JSON escaping, so 8 MiB was too tight. The bound is the
 * daemon's 16 MiB local IPC response cap (`LOCAL_IPC_MAX_RESPONSE_BODY_BYTES`)
 * less room for the response envelope; raising it requires raising that cap too.
 */
export const SESSION_MCP_APP_MAX_RESPONSE_BYTES = 16 * 1024 * 1024 - 64 * 1024;

export const SessionMcpAppErrorCodeSchema = z.enum([
  /** No live agent process, or the agent never advertised `mcpApps`. */
  'MCP_APP_UNAVAILABLE',
  'MCP_APP_ACCESS_DENIED',
  /** The agent rejected the request; `error` carries its message. */
  'MCP_APP_AGENT_ERROR',
  'MCP_APP_RESPONSE_TOO_LARGE',
]);
export type SessionMcpAppErrorCode = z.infer<typeof SessionMcpAppErrorCodeSchema>;

const McpAppTargetShape = {
  sessionId: z.string().trim().min(1),
  toolCallId: z.string().trim().min(1).max(2048),
  userId: z.string().trim().min(1),
};

export const SessionMcpAppRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('load'), ...McpAppTargetShape }).strict(),
  z
    .object({ op: z.literal('resource_read'), ...McpAppTargetShape, uri: McpAppFieldSchema })
    .strict(),
  z
    .object({
      op: z.literal('tool_call'),
      ...McpAppTargetShape,
      name: McpAppFieldSchema,
      arguments: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
]);
export type SessionMcpAppRequest = z.infer<typeof SessionMcpAppRequestSchema>;
export type SessionMcpAppOp = SessionMcpAppRequest['op'];

const McpAppResponseShape = {
  type: z.literal('session/mcp-app_response'),
  sessionId: z.string(),
  toolCallId: z.string(),
};

export const SessionMcpAppResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ...McpAppResponseShape,
      ok: z.literal(true),
      result: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      ...McpAppResponseShape,
      ok: z.literal(false),
      code: SessionMcpAppErrorCodeSchema,
      error: z.string(),
    })
    .strict(),
]);
export type SessionMcpAppResponse = z.infer<typeof SessionMcpAppResponseSchema>;

/** Agent result per op, from the ACP extension contract. */
export type SessionMcpAppResultByOp = {
  load: LodyMcpAppLoadResponse;
  resource_read: LodyMcpAppResourceReadResponse;
  tool_call: LodyMcpAppToolCallResponse;
};

const McpCallToolResultSchema = z.looseObject({
  content: z.array(z.unknown()),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

const AgentResultSchemas = {
  load: z.looseObject({
    app: McpAppToolCallMetaSchema,
    toolInput: z.record(z.string(), z.unknown()),
    toolResult: McpCallToolResultSchema.nullable(),
  }),
  resource_read: z.looseObject({
    contents: z.array(
      z.looseObject({
        uri: z.string(),
        mimeType: z.string().optional(),
        text: z.string().optional(),
        blob: z.string().optional(),
      })
    ),
  }),
  tool_call: McpCallToolResultSchema,
} as const;

/** Validates an agent's `_lody/mcp_apps/*` result at the CLI's foreign boundary. */
export const parseSessionMcpAppAgentResult = (
  op: SessionMcpAppOp,
  raw: unknown
): Record<string, unknown> | null => {
  const parsed = AgentResultSchemas[op].safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export const sessionMcpAppFailure = (
  request: Pick<SessionMcpAppRequest, 'sessionId' | 'toolCallId'>,
  code: SessionMcpAppErrorCode,
  error: string
): SessionMcpAppResponse => ({
  type: 'session/mcp-app_response',
  sessionId: request.sessionId,
  toolCallId: request.toolCallId,
  ok: false,
  code,
  error,
});
