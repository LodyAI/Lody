import type { z } from 'zod';

/**
 * Maximum UTF-8 byte length of a schema-validated plugin tool output stored inline
 * inside Loro Session History (`tool_call` plugin payload). Larger payloads write
 * full details to `ctx.dataDir` keyed by immutable `toolCallId` and return a summary + lookup key.
 */
export const MAX_INLINE_PLUGIN_TOOL_OUTPUT_BYTES = 16_384;

/**
 * Maximum UTF-8 byte length of a single `plugin/query` or `plugin/mutate` request payload.
 * Sized so encrypted E2EE RPC envelopes fit within a single 1 MiB `purpose 8` frame on the
 * direct Client-to-Machine Iroh P2P fast path without spilling into multi-frame Streams fallback.
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
  readonly [workspaceRefBrand]: 'WorkspaceRef';
  readonly workspaceId: string;
}

export interface MachineRef {
  readonly [machineRefBrand]: 'MachineRef';
  readonly workspaceId: string;
  readonly machineId: string;
}

export interface ProjectRef {
  readonly [projectRefBrand]: 'ProjectRef';
  readonly workspaceId: string;
  readonly machineId: string;
  readonly projectId: string;
}

export interface SessionRef {
  readonly [sessionRefBrand]: 'SessionRef';
  readonly workspaceId: string;
  readonly machineId: string;
  readonly sessionId: string;
  readonly projectId?: string;
}

export type PluginScope = 'workspace' | 'machine' | 'project' | 'session';
export type MachinePluginScope = 'machine' | 'project' | 'session';

export type ScopeTarget<S extends PluginScope> = S extends 'workspace'
  ? WorkspaceRef
  : S extends 'machine'
    ? MachineRef
    : S extends 'project'
      ? ProjectRef
      : SessionRef;

export type PluginCallErrorCode =
  | 'untrusted_plugin'
  | 'plugin_disabled'
  | 'plugin_faulted'
  | 'machine_offline'
  | 'forbidden'
  | 'not_found'
  | 'idempotency_conflict'
  | 'business_key_conflict'
  | 'outcome_unknown'
  | 'validation_failed'
  | 'handler_error';

export interface PluginCallError extends Error {
  readonly code: PluginCallErrorCode;
}

export type ReadonlyJsonPrimitive = string | number | boolean | null;
export type ReadonlyJsonArray = readonly ReadonlyJsonValue[];
export type ReadonlyJsonObject = { readonly [key: string]: ReadonlyJsonValue };
export type ReadonlyJsonValue = ReadonlyJsonPrimitive | ReadonlyJsonArray | ReadonlyJsonObject;

/**
 * Detached, deeply frozen read-only snapshot of an authorized Lody workspace or session state tree.
 * Gives custom Workspace / multi-Agent panels unrestricted read freedom beyond fixed summary shapes,
 * while keeping `HistoryWriter` and Kernel commands as the sole mutation path.
 */
export interface UnstableDocumentSnapshot<TDoc extends ReadonlyJsonValue = ReadonlyJsonObject> {
  readonly schemaVersion: number;
  readonly revision: string;
  readonly doc: TDoc;
}

/**
 * Scoped target for lazy, on-demand snapshot materialization directly over Lody's existing
 * Loro/Flock and `sessionData`/Roost readers (zero parallel Domain Store, zero whole-tree rebuilds
 * on unrelated commits or streaming tokens).
 */
export type UnstableSnapshotTarget =
  | {
      readonly kind: 'workspace-state';
      readonly workspace: WorkspaceRef;
      readonly path: readonly [
        'sessions' | 'projects' | 'machines' | 'roles' | 'schedules' | 'rateLimits',
        string,
        ...string[],
      ];
    }
  | { readonly kind: 'session-meta'; readonly session: SessionRef }
  | ({ readonly kind: 'session-transcript'; readonly session: SessionRef } & (
      | { readonly turnIds: readonly string[]; readonly limit?: never }
      | { readonly limit: number; readonly turnIds?: never }
    ))
  | {
      readonly kind: 'project-state';
      readonly project: ProjectRef;
      readonly path: readonly [string, ...string[]];
    };

