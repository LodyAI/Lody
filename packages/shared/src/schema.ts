import { InferInputType, InferType, schema } from 'loro-mirror';
// Type-only, so the cycle with `review.ts` (which needs
// `SessionPullRequestStateMeta` for the merge gate) is erased at compile time.
import type { SessionAutoReviewMeta } from './review';
import {
  ACPSessionId,
  AcpConfigOptionValue,
  AgentBrandId,
  AgentConfigId,
  AgentConfigCliType,
  AgentRoleId,
  AgentType,
  AcpCapabilityCacheEntry,
  BuiltinRuntimeOverrides,
  CliType,
  CustomAcpLaunchSpec,
  LocalProjectHistoryProvider,
  LocalProjectId,
  LocalProjectMeta,
  IssuePRMention,
  MachineId,
  MessageContent,
  ProjectRef,
  PreviewCandidate,
  PreviewConnection,
  Role,
  SessionTurnInputConfig,
  SessionId,
  TaskId,
  WorktreeCleanupScriptConfig,
  WorktreeSetupScriptConfig,
} from '.';
import type { PlanEntry } from '@agentclientprotocol/sdk';
import type { ModelInfo } from './ai';
import type { MachineProtocolCapabilities } from './machine-protocol-capabilities';
export * from 'loro-mirror';
import type { RateLimit } from 'acp-extension-core';

export const RATE_LIMIT_ENTRY_KEY_SEPARATOR = '::';

/**
 * Known limitId values used to distinguish rate limit tiers.
 * - `codex`: standard Codex limit
 * - `codex_bengalfox`: Codex Spark limit
 */
export const CODEX_SPARK_LIMIT_ID = 'codex_bengalfox';

export const getRateLimitEntryKey = (
  cliType: CliType,
  limitId: string | null | undefined
): string => {
  const id = limitId?.trim() || cliType;
  return `${cliType}${RATE_LIMIT_ENTRY_KEY_SEPARATOR}${id}`;
};

export const parseRateLimitEntryKey = (
  key: string
): {
  cliType: string;
  limitId: string | null;
} => {
  const separatorIndex = key.indexOf(RATE_LIMIT_ENTRY_KEY_SEPARATOR);
  if (separatorIndex === -1) {
    return {
      cliType: key,
      limitId: null,
    };
  }

  const cliType = key.slice(0, separatorIndex);
  const limitId = key.slice(separatorIndex + RATE_LIMIT_ENTRY_KEY_SEPARATOR.length);
  if (!limitId) {
    return {
      cliType,
      limitId: null,
    };
  }

  return {
    cliType,
    limitId,
  };
};

/**
 * Session Status - Simplified State Machine
 *
 * Core states:
 * - idle: waiting for user input
 * - running: agent processing turn (heartbeat-driven)
 * - requestPermission: waiting for user permission response
 * - initializing: session setup/resume
 *
 * See specs/session-status.md for full design.
 */
export type InitializingStage = 'git-clone' | 'managed-runtime' | 'acp' | 'resuming';
export type SessionRunningActivity = 'image_generation';
export type PermissionRequestKind = 'permission' | 'ask_user_question';

export type SessionStatus =
  | { type: 'idle' }
  | { type: 'running'; activity?: SessionRunningActivity }
  | { type: 'requestPermission' }
  | {
      type: 'initializing';
      stage?: InitializingStage;
      detail?: string;
    };

export type SessionStatusType = SessionStatus['type'];

/**
 * Configuration for automatic session title generation.
 */
export type TitleGenerationConfig = {
  /** Config option values to set on the title-generation ACP session (e.g. model, reasoning_effort). */
  configOptionValues?: Record<string, AcpConfigOptionValue>;
};

export type AgentConfigMeta = {
  id: AgentConfigId;
  /**
   * Parent machine this config belongs to. Configs are scoped per-machine because
   * each machine has its own binaries, auth state, env, and rate-limit context.
   *
   * Legacy configs written before this field existed are normalized by the one-time
   * migration tracked in docs/backward-compatibility.md (BC-AGENT-CONFIG-MACHINE-
   * ASSOCIATION); see also plans/20260420-machine-agent-settings.md. Consumers should filter
   * out configs without a resolved machineId while the migration is running.
   */
  machineId: MachineId;
  name: string;
  description: string | undefined;
  cliType: AgentConfigCliType;
  agentType: AgentType;
  /**
   * Launch spec for `cliType: 'custom'` configs: the exact command + args the
   * owning machine spawns. Absent for builtin/registry configs, whose launch is
   * resolved from static tables. `agentType` stays a per-config unique slug so
   * capability caches keyed by `cliType:agentType` never collide across configs.
   */
  customAcp?: CustomAcpLaunchSpec;
  /**
   * Optional user-specified runtime path for a builtin agent. This is an
   * advanced override; normal builtin agents use Lody-managed runtimes.
   */
  runtimeOverrides?: BuiltinRuntimeOverrides;
  env: Record<string, string>;
  prompt?: string;
  /** Title generation settings. When set, enables automatic title generation for this agent. */
  titleGeneration?: TitleGenerationConfig;
  /**
   * Provider brand this config was created for (e.g. a "DeepSeek over Claude Code"
   * preset). Optional and forward-compatible: the runtime stays `builtin`/`claude`,
   * but the UI renders the brand's icon instead of the Claude icon. Absent for
   * plain Kimi/Claude/Codex/registry agents; for configs created before this field
   * existed, the brand is inferred from `env.ANTHROPIC_BASE_URL` at render time
   * (see resolveAgentBrandId).
   */
  brandId?: AgentBrandId;
};

