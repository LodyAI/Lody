import type {
  McpServer,
  RegisteredTool,
  ToolAnnotations,
  ToolCallback,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

export const LODY_HELP_INSTRUCTIONS =
  'Before executing a Lody command, you MUST call lody_help({command: TOOL_NAME}) and read its successful command-specific response. The index and short summaries do not replace full help. Read help before issuing the command, never in parallel with it. Reuse full help already in the current context; after compaction or loss, fetch it again. lody_help itself is exempt.';

export type LodyToolServer = {
  registerTool<T extends z.ZodObject>(
    name: string,
    config: {
      summary: string;
      title?: string;
      description?: string;
      inputSchema: T;
      annotations?: ToolAnnotations;
    },
    callback: ToolCallback<T>
  ): RegisteredTool;
};

/** Keep discovery small; serve the executing registration's documentation on demand. */
export function createToolHelpServer(server: McpServer): LodyToolServer {
  const commands = new Map<string, { summary: string; read: () => Record<string, unknown> }>();

  server.registerTool(
    'lody_help',
    {
      title: 'Read Lody command help',
      description:
        'Required before executing a Lody command unless its full help is already in context. Supply command for full documentation; omitting it returns only an index. Read-only; no execution or permission changes.',
      inputSchema: z.object({ command: z.string().trim().min(1).max(100).optional() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ command }) => {
      const entry = command === undefined ? undefined : commands.get(command);
      if (command !== undefined && !entry) {
        return {
          isError: true,
          content: [
            { type: 'text', text: 'Unknown command. Call lody_help({}) for command names.' },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              entry
                ? entry.read()
                : {
                    commands: [...commands].map(([name, { summary }]) => ({ name, summary })),
                  }
            ),
          },
        ],
      };
    }
  );

  return {
    registerTool(name, { summary, ...config }, callback) {
      const registered = server.registerTool(
        name,
        {
          ...config,
          description: `${summary} Before execution, read lody_help({command:"${name}"}); reuse only if full help remains in context.`,
        },
        callback
      );
      commands.set(name, {
        summary,
        read: () => ({
          command: name,
          summary,
          title: config.title,
          description: config.description ?? '',
          inputSchema: z.toJSONSchema(config.inputSchema, { io: 'input' }),
          annotations: config.annotations,
        }),
      });
      return registered;
    },
  };
}