export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export interface ObservedToolLocation {
  readonly path: string;
  readonly line?: number;
}

/**
 * Normalized cross-provider tool call projection covering built-in, ACP (Claude, Codex, Antigravity,
 * custom ACP providers), and MCP tools, consumed by both `tools.matchRender` and `sessionTurns`.
 */
export interface ObservedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly mcpServer?: string;
  readonly acpKind: AcpToolKind;
  readonly title: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly command?: string;
  readonly outputText?: string;
  readonly locations: readonly ObservedToolLocation[];
  readonly rawInput?: ReadonlyJsonValue;
  readonly rawOutput?: ReadonlyJsonValue;
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

/**
 * Identifies a signed human root on this machine. This is provenance, not permission:
 * a plugin can write a new input on a shared member's behalf only while the driving
 * turn is active. A restart does not renew that authority.
 */
export interface SignedTurnOrigin {
  readonly session: SessionRef;
  readonly userTurnId: string;
}

export interface CreateSessionRequest {
  /**
   * Stable operation identity under `(workspace, user, target, pluginId, requestId)`.
   * Retrying the same normalized request returns the original SessionRef, including after
   * archive. A changed request rejects with `idempotency_conflict`.
   */
  readonly requestId: string;
  /**
   * Optional per-user active-task identity within `(workspace, user, target, pluginId, businessKey)`.
   * A different requestId with an already-active businessKey rejects with `business_key_conflict`.
   */
  readonly businessKey?: string;
  /** Workspace or plugin-contributed `AgentRole` ID (`plugin:<plugin_id>:<role_id>`). */
  readonly roleId?: string;
  /** Built-in Agent config ID or plugin ACP provider ID (`plugin:<plugin_id>:<provider_id>`). */
  readonly providerId?: string;
  /** Optional parent Session pointer recorded in `SessionMeta.openedBySessionId` / `openedByRootSessionId`. */
  readonly parentSession?: SessionRef;
  /**
   * Optional E2EE human-signed root Turn provenance on the same machine (`derivedFrom`).
   * Auto-populated in `ToolExecutionContext` and rooted `MachineEventContext`; explicitly
   * supplied during `machine.onStart` reconciliation from `SessionTurnSummary.userTurnId`.
   */
  readonly originTurn?: SignedTurnOrigin;
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
  readonly delivery?: 'queue' | 'steer';
  /** Optional E2EE human-signed root Turn provenance for daemon-side workflow/recovery calls. */
  readonly originTurn?: SignedTurnOrigin;
}

export interface SendSessionMessageReceipt {
  readonly turnId: string;
  readonly disposition: 'started' | 'queued' | 'steered';
}

export interface InteractionOption {
  readonly optionId: string;
  readonly name: string;
  readonly description?: string;
  readonly kind?: 'allow_once' | 'allow_always' | 'deny' | 'reject_once' | 'reject_always';
}

export interface PendingInteractionSummary {
  readonly requestId: string;
  readonly turnId?: string;
  readonly kind: 'permission' | 'elicitation';
  readonly title?: string;
  readonly options: readonly InteractionOption[];
}

export type InteractionOutcome =
  | {
      readonly outcome: 'cancelled';
      readonly _meta?: ReadonlyJsonObject | null;
    }
  | {
      readonly outcome: 'selected';
      readonly optionId: string;
      readonly _meta?: ReadonlyJsonObject | null;
    };

export interface RespondInteractionRequest {
  readonly requestId: string;
  readonly turnId?: string;
  readonly outcome: InteractionOutcome;
  /** Optional E2EE human-signed root Turn provenance for daemon-side workflow/recovery calls. */
  readonly originTurn?: SignedTurnOrigin;
}

export interface LodyQueryDescriptor<S extends PluginScope, TInput, TOutput> {
  readonly kind: 'lody-query';
  readonly scope: S;
  readonly id: string;
  readonly __types?: { readonly input: TInput; readonly output: TOutput };
}

