import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import { commandHelpReminder, type LodyToolServer } from './tool-help';
import { z } from 'zod';

export type SessionToolHandler = (args: unknown) => Promise<CallToolResult>;
export type SessionToolHandlers = Map<string, SessionToolHandler>;

/** Registration owns validation for both the MCP transport and daemon IPC. */
export function createSessionToolRegistrar(
  server: LodyToolServer,
  route: (
    name: string,
    args: unknown,
    execute: () => Promise<CallToolResult>
  ) => Promise<CallToolResult>,
  handlers?: SessionToolHandlers
) {
  return <T extends z.ZodObject>(
    name: string,
    config: {
      summary: string;
      title?: string;
      description?: string;
      inputSchema: T;
      annotations?: ToolAnnotations;
    },
    callback: (args: z.output<T>) => Promise<CallToolResult>
  ) => {
    handlers?.set(name, async (args) => {
      const parsed = await config.inputSchema.safeParseAsync(args);
      if (!parsed.success) {
        throw new z.ZodError([
          ...parsed.error.issues,
          { code: 'custom', path: [], message: commandHelpReminder(name) },
        ]);
      }
      return callback(parsed.data);
    });
    const inputSchema: z.ZodObject = config.inputSchema;
    return server.registerTool(name, { ...config, inputSchema }, async (args) =>
      // The SDK has already parsed MCP input; only direct daemon calls need parsing here.
      route(name, args, () => callback(args as z.output<T>))
    );
  };
}
