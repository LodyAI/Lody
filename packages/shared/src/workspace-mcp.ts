import type { McpServerId } from './ids';
import {
  getBuiltinMcpProvider,
  isBuiltinMcpAccessProfile,
  isBuiltinMcpProviderId,
  type BuiltinMcpAccessProfile,
  type BuiltinMcpProviderId,
} from './builtin-mcp-providers';

/**
 * Lody supports stdio and Streamable HTTP MCP servers. SSE is intentionally
 * excluded even when an agent advertises it.
 */
export type McpTransport = 'stdio' | 'http';

export const isMcpTransport = (value: unknown): value is McpTransport =>
  value === 'stdio' || value === 'http';

export type McpStdioConnection = {
  transport: 'stdio';
  command: string;
  args?: string[];
  /** Workspace-readable plaintext. Prefer ${VAR} or envPassthrough for secrets. */
  env?: Record<string, string>;
  /** Variable names whose values are read from the target daemon environment. */
  envPassthrough?: string[];
};

export type McpHttpConnection = {
  transport: 'http';
  url: string;
  bearerToken?: string;
  headers?: Record<string, string>;
};

export type McpConnectionSpec = McpStdioConnection | McpHttpConnection;

export type WorkspaceMcpBuiltinPresetSource = {
  kind: 'builtin';
  providerId: BuiltinMcpProviderId;
  presetVersion: number;
  accessProfile: BuiltinMcpAccessProfile;
  publicOptions?: Record<string, string | boolean>;
};

export type WorkspaceMcpServerSource = WorkspaceMcpBuiltinPresetSource;

export type WorkspaceMcpServerMeta = {
  id: McpServerId;
  /** Unique workspace display name and the name sent to the ACP agent. */
  name: string;
  transport: McpTransport;
  description?: string;
  connection?: McpConnectionSpec;
  /** Public preset identity only. Provider credentials remain machine-local. */
  source?: WorkspaceMcpServerSource;
  enabledByDefault?: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy?: string;
};

export const canonicalizeWorkspaceMcpName = (name: string): string =>
  name.normalize('NFKC').toLocaleLowerCase('en-US');

export const areWorkspaceMcpNamesEqual = (left: string, right: string): boolean =>
  canonicalizeWorkspaceMcpName(left) === canonicalizeWorkspaceMcpName(right);

export type ResolvedStdioMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
};

export type ResolvedHttpMcpServer = {
  type: 'http';
  name: string;
  url: string;
  headers: { name: string; value: string }[];
};

export type ResolvedMcpServer = ResolvedStdioMcpServer | ResolvedHttpMcpServer;

export type McpResolutionProblem =
  | { kind: 'catalog_unavailable'; reason: string }
  | { kind: 'unknown_server'; mcpServerId: McpServerId }
  | { kind: 'missing_connection'; mcpServerId: McpServerId; name: string }
  | {
      kind: 'auth_required';
      mcpServerId: McpServerId;
      name: string;
      providerId: BuiltinMcpProviderId;
    }
  | {
      kind: 'unsupported_transport';
      mcpServerId: McpServerId;
      name: string;
      transport: McpTransport;
    }
  | {
      kind: 'unresolved_env_var';
      mcpServerId: McpServerId;
      name: string;
      field: string;
      variable: string;
    }
  | {
      kind: 'invalid_connection';
      mcpServerId: McpServerId;
      name: string;
      reason: string;
    };

export type ResolveSessionMcpServersInput = {
  catalog: Readonly<Record<string, WorkspaceMcpServerMeta>>;
  selectedIds: readonly string[];
  agentCapabilities: { http?: boolean } | undefined;
  env: Readonly<Record<string, string | undefined>>;
};

export type ResolveSessionMcpServersResult = {
  servers: ResolvedMcpServer[];
  problems: McpResolutionProblem[];
};

/**
 * Shared so an authoring surface rejects exactly the passthrough names
 * `isMcpConnectionSpec` would later refuse to read back.
 */
export const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

const isBuiltinPublicOptions = (
  providerId: BuiltinMcpProviderId,
  value: unknown
): value is Record<string, string | boolean> | undefined => {
  if (value === undefined) return true;
  if (!isRecord(value) || providerId !== 'posthog') return false;
  const keys = Object.keys(value);
  return (
    keys.every((key) => key === 'mode') &&
    (value.mode === undefined || value.mode === 'cli' || value.mode === 'tools')
  );
};

