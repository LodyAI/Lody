import type { MessageContent, ModelInfo } from '../ai';
import type { SessionHistoryInput, SessionPlanEntry } from '../schema';
import { sanitizeLodyInternalInstructions } from '../goal';

import { parseCodexTerminalCommand, parseCodexTerminalOutput } from './codex-raw';
import type { AcpSessionNotification } from './schema';
import {
  getClaudeCodeToolName,
  isClaudeCodeTool,
  parseClaudeCodeTerminalCommand,
  parseClaudeCodeTerminalOutput,
  type ClaudeCodeMeta,
} from './claude-code-raw';
import {
  deriveLocationsFromRawInput,
  deriveLocationsFromToolCallContent,
  stripToolCallContentForHistory,
} from './tool-call-history';
import {
  parseLodyTaskMeta,
  parseSubagentTaskWire,
  mergeSubagentTaskPayload,
} from './claude-subagent-task';
import { parseCodexCollabAgentTasks } from './codex-collab-agent-task';

type StoredToolCallContent = NonNullable<Extract<MessageContent, { type: 'tool_call' }>['content']>;
type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;
type ProposedPlanMessage = Extract<MessageContent, { type: 'proposed_plan' }>;
type ToolKind = NonNullable<ToolCallMessage['kind']>;

/** Tool kinds whose rawOutput should not be treated as terminal output. */
const NON_TERMINAL_TOOL_KINDS = new Set<string>(['edit', 'search', 'write', 'read']);

/**
 * Scheduling tools whose `rawInput`/`rawOutput` we DO persist into history (unlike the
 * generic tool-call path, which strips them). The scheduled-tasks panel is derived purely
 * from history — nothing extra is stored in `SessionMeta` — so it needs the schedule
 * (`cron`/`delaySeconds`/`recurring`) from `rawInput` and the created job id from
 * `rawOutput` for a later `CronDelete` to match. These payloads are small and stable, so
 * the usual "unstructured & unbounded" reason for stripping does not apply.
 * See `collectPendingScheduledTasksFromHistory`.
 */
const SCHEDULING_TOOL_NAMES = new Set<string>([
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
]);

/**
 * The canonical tool name behind a `tool_call` update. ACP `title` is
 * human-facing — an agent that describes its calls puts the rendered schedule
 * there ("Scheduling cron ..."), not the tool name — so identity rides in
 * `_meta` instead. The provider-neutral `_meta.lody.toolName` wins;
 * `_meta.claudeCode.toolName` stays the fallback for adapters that only
 * publish the Claude shape.
 */
const resolveAcpToolName = (meta: unknown): string | undefined => {
  const record = asRecordOrUndefined(meta);
  const lody = asRecordOrUndefined(record?.lody);
  const neutral = lody?.toolName;
  if (typeof neutral === 'string' && neutral.length > 0) return neutral;
  // One-release compatibility for the earlier provider-neutral draft.
  const legacyNeutral = record?.toolName;
  if (typeof legacyNeutral === 'string' && legacyNeutral.length > 0) return legacyNeutral;
  return getClaudeCodeToolName(meta);
};

/** Narrow an unstructured ACP `rawInput`/`rawOutput` to the plain-object shape history stores. */
const asRecordOrUndefined = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * IANA timezone of THIS machine — the one processing the ACP notification, i.e. the machine
 * that ran the scheduling tool. Cron expressions are local-time to it, so the panel needs
 * this to resolve fire times correctly when the viewer's browser is in a different zone.
 */
const resolveMachineTimeZone = (): string | undefined => {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Extended tool call update type that includes the optional `_meta` field.
 * ACP spec allows arbitrary metadata in `_meta`; Claude Code uses it for tool responses.
 */
type ToolCallUpdateWithMeta = {
  _meta?: ClaudeCodeMeta & Record<string, unknown>;
};

const getToolCallActivityKind = (
  meta: (ClaudeCodeMeta & Record<string, unknown>) | undefined
): ToolCallMessage['activityKind'] => {
  if (meta?.contextCompaction === true) return 'context_compaction';
  const lody = asRecordOrUndefined(meta?.lody);
  const activity = asRecordOrUndefined(lody?.activity);
  if (activity?.kind === 'context_compaction') return 'context_compaction';
  if (activity?.kind === 'retry') return 'codex_retry';
  // One-release compatibility for the earlier activity marker.
  if (lody?.activityKind === 'context_compaction' || lody?.activityKind === 'codex_retry') {
    return lody.activityKind;
  }
  return undefined;
};

/**
 * Session history is stored inside a Loro CRDT document.
 *
 * Tool calls can become extremely expensive if we persist:
 * - full file contents (reads)
 * - full old/new text (edits)
 * - snapshot-style terminal output on every incremental update
 *
 * This file implements a "history compaction" layer:
 * - sanitize/normalize tool call blocks
 * - merge tool call updates by `toolCallId` (instead of appending)
 * - keep only bounded terminal output for follow-along/debugging
 */

/**
 * The terminal history budget is bytes, not JS UTF-16 code units.  This is the
 * durable boundary for session history; execution buffers deliberately have a
 * separate (and larger) limit.
 */
export const MAX_STORED_TERMINAL_OUTPUT_BYTES = 1024;
const utf8Encoder = new TextEncoder();

const defaultCreateId = (): string => {
  const maybeCrypto = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof maybeCrypto?.randomUUID === 'function') {
    return maybeCrypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const canAppendAssistantDeltas = (
  entry: SessionHistoryInput | undefined
): entry is SessionHistoryInput =>
  entry?.role === 'assistant' && entry.finished !== true && typeof entry.endedAt !== 'number';

/**
 * Keep a valid UTF-8 tail without splitting a Unicode code point.
 *
 * `TextEncoder` is used rather than `String#length`: Loro stores strings as
 * UTF-8 and emoji/CJK text otherwise makes the apparent 1 KiB bound false.
 */
export const truncateTerminalOutputForHistory = (
  output: string
): { output: string; didTruncate: boolean } => {
  // UTF-8 uses at least one byte per UTF-16 code unit, so this avoids encoding
  // a legacy multi-megabyte output merely to discover that it needs a tail.
  if (
    output.length <= MAX_STORED_TERMINAL_OUTPUT_BYTES &&
    utf8Encoder.encode(output).byteLength <= MAX_STORED_TERMINAL_OUTPUT_BYTES
  ) {
    return { output, didTruncate: false };
  }

  let start = output.length;
  let bytes = 0;
  while (start > 0) {
    const previous = output.charCodeAt(start - 1);
    const beforePrevious = start >= 2 ? output.charCodeAt(start - 2) : 0;
    const codePointStart =
      previous >= 0xdc00 &&
      previous <= 0xdfff &&
      beforePrevious >= 0xd800 &&
      beforePrevious <= 0xdbff
        ? start - 2
        : start - 1;
    const codePoint = output.slice(codePointStart, start);
    const codePointBytes = utf8Encoder.encode(codePoint).byteLength;
    if (bytes + codePointBytes > MAX_STORED_TERMINAL_OUTPUT_BYTES) break;
    bytes += codePointBytes;
    start = codePointStart;
  }

  return { output: output.slice(start), didTruncate: true };
};

/** Normalize all streams of one tool call into one shared combined 1 KiB tail. */
const normalizeTerminalOutputsForHistory = (
  contents: StoredToolCallContent
): StoredToolCallContent => {
  const outputs = contents.filter(
    (block): block is Extract<StoredToolCallContent[number], { type: 'terminal_output' }> =>
      block.type === 'terminal_output'
  );
  if (outputs.length === 0) return contents;

  let outputTail = '';
  let didTruncate = false;
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const block = outputs[index];
    if (!block?.output) continue;
    const blockTail = truncateTerminalOutputForHistory(block.output);
    didTruncate ||= blockTail.didTruncate;
    const next = outputTail ? `${blockTail.output}\n${outputTail}` : blockTail.output;
    const nextTail = truncateTerminalOutputForHistory(next);
    outputTail = nextTail.output;
    didTruncate ||= nextTail.didTruncate;
  }
  const last = outputs[outputs.length - 1];
  const terminal = {
    type: 'terminal_output' as const,
    output: outputTail,
    stream: 'combined' as const,
    truncated: didTruncate || outputs.some((block) => block.truncated === true),
    exitStatus: last?.exitStatus,
  };

  const next: StoredToolCallContent = [];
  let inserted = false;
  for (const block of contents) {
    if (block.type !== 'terminal_output') {
      next.push(block);
      continue;
    }
    if (!inserted) {
      next.push(terminal);
      inserted = true;
    }
  }
  return next;
};

const extractTerminalCommandContent = (
  rawInput: unknown,
  kind?: ToolKind | null
): StoredToolCallContent => {
  // Try Codex format first
  const codexParsed = parseCodexTerminalCommand(rawInput);
  if (codexParsed) {
    return [
      {
        type: 'terminal_command',
        command: codexParsed.command,
        args: codexParsed.args,
        cwd: codexParsed.cwd,
      },
    ];
  }

  // Try Claude Code format
  const claudeParsed = parseClaudeCodeTerminalCommand(rawInput);
  if (claudeParsed) {
    return [
      {
        type: 'terminal_command',
        command: claudeParsed.command,
        args: claudeParsed.args,
        cwd: claudeParsed.cwd,
      },
    ];
  }

  // Search tools (Grep/Glob) use {pattern, path} instead of {command}.
  // Check explicitly by kind, or heuristically when kind is omitted on tool_call_update:
  // only search tools have `pattern` without `command` in rawInput.
  if (kind === 'search' || (kind == null && looksLikeSearchRawInput(rawInput))) {
    return extractSearchCommandFromRawInput(rawInput);
  }

  return [];
};

/**
 * Try to extract a terminal command from ACP content blocks.
 *
 * Some agents (e.g., Kimi) stream the shell command as a JSON text content block
 * like `{"command": "cat hello.txt"}` instead of using rawInput.
 */
const extractTerminalCommandFromContent = (
  content: StoredToolCallContent
): StoredToolCallContent => {
  for (const block of content) {
    if (block.type !== 'content' || !('content' in block)) continue;
    if (block.content.type !== 'text' || !block.content.text) continue;
    const text = block.content.text.trim();
    // Only try JSON-like strings to avoid false positives
    if (!text.startsWith('{') || !text.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.command === 'string' && parsed.command.length > 0) {
        return [
          {
            type: 'terminal_command',
            command: parsed.command,
            args: undefined,
            cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
          },
        ];
      }
    } catch {
      // Not valid JSON, skip
    }
  }
  return [];
};

