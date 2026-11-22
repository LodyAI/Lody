import type { z } from "zod";

/**
 * Maximum UTF-8 byte length of a schema-validated plugin tool output stored inline
 * inside Loro Session History (`tool_call` plugin payload). Larger payloads write
 * full details to `ctx.dataDir` keyed by immutable `toolCallId` and return a summary + lookup key.
 */
export const MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES = 16_384;

/**
 * Maximum UTF-8 byte length of a single `plugin/query` or `plugin/mutate` request payload.
 * Sized so encrypted E2EE RPC envelopes fit within a single 1 MiB `purpose 8` frame on the
 * direct Desktop-to-Machine Iroh P2P fast path without spilling into multi-frame Streams fallback.
 */
export const MAX_PLUGIN_RPC_REQUEST_BYTES = 262_144;

/**
 * Maximum total byte size of a packed plugin's browser-pure `client.js` + `assets/` archive,
 * staying well within the 16 MiB E2EE paged read response ceiling (`purpose 9` 256 KiB chunks).
 */
export const MAX_PACKED_CLIENT_BUNDLE_BYTES = 4_194_304;

declare const workspaceRefBrand: unique symbol;
declare const machineRefBrand: unique symbol;
declare const projectRefBrand: unique symbol;
declare const sessionRefBrand: unique symbol;

/**
 * Logical workspace capability reference. Intentionally carries NO `machineId`:
 * workspace-level views read synced catalog projections directly without failing
 * when one machine is offline, and fan out per `MachineRef` when needed.
 */
export interface WorkspaceRef {
  readonly [workspaceRefBrand]: "WorkspaceRef";
  readonly workspaceId: string;
}

export interface MachineRef {
  readonly [machineRefBrand]: "MachineRef";
  readonly workspaceId: string;
  readonly machineId: string;
}

export interface ProjectRef {
  readonly [projectRefBrand]: "ProjectRef";
  readonly workspaceId: string;
  readonly machineId: string;
  readonly projectId: string;
}

export interface SessionRef {
  readonly [sessionRefBrand]: "SessionRef";
  readonly workspaceId: string;
  readonly machineId: string;
  readonly sessionId: string;
  readonly projectId?: string;
}

export type PluginScope = "workspace" | "machine" | "project" | "session";
export type MachinePluginScope = "machine" | "project" | "session";

export type ScopeTarget<S extends PluginScope> = S extends "workspace"
  ? WorkspaceRef
  : S extends "machine"
  ? MachineRef
  : S extends "project"
  ? ProjectRef
  : SessionRef;

export type PluginCallErrorCode =
  | "untrusted_plugin"
  | "plugin_disabled"
  | "plugin_faulted"
  | "machine_offline"
  | "forbidden"
  | "not_found"
  | "idempotency_conflict"
  | "business_key_conflict"
  | "outcome_unknown"
  | "validation_failed"
  | "handler_error";

export interface PluginCallError extends Error {
  readonly code: PluginCallErrorCode;
}

export interface QueryDescriptor<
  S extends MachinePluginScope = MachinePluginScope,
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  readonly kind: "query";
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
  readonly kind: "mutation";
  readonly scope: S;
  readonly id: string;
  readonly input: TInput;
  readonly output: TOutput;
}

export interface ToolDescriptor<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  readonly kind: "tool";
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

export interface AttachmentSourceDescriptor<
  TMeta extends z.ZodType = z.ZodType,
> {
  readonly kind: "attachment-source";
  readonly id: string;
  readonly title: string;
  readonly placeholder?: string;
  readonly metadataSchema?: TMeta;
}

