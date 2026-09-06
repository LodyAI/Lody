import { v4 as uuidV4 } from 'uuid';

import type {
  AcpSessionNotification,
  MessageContent,
  SessionHistoryInput,
  SessionId,
} from '@lody/shared';
import {
  getServerNow,
  parseLodyTaskMeta,
  sanitizeGoalObjective,
  truncateTerminalOutputForHistory,
} from '@lody/shared';
import type { ModelInfo } from '@lody/shared';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { Logger } from '@/utils/logger';
import { captureMessage } from '@/instrument';
import type { SessionDocument } from '@/lib/loro/doc';
import type { SessionPlanEntry } from '@lody/shared';
import { applyNotificationOnHistory } from './history-apply';
import {
  deriveLocationsFromToolCallContent,
  stripToolCallContentForHistory,
} from './tool-call-history';
import { buildMessageContentFromNotification } from './history-apply';

export type { ApplyNotificationOnHistoryOptions } from './history-apply';
export {
  applyMessageContentsBatch,
  applyNotificationOnHistory,
  buildMessageContentFromNotification,
} from './history-apply';

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
    editCallback?: (edits: readonly AcpAgentEditEvidence[]) => void | Promise<void>;
    standardDiffCallback?: (diffs: readonly AcpStandardDiffBlockEvidence[]) => void | Promise<void>;
    logger?: Logger;
  },
  model?: ModelInfo
) => {
  const batch = Array.isArray(messages) ? messages : [messages];
  const validBatch = filterInvalidNotifications(batch, callbacks?.logger);
  const enrichedBatch = enrichNotificationBatch(validBatch, getEnrichmentState(doc));
  const terminalOutputState = getTerminalOutputState(doc);
  const terminalOutputSnapshot = cloneTerminalOutputState(terminalOutputState);
  const persistableBatch = filterNotificationsForHistory(
    compactTerminalNotificationsForHistory(enrichedBatch, terminalOutputState)
  );
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
    if (persistableBatch.length > 0) {
      await doc.updateHistory((history) => {
        const targetTurnId = getTargetTurnId();
        if (!targetTurnId && callbacks?.allowAutonomousAssistantEntry !== true) {
          callbacks?.logger?.warn(
            `[${doc.sessionId}] Dropping ${persistableBatch.length} ACP history notifications without an assistant entry target`
          );
          return history;
        }
        const createId = targetTurnId ? () => targetTurnId : uuidV4;
        return applyNotificationOnHistory(history, persistableBatch, model, {
          createId,
          ...(targetTurnId ? { targetAssistantEntryId: targetTurnId } : {}),
        });
      });
    }
    // Evidence is derived from the same enriched notification, but it is only
    // safe to publish after the corresponding history write commits. Otherwise
    // a retried terminal notification records the same diff twice.
    if (callbacks?.editCallback) {
      await triggerEditCallbacksFromNotifications(
        enrichedBatch,
        getEnrichmentState(doc),
        callbacks.editCallback
      );
    }
    if (callbacks?.standardDiffCallback) {
      await triggerStandardDiffCallbacksFromNotifications(
        enrichedBatch,
        getEnrichmentState(doc),
        callbacks.standardDiffCallback
      );
    }
  } catch (error) {
    // Terminal compaction consumes its cross-flush accumulator before the doc
    // write. Restore it when that write fails so retrying the original terminal
    // notification can still emit the accumulated output.
    restoreTerminalOutputState(terminalOutputState, terminalOutputSnapshot);
    throw error;
  }

  if (latestPlan) {
    await doc.setPlan(latestPlan);
  }
};

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
  logger?: Logger
): AcpSessionNotification[] => {
  const out: AcpSessionNotification[] = [];
  for (const message of batch) {
    const { update, sessionId } = message;
    const validation = validateNotificationForHistory(update);
    if (validation.ok) {
      out.push(message);
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
  return out;
};

const validateNotificationForHistory = (
  update: AcpSessionNotification['update'] | undefined
): { ok: true } | { ok: false; reason: string; details?: Record<string, unknown> } => {
  if (!update || typeof update.sessionUpdate !== 'string') {
    return { ok: false, reason: 'missing_session_update' };
  }

  switch (update.sessionUpdate) {
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
 *    (e.g. "Shell" → "Shell: cat hello.txt"). In-progress updates that carry the
 *    refined title are later filtered out, so we propagate the best title to the
 *    completed/failed update.
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
  // --- Collect phase: scan all notifications and accumulate per-toolCallId state ---
  for (const { update } of batch) {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
      continue;
    }

    const id = update.toolCallId;
    const isTerminal = update.status === 'completed' || update.status === 'failed';

    // Derive kind and track titles from non-terminal notifications
    if (update.title && !isTerminal) {
      let acc = state.get(id);
      if (!acc) {
        acc = { parsedInput: {} };
        state.set(id, acc);
      }

      const explicitKind = normalizeToolKind(update.kind);
      const titleKind = deriveKindFromTitle(update.title);
      if (explicitKind) {
        acc.kind = explicitKind;
      } else if (titleKind) {
        acc.kind = titleKind;
      }

      if (update.sessionUpdate === 'tool_call') {
        acc.baseTitle = update.title;
      } else {
        acc.refinedTitle = update.title;
      }
    }

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
  }

  if (state.size === 0) return batch;

  // --- Apply phase: patch notifications using accumulated state ---
  return batch.map((message) => {
    const { update } = message;
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
      return message;
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
      !(Array.isArray(update.locations) && update.locations.length > 0) &&
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
  batch: AcpSessionNotification[]
): AcpSessionNotification[] => {
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
    // Tool call updates are often "full snapshots" (especially terminal output). Persisting all
    // intermediate snapshots causes the CRDT history to blow up. We keep terminal state
    // transitions, plus the non-terminal updates the applier extracts something durable
    // from — the clauses below.
    if (update.status === 'completed' || update.status === 'failed') return true;

    // Claude Code sends rawInput in a tool_call_update (~14% of Bash calls, ~50% of Read/Grep,
    // and ALL Edit calls). Keep these updates so we can extract terminal commands, diff blocks,
    // and locations from them.
    const rawInput = update.rawInput;
    if (rawInput && typeof rawInput === 'object' && Object.keys(rawInput as object).length > 0) {
      return true;
    }

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

    // `lastToolName` rides only on task progress, so dropping non-terminal task snapshots
    // left the panel unable to show the running tool. Reusing the applier's own parser
    // makes the predicate exact — kept iff it will materialize a `subagent_task` item —
    // and the cost stays bounded because `upsertSubagentTask` merges by `taskId` into one
    // item, so a kept tick is a few small `LoroMap.set` ops rather than a new snapshot.
    if (parseLodyTaskMeta(meta) !== null) return true;

    return false;
  };

  return batch.filter(shouldKeep);
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

    // Diff blocks on the completed update win; accumulated in-progress blocks fill the gaps
    // (Claude Code's terminal update carries no content at all).
    const diffBlocks = new Map<string, { oldText?: string; newText: string; isCreate: boolean }>(
      acc?.editDiffsByPath ?? []
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

// ---------------------------------------------------------------------------
// Loro history entry helpers (bridge the CRDT item type to MessageContent[])
// ---------------------------------------------------------------------------

type ToolCallMessageContent = Extract<MessageContent, { type: 'tool_call' }>;
type GoalMessageContent = Extract<MessageContent, { type: 'goal' }>;

const readEntryItems = (entry: SessionHistoryInput): MessageContent[] => {
  const rawItems = entry.items;
  return Array.isArray(rawItems) ? (rawItems as unknown as MessageContent[]) : [];
};

const writeEntryItems = (entry: SessionHistoryInput, items: MessageContent[]) => {
  entry.items = items as unknown as SessionHistoryInput['items'];
};

const isUnfinishedAssistantEntry = (entry: SessionHistoryInput | undefined): boolean =>
  entry?.role === 'assistant' && entry.finished !== true && typeof entry.endedAt !== 'number';

const createAssistantHistoryEntry = (id: string): SessionHistoryInput => ({
  id,
  role: 'assistant',
  items: [] as unknown as SessionHistoryInput['items'],
  timestamp: new Date(getServerNow()).toISOString(),
  read: undefined,
  userId: undefined,
  fileDiff: [],
});

const findLatestUnfinishedAssistantEntry = (
  history: SessionHistoryInput[]
): SessionHistoryInput | undefined => {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (isUnfinishedAssistantEntry(entry)) {
      return entry;
    }
  }
  return undefined;
};

export type ThreadGoalHistoryOptions = {
  targetEntryId?: string;
  createId?: () => string;
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

  await doc.updateHistory((history) => {
    // Single sweep: replace an existing snapshot for this thread in place, and
    // drop any prior `cleared` snapshots for OTHER threads so only the most
    // recent goal stays visible in the banner.
    let replaced = false;
    for (const entry of history) {
      const items = readEntryItems(entry);
      let touched = false;
      const nextItems: MessageContent[] = [];
      for (const item of items) {
        if (item.type === 'goal' && item.threadId === sanitizedGoal.threadId) {
          nextItems.push(sanitizedGoal);
          replaced = true;
          touched = true;
          continue;
        }
        if (item.type === 'goal' && item.status === 'cleared') {
          touched = true;
          continue;
        }
        nextItems.push(item);
      }
      if (touched) {
        writeEntryItems(entry, nextItems);
      }
    }

    if (replaced) {
      return history;
    }

    let targetEntry =
      options.targetEntryId !== undefined
        ? history.find((entry) => entry.id === options.targetEntryId && entry.role === 'assistant')
        : undefined;

    if (!targetEntry) {
      targetEntry = findLatestUnfinishedAssistantEntry(history);
    }

    if (!targetEntry) {
      targetEntry = createAssistantHistoryEntry(
        options.targetEntryId ?? options.createId?.() ?? uuidV4()
      );
      history.push(targetEntry);
    }

    writeEntryItems(targetEntry, [...readEntryItems(targetEntry), sanitizedGoal]);
    return history;
  });
};

export const clearThreadGoalFromHistory = async (
  doc: SessionDocument,
  threadId: string
): Promise<void> => {
  // Mark the goal as cleared in-place so the snapshot remains visible until a new
  // goal arrives. The previous behavior removed the entry entirely, which made
  // the cleared state invisible to the user the moment they pressed clear.
  await doc.updateHistory((history) => {
    for (const entry of history) {
      const items = readEntryItems(entry);
      let touched = false;
      const nextItems = items.map((item) => {
        if (item.type !== 'goal' || item.threadId !== threadId) return item;
        if (item.status === 'cleared') return item;
        touched = true;
        return { ...item, status: 'cleared' as const, updatedAt: getServerNow() };
      });
      if (touched) {
        writeEntryItems(entry, nextItems);
      }
    }
    return history;
  });
};

const sanitizeToolCallContentForHistory = (
  content: ToolCallMessageContent['content'] | undefined,
  kind: ToolCallMessageContent['kind'] | undefined
): ToolCallMessageContent['content'] | undefined => {
  if (!content) return undefined;
  const filtered = stripToolCallContentForHistory(kind ?? null, content);
  return filtered.length ? filtered : undefined;
};

export const ensurePermissionRequestOnToolCall = async (
  doc: SessionDocument,
  requestId: string,
  request: RequestPermissionRequest,
  _model?: ModelInfo
): Promise<boolean> => {
  const toolCallId = request.toolCall.toolCallId;
  let persisted = false;
  await doc.updateHistory((history) => {
    let updated = false;
    history.forEach((entry) => {
      const parsed = readEntryItems(entry);
      let entryUpdated = false;
      const nextContents = parsed.map((content) => {
        if (content.type === 'tool_call' && content.toolCallId === toolCallId) {
          entryUpdated = true;
          updated = true;
          return mergeToolCallWithPermission(content, requestId, request);
        }
        return content;
      });
      if (entryUpdated) {
        persisted = true;
        writeEntryItems(entry, nextContents);
      }
    });

    if (!updated) {
      const latestEntry = history[history.length - 1];
      if (
        latestEntry?.role === 'assistant' &&
        latestEntry.finished !== true &&
        typeof latestEntry.endedAt !== 'number'
      ) {
        persisted = true;
        writeEntryItems(latestEntry, [
          ...readEntryItems(latestEntry),
          buildToolCallFromPermissionRequest(requestId, request),
        ]);
      }
    }

    return history;
  });
  return persisted;
};

export const updatePermissionOutcomeInHistory = async (
  doc: SessionDocument,
  requestId: string,
  outcome: RequestPermissionResponse['outcome'],
  _logger: Logger
) => {
  await doc.updateHistory((history) => {
    history.forEach((entry) => {
      const parsed = readEntryItems(entry);
      let entryUpdated = false;
      const nextContents = parsed.map((content) => {
        if (content.type === 'tool_call' && content.permissionRequest?.requestId === requestId) {
          entryUpdated = true;
          return {
            ...content,
            permissionRequest: content.permissionRequest
              ? { ...content.permissionRequest, outcome }
              : content.permissionRequest,
          };
        }
        return content;
      });
      if (entryUpdated) {
        writeEntryItems(entry, nextContents);
      }
    });
    return history;
  });
};

const mergeToolCallWithPermission = (
  toolCall: ToolCallMessageContent,
  requestId: string,
  request: RequestPermissionRequest
): ToolCallMessageContent => {
  const tool = request.toolCall;
  const kind = (toolCall.kind ?? tool.kind ?? undefined) as
    | ToolCallMessageContent['kind']
    | undefined;
  const content = sanitizeToolCallContentForHistory(
    toolCall.content ?? tool.content ?? undefined,
    kind
  );
  const locations =
    toolCall.locations ??
    (Array.isArray(tool.locations) && tool.locations.length > 0 ? tool.locations : undefined) ??
    deriveLocationsFromToolCallContent(tool.content);
  const requestMeta = (request as { _meta?: unknown })._meta;
  const permissionMeta =
    typeof requestMeta === 'object' && requestMeta !== null && !Array.isArray(requestMeta)
      ? (requestMeta as Record<string, unknown>)
      : undefined;
  return {
    ...toolCall,
    title: toolCall.title ?? tool.title ?? null,
    kind,
    status: toolCall.status ?? tool.status ?? 'pending',
    content,
    locations,
    permissionRequest: {
      requestId,
      options: request.options,
      ...(permissionMeta ? { _meta: permissionMeta } : {}),
      outcome: toolCall.permissionRequest?.outcome,
    },
  };
};

const buildToolCallFromPermissionRequest = (
  requestId: string,
  request: RequestPermissionRequest
): ToolCallMessageContent => {
  const kind = request.toolCall.kind ?? undefined;
  const content = sanitizeToolCallContentForHistory(request.toolCall.content ?? undefined, kind);
  const explicitLocations =
    Array.isArray(request.toolCall.locations) && request.toolCall.locations.length > 0
      ? request.toolCall.locations
      : undefined;
  const locations =
    explicitLocations ?? deriveLocationsFromToolCallContent(request.toolCall.content);
  const base: ToolCallMessageContent = {
    type: 'tool_call',
    toolCallId: request.toolCall.toolCallId,
    title: request.toolCall.title ?? null,
    status: request.toolCall.status ?? 'pending',
    kind,
    content,
    locations,
  };
  return mergeToolCallWithPermission(base, requestId, request);
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