export const isWorkspaceMcpServerSource = (value: unknown): value is WorkspaceMcpServerSource => {
  if (
    !isRecord(value) ||
    value.kind !== 'builtin' ||
    !isBuiltinMcpProviderId(value.providerId) ||
    !Number.isSafeInteger(value.presetVersion) ||
    (value.presetVersion as number) < 1 ||
    !isBuiltinMcpAccessProfile(value.accessProfile) ||
    !isBuiltinPublicOptions(value.providerId, value.publicOptions)
  ) {
    return false;
  }
  const provider = getBuiltinMcpProvider(value.providerId);
  const presetVersion = value.presetVersion as number;
  return (
    presetVersion <= provider.presetVersion && provider.accessProfiles.includes(value.accessProfile)
  );
};

export const isMcpConnectionSpec = (value: unknown): value is McpConnectionSpec => {
  if (!isRecord(value) || !isMcpTransport(value.transport)) {
    return false;
  }

  if (value.transport === 'stdio') {
    return (
      typeof value.command === 'string' &&
      (value.args === undefined || isStringArray(value.args)) &&
      (value.env === undefined || isStringRecord(value.env)) &&
      (value.envPassthrough === undefined ||
        (isStringArray(value.envPassthrough) &&
          value.envPassthrough.every((name) => ENV_VAR_NAME_PATTERN.test(name))))
    );
  }

  return (
    typeof value.url === 'string' &&
    isOptionalString(value.bearerToken) &&
    (value.headers === undefined || isStringRecord(value.headers))
  );
};

export const isWorkspaceMcpServerMeta = (value: unknown): value is WorkspaceMcpServerMeta => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.trim().length === 0 ||
    typeof value.name !== 'string' ||
    value.name.trim().length === 0 ||
    !isMcpTransport(value.transport) ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt) ||
    (value.description !== undefined && typeof value.description !== 'string') ||
    (value.enabledByDefault !== undefined && typeof value.enabledByDefault !== 'boolean') ||
    (value.createdBy !== undefined && typeof value.createdBy !== 'string') ||
    (value.source !== undefined && !isWorkspaceMcpServerSource(value.source))
  ) {
    return false;
  }

  if (value.source?.kind === 'builtin') {
    return value.transport === 'http' && value.connection === undefined;
  }

  return (
    value.connection === undefined ||
    (isMcpConnectionSpec(value.connection) && value.connection.transport === value.transport)
  );
};

/** Normalize a persisted selection while preserving the distinction between absent and empty. */
export const normalizeMcpServerIdSelection = (value: unknown): McpServerId[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const seen = new Set<string>();
  const ids: McpServerId[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const id = candidate.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id as McpServerId);
  }
  return ids;
};

export const normalizeMcpServerIdsForDedup = (ids: readonly string[] | undefined): string[] =>
  [...new Set(ids ?? [])].sort();

export const interpolateEnvVars = (
  value: string,
  env: Readonly<Record<string, string | undefined>>
): { value: string; missing: string[] } => {
  const missing = new Set<string>();
  const interpolated = value.replace(ENV_VAR_PATTERN, (placeholder, variable: string) => {
    const replacement = env[variable];
    if (replacement === undefined || replacement === '') {
      missing.add(variable);
      return placeholder;
    }
    return replacement;
  });
  return { value: interpolated, missing: [...missing] };
};

const interpolateField = (
  rawValue: string,
  field: string,
  entry: WorkspaceMcpServerMeta,
  env: Readonly<Record<string, string | undefined>>,
  problems: McpResolutionProblem[]
): string => {
  const result = interpolateEnvVars(rawValue, env);
  for (const variable of result.missing) {
    problems.push({
      kind: 'unresolved_env_var',
      mcpServerId: entry.id,
      name: entry.name,
      field,
      variable,
    });
  }
  return result.value;
};

