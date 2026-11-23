import { parseLodyMessagePhase } from './schema';
import type { MessageContent, ModelInfo, SubagentRunItem } from '../ai';
import { isLodySubagentEvent, type LodySubagentEvent } from 'acp-extension-core';
import type { SessionHistoryInput, SessionPlanEntry } from '../schema';
import type { AgentHistoryTargets } from '../history-agent-window';
import { sanitizeLodyInternalInstructions } from '../goal';
import { Immer, enablePatches, type Patch } from 'immer';
import {
  mergeHistoryStreamText as mergeStreamText,
  hasAssistantTextTags,
  shouldDedupeHistoryChunk as shouldDedupeChunk,
} from '../history-stream-text';

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
  truncateToolTextForHistory,
} from './tool-call-history';
import {
  parseLodyTaskMeta,
  parseSubagentTaskWire,
  mergeSubagentTaskPayload,
} from './claude-subagent-task';
import { parseCodexCollabAgentTasks } from './codex-collab-agent-task';
import {
  getDevinSubagentContextId,
  hasOtherDevinSubagentMeta,
  parseDevinSubagentTaskMeta,
} from './devin-subagent-task';

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

const boundJsonValueForHistory = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (typeof value === 'string') return truncateToolTextForHistory(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const bounded = boundJsonValueForHistory(item, seen);
      if (bounded !== item) changed = true;
      return bounded;
    });
    return changed ? next : value;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const bounded = boundJsonValueForHistory(v, seen);
    if (bounded !== v) changed = true;
    next[k] = bounded;
  }
  return changed ? next : value;
};

const arePlanEntriesEqual = (
  a: readonly SessionPlanEntry[] | undefined,
  b: readonly SessionPlanEntry[]
): boolean => {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      !left ||
      !right ||
      left.status !== right.status ||
      left.content !== right.content ||
      left.priority !== right.priority
    ) {
      return false;
    }
  }
  return true;
};

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

/**
 * Durable budget for one `terminal_command` (command plus args, UTF-8 bytes).
 * Agents inline whole files or base64 images into shell commands; the stored
 * command is a display label, and the full text stays with the agent.
 */
export const MAX_STORED_TERMINAL_COMMAND_BYTES = 1024;
const TERMINAL_COMMAND_TRUNCATION_MARKER = '…';
const TERMINAL_COMMAND_TRUNCATION_MARKER_BYTES = 3;

/**
 * The longest head of `value` within `maxBytes` UTF-8 bytes that does not split
 * a code point. Counts in place so a multi-megabyte string is never encoded.
 */
const utf8Head = (value: string, maxBytes: number): { end: number; bytes: number } => {
  let end = 0;
  let bytes = 0;
  while (end < value.length) {
    const unit = value.charCodeAt(end);
    const isPair =
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      end + 1 < value.length &&
      (value.charCodeAt(end + 1) & 0xfc00) === 0xdc00;
    const width = unit < 0x80 ? 1 : unit < 0x800 ? 2 : isPair ? 4 : 3;
    if (bytes + width > maxBytes) break;
    bytes += width;
    end += isPair ? 2 : 1;
  }
  return { end, bytes };
};

/** Keep the head of a command and its args within one shared 1 KiB budget. */
export const truncateTerminalCommandForHistory = <
  T extends { command: string; args?: string[]; truncated?: boolean },
>(
  block: T
): T => {
  const parts = [block.command, ...(block.args ?? [])];
  let remaining = MAX_STORED_TERMINAL_COMMAND_BYTES;
  let fits = true;
  for (const part of parts) {
    const head = utf8Head(part, remaining);
    if (head.end < part.length) {
      fits = false;
      break;
    }
    remaining -= head.bytes;
  }
  if (fits) return block;

  let budget = MAX_STORED_TERMINAL_COMMAND_BYTES - TERMINAL_COMMAND_TRUNCATION_MARKER_BYTES;
  const kept: string[] = [];
  for (const part of parts) {
    const head = utf8Head(part, budget);
    if (head.end === part.length) {
      kept.push(part);
      budget -= head.bytes;
      continue;
    }
    kept.push(part.slice(0, head.end) + TERMINAL_COMMAND_TRUNCATION_MARKER);
    break;
  }
  const [command = '', ...args] = kept;
  return { ...block, command, ...(block.args === undefined ? {} : { args }), truncated: true };
};

/**
 * Agents often use the full shell command as a tool title, so the title gets
 * the same head-keeping 1 KiB bound as the command it repeats.
 */
export const truncateToolTitleForHistory = <T extends string | null | undefined>(title: T): T =>
  typeof title === 'string'
    ? (truncateTerminalCommandForHistory({ command: title }).command as T)
    : title;

/**
 * Whether a stored tool title is the output of `truncateToolTitleForHistory`.
 * Titles have no flag field: a cut title ends with the marker and fills the
 * budget to within one code point, which an ordinary title practically never does.
 */