/**
 * Typed descriptor for Lody's shared Host Command Registry (`lodyCommands`), executed identically by
 * first-party Lody UI (`use-session-actions.ts`, `planStatusViewCommand`, `workspace-catalog-write.ts`)
 * and plugins (`lody.execute` / `useLodyCommand` / `ctx.lody.execute`) with unified authorization gates.
 */
export interface LodyCommandDescriptor<S extends PluginScope, TInput, TOutput> {
  readonly kind: 'lody-command';
  readonly scope: S;
  readonly id: string;
  readonly __types?: { readonly input: TInput; readonly output: TOutput };
}

export interface MachineSummary {
  readonly machine: MachineRef;
  readonly name: string;
  readonly presence: 'online' | 'offline' | 'unknown';
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
  readonly sourcePluginId?: string;
  readonly visibility: 'private' | 'workspace';
  readonly availability: 'ready' | 'unavailable' | 'unknown';
}

export interface AgentProviderSummary {
  readonly providerId: string;
  readonly cliType: string;
  readonly label: string;
  readonly source: 'builtin' | 'plugin';
  readonly sourcePluginId?: string;
  readonly machine?: MachineRef;
  readonly availability: 'ready' | 'auth_required' | 'offline';
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

export interface SessionAutomationSummary {
  readonly automationId: string;
  readonly reason?: string;
  readonly intervalMs?: number;
  readonly expiresAt?: number;
  readonly status: 'active' | 'completed' | 'cancelled';
}

export interface InstalledPluginSummary {
  readonly pluginId: string;
  readonly title: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly state: 'disabled' | 'starting' | 'running' | 'stopping' | 'faulted';
  readonly clientDigest?: string;
  /** True when linked via `lody plugin link --dev`, eligible for scoped Trusted Dev Session HMR. */
  readonly devMode?: boolean;
  readonly machine?: MachineRef;
}

export interface SessionSummary {
  readonly session: SessionRef;
  readonly title: string;
  readonly status: 'idle' | 'busy' | 'waiting' | 'stopped';
  readonly machinePresence: 'online' | 'offline' | 'unknown';
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
  readonly pendingInteraction?: PendingInteractionSummary;
  readonly createdByPluginId?: string;
  readonly businessKey?: string;
  readonly pullRequests: readonly {
    readonly url: string;
    readonly state: 'open' | 'closed' | 'merged';
    readonly draft: boolean;
    readonly project?: ProjectRef;
  }[];
}

export type TurnStopReason = 'end_turn' | 'cancelled' | 'error' | 'max_tokens' | 'unknown';

export interface SessionTurnSummary {
  readonly turnId: string;
  readonly role: 'user' | 'assistant';
  /** Originating human-signed user Turn ID on this Session/derivation chain (when applicable). */
  readonly userTurnId?: string;
  readonly previewText: string;
  readonly createdAt: number;
  readonly finished: boolean;
  /** Populated on finished assistant turns so `machine.onStart` can reconcile missed `end_turn` completions. */
  readonly stopReason?: TurnStopReason;
}

export interface SubagentRunSummary {
  readonly runId: string;
  readonly title: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  readonly latestStepPreview?: string;
}

export interface SessionTurnRecord extends SessionTurnSummary {
  readonly proseMarkdown: string;
  readonly thoughtMarkdown?: string;
  readonly planMarkdown?: string;
  readonly toolCalls: readonly ObservedToolCall[];
  readonly subagentRuns: readonly SubagentRunSummary[];
  readonly endedAt?: number;
}

export interface SubagentRunDetail extends SubagentRunSummary {
  readonly turns: readonly SessionTurnRecord[];
}

export interface SessionDetail extends SessionSummary {
  readonly activeWait?: {
    readonly reason?: string;
    readonly nextCheckAt?: number;
  };
  readonly queuedCount: number;
  readonly recentTurns: readonly SessionTurnSummary[];
}

export interface RepositoryGitState {
  readonly hasRepository: boolean;
  readonly branch: string | null;
  readonly baseBranch: string | null;
  readonly dirty: boolean;
  /** Absent when no upstream is tracked or the machine cannot report divergence. */
  readonly ahead?: number;
  readonly behind?: number;
}

export interface SessionDiffSummary {
  readonly files: readonly {
    readonly path: string;
    readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
    readonly additions: number;
    readonly deletions: number;
  }[];
}

export interface FilePreviewEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory';
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
  readonly state: 'open' | 'closed' | 'merged';
  readonly draft: boolean;
  readonly ciStatus: 'success' | 'failure' | 'pending' | 'unknown';
  readonly reviewDecision?: 'approved' | 'changes_requested' | 'review_required';
  readonly unresolvedCommentCount?: number;
  readonly observedAt: number;
}