export const resolveSessionMcpServers = (
  input: ResolveSessionMcpServersInput
): ResolveSessionMcpServersResult => {
  const servers: ResolvedMcpServer[] = [];
  const problems: McpResolutionProblem[] = [];
  const selectedIds = normalizeMcpServerIdSelection(input.selectedIds) ?? [];

  for (const mcpServerId of selectedIds) {
    const entry = input.catalog[mcpServerId];
    if (!entry) {
      problems.push({ kind: 'unknown_server', mcpServerId });
      continue;
    }

    if (entry.source?.kind === 'builtin') {
      problems.push({
        kind: 'auth_required',
        mcpServerId,
        name: entry.name,
        providerId: entry.source.providerId,
      });
      continue;
    }

    const connection = entry.connection;
    if (!connection) {
      problems.push({ kind: 'missing_connection', mcpServerId, name: entry.name });
      continue;
    }

    if (entry.transport === 'http' && input.agentCapabilities?.http !== true) {
      problems.push({
        kind: 'unsupported_transport',
        mcpServerId,
        name: entry.name,
        transport: entry.transport,
      });
      continue;
    }

    if (connection.transport !== entry.transport) {
      problems.push({
        kind: 'invalid_connection',
        mcpServerId,
        name: entry.name,
        reason: `catalog transport ${entry.transport} does not match connection transport ${connection.transport}`,
      });
      continue;
    }

    const problemStart = problems.length;
    if (connection.transport === 'stdio') {
      if (!connection.command.trim()) {
        problems.push({
          kind: 'invalid_connection',
          mcpServerId,
          name: entry.name,
          reason: 'stdio command is empty',
        });
        continue;
      }

      const command = interpolateField(connection.command, 'command', entry, input.env, problems);
      const args = (connection.args ?? []).map((arg, index) =>
        interpolateField(arg, `args[${index}]`, entry, input.env, problems)
      );
      const resolvedEnv: { name: string; value: string }[] = [];
      for (const [name, rawValue] of Object.entries(connection.env ?? {}).sort(([a], [b]) =>
        a.localeCompare(b)
      )) {
        resolvedEnv.push({
          name,
          value: interpolateField(rawValue, name, entry, input.env, problems),
        });
      }
      const existingEnvNames = new Set(resolvedEnv.map(({ name }) => name));
      for (const name of connection.envPassthrough ?? []) {
        const value = input.env[name];
        if (value === undefined || value === '') {
          problems.push({
            kind: 'unresolved_env_var',
            mcpServerId,
            name: entry.name,
            field: name,
            variable: name,
          });
          continue;
        }
        if (!existingEnvNames.has(name)) {
          existingEnvNames.add(name);
          resolvedEnv.push({ name, value });
        }
      }

      if (problems.length !== problemStart) {
        continue;
      }
      servers.push({ name: entry.name, command, args, env: resolvedEnv });
      continue;
    }

    if (!connection.url.trim()) {
      problems.push({
        kind: 'invalid_connection',
        mcpServerId,
        name: entry.name,
        reason: 'HTTP URL is empty',
      });
      continue;
    }

    const url = interpolateField(connection.url, 'url', entry, input.env, problems);
    const headers: { name: string; value: string }[] = [];
    if (connection.bearerToken !== undefined) {
      const token = interpolateField(
        connection.bearerToken,
        'bearerToken',
        entry,
        input.env,
        problems
      );
      headers.push({ name: 'Authorization', value: `Bearer ${token}` });
    }
    for (const [name, rawValue] of Object.entries(connection.headers ?? {}).sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      headers.push({
        name,
        value: interpolateField(rawValue, name, entry, input.env, problems),
      });
    }

    if (problems.length !== problemStart) {
      continue;
    }
    servers.push({ type: 'http', name: entry.name, url, headers });
  }

  return { servers, problems };
};

export const formatMcpResolutionProblem = (problem: McpResolutionProblem): string => {
  switch (problem.kind) {
    case 'catalog_unavailable':
      return `Workspace MCP catalog is unavailable (${problem.reason}). Check workspace connectivity, then retry.`;
    case 'unknown_server':
      return `MCP server ${problem.mcpServerId} is no longer in the workspace catalog. Update this session's MCP selection.`;
    case 'missing_connection':
      return `MCP server “${problem.name}” has no connection. Set its command or URL in Settings → MCP, or run \`lody mcp set ${problem.mcpServerId}\`.`;
    case 'auth_required':
      return `MCP connector “${problem.name}” needs authorization on this machine. Connect ${problem.providerId} in Settings → MCP, then retry.`;
    case 'unsupported_transport':
      return `MCP server “${problem.name}” uses ${problem.transport}, which this agent does not support. Choose an agent with Streamable HTTP MCP support or change the server in Settings → MCP.`;
    case 'unresolved_env_var':
      return `MCP server “${problem.name}” was not started because ${problem.field} needs \${${problem.variable}}. Set ${problem.variable} in the target machine daemon environment, or update the server in Settings → MCP.`;
    case 'invalid_connection':
      return `MCP server “${problem.name}” has an invalid connection (${problem.reason}). Fix it in Settings → MCP, or run \`lody mcp set ${problem.mcpServerId}\`.`;
  }
  const exhaustive: never = problem;
  return exhaustive;
};

export const getDefaultSelectedMcpServerIds = (
  servers: readonly WorkspaceMcpServerMeta[]
): McpServerId[] =>
  servers.filter((server) => server.enabledByDefault === true).map(({ id }) => id);

/**
 * A one-line summary of what a server connects to, or `undefined` when there is
 * nothing to say. Each surface picks its own placeholder — the CLI table and the
 * settings row show a dash, the composer menu falls back to the transport name.
 */
export const describeMcpConnection = (
  connection: McpConnectionSpec | undefined
): string | undefined => {
  if (!connection) {
    return undefined;
  }
  if (connection.transport === 'http') {
    return connection.url.trim() || undefined;
  }
  const parts = [connection.command, ...(connection.args ?? [])].filter((part) => part.length > 0);
  return parts.join(' ') || undefined;
};