/**
 * Heuristic: does rawInput look like it came from a search tool (Grep/Glob)?
 *
 * Only search tools have `pattern` without `command`. This lets us handle
 * `tool_call_update` notifications that omit `kind`.
 */
const looksLikeSearchRawInput = (rawInput: unknown): boolean => {
  if (!rawInput || typeof rawInput !== 'object') return false;
  const record = rawInput as Record<string, unknown>;
  return (
    typeof record.pattern === 'string' && record.pattern.length > 0 && record.command === undefined
  );
};

/**
 * Extract a terminal_command block from search tool rawInput.
 *
 * Claude Code Grep: {pattern: "...", path: "...", output_mode: "...", ...}
 * Claude Code Glob: {pattern: "...", path: "..."}
 */
const extractSearchCommandFromRawInput = (rawInput: unknown): StoredToolCallContent => {
  if (!rawInput || typeof rawInput !== 'object') return [];
  const record = rawInput as Record<string, unknown>;

  const pattern = record.pattern;
  if (typeof pattern !== 'string' || pattern.length === 0) return [];

  const args: string[] = [];
  const path = record.path;
  if (typeof path === 'string' && path.length > 0) {
    args.push(path);
  }

  return [
    {
      type: 'terminal_command',
      command: pattern,
      args,
      cwd: undefined,
    },
  ];
};

const extractTerminalOutputContent = (
  rawOutput: unknown,
  kind?: ToolKind | null
): StoredToolCallContent => {
  // Codex format: object with aggregated_output, exit_code, etc.
  // This has explicit fields (aggregated_output, exit_code) so it's safe for any tool kind.
  const parsed = parseCodexTerminalOutput(rawOutput);
  if (parsed) {
    return buildTerminalOutputBlocks(parsed);
  }

  // Claude Code v0.19+: rawOutput is a plain string.
  // Only treat as terminal output for execute/bash tools (or when kind is unknown).
  // Non-terminal tools (edit, search, write, read) also send string rawOutput but it's not
  // terminal output — persisting it would bloat the CRDT and duplicate content blocks.
  if (
    typeof rawOutput === 'string' &&
    rawOutput.length > 0 &&
    !NON_TERMINAL_TOOL_KINDS.has(kind ?? '')
  ) {
    return buildTerminalOutputBlocks({ output: rawOutput });
  }

  return [];
};

/**
 * Extract terminal output from Claude Code's _meta.claudeCode.toolResponse.
 *
 * Claude Code puts tool responses in _meta rather than rawOutput.
 */
const extractClaudeCodeTerminalOutputContent = (meta: unknown): StoredToolCallContent => {
  const parsed = parseClaudeCodeTerminalOutput(meta);
  if (!parsed) {
    return [];
  }

  return buildTerminalOutputBlocks(parsed);
};

/**
 * Determine if a terminal output block should be kept in history.
 *
 * We skip empty outputs for successful commands (exitCode === 0) unless truncated,
 * as they provide no useful information. Non-zero exits and truncated outputs are
 * always kept for debugging.
 */
const shouldKeepTerminalOutput = (
  output: string,
  exitCode: number | undefined,
  truncated: boolean | undefined
): boolean => {
  return output.length > 0 || exitCode === undefined || exitCode !== 0 || truncated === true;
};

/**
 * Build terminal_output blocks from parsed output data.
 */
const buildTerminalOutputBlocks = (parsed: {
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
}): StoredToolCallContent => {
  const exitStatus =
    parsed.exitCode !== undefined
      ? {
          exitCode: parsed.exitCode,
          signal: null,
        }
      : undefined;

  // Combined output takes precedence over separate stdout/stderr
  if (parsed.output !== undefined) {
    if (!shouldKeepTerminalOutput(parsed.output, parsed.exitCode, parsed.truncated)) {
      return [];
    }
    return [
      {
        type: 'terminal_output',
        output: parsed.output,
        stream: 'combined',
        truncated: parsed.truncated,
        exitStatus,
      },
    ];
  }

  const output = [parsed.stdout, parsed.stderr]
    .filter((value): value is string => Boolean(value))
    .join('\n');
  if (!shouldKeepTerminalOutput(output, parsed.exitCode, parsed.truncated)) return [];
  return [
    {
      type: 'terminal_output',
      output,
      stream: 'combined',
      truncated: parsed.truncated,
      exitStatus,
    },
  ];
};

