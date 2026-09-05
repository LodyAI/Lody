import { z } from 'zod';

export const PROMPT_SHORTCUT_LIMITS = {
  promptBytes: 256 * 1024,
  documentBytes: 512 * 1024,
  indexBytes: 8 * 1024,
  variableValueBytes: 8 * 1024,
  mentions: 50,
  variables: 20,
} as const;

const utf8 = new TextEncoder();
export const shortcutByteLength = (value: string): number => utf8.encode(value).byteLength;
const identifier = z.string().min(1).max(200);
const variableName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/);
const projectSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('github'), repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/) })
    .strict(),
  z.object({ kind: z.literal('local'), id: identifier, machineId: identifier }).strict(),
]);

export const PromptShortcutScopeSchema = z
  .object({
    project: projectSchema.optional(),
    machineId: identifier.optional(),
    providerKey: identifier.optional(),
  })
  .strict();

export const PromptShortcutTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('file'),
      project: projectSchema,
      path: z.string().min(1).max(4096),
      directory: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('skill'),
      source: z.enum(['project', 'global', 'system']),
      project: projectSchema.optional(),
      machineId: identifier.optional(),
      path: z.string().min(1).max(4096),
      compatibleProviders: z.array(identifier).min(1).max(32),
    })
    .strict(),
  z.object({ kind: z.literal('agent_role'), agentRoleId: identifier }).strict(),
  z
    .object({
      kind: z.literal('issue'),
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      number: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pull_request'),
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      number: z.number().int().positive(),
    })
    .strict(),
]);

export const PromptShortcutMentionSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    label: z.string().min(1).max(4096),
    target: PromptShortcutTargetSchema,
  })
  .strict();

export const PromptShortcutVariableSchema = z
  .object({
    name: variableName,
    defaultValue: z
      .string()
      .refine(
        (value) => shortcutByteLength(value) <= PROMPT_SHORTCUT_LIMITS.variableValueBytes,
        'Variable default exceeds the byte limit'
      )
      .optional(),
  })
  .strict();

