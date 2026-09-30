import { ConvexHttpClient } from 'convex/browser';
import { z } from 'zod';
import { api } from '@lody/cloud-api';
import { BILLING_PLAN_TIERS } from '@lody/shared';
import { LODY_AUTH_URL } from '@/utils/const';

export const WorkspaceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullable(),
  role: z.string(),
});

export const WorkspaceGitHubRepositorySchema = z.object({
  id: z.number(),
  name: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  worktreeSetup: z
    .object({
      scripts: z.object({
        bash: z.string().optional(),
        powershell: z.string().optional(),
      }),
      timeoutMs: z.number().optional(),
    })
    .optional(),
  worktreeCleanup: z
    .object({
      scripts: z.object({
        bash: z.string().optional(),
        powershell: z.string().optional(),
      }),
      timeoutMs: z.number().optional(),
    })
    .optional(),
});

const WorkspaceListResultSchema = z.discriminatedUnion('valid', [
  z.object({
    valid: z.literal(false),
    userId: z.null(),
    workspaces: z.array(WorkspaceSummarySchema),
  }),
  z.object({
    valid: z.literal(true),
    userId: z.string(),
    workspaces: z.array(WorkspaceSummarySchema),
  }),
]);

const WorkspaceBillingEntitlementSchema = z.object({
  effectivePlanTier: z.enum(BILLING_PLAN_TIERS),
  checkoutPending: z.boolean(),
});

const WorkspaceBillingEntitlementResultSchema = z.discriminatedUnion('valid', [
  z.object({ valid: z.literal(false) }),
  WorkspaceBillingEntitlementSchema.extend({ valid: z.literal(true) }),
]);

const RegisterMachineAccessResultSchema = z.object({
  success: z.literal(true),
  existing: z.boolean(),
  sharedWithTeam: z.boolean(),
});

const MachineAccessCheckResultSchema = z.discriminatedUnion('allowed', [
  z.object({ allowed: z.literal(true) }),
  z.object({
    allowed: z.literal(false),
    reason: z.enum([
      'requester_not_member',
      'machine_not_registered',
      'not_visible',
      'project_not_shared',
    ]),
  }),
]);

const MachineRequestAccessResultSchema = z.discriminatedUnion('allowed', [
  z.object({ allowed: z.literal(true), requesterUserId: z.string().trim().min(1) }),
  MachineAccessCheckResultSchema.options[1],
]);

const WorkspaceGitHubRepositoryListResultSchema = z.discriminatedUnion('valid', [
  z.object({
    valid: z.literal(false),
    repositories: z.array(WorkspaceGitHubRepositorySchema),
  }),
  z.object({
    valid: z.literal(true),
    repositories: z.array(WorkspaceGitHubRepositorySchema),
  }),
]);

export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;
export type WorkspaceGitHubRepository = z.infer<typeof WorkspaceGitHubRepositorySchema>;
export type RegisterMachineAccessResult = z.infer<typeof RegisterMachineAccessResultSchema>;
export type MachineAccessCheckResult = z.infer<typeof MachineAccessCheckResultSchema>;
export type WorkspaceBillingEntitlement = z.infer<typeof WorkspaceBillingEntitlementSchema>;

// The client is stateless per query, so one instance serves every caller.
let authConvexClient: ConvexHttpClient | null = null;

function createAuthConvexClient(): ConvexHttpClient {
  if (!LODY_AUTH_URL) {
    throw new Error('LODY_AUTH_URL is not defined.');
  }

  authConvexClient ??= new ConvexHttpClient(LODY_AUTH_URL);
  return authConvexClient;
}

export async function listWorkspacesForToken(token: string): Promise<WorkspaceSummary[]> {
  const client = createAuthConvexClient();
  const raw = await client.query(api.deviceAuth.listMyWorkspacesForCliToken, { token });
  const parsed = WorkspaceListResultSchema.parse(raw);
  if (!parsed.valid) {
    throw new Error('CLI token is invalid or expired. Run `lody login` again.');
  }
  return parsed.workspaces;
}

export async function getWorkspaceBillingEntitlementForCliToken(input: {
  token: string;
  workspaceId: string;
}): Promise<WorkspaceBillingEntitlement> {
  const client = createAuthConvexClient();
  const raw = await client.query(api.deviceAuth.getWorkspaceBillingEntitlementForCliToken, input);
  const parsed = WorkspaceBillingEntitlementResultSchema.parse(raw);
  if (!parsed.valid) {
    throw new Error('CLI token cannot access this workspace. Run `lody login` again.');
  }
  return WorkspaceBillingEntitlementSchema.parse(parsed);
}

