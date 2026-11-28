import type { z } from 'zod';

declare const refBrand: unique symbol;

/**
 * All logical scopes understood by the plugin SDK.
 * - `workspace`: Cross-machine workspace scope backed by synced host state (no single `machineId`).
 * - `machine` | `project` | `session`: Concrete execution scopes bound to an owning `machineId`.
 */
export type PluginScope = 'workspace' | 'machine' | 'project' | 'session';

/** Scopes valid for plugin-authored `machine` handlers (`PluginWorker` always runs on one machine). */
export type MachinePluginScope = 'machine' | 'project' | 'session';

export interface WorkspaceRef {
  readonly [refBrand]: 'workspace';
  readonly workspaceId: string;
}

export interface MachineRef {
  readonly [refBrand]: 'machine';
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

export type ScopeTarget<S extends PluginScope> = S extends 'workspace'
  ? WorkspaceRef
  : S extends 'machine'
    ? MachineRef
    : S extends 'project'
      ? ProjectRef
      : SessionRef;

/**
 * Maximum UTF-8 byte length of a validated `defineTool` output persisted inline
 * inside Loro Session history (`tool_call.pluginOutput`). Larger payloads must be
 * stored in `ctx.dataDir` and fetched on demand via `defineQuery`.
 */
export const MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES = 16_384;

export type PluginCallErrorCode =
  | 'revision_mismatch'
  | 'worker_restarted'
  | 'outcome_unknown'
  | 'plugin_faulted'
  | 'machine_offline'
  | 'timeout'
  | 'idempotency_conflict'
  | 'business_key_conflict'
  | 'forbidden'
  | 'unavailable'
  | 'validation_failed'
  | 'handler_error';

export interface PluginCallError extends Error {
  readonly code: PluginCallErrorCode;
}

export interface QueryDescriptor<
  S extends MachinePluginScope = MachinePluginScope,
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
  S extends MachinePluginScope = MachinePluginScope,
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
  S extends MachinePluginScope = MachinePluginScope,
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
   * Stable operation identity under `(workspace, user, project, pluginId, requestId)`.
   * Retrying the same normalized request returns the original SessionRef, including after
   * archive. A changed request rejects with `idempotency_conflict`. The caller retains
   * this ID and the complete request across uncertain outcomes; it never generates a new ID to retry.
   */
  readonly requestId: string;
  /**
   * Optional active-task identity in the same workspace/user/project/plugin namespace.
   * A different requestId with an already-active businessKey rejects with
   * `business_key_conflict`. Archive releases only this active-task reservation,
   * never the original request receipt. A new generation uses a new requestId.
   */
  readonly businessKey?: string;
  readonly roleId?: string;
  readonly prompt: string;
  readonly skillIds?: readonly string[];
  /** Optional initial PR link so plaintext `github.*` observations have a bound PR target before Turn 1. */
  readonly pullRequestUrl?: string;
  readonly waitCondition?: {
    readonly program: string;
    readonly reason?: string;
    readonly intervalMs?: number;
    readonly expiresAt?: number;
  };
}

export interface SendSessionMessageRequest {
  /** Deduplicated per `(session, pluginId, idempotencyKey)` across uncertain transport outcomes. */
  readonly idempotencyKey?: string;
  readonly prompt: string;
  readonly attachments?: readonly AttachmentSnapshot[];
  readonly delivery?: 'queue' | 'steer';
}

export interface SendSessionMessageReceipt {
  readonly turnId: string;
  readonly disposition: 'started' | 'queued' | 'steered';
}

export interface HostQueryDescriptor<S extends PluginScope, TInput, TOutput> {
  readonly kind: 'host-query';
  readonly scope: S;
  readonly id: string;
  readonly __types?: { readonly input: TInput; readonly output: TOutput };
}

export interface MachineSummary {
  readonly machine: MachineRef;
  readonly name: string;
  readonly presence: 'online' | 'offline' | 'unknown';
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
  readonly businessKey?: string;
  readonly pullRequests: readonly {
    readonly url: string;
    readonly state: 'open' | 'closed' | 'merged';
    readonly draft: boolean;
    readonly project?: ProjectRef;
  }[];
}

export interface SessionTurnSummary {
  readonly turnId: string;
  readonly role: 'user' | 'assistant';
  readonly previewText: string;
  readonly createdAt: number;
  readonly finished: boolean;
}

export interface SessionDetail extends SessionSummary {
  readonly activeWait?: {
    readonly reason?: string;
    readonly nextCheckAt?: number;
  };
  readonly recentTurns: readonly SessionTurnSummary[];
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
  readonly machines: HostQueryDescriptor<
    'workspace',
    { readonly limit?: number },
    { readonly items: readonly MachineSummary[] }
  >;
  readonly projects: HostQueryDescriptor<
    'workspace',
    { readonly limit?: number; readonly cursor?: string },
    { readonly items: readonly ProjectSummary[]; readonly nextCursor?: string }
  >;
  readonly sessions: HostQueryDescriptor<
    'workspace' | 'machine' | 'project',
    {
      readonly archived?: boolean;
      readonly status?: 'idle' | 'busy' | 'waiting' | 'stopped';
      readonly createdByMe?: boolean;
      /** Filter to Sessions created by the calling plugin (`pluginId`). */
      readonly createdByPlugin?: boolean;
      /** Business-task lookup within the calling plugin's namespace; archive filtering is independent. */
      readonly businessKey?: string;
      /** Optional execution-machine filter when querying at `workspace` scope. */
      readonly machineId?: string;
      readonly search?: string;
      readonly limit?: number;
      readonly cursor?: string;
    },
    { readonly items: readonly SessionSummary[]; readonly nextCursor?: string }
  >;
  readonly sessionDetail: HostQueryDescriptor<
    'session',
    { readonly recentTurnLimit?: number },
    SessionDetail
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
  S extends MachinePluginScope,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  scope: S,
  id: string,
  schemas: { readonly input: TInput; readonly output: TOutput }
): QueryDescriptor<S, TInput, TOutput>;

export declare function defineMutation<
  S extends MachinePluginScope,
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
  S extends MachinePluginScope,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  scope: S,
  id: string,
  schemas: { readonly input: TInput; readonly output: TOutput }
): ObservationDescriptor<S, TInput, TOutput>;