/**
 * Session history storage: `items` vs legacy `contents`
 *
 * The new storage is `items`, a CRDT-friendly structured representation of `MessageContent[]`.
 * However, we intentionally do NOT model the full `MessageContent` shape in the Loro schema.
 *
 * Tradeoff & decision:
 * - Loro schema: keep it flexible with `schema.Any()` (plus a minimal `validate` guard below).
 *   This makes the persisted schema forward-compatible with new `MessageContent` variants or
 *   extra fields emitted by agents/clients without requiring a schema migration.
 * - TypeScript API: still treat `items` as `MessageContent[]` at the application boundary.
 *   All producers/consumers in CLI/Web should use `MessageContent` as the canonical type.
 *
 * Why not `schema.Any({ defaultLoroText: true })`:
 * - It enables deep Text inference for schema-less nested objects (catchalls), which can
 *   cause Mirror to generate `insert-container` for string values inside maps without a
 *   registered schema. After a restart, the per-container infer options are not persisted,
 *   so applying those diffs can fail with `Unknown schema type: undefined`.
 *
 * Decision:
 * - Keep the schema forward-compatible via `.catchall(schema.Any())`.
 * - Model streaming fields explicitly as `schema.LoroText()` (e.g. `text`) to avoid relying
 *   on inference.
 */
export type SessionHistoryItem = MessageContent;
export type SessionHistoryItems = MessageContent[];

const historyItemAnySchema = schema.Any({ defaultLoroText: true });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isWorktreeScriptHistoryStep = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.command === 'string' &&
  (value.status === 'in_progress' || value.status === 'completed' || value.status === 'failed') &&
  typeof value.output === 'string';

const historyMessageItemSchema = schema
  .LoroMap(
    {
      type: schema.String<MessageContent['type']>(),
      text: schema.LoroText({ required: false }),
      // `file` item: the mutable lifecycle fields `transport`/`machineId` are
      // carried through the `.catchall(...)` below (like every other variant's
      // payload fields, e.g. image's `imageId`/`sizeBytes`). They are plain
      // scalar string keys, so the CLI backfill flips `transport` 'local' -> 'r2'
      // (and clears `machineId`) with a single `LoroMap.set` — see the
      // round-trip + field-overwrite coverage in tests/session-input.test.ts.
    },
    {
      required: true,
      validate(value: unknown) {
        if (typeof value !== 'object' || value === null) return 'Expected object';
        const v = value as Record<string, unknown>;
        const type = v.type;
        if (typeof type !== 'string') return 'Missing type';

        switch (type) {
          case 'text':
          case 'thought':
            return typeof v.text === 'string' ? true : 'Missing text';
          case 'image':
            return typeof v.imageId === 'string' &&
              typeof v.mimeType === 'string' &&
              typeof v.sizeBytes === 'number'
              ? true
              : 'Missing image metadata';
          case 'file':
            if (
              typeof v.fileId !== 'string' ||
              typeof v.fileName !== 'string' ||
              typeof v.mimeType !== 'string' ||
              typeof v.sizeBytes !== 'number' ||
              typeof v.sha256 !== 'string' ||
              typeof v.textPreview !== 'boolean' ||
              (v.transport !== 'r2' && v.transport !== 'local') ||
              typeof v.uploadedAt !== 'number'
            ) {
              return 'Missing file metadata';
            }
            // transport='local' means the bytes only live on one machine pending
            // relay backfill; machineId is required to render the pending state.
            if (
              v.transport === 'local' &&
              (typeof v.machineId !== 'string' || v.machineId === '')
            ) {
              return "machineId is required when transport is 'local'";
            }
            return true;
          case 'image_group':
            return Array.isArray(v.images) && v.images.length > 0 ? true : 'Missing images';
          case 'plan':
            return Array.isArray(v.entries) ? true : 'Missing entries';
          case 'proposed_plan':
            return typeof v.turnId === 'string' &&
              typeof v.markdown === 'string' &&
              typeof v.status === 'string' &&
              typeof v.isLatest === 'boolean'
              ? true
              : 'Missing proposed plan metadata';
          case 'goal':
            return typeof v.threadId === 'string' &&
              typeof v.objective === 'string' &&
              typeof v.status === 'string' &&
              (v.tokensUsed === undefined || typeof v.tokensUsed === 'number') &&
              (v.timeUsedSeconds === undefined || typeof v.timeUsedSeconds === 'number') &&
              (v.createdAt === undefined || typeof v.createdAt === 'number') &&
              (v.updatedAt === undefined || typeof v.updatedAt === 'number')
              ? true
              : 'Missing goal metadata';
          case 'tool_call':
            return typeof v.toolCallId === 'string' && typeof v.status === 'string'
              ? true
              : 'Missing toolCallId/status';
          case 'subagent_task':
            return typeof v.taskId === 'string' && typeof v.status === 'string'
              ? true
              : 'Missing taskId/status';
          case 'available_commands':
            return Array.isArray(v.commands) ? true : 'Missing commands';
          case 'system_notice':
            return typeof v.name === 'string' ? true : 'Missing name';
          case 'operation_completion':
            return typeof v.deliveryId === 'string' &&
              typeof v.operationId === 'string' &&
              typeof v.operationKind === 'string' &&
              typeof v.completion === 'object' &&
              v.completion !== null
              ? true
              : 'Missing operation completion metadata';
          case 'worktree_script':
            return typeof v.phase === 'string' &&
              typeof v.status === 'string' &&
              Array.isArray(v.steps) &&
              v.steps.every(isWorktreeScriptHistoryStep)
              ? true
              : 'Missing worktree script metadata';
          case 'comment_reference':
            return typeof v.source === 'string' &&
              typeof v.path === 'string' &&
              typeof v.lineNumber === 'number' &&
              typeof v.side === 'string' &&
              typeof v.commentBody === 'string' &&
              typeof v.authorName === 'string'
              ? true
              : 'Missing comment reference metadata';
          case 'visual_annotation_reference':
            return v.source === 'visual_annotation' &&
              typeof v.commentId === 'string' &&
              typeof v.body === 'string' &&
              typeof v.anchor === 'object' &&
              v.anchor !== null
              ? true
              : 'Missing visual annotation reference metadata';
          default:
            return `Unknown type: ${type}`;
        }
      },
    }
  )
  .catchall(historyItemAnySchema);

export type SerializedLoroOpId = `${string}:${number}`;