export async function listWorkspaceGitHubRepositoriesForCliToken(input: {
  token: string;
  workspaceId: string;
  requesterUserId?: string;
  enabledOnly?: boolean;
}): Promise<WorkspaceGitHubRepository[]> {
  const client = createAuthConvexClient();
  const baseArgs = {
    cliToken: input.token,
    workspaceId: input.workspaceId,
  };
  const parse = (raw: unknown): WorkspaceGitHubRepository[] => {
    const parsed = WorkspaceGitHubRepositoryListResultSchema.parse(raw);
    if (!parsed.valid) {
      throw new Error('CLI token is invalid or expired. Run `lody login` again.');
    }
    return parsed.repositories;
  };
  try {
    const raw = await client.query(api.github.listWorkspaceRepositoriesForCliToken, {
      ...baseArgs,
      ...(input.requesterUserId ? { requesterUserId: input.requesterUserId } : {}),
      ...(input.enabledOnly === true ? { enabledOnly: true } : {}),
    });
    return parse(raw);
  } catch (error) {
    if (
      input.requesterUserId !== undefined &&
      input.enabledOnly !== true &&
      error instanceof Error &&
      LEGACY_REQUESTER_USER_ID_VALIDATOR_ERROR.test(error.message)
    ) {
      const raw = await client.query(api.github.listWorkspaceRepositoriesForCliToken, baseArgs);
      return parse(raw);
    }
    throw error;
  }
}

// Convex `ArgumentValidationError` raised by an older deploy whose validator
// does not yet accept `requesterUserId`.
const LEGACY_REQUESTER_USER_ID_VALIDATOR_ERROR =
  /ArgumentValidationError[\s\S]*extra field `requesterUserId`/;

export async function registerMachineAccessForCliToken(input: {
  token: string;
  workspaceId: string;
  machineId: string;
}): Promise<RegisterMachineAccessResult> {
  const client = createAuthConvexClient();
  const raw = await client.mutation(api.machines.upsertMachineRegistrationFromCliToken, {
    cliToken: input.token,
    workspaceId: input.workspaceId,
    machineId: input.machineId,
  });
  return RegisterMachineAccessResultSchema.parse(raw);
}

// Convex `ArgumentValidationError` raised by an older deploy whose validator
// does not yet accept `localProjectId`. Anchored on the error class name to
// avoid matching arbitrary error messages that happen to quote the same field.
const LEGACY_LOCAL_PROJECT_ID_VALIDATOR_ERROR =
  /ArgumentValidationError[\s\S]*extra field `localProjectId`/;

export async function canUseMachineForCliToken(input: {
  token: string;
  workspaceId: string;
  machineId: string;
  requesterUserId: string;
  // Optional: when set, the backend additionally verifies that this local
  // project is shared with the team (only relevant for non-owner requesters
  // on shared machines). Older Convex deploys reject the field — we retry
  // without it so CLI and backend can roll out in either order.
  localProjectId?: string;
}): Promise<MachineAccessCheckResult> {
  const client = createAuthConvexClient();
  const baseArgs = {
    cliToken: input.token,
    workspaceId: input.workspaceId,
    machineId: input.machineId,
    requesterUserId: input.requesterUserId,
  };
  try {
    const raw = await client.query(api.machines.canUseMachineFromCliToken, {
      ...baseArgs,
      ...(input.localProjectId !== undefined ? { localProjectId: input.localProjectId } : {}),
    });
    return MachineAccessCheckResultSchema.parse(raw);
  } catch (error) {
    if (
      input.localProjectId !== undefined &&
      error instanceof Error &&
      LEGACY_LOCAL_PROJECT_ID_VALIDATOR_ERROR.test(error.message)
    ) {
      const raw = await client.query(api.machines.canUseMachineFromCliToken, baseArgs);
      return MachineAccessCheckResultSchema.parse(raw);
    }
    throw error;
  }
}

// Convex's reply when a deploy predates a public function, so a newer CLI can
// keep its older conservative check until the backend rolls out.
const MISSING_PUBLIC_FUNCTION_ERROR = /Could not find (public )?function/;

/**
 * Delegated access: the token user (the executing machine's owner) and the
 * requester must each be able to use the target. Returns `null` when the
 * backend does not provide the query yet.
 */
export async function canDelegateMachineUseForCliToken(input: {
  token: string;
  workspaceId: string;
  machineId: string;
  requesterUserId: string;
  localProjectId?: string;
}): Promise<MachineAccessCheckResult | null> {
  const client = createAuthConvexClient();
  try {
    const raw = await client.query(api.machines.canDelegateMachineUseFromCliToken, {
      cliToken: input.token,
      workspaceId: input.workspaceId,
      machineId: input.machineId,
      requesterUserId: input.requesterUserId,
      ...(input.localProjectId !== undefined ? { localProjectId: input.localProjectId } : {}),
    });
    return MachineAccessCheckResultSchema.parse(raw);
  } catch (error) {
    if (error instanceof Error && MISSING_PUBLIC_FUNCTION_ERROR.test(error.message)) {
      return null;
    }
    throw error;
  }
}

export async function canRequestMachineForCliToken(input: {
  token: string;
  workspaceId: string;
  machineId: string;
  requesterUserId: string;
  localProjectId?: string;
}): Promise<MachineAccessCheckResult> {
  const client = createAuthConvexClient();
  const raw = await client.query(api.machines.canRequestMachineFromCliToken, {
    cliToken: input.token,
    workspaceId: input.workspaceId,
    machineId: input.machineId,
    ...(input.localProjectId !== undefined ? { localProjectId: input.localProjectId } : {}),
  });
  const result = MachineRequestAccessResultSchema.parse(raw);
  if (result.allowed) {
    if (result.requesterUserId !== input.requesterUserId) {
      throw new Error('Authenticated CLI user does not match the session requester.');
    }
    return { allowed: true };
  }
  return result;
}
