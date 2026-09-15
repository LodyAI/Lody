import { ConvexHttpClient } from 'convex/browser';
import { z } from 'zod';
import { Data, Effect, Schedule } from 'effect';
import { api } from '@lody/cloud-api';
import { BILLING_PLAN_TIERS } from '@lody/shared';
import { LODY_AUTH_URL } from '@/utils/const';
import { runCommandEffect } from '@/lib/command-effect';
import {
  ACCESS_QUERY_RETRY_DELAYS_MS,
  isTransientAccessQueryError,
  safeAccessQueryErrorDetails,
} from '@/utils/access-query-error';
import { getLogger } from '@/utils/logger';

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

export class WorkspaceAccessError extends Data.TaggedError('WorkspaceAccessError')<{
  kind: 'unavailable' | 'denied' | 'invalid_response' | 'not_configured';
  cause?: unknown;
}> {
  override get message() {
    return this.toLodyError().message;
  }
  toLodyError() {
    return {
      code:
        this.kind === 'unavailable'
          ? 'WORKSPACE_ACCESS_UNAVAILABLE'
          : this.kind === 'denied'
            ? 'WORKSPACE_ACCESS_DENIED'
            : 'WORKSPACE_RESOLUTION_FAILED',
      message:
        this.kind === 'unavailable'
          ? 'Workspace access verification is temporarily unavailable. Retry with the same operationId when present.'
          : this.kind === 'denied'
            ? 'CLI credentials cannot access workspaces. Run `lody login` again.'
            : 'Workspace access could not be resolved. Check the CLI configuration and server compatibility.',
      retryable: this.kind === 'unavailable',
    };
  }
}

/** Four read attempts, at most 5s each and 10s overall; cancellation reaches fetch/body reads. */
export const listWorkspacesForTokenEffect = (token: string) =>
  Effect.suspend(() => {
    const authUrl = LODY_AUTH_URL;
    if (!authUrl) return Effect.fail(new WorkspaceAccessError({ kind: 'not_configured' }));
    let attempt = 0;
    const query = Effect.tryPromise({
      try: async (signal) => {
        attempt += 1;
        // Per-attempt client: AbortSignal must never be shared across concurrent MCP calls.
        const client = new ConvexHttpClient(authUrl, {
          logger: false,
          fetch: async (url, init) => {
            try {
              const response = await fetch(url, { ...init, signal });
              if (!response.ok) {
                const status = response.status;
                void response.body?.cancel().catch(() => undefined);
                throw new WorkspaceAccessError({
                  kind:
                    status === 401 || status === 403
                      ? 'denied'
                      : isTransientAccessQueryError({ status })
                        ? 'unavailable'
                        : 'invalid_response',
                  cause: { status },
                });
              }
              // Capture body transport failures here, separately from Convex business/schema errors.
              const body = await response.text();
              return new Response(body, { status: response.status, headers: response.headers });
            } catch (cause) {
              if (cause instanceof WorkspaceAccessError) throw cause;
              throw new WorkspaceAccessError({
                kind: isTransientAccessQueryError(cause) ? 'unavailable' : 'invalid_response',
                cause,
              });
            }
          },
        });
        const raw = await client.query(api.deviceAuth.listMyWorkspacesForCliToken, { token });
        const parsed = WorkspaceListResultSchema.parse(raw);
        if (!parsed.valid) throw new WorkspaceAccessError({ kind: 'denied' });
        return parsed.workspaces;
      },
      catch: (cause) =>
        cause instanceof WorkspaceAccessError
          ? cause
          : new WorkspaceAccessError({ kind: 'invalid_response', cause }),
    }).pipe(
      Effect.timeoutFail({
        duration: 5_000,
        onTimeout: () =>
          new WorkspaceAccessError({ kind: 'unavailable', cause: { code: 'ETIMEDOUT' } }),
      }),
      Effect.tapError((error) =>
        Effect.sync(() =>
          getLogger('workspace').debug(
            JSON.stringify({
              stage: 'workspace.query',
              endpoint: 'auth.workspace-list',
              attempt,
              kind: error.kind,
              ...safeAccessQueryErrorDetails(error),
            })
          )
        )
      )
    );
    return query.pipe(
      Effect.retry({
        schedule: Schedule.fromDelays(...ACCESS_QUERY_RETRY_DELAYS_MS),
        while: (error) => error.kind === 'unavailable',
      }),
      Effect.timeoutFail({
        duration: 10_000,
        onTimeout: () =>
          new WorkspaceAccessError({ kind: 'unavailable', cause: { code: 'ETIMEDOUT' } }),
      })
    );
  });

export async function listWorkspacesForToken(token: string): Promise<WorkspaceSummary[]> {
  return runCommandEffect(listWorkspacesForTokenEffect(token));
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