export interface SkillSummary {
  readonly skillId: string;
  readonly name: string;
  readonly description?: string;
  readonly source: 'repository' | 'user' | 'plugin' | 'system';
}

/**
 * Canonical host lifecycle events consumable on BOTH `machine.events.on` and `lody.events.on`.
 */
export interface MachineHostEventMap {
  readonly 'session.created': {
    readonly workspace: WorkspaceRef;
    readonly machine: MachineRef;
    readonly session: SessionRef;
    readonly project?: ProjectRef;
    readonly agentRoleId?: string;
    readonly createdByPluginId?: string;
  };
  readonly 'session.status.changed': {
    readonly workspace: WorkspaceRef;
    readonly machine: MachineRef;
    readonly session: SessionRef;
    readonly project?: ProjectRef;
    readonly previousStatus: SessionSummary['status'];
    readonly status: SessionSummary['status'];
  };
  readonly 'session.turn.started': {
    readonly workspace: WorkspaceRef;
    readonly machine: MachineRef;
    readonly session: SessionRef;
    readonly project?: ProjectRef;
    readonly turnId: string;
    readonly userTurnId?: string;
  };
  readonly 'session.turn.completed': {
    readonly agentRoleId?: string;
    readonly workspace: WorkspaceRef;
    readonly machine: MachineRef;
    readonly session: SessionRef;
    readonly project?: ProjectRef;
    readonly turnId: string;
    readonly userTurnId?: string;
    readonly stopReason: TurnStopReason;
    readonly durationMs?: number;
  };
  readonly 'session.tool.started': {
    readonly workspace: WorkspaceRef;
    readonly machine: MachineRef;
    readonly session: SessionRef;
    readonly project?: ProjectRef;
    readonly turnId: string;
    readonly toolCall: ObservedToolCall;
  };
  readonly 'session.tool.completed': {
    readonly workspace: WorkspaceRef;
    readonly machine: MachineRef;
    readonly session: SessionRef;
    readonly project?: ProjectRef;
    readonly turnId: string;
    readonly toolCall: ObservedToolCall;
  };
  readonly 'session.waiting_input': {
    readonly workspace: WorkspaceRef;
    readonly machine: MachineRef;
    readonly session: SessionRef;
    readonly project?: ProjectRef;
    readonly interaction: PendingInteractionSummary;
  };
}

export type MachineHostEventType = keyof MachineHostEventMap;

/**
 * Client-side host event map combining visible workspace/session lifecycle transitions with
 * local UI interaction events (enabling Sound Effect, HUD, and coach plugins with zero DOM scraping).
 */
export interface ClientHostEventMap extends MachineHostEventMap {
  readonly 'ui.message.submitted': {
    readonly workspace: WorkspaceRef;
    readonly session: SessionRef;
    readonly project?: ProjectRef;
  };
  readonly 'ui.session.switched': {
    readonly workspace: WorkspaceRef;
    readonly session?: SessionRef;
    readonly previousSession?: SessionRef;
  };
  readonly 'ui.interaction.resolved': {
    readonly workspace: WorkspaceRef;
    readonly session: SessionRef;
    readonly requestId: string;
    readonly kind: 'permission' | 'elicitation';
  };
  readonly 'ui.command.invoked': {
    readonly workspace: WorkspaceRef;
    readonly commandId: string;
    readonly session?: SessionRef;
  };
}

