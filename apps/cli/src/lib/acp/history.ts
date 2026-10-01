import { v4 as uuidV4 } from 'uuid';
import { isLodySubagentEvent, isLodySubagentOutput } from 'acp-extension-core';

import type {
  AcpSessionNotification,
  MessageContent,
  PermissionOutcome,
  SessionHistoryInput,
  SessionId,
} from '@lody/shared';
import {
  getServerNow,
  sanitizeGoalObjective,
  truncateTerminalOutputForHistory,
  ToolCallContentSchema,
  parseHistoryWrite,
  HistoryWriteError,
  MessageContentSchema,
  parseLodyTaskMeta,
  parseDevinSubagentTaskMeta,
  getDevinSubagentContextId,
} from '@lody/shared';
import type { ModelInfo } from '@lody/shared';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { Logger } from '@/utils/logger';
import { captureMessage } from '@/instrument';
import type { SessionDocument } from '@/lib/loro/doc';
import type { SessionBackend } from '@/session/session-backend';
import type { SessionPlanEntry } from '@lody/shared';
import { deriveLocationsFromToolCallContent } from './tool-call-history';
import { buildMessageContentFromNotification } from './history-apply';

export type { ApplyNotificationOnHistoryOptions } from './history-apply';
export {
  applyMessageContentsBatch,
  applyNotificationOnHistory,
  buildMessageContentFromNotification,
} from './history-apply';

type ACPHistoryCallbacksBackend = Pick<
  SessionBackend,
  'readHistoryCount' | 'readHistoryDirectory' | 'readTurn' | 'applyAgentBatch' | 'setPlan'
>;

/**
 * Production SessionDocuments are always bound during initialization. Keep a
 * legacy fallback only for small data-only test fixtures that do not expose a
 * backend accessor; a real document must never silently write Loro history
 * after a backend selection failed or was omitted.
 */
const resolveBoundHistoryBackend = <T>(
  doc: SessionDocument,
  explicit?: T
): T | SessionBackend | undefined => {
  const accessor = (doc as unknown as { getSessionBackend?: () => SessionBackend })
    .getSessionBackend;
  const bound = explicit ?? accessor?.call(doc);
  if (!bound && typeof accessor === 'function') {
    throw new Error(`Session backend is not bound for ${doc.sessionId}`);
  }
  return bound;
};

// ---------------------------------------------------------------------------
// Cross-call enrichment state
// ---------------------------------------------------------------------------
//
// When notifications arrive one at a time (streamed mode), a completed update
// may arrive in a separate `handleACPUpdateMessage()` call from the in-progress
// updates that carried the refined title or tool parameters. We persist the
// collected state per SessionDocument via a WeakMap so it's GC'd automatically.

/** Per-toolCallId metadata collected from in-progress notifications. */
type ToolCallAccumulator = {
  /** Parsed JSON from the last complete in-progress content block. */
  parsedInput: Record<string, unknown>;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** Base title from the initial tool_call (e.g. "Shell", "ReadFile"). */
  baseTitle?: string;
  /** Last refined title from an in-progress tool_call_update (e.g. "Shell: echo hello"). */
  refinedTitle?: string;
  /** Tool kind derived from title heuristic. */
  kind?: EnrichmentToolKind;
  /**
   * Diff content blocks from in-progress updates, latest per path. Claude Code puts ALL edit
   * evidence (rawInput replacement pair, fragment diff, then a fuller whole-file diff) on
   * non-terminal updates and sends a bare `status: completed` — the terminal update alone
   * carries nothing to reconstruct from.
   */
  editDiffsByPath?: Map<string, { oldText?: string; newText: string; isCreate: boolean }>;
  /** Edit-tool `old_string`/`new_string` from an in-progress update's rawInput. */
  editReplacement?: { oldString: string; newString: string };
};

type EnrichmentState = Map<string, ToolCallAccumulator>;

type TerminalOutputAccumulator = {
  output: string;
  truncated: boolean;
  exitStatus?: { exitCode: number | null; signal: string | null };
};

type TerminalOutputState = Map<string, TerminalOutputAccumulator>;

const enrichmentStateByDoc = new WeakMap<SessionDocument, EnrichmentState>();
const subagentEnrichmentByDoc = new WeakMap<SessionDocument, Map<string, EnrichmentState>>();
const terminalOutputStateByDoc = new WeakMap<SessionDocument, TerminalOutputState>();

const getEnrichmentState = (doc: SessionDocument): EnrichmentState => {
  let state = enrichmentStateByDoc.get(doc);
  if (!state) {
    state = new Map();
    enrichmentStateByDoc.set(doc, state);
  }
  return state;
};

const getTerminalOutputState = (doc: SessionDocument): TerminalOutputState => {
  let state = terminalOutputStateByDoc.get(doc);
  if (!state) {
    state = new Map();
    terminalOutputStateByDoc.set(doc, state);
  }
  return state;
};

const cloneTerminalOutputState = (state: TerminalOutputState): TerminalOutputState =>
  new Map(
    [...state].map(([toolCallId, output]) => [
      toolCallId,
      {
        ...output,
        ...(output.exitStatus ? { exitStatus: { ...output.exitStatus } } : {}),
      },
    ])
  );

const restoreTerminalOutputState = (
  state: TerminalOutputState,
  snapshot: TerminalOutputState
): void => {
  state.clear();
  for (const [toolCallId, output] of snapshot) {
    state.set(toolCallId, output);
  }
};

const isRetryableEvidenceCallbackError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as {
    readonly retryable?: unknown;
    readonly options?: { readonly retryable?: unknown };
  };
  return candidate.retryable === true || candidate.options?.retryable === true;
};

/**
 * Applies ACP notifications to the session's persisted history (Loro CRDT).
 *
 * Important: The live UI should use notifications directly for streaming updates.
 * The persisted history is intentionally compacted/sanitized to avoid storing large
 * tool payloads (full file reads, repeated terminal snapshots).
 */
