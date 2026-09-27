import { Command } from 'commander';
import { discoveryListCommand } from './discovery';
import { isDeepStrictEqual } from 'node:util';
import { v4 as uuidV4 } from 'uuid';
import {
  ENV_VAR_NAME_PATTERN,
  getServerNow,
  type McpConnectionSpec,
  type McpHttpConnection,
  type McpServerId,
  type McpStdioConnection,
  type WorkspaceId,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import {
  getAuthContextOrThrow,
  normalizeCliValue,
  printJson,
  resolveWorkspaceOrThrow,
  runOneShotCommand,
  withWorkspaceManager,
  type CommonCommandOptions,
} from '@/lib/command-runtime';
import {
  deleteWorkspaceMcpCatalogEntry,
  listWorkspaceMcpCatalog,
  syncMcpCatalog,
  upsertWorkspaceMcpCatalogEntry,
  type McpCatalogWriteResult,
} from '@/lib/workspace-mcp-store';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { parseEnvAssignments } from './agent-config';
import { formatErrorMessage } from '@/utils/format-error';
import { captureCli } from '@/lib/analytics/posthog';

type ConnectionOptions = {
  command?: string;
  arg?: string[];
  env?: string[];
  envPassthrough?: string[];
  url?: string;
  bearerToken?: string;
  header?: string[];
};

type McpCommandOptions = CommonCommandOptions;
type McpAddOptions = McpCommandOptions &
  ConnectionOptions & {
    description?: string;
    default?: boolean;
  };
type McpSetOptions = McpCommandOptions &
  ConnectionOptions & {
    name?: string;
    description?: string;
    default?: boolean;
  };

function collect(value: string, previous: string[] = []): string[] {
  previous.push(value);
  return previous;
}

function parseHeaders(values: string[] | undefined): Record<string, string> | undefined {
  if (values === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf(':');
    const name = separator > 0 ? value.slice(0, separator).trim() : '';
    if (!name) {
      throw new Error(`Invalid --header value: ${value}. Expected Name: value.`);
    }
    result[name] = value.slice(separator + 1).trim();
  }
  return result;
}

function normalizePassthrough(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const names = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  for (const name of names) {
    if (!ENV_VAR_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid --env-passthrough name: ${name}`);
    }
  }
  return names;
}

function hasStdioOptions(options: ConnectionOptions): boolean {
  return (
    options.command !== undefined ||
    options.arg !== undefined ||
    options.env !== undefined ||
    options.envPassthrough !== undefined
  );
}

function hasHttpOptions(options: ConnectionOptions): boolean {
  return (
    options.url !== undefined || options.bearerToken !== undefined || options.header !== undefined
  );
}

function buildMcpConnectionFromOptions(
  options: ConnectionOptions,
  existing?: McpConnectionSpec
): McpConnectionSpec | undefined {
  const stdio = hasStdioOptions(options);
  const http = hasHttpOptions(options);
  if (stdio && http) {
    throw new Error(
      'Do not mix stdio options (--command/--arg/--env) with HTTP options (--url/--header).'
    );
  }
  if (!stdio && !http) {
    return existing;
  }

  if (stdio) {
    const previous = existing?.transport === 'stdio' ? existing : undefined;
    const command = normalizeCliValue(options.command) ?? previous?.command;
    if (!command) {
      throw new Error('A stdio MCP connection requires --command.');
    }
    const connection: McpStdioConnection = { transport: 'stdio', command };
    const args = options.arg ?? previous?.args;
    const env = options.env === undefined ? previous?.env : parseEnvAssignments(options.env);
    const envPassthrough = normalizePassthrough(options.envPassthrough) ?? previous?.envPassthrough;
    if (args !== undefined) connection.args = [...args];
    if (env !== undefined) connection.env = env;
    if (envPassthrough !== undefined) connection.envPassthrough = envPassthrough;
    return connection;
  }

  const previous = existing?.transport === 'http' ? existing : undefined;
  const url = normalizeCliValue(options.url) ?? previous?.url;
  if (!url) {
    throw new Error('An HTTP MCP connection requires --url.');
  }
  const connection: McpHttpConnection = { transport: 'http', url };
  const bearerToken = options.bearerToken ?? previous?.bearerToken;
  const headers = parseHeaders(options.header) ?? previous?.headers;
  if (bearerToken !== undefined) connection.bearerToken = bearerToken;
  if (headers !== undefined) connection.headers = headers;
  return connection;
}

function normalizeName(name: string): string {
  const normalized = normalizeCliValue(name);
  if (!normalized) throw new Error('MCP server name must not be empty.');
  return normalized;
}

function findByIdOrName(
  entries: readonly WorkspaceMcpServerMeta[],
  selector: string
): WorkspaceMcpServerMeta {
  const normalized = normalizeName(selector);
  const byId = entries.find(({ id }) => id === normalized);
  if (byId) return byId;
  const matches = entries.filter(
    ({ name }) => name.toLocaleLowerCase() === normalized.toLocaleLowerCase()
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`MCP server selector is ambiguous: ${normalized}. Use an id.`);
  }
  throw new Error(`MCP server not found: ${normalized}`);
}

function assertUniqueName(
  entries: readonly WorkspaceMcpServerMeta[],
  name: string,
  exceptId?: McpServerId
): void {
  const duplicate = entries.find(
    (entry) => entry.id !== exceptId && entry.name.toLocaleLowerCase() === name.toLocaleLowerCase()
  );
  if (duplicate) {
    throw new Error(`MCP server name already exists: ${name} (${duplicate.id})`);
  }
}

type McpCatalogContext = {
  repo: LoroDocumentManager['repo'];
  workspaceId: WorkspaceId;
  userId: string;
  /** The catalog as it stood after the pre-read sync. */
  servers: WorkspaceMcpServerMeta[];
  /** Writes inherit the command's `--offline` choice. */
  writeOptions: { sync: boolean };
};

/**
 * Every `lody mcp` subcommand resolves the same workspace, refreshes the
 * catalog unless `--offline`, and reads it once before acting.
 */
async function withMcpCatalog(
  options: McpCommandOptions,
  run: (context: McpCatalogContext) => Promise<void>
): Promise<void> {
  await runOneShotCommand('mcp', options, async () => {
    const auth = getAuthContextOrThrow('mcp');
    const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);
    await withWorkspaceManager(auth, workspace, 'mcp', async (manager) => {
      const workspaceId = workspace.id as WorkspaceId;
      if (!options.offline) {
        try {
          await syncMcpCatalog(manager, workspaceId);
        } catch (error) {
          throw new Error(
            `${formatErrorMessage(error)} Use --offline to read the local MCP catalog cache without syncing.`,
            { cause: error }
          );
        }
      }
      await run({
        repo: manager.repo,
        workspaceId,
        userId: auth.userId,
        servers: await listWorkspaceMcpCatalog(manager.repo, workspaceId),
        writeOptions: { sync: !options.offline },
      });
    });
  });
}

/** Shared write reporting: JSON envelope, or a human line plus the sync warning. */
function reportWrite(
  options: McpCommandOptions,
  payload: Record<string, unknown>,
  message: string,
  result: McpCatalogWriteResult
): void {
  if (options.json) {
    printJson({ ok: true, ...payload, ...result });
    return;
  }
  console.log(message);
  if (result.changed && !result.synced) {
    console.warn(
      `Warning: saved locally but NOT synced to the workspace yet (${result.syncError ?? 'unknown error'}).\nOther machines will not see it until this machine syncs.`
    );
  }
}

function addCommonOptions(command: Command): Command {
  return command
    .option('--workspace <selector>', 'Target workspace id, slug, or name')
    .option('--json', 'Print JSON output')
    .option('--debug', 'Enable debug output')
    .option('--offline', 'Use the local catalog cache without refreshing it first');
}

function addConnectionOptions(command: Command): Command {
  return command
    .option('--command <command>', 'stdio executable')
    .option('--arg <arg>', 'stdio argument (repeatable)', collect)
    .option('--env <NAME=value>', 'stdio environment value (repeatable)', collect)
    .option(
      '--env-passthrough <NAME>',
      'Pass a variable from the target daemon environment (repeatable)',
      collect
    )
    .option('--url <url>', 'Streamable HTTP endpoint')
    .option('--bearer-token <token>', 'HTTP bearer token; supports ${VAR}')
    .option('--header <Name:value>', 'HTTP request header (repeatable)', collect);
}

const listCommand = discoveryListCommand('mcp');

const addCommand = addConnectionOptions(
  addCommonOptions(new Command('add').description('Add a workspace MCP server'))
)
  .argument('<name>', 'Unique server name')
  .option('--description <description>', 'Server description')
  .option('--default', 'Select this server by default for new sessions')
  .option('--no-default', 'Do not select this server by default for new sessions')
  .action(async (name: string, options: McpAddOptions) => {
    await withMcpCatalog(options, async ({ repo, workspaceId, userId, servers, writeOptions }) => {
      const normalizedName = normalizeName(name);
      assertUniqueName(servers, normalizedName);
      const connection = buildMcpConnectionFromOptions(options);
      const now = getServerNow();
      const entry: WorkspaceMcpServerMeta = {
        id: uuidV4() as McpServerId,
        name: normalizedName,
        transport: connection?.transport ?? 'stdio',
        ...(normalizeCliValue(options.description)
          ? { description: normalizeCliValue(options.description) }
          : {}),
        ...(connection ? { connection } : {}),
        ...(options.default ? { enabledByDefault: true } : {}),
        createdAt: now,
        updatedAt: now,
        createdBy: userId,
      };
      const result = await upsertWorkspaceMcpCatalogEntry(repo, workspaceId, entry, writeOptions);
      captureCli('workspace/mcp_created', {
        workspace_id: workspaceId,
        source: 'cli',
        transport: entry.transport,
        enabled_by_default: entry.enabledByDefault === true,
        has_description: Boolean(entry.description),
      });
      reportWrite(
        options,
        { workspaceId, server: entry },
        `Added MCP server ${entry.name} (${entry.id}).`,
        result
      );
    });
  });

const setCommand = addConnectionOptions(
  addCommonOptions(new Command('set').description('Update a workspace MCP server'))
)
  .argument('<server>', 'Server id or name')
  .option('--name <name>', 'New unique server name')
  .option('--description <description>', 'Server description')
  .option('--default', 'Select this server by default for new sessions')
  .option('--no-default', 'Do not select this server by default for new sessions')
  .action(async (selector: string, options: McpSetOptions) => {
    await withMcpCatalog(options, async ({ repo, workspaceId, servers, writeOptions }) => {
      const current = findByIdOrName(servers, selector);
      const name = options.name === undefined ? current.name : normalizeName(options.name);
      assertUniqueName(servers, name, current.id);
      const connection = buildMcpConnectionFromOptions(options, current.connection);
      const next: WorkspaceMcpServerMeta = {
        ...current,
        name,
        transport: connection?.transport ?? current.transport,
        ...(connection ? { connection } : {}),
      };
      if (options.description !== undefined) {
        const description = normalizeCliValue(options.description);
        if (description) next.description = description;
        else delete next.description;
      }
      if (options.default !== undefined) {
        next.enabledByDefault = options.default;
      }
      if (!isDeepStrictEqual(next, current)) {
        next.updatedAt = getServerNow();
      }
      const result = await upsertWorkspaceMcpCatalogEntry(repo, workspaceId, next, writeOptions);
      reportWrite(
        options,
        { workspaceId, server: next },
        result.changed ? `Updated MCP server ${next.name}.` : 'No changes.',
        result
      );
    });
  });

const removeCommand = addCommonOptions(
  new Command('remove').description('Remove a workspace MCP server')
)
  .argument('<server>', 'Server id or name')
  .action(async (selector: string, options: McpCommandOptions) => {
    await withMcpCatalog(options, async ({ repo, workspaceId, servers, writeOptions }) => {
      const current = findByIdOrName(servers, selector);
      const result = await deleteWorkspaceMcpCatalogEntry(
        repo,
        workspaceId,
        current.id,
        writeOptions
      );
      reportWrite(
        options,
        { workspaceId, mcpServerId: current.id },
        `Removed MCP server ${current.name} (${current.id}).`,
        result
      );
    });
  });

export const mcpCommand = new Command('mcp')
  .description('Manage workspace MCP servers')
  .addCommand(listCommand)
  .addCommand(addCommand)
  .addCommand(setCommand)
  .addCommand(removeCommand);
