import { z } from 'zod';
import {
  AGENT_ROLE_VERSION,
  canManageAgentRole,
  getAgentRoleMentionSlug,
  isAgentRoleContentEqual,
  listAccessibleAgentRoles,
  normalizeAgentRoleMentionSlug,
  type AgentRole,
} from './agent-role';
import type { AgentConfigId, AgentRoleId, MachineId } from './ids';

const id = z.string().trim().min(1).max(128);
const fields = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .refine((value) => !!normalizeAgentRoleMentionSlug(value)),
  description: z.string().refine((value) => Array.from(value).length <= 140),
  promptPrefix: z.string().max(32768).trim(),
};
export const AgentRoleCreateProposalSchema = z
  .object({
    requestId: id,
    name: fields.name,
    description: fields.description.optional(),
    promptPrefix: fields.promptPrefix.optional(),
    machineId: id,
    agentConfigId: id,
  })
  .strict();
export const AgentRoleUpdateProposalSchema = z
  .object({
    requestId: id,
    roleId: id,
    patch: z
      .object({
        name: fields.name.optional(),
        description: fields.description.optional(),
        promptPrefix: fields.promptPrefix.optional(),
      })
      .strict()
      .refine((value) => Object.values(value).some((field) => field !== undefined), 'Empty patch'),
  })
  .strict();
export const AgentRoleProposalCommandSchema = z.discriminatedUnion('action', [
  AgentRoleCreateProposalSchema.extend({ action: z.literal('create') }),
  AgentRoleUpdateProposalSchema.extend({ action: z.literal('update') }),
]);
export type AgentRoleProposalCommand = z.infer<typeof AgentRoleProposalCommandSchema>;
export const AgentRoleProposalMetaSchema = z.object({
  command: AgentRoleProposalCommandSchema,
  roleId: id,
  requesterUserId: id,
  before: z
    .object({
      name: fields.name,
      description: fields.description.optional(),
      promptPrefix: fields.promptPrefix.optional(),
    })
    .optional(),
  outcome: z.enum(['saved', 'dismissed']).optional(),
});
export type AgentRoleProposalMeta = z.infer<typeof AgentRoleProposalMetaSchema>;

/** Apply only proposed fields to the latest row; concurrent replicas use ordinary Flock merging. */
export function applyAgentRoleProposal(
  proposal: AgentRoleProposalMeta,
  roles: readonly AgentRole[],
  userId: string,
  now: number
): AgentRole {
  if (proposal.requesterUserId !== userId)
    throw new Error('Only the requesting user can save this proposal');
  const command = AgentRoleProposalCommandSchema.parse(proposal.command);
  const existing = roles.find((role) => role.id === proposal.roleId);
  if (existing && !canManageAgentRole(existing, userId))
    throw new Error('Agent Role is not editable');
  if (command.action === 'update' && (!existing || command.roleId !== proposal.roleId))
    throw new Error('Agent Role no longer exists');
  // A create retry must not replace a Role that has since been edited.
  if (command.action === 'create' && existing) return existing;
  const next: AgentRole =
    command.action === 'create'
      ? {
          v: AGENT_ROLE_VERSION,
          id: proposal.roleId as AgentRoleId,
          ownerUserId: userId,
          visibility: 'private',
          name: command.name,
          description: command.description ?? '',
          promptPrefix: command.promptPrefix ?? '',
          machineId: command.machineId as MachineId,
          agentConfigId: command.agentConfigId as AgentConfigId,
          runConfig: {},
          revision: 1,
          createdAt: now,
          updatedAt: now,
        }
      : { ...existing!, ...command.patch };
  if (
    listAccessibleAgentRoles(roles, userId).some(
      (role) =>
        role.id !== next.id && getAgentRoleMentionSlug(role) === getAgentRoleMentionSlug(next)
    )
  )
    throw new Error('Agent Role name is already in use');
  if (!existing || isAgentRoleContentEqual(existing, next)) return existing ?? next;
  return { ...next, revision: existing.revision + 1, updatedAt: now };
}
