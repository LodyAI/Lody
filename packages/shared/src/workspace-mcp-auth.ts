import { z } from 'zod';
import { BUILTIN_MCP_PROVIDER_IDS } from './builtin-mcp-providers';
import type { McpServerId } from './ids';

const McpServerIdSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value as McpServerId);

export const WorkspaceMcpAuthStateSchema = z.enum([
  'not_connected',
  'authorizing',
  'connected',
  'expired',
  'error',
]);
export type WorkspaceMcpAuthState = z.infer<typeof WorkspaceMcpAuthStateSchema>;

export const WorkspaceMcpConnectionActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('status'),
      mcpServerId: McpServerIdSchema,
      requestedByUserId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('start-oauth'),
      mcpServerId: McpServerIdSchema,
      requestedByUserId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('set-secret-url'),
      mcpServerId: McpServerIdSchema,
      requestedByUserId: z.string().trim().min(1),
      secretUrl: z.string().trim().url().max(8_192),
    })
    .strict(),
  z
    .object({
      action: z.literal('disconnect'),
      mcpServerId: McpServerIdSchema,
      requestedByUserId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('test'),
      mcpServerId: McpServerIdSchema,
      requestedByUserId: z.string().trim().min(1),
    })
    .strict(),
]);
export type WorkspaceMcpConnectionAction = z.infer<typeof WorkspaceMcpConnectionActionSchema>;

const WorkspaceMcpConnectionStatusSchema = z
  .object({
    type: z.literal('workspace-mcp/connection-status'),
    mcpServerId: McpServerIdSchema,
    providerId: z.enum(BUILTIN_MCP_PROVIDER_IDS),
    state: WorkspaceMcpAuthStateSchema,
    connectedAt: z.number().finite().nonnegative().optional(),
    expiresAt: z.number().finite().nonnegative().optional(),
    error: z.string().optional(),
  })
  .strict();

const WorkspaceMcpOAuthStartedSchema = z
  .object({
    type: z.literal('workspace-mcp/oauth-started'),
    mcpServerId: McpServerIdSchema,
    providerId: z.enum(BUILTIN_MCP_PROVIDER_IDS),
    authorizationUrl: z.string().url(),
    expiresAt: z.number().finite().positive(),
  })
  .strict();

const WorkspaceMcpConnectionErrorSchema = z
  .object({
    type: z.literal('workspace-mcp/connection-error'),
    mcpServerId: McpServerIdSchema,
    code: z.enum([
      'permission_denied',
      'entry_not_found',
      'not_builtin',
      'wrong_auth_kind',
      'invalid_secret_url',
      'remote_authorization_unsupported',
      'provider_error',
      'internal_error',
    ]),
    message: z.string().trim().min(1),
    retryable: z.boolean(),
  })
  .strict();

export const WorkspaceMcpConnectionResultSchema = z.union([
  WorkspaceMcpConnectionStatusSchema,
  WorkspaceMcpOAuthStartedSchema,
  WorkspaceMcpConnectionErrorSchema,
]);
export type WorkspaceMcpConnectionResult = z.infer<
  typeof WorkspaceMcpConnectionResultSchema
>;