export type FileDiffCodeCollabCheckpoint = {
  v: 1;
  fileId: string;
  opId?: SerializedLoroOpId;
  baseOpId?: SerializedLoroOpId;
  base?: 'missing';
  deleted?: true;
};

export type FileDiff = {
  filePath: string;
  add: number;
  del: number;
  cc?: FileDiffCodeCollabCheckpoint;
};

export type ParsedSerializedLoroOpId = {
  readonly peer: string;
  readonly counter: number;
};

export function serializeLoroOpId(input: {
  readonly peer: string | number;
  readonly counter: number;
}): SerializedLoroOpId {
  const peer = String(input.peer);
  if (!/^\d+$/u.test(peer)) {
    throw new Error('Loro OpId peer must be a non-negative integer string');
  }
  if (!Number.isSafeInteger(input.counter) || input.counter < 0) {
    throw new Error('Loro OpId counter must be a non-negative safe integer');
  }
  return `${peer}:${input.counter}`;
}

export function parseSerializedLoroOpId(input: string): ParsedSerializedLoroOpId | undefined {
  const match = /^(\d+):(\d+)$/u.exec(input);
  if (!match) return undefined;
  const peer = match[1];
  const counter = Number(match[2]);
  if (peer === undefined || !Number.isSafeInteger(counter) || counter < 0) {
    return undefined;
  }
  return { peer, counter };
}

export function normalizeFileDiffCodeCollabCheckpoint(
  value: unknown
): FileDiffCodeCollabCheckpoint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || typeof record.fileId !== 'string' || record.fileId.length === 0) {
    return undefined;
  }
  const opId = typeof record.opId === 'string' ? parseSerializedLoroOpId(record.opId) : undefined;
  const baseOpId =
    typeof record.baseOpId === 'string' ? parseSerializedLoroOpId(record.baseOpId) : undefined;
  if (record.opId !== undefined && opId === undefined) return undefined;
  if (record.baseOpId !== undefined && baseOpId === undefined) return undefined;
  if (record.base !== undefined && record.base !== 'missing') return undefined;
  if (record.deleted !== undefined && record.deleted !== true) return undefined;
  return {
    v: 1,
    fileId: record.fileId,
    ...(typeof record.opId === 'string' ? { opId: record.opId as SerializedLoroOpId } : {}),
    ...(typeof record.baseOpId === 'string'
      ? { baseOpId: record.baseOpId as SerializedLoroOpId }
      : {}),
    ...(record.base === 'missing' ? { base: 'missing' as const } : {}),
    ...(record.deleted === true ? { deleted: true as const } : {}),
  };
}

export function normalizeFileDiff(value: unknown): FileDiff | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.filePath !== 'string' || record.filePath.length === 0) return undefined;
  const add = typeof record.add === 'number' && Number.isFinite(record.add) ? record.add : 0;
  const del = typeof record.del === 'number' && Number.isFinite(record.del) ? record.del : 0;
  const cc = normalizeFileDiffCodeCollabCheckpoint(record.cc);
  return {
    filePath: record.filePath,
    add,
    del,
    ...(cc === undefined ? {} : { cc }),
  };
}

export type SessionPlanEntry = Pick<PlanEntry, 'status' | 'content' | 'priority'>;

export const sessionPlanEntrySchema = schema.LoroMap({
  status: schema.String<SessionPlanEntry['status']>(),
  content: schema.String(),
  priority: schema.String<SessionPlanEntry['priority']>(),
});

export type SessionHistorySendStatus = 'timeout';
export type SessionHistoryStatus =
  | 'pending'
  | 'pending_apply'
  | 'seen'
  | 'processing'
  | 'handled'
  | 'failed'
  | 'canceled';
type SessionHistoryStatusReadable = {
  role: Role;
  read?: boolean;
  status?: SessionHistoryStatus;
};

const issuePrMentionSchema = schema.LoroMap({
  type: schema.String<IssuePRMention['type']>(),
  title: schema.String(),
  url: schema.String(),
  number: schema.Number(),
});

// Loro Mirror passes null through transforms without invoking encode/decode.
// The transform therefore gives this optional string its domain-level explicit
// None state while retaining a primitive string in the CRDT when an id exists.
const agentRoleIdSchema = schema
  .String<AgentRoleId>({ required: false })
  .transform<AgentRoleId | null>({
    decode: (value) => value,
    encode: (value) => value,
  });

const acpSessionConfigSchema = schema
  .LoroMap(
    {
      prompt: schema.String(),
      inputBlocks: schema.Any({ required: false }),
      cliType: schema.String<AgentConfigCliType>(),
      agentType: schema.String(),
      modeId: schema.String({ required: false }),
      modelId: schema.String({ required: false }),
      issuePRMentions: schema.LoroList(issuePrMentionSchema, undefined, { required: false }),
      resume: schema.String({ required: false }),
      /** Config option values (configId → value) for setSessionConfigOption */
      configOptionValues: schema.Any({ required: false }),
      /** Workspace MCP catalog ids selected for this session (string[]). */
      mcpServerIds: schema.Any({ required: false }),
      /** Whether the built-in Lody Task MCP tools are mounted for this Turn. */
      taskToolsEnabled: schema.Boolean({ required: false }),
      /** Agent Role selected for this Turn; null is explicit None. */
      agentRoleId: agentRoleIdSchema,
      agentRoleRevision: schema.Number({ required: false }),
      chainDepth: schema.Number({ required: false }),
    },
    { required: false }
  )
  .catchall(schema.Any());

export const sessionPreviewDocSchema = schema.LoroMap(
  {
    candidate: schema.Any({ required: false }),
    connection: schema.Any({ required: false }),
  },
  { required: false }
);

export const sessionExternalHistoryCursorDocSchema = schema.LoroMap(
  {
    importedTurnHashes: schema.LoroList(schema.String(), undefined, { required: false }),
  },
  { required: false }
);

