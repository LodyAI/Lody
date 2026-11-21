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

/**
 * Approved owner guidance (2026-11-21), one sentence per Session and only when its working
 * directory has git. With the managed `gh` shim, `gh pr create` links its PR, so only other
 * paths need the action; without the shim (native credentials) every PR needs it.
 */
export const LODY_PR_LINK_GUIDANCE =
  'A pull or merge request this Session opened without gh pr create is linked to it with lody_session_manage action pr_link.';
export const LODY_PR_LINK_GUIDANCE_WITHOUT_GH_SHIM =
  'A pull or merge request this Session opens is linked to it with lody_session_manage action pr_link.';

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

/** The MCP request context a tool callback receives (abort signal, session). */
export type LodyToolExtra = Parameters<ToolCallback<z.ZodObject>>[1];

/**
 * One action of an action tool. `inputSchema` validates the action's `arguments`
 * and is published only through `lody_help`; `run` receives the parsed arguments.
 */
export type LodyToolAction = {
  summary: string;
  description: string;
  inputSchema: z.ZodObject;
  run: (raw: unknown, extra?: LodyToolExtra) => Promise<CallToolResult>;
};

export function defineToolAction<S extends z.ZodObject>(action: {
  summary: string;
  description: string;
  inputSchema: S;
  run: (args: z.output<S>, extra?: LodyToolExtra) => Promise<CallToolResult>;
}): LodyToolAction {
  return { ...action, run: (raw, extra) => action.run(action.inputSchema.parse(raw), extra) };
}

/**
 * The eager schema of an action tool is thin: an `action` enum and an `arguments`
 * object. Validation is not: each action's real schema checks `arguments`, and its
 * issues keep their paths below `arguments` so the existing help reminder applies.
 */
export function actionToolInputSchema<K extends string>(
  actions: Record<K, LodyToolAction>,
  actionPhrase: string
) {
  const names = Object.keys(actions) as [K, ...K[]];
  return z
    .object({
      action: z.enum(names).describe(actionPhrase),
      arguments: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Fields of the chosen action; lody_help({command, action}) lists them.'),
    })
    .strict()
    .superRefine((value, ctx) => {
      const result = actions[value.action].inputSchema.safeParse(value.arguments ?? {});
      if (result.success) return;
      for (const issue of result.error.issues)
        ctx.addIssue({
          code: 'custom',
          path: ['arguments', ...issue.path],
          message: `${value.action}: ${issue.message}`,
        });
    });
}

export const runToolAction = <K extends string>(
  actions: Record<K, LodyToolAction>,
  input: { action: K; arguments?: Record<string, unknown> },
  extra?: LodyToolExtra
): Promise<CallToolResult> => actions[input.action].run(input.arguments ?? {}, extra);

export type LodyToolConfig<T extends z.ZodObject> = {
  summary: string;
  title?: string;
  description?: string;
  inputSchema: T;
  annotations?: ToolAnnotations;
  /** Action tools: per-action documentation served by `lody_help({command, action})`. */
  actions?: Record<string, LodyToolAction>;
};

export type LodyToolServer = {
  registerTool<T extends z.ZodObject>(
    name: string,
    config: LodyToolConfig<T>,
    callback: ToolCallback<T>
  ): RegisteredTool;
};

const actionHelp = (name: string, action: string, entry: LodyToolAction) => ({
  command: name,
  action,
  summary: entry.summary,
  description: entry.description,
  argumentsSchema: z.toJSONSchema(entry.inputSchema, { io: 'input' }),
});

/** Keep discovery small; serve the executing registration's documentation on demand. */
export function createToolHelpServer(server: McpServer): LodyToolServer {
  const commands = new Map<
    string,
    {
      summary: string;
      read: () => Record<string, unknown>;
      actions?: Record<string, LodyToolAction>;
    }
  >();

  server.registerTool(
    'lody_help',
    {
      title: 'Read Lody command help',
      description:
        'Required before executing a Lody command unless its full help is already in context. Supply command for full documentation, including every action of an action tool; add action for that action alone; omitting command returns only an index. Read-only; no execution or permission changes.',
      inputSchema: z
        .object({
          command: z.string().trim().min(1).max(100).optional(),
          action: z.string().trim().min(1).max(100).optional(),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ command, action }) => {
      const entry = command === undefined ? undefined : commands.get(command);
      if ((command !== undefined && !entry) || (command === undefined && action !== undefined)) {
        return {
          isError: true,
          content: [
            { type: 'text', text: 'Unknown command. Call lody_help({}) for command names.' },
          ],
        };
      }
      if (entry && command !== undefined && action !== undefined) {
        const actionEntry = entry.actions?.[action];
        return actionEntry
          ? {
              content: [
                { type: 'text', text: JSON.stringify(actionHelp(command, action, actionEntry)) },
              ],
            }
          : {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: entry.actions
                    ? `Unknown action. ${command} actions: ${Object.keys(entry.actions).join(', ')}.`
                    : `${command} has no actions; call lody_help({command:"${command}"}).`,
                },
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
    registerTool(name, { summary, actions, ...config }, callback) {
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
        actions,
        read: () => ({
          command: name,
          summary,
          title: config.title,
          description: config.description ?? '',
          inputSchema: z.toJSONSchema(config.inputSchema, { io: 'input' }),
          annotations: config.annotations,
          // Full help of an action tool is every action's complete documentation.
          ...(actions
            ? {
                actions: Object.entries(actions).map(([action, entry]) =>
                  actionHelp(name, action, entry)
                ),
              }
            : {}),
        }),
      });
      return registered;
    },
  };
}