export const handleACPUpdateMessage = async (
  doc: SessionDocument,
  messages: AcpSessionNotification | AcpSessionNotification[],
  callbacks?: {
    /**
     * Returns the current turn ID for the session. A turn is a single message
     * in a conversation (user or assistant). See specs/data-model.md for details.
     */
    getCurrentSessionTurnId?: (sessionId: SessionId) => string | undefined;
    targetAssistantEntryId?: string;
    allowAutonomousAssistantEntry?: boolean;
    editCallback?: (
      edits: readonly AcpAgentEditEvidence[],
      assistantEntryId?: string
    ) => void | Promise<void>;
    standardDiffCallback?: (
      diffs: readonly AcpStandardDiffBlockEvidence[],
      assistantEntryId?: string
    ) => void | Promise<void>;
    /** Stable per-notification identities aligned with the input batch. */
    operationIds?: readonly string[];
    logger?: Logger;
    backend?: ACPHistoryCallbacksBackend;
  },
  model?: ModelInfo
) => {
  const batch = Array.isArray(messages) ? messages : [messages];
  const valid = filterInvalidNotifications(batch, callbacks?.logger, callbacks?.operationIds);
  const validBatch = valid.notifications;
  const rootEnrichedBatch = enrichNotificationBatch(validBatch, getEnrichmentState(doc));
  const childGroups = new Map<
    string,
    { state: EnrichmentState; batch: AcpSessionNotification[]; indices: number[] }
  >();
  let childStates = subagentEnrichmentByDoc.get(doc);
  if (!childStates) {
    childStates = new Map();
    subagentEnrichmentByDoc.set(doc, childStates);
  }
  for (const [index, message] of rootEnrichedBatch.entries()) {
    if (message.update.sessionUpdate !== 'subagent_event' || message.update.event.type !== 'output')
      continue;
    const event = message.update.event;
    const key = JSON.stringify([event.sessionId, event.runId]);
    let group = childGroups.get(key);
    if (!group) {
      const state = childStates.get(key) ?? new Map<string, ToolCallAccumulator>();
      childStates.set(key, state);
      group = { state, batch: [], indices: [] };
      childGroups.set(key, group);
    }
    group.batch.push({ sessionId: event.sessionId, update: event.update });
    group.indices.push(index);
  }
  const enrichedBatch = [...rootEnrichedBatch];
  for (const group of childGroups.values()) {
    group.batch = enrichNotificationBatch(group.batch, group.state);
    for (const [offset, child] of group.batch.entries()) {
      const index = group.indices[offset];
      if (index === undefined) continue;
      const original = enrichedBatch[index];
      if (
        original?.update.sessionUpdate !== 'subagent_event' ||
        original.update.event.type !== 'output' ||
        !isLodySubagentOutput(child.update)
      )
        continue;
      enrichedBatch[index] = {
        ...original,
        update: { ...original.update, event: { ...original.update.event, update: child.update } },
      };
    }
  }
  const terminalOutputState = getTerminalOutputState(doc);
  const terminalOutputSnapshot = cloneTerminalOutputState(terminalOutputState);
  const persistable = filterNotificationsForHistory(
    compactTerminalNotificationsForHistory(enrichedBatch, terminalOutputState),
    valid.operationIds
  );
  const persistableBatch = persistable.notifications;
  const latestPlan = extractLatestPlanSnapshot(validBatch);
  // Lazily get the turn ID only when actually needed to avoid errors on no-op batches.
  // Some notification batches (e.g., filtered session_info_update or tool_call_update)
  // may not produce any message content and don't need a turn ID.
  let cachedTurnId: string | undefined;
  const getTargetTurnId = (): string | undefined => {
    if (callbacks?.targetAssistantEntryId) {
      return callbacks.targetAssistantEntryId;
    }
    if (cachedTurnId === undefined && callbacks?.getCurrentSessionTurnId) {
      cachedTurnId = callbacks.getCurrentSessionTurnId(doc.sessionId);
    }
    return cachedTurnId;
  };

  try {
    const boundBackend = resolveBoundHistoryBackend(doc, callbacks?.backend);
    if (persistableBatch.length > 0) {
      const targetTurnId = getTargetTurnId();
      if (!targetTurnId && callbacks?.allowAutonomousAssistantEntry !== true) {
        callbacks?.logger?.warn(
          `[${doc.sessionId}] Dropping ${persistableBatch.length} ACP history notifications without an assistant entry target`
        );
      } else {
        // Tool/subagent updates can belong to older turns. Only text/thought
        // chunks have a target-local ownership contract; retain full routing otherwise.
        // Devin subagent-tagged chunks need the whole-history view too — the
        // applier can only drop them when it can see the owner task row, which
        // may live in an older entry.
        const targetOnly = Boolean(
          targetTurnId &&
          persistableBatch.every(
            ({ update }) =>
              (update.sessionUpdate === 'agent_message_chunk' ||
                update.sessionUpdate === 'agent_thought_chunk') &&
              update.content.type === 'text' &&
              getDevinSubagentContextId(update._meta) === null
          )
        );
        const createId = targetTurnId ? () => targetTurnId : uuidV4;
        await (boundBackend ?? doc.agentWrites).applyAgentBatch({
          notifications: persistableBatch,
          ...(persistable.operationIds ? { operationIds: persistable.operationIds } : {}),
          ...(targetTurnId ? { targetAssistantEntryId: targetTurnId } : {}),
          ...(targetOnly ? { entryBound: true } : {}),
          createId,
          ...(model ? { model } : {}),
        });
      }
    }
    // Evidence is derived from the same enriched notification, but it is only
    // safe to publish after the corresponding history write commits. Otherwise
    // a retried terminal notification records the same diff twice.
    const childEvidenceOwners = new Map<
      string,
      {
        entryId: string;
        toolCallIds: ReadonlySet<string>;
      }
    >();
    const evidenceRunKeys = new Set(
      [...childGroups]
        .filter(([, group]) =>
          group.batch.some(
            ({ update }) =>
              update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
          )
        )
        .map(([key]) => key)
    );
    if (evidenceRunKeys.size > 0 && (callbacks?.editCallback || callbacks?.standardDiffCallback)) {
      // Ownership comes from the committed run, not the turn that happened to flush it.
      const backend = boundBackend;
      const directory = backend
        ? await backend.readHistoryDirectory(0, await backend.readHistoryCount())
        : await doc.sessionData.history.readDirectory(0, await doc.sessionData.history.count());
      for (const row of directory) {
        if (!row.turnId || row.scalars?.role !== 'assistant') continue;
        const read = backend
          ? await backend.readTurn(row.turnId)
          : await doc.sessionData.history.readTurn(row.turnId);
        if (read.state !== 'ready') continue;
        for (const stored of read.turn.items ?? []) {
          if (
            !stored ||
            typeof stored !== 'object' ||
            !('type' in stored) ||
            stored.type !== 'subagent_task'
          )
            continue;
          const parsed = MessageContentSchema.safeParse(stored);
          if (!parsed.success || parsed.data.type !== 'subagent_task') continue;
          const item = parsed.data;
          if (!item.run) continue;
          const key = JSON.stringify([item.run.sessionId, item.taskId]);
          if (!evidenceRunKeys.has(key)) continue;
          childEvidenceOwners.set(key, {
            entryId: read.turn.id,
            toolCallIds: new Set(
              item.run.items
                .filter((content) => content.type === 'tool_call')
                .map((content) => content.toolCallId)
            ),
          });
          evidenceRunKeys.delete(key);
        }
        if (evidenceRunKeys.size === 0) break;
      }
    }
    if (callbacks?.editCallback) {
      await triggerEditCallbacksFromNotifications(
        enrichedBatch.filter((message) => !isSubagentPermissionMirror(message)),
        getEnrichmentState(doc),
        callbacks.editCallback
      );
      for (const [key, group] of childGroups) {
        const owner = childEvidenceOwners.get(key);
        if (!owner) continue;
        await triggerEditCallbacksFromNotifications(
          group.batch.filter((message) => hasPersistedSubagentTool(message, owner.toolCallIds)),
          group.state,
          (edits) => callbacks.editCallback?.(edits, owner.entryId)
        );
      }
    }
    if (callbacks?.standardDiffCallback) {
      await triggerStandardDiffCallbacksFromNotifications(
        enrichedBatch.filter((message) => !isSubagentPermissionMirror(message)),
        getEnrichmentState(doc),
        callbacks.standardDiffCallback
      );
      for (const [key, group] of childGroups) {
        const owner = childEvidenceOwners.get(key);
        if (!owner) continue;
        await triggerStandardDiffCallbacksFromNotifications(
          group.batch.filter((message) => hasPersistedSubagentTool(message, owner.toolCallIds)),
          group.state,
          (diffs) => callbacks.standardDiffCallback?.(diffs, owner.entryId)
        );
      }
    }
    for (const message of enrichedBatch) {
      if (message.update.sessionUpdate !== 'subagent_event') continue;
      const event = message.update.event;
      if (
        event.type === 'snapshot' &&
        ['completed', 'failed', 'cancelled'].includes(event.snapshot.state)
      ) {
        childStates.delete(JSON.stringify([event.sessionId, event.runId]));
      }
    }
  } catch (error) {
    // Terminal compaction consumes its cross-flush accumulator before the doc
    // write. Restore it when that write fails so retrying the original terminal
    // notification can still emit the accumulated output.
    restoreTerminalOutputState(terminalOutputState, terminalOutputSnapshot);
    throw error;
  }

  if (latestPlan) {
    if (callbacks?.backend) await callbacks.backend.setPlan(latestPlan);
    else await doc.setPlan(latestPlan);
  }
};