export const resolveSessionHistoryStatus = (
  entry: SessionHistoryStatusReadable | null | undefined
): SessionHistoryStatus | undefined => {
  if (!entry || entry.role !== 'user') {
    return undefined;
  }
  if (typeof entry.status === 'string') {
    return entry.status as SessionHistoryStatus;
  }
  if (entry.read === true) {
    return 'seen';
  }
  if (entry.read === false) {
    return 'pending';
  }
  return undefined;
};

export const getLegacyReadForSessionHistoryStatus = (
  status: SessionHistoryStatus | undefined
): boolean | undefined => {
  if (!status) {
    return undefined;
  }
  return status !== 'pending' && status !== 'pending_apply';
};

export const isSessionHistoryDelivered = (
  entry: SessionHistoryStatusReadable | null | undefined
): boolean => {
  const status = resolveSessionHistoryStatus(entry);
  if (status) {
    return status !== 'pending' && status !== 'pending_apply';
  }
  return entry?.read === true;
};

export const isSessionHistoryPendingForDispatch = (
  entry: SessionHistoryStatusReadable | null | undefined
): boolean => {
  const status = resolveSessionHistoryStatus(entry);
  return status === 'pending' || status === 'seen' || status === 'processing';
};

export const sessionHistorySchema = schema.LoroMap({
  id: schema.String(),
  userTurnId: schema.String({ required: false }),
  // Provider-native assistant turn boundary emitted by the ACP adapter.
  // Lody stores and returns this opaque value without interpreting it.
  acpTurnId: schema.String({ required: false }),
  items: schema.LoroList(historyMessageItemSchema, undefined, { required: false }),
  // Plan attached to this turn, updated via notification updates during the agent's response
  plan: schema.LoroList(sessionPlanEntrySchema, undefined, { required: false }),
  timestamp: schema.String(),
  startedAt: schema.Number({ required: false }),
  endedAt: schema.Number({ required: false }),
  // Total time in milliseconds spent waiting for permission approvals during this turn.
  // Effective agent working time = (endedAt - Date.parse(timestamp)) - permissionWaitMs
  permissionWaitMs: schema.Number({ required: false }),
  role: schema.String<Role>(),
  status: schema.String<SessionHistoryStatus>({ required: false }),
  inputConfig: acpSessionConfigSchema,
  /**
   * @deprecated Use `status` instead.
   * Kept temporarily so existing persisted docs and older UI logic remain readable.
   */
  read: schema.Boolean({ required: false }),
  userId: schema.String({ required: false }),
  modelInfo: schema.Any({ required: false }),
  // FileDiff 此次对话有哪些文件变更，和具体变更行数
  fileDiff: schema.Any(),
  // Indicates whether the agent's response for this turn has finished
  // For assistant turns: set to true when agent completes response
  // For user turns: always true (user messages are complete when created)
  finished: schema.Boolean({ required: false }),
  // Send status for user messages - only set when message delivery failed (e.g., timeout)
  // Cleared when message is successfully retried
  sendStatus: schema.String<SessionHistorySendStatus>({ required: false }),
});

export type PrStatus = 'open' | 'closed' | 'merged' | 'draft';

export type SessionPullRequestMeta = {
  url: string;
  status: PrStatus;
};

export type SessionPullRequestLegacyMetaFields = {
  /** Deprecated legacy detail. New writes derive this from `url` when needed. */
  number?: number;
  /** Deprecated legacy detail. New writes derive this from `url` or session project when needed. */
  repository?: string;
  /** Deprecated legacy detail. Branch lives on `SessionMeta.branchName` / `ProjectRef`. */
  branch?: string;
  /** Deprecated legacy detail. PR details cache should provide the head SHA when needed. */
  headCommitSha?: string;
  /** Deprecated legacy ordering detail. New writes keep array order instead. */
  reportedAt?: string;
};

export type SessionPullRequestMetaWithLegacy = SessionPullRequestMeta &
  Partial<SessionPullRequestLegacyMetaFields>;

export function getSessionPullRequestLegacyFields(
  pr: SessionPullRequestMeta | null | undefined
): Partial<SessionPullRequestLegacyMetaFields> {
  return (pr ?? {}) as Partial<SessionPullRequestLegacyMetaFields>;
}

export function normalizeSessionPullRequestMeta(value: unknown): SessionPullRequestMeta | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const url = typeof record.url === 'string' ? record.url.trim() : '';
  const status = record.status;
  if (
    !url ||
    (status !== 'open' && status !== 'closed' && status !== 'merged' && status !== 'draft')
  ) {
    return null;
  }
  return { url, status };
}

/** Rollup CI state of a PR's head commit: success/failure/pending/error/expected. */
export type SessionPullRequestCiState = 's' | 'f' | 'p' | 'e' | 'x';

/**
 * Merge readiness reported by the provider (GitHub `mergeStateStatus`):
 * clean / blocked (protection rules) / dirty (conflicts) / behind (needs
 * rebase) / unstable (checks failing but mergeable). Absent = unknown
 * (provider still computing); drafts are already covered by `PrStatus`.
 */
export type SessionPullRequestMergeState = 'c' | 'b' | 'd' | 'h' | 'u';

/**
 * Product-level merge readiness. `y` means the PR is cleanly mergeable with
 * successful or no CI. Legacy: the CLI poller used to compute this (factoring
 * in review decision and unresolved review threads) and write it as `r`; the
 * reconciler no longer writes `r` and deletes it on touch, so consumers must
 * derive readiness from `s`/`m` via `deriveSessionPullRequestReadiness`.
 */
export type SessionPullRequestReadiness = 'y' | 'n';

/**
 * Compact per-PR CI + merge/readiness record synced by the CLI PR poller.
 * Single-letter codes keep one entry under 50B — repo meta is costly sync state
 * and the budget for these signals together is 50B (see plan
 * `plans/20260717-cli-pr-status-poller.md` §5). `t` is the epoch SECOND of
 * the last change to `s`, `m`, or `r` (not of the last poll).
 */
export type SessionPullRequestStateMeta = {
  s?: SessionPullRequestCiState;
  m?: SessionPullRequestMergeState;
  r?: SessionPullRequestReadiness;
  t: number;
};

