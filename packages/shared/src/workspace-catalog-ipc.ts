import { z } from 'zod';
import { normalizeAgentRole, type AgentRole } from './agent-role';
import { WorkspaceProjectSchema } from './workspace-project';
import { isWorkspaceMcpServerMeta, type WorkspaceMcpServerMeta } from './workspace-mcp';
import type { WorkspaceCatalogCommand, WorkspaceCatalogUpdate } from './workspace-catalog';

export const CATALOG_COMMAND_MAX_BYTES = 64 * 1024;
const id = z.string().min(1).max(512);
const text = z.string().max(32 * 1024);
const record = z.record(z.string().max(512), text);
const connection = z.discriminatedUnion('transport', [
  z
    .object({
      transport: z.literal('stdio'),
      authentication: z.literal('local').optional(),
      command: text,
      args: z.array(text).max(256).optional(),
      env: record.optional(),
      envPassthrough: z.array(id).max(256).optional(),
    })
    .strict(),
  z
    .object({
      transport: z.literal('http'),
      authentication: z.literal('local').optional(),
      url: text,
      bearerToken: text.optional(),
      headers: record.optional(),
    })
    .strict(),
]);
const mcp = z
  .object({
    id,
    name: id,
    transport: z.enum(['stdio', 'http']),
    description: text.optional(),
    connection: connection.optional(),
    enabledByDefault: z.boolean().optional(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    createdBy: id.optional(),
  })
  .strict()
  .refine(isWorkspaceMcpServerMeta)
  .transform((value) => value as WorkspaceMcpServerMeta);
const roleFields = new Set([
  'v',
  'id',
  'ownerUserId',
  'visibility',
  'name',
  'description',
  'emoji',
  'machineId',
  'agentConfigId',
  'runConfig',
  'alias',
  'additionalTargets',
  'promptPrefix',
  'revision',
  'createdAt',
  'updatedAt',
]);
const role = z
  .custom<AgentRole>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      Object.keys(value).every((key) => roleFields.has(key)) &&
      normalizeAgentRole(value) !== undefined
  )
  .transform((value) => normalizeAgentRole(value)!);
const revision = z.number().int().positive().optional();
const evidence = z
  .object({
    target: z
      .object({
        machineId: id,
        agentConfigId: id,
        cliType: id,
        agentType: id,
        runtimeOverrides: z.record(z.string().max(128), text).optional(),
      })
      .strict(),
    schema: z
      .object({
        cliType: id,
        agentType: id,
        cacheVersion: z.number().finite().optional(),
        provenance: z.literal('runtime').optional(),
        sourceVersion: id.optional(),
        fetchedAt: z.number().finite(),
        configOptions: z
          .array(
            z
              .object({ id, type: id, category: id.optional(), currentValue: text.optional() })
              .strict()
          )
          .max(256)
          .optional(),
      })
      .strict(),
  })
  .strict();
const commandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('put-mcp'), entry: mcp }).strict(),
  z.object({ kind: z.literal('delete-mcp'), id }).strict(),
  z.object({ kind: z.literal('put-role'), role, expectedRevision: revision }).strict(),
  z.object({ kind: z.literal('delete-role'), id, expectedRevision: revision }).strict(),
  z
    .object({
      kind: z.literal('put-project'),
      project: WorkspaceProjectSchema,
      expectedRevision: revision,
    })
    .strict(),
  z.object({ kind: z.literal('delete-project'), id, expectedRevision: revision }).strict(),
  z
    .object({ kind: z.literal('set-project-defaults'), projectKey: id, ids: z.array(id).max(256) })
    .strict(),
  // Main never trusts this evidence for a mutation. Lack of a fresh trusted
  // runtime probe is an explicit no-op, matching the native owner contract.
  z
    .object({
      kind: z.literal('reconcile-role-schema'),
      expected: role,
      evidence,
      now: z.number().finite(),
    })
    .strict(),
]);
export function parseWorkspaceCatalogIpcCommand(value: unknown): WorkspaceCatalogCommand {
  const encoded = JSON.stringify(value);
  if (!encoded || new TextEncoder().encode(encoded).length > CATALOG_COMMAND_MAX_BYTES)
    throw new Error('Workspace catalog command exceeds its finite DTO budget');
  return commandSchema.parse(value) as WorkspaceCatalogCommand;
}
export const workspaceCatalogIpcRequestSchema = z
  .object({
    registrationId: z.string().uuid(),
    requestId: z.string().uuid(),
  })
  .strict();
export const workspaceCatalogIpcUnsubscribeSchema = workspaceCatalogIpcRequestSchema
  .extend({ leaseId: z.string().uuid() })
  .strict();
export type WorkspaceCatalogIpcEvent = {
  readonly registrationId: string;
  readonly requestId: string;
  readonly leaseId: string;
} & (
  | { readonly type: 'snapshot'; readonly update: WorkspaceCatalogUpdate }
  | { readonly type: 'error'; readonly code: 'restart_required' | 'cleanup_unconfirmed' }
);