function hasPersistedSubagentTool(
  message: AcpSessionNotification,
  toolCallIds: ReadonlySet<string>
): boolean {
  const update = message.update;
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')
    return false;
  return toolCallIds.has(update.toolCallId);
}

function isSubagentPermissionMirror(message: AcpSessionNotification): boolean {
  const lody = message.update._meta?.lody;
  return !!lody && typeof lody === 'object' && 'subagentRunId' in lody;
}

type ACPHistoryAppendCallbacks = Omit<
  NonNullable<Parameters<typeof handleACPUpdateMessage>[2]>,
  'targetAssistantEntryId' | 'allowAutonomousAssistantEntry' | 'getCurrentSessionTurnId'
>;

export const appendACPNotificationsToAssistantEntry = async (
  doc: SessionDocument,
  messages: AcpSessionNotification | AcpSessionNotification[],
  assistantEntryId: string,
  callbacks?: ACPHistoryAppendCallbacks,
  model?: ModelInfo
) => {
  await handleACPUpdateMessage(
    doc,
    messages,
    {
      ...callbacks,
      targetAssistantEntryId: assistantEntryId,
    },
    model
  );
};

export const appendAutonomousACPNotifications = async (
  doc: SessionDocument,
  messages: AcpSessionNotification | AcpSessionNotification[],
  callbacks?: ACPHistoryAppendCallbacks,
  model?: ModelInfo
) => {
  await handleACPUpdateMessage(
    doc,
    messages,
    {
      ...callbacks,
      allowAutonomousAssistantEntry: true,
    },
    model
  );
};