/**
 * Derive merge readiness from the poller-synced CI (`s`) and merge (`m`)
 * codes. A PR is ready when GitHub reports a clean merge state and CI is
 * either successful or absent. The legacy `r` field is intentionally ignored:
 * nothing writes it anymore and a stale value must not authorize a merge.
 */
export function deriveSessionPullRequestReadiness(
  state: SessionPullRequestStateMeta | null | undefined
): SessionPullRequestReadiness | null {
  if (!state || state.m !== 'c') {
    return null;
  }
  return state.s === undefined || state.s === 's' ? 'y' : null;
}

export type LineChange = {
  add: number;
  del: number;
};

export type SessionDiffStats = {
  allChange: LineChange;
};

export type SessionContextWindowUsage = {
  size: number;
  used: number;
};

export type SessionTitleSource = 'user' | 'generated' | 'draft';

export type ExternalAcpHistorySyncMeta = {
  provider: LocalProjectHistoryProvider;
  source: 'local-acp-history';
  /** Original ACP session id used only as an import source key, not a resumable Lody session id. */
  sourceAcpSessionId: ACPSessionId;
  sourceUpdatedAt?: string;
  replayDigest?: string;
  importedTurnCount: number;
  /** @deprecated Legacy bulky cursor. New writes do not store per-turn hashes in meta. */
  importedTurnHashes?: string[];
  lastSyncAt: number;
  status?: 'synced' | 'sync_conflict' | 'metadata_only';
  conflictReason?: string;
};

export type SessionPreviewDocState = {
  candidate?: PreviewCandidate;
  connection?: PreviewConnection;
};

export type SessionPreviewCandidateMeta = Pick<PreviewCandidate, 'status' | 'updatedAt'>;

export type SessionPreviewConnectionMeta = Pick<PreviewConnection, 'status' | 'updatedAt'>;

export type SessionPreviewLegacyMetaFields = {
  /** Deprecated legacy detail. Full preview candidate state lives in session doc `preview`. */
  previewCandidate?: PreviewCandidate;
  /** Deprecated legacy detail. Full preview connection state lives in session doc `preview`. */
  previewConnection?: PreviewConnection;
};

export type SessionExternalHistoryCursorDocState = {
  importedTurnHashes?: string[];
};

/**
 * Legacy/fallback launch config shape. New writers must not persist this per session;
 * resolve customAcp/env from AgentConfigMeta and worktree scripts from project config.
 */
export type SessionLaunchConfig = {
  customAcp?: CustomAcpLaunchSpec;
  runtimeOverrides?: BuiltinRuntimeOverrides;
  env?: Record<string, string>;
  worktreeSetup?: WorktreeSetupScriptConfig;
  worktreeCleanup?: WorktreeCleanupScriptConfig;
};

/**
 * A future-firing task scheduled by the agent (cron job or one-shot wakeup) that
 * keeps a session "alive" after the current turn ends. Surfaced above the composer so
 * the user knows the session will trigger again. NOT persisted anywhere: derived on the
 * fly from the Cron / ScheduleWakeup `tool_call` items already in session history (see
 * `collectPendingScheduledTasksFromHistory`).
 */
export type PendingScheduledTask = {
  /** Stable id: cron job id, or a fixed key for the session's single pending wakeup. */
  id: string;
  kind: 'cron' | 'wakeup';
  /**
   * When this task set entry was last recorded, epoch ms. For calls persisted with
   * `recordedAtMs` this is the tool call's own first-sighting stamp (the true creation
   * moment); older history falls back to the owning turn's START — never its `endedAt`,
   * which merged cron-fire turns can push past a one-shot's fire minute.
   */
  createdAtMs: number;
  /**
   * Wakeup fire time (epoch ms); also the runtime-committed fire time of a one-shot cron
   * whose CronCreate output carried a `nextFireAt` line. Absent for recurring cron jobs
   * (they resolve from their schedule expression relative to now).
   */
  scheduledForMs?: number;
  /** Cron schedule expression / human-readable schedule string. */
  humanSchedule?: string;
  /** True for recurring cron jobs; false/undefined for one-shot cron or wakeups. */
  recurring?: boolean;
  /** True if the cron job is persisted to disk (survives CLI restart); false = session-only. */
  durable?: boolean;
  /** Short description of what will happen when it fires (the scheduled prompt/reason). */
  summary?: string;
  /**
   * IANA timezone of the execution machine that created the cron (e.g. `America/New_York`).
   * Cron expressions are interpreted in the machine's LOCAL time (`0 9 * * *` = 9am there),
   * so the panel must resolve fire times in this zone — not the viewer's browser zone — or
   * the displayed time drifts when the two differ. Absent for wakeups (relative delay) and
   * for pre-existing history; callers fall back to the viewer's local zone then.
   */
  timeZone?: string;
};

