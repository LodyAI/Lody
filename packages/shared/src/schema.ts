import type { SessionProjectRun } from './workspace-project';
import type { SessionEntry, SessionFileDiff } from './session-data/domain';
import type { InferInputType, InferType } from 'loro-mirror';
import {
  ACPSessionId,
  AcpConfigOptionValue,
  AgentBrandId,
  AgentConfigId,
  AgentConfigCliType,
  AgentRoleId,
  AgentType,
  AcpCapabilityCacheEntry,
  AcpCommandSummary,
  BuiltinRuntimeOverrides,
  CustomAcpLaunchSpec,
  LocalProjectHistoryProvider,
  LocalProjectId,
  LocalProjectMeta,
  MachineId,
  MessageContent,
  ProjectRef,
  PreviewCandidate,
  PreviewConnection,
  Role,
  SessionId,
  WorktreeCleanupScriptConfig,
  WorktreeSetupScriptConfig,
} from '.';
import type { PlanEntry } from '@agentclientprotocol/sdk';
import type { MachineProtocolCapabilities } from './machine-protocol-capabilities';
// Value exports stay out: `loro-mirror` value imports retain `loro-crdt` (WASM)
// in the importing chunk, and this module is reachable from the renderer boot
// path. Mirror construction lives in `./session-doc-schemas`.
export type * from 'loro-mirror';
// Same rule for the schema objects: re-exported as types so `typeof
// sessionDocSchema` keeps resolving; value consumers import
// `./session-doc-schemas` directly.
export type {
  messageQueueItemSchema,
  sessionDocSchema,
  sessionExternalHistoryCursorDocSchema,
  sessionHistorySchema,
  sessionPlanEntrySchema,
  sessionPreviewDocSchema,
  sessionSchema,
} from './session-doc-schemas';
import type { messageQueueItemSchema, sessionDocSchema } from './session-doc-schemas';
// PR field types/helpers live in their own module so the renderer boot path
// (session list atoms, notification presentation) can consume them without
// pulling in the loro-mirror/loro-crdt graph through this file.
export * from './session-pull-request-meta';
import type {
  SessionAutoDelivery,
  SessionPullRequestRecordFields,
  SessionPullRequestMeta,
  SessionPullRequestStateMeta,
} from './session-pull-request-meta';
import type { RateLimit } from 'acp-extension-core';

export const RATE_LIMIT_ENTRY_KEY_SEPARATOR = '::';
const PROVIDER_RATE_LIMIT_ENTRY_KEY_PREFIX = 'provider';

/**
 * Known limitId values used to distinguish rate limit tiers.
 * - `codex`: standard Codex limit
 * - `codex_bengalfox`: Codex Spark limit
 */
export const CODEX_SPARK_LIMIT_ID = 'codex_bengalfox';

export const getRateLimitEntryKey = (
  cliType: string,
  limitId: string | null | undefined,
  agentConfigId?: AgentConfigId | null
): string => {
  const id = limitId?.trim() || cliType;
  if (agentConfigId) {
    return [
      PROVIDER_RATE_LIMIT_ENTRY_KEY_PREFIX,
      encodeURIComponent(agentConfigId),
      encodeURIComponent(cliType),
      encodeURIComponent(id),
    ].join(RATE_LIMIT_ENTRY_KEY_SEPARATOR);
  }
  return `${cliType}${RATE_LIMIT_ENTRY_KEY_SEPARATOR}${id}`;
};

