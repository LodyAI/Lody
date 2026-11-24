import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  commandHelpReminder,
  type LodyToolConfig,
  type LodyToolExtra,
  type LodyToolServer,
} from './tool-help';
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
    config: LodyToolConfig<T> & {
      /**
       * Calls that must run in the MCP process that received them (for example, one
       * that needs this request's abort signal or the CLI account). They never cross
       * daemon IPC, and a direct daemon call for them is rejected.
       */
      executeLocally?: (args: z.output<T>) => boolean;
    },
    callback: (args: z.output<T>, extra?: LodyToolExtra) => Promise<CallToolResult>
  ) => {
    const { executeLocally, ...toolConfig } = config;
    handlers?.set(name, async (args) => {
      const parsed = await config.inputSchema.safeParseAsync(args);
      if (!parsed.success) {
        throw new z.ZodError([
          ...parsed.error.issues,
          { code: 'custom', path: [], message: commandHelpReminder(name) },
        ]);
      }
      if (executeLocally?.(parsed.data))
        throw new Error(`Unsupported daemon Session tool call: ${name}`);
      return callback(parsed.data);
    });
    const inputSchema: z.ZodObject = config.inputSchema;
    return server.registerTool(name, { ...toolConfig, inputSchema }, async (args, extra) => {
      // The SDK has already parsed MCP input; only direct daemon calls need parsing here.
      const parsed = args as z.output<T>;
      if (executeLocally?.(parsed)) return callback(parsed, extra);
      return route(name, args, () => callback(parsed, extra));
    });
  };
}