export interface CreateSessionRequest {
  /**
   * Stable operation identity under `(workspace, user, target, pluginId, requestId)`.
   * Retrying the same normalized request returns the original SessionRef, including after
   * archive. A changed request rejects with `idempotency_conflict`. The caller retains
   * this ID and the complete request across uncertain outcomes; it never generates a new ID to retry.
   */
  readonly requestId: string;
  /**
   * Optional per-user active-task identity within `(workspace, user, target, pluginId, businessKey)`.
   * A different requestId with an already-active businessKey rejects with
   * `business_key_conflict`. Archive releases only this active-task reservation,
   * never the original request receipt. A new generation uses a new requestId.
   */
  readonly businessKey?: string;
  /** Workspace `AgentRole` ID to instantiate for this Session. */
  readonly roleId?: string;
  /** Optional parent Session pointer recorded in `SessionMeta.openedBySessionId` / `openedByRootSessionId`. */
  readonly parentSession?: SessionRef;
  readonly prompt: string;
  readonly skillIds?: readonly string[];
  /** Optional initial PR link recorded on Session creation. */
  readonly pullRequestUrl?: string;
}

export interface SendSessionMessageRequest {
  /** Deduplicated per `(session, pluginId, idempotencyKey)` across uncertain transport outcomes. */
  readonly idempotencyKey?: string;
  readonly prompt: string;
  readonly attachments?: readonly AttachmentSnapshot[];
  readonly delivery?: "queue" | "steer";
}

export interface SendSessionMessageReceipt {
  readonly turnId: string;
  readonly disposition: "started" | "queued" | "steered";
}

/**
 * Lightweight pending-interaction indicator on `SessionSummary` (mirrors `PermissionRequestKind`
 * in `packages/shared/src/schema.ts`) so sidebar rows and HUD badges can immediately display
 * `? Input` or `Approval needed` states without N+1 detail queries.
 */
export interface PendingInteractionSummary {
  readonly kind: "permission" | "ask_user_question";
  readonly requestId: string;
}

export interface ElicitationOption {
  readonly label: string;
  readonly description?: string;
  readonly preview?: string;
}

export interface ElicitationQuestion {
  /** Canonical answer key resolved via `getAskUserQuestionAnswerKey` (`packages/shared/src/acp/ask-user-question.ts`). */
  readonly answerKey: string;
  readonly id?: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly ElicitationOption[];
  readonly multiSelect: boolean;
  readonly allowCustomAnswer?: boolean;
  readonly isSecret?: boolean;
}

/**
 * Structured `ask_user_question` prompt parsed from Lody, Claude Code, or Codex ACP elicitation
 * (`packages/shared/src/acp/ask-user-question.ts`). Note: tool `permission` approvals remain
 * exclusively owned by Lody's trusted kernel UI so plugins can never spoof or auto-approve tools.
 */
export interface PendingQuestionPrompt {
  readonly requestId: string;
  readonly source: "lody" | "claude" | "codex";
  readonly allowCustomAnswer: boolean;
  readonly questions: readonly ElicitationQuestion[];
  readonly autoResolveAt?: number;
}

export interface AnswerQuestionRequest {
  readonly requestId: string;
  readonly answers: Readonly<Record<string, string | readonly string[]>>;
}

export interface LodyQueryDescriptor<S extends PluginScope, TInput, TOutput> {
  readonly kind: "lody-query";
  readonly scope: S;
  readonly id: string;
  readonly __types?: { readonly input: TInput; readonly output: TOutput };
}

export interface MachineSummary {
  readonly machine: MachineRef;
  readonly name: string;
  readonly presence: "online" | "offline" | "unknown";
  readonly agentConfigs: readonly {
    readonly agentConfigId: string;
    readonly cliType: string;
    readonly label: string;
  }[];
}

export interface ProjectSummary {
  readonly project: ProjectRef;
  readonly name: string;
  readonly repository?: string;
}

export interface AgentRoleSummary {
  readonly roleId: string;
  readonly name: string;
  readonly description?: string;
  readonly emoji?: string;
  readonly visibility: "private" | "workspace";
  readonly availability: "ready" | "unavailable" | "unknown";
}

export interface WorkspaceMemberSummary {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
}

export interface ScheduleSummary {
  readonly scheduleId: string;
  readonly title: string;
  readonly cronExpression?: string;
  readonly enabled: boolean;
  readonly machine?: MachineRef;
  readonly project?: ProjectRef;
  readonly nextRunAt?: number;
}

