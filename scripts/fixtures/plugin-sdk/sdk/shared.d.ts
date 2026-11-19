import type { z } from 'zod';

declare const refBrand: unique symbol;

export type PluginScope = 'workspace' | 'project';

export interface WorkspaceRef {
  readonly [refBrand]: 'workspace';
  readonly workspaceId: string;
  readonly machineId: string;
}

export interface ProjectRef {
  readonly [refBrand]: 'project';
  readonly workspaceId: string;
  readonly machineId: string;
  readonly projectId: string;
  readonly memberId?: string;
}

export interface SessionRef {
  readonly [refBrand]: 'session';
  readonly workspaceId: string;
  readonly machineId: string;
  readonly sessionId: string;
  readonly project?: ProjectRef;
}

export type ScopeTarget<S extends PluginScope> = S extends 'workspace' ? WorkspaceRef : ProjectRef;

export type PluginCallErrorCode =
  | 'revision_mismatch'
  | 'worker_restarted'
  | 'machine_offline'
  | 'timeout'
  | 'idempotency_conflict'
  | 'forbidden'
  | 'unavailable'
  | 'validation_failed'
  | 'handler_error';

export interface PluginCallError extends Error {
  readonly code: PluginCallErrorCode;
}

export interface QueryDescriptor<
  S extends PluginScope = PluginScope,
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  readonly kind: 'query';
  readonly scope: S;
  readonly id: string;
  readonly input: TInput;
  readonly output: TOutput;
}

export interface MutationDescriptor<
  S extends PluginScope = PluginScope,
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  readonly kind: 'mutation';
  readonly scope: S;
  readonly id: string;
  readonly input: TInput;
  readonly output: TOutput;
}

export interface ToolDescriptor<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  readonly kind: 'tool';
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly input: TInput;
  readonly output: TOutput;
}

export interface AttachmentItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly url?: string;
}

export interface AttachmentSnapshot<TMeta = unknown> {
  readonly title: string;
  readonly markdown: string;
  readonly url?: string;
  readonly metadata?: TMeta;
}

export interface AttachmentSourceDescriptor<TMeta extends z.ZodType = z.ZodType> {
  readonly kind: 'attachment-source';
  readonly id: string;
  readonly title: string;
  readonly placeholder?: string;
  readonly metadataSchema?: TMeta;
}

export interface ObservationDescriptor<
  S extends PluginScope = PluginScope,
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  readonly kind: 'observation';
  readonly scope: S;
  readonly id: string;
  readonly input: TInput;
  readonly output: TOutput;
}

export interface CreateSessionRequest {
  /**
   * Deduplicated by host under `(workspace, user, project, pluginId, idempotencyKey)`.
   * Reusing a key with a different normalized request rejects with `idempotency_conflict`.
   */
  readonly idempotencyKey?: string;
  readonly roleId?: string;
  readonly prompt: string;
  readonly skillIds?: readonly string[];
  readonly waitCondition?: {
    readonly program: string;
    readonly reason?: string;
  };
}

export interface HostQueryDescriptor<S extends PluginScope, TInput, TOutput> {
  readonly kind: 'host-query';
  readonly scope: S;
  readonly id: string;
  readonly __types?: { readonly input: TInput; readonly output: TOutput };
}

export interface ProjectSummary {
  readonly project: ProjectRef;
  readonly name: string;
  readonly repository?: string;
}

export interface SessionSummary {
  readonly session: SessionRef;
  readonly title: string;
  readonly status: 'idle' | 'busy' | 'waiting' | 'stopped';
  readonly machinePresence: 'online' | 'offline' | 'unknown';
  readonly isMine: boolean;
  readonly archived: boolean;
  readonly updatedAt: number;
  /** Present only when the Session was created by the calling plugin (`pluginId`). */
  readonly idempotencyKey?: string;
  readonly pullRequests: readonly {
    readonly url: string;
    readonly state: 'open' | 'closed' | 'merged';
    readonly draft: boolean;
    readonly project?: ProjectRef;
  }[];
}

export interface WorktreeEntry {
  readonly branch: string | null;
  readonly path: string;
  readonly locked: boolean | null;
  readonly rootSession: SessionRef;
}

export interface PullRequestSummary {
  readonly number: number;
  readonly url: string;
  readonly headSha: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly draft: boolean;
  readonly ciStatus: 'success' | 'failure' | 'pending' | 'unknown';
  readonly observedAt: number;
}

export declare const hostQueries: {
  readonly projects: HostQueryDescriptor<
    'workspace',
    { readonly limit?: number; readonly cursor?: string },
    { readonly items: readonly ProjectSummary[]; readonly nextCursor?: string }
  >;
  readonly sessions: HostQueryDescriptor<
    PluginScope,
    {
      readonly archived?: boolean;
      readonly status?: 'idle' | 'busy' | 'waiting' | 'stopped';
      readonly createdByMe?: boolean;
      /** Filter to Sessions created by the calling plugin (`pluginId`). */
      readonly createdByPlugin?: boolean;
      /** Exact lookup scoped to the calling plugin's `(pluginId, idempotencyKey)` namespace. */
      readonly idempotencyKey?: string;
      /** Optional execution-machine filter in multi-machine workspaces. */
      readonly machineId?: string;
      readonly search?: string;
      readonly limit?: number;
      readonly cursor?: string;
    },
    { readonly items: readonly SessionSummary[]; readonly nextCursor?: string }
  >;
  readonly worktrees: HostQueryDescriptor<
    'project',
    { readonly limit?: number; readonly cursor?: string },
    { readonly items: readonly WorktreeEntry[]; readonly nextCursor?: string }
  >;
  readonly pullRequests: HostQueryDescriptor<
    'project',
    { readonly number: number } | { readonly url: string },
    PullRequestSummary | null
  >;
};

export declare function defineQuery<
  S extends PluginScope,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  scope: S,
  id: string,
  schemas: { readonly input: TInput; readonly output: TOutput }
): QueryDescriptor<S, TInput, TOutput>;

export declare function defineMutation<
  S extends PluginScope,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  scope: S,
  id: string,
  schemas: { readonly input: TInput; readonly output: TOutput }
): MutationDescriptor<S, TInput, TOutput>;

export declare function defineTool<TInput extends z.ZodType, TOutput extends z.ZodType>(
  id: string,
  spec: {
    readonly title: string;
    readonly description: string;
    readonly input: TInput;
    readonly output: TOutput;
  }
): ToolDescriptor<TInput, TOutput>;

export declare function defineAttachmentSource<TMeta extends z.ZodType = z.ZodUnknown>(
  id: string,
  spec: {
    readonly title: string;
    readonly placeholder?: string;
    readonly metadataSchema?: TMeta;
  }
): AttachmentSourceDescriptor<TMeta>;

export declare function defineObservation<
  S extends PluginScope,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  scope: S,
  id: string,
  schemas: { readonly input: TInput; readonly output: TOutput }
): ObservationDescriptor<S, TInput, TOutput>;
