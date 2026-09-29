import type { McpServer, CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';

export type SessionToolHandler = (args: unknown) => Promise<CallToolResult>;
export type SessionToolHandlers = Map<string, SessionToolHandler>;

/** Registration owns validation for both the MCP transport and daemon IPC. */
export function createSessionToolRegistrar(
  server: McpServer,
  route: (
    name: string,
    args: unknown,
    execute: () => Promise<CallToolResult>
  ) => Promise<CallToolResult>,
  handlers?: SessionToolHandlers
) {
  return <T extends z.ZodObject>(
    name: string,
    config: { title?: string; description?: string; inputSchema: T; annotations?: ToolAnnotations },
    callback: (args: z.output<T>) => Promise<CallToolResult>
  ) => {
    handlers?.set(name, async (args) => callback(await config.inputSchema.parseAsync(args)));
    const inputSchema: z.ZodObject = config.inputSchema;
    return server.registerTool(name, { ...config, inputSchema }, async (args) =>
      // The SDK has already parsed MCP input; only direct daemon calls need parsing here.
      route(name, args, () => callback(args as z.output<T>))
    );
  };
}