const filterInvalidNotifications = (
  batch: AcpSessionNotification[],
  logger?: Logger,
  operationIds?: readonly string[]
): { notifications: AcpSessionNotification[]; operationIds?: string[] } => {
  if (operationIds && operationIds.length !== batch.length) {
    throw new Error('ACP notification operation IDs must match the input batch length');
  }
  const out: AcpSessionNotification[] = [];
  const outOperationIds: string[] = [];
  for (const [index, message] of batch.entries()) {
    const { update, sessionId } = message;
    let validation = validateNotificationForHistory(update);
    if (
      validation.ok &&
      (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
      update.content != null
    ) {
      try {
        // Validate before enrichment touches known block fields (e.g. text.trim).
        // Unknown provider variants remain JSON, rather than masquerading as known text.
        parseHistoryWrite(ToolCallContentSchema.array(), update.content);
      } catch (error) {
        if (!(error instanceof HistoryWriteError)) throw error;
        validation = {
          ok: false,
          reason: 'invalid_tool_content',
          details: { issues: error.issues },
        };
      }
    }
    if (validation.ok) {
      out.push(message);
      if (operationIds) outOperationIds.push(operationIds[index]!);
      continue;
    }

    const details = {
      sessionUpdate: update?.sessionUpdate ?? 'unknown',
      reason: validation.reason,
      ...validation.details,
    };
    const payload = JSON.stringify(details);
    const debug = logger?.debug ? logger.debug.bind(logger) : console.debug;
    debug(`[${sessionId}] Dropping invalid ACP notification: ${payload}`);
    void captureMessage('Invalid ACP notification dropped', {
      component: 'acp-history',
      level: 'warning',
      extra: {
        sessionId,
        ...details,
      },
    });
  }
  return {
    notifications: out,
    ...(operationIds ? { operationIds: outOperationIds } : {}),
  };
};

const validateNotificationForHistory = (
  update: AcpSessionNotification['update'] | undefined
): { ok: true } | { ok: false; reason: string; details?: Record<string, unknown> } => {
  if (!update || typeof update.sessionUpdate !== 'string') {
    return { ok: false, reason: 'missing_session_update' };
  }

  switch (update.sessionUpdate) {
    case 'subagent_event':
      return isLodySubagentEvent(update.event)
        ? { ok: true }
        : { ok: false, reason: 'invalid_subagent_event' };
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const content = update.content as { type?: unknown; text?: unknown } | undefined;
      if (!content || typeof content.type !== 'string') {
        return {
          ok: false,
          reason: 'unexpected_content_type',
          details: { contentType: content ? describeValue(content.type) : 'missing' },
        };
      }
      if (content.type !== 'text') {
        return { ok: true };
      }
      if (typeof content.text !== 'string') {
        return {
          ok: false,
          reason: 'invalid_text',
          details: { textType: describeValue(content.text) },
        };
      }
      return { ok: true };
    }
    case 'tool_call':
    case 'tool_call_update':
      if (typeof update.toolCallId !== 'string' || update.toolCallId.length === 0) {
        return {
          ok: false,
          reason: 'missing_tool_call_id',
          details: { toolCallIdType: describeValue(update.toolCallId) },
        };
      }
      return { ok: true };
    case 'plan':
      if (!Array.isArray(update.entries)) {
        return {
          ok: false,
          reason: 'invalid_plan_entries',
          details: { entriesType: describeValue(update.entries) },
        };
      }
      return { ok: true };
    case 'plan_update':
      if (!update.plan || typeof update.plan !== 'object') {
        return {
          ok: false,
          reason: 'invalid_plan_update',
          details: { planType: describeValue(update.plan) },
        };
      }
      return { ok: true };
    case 'plan_removed':
      if (typeof update.planId !== 'string' || update.planId.length === 0) {
        return {
          ok: false,
          reason: 'invalid_plan_id',
          details: { planIdType: describeValue(update.planId) },
        };
      }
      return { ok: true };
    case 'available_commands_update':
      if (!Array.isArray(update.availableCommands)) {
        return {
          ok: false,
          reason: 'invalid_available_commands',
          details: { commandsType: describeValue(update.availableCommands) },
        };
      }
      return { ok: true };
    case 'user_message_chunk':
    case 'config_option_update':
    case 'current_mode_update':
    case 'session_info_update':
    case 'usage_update':
      return { ok: true };
    default:
      return {
        ok: false,
        reason: 'unknown_session_update',
        details: { sessionUpdate: (update as { sessionUpdate?: unknown }).sessionUpdate },
      };
  }
};

const describeValue = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Title-to-kind heuristic for agents that don't send `kind`
// ---------------------------------------------------------------------------

/** Tool kind values used in enrichment — superset of ACP ToolKind to cover internal kinds. */
type EnrichmentToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'
  | 'bash'
  | 'computer'
  | 'write'
  | 'mcp';

const ENRICHMENT_TOOL_KINDS = new Set<EnrichmentToolKind>([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
  'bash',
  'computer',
  'write',
  'mcp',
]);

const TITLE_PREFIX_TO_KIND: ReadonlyArray<{ prefix: string; kind: EnrichmentToolKind }> = [
  { prefix: 'Shell', kind: 'execute' },
  { prefix: 'ReadFile', kind: 'read' },
  { prefix: 'StrReplaceFile', kind: 'edit' },
  { prefix: 'WriteFile', kind: 'write' },
  { prefix: 'SearchText', kind: 'search' },
  { prefix: 'ListDir', kind: 'search' },
];

const deriveKindFromTitle = (title: string): EnrichmentToolKind | undefined => {
  for (const { prefix, kind } of TITLE_PREFIX_TO_KIND) {
    if (title === prefix || title.startsWith(prefix + ':') || title.startsWith(prefix + ' ')) {
      return kind;
    }
  }
  return undefined;
};

const normalizeToolKind = (kind: unknown): EnrichmentToolKind | undefined =>
  typeof kind === 'string' && ENRICHMENT_TOOL_KINDS.has(kind as EnrichmentToolKind)
    ? (kind as EnrichmentToolKind)
    : undefined;

// ---------------------------------------------------------------------------
// Content block helpers
// ---------------------------------------------------------------------------

type AcpContentLike = ReadonlyArray<{ type: string; content?: { type: string; text?: string } }>;

/** Extract all non-empty text strings from ACP tool-call content blocks of type "content". */
const extractTextFromContentBlocks = (content: AcpContentLike): string[] => {
  const texts: string[] = [];
  for (const block of content) {
    if (block.type !== 'content') continue;
    if (block.content?.type !== 'text' || !block.content.text) continue;
    texts.push(block.content.text);
  }
  return texts;
};

/**
 * Try to parse a complete JSON object from the first text content block that looks like JSON.
 * Returns null for partial streaming chunks or non-JSON content.
 */
