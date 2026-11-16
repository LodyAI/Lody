import { z } from 'zod';
import {
  AGENT_ROLE_VERSION,
  canManageAgentRole,
  getAgentRoleMentionSlug,
  getAgentRoleTargets,
  isAgentRoleContentEqual,
  listAccessibleAgentRoles,
  normalizeAgentRoleMentionSlug,
  withAgentRoleTargets,
  type AgentRole,
} from './agent-role';
import type { AgentConfigId, AgentRoleId, MachineId } from './ids';
import { MemoryAssociationSchema, MemoryBindingSchema } from './memory-provider';

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
    /** An identity on `machineId`; one not yet imported into Lody is imported on Save. */
    memory: MemoryBindingSchema.optional(),
  })
  .strict();
/** One existing machine target of the Role; `memory: null` unlinks it. */
export const AgentRoleTargetPatchSchema = z
  .object({ machineId: id, memory: MemoryBindingSchema.nullable() })
  .strict();
export type AgentRoleTargetPatch = z.infer<typeof AgentRoleTargetPatchSchema>;
export const AGENT_ROLE_PROPOSAL_MAX_TARGETS = 16;
export const AgentRoleUpdateProposalSchema = z
  .object({
    requestId: id,
    roleId: id,
    patch: z
      .object({
        name: fields.name.optional(),
        description: fields.description.optional(),
        promptPrefix: fields.promptPrefix.optional(),
        targets: z
          .array(AgentRoleTargetPatchSchema)
          .min(1)
          .max(AGENT_ROLE_PROPOSAL_MAX_TARGETS)
          .refine(
            (targets) => new Set(targets.map((target) => target.machineId)).size === targets.length,
            'Each machine may appear once'
          )
          .optional(),
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
      /** Each patched target's memory before the proposal; absent memory means unlinked. */
      targets: z
        .array(z.object({ machineId: id, memory: MemoryBindingSchema.optional() }))
        .max(AGENT_ROLE_PROPOSAL_MAX_TARGETS)
        .optional(),
    })
    .optional(),
  /**
   * Provider identities the proposal binds that were not yet imported on their
   * machine. Save imports them before writing the Role; they never change the command.
   */
  memoryImports: z.array(MemoryAssociationSchema).max(AGENT_ROLE_PROPOSAL_MAX_TARGETS).optional(),
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
          runConfig: command.memory ? { memory: command.memory } : {},
          revision: 1,
          createdAt: now,
          updatedAt: now,
        }
      : patchAgentRole(existing!, command.patch);
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

function patchAgentRole(
  role: AgentRole,
  patch: z.infer<typeof AgentRoleUpdateProposalSchema>['patch']
): AgentRole {
  const { targets: changes, ...fields } = patch;
  const next = { ...role, ...fields };
  if (!changes) return next;
  const targets = getAgentRoleTargets(next);
  for (const change of changes)
    if (!targets.some((target) => target.machineId === change.machineId))
      throw new Error(`Agent Role does not run on machine ${change.machineId}`);
  const [first, ...rest] = targets.map((target) => {
    const change = changes.find((candidate) => candidate.machineId === target.machineId);
    if (!change) return target;
    const { memory: _memory, ...runConfig } = target.runConfig;
    return {
      ...target,
      runConfig: change.memory ? { ...runConfig, memory: change.memory } : runConfig,
    };
  });
  return withAgentRoleTargets(next, [first!, ...rest]);
}
