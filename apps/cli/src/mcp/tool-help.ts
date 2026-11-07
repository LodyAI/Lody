import type {
  McpServer,
  CallToolResult,
  InputRequiredResult,
  RegisteredTool,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

export const LODY_HELP_INSTRUCTIONS =
  'Before executing a Lody command, you MUST call lody_help({command: TOOL_NAME}) and read its successful command-specific response. The index and short summaries do not replace full help. Read help before issuing the command, never in parallel with it. Reuse full help already in the current context; after compaction or loss, fetch it again. lody_help itself is exempt.';

export const commandHelpReminder = (name: string): string =>
  `Before using this command, read lody_help({command:"${name}"}) and follow its parameter and retry rules.`;

/** The SDK validates before callbacks; preserve the schema and append a recovery hint to issues. */
function inputWithHelp<T extends z.ZodObject>(
  schema: T,
  name: string
): StandardSchemaWithJSON<
  StandardSchemaWithJSON.InferInput<T>,
  StandardSchemaWithJSON.InferOutput<T>
> {
  return {
    '~standard': {
      ...schema['~standard'],
      validate: async (value, options) => {
        const result = await schema['~standard'].validate(value, options);
        return result.issues
          ? { issues: [...result.issues, { message: commandHelpReminder(name) }] }
          : result;
      },
    },
  };
}

function isFailedToolResult(
  result: CallToolResult | InputRequiredResult
): result is CallToolResult {
  return result.isError === true && Array.isArray(result.content);
}

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
      const inputSchema = inputWithHelp(config.inputSchema, name);
      const execute: ToolCallback<typeof inputSchema> = async (args, context) => {
        const result = await callback(args, context);
        return isFailedToolResult(result)
          ? {
              ...result,
              content: [...result.content, { type: 'text', text: commandHelpReminder(name) }],
            }
          : result;
      };
      // Select the Standard Schema overload while keeping the underlying Zod validation/JSON schema.
      const registered = server.registerTool<StandardSchemaWithJSON, typeof inputSchema>(
        name,
        {
          ...config,
          inputSchema,
          description: `${summary} Before execution, read lody_help({command:"${name}"}); reuse only if full help remains in context.`,
        },
        execute
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
