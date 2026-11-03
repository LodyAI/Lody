import { z } from 'zod';
import type { McpConnectionSpec, WorkspaceMcpServerMeta } from './workspace-mcp';

const values = z
  .record(z.string().min(1).max(256), z.string().max(16_384))
  .refine((record) => Object.keys(record).length <= 64, 'Too many authentication fields.');
/** Local RPC input only. Never persist this object in a workspace document. */
export const McpLocalAuthenticationSchema = z
  .object({
    mode: z.enum(['oauth', 'manual']),
    bearerToken: z.string().max(16_384).optional(),
    headers: values.optional(),
    env: values.optional(),
    clientId: z.string().max(2048).optional(),
    clientSecret: z.string().max(16_384).optional(),
  })
  .strict()
  .refine(
    (value) => JSON.stringify(value).length <= 64 * 1024,
    'Authentication configuration is too large.'
  );
export type McpLocalAuthentication = z.infer<typeof McpLocalAuthenticationSchema>;

export const McpAuthenticationResultSchema = z
  .object({
    type: z.literal('mcp/authentication'),
    status: z.enum(['unknown', 'not_required', 'required', 'waiting', 'authorized', 'error']),
    hasCredentials: z.boolean(),
    mode: z.enum(['oauth', 'manual']).optional(),
    attemptId: z.string().optional(),
    authorizationUrl: z.string().url().max(16_384).optional(),
    reason: z
      .enum([
        'oauth_required',
        'client_required',
        'unsupported',
        'expired',
        'cancelled',
        'connection_failed',
        'storage_unavailable',
      ])
      .optional(),
  })
  .strict();
export type McpAuthenticationResult = z.infer<typeof McpAuthenticationResultSchema>;

const environmentReference = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const secretQueryKey =
  /^(?:(?:access|refresh|id)[_-]?token|api[_-]?(?:key|token)|auth(?:orization)?|bearer|token|secret|password|client[_-]?secret)$/i;
const parseUrl = (value: string) => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};
const publicUrl = (value: string) => {
  const url = parseUrl(value);
  if (!url) return value;
  const sensitive = Boolean(
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => secretQueryKey.test(key))
  );
  if (!sensitive) return value;
  url.username = '';
  url.password = '';
  url.hash = '';
  for (const key of [...url.searchParams.keys()])
    if (secretQueryKey.test(key)) url.searchParams.delete(key);
  return url.toString();
};
/** Separate credential values from the definition before it reaches a shared writer. */
export function splitMcpAuthentication(connection: McpConnectionSpec): {
  connection: McpConnectionSpec;
  authentication: Omit<McpLocalAuthentication, 'mode'>;
} {
  const separate = (input: Record<string, string> | undefined) => {
    const entries = Object.entries(input ?? {}).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    return {
      shared: Object.fromEntries(entries.filter(([, value]) => environmentReference.test(value))),
      local: Object.fromEntries(entries.filter(([, value]) => !environmentReference.test(value))),
    };
  };
  if (connection.transport === 'stdio') {
    const env = separate(connection.env);
    return {
      connection: {
        transport: 'stdio',
        command: connection.command,
        ...(connection.args ? { args: connection.args } : {}),
        ...(connection.envPassthrough ? { envPassthrough: connection.envPassthrough } : {}),
        ...(connection.authentication || Object.keys(env.local).length
          ? { authentication: 'local' as const }
          : {}),
        ...(Object.keys(env.shared).length ? { env: env.shared } : {}),
      },
      authentication: Object.keys(env.local).length ? { env: env.local } : {},
    };
  }
  const headers = separate(connection.headers);
  const { bearerToken } = connection;
  const sharedBearer = bearerToken !== undefined && environmentReference.test(bearerToken);
  return {
    connection: {
      transport: 'http',
      url: publicUrl(connection.url),
      ...(connection.authentication ||
      (!sharedBearer && bearerToken) ||
      Object.keys(headers.local).length ||
      publicUrl(connection.url) !== connection.url
        ? { authentication: 'local' as const }
        : {}),
      ...(sharedBearer ? { bearerToken } : {}),
      ...(Object.keys(headers.shared).length ? { headers: headers.shared } : {}),
    },
    authentication: {
      ...(!sharedBearer && bearerToken ? { bearerToken } : {}),
      ...(Object.keys(headers.local).length ? { headers: headers.local } : {}),
    },
  };
}

export function publicMcpServer(entry: WorkspaceMcpServerMeta): WorkspaceMcpServerMeta {
  return {
    id: entry.id,
    name: entry.name,
    transport: entry.transport,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.createdBy !== undefined ? { createdBy: entry.createdBy } : {}),
    ...(entry.enabledByDefault !== undefined ? { enabledByDefault: entry.enabledByDefault } : {}),
    ...(entry.connection
      ? { connection: splitMcpAuthentication(entry.connection).connection }
      : {}),
  };
}

export function assertPublicMcpServer(entry: WorkspaceMcpServerMeta): void {
  const fields = new Set([
    'id',
    'name',
    'transport',
    'createdAt',
    'updatedAt',
    'description',
    'createdBy',
    'enabledByDefault',
    'connection',
  ]);
  if (Object.keys(entry).some((key) => !fields.has(key)))
    throw new Error('Unsupported MCP configuration fields.');
  if (entry.connection) {
    const connectionFields = new Set(
      entry.connection.transport === 'http'
        ? ['transport', 'authentication', 'url', 'bearerToken', 'headers']
        : ['transport', 'authentication', 'command', 'args', 'env', 'envPassthrough']
    );
    if (Object.keys(entry.connection).some((key) => !connectionFields.has(key)))
      throw new Error('Unsupported MCP connection fields.');
  }
  if (
    entry.connection &&
    Object.keys(splitMcpAuthentication(entry.connection).authentication).length
  ) {
    throw new Error(
      'MCP credentials must be configured on the local machine, or referenced with ${VAR}.'
    );
  }
  if (entry.connection?.transport === 'http') {
    const url = parseUrl(entry.connection.url);
    if (
      url?.username ||
      url?.password ||
      url?.hash ||
      (url && [...url.searchParams.keys()].some((key) => secretQueryKey.test(key)))
    ) {
      throw new Error(
        'MCP URLs must not contain credentials. Configure authentication on the local machine.'
      );
    }
  }
}