export type SessionMeta = {
  id: SessionId;
  machineId: MachineId;
  createdAt: string;
  /** Feedback post id bound at session start, when the session originates from lody-feedback. */
  fromFeedbackPostId?: string;
  lastMessageAt?: number;
  lastReadAt?: number;
  /**
   * Timestamp of the last transition into an active status (running/initializing/
   * requestPermission). No longer refreshed periodically. Live working state is
   * read from ephemeral session presence instead of this durable metadata.
   */
  lastRunningSeen?: number;
  title?: string;
  /** Indicates whether the current title was entered by a user, generated by the agent, or copied from a draft tab prompt. */
  titleSource?: SessionTitleSource;
  userId: string;
  status?: SessionStatus;
  isArchived?: boolean;
  origin?: 'lody' | 'external-acp';
  /** When true, this session is pinned to the top of the sidebar list. */
  isPinned?: boolean;
  cliType: AgentConfigCliType;
  agentType: AgentType;
  agentConfigId?: AgentConfigId;
  /**
   * Agent Role this session was created from, and the Role revision that was
   * resolved when its create Operation was accepted.
   *
   * Provenance only. Execution is governed by the already-frozen agent config
   * and dispatch config, so nothing may re-read the mutable Role catalog from
   * these fields: a later Role edit or delete must not change execution.
   */
  agentRoleId?: AgentRoleId;
  agentRoleRevision?: number;
  acpSessionId?: ACPSessionId;
  /** Exact Session or child Tab that created/opened this session, when known. */
  openedBySessionId?: SessionId;
  /**
   * Root Session that owns `openedBySessionId` when the opener is a child Tab.
   * Omitted when the exact opener is already a root Session. Keeping this
   * companion pointer makes the cross-Session route self-contained: clients
   * can open the root route and restore the precise Tab even if the opener's
   * metadata has not synced yet.
   */
  openedByRootSessionId?: SessionId;
  /** Project binding for this session (GitHub repo or local project). */
  project?: ProjectRef;
  repoFullName?: string;
  /** Base branch selected when the session starts (starting point). */
  baseBranch?: string;
  /** Runtime working branch for the session (changes as session runs). */
  branchName?: string;
  /** True if this session runs inside a git worktree (local or GitHub). */
  isWorktree?: boolean;
  pullRequests?: SessionPullRequestMeta[];
  /**
   * CI rollup + merge/readiness per associated PR URL, written by the CLI PR
   * poller (compact single-letter codes, ≤50B/entry). Kept outside
   * `pullRequests` because the webhook fan-out replaces that array wholesale
   * and strips it to `{url, status}`.
   */
  pullRequestState?: Record<string, SessionPullRequestStateMeta>;
  contextWindowUsage?: SessionContextWindowUsage;
  /**
   * Latest user history entry published for dispatch. Owned by dispatch
   * producers; execution terminal bookkeeping must never rewrite it.
   */
  latestUserMsgId?: string;
  /** Assistant turn id the client wants to stop; cancel is ignored unless it matches the machine's in-memory active turn. */
  lastCanceledTurn?: string;
  /** Latest user history entry id that the machine has fully handled. */
  lastHandledUserMsgId?: string;
  /** User history entry id currently being processed by the machine. */
  processingUserMsgId?: string;
  /**
   * Exact dispatch activation negatively acknowledged because its history
   * payload never synced. It suppresses only a matching producer pointer.
   */
  lastMissingHistoryUserMsgId?: string;
  /**
   * Exact dispatch activation retired because its history entry is already
   * terminal — the turn ran, only the pointer was stale. Recorded beside the
   * producer-owned pointers instead of rewriting them, because there is no CAS
   * against a concurrent send. It suppresses only a matching pointer, and the
   * turn it names is terminal, so a later settlement may replace it freely.
   */
  settledActivationUserMsgId?: string;
  /** Goal thread id the user dismissed from the banner after it reached a terminal state.
   *  The banner stays hidden until a goal with a different threadId arrives. */
  dismissedGoalThreadId?: string;
  // 当前 codespace 相比基础分支(默认main)的代码变更统计
  diffStats?: SessionDiffStats;
  /** True if workspace has uncommitted changes (staged or unstaged) */
  workspaceDirty?: boolean;
  /** If set, this session is a child tab of another session and shares its workspace directory. */
  parentSessionId?: SessionId;
  /**
   * Sparse presentation override for a child session. Absence keeps the existing
   * top-tab behavior; side-panel children stay out of the tab strip and are
   * rendered as durable conversation panels instead.
   */
  childSessionPlacement?: 'side-panel';
  /** History entry id pinned at the top of this session's chat. When empty or undefined, no pin banner is shown. */
  pinnedHistoryId?: string;
  /** Preview candidate summary for list/header UI; full state lives in session doc `preview`. */
  previewCandidate?: SessionPreviewCandidateMeta;
  /** Preview connection summary for list/header UI; full state lives in session doc `preview`. */
  previewConnection?: SessionPreviewConnectionMeta;
  /** External native history projection cursor for imported sessions. */
  externalHistory?: ExternalAcpHistorySyncMeta;
  /** Monotonic-ish signal used to wake the owning CLI when the CRDT message queue changes. */
  messageQueueUpdatedAt?: number;
  /** Last queue update signal the owning CLI checked when no dispatchable turn was found. */
  messageQueueCheckedAt?: number;
  /**
   * Task this session belongs to, for navigation back to it. The association
   * itself, with its provenance, lives in the task document; this is only a
   * pointer, and a session belongs to at most one task.
   */
  taskId?: TaskId;
  /**
   * When the session started waiting on a human answer, cleared when the request
   * resolves. A list-rendering summary of the durable truth in history (a
   * permission request with no outcome), so surfaces can show "waiting on you"
   * without opening session documents.
   *
   * Unlike `status`, this is not repaired by the heartbeat TTL: a machine that
   * goes offline mid-question is still waiting on the user, and that is exactly
   * when the signal matters.
   */
  awaitingUserSince?: number;
  /**
   * Auto review and merge authorization plus a pointer to the run document.
   * Presence of this field IS the checkbox being on, so unchecking removes it.
   *
   * Only a human may write it. The reviewer and the authoring agent both run
   * with MCP access to this session, and an agent that could grant itself merge
   * authority would make the whole gate decorative — the same rule that keeps
   * MCP from writing a Task's entrusted `agent`.
   */
  autoReview?: SessionAutoReviewMeta;
};

/**
 * Resolve the dispatch activation a machine still owes work for.
 *
 * The pointer pair alone is NOT the answer: two suppression slots retire an
 * activation without rewriting the producer-owned pointers, so raw
 * `latestUserMsgId !== lastHandledUserMsgId` reports pending work forever once
 * either fires. `lastMissingHistoryUserMsgId` is a permanent negative ack for a
 * turn whose payload never synced; `settledActivationUserMsgId` retires a turn
 * whose history entry is already terminal. Every consumer that asks "does this
 * session still owe a turn?" — dispatch, idle GC, auto review, MCP status —
 * must go through here, or they disagree with the watcher and hang.
 */