const tryParseJsonFromContentBlocks = (content: AcpContentLike): Record<string, unknown> | null => {
  for (const block of content) {
    if (block.type !== 'content') continue;
    if (block.content?.type !== 'text' || !block.content.text) continue;
    const text = block.content.text.trim();
    if (!text.startsWith('{') || !text.endsWith('}')) continue;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Notification enrichment (single pass — replaces the former
// `propagateToolCallState` + `enrichKimiToolData` two-pass pipeline)
// ---------------------------------------------------------------------------

/**
 * Enrich a batch of ACP notifications before history filtering.
 *
 * This single-pass enrichment handles two concerns:
 *
 * 1. **Title propagation** — Agents like Kimi refine the title during streaming
 *    (e.g. "Shell" → "Shell: cat hello.txt"). Retain that title for sparse
 *    completed/failed updates and for terminal-output projection.
 *
 * 2. **Missing field injection** — Agents that use ACP terminal RPCs (e.g. Kimi)
 *    don't set `kind`, `rawInput`, `rawOutput`, or `locations`. We derive them
 *    from title patterns and in-progress JSON content blocks.
 *
 * Uses a persistent `EnrichmentState` (keyed by SessionDocument) so streamed
 * notifications produce the same result as a single batch.
 */
const enrichNotificationBatch = (
  batch: AcpSessionNotification[],
  state: EnrichmentState
): AcpSessionNotification[] => {
  // Apply in wire order: looking ahead would mark running output completed
  // before the actual response, and lose sparse post-result hook updates.
  return batch.map((original) => {
    let message = original;
    let update = message.update;
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
      return message;
    }

    const id = update.toolCallId;
    const previous = state.get(id) ?? { parsedInput: {} };
    state.set(id, previous);
    if (update.status != null) previous.status = update.status;
    else if (previous.status) {
      update = { ...update, status: previous.status };
      message = { ...message, update };
    }
    const isTerminal = update.status === 'completed' || update.status === 'failed';

    // Derive kind and track titles from non-terminal notifications
    if ((update.title || update.kind) && !isTerminal) {
      let acc = state.get(id);
      if (!acc) {
        acc = { parsedInput: {} };
        state.set(id, acc);
      }

      const explicitKind = normalizeToolKind(update.kind);
      const titleKind = update.title ? deriveKindFromTitle(update.title) : undefined;
      if (explicitKind) {
        acc.kind = explicitKind;
      } else if (titleKind) {
        acc.kind = titleKind;
      }

      if (update.title) {
        if (update.sessionUpdate === 'tool_call') acc.baseTitle = update.title;
        else acc.refinedTitle = update.title;
      }
    }

    // A present list supersedes every earlier diff, including an explicit clear.
    if (Array.isArray(update.content)) state.get(id)?.editDiffsByPath?.clear();

    // Accumulate edit evidence from non-terminal updates (Claude Code's completed update is
    // bare; see ToolCallAccumulator.editDiffsByPath).
    if (!isTerminal) {
      const diffs = Array.isArray(update.content)
        ? update.content.filter((c): c is Extract<typeof c, { type: 'diff' }> => c.type === 'diff')
        : [];
      const rawInput = update.rawInput;
      const rawInputRecord =
        rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
          ? (rawInput as Record<string, unknown>)
          : undefined;
      const replacement =
        rawInputRecord !== undefined &&
        typeof rawInputRecord.old_string === 'string' &&
        typeof rawInputRecord.new_string === 'string'
          ? { oldString: rawInputRecord.old_string, newString: rawInputRecord.new_string }
          : undefined;
      if (diffs.length > 0 || replacement !== undefined) {
        let acc = state.get(id);
        if (!acc) {
          acc = { parsedInput: {} };
          state.set(id, acc);
        }
        if (replacement !== undefined) acc.editReplacement = replacement;
        for (const diff of diffs) {
          if (typeof diff.path !== 'string' || typeof diff.newText !== 'string') continue;
          acc.editDiffsByPath ??= new Map();
          acc.editDiffsByPath.set(diff.path, {
            ...(typeof diff.oldText === 'string' ? { oldText: diff.oldText } : {}),
            newText: diff.newText,
            isCreate: diff.oldText === null || diff.oldText === undefined,
          });
        }
      }
    }

    // Parse JSON from in-progress content (skip if agent already provides rawInput)
    if (
      update.sessionUpdate === 'tool_call_update' &&
      !isTerminal &&
      !(update.rawInput && typeof update.rawInput === 'object') &&
      Array.isArray(update.content)
    ) {
      const parsed = tryParseJsonFromContentBlocks(update.content);
      if (parsed) {
        let acc = state.get(id);
        if (!acc) {
          acc = { parsedInput: {} };
          state.set(id, acc);
        }
        acc.parsedInput = parsed;
      }
    }

    const acc = state.get(update.toolCallId);
    if (!acc) return message;

    const isCompletedOrFailed =
      update.sessionUpdate === 'tool_call_update' &&
      (update.status === 'completed' || update.status === 'failed');

    // Non-terminal updates: only inject kind (no rawInput/rawOutput — injecting
    // rawInput on the initial tool_call would create a lone terminal_command
    // without a matching terminal_output, producing a broken intermediate state).
    if (!isCompletedOrFailed) {
      if (acc.kind && !update.kind) {
        return { ...message, update: { ...update, kind: acc.kind } } as AcpSessionNotification;
      }
      return message;
    }

    // Completed/failed: inject title, kind, locations, rawInput, rawOutput as needed.
    const patches: {
      title?: typeof update.title;
      kind?: EnrichmentToolKind;
      locations?: typeof update.locations;
      rawInput?: typeof update.rawInput;
      rawOutput?: typeof update.rawOutput;
    } = {};

    // Title propagation: carry forward the refined title when the completed update
    // arrives without one, but only if it's a refinement of the base title.
    // Note: baseTitle is only set from the initial tool_call notification.
    // ACP guarantees tool_call arrives before any tool_call_update for the same
    // toolCallId, so baseTitle is always available when refinedTitle is.
    if (!update.title && acc.refinedTitle) {
      const base = acc.baseTitle ?? '';
      if (base && acc.refinedTitle.startsWith(base)) {
        patches.title = acc.refinedTitle;
      }
    }

    if (acc.kind && !update.kind) patches.kind = acc.kind;
    const effectiveKind = patches.kind ?? update.kind;

    // Locations from parsed path (when not already present or derivable from diff blocks)
    const parsedPath = acc.parsedInput.path;
    if (
      typeof parsedPath === 'string' &&
      parsedPath.length > 0 &&
      update.locations == null &&
      !deriveLocationsFromToolCallContent(update.content)
    ) {
      patches.locations = [{ path: parsedPath }];
    }

    // Shell tools: inject rawInput (command) and rawOutput (terminal result text)
    const isShellTool =
      effectiveKind === 'execute' ||
      (!effectiveKind && typeof acc.parsedInput.command === 'string');

    if (isShellTool) {
      if (
        typeof acc.parsedInput.command === 'string' &&
        acc.parsedInput.command.length > 0 &&
        !(update.rawInput && typeof update.rawInput === 'object')
      ) {
        const rawInput: Record<string, unknown> = { command: acc.parsedInput.command };
        if (typeof acc.parsedInput.cwd === 'string') rawInput.cwd = acc.parsedInput.cwd;
        patches.rawInput = rawInput;
      }

      if (update.rawOutput === undefined && Array.isArray(update.content)) {
        const texts = extractTextFromContentBlocks(update.content);
        if (texts.length > 0) patches.rawOutput = texts.join('\n');
      }
    }

    if (Object.keys(patches).length === 0) return message;
    return { ...message, update: { ...update, ...patches } } as AcpSessionNotification;
  });
};

const appendTerminalTail = (current: string, incoming: string): string => {
  if (!current) return truncateTerminalOutputForHistory(incoming).output;
  if (incoming.startsWith(current)) return truncateTerminalOutputForHistory(incoming).output;
  if (current.endsWith(incoming)) return current;
  return truncateTerminalOutputForHistory(`${current}\n${incoming}`).output;
};

const terminalOutputFromNotification = (
  message: AcpSessionNotification
): TerminalOutputAccumulator | undefined => {
  const toolCall = buildMessageContentFromNotification(message).find(
    (content): content is Extract<MessageContent, { type: 'tool_call' }> =>
      content.type === 'tool_call'
  );
  const output = toolCall?.content?.find((content) => content.type === 'terminal_output') as
    | Extract<
        NonNullable<Extract<MessageContent, { type: 'tool_call' }>['content']>[number],
        {
          type: 'terminal_output';
        }
      >
    | undefined;
  if (!output) return undefined;
  return {
    output: output.output,
    truncated: output.truncated === true,
    exitStatus: output.exitStatus
      ? {
          exitCode: output.exitStatus.exitCode ?? null,
          signal: output.exitStatus.signal ?? null,
        }
      : undefined,
  };
};

const withoutTerminalSources = (message: AcpSessionNotification): AcpSessionNotification => {
  if (message.update.sessionUpdate !== 'tool_call_update') return message;
  const update = message.update;
  const meta = (update as Record<string, unknown>)._meta;
  const claudeCode =
    meta && typeof meta === 'object' && !Array.isArray(meta)
      ? (meta as Record<string, unknown>).claudeCode
      : undefined;
  const nextMeta =
    claudeCode && typeof claudeCode === 'object' && !Array.isArray(claudeCode)
      ? {
          ...(meta as Record<string, unknown>),
          claudeCode: { ...(claudeCode as Record<string, unknown>), toolResponse: undefined },
        }
      : meta;

  return {
    ...message,
    update: {
      ...update,
      rawOutput: undefined,
      // A provider may put the same terminal snapshot in a fenced `content`
      // block. Keep only structured diffs here; the command is derived from
      // rawInput/enrichment and the output is materialized on completion.
      content: update.content?.filter((content) => content.type === 'diff'),
      ...(nextMeta === undefined ? {} : { _meta: nextMeta }),
    },
  } as AcpSessionNotification;
};

/**
 * ACP adapters frequently report terminal snapshots while a tool is running.
 * Keep their bounded tails in CLI memory and emit exactly one terminal block
 * when that tool reaches a durable terminal status.
 */
const compactTerminalNotificationsForHistory = (
  batch: AcpSessionNotification[],
  state: TerminalOutputState
): AcpSessionNotification[] =>
  batch.map((message) => {
    if (message.update.sessionUpdate !== 'tool_call_update') return message;

    const { toolCallId, status } = message.update;
    const extracted = terminalOutputFromNotification(message);
    if (extracted) {
      const previous = state.get(toolCallId);
      state.set(toolCallId, {
        output: appendTerminalTail(previous?.output ?? '', extracted.output),
        truncated: previous?.truncated === true || extracted.truncated,
        exitStatus: extracted.exitStatus ?? previous?.exitStatus,
      });
    }

    const isTerminalStatus = status === 'completed' || status === 'failed';
    if (!isTerminalStatus) {
      return extracted ? withoutTerminalSources(message) : message;
    }

    const terminal = state.get(toolCallId);
    state.delete(toolCallId);
    if (!terminal) return message;

    const stripped = withoutTerminalSources(message);
    if (stripped.update.sessionUpdate !== 'tool_call_update') return stripped;
    return {
      ...stripped,
      update: {
        ...stripped.update,
        content: [
          ...(stripped.update.content ?? []),
          {
            type: 'terminal_output',
            output: terminal.output,
            stream: 'combined',
            truncated: terminal.truncated,
            exitStatus: terminal.exitStatus,
          },
        ],
      },
    } as AcpSessionNotification;
  });

const filterNotificationsForHistory = (
  batch: AcpSessionNotification[],
  operationIds?: readonly string[]
): { notifications: AcpSessionNotification[]; operationIds?: string[] } => {
  const shouldKeep = (message: AcpSessionNotification): boolean => {
    const update = message.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
        return update.content.type === 'text';
      case 'user_message_chunk':
      case 'config_option_update':
      case 'plan':
      case 'available_commands_update':
      case 'current_mode_update':
      case 'usage_update':
        // These updates do not produce MessageContent history items.
        return false;
      case 'plan_update':
        // Checklist plans use the same per-turn plan field as legacy `plan`.
        // Markdown/file plans remain history content and continue below.
        return update.plan.type !== 'items';
      case 'session_info_update':
        return (
          update._meta?.lody !== null &&
          typeof update._meta?.lody === 'object' &&
          typeof (update._meta.lody as Record<string, unknown>).turnId === 'string'
        );
    }
    if (update.sessionUpdate !== 'tool_call_update') return true;
    // Task snapshots are small lifecycle facts, not replaceable tool output.
    // The history applier merges them by taskId for both live and resumed views.
    if (parseLodyTaskMeta(update._meta) ?? parseDevinSubagentTaskMeta(update._meta)) return true;
    // Terminal payloads have already been compacted. Other tool fields are
    // independent patches: a title/list-only update may be their only delivery.
    if (
      ['status', 'title', 'kind', 'content', 'locations', 'rawInput', 'rawOutput'].some(
        (field) => (update as Record<string, unknown>)[field] != null
      )
    )
      return true;

    // Claude Code sends toolResponse in updates with status=null. Keep these updates
    // so we can extract terminal output from _meta.claudeCode.toolResponse.
    const meta = (update as Record<string, unknown>)._meta;
    if (meta && typeof meta === 'object') {
      const claudeCode = (meta as Record<string, unknown>).claudeCode;
      if (claudeCode && typeof claudeCode === 'object') {
        if ((claudeCode as Record<string, unknown>).toolResponse) {
          return true;
        }
      }
    }

    return false;
  };

  const notifications: AcpSessionNotification[] = [];
  const filteredOperationIds: string[] = [];
  for (const [index, message] of batch.entries()) {
    if (!shouldKeep(message)) continue;
    notifications.push(message);
    if (operationIds) filteredOperationIds.push(operationIds[index]!);
  }
  return {
    notifications,
    ...(operationIds ? { operationIds: filteredOperationIds } : {}),
  };
};

/**
 * Evidence of one agent file edit extracted from a completed edit tool call. Per-turn diff
 * capture reconstructs full old/new text from it (specs/code-collab.md "ACP 可见编辑").
 *
 * `unifiedDiff` comes from Codex apply_patch payloads (`rawOutput.changes`) and supports exact
 * reconstruction. `fullNewText` is only set when the payload proves the complete new text
 * (an ACP diff content block with `oldText: null` — a created file). `contentOldText`/
 * `contentNewText` carry the raw diff content block texts and `oldString`/`newString` the
 * Edit-tool replacement pair from `rawInput`; both MAY be fragments, so the capture side must
 * verify them against the on-disk post-edit text before trusting them as file content —
 * treating fragments as full text is how truncated bases corrupted per-turn diffs before
 * this evidence shape.
 */
export type AcpAgentEditEvidence = {
  readonly path: string;
  readonly changeType: 'update' | 'add' | 'delete';
  readonly unifiedDiff?: string;
  readonly movePath?: string;
  readonly fullNewText?: string;
  readonly contentOldText?: string;
  readonly contentNewText?: string;
  readonly oldString?: string;
  readonly newString?: string;
};

export type AcpStandardDiffBlockEvidence = {
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string;
};

const RAW_CHANGE_TYPES = new Set(['update', 'add', 'delete']);

function editEvidenceFromRawChanges(rawValue: unknown): Map<string, AcpAgentEditEvidence> {
  const evidence = new Map<string, AcpAgentEditEvidence>();
  if (typeof rawValue !== 'object' || rawValue === null) return evidence;
  const changes = (rawValue as { readonly changes?: unknown }).changes;
  if (typeof changes !== 'object' || changes === null) return evidence;
  for (const [path, change] of Object.entries(changes)) {
    if (!path || typeof change !== 'object' || change === null) continue;
    const record = change as Record<string, unknown>;
    const rawType = typeof record.type === 'string' ? record.type : 'update';
    const changeType = (RAW_CHANGE_TYPES.has(rawType) ? rawType : 'update') as
      | 'update'
      | 'add'
      | 'delete';
    const unifiedDiff = typeof record.unified_diff === 'string' ? record.unified_diff : undefined;
    const movePath =
      typeof record.move_path === 'string' && record.move_path.length > 0
        ? record.move_path
        : undefined;
    evidence.set(path, {
      path,
      changeType,
      ...(unifiedDiff === undefined ? {} : { unifiedDiff }),
      ...(movePath === undefined ? {} : { movePath }),
    });
  }
  return evidence;
}

const triggerEditCallbacksFromNotifications = async (
  batch: AcpSessionNotification[],
  state: EnrichmentState,
  editCallback: (edits: readonly AcpAgentEditEvidence[]) => void | Promise<void>
): Promise<void> => {
  for (const message of batch) {
    const update = message.update;
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')
      continue;
    if (update.status !== 'completed') continue;

    const acc = state.get(update.toolCallId);
    // Read from the enriched notification batch (not from persisted history), because history
    const contents = update.content ?? [];
    // ACP marks `kind` as optional on tool updates. Codex can send terminal updates with diff
    // content but no kind, and accumulator state is best-effort across flush/doc lifetimes.
    // A completed diff payload is already file-edit evidence, so accept it as the fallback.
    const hasDiffContent =
      contents.some((content) => content.type === 'diff') || (acc?.editDiffsByPath?.size ?? 0) > 0;
    // Codex apply_patch reports its change map on the completed update's rawOutput (rawInput on
    // the begin notification); it is the only payload carrying full unified diffs.
    const evidenceByPath = editEvidenceFromRawChanges(
      (update as { readonly rawOutput?: unknown }).rawOutput ??
        (update as { readonly rawInput?: unknown }).rawInput
    );
    if (update.kind !== 'edit' && !hasDiffContent && evidenceByPath.size === 0) continue;

    // Edit-tool replacement pair: a fragment-level old/new string the capture side can verify
    // against disk to reconstruct the full pre-image. Kimi puts it on the completed update's
    // rawInput; Claude Code only on an in-progress update (accumulator fallback).
    const rawInput = (update as { readonly rawInput?: unknown }).rawInput;
    const rawInputRecord =
      rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)
        : undefined;
    const replacement =
      rawInputRecord !== undefined &&
      typeof rawInputRecord.old_string === 'string' &&
      typeof rawInputRecord.new_string === 'string'
        ? { oldString: rawInputRecord.old_string, newString: rawInputRecord.new_string }
        : acc?.editReplacement;

    // Only omission reuses the earlier list; an explicit list replaces it wholly.
    const diffBlocks = new Map<string, { oldText?: string; newText: string; isCreate: boolean }>(
      update.content == null ? (acc?.editDiffsByPath ?? []) : []
    );
    for (const content of contents) {
      if (content.type !== 'diff') continue;
      // The ACP content schema defines these fields, but the overall `content` array is still
      // unstructured by spec; keep this defensive.
      if (typeof content.path !== 'string' || typeof content.newText !== 'string') continue;
      diffBlocks.set(content.path, {
        ...(typeof content.oldText === 'string' ? { oldText: content.oldText } : {}),
        newText: content.newText,
        isCreate: content.oldText === null || content.oldText === undefined,
      });
    }

    for (const [path, { oldText, newText, isCreate }] of diffBlocks) {
      const existing = evidenceByPath.get(path);
      if (existing) {
        // unified_diff evidence wins; a created-file content block can still contribute the
        // proven full new text.
        if (isCreate && existing.fullNewText === undefined) {
          evidenceByPath.set(path, { ...existing, fullNewText: newText });
        }
        continue;
      }
      evidenceByPath.set(path, {
        path,
        changeType: isCreate ? 'add' : 'update',
        ...(isCreate ? { fullNewText: newText } : {}),
        ...(oldText === undefined ? {} : { contentOldText: oldText }),
        ...(isCreate ? {} : { contentNewText: newText }),
        ...(replacement === undefined ? {} : replacement),
      });
    }

    if (evidenceByPath.size === 0) continue;
    try {
      await editCallback([...evidenceByPath.values()]);
    } catch (error) {
      if (isRetryableEvidenceCallbackError(error)) {
        throw error;
      }
      // Best-effort hook; don't break session processing if the callback fails.
    }
  }
};