export const parseRateLimitEntryKey = (
  key: string
): {
  agentConfigId: AgentConfigId | null;
  cliType: string;
  limitId: string | null;
} => {
  const parts = key.split(RATE_LIMIT_ENTRY_KEY_SEPARATOR);
  if (
    parts.length === 4 &&
    parts[0] === PROVIDER_RATE_LIMIT_ENTRY_KEY_PREFIX &&
    parts[1] &&
    parts[2] &&
    parts[3]
  ) {
    try {
      return {
        agentConfigId: decodeURIComponent(parts[1]) as AgentConfigId,
        cliType: decodeURIComponent(parts[2]),
        limitId: decodeURIComponent(parts[3]),
      };
    } catch {
      // Malformed scoped keys stay unreadable rather than being attributed to
      // an unrelated provider through the legacy parser below.
      return { agentConfigId: null, cliType: '', limitId: null };
    }
  }

  const separatorIndex = key.indexOf(RATE_LIMIT_ENTRY_KEY_SEPARATOR);
  if (separatorIndex === -1) {
    return {
      agentConfigId: null,
      cliType: key,
      limitId: null,
    };
  }

  const cliType = key.slice(0, separatorIndex);
  const limitId = key.slice(separatorIndex + RATE_LIMIT_ENTRY_KEY_SEPARATOR.length);
  if (!limitId) {
    return {
      agentConfigId: null,
      cliType,
      limitId: null,
    };
  }

  return {
    agentConfigId: null,
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
export type SessionRunningPhase = 'finalizing';
export type PermissionRequestKind = 'permission' | 'ask_user_question';

export type SessionStatus =
  | { type: 'idle' }
  | { type: 'running'; activity?: SessionRunningActivity; phase?: SessionRunningPhase }
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

/**
 * Provider values a session runs with where its request names none, keyed by
 * the agent's config ids (Sorbet: `model`, `thought_level`, `permission_mode`).
 */
export type AgentSessionDefaults = {
  modelId?: string;
  configOptionValues: Record<string, AcpConfigOptionValue>;
};

export type AgentConfigMeta = {
  codexAuth?: import('./codex-auth-profile').CodexAuthProfile;
  id: AgentConfigId;
  /**
   * Parent machine this config belongs to. Configs are scoped per-machine because
   * each machine has its own binaries, auth state, env, and rate-limit context.
   *
   * Legacy configs written before this field existed are normalized by the one-time
   * `useAgentConfigMigration` hook in `@lody/components`. Consumers should filter
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
  /** Local gateway metadata consumed by Lody before launch, outside process env. */
  magpieGatewayUrl?: string;
  env: Record<string, string>;
  prompt?: string;
  /** Title generation settings. When set, enables automatic title generation for this agent. */
  titleGeneration?: TitleGenerationConfig;
  sessionDefaults?: AgentSessionDefaults;
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
 * Insertion policy (NOT a migration or a new validation constraint):
 * - The history item catchall is `schema.Any({ defaultLoroText: false })` so a brand-new
 *   string field is stored as a plain primitive. A new turn's ordinary metadata
 *   (`toolCallId`/`status`/`title`/`kind`/`locations[].path`) is therefore not wrapped in
 *   a `LoroText`, which removes thousands of unnecessary containers across a long session.
 * - Text containers are reserved for fields that genuinely grow while streaming. They are
 *   declared explicitly (outer `text`/`markdown`/`content`/`steps`) instead of leaning on
 *   deep inference, which also avoids emitting `insert-container` for schema-less nested
 *   strings whose per-container infer options are not persisted across a restart.
 * - Editing an existing string neither migrates nor rewraps it: the shared
 *   `HistoryWriter` diffs against the stored container kind, so a legacy `LoroText` keeps
 *   its container id and a legacy primitive stays primitive (`history-materializer.ts`).
 *
 * Validation stays separate from this storage hint: the permissive `validate` guard below
 * still accepts unknown item types from newer peers, and no schema here rejects an old
 * payload (see the `storageSchema` hints).
 */
export type SessionHistoryItem = MessageContent;
export type SessionHistoryItems = MessageContent[];

export type SerializedLoroOpId = `${string}:${number}`;

export type FileDiffCodeCollabCheckpoint = NonNullable<SessionFileDiff['cc']>;
export type FileDiff = SessionFileDiff;

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

export type SessionHistorySendStatus = 'timeout';
export type SessionHistoryStatus =
  | 'prepared'
  | 'pending'
  | 'pending_apply'
  | 'delivery_unknown'
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

export const isSessionHistoryDelivered = (
  entry: SessionHistoryStatusReadable | null | undefined
): boolean => {
  const status = resolveSessionHistoryStatus(entry);
  if (status) {
    return (
      status !== 'prepared' &&
      status !== 'pending' &&
      status !== 'pending_apply' &&
      status !== 'delivery_unknown'
    );
  }
  return entry?.read === true;
};

/**
 * User input no execution has claimed. `seen` is only the CLI's read receipt:
 * the turn still needs its dispatch pointer and has not started.
 */
export const isSessionHistoryStatusAwaitingStart = (
  status: SessionHistoryStatus | undefined
): boolean => status === 'pending' || status === 'seen';

export const isSessionHistoryPendingForDispatch = (
  entry: SessionHistoryStatusReadable | null | undefined
): boolean => {
  const status = resolveSessionHistoryStatus(entry);
  return status === 'pending' || status === 'seen' || status === 'processing';
};

export type LineChange = {
  add: number;
  del: number;
  /** Changed paths in the complete workspace comparison; absent on older writers. */
  files?: number;
};

export type SessionDiffStats = {
  /** Workspace base versus current files, including committed and uncommitted changes. */
  allChange: LineChange;
};

/** Explicit path counts own presence; old daemons only published text line totals. */
export function hasWorkspaceChanges(change: LineChange | null | undefined): boolean {
  if (!change) return false;
  return change.files === undefined ? change.add + change.del > 0 : change.files > 0;
}

export type SessionContextWindowUsage = {
  size: number;
  used: number;
};

export type SessionTitleSource = 'user' | 'generated' | 'draft';

const DRAFT_SESSION_TITLE_MAX_CHARS = 50;

/**
 * Placeholder title for a new Session: the prompt's first non-empty line. Stored
 * with `titleSource: 'draft'` so a generated title still replaces it; ACP-owned
 * titles (e.g. Codex) only arrive after the first turn ends.
 */
export const deriveDraftSessionTitle = (prompt: string): string | undefined =>
  prompt
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, DRAFT_SESSION_TITLE_MAX_CHARS);

export type ExternalAcpHistorySyncMeta = {
  provider: LocalProjectHistoryProvider;
  source: 'local-acp-history';
  /** Original ACP session id used only as an import source key, not a resumable Lody session id. */
  sourceAcpSessionId: ACPSessionId;
  sourceUpdatedAt?: string;
  replayDigest?: string;
  /**
   * Canonical-hash version `replayDigest` was computed with. Absent means v1
   * (written before hash versions existed). It versions the digest only; the
   * session doc cursor carries its own version for `importedTurnHashes`.
   */
  hashVersion?: number;
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

export type SessionExternalHistoryCursorDocState = {
  importedTurnHashes?: string[];
  /**
   * Canonical-hash version `importedTurnHashes` were computed with. Absent means
   * v1. It is deliberately independent of `ExternalAcpHistorySyncMeta.hashVersion`:
   * a conflict marker may advance only the metadata while this cursor stays v1, and
   * a v1 cursor must never be read as v2 (that manufactures a false prefix_mismatch).
   */
  hashVersion?: number;
  /** Versioned JSON bound to this cursor's source hashes, not the metadata digest. */
  storedHistoryBaseline?: string;
};

/** Logical changes in an owner history publication. */
export type SessionHistoryChange =
  | { readonly kind: 'structure'; readonly from: number; readonly to: number }
  | { readonly kind: 'changed'; readonly ids: readonly string[] };

/**
 * Legacy/fallback launch config shape. New writers must not persist this per session;
 * resolve customAcp/env from AgentConfigMeta and worktree scripts from project config.
 */
export type SessionLaunchConfig = {
  codexAuth?: import('./codex-auth-profile').CodexAuthProfile;
  customAcp?: CustomAcpLaunchSpec;
  runtimeOverrides?: BuiltinRuntimeOverrides;
  magpieGatewayUrl?: string;
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

export type SessionHistoryBackendKind = 'loro' | 'roost';

/** Missing discriminator means a legacy session and must remain pinned to Loro. */
export const LEGACY_SESSION_HISTORY_BACKEND: SessionHistoryBackendKind = 'loro';

/** Explicit backend selected by the renderer when the Roost experiment is enabled. */
export const ROOST_SESSION_HISTORY_BACKEND: SessionHistoryBackendKind = 'roost';

/**
 * Default for creation paths without a renderer feature-gate decision.
 * Existing sessions keep their persisted choice; only an explicit opt-in selects Roost.
 */
export const NEW_SESSION_HISTORY_BACKEND: SessionHistoryBackendKind =
  LEGACY_SESSION_HISTORY_BACKEND;

/**
 * Resolve the immutable history backend choice for an opened session.
 *
 * Keep this policy in the shared package so the CLI and renderer cannot
 * accidentally assign different meanings to a missing discriminator while a
 * document is still being bootstrapped.
 */
export const resolveSessionHistoryBackendKind = (
  meta?: Pick<{ historyBackend?: SessionHistoryBackendKind }, 'historyBackend'> | null
): SessionHistoryBackendKind => meta?.historyBackend ?? LEGACY_SESSION_HISTORY_BACKEND;

export type SessionQueuePromotionState =
  | 'prepared'
  | 'history_accepted'
  | 'activation_published'
  | 'queue_consumed';

export type SessionQueuePromotionRecord = {
  queueCid: string;
  userTurnId: string;
  state: SessionQueuePromotionState;
  updatedAt: number;
};

export type SessionSteerOperationRecord = {
  operationId: string;
  userTurnId: string;
  expectedTurnId: string;
  cancellationPolicy: 'promote' | 'preserve';
  phase: 'prepared' | 'submitted' | 'settled';
  delivery: 'not_submitted' | 'applied' | 'not_applied' | 'unknown';
  status: 'pending' | 'processing' | 'handled' | 'failed' | 'canceled' | 'delivery_unknown';
  updatedAt: number;
};

export type SessionImportFence = {
  workspaceId: string;
  turnIds: string[];
  queueItemIds: string[];
  /** Provenance only. */
  importedBy?: string;
};

/** On a schedule document's metadata: the activation an import carried in. */
export type ScheduleImportFence = { workspaceId: string; activationId: string };

const EMPTY_FENCE: { turnIds: readonly string[]; queueItemIds: readonly string[] } = {
  turnIds: [],
  queueItemIds: [],
};

/** Turn and queue ids an import fenced off in this workspace; empty elsewhere. */
export function getImportFence(
  meta: Pick<SessionMeta, 'importFence'> | undefined,
  workspaceId: string | undefined
): { turnIds: readonly string[]; queueItemIds: readonly string[] } {
  const fence = meta?.importFence;
  if (!workspaceId || !fence || fence.workspaceId !== workspaceId) return EMPTY_FENCE;
  return {
    turnIds: Array.isArray(fence.turnIds) ? fence.turnIds : [],
    queueItemIds: Array.isArray(fence.queueItemIds) ? fence.queueItemIds : [],
  };
}

/** True when this schedule activation came from an import into `workspaceId`. */
export function isScheduleImportFenced(
  meta: { importFence?: unknown } | undefined,
  workspaceId: string,
  activationId: string
): boolean {
  const fence = meta?.importFence as Partial<ScheduleImportFence> | undefined;
  return fence?.workspaceId === workspaceId && fence.activationId === activationId;
}

export type SessionMeta = SessionPullRequestRecordFields & {
  /** Latest assistant's actual model; null means no assistant history, absent means unknown. */
  lastModel?: { modelId?: string; name?: string } | null;
  id: SessionId;
  machineId: MachineId;
  createdAt: string;
  /** Feedback post id bound at session start, when the session originates from lody-feedback. */
  fromFeedbackPostId?: string;
  /** 36-byte UUID activation index; content lives in the session control doc. */
  notificationId?: string;
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
  /** User-owned tree execution barrier; inherited through containment and precise opener links. */
  collaborationStopped?: boolean;
  /** Turns and queued items from a bundle import that never run in `workspaceId`. */
  importFence?: SessionImportFence;
  /** Shared tab visibility only; closing never changes the session lifecycle. */
  isTabClosed?: boolean;
  origin?: 'lody' | 'external-acp';
  /** When true, this session is pinned to the top of the sidebar list. */
  isPinned?: boolean;
  /** Pin section this pinned session belongs to; missing or unknown means the default section. Read only while `isPinned`. */
  pinSectionId?: string;
  /** Fractional index ordering this session manually (shared by Pinned sections and Status Focus). */
  orderKey?: string;
  /** Epoch ms until which this session is snoozed in the Status view's Later section. */
  snoozedUntil?: number;
  /** Epoch ms when the user explicitly settled this session in the Status view's Settled section. */
  settledAt?: number;
  /** Epoch ms when the user explicitly moved an inactive session back to Focus (overrides 7d auto-settle for 7d). */
  focusRestoredAt?: number;
  cliType: AgentConfigCliType;
  agentType: AgentType;
  /** Backend selected when this session was created. Missing means legacy Loro. */
  historyBackend?: SessionHistoryBackendKind;
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
  /** Schedule provenance only, a UUID of at most 50 UTF-8 bytes. */
  scheduleId?: string;
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
  projectRun?: SessionProjectRun;
  repoFullName?: string;
  /** Base branch selected when the session starts (starting point). */
  baseBranch?: string;
  /** Runtime working branch for the session (changes as session runs). */
  branchName?: string;
  /** True if this session runs inside a git worktree (local or GitHub). */
  isWorktree?: boolean;
  /** Machine-owned association order; status is a compatibility projection. */
  pullRequests?: SessionPullRequestMeta[];
  /**
   * CI rollup + merge/readiness per associated PR URL, written by the CLI PR
   * poller (compact single-letter codes, ≤50B/entry). Independent of both
   * association ordering and provider-versioned lifecycle registers.
   */
  pullRequestState?: Record<string, SessionPullRequestStateMeta>;
  contextWindowUsage?: SessionContextWindowUsage;
  /**
   * Latest user history entry published for dispatch. Owned by dispatch
   * producers; execution terminal bookkeeping must never rewrite it.
   */
  latestUserMsgId?: string;
  /** Daemon-owned steer results awaiting history projection or ordinary dispatch claim. */
  steerTurnStatuses?: Record<
    string,
    'pending' | 'processing' | 'handled' | 'failed' | 'canceled' | 'delivery_unknown'
  >;
  /** Durable provider-delivery evidence, keyed by stable steer operation id. */
  steerOperationLedger?: Record<string, SessionSteerOperationRecord>;
  /** Recoverable queue promotion receipts, keyed by the stable operation id. */
  queuePromotionLedger?: Record<string, SessionQueuePromotionRecord>;
  /** Stop request marker into the Session control doc; legacy values directly name the target turn. */
  lastCanceledTurn?: string;
  /** Latest user history entry id that the machine has fully handled. */
  lastHandledUserMsgId?: string;
  /**
   * Latest user history entry id whose turn ended in failure, written together with
   * `lastHandledUserMsgId`. It stays set; read it only through
   * {@link hasFailedLatestTurn}, so a later handled or canceled turn retires it without
   * another write.
   */
  lastFailedUserMsgId?: string;
  /** User history entry id currently being processed by the machine. */
  processingUserMsgId?: string;
  /**
   * Legacy latest missing-history acknowledgement. Read with the retained map;
   * producers must not clear this receipt when publishing a fresh activation.
   */
  lastMissingHistoryUserMsgId?: string;
  /** Host-owned append-only acknowledgements; a newer timeout must not revive an older input. */
  missingHistoryUserMsgIds?: Record<string, true>;
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
  /**
   * True if the working branch has local commits its upstream lacks. Tracked
   * separately from `workspaceDirty` because they go stale at different moments:
   * committing clears `workspaceDirty` while the remote — and therefore the PR
   * head a reviewer reads — is still behind. Consumers that ask "is the PR head
   * the author's latest work?" must check BOTH.
   */
  workspaceUnpushed?: boolean;
  /**
   * Auto delivery progress for this Session's pull request. The owning machine
   * writes it at each transition only; absent or null while Auto delivery is off.
   */
  autoDelivery?: SessionAutoDelivery | null;
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
  /** Last agent-started simulator operation (UUID only); UI discovery hint, never live state or authority. */
  iosSimulatorPreviewRequestId?: string;
  androidEmulatorPreviewRequestId?: string;
  /** Preview connection summary for list/header UI; full state lives in session doc `preview`. */
  previewConnection?: SessionPreviewConnectionMeta;
  /** External native history projection cursor for imported sessions. */
  externalHistory?: ExternalAcpHistorySyncMeta;
  /** Monotonic-ish signal used to wake the owning CLI when the CRDT message queue changes. */
  messageQueueUpdatedAt?: number;
  /** Control-document causal frontier captured after the queue mutation named by updatedAt. */
  messageQueueUpdateVersion?: {
    updatedAt: number;
    frontiers: { peer: `${number}`; counter: number }[];
  };
  /** Last queue signal whose control mutation was observed and whose queue was drained. */
  messageQueueCheckedAt?: number;
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
   * Historical auto-review pointer, retained for stored metadata compatibility.
   * The retired review automation no longer reads or acts on this field.
   */
  autoReview?: { runId: string; t: number };
};

/** Match a retained missing-payload acknowledgement, including legacy metadata. */
export function isMissingHistoryUserTurn(
  meta: Pick<SessionMeta, 'lastMissingHistoryUserMsgId' | 'missingHistoryUserMsgIds'> | undefined,
  turnId: string | undefined
): boolean {
  return (
    !!turnId &&
    (meta?.lastMissingHistoryUserMsgId === turnId ||
      meta?.missingHistoryUserMsgIds?.[turnId] === true)
  );
}

/**
 * Whether the conversation's latest finished turn ended in failure: the failed marker still
 * names the turn the machine handled last. Lets lists show a failed conversation from
 * metadata alone, without opening its history.
 */
export function hasFailedLatestTurn(
  meta: Pick<SessionMeta, 'lastFailedUserMsgId' | 'lastHandledUserMsgId'>
): boolean {
  return (
    typeof meta.lastFailedUserMsgId === 'string' &&
    meta.lastFailedUserMsgId.length > 0 &&
    meta.lastFailedUserMsgId === meta.lastHandledUserMsgId
  );
}

/**
 * Resolve the dispatch activation a machine still owes work for.
 *
 * The pointer pair alone is NOT the answer: the negative-ack ledger and terminal slot retire an
 * activation without rewriting the producer-owned pointers, so raw
 * `latestUserMsgId !== lastHandledUserMsgId` reports pending work forever once
 * either fires. `missingHistoryUserMsgIds` preserves every failed identity (including the legacy
 * `lastMissingHistoryUserMsgId` marker); `settledActivationUserMsgId` retires a turn
 * whose history entry is already terminal. Every consumer that asks "does this
 * session still owe a turn?" — dispatch, idle GC, MCP status —
 * must go through here, or they disagree with the watcher and hang.
 */
export function getPendingUserTurnActivationId(meta: SessionMeta): string | undefined {
  const settledUserTurnId = meta.settledActivationUserMsgId;
  if (
    typeof meta.processingUserMsgId === 'string' &&
    meta.processingUserMsgId.length > 0 &&
    !isMissingHistoryUserTurn(meta, meta.processingUserMsgId) &&
    meta.processingUserMsgId !== settledUserTurnId
  ) {
    return meta.processingUserMsgId;
  }
  if (
    typeof meta.latestUserMsgId === 'string' &&
    meta.latestUserMsgId.length > 0 &&
    meta.latestUserMsgId !== meta.lastHandledUserMsgId &&
    !isMissingHistoryUserTurn(meta, meta.latestUserMsgId) &&
    meta.latestUserMsgId !== settledUserTurnId
  ) {
    return meta.latestUserMsgId;
  }
  return Object.keys(meta.steerTurnStatuses ?? {}).find(
    (id) =>
      meta.steerTurnStatuses?.[id] === 'pending' &&
      !isMissingHistoryUserTurn(meta, id) &&
      id !== settledUserTurnId
  );
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

export type MessageQueueItem = Omit<InferType<typeof messageQueueItemSchema>, 'project'> & {
  project: ProjectRef | undefined;
};
export type MessageQueueItemInput = Omit<
  InferInputType<typeof messageQueueItemSchema>,
  'project' | 'acpSessionConfig' | 'paused'
> & {
  project: ProjectRef | undefined;
  paused?: boolean;
  acpSessionConfig?: import('./ai').ACPSessionConfig &
    Pick<import('./ai').SessionTurnInputConfig, '_lodyAutomation'>;
};

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
  /** Actual commands for this ACP session; an empty list clears the menu. */
  availableCommands?: AcpCommandSummary[];
};

export type SessionAcpRuntimeConfigPatch = Omit<
  SessionAcpRuntimeConfigSnapshot,
  'basedOnUserTurnId' | 'revision'
>;

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
  /**
   * IANA zone of the machine's clock, e.g. `Asia/Shanghai` (under 50 bytes,
   * rewritten only at registration). Schedules owned by this machine are
   * authored on this clock; absent on older CLIs.
   */
  timeZone?: string;
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
  'id' | 'createdAt' | 'chatId' | 'status' | 'isArchived' | 'isTabClosed' | 'diffStats'
> &
  SessionLaunchConfig & {
    sessionId?: SessionId;
  };
export type SessionToUpdate = Pick<Session, 'id' | 'status' | 'history'>;
export type SessionToDelete = Pick<Session, 'id'>;
export type SessionHistoryInput = SessionEntry;
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