export function getPendingUserTurnActivationId(meta: SessionMeta): string | undefined {
  const missingUserTurnId = meta.lastMissingHistoryUserMsgId;
  const settledUserTurnId = meta.settledActivationUserMsgId;
  if (
    typeof meta.processingUserMsgId === 'string' &&
    meta.processingUserMsgId.length > 0 &&
    meta.processingUserMsgId !== missingUserTurnId &&
    meta.processingUserMsgId !== settledUserTurnId
  ) {
    return meta.processingUserMsgId;
  }
  if (
    typeof meta.latestUserMsgId === 'string' &&
    meta.latestUserMsgId.length > 0 &&
    meta.latestUserMsgId !== meta.lastHandledUserMsgId &&
    meta.latestUserMsgId !== missingUserTurnId &&
    meta.latestUserMsgId !== settledUserTurnId
  ) {
    return meta.latestUserMsgId;
  }
  return undefined;
}

export function hasPendingUserTurnActivation(meta: SessionMeta): boolean {
  return getPendingUserTurnActivationId(meta) !== undefined;
}

export type SessionLegacyMetaFields = {
  /** Deprecated legacy snapshot; new writes keep goal state in session history. */
  latestGoal?: Extract<MessageContent, { type: 'goal' }> | null;
  /** Deprecated launch state; new writes store this in AgentConfigMeta. */
  customAcp?: CustomAcpLaunchSpec;
  /** Deprecated launch state; new writes store this in AgentConfigMeta. */
  env?: Record<string, string>;
  /** Deprecated launch state; new writes store this in project worktree config. */
  worktreeSetup?: WorktreeSetupScriptConfig;
  /** Deprecated launch state; new writes store this in project worktree config. */
  worktreeCleanup?: WorktreeCleanupScriptConfig;
};

export type SessionMetaWithLegacyPreview = Omit<
  SessionMeta,
  'previewCandidate' | 'previewConnection'
> &
  Partial<SessionPreviewLegacyMetaFields>;

export function getSessionPreviewLegacyFields(
  session: Pick<SessionMeta, 'previewCandidate' | 'previewConnection'> | null | undefined
): Partial<SessionPreviewLegacyMetaFields> {
  return (session ?? {}) as Partial<SessionPreviewLegacyMetaFields>;
}

export type NeedToDeleteSessionQueueItem =
  | boolean
  | {
      repoFullName?: string;
      branchName?: string;
      baseBranchName?: string;
      requestedAt?: number;
      localProjectId?: LocalProjectId;
      originalRootPath?: string;
      isWorktree?: boolean;
      keptWorktreePath?: string;
    };

export const sessionSchema = schema.LoroMap({
  id: schema.String<SessionId>(),
});

export const messageQueueItemSchema = schema.LoroMap({
  task: schema.String(),
  project: schema.Any({ required: false }),
  userId: schema.String(),
  userTurnId: schema.String({ required: false }),
  timestamp: schema.String(),
  isEditing: schema.Boolean({ required: false }),
  // Calibrated server time (`getServerNow()`) when the current editor entered the row.
  // Used as a lease so the CLI dispatcher does not block the queue forever if the
  // editing client never gets a chance to clear `isEditing` (hard close / crash /
  // killed tab). See `popMessageQueue` in `apps/cli/src/lib/loro/doc.ts`.
  editingStartedAt: schema.Number({ required: false }),
  acpSessionConfig: acpSessionConfigSchema,
});

export type MessageQueueItem = Omit<InferType<typeof messageQueueItemSchema>, 'project'> & {
  project: ProjectRef | undefined;
};
export type MessageQueueItemInput = Omit<
  InferInputType<typeof messageQueueItemSchema>,
  'project'
> & {
  project: ProjectRef | undefined;
};

const sessionForkOperationDocSchema = schema.LoroMap(
  {
    id: schema.String(),
    sourceSessionId: schema.String<SessionId>(),
    sourceTurnId: schema.String(),
    requestedByUserId: schema.String(),
    targetContext: schema.String<'shared' | 'new-worktree'>(),
    capturedHeadSha: schema.String({ required: false }),
    sourceWasDirty: schema.Boolean({ required: false }),
    state: schema.String<'preparing' | 'failed'>(),
    phase: schema.String<'preparing-worktree' | 'running-setup' | 'starting-agent' | 'committing'>({
      required: false,
    }),
    error: schema.LoroMap(
      {
        code: schema.String(),
        message: schema.String(),
      },
      { required: false }
    ),
    createdAt: schema.String(),
    updatedAt: schema.String(),
  },
  { required: false }
);

/**
 * ACP-reported runtime configuration after a Turn has started. This is shared
 * control state, not transcript content: `basedOnUserTurnId` supplies the
 * causal fence that prevents a late update from changing a newer Turn's
 * composer baseline.
 */
export type SessionAcpRuntimeConfigSnapshot = {
  acpSessionId: ACPSessionId;
  basedOnUserTurnId: string;
  revision: number;
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, AcpConfigOptionValue>;
};

export type SessionAcpRuntimeConfigPatch = Omit<
  SessionAcpRuntimeConfigSnapshot,
  'basedOnUserTurnId' | 'revision'
>;

const sessionAcpRuntimeConfigDocSchema = schema.LoroMap(
  {
    acpSessionId: schema.String<ACPSessionId>(),
    basedOnUserTurnId: schema.String(),
    revision: schema.Number(),
    modeId: schema.String({ required: false }),
    modelId: schema.String({ required: false }),
    configOptionValues: schema.Any({ required: false }),
  },
  { required: false }
);

/**
 * Root schema for a session doc.
 *
 * Synced docs outlive the builds that write them: a client on a newer schema
 * can add a root key that older clients do not declare. Adding an optional
 * root field is therefore safe, but only because every Mirror over a synced
 * doc is constructed with `ignoreUnknownProperties` — without it loro-mirror
 * rejects the whole state with `Unknown property: <key>` and the older client
 * can never write to that doc again. Removing or repurposing an existing root
 * field is still a breaking change.
 *
 * See `packages/shared/tests/session-doc-forward-compat.test.ts`.
 */