const triggerStandardDiffCallbacksFromNotifications = async (
  batch: AcpSessionNotification[],
  state: EnrichmentState,
  diffCallback: (diffs: readonly AcpStandardDiffBlockEvidence[]) => void | Promise<void>
): Promise<void> => {
  for (const message of batch) {
    const update = message.update;
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
      continue;
    }
    const contents = update.content ?? [];
    const hasDiffContent = contents.some((content) => content.type === 'diff');
    const includeAccumulatedDiffs = update.status === 'completed';
    if (!includeAccumulatedDiffs && !hasDiffContent) {
      continue;
    }

    const acc = state.get(update.toolCallId);
    const diffBlocks = new Map<string, AcpStandardDiffBlockEvidence>();
    if (includeAccumulatedDiffs) {
      for (const [path, diff] of acc?.editDiffsByPath ?? []) {
        if (diff.oldText === undefined && !diff.isCreate) {
          continue;
        }
        diffBlocks.set(path, {
          path,
          oldText: diff.isCreate ? null : (diff.oldText ?? null),
          newText: diff.newText,
        });
      }
    }

    for (const content of contents) {
      if (content.type !== 'diff') {
        continue;
      }
      if (typeof content.path !== 'string' || typeof content.newText !== 'string') {
        continue;
      }
      if (content.oldText !== null && typeof content.oldText !== 'string') {
        continue;
      }
      diffBlocks.set(content.path, {
        path: content.path,
        oldText: content.oldText,
        newText: content.newText,
      });
    }

    if (diffBlocks.size === 0) {
      continue;
    }
    try {
      await diffCallback([...diffBlocks.values()]);
    } catch (error) {
      if (isRetryableEvidenceCallbackError(error)) {
        throw error;
      }
      // Best-effort hook; don't break session processing if the callback fails.
    }
  }
};