export const isToolTitleTruncatedForHistory = (title: string): boolean => {
  if (!title.endsWith(TERMINAL_COMMAND_TRUNCATION_MARKER)) return false;
  const { end, bytes } = utf8Head(title, MAX_STORED_TERMINAL_COMMAND_BYTES);
  return end === title.length && bytes > MAX_STORED_TERMINAL_COMMAND_BYTES - 4;
};

const normalizeTerminalCommandsForHistory = (
  contents: StoredToolCallContent
): StoredToolCallContent =>
  contents.some((block) => block.type === 'terminal_command')
    ? contents.map((block) =>
        block.type === 'terminal_command' ? truncateTerminalCommandForHistory(block) : block
      )
    : contents;

const extractTerminalCommandContent = (
  rawInput: unknown,
  kind?: ToolKind | null
): StoredToolCallContent => {
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
  const parsed = parseCodexTerminalOutput(rawOutput);
  if (parsed) {
    return buildTerminalOutputBlocks(parsed);
  }

  if (
    typeof rawOutput === 'string' &&
    rawOutput.length > 0 &&
    !NON_TERMINAL_TOOL_KINDS.has(kind ?? '')
  ) {
    return buildTerminalOutputBlocks({ output: rawOutput });
  }

  if (kind === 'execute') {
    const content = asRecordOrUndefined(rawOutput)?.content;
    if (Array.isArray(content)) {
      const output = content
        .flatMap((block) => {
          const record = asRecordOrUndefined(block);
          return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
        })
        .join('');
      if (output.length > 0) return buildTerminalOutputBlocks({ output });
    }
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
  let compacted = contents.filter((block) => {
    if (block.type !== 'content' || !('content' in block)) return true;
    if (block.content.type !== 'text') return true;
    return (block.content.text ?? '').trim().length > 0;
  });

  compacted = dedupeAdjacentToolCallContent(compacted);

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
          compacted[existingIndex] = {
            ...existing,
            output: existing.output + latest.snapshot.slice(existing.output.length),
            stream: 'combined',
          };
        } else {
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
  compacted = normalizeTerminalCommandsForHistory(compacted);

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
      last.type === nextItem.type &&
      (last.type !== 'text' ||
        nextItem.type !== 'text' ||
        last.messagePhase === nextItem.messagePhase)
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

function mergeTerminalOutputSnapshot(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current) return incoming;

  if (incoming.startsWith(current)) {
    return current + incoming.slice(current.length);
  }

  if (incoming === current) {
    return current;
  }

  if (shouldDedupeChunk(incoming) && current.endsWith(incoming)) {
    return current;
  }

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

export type AgentHistoryTextAppend = {
  turnId: string;
  itemIndex: number;
  previous: string;
  value: string;
  text: string;
};

const mergeToolCallMessage = (
  prev: ToolCallMessage,
  incoming: ToolCallMessage,
  replaceContent = false
): ToolCallMessage => {
  const nextKind = (incoming.kind ?? prev.kind) as ToolKind | null | undefined;

  const mergedContent: StoredToolCallContent = replaceContent
    ? (prev.content ?? []).filter((block) => block.type === 'terminal_command')
    : [...(prev.content ?? [])];
  const nextChunks = incoming.content ?? [];

  if (nextChunks.length > 0) {
    const diffChunks = nextChunks.filter((c) => c.type === 'diff') as Extract<
      StoredToolCallContent[number],
      { type: 'diff' }
    >[];
    if (diffChunks.length > 0) {
      if (nextKind === 'edit') {
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

        const replaceCount = Math.min(existingDiffIndices.length, diffChunks.length);
        for (let i = 0; i < replaceCount; i++) {
          const idx = existingDiffIndices[i];
          const diff = diffChunks[i];
          if (idx === undefined || !diff) continue;
          mergedContent[idx] = diff;
        }

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
      const hasCombined = nextTerminalOutputs.some((o) => (o.stream ?? 'combined') === 'combined');
      if (hasCombined) {
        const combined = nextTerminalOutputs.find((o) => (o.stream ?? 'combined') === 'combined');
        if (combined) {
          const existingIndex = mergedContent.findIndex(
            (c) => c.type === 'terminal_output' && (c.stream ?? 'combined') === 'combined'
          );
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

  const statusRank = { pending: 0, in_progress: 1, completed: 2, failed: 2 } as const;
  const nextStatus =
    statusRank[incoming.status] < statusRank[prev.status] ? prev.status : incoming.status;

  return {
    ...prev,
    toolCallId: incoming.toolCallId,
    title: truncateToolTitleForHistory(incoming.title ?? prev.title),
    kind: nextKind ?? undefined,
    status: nextStatus,
    content: mergedContent.length
      ? compactToolCallContentForHistory(mergedContent, { kind: nextKind })
      : replaceContent
        ? []
        : prev.content,
    locations: incoming.locations !== undefined ? incoming.locations : prev.locations,
    rawInput: incoming.rawInput !== undefined ? incoming.rawInput : prev.rawInput,
    rawOutput: incoming.rawOutput !== undefined ? incoming.rawOutput : prev.rawOutput,
    schedulingTimeZone:
      incoming.schedulingTimeZone !== undefined
        ? incoming.schedulingTimeZone
        : prev.schedulingTimeZone,
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

  if (lastIndex < text.length) {
    const textAfter = text.slice(lastIndex);
    if (textAfter) {
      result.push({ type: 'text', text: textAfter });
    }
  }

  if (result.length === 0) {
    return [{ type: 'text', text }];
  }

  return result;
};

const parseCodexProposedPlanTags = (text: string, turnId: string): MessageContent[] => {
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
      markdown: truncateToolTextForHistory(markdown),
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

type ToolUpdate = Extract<
  AcpSessionNotification['update'],
  { sessionUpdate: 'tool_call' | 'tool_call_update' }
>;

const toolUpdateSubagentTasks = (update: ToolUpdate): MessageContent[] => {
  const subagentTask =
    parseLodyTaskMeta((update as ToolCallUpdateWithMeta)._meta) ??
    parseDevinSubagentTaskMeta((update as ToolCallUpdateWithMeta)._meta) ??
    parseSubagentTaskWire(update.rawInput);
  if (subagentTask) {
    const devinSubagentId = getDevinSubagentContextId((update as ToolCallUpdateWithMeta)._meta);
    return [
      {
        type: 'subagent_task',
        ...(devinSubagentId !== null ? { parentTaskId: devinSubagentId } : {}),
        ...subagentTask,
      },
    ];
  }
  return parseCodexCollabAgentTasks(update.title, update.rawInput).map((task) => ({
    type: 'subagent_task',
    ...task,
  }));
};

/** Dependencies for a sparse history write; undefined only for structural/singleton updates. */
export const targetLocalHistoryTargets = (
  notifications: readonly AcpSessionNotification[]
): AgentHistoryTargets | undefined => {
  const tools = new Set<string>();
  const tasks = new Set<string>();
  let rootTail = false;
  const rootTailIfTaskMissing = new Set<string>();
  const runs = new Map<
    string,
    { sessionId: string; runId: string; tail: boolean; plan: boolean; toolCallIds: string[] }
  >();
  const run = (sessionId: string, runId: string) => {
    const key = JSON.stringify([sessionId, runId]);
    let target = runs.get(key);
    if (!target)
      runs.set(key, (target = { sessionId, runId, tail: false, plan: false, toolCallIds: [] }));
    return target;
  };
  for (const { sessionId, update } of notifications) {
    const context = getDevinSubagentContextId(update._meta);
    if (context !== null) tasks.add(context);
    switch (update.sessionUpdate) {
      case 'subagent_event': {
        const event = update.event;
        if (!isLodySubagentEvent(event) || event.sessionId !== sessionId) continue;
        const target = run(event.sessionId, event.runId);
        if (event.type === 'snapshot') {
          if (event.snapshot.parentRunId) run(event.sessionId, event.snapshot.parentRunId);
          if (event.snapshot.parentToolCallId) tools.add(event.snapshot.parentToolCallId);
        } else if (event.type === 'output') {
          if (
            (event.update.sessionUpdate === 'agent_message_chunk' ||
              event.update.sessionUpdate === 'agent_thought_chunk') &&
            event.update.content.type === 'text'
          )
            target.tail = true;
          if (event.update.sessionUpdate === 'plan') target.plan = true;
          if (
            event.update.sessionUpdate === 'tool_call' ||
            event.update.sessionUpdate === 'tool_call_update'
          )
            target.toolCallIds.push(event.update.toolCallId);
        }
        continue;
      }
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
        if (update.content.type === 'text' && update.content.text.length > 0) {
          if (context !== null && !hasOtherDevinSubagentMeta(update._meta))
            rootTailIfTaskMissing.add(context);
          else rootTail = true;
        }
        continue;
      case 'user_message_chunk':
      case 'config_option_update':
      case 'usage_update':
      case 'plan':
        continue;
      case 'plan_update':
        if (update.plan.type !== 'items') return undefined;
        continue;
      case 'tool_call':
      case 'tool_call_update':
        tools.add(update.toolCallId);
        for (const task of toolUpdateSubagentTasks(update))
          if (task.type === 'subagent_task') tasks.add(task.taskId);
        continue;
      default:
        return undefined;
    }
  }
  return {
    toolCallIds: [...tools],
    taskIds: [...tasks],
    rootTail,
    rootTailIfTaskMissing: [...rootTailIfTaskMissing],
    runs: [...runs.values()],
  };
};

/** Compatibility for callers that only support the original tool-only window. */
export const targetLocalToolCallIds = (
  notifications: readonly AcpSessionNotification[]
): string[] | undefined => {
  const targets = targetLocalHistoryTargets(notifications);
  return targets && targets.taskIds.length === 0 && targets.runs.length === 0
    ? [...targets.toolCallIds]
    : undefined;
};

/** One storage projection for root and normalized child tools, before any CRDT write. */
const buildToolCallMessageForHistory = (
  update: Extract<
    AcpSessionNotification['update'],
    { sessionUpdate: 'tool_call' | 'tool_call_update' }
  >,
  previousTool?: ToolCallMessage
): ToolCallMessage => {
  const kind = (update.kind ?? previousTool?.kind) as ToolKind | null | undefined;

  let baseContent: StoredToolCallContent = update.content ? [...update.content] : [];
  baseContent = stripToolCallContentForHistory(kind, baseContent);

  let derivedCommand = extractTerminalCommandContent(update.rawInput, kind);

  if (derivedCommand.length === 0) {
    derivedCommand = extractTerminalCommandFromContent(baseContent);
  }

  let derivedOutput: StoredToolCallContent = [];
  if (kind !== 'read') {
    const meta = (update as ToolCallUpdateWithMeta)._meta;
    if (isClaudeCodeTool(meta)) {
      derivedOutput = extractClaudeCodeTerminalOutputContent(meta);
    }

    if (derivedOutput.length === 0) {
      derivedOutput = extractTerminalOutputContent(update.rawOutput, kind);
    }
  }

  if (derivedOutput.length > 0) {
    baseContent = baseContent.filter((c) => c.type !== 'terminal');

    const candidateOutputs = new Set(
      derivedOutput
        .filter((b) => b.type === 'terminal_output')
        .map((b) => normalizeTerminalOutputForComparison(b.output))
    );
    baseContent = baseContent.filter((c) => {
      if (c.type !== 'content') return true;
      if (!('content' in c)) return true;
      if (c.content.type !== 'text') return true;
      const fenced = extractSingleFencedBlock(c.content.text);
      if (fenced && candidateOutputs.has(normalizeTerminalOutputForComparison(fenced.body))) {
        return false;
      }
      const plainText = c.content.text.trim();
      if (
        plainText.length > 0 &&
        (candidateOutputs.has(normalizeTerminalOutputForComparison(plainText)) ||
          candidateOutputs.has(normalizeTerminalOutputForComparison(c.content.text)))
      ) {
        return false;
      }
      return true;
    });
  }

  const derived: StoredToolCallContent = [...derivedCommand, ...derivedOutput];
  const content = compactToolCallContentForHistory([...baseContent, ...derived], { kind });
  const explicitLocations = Array.isArray(update.locations) ? update.locations : undefined;
  const locations =
    explicitLocations ??
    deriveLocationsFromToolCallContent(update.content) ??
    deriveLocationsFromRawInput(update.rawInput);
  const toolName =
    resolveAcpToolName((update as ToolCallUpdateWithMeta)._meta) ?? previousTool?.toolName;
  const activityKind = getToolCallActivityKind((update as ToolCallUpdateWithMeta)._meta);
  const isSchedulingTool = toolName !== undefined && SCHEDULING_TOOL_NAMES.has(toolName);
  const input = asRecordOrUndefined(update.rawInput);
  return {
    type: 'tool_call',
    toolCallId: update.toolCallId,
    title: truncateToolTitleForHistory(update.title),
    toolName,
    kind: kind ?? undefined,
    status: update.status ?? previousTool?.status ?? 'pending',
    content: content.length ? content : undefined,
    locations,
    rawInput: isSchedulingTool
      ? (boundJsonValueForHistory(input) as Record<string, unknown> | undefined)
      : kind === 'switch_mode' && typeof input?.plan === 'string'
        ? { plan: truncateToolTextForHistory(input.plan) }
        : undefined,
    rawOutput: isSchedulingTool
      ? (boundJsonValueForHistory(asRecordOrUndefined(update.rawOutput)) as
          | Record<string, unknown>
          | undefined)
      : undefined,
    schedulingTimeZone: isSchedulingTool ? resolveMachineTimeZone() : undefined,
    activityKind,
  };
};

export const buildMessageContentFromNotification = (
  message: AcpSessionNotification,
  previousTool?: ToolCallMessage
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
          const messagePhase = parseLodyMessagePhase(update._meta);
          return [
            { type: 'text', text: update.content.text, ...(messagePhase ? { messagePhase } : {}) },
          ];
        case 'image':
        case 'audio':
        case 'resource_link':
        case 'resource':
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
      const subagentTasks = toolUpdateSubagentTasks(update);
      if (subagentTasks.length > 0) return subagentTasks;

      return [buildToolCallMessageForHistory(update, previousTool)];
    }
    case 'plan':
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
              markdown: truncateToolTextForHistory(update.plan.content),
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
      return [];
    case 'current_mode_update':
      return [];
    case 'session_info_update':
      const { title } = update;
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

  private readonly parsedItemsByEntryIndex: Array<MessageContent[] | null>;
  private readonly toolCallEntryIndexById = new Map<string, number | null>();
  private readonly subagentTaskEntryIndexById = new Map<string, number | null>();
  private readonly touchedAssistantEntryIndices = new Set<number>();
  private runIndex: Map<string, { entryIndex: number; itemIndex: number }> | undefined;
  private changed = false;

  constructor(
    history: SessionHistoryInput[],
    options: ApplyNotificationOnHistoryOptions,
    private model?: ModelInfo,
    private readonly textAppends?: AgentHistoryTextAppend[]
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
      if (update.sessionUpdate === 'subagent_event') {
        if (
          isLodySubagentEvent(update.event) &&
          update.event.sessionId === notification.sessionId
        ) {
          this.applySubagentEvent(update.event);
        }
        continue;
      }

      const devinSubagentOwnerId = getDevinSubagentContextId(update._meta);
      if (
        devinSubagentOwnerId !== null &&
        !hasOtherDevinSubagentMeta(update._meta) &&
        this.resolveSubagentTaskEntryIndex(devinSubagentOwnerId) !== undefined &&
        ((update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') ||
          this.resolveToolCallEntryIndex(update.toolCallId) === undefined)
      ) {
        continue;
      }

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

      if (update.sessionUpdate === 'plan') {
        this.updateEntryPlan(update.entries);
        continue;
      }
      if (update.sessionUpdate === 'plan_update' && update.plan.type === 'items') {
        this.updateEntryPlan(update.plan.entries);
        continue;
      }

      const toolUpdate =
        update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
          ? update
          : undefined;
      const entryIndex = toolUpdate
        ? this.resolveToolCallEntryIndex(toolUpdate.toolCallId)
        : undefined;
      const previousTool =
        entryIndex === undefined
          ? undefined
          : this.readEntryItems(entryIndex).find(
              (item): item is ToolCallMessage =>
                item.type === 'tool_call' && item.toolCallId === toolUpdate?.toolCallId
            );
      const contents = buildMessageContentFromNotification(notification, previousTool);
      for (const message of contents) {
        this.applyMessageContent(message, toolUpdate?.content != null);
      }
    }

    this.postProcessTouchedAssistantEntries();

    return this.history;
  }

  hasChanges(): boolean {
    return this.changed;
  }

  private findRun(sessionId: string, runId: string) {
    if (!this.runIndex) {
      this.runIndex = new Map();
      for (let entryIndex = 0; entryIndex < this.history.length; entryIndex++) {
        this.readEntryItems(entryIndex).forEach((item, itemIndex) => {
          if (item.type !== 'subagent_task' || !item.run) return;
          const key = JSON.stringify([item.run.sessionId, item.taskId]);
          if (!this.runIndex!.has(key)) this.runIndex!.set(key, { entryIndex, itemIndex });
        });
      }
    }
    const found = this.runIndex.get(JSON.stringify([sessionId, runId]));
    if (!found) return undefined;
    const task = this.readEntryItems(found.entryIndex)[found.itemIndex];
    return task?.type === 'subagent_task' ? { ...found, task } : undefined;
  }

  /** Run identity includes the ACP root; children never alter parent turn metadata. */
  private applySubagentEvent(event: LodySubagentEvent) {
    const existing = this.findRun(event.sessionId, event.runId);
    if (!existing && event.type !== 'snapshot') return;
    const previousRun = existing?.task.run;
    const terminal =
      previousRun && ['completed', 'failed', 'cancelled'].includes(previousRun.snapshot.state);
    if (terminal && event.type !== 'snapshot') return;
    if (
      terminal &&
      event.type === 'snapshot' &&
      event.snapshot.state !== previousRun.snapshot.state
    )
      return;

    let entryIndex = existing?.entryIndex;
    if (event.type === 'snapshot') {
      let parentId = event.snapshot.parentRunId;
      const seen = new Set([event.runId]);
      while (parentId) {
        if (seen.has(parentId)) return;
        seen.add(parentId);
        const parent = this.findRun(event.sessionId, parentId);
        if (!parent) return;
        entryIndex ??= parent.entryIndex;
        parentId = parent.task.run?.snapshot.parentRunId;
      }
      if (entryIndex === undefined && event.snapshot.parentToolCallId) {
        entryIndex = this.resolveToolCallEntryIndex(event.snapshot.parentToolCallId);
      }
      if (entryIndex === undefined && this.targetAssistantEntryId)
        entryIndex = this.ensureActiveAssistantEntry();
      if (entryIndex === undefined) return;
      const snapshot = {
        ...event.snapshot,
        ...(previousRun?.snapshot.outputIncomplete ? { outputIncomplete: true as const } : {}),
      };
      if (previousRun && JSON.stringify(previousRun.snapshot) === JSON.stringify(snapshot)) return;
      const state = snapshot.state;
      const task: Extract<MessageContent, { type: 'subagent_task' }> = {
        type: 'subagent_task',
        taskId: event.runId,
        taskKind: 'subagent',
        status:
          state === 'running' || state === 'unknown'
            ? 'in_progress'
            : state === 'cancelled'
              ? 'failed'
              : state,
        actor: snapshot.name,
        description: snapshot.description,
        summary: snapshot.summary,
        toolUseId: snapshot.parentToolCallId,
        parentTaskId: snapshot.parentRunId ?? undefined,
        modelId: snapshot.modelId,
        startedAtEpochSeconds: snapshot.startedAtEpochSeconds,
        endedAtEpochSeconds: snapshot.endedAtEpochSeconds,
        error: snapshot.reason?.message,
        run: {
          sessionId: event.sessionId,
          snapshot,
          items: previousRun?.items ?? [],
          ...(previousRun?.progress ? { progress: previousRun.progress } : {}),
        },
      };
      const items = this.ensureEntryItems(entryIndex);
      if (existing) items[existing.itemIndex] = task;
      else {
        items.push(task);
        this.runIndex?.set(JSON.stringify([event.sessionId, event.runId]), {
          entryIndex,
          itemIndex: items.length - 1,
        });
      }
      this.changed = true;
      return;
    }
    if (!existing || !previousRun) return;
    const run = {
      ...previousRun,
      items: event.type === 'output' ? [...previousRun.items] : previousRun.items,
    };
    if (event.type === 'progress') {
      run.progress = { ...run.progress, ...event.progress };
      if (JSON.stringify(run.progress) === JSON.stringify(previousRun.progress)) return;
    } else {
      const update = event.update;
      const identity = {
        nativeTurnId: event.nativeTurnId,
        messageId:
          event.messageId ?? ('messageId' in update ? (update.messageId ?? undefined) : undefined),
      };
      if (update.sessionUpdate === 'plan') {
        const index = run.items.findIndex((item) => item.type === 'plan');
        const plan: SubagentRunItem = { type: 'plan', entries: update.entries, ...identity };
        if (index < 0) run.items.push(plan);
        else run.items[index] = plan;
      } else if (
        update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'agent_thought_chunk'
      ) {
        if (update.content.type !== 'text') {
          run.snapshot = { ...run.snapshot, outputIncomplete: true };
        } else {
          const type = update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thought';
          const last = run.items.at(-1);
          const messagePhase = type === 'text' ? parseLodyMessagePhase(update._meta) : undefined;
          if (
            last?.type === type &&
            last.nativeTurnId === identity.nativeTurnId &&
            last.messageId === identity.messageId &&
            (last.type !== 'text' || last.messagePhase === messagePhase)
          )
            run.items[run.items.length - 1] = { ...last, text: last.text + update.content.text };
          else
            run.items.push({
              type,
              text: update.content.text,
              ...identity,
              ...(messagePhase ? { messagePhase } : {}),
            });
        }
      } else {
        const index = run.items.findIndex(
          (item) => item.type === 'tool_call' && item.toolCallId === update.toolCallId
        );
        const previous = run.items[index];
        const tool = previous?.type === 'tool_call' ? previous : undefined;
        const incoming = this.stampSchedulingToolCall(buildToolCallMessageForHistory(update, tool));
        const content: Extract<SubagentRunItem, { type: 'tool_call' }> = {
          ...(tool ? mergeToolCallMessage(tool, incoming, update.content != null) : incoming),
          ...(identity.nativeTurnId !== undefined ? { nativeTurnId: identity.nativeTurnId } : {}),
          ...(identity.messageId !== undefined ? { messageId: identity.messageId } : {}),
        };
        if (index >= 0) run.items[index] = content;
        else run.items.push(content);
      }
    }
    this.ensureEntryItems(existing.entryIndex)[existing.itemIndex] = { ...existing.task, run };
    this.changed = true;
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
    if (this.subagentTaskEntryIndexById.has(taskId)) {
      const cached = this.subagentTaskEntryIndexById.get(taskId);
      return cached === null ? undefined : cached;
    }

    for (let i = this.history.length - 1; i >= 0; i--) {
      const items = this.readEntryItems(i);
      if (items.some((content) => content.type === 'subagent_task' && content.taskId === taskId)) {
        this.subagentTaskEntryIndexById.set(taskId, i);
        return i;
      }
    }

    this.subagentTaskEntryIndexById.set(taskId, null);
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

  private applyMessageContent(message: MessageContent, replaceContent = false) {
    switch (message.type) {
      case 'text': {
        const text = sanitizeLodyInternalInstructions(message.text);
        if (!text) return;
        const entryIndex = this.ensureActiveAssistantEntry();
        this.appendOrMergeAdjacentText(entryIndex, 'text', text, message.messagePhase);
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
          this.upsertToolCall(existingEntryIndex, message, replaceContent);
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
    if (arePlanEntriesEqual(entry.plan, entries)) return;

    entry.plan = entries;
    this.changed = true;
  }

  private appendOrMergeAdjacentText(
    entryIndex: number,
    kind: Extract<MessageContent, { type: 'text' | 'thought' }>['type'],
    delta: string,
    messagePhase?: 'commentary' | 'final_answer'
  ) {
    if (!delta) return;
    const items = this.ensureEntryItems(entryIndex);

    const last = items[items.length - 1];
    if (
      last &&
      last.type === kind &&
      (last.type !== 'text' || last.messagePhase === messagePhase)
    ) {
      const existing = last as Extract<MessageContent, { type: typeof kind }>;
      const merged = mergeStreamText(existing, delta);
      const text = merged.item.text;
      if (!text) {
        items.pop();
        this.touchedAssistantEntryIndices.add(entryIndex);
        this.changed = true;
        return;
      }
      items[items.length - 1] = merged.item;
      const turnId = this.history[entryIndex]?.id;
      if (turnId && merged.suffix !== undefined)
        this.textAppends?.push({
          turnId,
          itemIndex: items.length - 1,
          previous: existing.text,
          value: text,
          text: merged.suffix,
        });
      this.touchedAssistantEntryIndices.add(entryIndex);
      this.changed = true;
      return;
    }

    items.push({
      type: kind,
      text: delta,
      ...(messagePhase ? { messagePhase } : {}),
    } as MessageContent);
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
      const existing = items[existingIndex] as ProposedPlanMessage;
      if (
        existing.markdown === next.markdown &&
        existing.status === next.status &&
        existing.isLatest === next.isLatest
      ) {
        return;
      }
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

  private upsertToolCall(entryIndex: number, incoming: ToolCallMessage, replaceContent = false) {
    const entry = this.history[entryIndex];
    if (!entry) return;

    const items = this.ensureEntryItems(entryIndex);
    const toolIndex = items.findIndex(
      (m) => m.type === 'tool_call' && (m as ToolCallMessage).toolCallId === incoming.toolCallId
    );
    if (toolIndex >= 0) {
      const prevTool = items[toolIndex] as ToolCallMessage;
      items[toolIndex] = mergeToolCallMessage(prevTool, incoming, replaceContent);
      this.changed = true;
      return;
    }

    items.push({
      ...incoming,
      ...(incoming.title ? { title: truncateToolTitleForHistory(incoming.title) } : {}),
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
        if (!hasAssistantTextTags(item)) {
          newItems.push(item);
          continue;
        }

        const parsed = parseAssistantTextTags(text, entry.id);

        if (
          parsed.length !== 1 ||
          parsed[0]?.type !== 'text' ||
          (parsed[0]?.type === 'text' && parsed[0].text !== text)
        ) {
          newItems.push(
            ...parsed.map((part) =>
              part.type === 'text' && item.messagePhase
                ? { ...part, messagePhase: item.messagePhase }
                : part
            )
          );
          modified = true;
        } else {
          newItems.push(item);
        }
      }

      if (modified) {
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

enablePatches();
const mutationImmer = new Immer({ autoFreeze: false, useStrictShallowCopy: true });
/** Authored paths, before validation; values always come from the validated result. */
export type AgentHistoryMutationPath = { turnId: string; path: readonly (string | number)[] };
export type AgentHistoryMutationEvent =
  | { kind: 'notification'; value: AcpSessionNotification }
  | { kind: 'content'; value: MessageContent };

/** Private-owner planning: shares untouched values; public readers still detach. */
export function planAgentHistoryMutation(
  history: SessionHistoryInput[],
  events: readonly AgentHistoryMutationEvent[],
  model?: ModelInfo,
  options: ApplyNotificationOnHistoryOptions = {}
): {
  history: SessionHistoryInput[];
  textAppends: AgentHistoryTextAppend[];
  changes: AgentHistoryMutationPath[];
} {
  const textAppends: AgentHistoryTextAppend[] = [];
  const changes: AgentHistoryMutationPath[] = [];
  let next = history;
  const ownedEvents = structuredClone(events);
  const ownedModel = model === undefined ? undefined : structuredClone(model);
  for (const event of ownedEvents) {
    let patches: Patch[] = [];
    next = mutationImmer.produce(
      next,
      (draft) => {
        if (event.kind === 'notification') {
          new NotificationOnHistoryApplier(draft, options, ownedModel, textAppends).apply([
            event.value,
          ]);
        } else {
          const applied = applyMessageContentsBatch(draft, [event.value], {
            ...options,
            model: ownedModel,
            textAppends,
          });
          for (const [index, entry] of applied.entries()) {
            const current = draft[index];
            if (!current || current.id !== entry.id) {
              draft[index] = entry;
              continue;
            }
            for (const key of new Set([...Object.keys(current), ...Object.keys(entry)])) {
              if (Reflect.get(current, key) === Reflect.get(entry, key)) continue;
              if (Object.hasOwn(entry, key)) Reflect.set(current, key, Reflect.get(entry, key));
              else Reflect.deleteProperty(current, key);
            }
          }
          draft.length = applied.length;
        }
      },
      (recorded) => {
        patches = recorded;
      }
    );
    for (const patch of patches) {
      const index = patch.path[0];
      if (typeof index !== 'number') continue;
      const entry = next[index];
      if (entry) changes.push({ turnId: entry.id, path: patch.path.slice(1) });
    }
  }
  return { history: next, textAppends, changes };
}

/**
 * Batch process multiple message contents in O(n) time complexity.
 * This avoids the O(n²) cost of calling applyMessageContent repeatedly.
 *
 * IMPORTANT: This preserves the chronological ordering of messages.
 * When an `available_commands` or new `tool_call` is encountered, accumulated
 * text/thought/plan deltas are flushed first to maintain correct order.
 */
export type ApplyMessageContentsBatchOptions = {
  /** Internal planning records; the mutating reader API remains unchanged. */
  textAppends?: AgentHistoryTextAppend[];
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
  if (messages.length === 0) {
    return history;
  }

  const createId = options.createId ?? defaultCreateId;
  const now = options.now ?? (() => new Date().toISOString());

  type EntryState = {
    entry: SessionHistoryInput;
    items: MessageContent[];
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
    delta: string,
    messagePhase?: 'commentary' | 'final_answer'
  ) => {
    if (!delta) return;
    const state = entryStates[entryIndex];
    if (!state) return;

    const last = state.items[state.items.length - 1];
    if (
      last &&
      last.type === kind &&
      (last.type !== 'text' || last.messagePhase === messagePhase)
    ) {
      const existing = last as Extract<MessageContent, { type: typeof kind }>;
      const merged = mergeStreamText(existing, delta);
      const text = merged.item.text;
      if (text) {
        state.items[state.items.length - 1] = merged.item;
        if (merged.suffix !== undefined)
          options.textAppends?.push({
            turnId: state.entry.id,
            itemIndex: state.items.length - 1,
            previous: existing.text,
            value: text,
            text: merged.suffix,
          });
      } else {
        state.items.pop();
      }
    } else {
      state.items.push({
        type: kind,
        text: delta,
        ...(messagePhase ? { messagePhase } : {}),
      } as MessageContent);
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
      state.items[state.items.length - 1] = next as MessageContent;
      state.dirty = true;
      return;
    }

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
      const existing = state.items[existingIndex] as ProposedPlanMessage;
      if (
        existing.markdown === next.markdown &&
        existing.status === next.status &&
        existing.isLatest === next.isLatest
      ) {
        return;
      }
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

    const toolIndex = state.items.findIndex(
      (m) => m.type === 'tool_call' && (m as ToolCallMessage).toolCallId === incoming.toolCallId
    );
    if (toolIndex >= 0) {
      const prevTool = state.items[toolIndex] as ToolCallMessage;
      state.items[toolIndex] = mergeToolCallMessage(prevTool, incoming);
    } else {
      state.items.push({
        ...incoming,
        ...(incoming.title ? { title: truncateToolTitleForHistory(incoming.title) } : {}),
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

  for (const message of messages) {
    switch (message.type) {
      case 'text': {
        const text = sanitizeLodyInternalInstructions(message.text);
        if (!text) break;
        const entryIndex = ensureActiveAssistantEntry();
        appendOrMergeAdjacentText(entryIndex, 'text', text, message.messagePhase);
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
      if (!hasAssistantTextTags(item)) {
        newItems.push(item);
        continue;
      }
      const parsed = parseAssistantTextTags(item.text, state.entry.id);
      if (
        parsed.length !== 1 ||
        parsed[0]?.type !== 'text' ||
        (parsed[0]?.type === 'text' && parsed[0].text !== item.text)
      ) {
        newItems.push(
          ...parsed.map((part) =>
            part.type === 'text' && item.messagePhase
              ? { ...part, messagePhase: item.messagePhase }
              : part
          )
        );
        modified = true;
      } else {
        newItems.push(item);
      }
    }

    if (modified) {
      state.items = compactAdjacentTextAndThought(newItems);
    }
  }

  return entryStates.map((state) => {
    if (!state.dirty) return state.entry;
    return writeEntryItems(state.entry, state.items);
  });
};