export type ClientHostEventType = keyof ClientHostEventMap;

export declare const lodyQueries: {
  readonly machines: LodyQueryDescriptor<
    'workspace',
    { readonly limit?: number } | void,
    { readonly items: readonly MachineSummary[] }
  >;
  readonly projects: LodyQueryDescriptor<
    'workspace',
    { readonly limit?: number; readonly cursor?: string } | void,
    { readonly items: readonly ProjectSummary[]; readonly nextCursor?: string }
  >;
  readonly agentRoles: LodyQueryDescriptor<
    'workspace',
    void,
    { readonly items: readonly AgentRoleSummary[]; readonly synced: boolean }
  >;
  readonly agentConfigs: LodyQueryDescriptor<
    'workspace',
    void,
    { readonly items: readonly AgentProviderSummary[] }
  >;
  readonly plugins: LodyQueryDescriptor<
    'workspace',
    void,
    { readonly items: readonly InstalledPluginSummary[] }
  >;
  readonly members: LodyQueryDescriptor<
    'workspace',
    void,
    { readonly items: readonly WorkspaceMemberSummary[] }
  >;
  readonly schedules: LodyQueryDescriptor<
    'workspace' | 'machine' | 'project',
    { readonly enabledOnly?: boolean } | void,
    { readonly items: readonly ScheduleSummary[] }
  >;
  readonly sessions: LodyQueryDescriptor<
    'workspace' | 'machine' | 'project',
    {
      readonly sessionIds?: readonly string[];
      readonly archived?: boolean;
      readonly status?: 'idle' | 'busy' | 'waiting' | 'stopped';
      readonly agentRoleId?: string;
      readonly createdByMe?: boolean;
      readonly createdByPlugin?: boolean;
      readonly businessKey?: string;
      readonly rootSessionId?: string;
      readonly machineId?: string;
      /** Inclusive `updatedAt >= updatedAfter` watermark filter for incremental workflow reconciliation. */
      readonly updatedAfter?: number;
      readonly search?: string;
      readonly limit?: number;
      readonly cursor?: string;
    } | void,
    { readonly items: readonly SessionSummary[]; readonly nextCursor?: string }
  >;
  readonly sessionDetail: LodyQueryDescriptor<
    'session',
    { readonly recentTurnLimit?: number } | void,
    SessionDetail
  >;
  readonly sessionTurns: LodyQueryDescriptor<
    'session',
    { readonly limit?: number; readonly cursor?: string } | void,
    {
      readonly items: readonly SessionTurnRecord[];
      readonly nextCursor?: string;
    }
  >;
  readonly subagentRun: LodyQueryDescriptor<
    'session',
    { readonly runId: string },
    SubagentRunDetail | null
  >;
  readonly automations: LodyQueryDescriptor<
    'session',
    void,
    { readonly items: readonly SessionAutomationSummary[] }
  >;
  readonly gitState: LodyQueryDescriptor<'project' | 'session', void, RepositoryGitState>;
  readonly worktrees: LodyQueryDescriptor<
    'project',
    { readonly limit?: number; readonly cursor?: string } | void,
    { readonly items: readonly WorktreeEntry[]; readonly nextCursor?: string }
  >;
  readonly sessionDiff: LodyQueryDescriptor<
    'session',
    { readonly turnId?: string } | void,
    SessionDiffSummary
  >;
  readonly filePreview: LodyQueryDescriptor<
    'project' | 'session',
    { readonly path: string; readonly maxBytes?: number },
    FilePreviewEntry
  >;
  readonly pullRequests: LodyQueryDescriptor<
    'project',
    { readonly number: number } | { readonly url: string },
    PullRequestSummary | null
  >;
  readonly skills: LodyQueryDescriptor<
    'machine' | 'project',
    void,
    { readonly items: readonly SkillSummary[] }
  >;
};