const extractLatestPlanSnapshot = (batch: AcpSessionNotification[]): SessionPlanEntry[] | null => {
  for (let i = batch.length - 1; i >= 0; i -= 1) {
    const update = batch[i]?.update;
    if (getDevinSubagentContextId(update?._meta) !== null) continue;
    const entries =
      update?.sessionUpdate === 'plan'
        ? update.entries
        : update?.sessionUpdate === 'plan_update' && update.plan.type === 'items'
          ? update.plan.entries
          : null;
    if (entries) {
      return entries.map((entry) => ({
        status: entry.status,
        content: entry.content,
        priority: entry.priority,
      }));
    }
  }
  return null;
};
type GoalMessageContent = Extract<MessageContent, { type: 'goal' }>;

const readEntryItems = (entry: SessionHistoryInput): MessageContent[] => {
  const rawItems = entry.items;
  return Array.isArray(rawItems) ? (rawItems as unknown as MessageContent[]) : [];
};

const createAssistantHistoryEntry = (id: string): SessionHistoryInput => ({
  id,
  role: 'assistant',
  items: [] as unknown as SessionHistoryInput['items'],
  timestamp: new Date(getServerNow()).toISOString(),
  read: undefined,
  userId: undefined,
  fileDiff: [],
});

export type ThreadGoalHistoryOptions = {
  targetEntryId?: string;
  createId?: () => string;
  backend?: Pick<SessionBackend, 'applyHistoryAction'>;
};