export const PromptShortcutSchema = z
  .object({
    v: z.literal(1),
    id: identifier,
    workspaceId: identifier,
    ownerUserId: identifier,
    visibility: z.enum(['private', 'workspace']),
    name: z.string().trim().min(1).max(60),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
    description: z.string().max(240).optional(),
    prompt: z
      .string()
      .refine(
        (value) => shortcutByteLength(value) <= PROMPT_SHORTCUT_LIMITS.promptBytes,
        'Prompt exceeds the byte limit'
      ),
    mentions: z.array(PromptShortcutMentionSchema).max(PROMPT_SHORTCUT_LIMITS.mentions),
    variables: z.array(PromptShortcutVariableSchema).max(PROMPT_SHORTCUT_LIMITS.variables),
    scope: PromptShortcutScopeSchema,
    revision: identifier,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type PromptShortcut = z.infer<typeof PromptShortcutSchema>;
export type PromptShortcutScope = z.infer<typeof PromptShortcutScopeSchema>;
export type PromptShortcutProject = z.infer<typeof projectSchema>;
export type PromptShortcutTarget = z.infer<typeof PromptShortcutTargetSchema>;
export type PromptShortcutMention = z.infer<typeof PromptShortcutMentionSchema>;
export type PromptShortcutVariable = z.infer<typeof PromptShortcutVariableSchema>;

export class PromptShortcutError extends Error {
  constructor(
    readonly code:
      | 'invalid_template'
      | 'missing_scope'
      | 'scope_mismatch'
      | 'missing_variables'
      | 'invalid_ranges'
      | 'size_limit'
      | 'conflict'
      | 'not_found'
      | 'forbidden'
      | 'revision_pending'
      | 'index_pending',
    message: string,
    readonly details: readonly string[] = []
  ) {
    super(message);
    this.name = 'PromptShortcutError';
  }
}

export function sameShortcutProject(a: PromptShortcutProject, b: PromptShortcutProject): boolean {
  if (a.kind === 'github' && b.kind === 'github') {
    return a.repository.toLowerCase() === b.repository.toLowerCase();
  }
  return a.kind === 'local' && b.kind === 'local' && a.id === b.id && a.machineId === b.machineId;
}

export type ShortcutScopeIssue = {
  code: 'missing_scope' | 'scope_mismatch';
  axis: keyof PromptShortcutScope;
};

export function getShortcutMentionScopeIssues(
  scope: PromptShortcutScope,
  target: PromptShortcutTarget
): ShortcutScopeIssue[] {
  const issues: ShortcutScopeIssue[] = [];
  let project: PromptShortcutProject | undefined;
  let machineId: string | undefined;
  if (target.kind === 'file' || target.kind === 'skill') project = target.project;
  if (target.kind === 'issue' || target.kind === 'pull_request') {
    project = { kind: 'github', repository: target.repository };
  }
  if (project?.kind === 'local') machineId = project.machineId;
  if (target.kind === 'skill') machineId = target.machineId ?? machineId;
  if (project) {
    if (!scope.project) issues.push({ code: 'missing_scope', axis: 'project' });
    else if (!sameShortcutProject(scope.project, project))
      issues.push({ code: 'scope_mismatch', axis: 'project' });
  }
  if (machineId !== undefined) {
    if (scope.machineId === undefined) issues.push({ code: 'missing_scope', axis: 'machineId' });
    else if (scope.machineId !== machineId)
      issues.push({ code: 'scope_mismatch', axis: 'machineId' });
  }
  if (target.kind === 'skill') {
    if (scope.providerKey === undefined)
      issues.push({ code: 'missing_scope', axis: 'providerKey' });
    else if (!target.compatibleProviders.includes(scope.providerKey)) {
      issues.push({ code: 'scope_mismatch', axis: 'providerKey' });
    }
  }
  // A Role's provider describes its target session, not this composer.
  return issues;
}

/** Used before source activation: missing scope leaves a discoverable disabled category. */
export function getShortcutMentionGate(
  type:
    | 'file'
    | 'project_skill'
    | 'global_skill'
    | 'system_skill'
    | 'agent_role'
    | 'issue'
    | 'pull_request',
  scope: PromptShortcutScope
): { enabled: boolean; missing: (keyof PromptShortcutScope)[] } {
  const missing: (keyof PromptShortcutScope)[] = [];
  if (type === 'agent_role') return { enabled: true, missing };
  const homeSkill = type === 'global_skill' || type === 'system_skill';
  if (!homeSkill && !scope.project) missing.push('project');
  if ((homeSkill || scope.project?.kind === 'local') && scope.machineId === undefined)
    missing.push('machineId');
  if (type.endsWith('_skill') && scope.providerKey === undefined) missing.push('providerKey');
  const githubOnly = type === 'issue' || type === 'pull_request';
  const localMachineMatches =
    scope.project?.kind !== 'local' ||
    scope.machineId === undefined ||
    scope.project.machineId === scope.machineId;
  return {
    enabled:
      missing.length === 0 &&
      localMachineMatches &&
      (!githubOnly || scope.project?.kind === 'github'),
    missing,
  };
}

export type ShortcutAvailability =
  | { kind: 'available' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'unavailable'; reason: string };

export function resolveShortcutAvailability(input: {
  shortcut: Pick<PromptShortcut, 'workspaceId' | 'ownerUserId' | 'visibility' | 'scope'>;
  dependencies: readonly PromptShortcutTarget[];
  context: { workspaceId: string; userId: string; scope: PromptShortcutScope };
  canRead: boolean;
  resolveDependency: (target: PromptShortcutTarget) => ShortcutAvailability;
}): ShortcutAvailability {
  const { shortcut, context, dependencies } = input;
  if (
    !input.canRead ||
    shortcut.workspaceId !== context.workspaceId ||
    (shortcut.visibility === 'private' && shortcut.ownerUserId !== context.userId)
  ) {
    return { kind: 'unavailable', reason: 'permission_denied' };
  }
  for (const target of dependencies) {
    const issue = getShortcutMentionScopeIssues(shortcut.scope, target).at(0);
    if (issue) return { kind: 'unavailable', reason: issue.code };
  }
  const scope = shortcut.scope;
  if (
    scope.project &&
    (!context.scope.project || !sameShortcutProject(scope.project, context.scope.project))
  ) {
    return { kind: 'unavailable', reason: 'project_mismatch' };
  }
  if (scope.machineId !== undefined && scope.machineId !== context.scope.machineId)
    return { kind: 'unavailable', reason: 'machine_mismatch' };
  if (scope.providerKey !== undefined && scope.providerKey !== context.scope.providerKey)
    return { kind: 'unavailable', reason: 'provider_mismatch' };
  let pending: ShortcutAvailability | undefined;
  for (const target of dependencies) {
    const result = input.resolveDependency(target);
    if (result.kind === 'unavailable') return result;
    if (result.kind === 'unknown') pending = result;
  }
  return pending ?? { kind: 'available' };
}