export declare const lodyCommands: {
  readonly sessionCreate: LodyCommandDescriptor<
    'machine' | 'project',
    CreateSessionRequest,
    SessionRef
  >;
  readonly sessionSend: LodyCommandDescriptor<
    'session',
    SendSessionMessageRequest,
    SendSessionMessageReceipt
  >;
  readonly sessionRespondInteraction: LodyCommandDescriptor<
    'session',
    RespondInteractionRequest,
    void
  >;
  readonly sessionStop: LodyCommandDescriptor<'session', void, void>;
  readonly sessionArchive: LodyCommandDescriptor<'session', void, void>;
  readonly sessionRestore: LodyCommandDescriptor<'session', void, void>;
  readonly sessionFork: LodyCommandDescriptor<
    'session',
    {
      readonly fromTurnId?: string;
      readonly title?: string;
      readonly originTurn?: SignedTurnOrigin;
    } | void,
    SessionRef
  >;
  readonly sessionUpdateTitle: LodyCommandDescriptor<'session', { readonly title: string }, void>;
  /** @experimental Coupled to the host sidebar. */
  readonly sessionMarkRead: LodyCommandDescriptor<'session', void, void>;
  /** @experimental Coupled to the host sidebar. */
  readonly sessionMarkUnread: LodyCommandDescriptor<'session', void, void>;
  /** @experimental Coupled to the host sidebar. */
  readonly sessionSetPinned: LodyCommandDescriptor<'session', { readonly pinned: boolean }, void>;
  /** @experimental Coupled to the host sidebar. */
  readonly sessionSnooze: LodyCommandDescriptor<
    'session',
    { readonly until: number; readonly includeOpenedSessions?: boolean },
    void
  >;
  /** @experimental Coupled to the host sidebar. */
  readonly sessionSettle: LodyCommandDescriptor<
    'session',
    { readonly includeOpenedSessions?: boolean } | void,
    void
  >;
  /** @experimental Coupled to the host sidebar. */
  readonly sessionMoveToFocus: LodyCommandDescriptor<
    'session',
    { readonly includeOpenedSessions?: boolean } | void,
    void
  >;
  /** @experimental Coupled to the host sidebar. */
  readonly sessionMoveOrder: LodyCommandDescriptor<
    'session',
    {
      readonly to:
        | { readonly area: 'focus' }
        | { readonly area: 'pinned'; readonly sectionId: string | null };
      readonly beforeSessionId: string | null;
    },
    void
  >;
  /** @experimental Reserved for hosts with workspace pin-section support; unavailable in the current host. */
  readonly pinSectionCreate: LodyCommandDescriptor<
    'workspace',
    { readonly sectionId?: string; readonly name: string },
    { readonly sectionId: string }
  >;
  /** @experimental Reserved for hosts with workspace pin-section support; unavailable in the current host. */
  readonly pinSectionRename: LodyCommandDescriptor<
    'workspace',
    { readonly sectionId: string; readonly name: string },
    void
  >;
  /** @experimental Reserved for hosts with workspace pin-section support; unavailable in the current host. */
  readonly pinSectionMove: LodyCommandDescriptor<
    'workspace',
    { readonly sectionId: string; readonly beforeSectionId: string | null },
    void
  >;
  /** @experimental Reserved for hosts with workspace pin-section support; unavailable in the current host. */
  readonly pinSectionDelete: LodyCommandDescriptor<
    'workspace',
    { readonly sectionId: string },
    void
  >;
  readonly scheduleSetEnabled: LodyCommandDescriptor<
    'workspace' | 'machine' | 'project',
    { readonly scheduleId: string; readonly enabled: boolean },
    void
  >;
  readonly scheduleRunNow: LodyCommandDescriptor<
    'workspace' | 'machine' | 'project',
    { readonly scheduleId: string; readonly originTurn?: SignedTurnOrigin },
    { readonly session?: SessionRef }
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