const extractSingleFencedBlock = (text: string): { lang: string | null; body: string } | null => {
  const match = text.match(/^```([^\n`]*)\n([\s\S]*?)\n```\n?$/);
  if (!match) return null;
  const lang = match[1] ? match[1].trim() : null;
  return { lang: lang && lang.length ? lang : null, body: match[2] ?? '' };
};

const normalizeTerminalOutputForComparison = (value: string): string => {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
};

const stripDuplicateFencedToolContent = (
  contents: StoredToolCallContent
): StoredToolCallContent => {
  // Many agents emit terminal output twice:
  // - as a structured `terminal_output` block, and
  // - as a fenced `content` snapshot (often repeated on every update).
  //
  // Once we have *any* structured terminal output, drop all fenced snapshot blocks.
  const hasTerminalOutput = contents.some((b) => b.type === 'terminal_output');
  if (!hasTerminalOutput) {
    return contents;
  }

  return contents.filter((c) => {
    if (c.type !== 'content') return true;
    if (!('content' in c)) return true;
    if (c.content.type !== 'text') return true;
    const fenced = extractSingleFencedBlock(c.content.text);
    if (!fenced) return true;
    return false;
  });
};

const dedupeAdjacentToolCallContent = (contents: StoredToolCallContent): StoredToolCallContent => {
  const out: StoredToolCallContent = [];
  for (const block of contents) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(block);
      continue;
    }

    if (block.type === 'content' && prev.type === 'content') {
      if (
        'content' in block &&
        'content' in prev &&
        block.content.type === 'text' &&
        prev.content.type === 'text' &&
        String(block.content.text ?? '') === String(prev.content.text ?? '')
      ) {
        continue;
      }
    }

    if (block.type === 'terminal_output' && prev.type === 'terminal_output') {
      const prevStream = prev.stream ?? 'combined';
      const blockStream = block.stream ?? 'combined';
      if (prevStream === blockStream && prev.output === block.output) {
        continue;
      }
    }

    if (block.type === 'diff' && prev.type === 'diff') {
      if (
        block.path === prev.path &&
        block.newText === prev.newText &&
        block.oldText === prev.oldText
      ) {
        continue;
      }
    }

    out.push(block);
  }
  return out;
};

const findLastTerminalSnapshotInContentBlocks = (
  contents: StoredToolCallContent
): { snapshot: string; indices: number[] } | null => {
  const indices: number[] = [];
  let snapshot: string | null = null;

  for (let i = 0; i < contents.length; i++) {
    const block = contents[i];
    if (!block || block.type !== 'content') continue;
    if (!('content' in block)) continue;
    if (block.content.type !== 'text') continue;
    const raw = String(block.content.text ?? '');
    const fenced = extractSingleFencedBlock(raw);
    if (!fenced) continue;
    indices.push(i);
    snapshot = fenced.body;
  }

  if (!snapshot || indices.length === 0) {
    return null;
  }
  return { snapshot, indices };
};

/**
 * Compacts tool-call content before writing into the session history CRDT.
 *
 * Goals:
 * - Avoid storing unbounded payloads (file contents, full diffs, repeated terminal snapshots).
 * - Prefer stable, structured blocks (`terminal_command`, `terminal_output`) over ad-hoc `content`.
 * - Keep the number and size of CRDT operations small by deduping adjacent blocks and
 *   merging snapshot-style terminal output as incremental appends when possible.
 */
const compactToolCallContentForHistory = (
  contents: StoredToolCallContent,
  opts: { kind?: ToolKind | null } = {}
): StoredToolCallContent => {
  // Remove empty text content blocks (e.g. Kimi sends an empty text content block
  // in the initial tool_call notification that renders as an empty bordered div).
  let compacted = contents.filter((block) => {
    if (block.type !== 'content' || !('content' in block)) return true;
    if (block.content.type !== 'text') return true;
    return (block.content.text ?? '').trim().length > 0;
  });

  compacted = dedupeAdjacentToolCallContent(compacted);

  // Convert repeated fenced "terminal snapshots" emitted as ACP `content` blocks into a single
  // `terminal_output` block so future updates can merge into the same LoroText instead of
  // re-inserting the full snapshot every time.
  if (opts.kind === 'execute') {
    const latest = findLastTerminalSnapshotInContentBlocks(compacted);
    if (latest) {
      compacted = compacted.filter((_, idx) => !latest.indices.includes(idx));
      const existingIndex = compacted.findIndex(
        (b) => b.type === 'terminal_output' && (b.stream ?? 'combined') === 'combined'
      );
      if (existingIndex >= 0) {
        const existing = compacted[existingIndex] as Extract<
          StoredToolCallContent[number],
          { type: 'terminal_output' }
        >;
        if (latest.snapshot.startsWith(existing.output)) {
          // Common case: snapshot-style streaming. Apply as append to keep CRDT ops small.
          compacted[existingIndex] = {
            ...existing,
            output: existing.output + latest.snapshot.slice(existing.output.length),
            stream: 'combined',
          };
        } else {
          // Prefer already-derived terminal output (e.g. from `rawOutput`) over fenced snapshots.
          // Codex often emits a fenced block containing escaped `\\u001b` sequences while `rawOutput`
          // contains real ANSI escapes. Don't clobber the real output in that case.
          const existingHasAnsi = existing.output.includes('\u001b');
          const snapshotHasEscapedAnsi = latest.snapshot.includes('\\u001b');
          if (!existingHasAnsi || !snapshotHasEscapedAnsi) {
            compacted[existingIndex] = {
              ...existing,
              output: mergeTerminalOutputSnapshot(existing.output, latest.snapshot),
              stream: 'combined',
            };
          }
        }
      } else {
        compacted.push({
          type: 'terminal_output',
          stream: 'combined',
          output: latest.snapshot,
          truncated: undefined,
          exitStatus: undefined,
        });
      }
    }
  }

  compacted = stripToolCallContentForHistory(opts.kind, compacted);

  compacted = stripDuplicateFencedToolContent(compacted);
  compacted = normalizeTerminalOutputsForHistory(compacted);

  // Post-filtering may have created adjacent duplicates again.
  return dedupeAdjacentToolCallContent(compacted);
};

const compactAdjacentTextAndThought = (items: MessageContent[]): MessageContent[] => {
  if (items.length === 0) return items;
  const compacted: MessageContent[] = [];
  for (const item of items) {
    const nextItem =
      item.type === 'text' || item.type === 'thought'
        ? ({ ...item, text: sanitizeLodyInternalInstructions(item.text) } as MessageContent)
        : item;
    if ((nextItem.type === 'text' || nextItem.type === 'thought') && !nextItem.text) {
      continue;
    }

    const last = compacted[compacted.length - 1];
    if (
      last &&
      (nextItem.type === 'text' || nextItem.type === 'thought') &&
      last.type === nextItem.type
    ) {
      const existing = last as Extract<MessageContent, { type: 'text' | 'thought' }>;
      const next = nextItem as Extract<MessageContent, { type: 'text' | 'thought' }>;
      const text = sanitizeLodyInternalInstructions(existing.text + next.text);
      if (text) {
        compacted[compacted.length - 1] = { ...existing, text };
      } else {
        compacted.pop();
      }
      continue;
    }
    compacted.push(nextItem);
  }
  return compacted;
};

function shouldDedupeChunk(chunk: string): boolean {
  // Heuristic: only dedupe "substantial" chunks to avoid collapsing legitimate short repeats
  // (e.g. "yes", "ha", or repeated tokens in intentionally repeated phrases).
  return chunk.length >= 48 || chunk.includes('\n');
}

function mergeTerminalOutputSnapshot(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current) return incoming;

  // If the upstream sends an aggregated snapshot (common), prefer keeping the latest snapshot,
  // but apply it as an append when it's a strict prefix to keep CRDT operations small.
  if (incoming.startsWith(current)) {
    return current + incoming.slice(current.length);
  }

  // Dedupe replays.
  if (incoming === current) {
    return current;
  }

  if (shouldDedupeChunk(incoming) && current.endsWith(incoming)) {
    return current;
  }

  // Best-effort overlap merge (same approach as text streaming), but fallback to snapshot replacement
  // instead of concatenation to avoid duplicating output when the upstream sends snapshots.
  const maxWindow = 4096;
  const minOverlap = 24;
  const maxOverlap = Math.min(current.length, incoming.length, maxWindow);
  for (let overlap = maxOverlap; overlap >= minOverlap; overlap--) {
    if (current.slice(-overlap) === incoming.slice(0, overlap)) {
      return current + incoming.slice(overlap);
    }
  }

  return incoming;
}

const mergeStreamChunk = (current: string, incoming: string): string => {
  if (!incoming) return current;
  if (!current) return incoming;

  // Some emitters send snapshots instead of deltas. If `incoming` is a snapshot that already
  // contains `current`, keep only the snapshot.
  if (incoming.startsWith(current)) {
    return incoming;
  }

  // On reconnect/retry, the same chunk may be re-sent. Avoid duplicating large chunks.
  if (shouldDedupeChunk(incoming) && current.endsWith(incoming)) {
    return current;
  }

  if (!shouldDedupeChunk(incoming)) {
    return current + incoming;
  }

  // Best-effort overlap merge to handle partial replays where the boundary is not aligned.
  const maxWindow = 4096;
  const minOverlap = 24;
  const maxOverlap = Math.min(current.length, incoming.length, maxWindow);
  for (let overlap = maxOverlap; overlap >= minOverlap; overlap--) {
    if (current.slice(-overlap) === incoming.slice(0, overlap)) {
      return current + incoming.slice(overlap);
    }
  }

  return current + incoming;
};

const mergeToolCallMessage = (
  prev: ToolCallMessage,
  incoming: ToolCallMessage
): ToolCallMessage => {
  const nextKind = (incoming.kind ?? prev.kind) as ToolKind | null | undefined;

  const mergedContent: StoredToolCallContent = prev.content ? [...prev.content] : [];
  const nextChunks = incoming.content ?? [];

  if (nextChunks.length > 0) {
    const diffChunks = nextChunks.filter((c) => c.type === 'diff') as Extract<
      StoredToolCallContent[number],
      { type: 'diff' }
    >[];
    if (diffChunks.length > 0) {
      if (nextKind === 'edit') {
        // Edits often include full old/new text in `diff` blocks. Ignore them to keep the
        // persisted history small (we only keep paths/status/terminal output).
        for (let i = mergedContent.length - 1; i >= 0; i--) {
          if (mergedContent[i]?.type === 'diff') {
            mergedContent.splice(i, 1);
          }
        }
      } else {
        const existingDiffIndices: number[] = [];
        for (let i = 0; i < mergedContent.length; i++) {
          if (mergedContent[i]?.type === 'diff') {
            existingDiffIndices.push(i);
          }
        }

        // Replace in-place where possible to avoid "delete + re-insert full text" CRDT churn.
        const replaceCount = Math.min(existingDiffIndices.length, diffChunks.length);
        for (let i = 0; i < replaceCount; i++) {
          const idx = existingDiffIndices[i];
          const diff = diffChunks[i];
          if (idx === undefined || !diff) continue;
          mergedContent[idx] = diff;
        }

        // Remove extra existing diffs.
        if (existingDiffIndices.length > diffChunks.length) {
          const toRemove = new Set(existingDiffIndices.slice(diffChunks.length));
          const filtered: StoredToolCallContent = [];
          for (let i = 0; i < mergedContent.length; i++) {
            if (toRemove.has(i)) continue;
            const block = mergedContent[i];
            if (!block) continue;
            filtered.push(block);
          }
          mergedContent.splice(0, mergedContent.length, ...filtered);
        }

        // Append any extra incoming diffs.
        if (diffChunks.length > existingDiffIndices.length) {
          mergedContent.push(...diffChunks.slice(existingDiffIndices.length));
        }
      }
    }

    const nextTerminalCommands = nextChunks.filter((c) => c.type === 'terminal_command') as Extract<
      StoredToolCallContent[number],
      { type: 'terminal_command' }
    >[];
    if (nextTerminalCommands.length > 0) {
      const cmd = nextTerminalCommands[nextTerminalCommands.length - 1];
      if (cmd) {
        const existingIndex = mergedContent.findIndex((c) => c.type === 'terminal_command');
        if (existingIndex >= 0) {
          mergedContent[existingIndex] = cmd;
        } else {
          // Keep the typical ordering: command before output.
          const firstOutputIndex = mergedContent.findIndex((c) => c.type === 'terminal_output');
          if (firstOutputIndex >= 0) {
            mergedContent.splice(firstOutputIndex, 0, cmd);
          } else {
            mergedContent.push(cmd);
          }
        }
      }
    }

    const nextTerminalOutputs = nextChunks.filter((c) => c.type === 'terminal_output') as Extract<
      StoredToolCallContent[number],
      { type: 'terminal_output' }
    >[];
    if (nextTerminalOutputs.length > 0) {
      // Terminal output updates are often snapshots, not deltas. Merge them carefully so the CRDT
      // sees small appends when possible instead of repeated full-string replacements.
      const hasCombined = nextTerminalOutputs.some((o) => (o.stream ?? 'combined') === 'combined');
      if (hasCombined) {
        // Canonicalize to one combined output block.
        const combined = nextTerminalOutputs.find((o) => (o.stream ?? 'combined') === 'combined');
        if (combined) {
          const existingIndex = mergedContent.findIndex(
            (c) => c.type === 'terminal_output' && (c.stream ?? 'combined') === 'combined'
          );
          // Drop all existing terminal_output blocks except the combined one we will merge into.
          const filtered: StoredToolCallContent = [];
          for (let i = 0; i < mergedContent.length; i++) {
            const block = mergedContent[i];
            if (!block) continue;
            if (block.type !== 'terminal_output') {
              filtered.push(block);
              continue;
            }
            if ((block.stream ?? 'combined') === 'combined' && i === existingIndex) {
              filtered.push(block);
            }
          }
          mergedContent.splice(0, mergedContent.length, ...filtered);

          const combinedIndex = mergedContent.findIndex(
            (c) => c.type === 'terminal_output' && (c.stream ?? 'combined') === 'combined'
          );
          if (combinedIndex >= 0) {
            const prevOutput = mergedContent[combinedIndex] as Extract<
              StoredToolCallContent[number],
              { type: 'terminal_output' }
            >;
            mergedContent[combinedIndex] = {
              ...prevOutput,
              output: mergeTerminalOutputSnapshot(prevOutput.output, combined.output),
              stream: 'combined',
              truncated: combined.truncated ?? prevOutput.truncated,
              exitStatus: combined.exitStatus ?? prevOutput.exitStatus,
            };
          } else {
            mergedContent.push(combined);
          }
        }
      } else {
        for (const chunk of nextTerminalOutputs) {
          const stream = chunk.stream ?? 'combined';
          const existingIndex = mergedContent.findIndex((c) => {
            if (c.type !== 'terminal_output') return false;
            return (c.stream ?? 'combined') === stream;
          });

          if (existingIndex >= 0) {
            const prevOutput = mergedContent[existingIndex] as Extract<
              StoredToolCallContent[number],
              { type: 'terminal_output' }
            >;
            mergedContent[existingIndex] = {
              ...prevOutput,
              output: mergeTerminalOutputSnapshot(prevOutput.output, chunk.output),
              stream: stream,
              truncated: chunk.truncated ?? prevOutput.truncated,
              exitStatus: chunk.exitStatus ?? prevOutput.exitStatus,
            };
          } else {
            mergedContent.push(chunk);
          }
        }
      }
    }

    let remaining: StoredToolCallContent = nextChunks.filter(
      (c) => c.type !== 'diff' && c.type !== 'terminal_command' && c.type !== 'terminal_output'
    ) as StoredToolCallContent;
    remaining = stripToolCallContentForHistory(nextKind, remaining);
    if (remaining.length > 0) {
      mergedContent.push(...remaining);
    }
  }

  // Reconnect/retry tails can replay an older `tool_call` notification after a newer update
  // already persisted. Status is monotonic in the ACP lifecycle, so it must never regress.
  const statusRank = { pending: 0, in_progress: 1, completed: 2, failed: 2 } as const;
  const nextStatus =
    statusRank[incoming.status] < statusRank[prev.status] ? prev.status : incoming.status;

  return {
    ...prev,
    toolCallId: incoming.toolCallId,
    // `null` title/kind means "no information" on the wire (zod allows explicit null);
    // it must keep the previously persisted value, not wipe it.
    title: incoming.title ?? prev.title,
    kind: nextKind ?? undefined,
    status: nextStatus,
    content: mergedContent.length
      ? compactToolCallContentForHistory(mergedContent, { kind: nextKind })
      : prev.content,
    locations: incoming.locations !== undefined ? incoming.locations : prev.locations,
    // Scheduling tools split rawInput and the terminal `completed` across updates; keep
    // whichever update carried each (see SCHEDULING_TOOL_NAMES).
    rawInput: incoming.rawInput !== undefined ? incoming.rawInput : prev.rawInput,
    rawOutput: incoming.rawOutput !== undefined ? incoming.rawOutput : prev.rawOutput,
    schedulingTimeZone:
      incoming.schedulingTimeZone !== undefined
        ? incoming.schedulingTimeZone
        : prev.schedulingTimeZone,
    // The first-persisted stamp wins; a replayed/retried update must not move it.
    recordedAtMs: prev.recordedAtMs ?? incoming.recordedAtMs,
    toolName: incoming.toolName ?? prev.toolName,
    activityKind: incoming.activityKind !== undefined ? incoming.activityKind : prev.activityKind,
  };
};

/**
 * Parse Claude Code's <thinking> tags and split into thought + text content.
 *
 * Claude Code streams thinking as regular agent_message_chunk with <thinking> tags,
 * unlike Codex which uses dedicated agent_thought_chunk notifications.
 *
 * This function extracts thinking content and converts it to the unified `thought` type.
 */
const parseClaudeCodeThinkingTags = (text: string): MessageContent[] => {
  const result: MessageContent[] = [];

  // Only tags anchored to line boundaries are structural (same rationale as the
  // hardened `<proposed_plan>` parser below): the opening tag must start a line
  // and the closing tag must end one, so inline mentions like `<thinking>` in
  // prose or code stay visible text instead of being extracted and rewritten.
  // Content (including its delimiter newlines) is captured verbatim. The
  // negative lookahead prevents a stray isolated opening tag from swallowing
  // prose up to a later real block.
  const thinkingRegex =
    /(^|\r?\n)[ \t]*<thinking>((?:(?!<thinking>)[\s\S])*?)<\/thinking>[ \t]*(?=\r?\n|$)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = thinkingRegex.exec(text)) !== null) {
    const leadingNewline = match[1] ?? '';
    const textBeforeEnd = match.index + leadingNewline.length;
    if (textBeforeEnd > lastIndex) {
      const textBefore = text.slice(lastIndex, textBeforeEnd);
      if (textBefore) {
        result.push({ type: 'text', text: textBefore });
      }
    }

    const thinkingContent = match[2];
    if (thinkingContent) {
      result.push({ type: 'thought', text: thinkingContent });
    }

    lastIndex = thinkingRegex.lastIndex;
  }

  // Add remaining text after last thinking tag
  if (lastIndex < text.length) {
    const textAfter = text.slice(lastIndex);
    if (textAfter) {
      result.push({ type: 'text', text: textAfter });
    }
  }

  // If no thinking tags found, return the original text
  if (result.length === 0) {
    return [{ type: 'text', text }];
  }

  return result;
};

const parseCodexProposedPlanTags = (text: string, turnId: string): MessageContent[] => {
  // Codex may still emit proposed-plan markup as ordinary assistant text. Keep parsing in Lody,
  // but only for line-isolated control tags; inline mentions like `<proposed_plan>` in prose or
  // code must remain visible text.
  //
  // The content match uses a negative lookahead so it cannot swallow another
  // `<proposed_plan>` opening tag. Without it, when the model wrote
  // `` `<proposed_plan>` `` on a line of its own (e.g. wrapped prose) before
  // the real plan block, the lazy `[\s\S]*?` paired the *first* opening with
  // the *final* closing tag — yanking the intervening prose plus the real
  // opening tag into the plan markdown. Rejected: a hand-rolled scan that
  // tracks the latest unmatched opening — equivalent behavior, more code,
  // and harder to reason about for streaming partial input.
  const planRegex =
    /(^|\r?\n)[ \t]*<proposed_plan>[ \t]*(?:\r?\n)((?:(?!<proposed_plan>)[\s\S])*?)(\r?\n)[ \t]*<\/proposed_plan>[ \t]*(?=\r?\n|$)/g;
  const result: MessageContent[] = [];
  let lastIndex = 0;
  let insertIndex: number | undefined;
  let markdown = '';
  let match: RegExpExecArray | null;

  while ((match = planRegex.exec(text)) !== null) {
    const leadingNewline = match[1] ?? '';
    const textBeforeEnd = match.index + leadingNewline.length;
    if (textBeforeEnd > lastIndex) {
      const textBefore = text.slice(lastIndex, textBeforeEnd);
      if (textBefore) {
        result.push({ type: 'text', text: textBefore });
      }
    }

    insertIndex ??= result.length;
    markdown += match[2] ?? '';
    lastIndex = planRegex.lastIndex;
  }

  if (insertIndex === undefined) {
    return [{ type: 'text', text }];
  }

  if (lastIndex < text.length) {
    const textAfter = text.slice(lastIndex);
    if (textAfter) {
      result.push({ type: 'text', text: textAfter });
    }
  }

  if (markdown.trim()) {
    result.splice(insertIndex, 0, {
      type: 'proposed_plan',
      turnId,
      markdown,
      status: 'completed',
      isLatest: true,
    });
  }

  return result;
};

const parseAssistantTextTags = (text: string, turnId: string): MessageContent[] => {
  const withThoughts = parseClaudeCodeThinkingTags(text);
  return withThoughts.flatMap((item) => {
    if (item.type !== 'text') {
      return [item];
    }
    return parseCodexProposedPlanTags(item.text, turnId);
  });
};

export const buildMessageContentFromNotification = (
  message: AcpSessionNotification
): MessageContent[] => {
  const { update } = message;
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
    case 'config_option_update':
    case 'usage_update':
      return [];
    case 'agent_message_chunk':
      switch (update.content.type) {
        case 'text':
          // Note: Claude Code streams <thinking> tags across multiple chunks.
          // We handle parsing in postProcessThinkingTags() after all chunks are merged.
          return [{ type: 'text', text: update.content.text }];
        case 'image':
        case 'audio':
        case 'resource_link':
        case 'resource':
          // Persisted history currently stores text-only assistant chunks. Live UI can still
          // consume richer ACP content directly from notifications.
          return [];
      }
    case 'agent_thought_chunk':
      switch (update.content.type) {
        case 'text':
          return [{ type: 'thought', text: update.content.text }];
        case 'image':
        case 'audio':
        case 'resource_link':
        case 'resource':
          return [];
      }
      return [];
    case 'tool_call':
    case 'tool_call_update': {
      // Subagent/background task lifecycle rides the tool_call transport (see
      // claude-subagent-task.ts). Materialize it as a first-class `subagent_task`
      // item instead of persisting a tool_call; the applier merges by taskId.
      const subagentTask =
        parseLodyTaskMeta((update as ToolCallUpdateWithMeta)._meta) ??
        parseSubagentTaskWire(update.rawInput);
      if (subagentTask) {
        return [{ type: 'subagent_task', ...subagentTask }];
      }

      const codexCollabTasks = parseCodexCollabAgentTasks(update.title, update.rawInput);
      if (codexCollabTasks.length > 0) {
        return codexCollabTasks.map((task) => ({ type: 'subagent_task', ...task }));
      }

      const kind = (update.kind ?? undefined) as ToolKind | null | undefined;

      // `update.content` is untrusted and provider-dependent; some tools include whole file
      // contents or full old/new text. Strip those early so we never persist them.
      let baseContent: StoredToolCallContent = update.content ? [...update.content] : [];
      baseContent = stripToolCallContentForHistory(kind, baseContent);

      // Extract structured terminal command/output from implementation-specific fields.
      //
      // rawInput → terminal_command block
      // _meta.claudeCode.toolResponse / rawOutput → terminal_output blocks
      //
      // For file reads, `rawOutput` is usually the full file text; we intentionally do NOT
      // persist that into session history.
      //
      // Priority for terminal output extraction:
      // 1. Claude Code _meta.claudeCode.toolResponse (v0.19+: {stdout, stderr, ...})
      // 2. Codex rawOutput (object: {aggregated_output, exit_code, ...})
      // 3. Claude Code rawOutput (v0.19+: plain string)
      let derivedCommand = extractTerminalCommandContent(update.rawInput, kind);

      // Fallback: some agents (e.g., Kimi) put the command as JSON in content blocks
      // instead of rawInput. Try to extract it from content when rawInput yields nothing.
      if (derivedCommand.length === 0) {
        derivedCommand = extractTerminalCommandFromContent(baseContent);
      }

      let derivedOutput: StoredToolCallContent = [];
      if (kind !== 'read') {
        // Prefer _meta.claudeCode.toolResponse for Claude Code tools (has separate stdout/stderr)
        const meta = (update as ToolCallUpdateWithMeta)._meta;
        if (isClaudeCodeTool(meta)) {
          derivedOutput = extractClaudeCodeTerminalOutputContent(meta);
        }

        // Fallback to rawOutput (Codex object format or Claude Code plain string for execute tools)
        if (derivedOutput.length === 0) {
          derivedOutput = extractTerminalOutputContent(update.rawOutput, kind);
        }
      }

      if (derivedOutput.length > 0) {
        // ACP uses a `terminal` placeholder block to indicate that terminal output is streaming
        // in the CLI. Once we have *any* structured terminal output (`terminal_output`) persisted
        // in history, the placeholder becomes redundant and can cause confusing UI layouts
        // (e.g. "streaming in your CLI" inserted between command and output).
        baseContent = baseContent.filter((c) => c.type !== 'terminal');

        // Some agents duplicate terminal output by emitting both:
        // - `rawOutput.aggregated_output` (with real ANSI escapes), and
        // - a fenced `content` snapshot (often with escaped sequences like `\\u001b`).
        //
        // Agents using ACP terminal RPCs (e.g., Kimi) put the result as plain text content
        // blocks which are also extracted as rawOutput → terminal_output.
        //
        // When we have a derived terminal output, drop any content blocks whose text matches.
        const candidateOutputs = new Set(
          derivedOutput
            .filter((b) => b.type === 'terminal_output')
            .map((b) => normalizeTerminalOutputForComparison(b.output))
        );
        baseContent = baseContent.filter((c) => {
          if (c.type !== 'content') return true;
          if (!('content' in c)) return true;
          if (c.content.type !== 'text') return true;
          // Check fenced code blocks (Codex style)
          const fenced = extractSingleFencedBlock(c.content.text);
          if (fenced && candidateOutputs.has(normalizeTerminalOutputForComparison(fenced.body))) {
            return false;
          }
          // Check plain text match (Kimi style: content text is identical to terminal output)
          const plainText = c.content.text.trim();
          if (
            plainText.length > 0 &&
            candidateOutputs.has(normalizeTerminalOutputForComparison(plainText))
          ) {
            return false;
          }
          return true;
        });
      }

      const derived: StoredToolCallContent = [...derivedCommand, ...derivedOutput];
      const content = compactToolCallContentForHistory([...baseContent, ...derived], { kind });
      const explicitLocations =
        Array.isArray(update.locations) && update.locations.length > 0
          ? update.locations
          : undefined;
      const locations =
        explicitLocations ??
        deriveLocationsFromToolCallContent(update.content) ??
        deriveLocationsFromRawInput(update.rawInput);
      // Scheduling tools are the one exception to stripping rawInput/rawOutput: the
      // scheduled-tasks panel derives entirely from history, so it needs the schedule and
      // the created job id. Persist them (small, stable) plus the canonical tool name the
      // deriver switches on; `title` stays whatever the agent chose to show.
      const toolName = resolveAcpToolName((update as ToolCallUpdateWithMeta)._meta);
      const activityKind = getToolCallActivityKind((update as ToolCallUpdateWithMeta)._meta);
      const isSchedulingTool = toolName !== undefined && SCHEDULING_TOOL_NAMES.has(toolName);
      return [
        {
          type: 'tool_call',
          toolCallId: update.toolCallId,
          title: update.title,
          toolName,
          kind: update.kind || undefined,
          status: update.status || 'pending',
          content: content.length ? content : undefined,
          locations,
          // Generic ACP rawInput/rawOutput is excluded because it is unstructured by spec;
          // scheduling tools keep theirs (see SCHEDULING_TOOL_NAMES).
          rawInput: isSchedulingTool ? asRecordOrUndefined(update.rawInput) : undefined,
          rawOutput: isSchedulingTool ? asRecordOrUndefined(update.rawOutput) : undefined,
          // Cron is local-time to this machine — record its zone so the panel resolves the
          // fire time in the right timezone regardless of where it is later viewed.
          schedulingTimeZone: isSchedulingTool ? resolveMachineTimeZone() : undefined,
          activityKind,
        },
      ];
    }
    case 'plan':
      // Plan is now stored as a field on the history entry, not as a MessageContent item.
      // Return empty array here; plan updates are handled separately in the applier.
      return [];
    case 'plan_update':
      switch (update.plan.type) {
        case 'items':
          return [{ type: 'plan', entries: update.plan.entries }];
        case 'markdown':
          return [
            {
              type: 'proposed_plan',
              turnId: update.plan.planId,
              markdown: update.plan.content,
              status: 'delta',
              isLatest: true,
            },
          ];
        case 'file':
          return [];
      }
    case 'plan_removed':
      return [
        {
          type: 'proposed_plan',
          turnId: update.planId,
          markdown: '',
          status: 'cleared',
          isLatest: false,
        },
      ];
    case 'available_commands_update':
      // Slash commands are already cached in ACP capabilities metadata and consumed from there.
      // Persisting them into chat history only creates empty assistant rows in the UI.
      return [];
    case 'current_mode_update':
      // Mode changes are session-level metadata; the persisted history only stores message content.
      return [];
    case 'session_info_update':
      const { title } = update;
      // TODO: wait for cc codex agent support
      void title;
      return [];
    default:
      return [];
  }
};

export type ApplyNotificationOnHistoryOptions = {
  createId?: () => string;
  now?: () => string;
  targetAssistantEntryId?: string;
};

/**
 * Applies ACP notifications onto session history by mutating the `history` array in-place.
 *
 * Why a class:
 * - Keeps the hot-path state (caches + indexes) scoped and explicit.
 * - Avoids plumbing a dozen helper closures through the call stack.
 * - Makes correctness testing easier by exposing one cohesive unit of behavior.
 */
class NotificationOnHistoryApplier {
  private readonly history: SessionHistoryInput[];
  private readonly createId: () => string;
  private readonly now: () => string;
  private readonly targetAssistantEntryId: string | undefined;

  // Cache for parsing `entry.items` (we only parse each entry once).
  private readonly parsedItemsByEntryIndex: Array<MessageContent[] | null>;
  // Tool calls can receive future updates that should be applied to the entry where the
  // tool call originally appeared (keyed by `toolCallId`).
  private readonly toolCallEntryIndexById = new Map<string, number | null>();
  // Subagent tasks receive future lifecycle events that must merge into the item
  // where the task first appeared (keyed by `taskId`).
  private readonly subagentTaskEntryIndexById = new Map<string, number>();
  private readonly touchedAssistantEntryIndices = new Set<number>();
  private changed = false;

  constructor(
    history: SessionHistoryInput[],
    options: ApplyNotificationOnHistoryOptions,
    private model?: ModelInfo
  ) {
    this.history = history;
    this.createId = options.createId ?? defaultCreateId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.targetAssistantEntryId = options.targetAssistantEntryId;
    this.parsedItemsByEntryIndex = Array.from({ length: history.length }, () => null);
  }

  apply(notifications: AcpSessionNotification[]): SessionHistoryInput[] {
    if (notifications.length === 0) {
      return this.history;
    }

    this.primeToolCallIndexForBatch(notifications);

    for (const notification of notifications) {
      const { update } = notification;

      const turnId =
        update._meta?.lody &&
        typeof update._meta.lody === 'object' &&
        typeof (update._meta.lody as Record<string, unknown>).turnId === 'string'
          ? ((update._meta.lody as Record<string, unknown>).turnId as string)
          : undefined;
      if (turnId) {
        const entryIndex = this.ensureActiveAssistantEntry();
        const entry = this.history[entryIndex];
        if (entry && entry.acpTurnId !== turnId) {
          entry.acpTurnId = turnId;
          this.changed = true;
        }
      }

      // Checklist plans go to entry.plan, not entry.items. ACP 1.0 called this
      // update `plan`; ACP 1.3 carries the same entries in `plan_update`.
      if (update.sessionUpdate === 'plan') {
        this.updateEntryPlan(update.entries);
        continue;
      }
      if (update.sessionUpdate === 'plan_update' && update.plan.type === 'items') {
        this.updateEntryPlan(update.plan.entries);
        continue;
      }

      const contents = buildMessageContentFromNotification(notification);
      for (const message of contents) {
        this.applyMessageContent(message);
      }
    }

    // Post-process: Parse <thinking> tags from accumulated text content.
    // Claude Code streams <thinking> tags across multiple chunks, so we need to
    // parse them after all chunks are merged, not per-chunk.
    this.postProcessTouchedAssistantEntries();

    return this.history;
  }

  hasChanges(): boolean {
    return this.changed;
  }

  private primeToolCallIndexForBatch(notifications: AcpSessionNotification[]) {
    const unresolved = new Set<string>();

    for (const notification of notifications) {
      const update = notification.update;
      if (
        (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
        typeof update.toolCallId === 'string' &&
        update.toolCallId.length > 0 &&
        !this.toolCallEntryIndexById.has(update.toolCallId)
      ) {
        unresolved.add(update.toolCallId);
      }
    }

    if (unresolved.size === 0) {
      return;
    }

    for (let i = this.history.length - 1; i >= 0 && unresolved.size > 0; i--) {
      const items = this.readEntryItems(i);
      if (items.length === 0) continue;

      for (const content of items) {
        if (content.type !== 'tool_call') continue;
        if (!unresolved.has(content.toolCallId)) continue;
        this.toolCallEntryIndexById.set(content.toolCallId, i);
        unresolved.delete(content.toolCallId);
        if (unresolved.size === 0) {
          break;
        }
      }
    }

    for (const toolCallId of unresolved) {
      this.toolCallEntryIndexById.set(toolCallId, null);
    }
  }

  private resolveToolCallEntryIndex(toolCallId: string): number | undefined {
    if (this.toolCallEntryIndexById.has(toolCallId)) {
      const cached = this.toolCallEntryIndexById.get(toolCallId);
      return cached === null ? undefined : cached;
    }

    for (let i = this.history.length - 1; i >= 0; i--) {
      const items = this.readEntryItems(i);
      if (
        items.some((content) => content.type === 'tool_call' && content.toolCallId === toolCallId)
      ) {
        this.toolCallEntryIndexById.set(toolCallId, i);
        return i;
      }
    }

    this.toolCallEntryIndexById.set(toolCallId, null);
    return undefined;
  }

  private resolveSubagentTaskEntryIndex(taskId: string): number | undefined {
    const cached = this.subagentTaskEntryIndexById.get(taskId);
    if (cached !== undefined) return cached;

    for (let i = this.history.length - 1; i >= 0; i--) {
      const items = this.readEntryItems(i);
      if (items.some((content) => content.type === 'subagent_task' && content.taskId === taskId)) {
        this.subagentTaskEntryIndexById.set(taskId, i);
        return i;
      }
    }

    return undefined;
  }

  private readEntryItems(entryIndex: number): MessageContent[] {
    const cached = this.parsedItemsByEntryIndex[entryIndex];
    if (cached) return cached;

    const entry = this.history[entryIndex];
    if (!entry) return [];

    const rawItems = entry.items;
    const items = Array.isArray(rawItems) ? (rawItems as unknown as MessageContent[]) : [];
    this.parsedItemsByEntryIndex[entryIndex] = items;
    return items;
  }

  private ensureEntryItems(entryIndex: number): MessageContent[] {
    const entry = this.history[entryIndex];
    if (!entry) return [];

    const rawItems = entry.items;
    const items = Array.isArray(rawItems) ? (rawItems as unknown as MessageContent[]) : [];
    if (!Array.isArray(rawItems)) {
      entry.items = items as unknown as SessionHistoryInput['items'];
      this.changed = true;
    }
    this.parsedItemsByEntryIndex[entryIndex] = items;
    return items;
  }

  private ensureActiveAssistantEntry(): number {
    if (this.targetAssistantEntryId) {
      const targetIndex = this.history.findIndex(
        (entry) => entry.role === 'assistant' && entry.id === this.targetAssistantEntryId
      );
      if (targetIndex >= 0) {
        const target = this.history[targetIndex];
        this.ensureEntryItems(targetIndex);
        if (target && !target.modelInfo && this.model) {
          target.modelInfo = this.model;
          this.changed = true;
        }
        return targetIndex;
      }
      this.history.push({
        id: this.targetAssistantEntryId,
        role: 'assistant',
        items: [] as unknown as SessionHistoryInput['items'],
        timestamp: this.now(),
        userId: undefined,
        read: undefined,
        modelInfo: this.model,
        fileDiff: [],
      });
      this.parsedItemsByEntryIndex.push([]);
      this.changed = true;
      return this.history.length - 1;
    }

    const lastIndex = this.history.length - 1;
    const last = lastIndex >= 0 ? this.history[lastIndex] : undefined;
    if (canAppendAssistantDeltas(last)) {
      this.ensureEntryItems(lastIndex);
      // Populate modelInfo if missing (e.g., placeholder entry created by web client)
      if (!last.modelInfo && this.model) {
        last.modelInfo = this.model;
        this.changed = true;
      }
      return lastIndex;
    }

    this.history.push({
      id: this.targetAssistantEntryId ?? this.createId(),
      role: 'assistant',
      items: [] as unknown as SessionHistoryInput['items'],
      timestamp: this.now(),
      userId: undefined,
      read: undefined,
      modelInfo: this.model,
      fileDiff: [],
    });
    this.parsedItemsByEntryIndex.push([]);
    this.changed = true;
    return this.history.length - 1;
  }

  private applyMessageContent(message: MessageContent) {
    switch (message.type) {
      case 'text': {
        const text = sanitizeLodyInternalInstructions(message.text);
        if (!text) return;
        const entryIndex = this.ensureActiveAssistantEntry();
        this.appendOrMergeAdjacentText(entryIndex, 'text', text);
        return;
      }
      case 'thought': {
        const text = sanitizeLodyInternalInstructions(message.text);
        if (!text) return;
        const entryIndex = this.ensureActiveAssistantEntry();
        this.appendOrMergeAdjacentText(entryIndex, 'thought', text);
        return;
      }
      case 'available_commands': {
        const entryIndex = this.ensureActiveAssistantEntry();
        this.upsertSingletonItem(entryIndex, 'available_commands', message);
        return;
      }
      case 'proposed_plan': {
        const entryIndex = this.ensureActiveAssistantEntry();
        this.upsertProposedPlanItem(entryIndex, message);
        return;
      }
      case 'tool_call': {
        const existingEntryIndex = this.resolveToolCallEntryIndex(message.toolCallId);
        if (existingEntryIndex !== undefined) {
          this.upsertToolCall(existingEntryIndex, message);
          return;
        }
        const entryIndex = this.ensureActiveAssistantEntry();
        this.upsertToolCall(entryIndex, this.stampSchedulingToolCall(message));
        this.toolCallEntryIndexById.set(message.toolCallId, entryIndex);
        return;
      }
      case 'subagent_task': {
        const existingEntryIndex = this.resolveSubagentTaskEntryIndex(message.taskId);
        const entryIndex = existingEntryIndex ?? this.ensureActiveAssistantEntry();
        this.upsertSubagentTask(entryIndex, message);
        this.subagentTaskEntryIndexById.set(message.taskId, entryIndex);
        return;
      }
      case 'image':
      case 'image_group':
      case 'file': {
        const entryIndex = this.ensureActiveAssistantEntry();
        const items = this.ensureEntryItems(entryIndex);
        items.push(message);
        this.changed = true;
        return;
      }
    }
  }

  /**
   * Stamp a scheduling tool call with its first-persisted wall-clock sighting. The
   * scheduled-tasks deriver anchors a one-shot cron's fire time at its creation moment,
   * and the turn entry's `endedAt` is NOT that moment: cron-fire follow-up turns are
   * runtime-internal steers that keep extending the same history entry, so `endedAt`
   * can land past the one-shot's fire minute and roll the resolved fire time a year
   * forward. Replay imports stamp their own import time — no worse than the turn anchor
   * they replace, and the output's `nextFireAt` still wins for one-shots there.
   */
  private stampSchedulingToolCall(message: ToolCallMessage): ToolCallMessage {
    if (message.recordedAtMs !== undefined) return message;
    if (message.toolName === undefined || !SCHEDULING_TOOL_NAMES.has(message.toolName)) {
      return message;
    }
    const recordedAtMs = Date.parse(this.now());
    if (!Number.isFinite(recordedAtMs)) return message;
    return { ...message, recordedAtMs };
  }

  /**
   * Update the plan field on the current assistant entry.
   * Plan is stored directly on the entry, not as a MessageContent item.
   */
  private updateEntryPlan(entries: SessionPlanEntry[]) {
    const entryIndex = this.ensureActiveAssistantEntry();
    const entry = this.history[entryIndex];
    if (!entry) return;

    entry.plan = entries;
    this.changed = true;
  }

  private appendOrMergeAdjacentText(
    entryIndex: number,
    kind: Extract<MessageContent, { type: 'text' | 'thought' }>['type'],
    delta: string
  ) {
    if (!delta) return;
    const items = this.ensureEntryItems(entryIndex);

    const last = items[items.length - 1];
    if (last && last.type === kind) {
      const existing = last as Extract<MessageContent, { type: typeof kind }>;
      const text = sanitizeLodyInternalInstructions(mergeStreamChunk(existing.text, delta));
      if (!text) {
        items.pop();
        this.touchedAssistantEntryIndices.add(entryIndex);
        this.changed = true;
        return;
      }
      items[items.length - 1] = {
        ...existing,
        text,
      } as MessageContent;
      this.touchedAssistantEntryIndices.add(entryIndex);
      this.changed = true;
      return;
    }

    items.push({ type: kind, text: delta } as MessageContent);
    this.touchedAssistantEntryIndices.add(entryIndex);
    this.changed = true;
  }

  private upsertSingletonItem<T extends MessageContent['type']>(
    entryIndex: number,
    type: T,
    next: Extract<MessageContent, { type: T }>
  ) {
    const entry = this.history[entryIndex];
    if (!entry) return;

    const items = this.ensureEntryItems(entryIndex);
    const last = items[items.length - 1];
    if (last && last.type === type) {
      items[items.length - 1] = next as MessageContent;
      this.changed = true;
      return;
    }

    const withoutType = items.filter((m) => m.type !== type);
    withoutType.push(next as MessageContent);
    const compacted = compactAdjacentTextAndThought(withoutType);
    entry.items = compacted as unknown as SessionHistoryInput['items'];
    this.parsedItemsByEntryIndex[entryIndex] = compacted;
    this.changed = true;
  }

  private upsertProposedPlanItem(entryIndex: number, next: ProposedPlanMessage) {
    const entry = this.history[entryIndex];
    if (!entry) return;

    const items = this.ensureEntryItems(entryIndex);
    const existingIndex = items.findIndex(
      (item) => item.type === 'proposed_plan' && item.turnId === next.turnId
    );
    if (existingIndex >= 0) {
      items[existingIndex] = next;
      this.changed = true;
      return;
    }

    items.push(next);
    const compacted = compactAdjacentTextAndThought(items);
    entry.items = compacted as unknown as SessionHistoryInput['items'];
    this.parsedItemsByEntryIndex[entryIndex] = compacted;
    this.changed = true;
  }

  private upsertToolCall(entryIndex: number, incoming: ToolCallMessage) {
    const entry = this.history[entryIndex];
    if (!entry) return;

    const items = this.ensureEntryItems(entryIndex);
    const toolIndex = items.findIndex(
      (m) => m.type === 'tool_call' && (m as ToolCallMessage).toolCallId === incoming.toolCallId
    );
    if (toolIndex >= 0) {
      const prevTool = items[toolIndex] as ToolCallMessage;
      items[toolIndex] = mergeToolCallMessage(prevTool, incoming);
      this.changed = true;
      return;
    }

    items.push({
      ...incoming,
      status: incoming.status || 'pending',
      content: incoming.content
        ? compactToolCallContentForHistory(incoming.content, {
            kind: (incoming.kind ?? undefined) as ToolKind | null | undefined,
          })
        : undefined,
    });
    this.changed = true;
  }

  private upsertSubagentTask(
    entryIndex: number,
    incoming: Extract<MessageContent, { type: 'subagent_task' }>
  ) {
    const entry = this.history[entryIndex];
    if (!entry) return;

    const items = this.ensureEntryItems(entryIndex);
    const idx = items.findIndex((m) => m.type === 'subagent_task' && m.taskId === incoming.taskId);
    if (idx >= 0) {
      const prev = items[idx] as Extract<MessageContent, { type: 'subagent_task' }>;
      // Later events win per field, earlier-only fields (subagentType/description) survive.
      items[idx] = { ...mergeSubagentTaskPayload(prev, incoming), type: 'subagent_task' };
      this.changed = true;
      return;
    }

    items.push(incoming);
    this.changed = true;
  }

  /**
   * Post-process text content to extract <thinking> tags into thought blocks.
   *
   * Claude Code streams <thinking>...</thinking> tags across multiple agent_message_chunk
   * notifications. We can only parse them after all chunks are merged into a single text block.
   */
  private postProcessTouchedAssistantEntries() {
    for (const entryIndex of this.touchedAssistantEntryIndices) {
      const entry = this.history[entryIndex];
      if (!entry || entry.role !== 'assistant') continue;

      const items = this.readEntryItems(entryIndex);
      let modified = false;
      const newItems: MessageContent[] = [];

      for (const item of items) {
        if (item.type !== 'text') {
          newItems.push(item);
          continue;
        }

        const text = item.text;
        if (!text.includes('<thinking>') && !text.includes('<proposed_plan>')) {
          newItems.push(item);
          continue;
        }

        const parsed = parseAssistantTextTags(text, entry.id);

        if (
          parsed.length !== 1 ||
          parsed[0]?.type !== 'text' ||
          (parsed[0]?.type === 'text' && parsed[0].text !== text)
        ) {
          newItems.push(...parsed);
          modified = true;
        } else {
          newItems.push(item);
        }
      }

      if (modified) {
        // Compact adjacent text/thought blocks that may have been created
        const compacted = compactAdjacentTextAndThought(newItems);
        entry.items = compacted as unknown as SessionHistoryInput['items'];
        this.parsedItemsByEntryIndex[entryIndex] = compacted;
        this.changed = true;
      }
    }
  }
}

export const applyNotificationOnHistory = (
  history: SessionHistoryInput[],
  notifications: AcpSessionNotification[],
  model?: ModelInfo,
  options: ApplyNotificationOnHistoryOptions = {}
): SessionHistoryInput[] => {
  return new NotificationOnHistoryApplier(history, options, model).apply(notifications);
};

export const applyNotificationOnHistoryWithChange = (
  history: SessionHistoryInput[],
  notifications: AcpSessionNotification[],
  model?: ModelInfo,
  options: ApplyNotificationOnHistoryOptions = {}
): { history: SessionHistoryInput[]; changed: boolean } => {
  const applier = new NotificationOnHistoryApplier(history, options, model);
  const nextHistory = applier.apply(notifications);
  return { history: nextHistory, changed: applier.hasChanges() };
};

/**
 * Batch process multiple message contents in O(n) time complexity.
 * This avoids the O(n²) cost of calling applyMessageContent repeatedly.
 *
 * IMPORTANT: This preserves the chronological ordering of messages.
 * When an `available_commands` or new `tool_call` is encountered, accumulated
 * text/thought/plan deltas are flushed first to maintain correct order.
 */
export type ApplyMessageContentsBatchOptions = {
  createId?: () => string;
  now?: () => string;
  targetAssistantEntryId?: string;
  model?: ModelInfo;
};

export const applyMessageContentsBatch = (
  history: SessionHistoryInput[],
  messages: MessageContent[],
  options: ApplyMessageContentsBatchOptions = {}
): SessionHistoryInput[] => {
  // Fast-path: nothing to apply.
  if (messages.length === 0) {
    return history;
  }

  // Dependency injection for deterministic tests (IDs/timestamps).
  const createId = options.createId ?? defaultCreateId;
  const now = options.now ?? (() => new Date().toISOString());

  type EntryState = {
    // The underlying persisted history entry we will (maybe) rewrite.
    entry: SessionHistoryInput;
    // Working set of items for `entry` (always normalized to `MessageContent[]`).
    items: MessageContent[];
    // Whether `entry` needs to be rewritten because `items` changed.
    dirty: boolean;
  };

  const parseEntryItems = (entry: SessionHistoryInput): MessageContent[] => {
    const rawItems = entry.items;
    return Array.isArray(rawItems) ? (rawItems as unknown as MessageContent[]) : [];
  };

  const writeEntryItems = (
    entry: SessionHistoryInput,
    items: MessageContent[]
  ): SessionHistoryInput => {
    return {
      ...entry,
      items: items as unknown as SessionHistoryInput['items'],
    };
  };

  const createAssistantEntryState = (): EntryState => ({
    entry: {
      id: options.targetAssistantEntryId ?? createId(),
      role: 'assistant',
      items: [] as unknown as SessionHistoryInput['items'],
      timestamp: now(),
      userId: undefined,
      read: undefined,
      modelInfo: options.model,
      fileDiff: [],
    },
    items: [],
    dirty: true,
  });

  // Normalize existing history entries into mutable `EntryState`s.
  const entryStates: EntryState[] = history.map((entry) => {
    return { entry, items: parseEntryItems(entry), dirty: false };
  });

  const ensureActiveAssistantEntry = (): number => {
    if (options.targetAssistantEntryId) {
      const targetIndex = entryStates.findIndex(
        (state) =>
          state.entry.role === 'assistant' && state.entry.id === options.targetAssistantEntryId
      );
      if (targetIndex >= 0) {
        const target = entryStates[targetIndex];
        if (target && !target.entry.modelInfo && options.model) {
          target.entry = {
            ...target.entry,
            modelInfo: options.model,
          };
          target.dirty = true;
        }
        return targetIndex;
      }
      entryStates.push(createAssistantEntryState());
      return entryStates.length - 1;
    }

    // We append assistant deltas to the latest assistant entry whenever possible.
    // If history ends with a non-assistant entry (e.g. user), we create a new assistant entry.
    const lastIndex = entryStates.length - 1;
    const last = lastIndex >= 0 ? entryStates[lastIndex] : undefined;
    if (last && canAppendAssistantDeltas(last.entry)) {
      if (!last.entry.modelInfo && options.model) {
        last.entry = {
          ...last.entry,
          modelInfo: options.model,
        };
        last.dirty = true;
      }
      return lastIndex;
    }
    entryStates.push(createAssistantEntryState());
    return entryStates.length - 1;
  };

  const appendOrMergeAdjacentText = (
    entryIndex: number,
    kind: Extract<MessageContent, { type: 'text' | 'thought' }>['type'],
    delta: string
  ) => {
    if (!delta) return;
    const state = entryStates[entryIndex];
    if (!state) return;

    // Most ACP updates stream text/thought in many small deltas.
    // Keep the stored representation compact by merging adjacent deltas.
    const last = state.items[state.items.length - 1];
    if (last && last.type === kind) {
      const existing = last as Extract<MessageContent, { type: typeof kind }>;
      const text = sanitizeLodyInternalInstructions(mergeStreamChunk(existing.text, delta));
      if (text) {
        state.items[state.items.length - 1] = {
          ...existing,
          text,
        } as MessageContent;
      } else {
        state.items.pop();
      }
    } else {
      state.items.push({ type: kind, text: delta } as MessageContent);
    }
    state.dirty = true;
  };

  const upsertSingletonItem = <T extends MessageContent['type']>(
    entryIndex: number,
    type: T,
    next: Extract<MessageContent, { type: T }>
  ) => {
    const state = entryStates[entryIndex];
    if (!state) return;

    const last = state.items[state.items.length - 1];
    if (last && last.type === type) {
      // Common case: the singleton is already the last item (cheap overwrite).
      state.items[state.items.length - 1] = next as MessageContent;
      state.dirty = true;
      return;
    }

    // Singleton semantics: there should only be one `available_commands` per entry,
    // representing the "current snapshot". Replace any existing item of that type.
    const withoutType = state.items.filter((m) => m.type !== type);
    withoutType.push(next as MessageContent);
    state.items = compactAdjacentTextAndThought(withoutType);
    state.dirty = true;
  };

  const upsertProposedPlanItem = (entryIndex: number, next: ProposedPlanMessage) => {
    const state = entryStates[entryIndex];
    if (!state) return;

    const existingIndex = state.items.findIndex(
      (item) => item.type === 'proposed_plan' && item.turnId === next.turnId
    );
    if (existingIndex >= 0) {
      state.items[existingIndex] = next;
      state.dirty = true;
      return;
    }

    state.items.push(next);
    state.items = compactAdjacentTextAndThought(state.items);
    state.dirty = true;
  };

  const upsertToolCall = (entryIndex: number, incoming: ToolCallMessage) => {
    const state = entryStates[entryIndex];
    if (!state) return;

    // Tool calls are keyed by `toolCallId` (not by position).
    // We merge updates into the original entry whenever possible.
    const toolIndex = state.items.findIndex(
      (m) => m.type === 'tool_call' && (m as ToolCallMessage).toolCallId === incoming.toolCallId
    );
    if (toolIndex >= 0) {
      const prevTool = state.items[toolIndex] as ToolCallMessage;
      state.items[toolIndex] = mergeToolCallMessage(prevTool, incoming);
    } else {
      state.items.push({
        ...incoming,
        status: incoming.status || 'pending',
        content: incoming.content
          ? compactToolCallContentForHistory(incoming.content, {
              kind: (incoming.kind ?? undefined) as ToolKind | null | undefined,
            })
          : undefined,
      });
    }
    state.dirty = true;
  };

  const appendMessageContent = (entryIndex: number, message: MessageContent) => {
    const state = entryStates[entryIndex];
    if (!state) return;
    state.items.push(message);
    state.dirty = true;
  };

  // Build an index of existing tool calls so updates can be applied to the entry where the
  // tool call originally appeared (instead of always appending to the latest assistant entry).
  const toolCallEntryIndexById = new Map<string, number>();
  for (let i = 0; i < entryStates.length; i++) {
    const state = entryStates[i];
    if (!state) continue;
    for (const content of state.items) {
      if (content.type === 'tool_call') {
        toolCallEntryIndexById.set(content.toolCallId, i);
      }
    }
  }

  // Single pass over incoming message deltas (O(n) in number of deltas + history size).
  for (const message of messages) {
    switch (message.type) {
      case 'text': {
        const text = sanitizeLodyInternalInstructions(message.text);
        if (!text) break;
        const entryIndex = ensureActiveAssistantEntry();
        appendOrMergeAdjacentText(entryIndex, 'text', text);
        break;
      }
      case 'thought': {
        const text = sanitizeLodyInternalInstructions(message.text);
        if (!text) break;
        const entryIndex = ensureActiveAssistantEntry();
        appendOrMergeAdjacentText(entryIndex, 'thought', text);
        break;
      }
      case 'plan': {
        // Plan is stored as a field on the entry, not as a MessageContent item
        const entryIndex = ensureActiveAssistantEntry();
        const state = entryStates[entryIndex];
        if (state) {
          state.entry.plan = message.entries;
          state.dirty = true;
        }
        break;
      }
      case 'available_commands': {
        const entryIndex = ensureActiveAssistantEntry();
        upsertSingletonItem(entryIndex, 'available_commands', message);
        break;
      }
      case 'proposed_plan': {
        const entryIndex = ensureActiveAssistantEntry();
        upsertProposedPlanItem(entryIndex, message);
        break;
      }
      case 'tool_call': {
        // Unlike other message types, tool calls can receive future updates that should
        // modify the original tool call entry (by `toolCallId`), not the "current" entry.
        const existingEntryIndex = toolCallEntryIndexById.get(message.toolCallId);
        if (existingEntryIndex !== undefined) {
          upsertToolCall(existingEntryIndex, message);
        } else {
          const entryIndex = ensureActiveAssistantEntry();
          upsertToolCall(entryIndex, message);
          toolCallEntryIndexById.set(message.toolCallId, entryIndex);
        }
        break;
      }
      case 'image':
      case 'image_group':
      case 'file': {
        const entryIndex = ensureActiveAssistantEntry();
        appendMessageContent(entryIndex, message);
        break;
      }
    }
  }

  for (const state of entryStates) {
    if (!state.dirty || state.entry.role !== 'assistant') continue;

    let modified = false;
    const newItems: MessageContent[] = [];
    for (const item of state.items) {
      if (item.type !== 'text') {
        newItems.push(item);
        continue;
      }
      if (!item.text.includes('<thinking>') && !item.text.includes('<proposed_plan>')) {
        newItems.push(item);
        continue;
      }
      const parsed = parseAssistantTextTags(item.text, state.entry.id);
      if (
        parsed.length !== 1 ||
        parsed[0]?.type !== 'text' ||
        (parsed[0]?.type === 'text' && parsed[0].text !== item.text)
      ) {
        newItems.push(...parsed);
        modified = true;
      } else {
        newItems.push(item);
      }
    }

    if (modified) {
      state.items = compactAdjacentTextAndThought(newItems);
    }
  }

  // Materialize the updated history, rewriting only dirty entries to avoid churn.
  return entryStates.map((state) => {
    if (!state.dirty) return state.entry;
    return writeEntryItems(state.entry, state.items);
  });
};
