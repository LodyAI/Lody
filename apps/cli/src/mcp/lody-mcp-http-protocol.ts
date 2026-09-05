import { z } from 'zod';

/**
 * Shared wire contract between the daemon-side supervisor
 * (`lody-mcp-http-server.ts`), the MCP HTTP host subprocess
 * (`lody-mcp-http-host.ts`), and the ACP client config builder
 * (`agent-client.ts`). Deliberately import-light: the daemon must be able to
 * build MCP server entries without pulling in the MCP tool module.
 */

export interface LodyMcpHttpEndpoint {
  url: string;
  token: string;
}

export const MCP_HTTP_SESSION_ID_HEADER = 'x-lody-mcp-session-id';
export const MCP_HTTP_WORKSPACE_ID_HEADER = 'x-lody-mcp-workspace-id';
export const MCP_HTTP_MACHINE_ID_HEADER = 'x-lody-mcp-machine-id';
export const MCP_HTTP_TASK_TOOLS_ENABLED_HEADER = 'x-lody-mcp-task-tools-enabled';
export const MCP_HTTP_SCHEDULE_TOOLS_ENABLED_HEADER = 'x-lody-mcp-schedule-tools-enabled';
// Base64url-encoded: workdir paths are arbitrary UTF-8, HTTP headers are not.
export const MCP_HTTP_WORKDIR_B64_HEADER = 'x-lody-mcp-workdir-b64';

/** Env vars the supervisor passes to the host subprocess. The token lives in
 * the child environment (owner-readable only), never on its command line. */
export const MCP_HTTP_TOKEN_ENV = 'LODY_MCP_HTTP_TOKEN';
export const MCP_HTTP_PREFERRED_PORT_ENV = 'LODY_MCP_HTTP_PREFERRED_PORT';

/** One JSON line written by the host on its handshake fd once listening. */
export const McpHttpHostHandshakeSchema = z.object({
  type: z.literal('lody-mcp-http-listening'),
  port: z.number().int().positive(),
});
export type McpHttpHostHandshake = z.infer<typeof McpHttpHostHandshakeSchema>;

/** Header set for one session's MCP server entry (ACP `HttpHeader` shape). */
export const buildLodyMcpHttpHeaders = (
  endpoint: LodyMcpHttpEndpoint,
  context: {
    sessionId: string;
    workspaceId: string;
    machineId: string;
    workdir: string;
    taskToolsEnabled: boolean;
    scheduleToolsEnabled?: boolean;
  }
): Array<{ name: string; value: string }> => [
  { name: 'Authorization', value: `Bearer ${endpoint.token}` },
  { name: MCP_HTTP_SESSION_ID_HEADER, value: context.sessionId },
  { name: MCP_HTTP_WORKSPACE_ID_HEADER, value: context.workspaceId },
  { name: MCP_HTTP_MACHINE_ID_HEADER, value: context.machineId },
  { name: MCP_HTTP_TASK_TOOLS_ENABLED_HEADER, value: context.taskToolsEnabled ? '1' : '0' },
  { name: MCP_HTTP_SCHEDULE_TOOLS_ENABLED_HEADER, value: context.scheduleToolsEnabled ? '1' : '0' },
  {
    name: MCP_HTTP_WORKDIR_B64_HEADER,
    value: Buffer.from(context.workdir, 'utf8').toString('base64url'),
  },
];
