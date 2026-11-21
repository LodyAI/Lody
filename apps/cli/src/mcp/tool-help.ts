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

/** Approved owner guidance: long work is resumed by an event rather than awaited in a turn. */
export const LODY_LONG_RUN_GUIDANCE =
  'An idle Session may be reclaimed, which ends background processes you started; run long commands with lody_automation `run`, which resumes this Session when they exit.';

export const commandHelpReminder = (name: string): string =>
  `Before using this command, read lody_help({command:"${name}"}) and follow its parameter and retry rules.`;

type JsonSchemaNode = Record<string, unknown>;

const isJsonSchemaNode = (value: unknown): value is JsonSchemaNode =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Keywords whose value maps names (not keywords) to subschemas. */
const SCHEMA_MAP_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
]);
/** Keywords whose value is instance data; copied verbatim, never walked. */
const DATA_KEYWORDS = new Set(['const', 'default', 'enum', 'examples']);

function withoutDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutDescriptions);
  if (!isJsonSchemaNode(node)) return node;
  const copy: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && typeof value === 'string') continue;
    if (key === 'pattern' && typeof node.format === 'string') continue;
    if (DATA_KEYWORDS.has(key)) copy[key] = value;
    else if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonSchemaNode(value))
      copy[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [name, withoutDescriptions(schema)])
      );
    else copy[key] = withoutDescriptions(value);
  }
  return copy;
}

/**
 * The eager `tools/list` copy of an input schema. It keeps every type, enum, bound and
 * required list, plus the short phrase on each top-level argument; prose on nested fields
 * (batch items, work contexts, unions) is served only by `lody_help`. Validation never reads
 * this copy. `$schema` is omitted because MCP defaults input schemas to draft 2020-12, and a
 * generated `pattern` is omitted where a `format` (date-time, uuid, ...) already names it.
 */
export function eagerInputJsonSchema(schema: JsonSchemaNode): JsonSchemaNode {
  const eager: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$schema' || (key === 'description' && typeof value === 'string')) continue;
    if (key === 'pattern' && typeof schema.format === 'string') continue;
    if (key === 'properties' && isJsonSchemaNode(value)) {
      eager[key] = Object.fromEntries(
        Object.entries(value).map(([name, property]) => {
          if (!isJsonSchemaNode(property)) return [name, property];
          const slim = withoutDescriptions(property);
          return [
            name,
            typeof property.description === 'string' && isJsonSchemaNode(slim)
              ? { description: property.description, ...slim }
              : slim,
          ];
        })
      );
    } else eager[key] = withoutDescriptions(value);
  }
  return eager;
}

/** The SDK validates before callbacks; preserve the validator and append a recovery hint to issues. */
function inputWithHelp<T extends z.ZodObject>(
  schema: T,
  name: string
): StandardSchemaWithJSON<
  StandardSchemaWithJSON.InferInput<T>,
  StandardSchemaWithJSON.InferOutput<T>
> {
  const standard = schema['~standard'];
  return {
    '~standard': {
      ...standard,
      jsonSchema: {
        input: (options) => eagerInputJsonSchema(standard.jsonSchema.input(options)),
        output: (options) => standard.jsonSchema.output(options),
      },
      validate: async (value, options) => {
        const result = await standard.validate(value, options);
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
          // The help-first rule lives once in the server instructions and the Lody prompt,
          // and every failure appends commandHelpReminder; repeating it per tool cost ~4 KB.
          description: summary,
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
