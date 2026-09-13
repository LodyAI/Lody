import { randomUUID } from 'node:crypto';
import {
  ENV_VAR_NAME_PATTERN,
  areWorkspaceMcpNamesEqual,
  getServerNow,
  type McpServerId,
  type WorkspaceId,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import { z } from 'zod';
import {
  WORKSPACE_SYNC_UNAVAILABLE_MESSAGE,
  WorkspaceSyncUnavailableError,
} from '@/lib/command-runtime';
import {
  listWorkspaceMcpCatalog,
  syncMcpCatalog,
  upsertWorkspaceMcpCatalogEntry,
  type McpCatalogWriteResult,
} from '@/lib/workspace-mcp-store';

const MAX_MCP_CATALOG_ENTRIES = 100;
const MAX_MCP_CONFIG_BYTES = 64 * 1024;
const MAX_MCP_NAME_LENGTH = 128;
const MAX_MCP_DESCRIPTION_LENGTH = 1_024;
const MAX_MCP_STRING_LENGTH = 4_096;
const MAX_MCP_COLLECTION_ENTRIES = 64;
const SECRET_REFERENCE_PATTERN = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const boundedRecord = (valueSchema: z.ZodType<string>) =>
  z
    .record(z.string().min(1).max(256).regex(HTTP_HEADER_NAME_PATTERN), valueSchema)
    .refine((value) => Object.keys(value).length <= MAX_MCP_COLLECTION_ENTRIES, {
      message: `At most ${MAX_MCP_COLLECTION_ENTRIES} entries are allowed.`,
    });

const SecretReferenceSchema = z
  .string()
  .trim()
  .max(MAX_MCP_STRING_LENGTH)
  .regex(SECRET_REFERENCE_PATTERN, 'Use a ${VAR} reference instead of a literal credential.');

const EnvironmentSchema = z
  .record(z.string().max(256).regex(ENV_VAR_NAME_PATTERN), SecretReferenceSchema)
  .refine((value) => Object.keys(value).length <= MAX_MCP_COLLECTION_ENTRIES, {
    message: `At most ${MAX_MCP_COLLECTION_ENTRIES} environment entries are allowed.`,
  });

const HeaderSchema = boundedRecord(SecretReferenceSchema);

const HttpEndpointSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_MCP_STRING_LENGTH)
  .superRefine((value, ctx) => {
    try {
      const parsed = new URL(value.replaceAll(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, 'placeholder'));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('unsupported protocol');
      }
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'HTTP MCP endpoints must not include credentials, query parameters, or fragments.',
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a valid HTTP or HTTPS MCP endpoint.',
      });
    }
  });

const StdioMcpConnectionInputSchema = z
  .object({
    transport: z.literal('stdio'),
    command: z
      .string()
      .trim()
      .min(1)
      .max(MAX_MCP_STRING_LENGTH)
      .describe('Executable used to start the MCP server.'),
    args: z
      .array(z.string().max(MAX_MCP_STRING_LENGTH))
      .max(MAX_MCP_COLLECTION_ENTRIES)
      .optional()
      .describe(
        'Workspace-readable arguments passed to the executable. Use envPassthrough rather than literal credentials.'
      ),
    env: EnvironmentSchema.optional().describe(
      'Environment values stored as ${VAR} references. Literal values are rejected on the Agent path.'
    ),
    envPassthrough: z
      .array(z.string().trim().regex(ENV_VAR_NAME_PATTERN))
      .max(MAX_MCP_COLLECTION_ENTRIES)
      .optional()
      .describe('Environment variable names read from the target Lody daemon environment.'),
  })
  .strict();

const HttpMcpConnectionInputSchema = z
  .object({
    transport: z.literal('http'),
    url: HttpEndpointSchema.describe(
      'Streamable HTTP MCP endpoint without credentials or query parameters.'
    ),
    bearerToken: SecretReferenceSchema.optional().describe(
      'Optional bearer token as a ${VAR} reference. Literal credentials are rejected.'
    ),
    headers: HeaderSchema.optional().describe(
      'Optional HTTP headers. Every value must be a ${VAR} reference.'
    ),
  })
  .strict()
  .superRefine((connection, ctx) => {
    const seen = new Set<string>();
    for (const name of Object.keys(connection.headers ?? {})) {
      const canonicalName = name.toLocaleLowerCase('en-US');
      if (seen.has(canonicalName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['headers', name],
          message: 'HTTP header names must be unique case-insensitively.',
        });
      }
      seen.add(canonicalName);
    }
    if (connection.bearerToken && seen.has('authorization')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['headers', 'Authorization'],
        message: 'Do not combine bearerToken with an Authorization header.',
      });
    }
  });

export const WorkspaceMcpConfigureToolInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(MAX_MCP_NAME_LENGTH)
      .refine((name) => !areWorkspaceMcpNamesEqual(name, 'lody'), {
        message: 'The name "lody" is reserved for the built-in Lody MCP server.',
      })
      .describe('Unique workspace display name. Existing names must be updated in trusted UI/CLI.'),
    description: z
      .string()
      .trim()
      .min(1)
      .max(MAX_MCP_DESCRIPTION_LENGTH)
      .optional()
      .describe('Optional human-readable purpose.'),
    connection: z.discriminatedUnion('transport', [
      StdioMcpConnectionInputSchema,
      HttpMcpConnectionInputSchema,
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_MCP_CONFIG_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `The serialized MCP configuration must not exceed ${MAX_MCP_CONFIG_BYTES} bytes.`,
      });
    }
  });

export type WorkspaceMcpConfigureToolInput = z.infer<typeof WorkspaceMcpConfigureToolInputSchema>;

type WorkspaceMcpConfigureManager = Parameters<typeof syncMcpCatalog>[0] & {
  repo: Parameters<typeof listWorkspaceMcpCatalog>[0] &
    Parameters<typeof upsertWorkspaceMcpCatalogEntry>[0];
};

type ConfigureWorkspaceMcpServerDeps = {
  syncCatalog: typeof syncMcpCatalog;
  listCatalog: typeof listWorkspaceMcpCatalog;
  upsertEntry: typeof upsertWorkspaceMcpCatalogEntry;
  now: () => number;
  createId: () => McpServerId;
};

const defaultDeps: ConfigureWorkspaceMcpServerDeps = {
  syncCatalog: syncMcpCatalog,
  listCatalog: listWorkspaceMcpCatalog,
  upsertEntry: upsertWorkspaceMcpCatalogEntry,
  now: getServerNow,
  createId: () => randomUUID() as McpServerId,
};

const configureQueues = new Map<string, Promise<void>>();

async function withWorkspaceConfigureLock<T>(
  workspaceId: WorkspaceId,
  run: () => Promise<T>
): Promise<T> {
  const previous = configureQueues.get(workspaceId) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  configureQueues.set(workspaceId, tail);
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release();
    if (configureQueues.get(workspaceId) === tail) {
      configureQueues.delete(workspaceId);
    }
  }
}

export type WorkspaceMcpConfigureResult = McpCatalogWriteResult & {
  action: 'created';
  server: Pick<
    WorkspaceMcpServerMeta,
    'id' | 'name' | 'transport' | 'description' | 'enabledByDefault'
  >;
};

/**
 * Add one server under a new workspace-unique display name.
 * The returned summary deliberately excludes connection credentials.
 * Agent-authored entries are never selected by default; trusted UI/CLI owns updates and selection.
 */
export async function configureWorkspaceMcpServer(
  manager: WorkspaceMcpConfigureManager,
  workspaceId: WorkspaceId,
  userId: string,
  rawInput: WorkspaceMcpConfigureToolInput,
  deps: ConfigureWorkspaceMcpServerDeps = defaultDeps
): Promise<WorkspaceMcpConfigureResult> {
  const input = WorkspaceMcpConfigureToolInputSchema.parse(rawInput);
  return withWorkspaceConfigureLock(workspaceId, async () => {
    try {
      await deps.syncCatalog(manager, workspaceId);
    } catch (error) {
      throw new WorkspaceSyncUnavailableError({
        message: WORKSPACE_SYNC_UNAVAILABLE_MESSAGE,
        cause: error,
      });
    }

    const servers = await deps.listCatalog(manager.repo, workspaceId);
    const matches = servers.filter((server) => areWorkspaceMcpNamesEqual(server.name, input.name));
    if (matches.length > 0) {
      throw new Error(
        `A workspace MCP server named ${input.name} already exists. Review and update it in Settings → MCP or with lody mcp set.`
      );
    }

    if (servers.length >= MAX_MCP_CATALOG_ENTRIES) {
      throw new Error(
        `The workspace MCP catalog already contains ${MAX_MCP_CATALOG_ENTRIES} entries. Remove one before adding another.`
      );
    }

    const now = deps.now();
    const connection = {
      ...input.connection,
      ...(input.connection.transport === 'stdio' && input.connection.envPassthrough
        ? { envPassthrough: [...new Set(input.connection.envPassthrough)] }
        : {}),
    };
    const next: WorkspaceMcpServerMeta = {
      id: deps.createId(),
      name: input.name,
      transport: input.connection.transport,
      connection,
      enabledByDefault: false,
      createdAt: now,
      updatedAt: now,
      createdBy: userId,
      ...(input.description ? { description: input.description } : {}),
    };

    const write = await deps.upsertEntry(manager.repo, workspaceId, next);
    return {
      ...write,
      action: 'created',
      server: {
        id: next.id,
        name: next.name,
        transport: next.transport,
        ...(next.description !== undefined ? { description: next.description } : {}),
        ...(next.enabledByDefault !== undefined ? { enabledByDefault: next.enabledByDefault } : {}),
      },
    };
  });
}