export const upsertThreadGoalInHistory = async (
  doc: SessionDocument,
  goal: GoalMessageContent,
  options: ThreadGoalHistoryOptions = {}
): Promise<void> => {
  const sanitizedGoal: GoalMessageContent = {
    ...goal,
    objective: sanitizeGoalObjective(goal.objective),
  };

  const action = {
    kind: 'upsert-goal' as const,
    goal: sanitizedGoal,
    targetTurnId: options.targetEntryId,
    fallback: createAssistantHistoryEntry(
      options.targetEntryId ?? options.createId?.() ?? uuidV4()
    ),
  };
  const backend = resolveBoundHistoryBackend(doc, options.backend);
  if (backend) {
    await backend.applyHistoryAction(action);
  } else {
    await doc.sessionData.commands.applyHistoryAction(action);
  }
};

export const clearThreadGoalFromHistory = async (
  doc: SessionDocument,
  threadId: string,
  options: { backend?: Pick<SessionBackend, 'applyHistoryAction'> } = {}
): Promise<void> => {
  // Mark the goal as cleared in-place so the snapshot remains visible until a new
  // goal arrives. The previous behavior removed the entry entirely, which made
  // the cleared state invisible to the user the moment they pressed clear.
  const action = {
    kind: 'clear-goal' as const,
    threadId,
    updatedAt: getServerNow(),
  };
  const backend = resolveBoundHistoryBackend(doc, options.backend);
  if (backend) {
    await backend.applyHistoryAction(action);
  } else {
    await doc.sessionData.commands.applyHistoryAction(action);
  }
};

export const ensurePermissionRequestOnToolCall = async (
  doc: SessionDocument,
  requestId: string,
  request: RequestPermissionRequest,
  _model?: ModelInfo,
  backend?: Pick<SessionBackend, 'applyHistoryAction'>
): Promise<boolean> => {
  const action = {
    kind: 'permission-request',
    requestId,
    request,
  } as const;
  const boundBackend = resolveBoundHistoryBackend(doc, backend);
  const result = boundBackend
    ? await boundBackend.applyHistoryAction(action)
    : await doc.sessionData.commands.applyHistoryAction(action);
  return result.matched ?? false;
};

export const updatePermissionOutcomeInHistory = async (
  doc: SessionDocument,
  requestId: string,
  outcome: RequestPermissionResponse['outcome'],
  logger: Logger,
  backend?: Pick<SessionBackend, 'respondPermission'>
): Promise<boolean> => {
  // Domain command instead of a whole-history callback: the adapter locates the
  // matching tool call by request id and writes only that turn's outcome.
  const boundBackend = resolveBoundHistoryBackend(doc, backend);
  const result = boundBackend
    ? await boundBackend.respondPermission(requestId, outcome as PermissionOutcome)
    : await doc.sessionData.commands.respondPermission(requestId, outcome as PermissionOutcome);
  if (!result)
    logger.debug(`Permission outcome for ${requestId} not applied: not_found_or_already_set`);
  return result;
};

/**
 * Finds the permission outcome for a given requestId in the session history.
 * Returns undefined if no outcome is found yet.
 */
export const findPermissionOutcomeInHistory = (
  history: SessionHistoryInput[],
  requestId: string
): RequestPermissionResponse['outcome'] | undefined => {
  for (const entry of history) {
    for (const item of readEntryItems(entry)) {
      if (item.type === 'tool_call' && item.permissionRequest?.requestId === requestId) {
        return item.permissionRequest.outcome;
      }
    }
  }
  return undefined;
};