export const sessionDocSchema = schema({
  session: sessionSchema,
  history: schema.LoroList(sessionHistorySchema, (item) => item.id),
  mq: schema.LoroMovableList(messageQueueItemSchema, (item) => item.$cid, { required: false }),
  /** Temporary durable state for an asynchronous Session fork. Removed on success. */
  forkOperation: sessionForkOperationDocSchema,
  preview: sessionPreviewDocSchema,
  externalHistoryCursor: sessionExternalHistoryCursorDocSchema,
  acpRuntimeConfig: sessionAcpRuntimeConfigDocSchema,
});

/**
 * How this machine is hosted.
 * - `user`: owned by a user, running a local CLI.
 * - `cloud`: managed by Lody's cloud runtime (not exposed in the UI yet).
 *
 * Absent values read as `'user'` via `getMachineHostType()`.
 */
export type MachineHostType = 'user' | 'cloud';

export type MachineMeta = {
  id: MachineId;
  name: string;
  /** User id that owns/logged into this machine. Used for UI scoping. */
  ownerUserId?: string;
  /** See `MachineHostType`. Treat absent as `'user'`. */
  hostType?: MachineHostType;
  cliVersion: string;
  os: string;
  supportRegistryAgentTypes?: string[];
  sessions: SessionId[];
  /**
   * @deprecated Legacy registration timestamp; no longer written. Machine
   * online detection reads ephemeral machine presence only — never this field.
   */
  lastSeen?: number;
  /** Version string for the machine RPC protocol implementation. */
  rpcVersion?: string;
  /** True when this machine can handle local project history sync/import over Streams RPC. */
  supportsLocalProjectHistoryRpc?: boolean;
  /** Versioned daemon protocols available to remote and local clients. */
  protocolCapabilities?: MachineProtocolCapabilities;
};

/**
 * Fields that may still exist on older machine doc metadata but are no longer
 * part of the current MachineMeta contract. New writers must use the machine
 * Flock doc for this state.
 */
export type MachineLegacyMetaFields = {
  acpCapabilities?: Record<string, AcpCapabilityCacheEntry>;
  localProjects?: Record<LocalProjectId, LocalProjectMeta>;
  workspacePaths?: Record<SessionId, string>;
  needToArchiveSessions?: Record<SessionId, boolean>;
  needToDeleteSessions?: Record<SessionId, NeedToDeleteSessionQueueItem>;
  raceLimits?: Record<string, RateLimit>;
};

/**
 * UI/CLI read model after overlaying machine Flock doc rows and legacy fallback
 * metadata. This type is intentionally separate from MachineMeta so root repo
 * metadata does not look like a cheap place for bulky machine state.
 */
export type MachineViewMeta = MachineMeta &
  Omit<MachineLegacyMetaFields, 'raceLimits'> & {
    raceLimits: Record<string, RateLimit>;
  };

export const getMachineHostType = (meta: Pick<MachineMeta, 'hostType'>): MachineHostType =>
  meta.hostType ?? 'user';

export type SessionDoc = InferInputType<typeof sessionDocSchema>;
export type SessionDocMeta = Omit<SessionDoc, '$cid' | 'history'> & {
  session: { id: SessionId };
  history: SessionHistory[];
  mq?: MessageQueueItem[];
};
export type Session = SessionMeta & SessionDocMeta;
export type SessionToCreate = Omit<
  SessionMeta,
  'id' | 'createdAt' | 'chatId' | 'status' | 'isArchived' | 'diffStats'
> &
  SessionLaunchConfig & {
    sessionId?: SessionId;
  };
export type SessionToUpdate = Pick<Session, 'id' | 'status' | 'history'>;
export type SessionToDelete = Pick<Session, 'id'>;
export type SessionHistoryInput = Omit<
  InferInputType<typeof sessionHistorySchema>,
  | 'userTurnId'
  | 'acpTurnId'
  | 'modelInfo'
  | 'fileDiff'
  | 'startedAt'
  | 'endedAt'
  | 'permissionWaitMs'
  | 'plan'
  | 'finished'
  | 'sendStatus'
  | 'status'
  | 'inputConfig'
  | 'items'
  | 'read'
  | 'userId'
> & {
  items?: Array<MessageContent & { text?: string | undefined }>;
  read?: boolean;
  userId?: string;
  userTurnId?: string | undefined;
  acpTurnId?: string | undefined;
  modelInfo?: ModelInfo | undefined;
  fileDiff: FileDiff[];
  status?: SessionHistoryStatus;
  inputConfig?: SessionTurnInputConfig | undefined;
  /**
   * @deprecated Use `timestamp` for the start time of this turn.
   * Kept for backward compatibility with older clients.
   */
  startedAt?: number;
  endedAt?: number;
  permissionWaitMs?: number;
  plan?: SessionPlanEntry[];
  finished?: boolean;
  sendStatus?: SessionHistorySendStatus;
};
export type SessionHistory = Omit<SessionHistoryInput, '$cid'> & {
  $cid?: string;
};
export type SessionHistoryParsed = Omit<SessionHistory, 'items' | 'fileDiff'> & {
  items: MessageContent[];
  fileDiff?: FileDiff[] | undefined;
};

export const resolveActiveAssistantTurnId = (
  history:
    | ReadonlyArray<Pick<SessionHistoryInput, 'id' | 'role' | 'finished' | 'endedAt'> | undefined>
    | null
    | undefined
): string | undefined => {
  if (!history?.length) {
    return undefined;
  }

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (!entry || entry.role !== 'assistant') {
      continue;
    }
    if (entry.finished === true || typeof entry.endedAt === 'number') {
      return undefined;
    }
    return entry.id;
  }

  return undefined;
};

export type WorkspaceDoc = {
  sessions: WorkspaceSession[];
  agentConfigs: WorkspaceAgentConfig[];
};
export type Workspace = WorkspaceDoc;
export type WorkspaceSession = { id: SessionId; isDeleted: boolean };
export type WorkspaceAgentConfig = { id: AgentConfigId; isDeleted: boolean };