/**
 * Raw visible `SessionMeta` + ephemeral presence record exposed directly through `lodyQueries.sessions`
 * so custom sidebars, row hover popovers, and multi-Agent dashboards can reconstruct parent/child
 * lineages (`openedBySessionId` / `openedByRootSessionId`), Role lanes (`agentRoleId`), and
 * waiting-input indicators (`pendingInteraction`) without bespoke host groups.
 */
export interface SessionSummary {
  readonly session: SessionRef;
  readonly title: string;
  readonly status: "idle" | "busy" | "waiting" | "stopped";
  readonly machinePresence: "online" | "offline" | "unknown";
  readonly isMine: boolean;
  readonly userId: string;
  readonly archived: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly project?: ProjectRef;
  readonly openedBySessionId?: string;
  readonly openedByRootSessionId?: string;
  readonly agentRoleId?: string;
  readonly agentRoleRevision?: number;
  readonly cliType?: string;
  readonly lastModel?: {
    readonly modelId?: string;
    readonly name?: string;
  } | null;
  readonly branchName?: string;
  readonly baseBranch?: string;
  readonly isWorktree?: boolean;
  readonly isPinned?: boolean;
  readonly pinSectionId?: string;
  readonly orderKey?: string;
  readonly snoozedUntil?: number;
  readonly settledAt?: number;
  readonly scheduleId?: string;
  readonly contextWindowUsage?: {
    readonly usedTokens: number;
    readonly maxTokens?: number;
  };
  /** Present when the Session is currently awaiting an elicitation answer or tool permission. */
  readonly pendingInteraction?: PendingInteractionSummary;
  /** Present when the Session was created by a plugin (`pluginId`). */
  readonly createdByPluginId?: string;
  /** Present only when the Session was created by the calling plugin (`pluginId`). */
  readonly businessKey?: string;
  readonly pullRequests: readonly {
    readonly url: string;
    readonly state: "open" | "closed" | "merged";
    readonly draft: boolean;
    readonly project?: ProjectRef;
  }[];
}

export interface SessionTurnSummary {
  readonly turnId: string;
  readonly role: "user" | "assistant";
  readonly previewText: string;
  readonly createdAt: number;
  readonly finished: boolean;
}

export interface SessionDetail extends SessionSummary {
  readonly activeWait?: {
    readonly reason?: string;
    readonly nextCheckAt?: number;
  };
  readonly queuedCount: number;
  readonly pendingPermission: boolean;
  /** Present when `pendingInteraction?.kind === 'ask_user_question'`. */
  readonly pendingQuestion?: PendingQuestionPrompt;
  readonly recentTurns: readonly SessionTurnSummary[];
}

export interface RepositoryGitState {
  readonly hasRepository: boolean;
  readonly branch: string | null;
  readonly baseBranch: string | null;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
}

export interface SessionDiffSummary {
  readonly files: readonly {
    readonly path: string;
    readonly status: "added" | "modified" | "deleted" | "renamed";
    readonly additions: number;
    readonly deletions: number;
  }[];
}

export interface FilePreviewEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly content?: string;
  readonly truncated?: boolean;
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
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  readonly ciStatus: "success" | "failure" | "pending" | "unknown";
  readonly reviewDecision?:
    | "approved"
    | "changes_requested"
    | "review_required";
  readonly unresolvedCommentCount?: number;
  readonly observedAt: number;
}

export interface SkillSummary {
  readonly skillId: string;
  readonly name: string;
  readonly description?: string;
  readonly source: "repository" | "user" | "plugin" | "system";
}

/**
 * Lody's published client/host read & network SDK.
 * Workspace/session catalog descriptors subscribe directly to Lody's shared ref-counted Loro/Flock
 * rooms with zero extra RPC; machine/project/network descriptors reuse Lody's authenticated
 * `WorkspaceMachineRpcFacade` and platform cloud ports.
 */
export declare const lodyQueries: {
  readonly machines: LodyQueryDescriptor<
    "workspace",
    { readonly limit?: number } | void,
    { readonly items: readonly MachineSummary[] }
  >;
  readonly projects: LodyQueryDescriptor<
    "workspace",
    { readonly limit?: number; readonly cursor?: string } | void,
    { readonly items: readonly ProjectSummary[]; readonly nextCursor?: string }
  >;
  readonly agentRoles: LodyQueryDescriptor<
    "workspace",
    void,
    { readonly items: readonly AgentRoleSummary[]; readonly synced: boolean }
  >;
  readonly members: LodyQueryDescriptor<
    "workspace",
    void,
    { readonly items: readonly WorkspaceMemberSummary[] }
  >;
  readonly schedules: LodyQueryDescriptor<
    "workspace" | "machine" | "project",
    { readonly enabledOnly?: boolean } | void,
    { readonly items: readonly ScheduleSummary[] }
  >;
  readonly sessions: LodyQueryDescriptor<
    "workspace" | "machine" | "project",
    {
      readonly archived?: boolean;
      readonly status?: "idle" | "busy" | "waiting" | "stopped";
      readonly createdByMe?: boolean;
      /** Filter to Sessions created by the calling plugin (`pluginId`). */
      readonly createdByPlugin?: boolean;
      /** Business-task lookup within the calling plugin's namespace; archive filtering is independent. */
      readonly businessKey?: string;
      /** Filter to descendants opened by a root Session (`openedByRootSessionId`). */
      readonly rootSessionId?: string;
      /** Optional execution-machine filter when querying at `workspace` scope. */
      readonly machineId?: string;
      readonly search?: string;
      readonly limit?: number;
      readonly cursor?: string;
    } | void,
    { readonly items: readonly SessionSummary[]; readonly nextCursor?: string }
  >;
  readonly sessionDetail: LodyQueryDescriptor<
    "session",
    { readonly recentTurnLimit?: number } | void,
    SessionDetail
  >;
  readonly gitState: LodyQueryDescriptor<
    "project" | "session",
    void,
    RepositoryGitState
  >;
  readonly worktrees: LodyQueryDescriptor<
    "project",
    { readonly limit?: number; readonly cursor?: string } | void,
    { readonly items: readonly WorktreeEntry[]; readonly nextCursor?: string }
  >;
  readonly sessionDiff: LodyQueryDescriptor<
    "session",
    { readonly turnId?: string } | void,
    SessionDiffSummary
  >;
  readonly filePreview: LodyQueryDescriptor<
    "project" | "session",
    { readonly path: string; readonly maxBytes?: number },
    FilePreviewEntry
  >;
  readonly pullRequests: LodyQueryDescriptor<
    "project",
    { readonly number: number } | { readonly url: string },
    PullRequestSummary | null
  >;
  readonly skills: LodyQueryDescriptor<
    "machine" | "project",
    void,
    { readonly items: readonly SkillSummary[] }
  >;
};

export declare function defineQuery<
  S extends MachinePluginScope,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  scope: S,
  id: string,
  schemas: { readonly input: TInput; readonly output: TOutput },
): QueryDescriptor<S, TInput, TOutput>;

export declare function defineMutation<
  S extends MachinePluginScope,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  scope: S,
  id: string,
  schemas: { readonly input: TInput; readonly output: TOutput },
): MutationDescriptor<S, TInput, TOutput>;

export declare function defineTool<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  id: string,
  spec: {
    readonly title: string;
    readonly description: string;
    readonly input: TInput;
    readonly output: TOutput;
  },
): ToolDescriptor<TInput, TOutput>;

export declare function defineAttachmentSource<
  TMeta extends z.ZodType = z.ZodUnknown,
>(
  id: string,
  spec: {
    readonly title: string;
    readonly placeholder?: string;
    readonly metadataSchema?: TMeta;
  },
): AttachmentSourceDescriptor<TMeta>;
