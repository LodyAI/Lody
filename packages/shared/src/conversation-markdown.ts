/**
 * Conversation Markdown Builder
 *
 * Renders a session's persisted history as real Markdown for the "Copy as
 * Markdown" action. This is a SEPARATE surface from `replay-prompt-builder.ts`:
 * that one produces an agent-facing replay prompt (`[User]` / `[Assistant]`
 * labels, resume framing) and its budget behaviour is load-bearing for CLI
 * resume. Do not merge the two; only the redaction helper is shared.
 *
 * ## Budget
 *
 * The copied text targets ~60k tokens / 150k characters so it can be pasted into
 * another chat without blowing its context. Character count alone is not enough:
 * CJK text is roughly one token per character, so 150k CJK characters is ~150k
 * tokens, not 60k. `estimateTokenCount` approximates both scripts and the output
 * must satisfy BOTH bounds.
 *
 * ## What gets trimmed — and what never does
 *
 * The point of this export is to move a conversation's CONTEXT to another agent,
 * so prose-shaped content outranks everything the agent produced around it.
 *
 * **Message text is never trimmed and thinking is never dropped.** User text,
 * assistant text and proposed plans are reproduced verbatim at every level; if
 * they alone exceed the budget the result goes over and reports `overBudget`.
 * Thinking is what lets the receiving conversation inherit the reasoning, so it
 * degrades by CAPPING (head + tail, middle elided), never by disappearing.
 * Only heading levels inside prose are rewritten — see `demoteMarkdownHeadings`.
 *
 * Everything else degrades first, in this order:
 *
 * | Level | Effect |
 * | ----- | ------ |
 * | 0 | Everything, uncapped |
 * | 1 | Tool results capped at 4000 chars, terminal tail 2048 |
 * | 2 | Tool results capped at 1000 chars, terminal tail 512 |
 * | 3 | Terminal output dropped (command kept), tool results capped at 300 |
 * | 4 | Tool calls collapsed to ONE per-turn summary with counts |
 * | 5 | Thinking capped at 2000 chars |
 * | 6 | Thinking capped at 500 chars |
 *
 * Collapsing tool calls before touching thinking is deliberate. A per-turn
 * summary costs a few dozen characters where one bold line per call cost up to
 * 120 each, so level 4 frees far more budget than dropping thinking ever did —
 * which is why most conversations never reach levels 5 and 6 at all.
 *
 * Degradation is recency-weighted: levels are raised on OLD turns first and the
 * last `recentEntryCount` turns keep their detail as long as possible, because
 * the tail of a conversation is what people actually paste elsewhere. Combined
 * with the capping above, the reasoning that is still live survives longest.
 */

import type { MessageContent, ToolCallContent } from './ai';
import type { SessionHistoryInput } from './schema';
import { redactSensitiveTokens } from './replay-prompt-builder';

/** Character ceiling for the copied Markdown. */
export const CONVERSATION_MARKDOWN_MAX_CHARS = 150_000;
/** Estimated-token ceiling for the copied Markdown. */
export const CONVERSATION_MARKDOWN_MAX_TOKENS = 60_000;
/** Trailing turns that keep full detail while older ones degrade first. */
export const CONVERSATION_MARKDOWN_RECENT_ENTRIES = 4;

type ToolCallItem = Extract<MessageContent, { type: 'tool_call' }>;

/**
 * A prose-only display message with an optional estimate for its full persisted
 * turn. Thinking, plans and tools contribute to the estimate, not to `text`.
 */
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Includes stored working content; excludes binary media and unavailable
   * output. Not provider usage or repeated context costs. Omitted for prose-only inputs. */
  estimatedTokens?: number;
  /** Model recorded on this turn; never the composer's current selection. */
  modelName?: string;
}

/**
 * Model recorded on a turn. `modelInfo` is what actually ran; `inputConfig` is
 * only what was requested, so it is the last resort and never overrides.
 */
export function resolveTurnModelName(
  entry: Pick<SessionHistoryInput, 'modelInfo' | 'inputConfig'>
): string | undefined {
  return (
    entry.modelInfo?.name || entry.modelInfo?.modelId || entry.inputConfig?.modelId || undefined
  );
}

/**
 * Collect the plain-text conversation from session history. Entries with no
 * text content (pure tool-call turns) are skipped; multiple text items in one
 * entry join with a blank line.
 */
export function collectConversationMessages(history: SessionHistoryInput[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const entry of history) {
    if (entry.role !== 'user' && entry.role !== 'assistant') {
      continue;
    }
    const texts: string[] = [];
    for (const item of (entry.items ?? []) as MessageContent[]) {
      if (item.type === 'text' && item.text?.trim()) {
        texts.push(item.text);
      }
    }
    if (texts.length > 0) {
      messages.push({
        id: entry.id,
        role: entry.role,
        text: texts.join('\n\n'),
        estimatedTokens: estimateStoredMessageTokens((entry.items ?? []) as MessageContent[]),
        modelName: resolveTurnModelName(entry),
      });
    }
  }
  return messages;
}

function estimateStoredMessageTokens(items: readonly MessageContent[]): number {
  let tokens = 0;
  const count = (text: string | null | undefined) => {
    tokens += estimateTokenCount(text ?? '');
  };
  for (const item of items) {
    switch (item.type) {
      case 'text':
      case 'thought':
        count(item.text);
        break;
      case 'plan':
        for (const entry of item.entries) count(entry.content);
        break;
      case 'proposed_plan':
        count(item.markdown);
        break;
      case 'tool_call': {
        count(item.toolName ?? item.title);
        if (item.rawInput) count(JSON.stringify(item.rawInput));
        // Structured content is the display representation of rawOutput; count
        // one representation so an adapter publishing both cannot double it.
        const hasOutputContent = item.content?.some((block) => block.type !== 'terminal_command');
        if (!hasOutputContent && item.rawOutput) count(JSON.stringify(item.rawOutput));
        for (const block of item.content ?? []) {
          switch (block.type) {
            case 'terminal_command':
              if (!item.rawInput) count([block.command, ...(block.args ?? [])].join(' '));
              break;
            case 'terminal_output':
              count(block.output);
              break;
            case 'diff':
              count(block.path);
              count(block.oldText);
              count(block.newText);
              break;
            case 'content':
              if (block.content.type === 'text') count(block.content.text);
              else if (block.content.type === 'resource' && 'text' in block.content.resource)
                count(block.content.resource.text);
              break;
          }
        }
        break;
      }
    }
  }
  return tokens;
}

export interface ConversationMarkdownStats {
  /** Characters in the rendered Markdown. */
  chars: number;
  /** Approximate token count (see `estimateTokenCount`). */
  estimatedTokens: number;
  /** History entries rendered. */
  entryCount: number;
  /** Terminal output was dropped from at least one rendered tool call. */
  terminalOutputOmitted: boolean;
  /** Terminal output was tail-truncated in at least one tool call. */
  terminalOutputTruncated: boolean;
  /** Thinking was capped in at least one turn. Thinking is never dropped whole. */
  thinkingTruncated: boolean;
  /** Tool result bodies that were truncated. */
  toolResultsTruncated: number;
  /** Tool calls were collapsed to per-turn summaries, dropping their bodies. */
  toolCallsCollapsed: boolean;
  /** Unique file paths listed in the trailing reference section. */
  pathsCount: number;
  /** True when even the most aggressive level exceeded the budget. */
  overBudget: boolean;
}

export interface ConversationMarkdownResult {
  markdown: string;
  stats: ConversationMarkdownStats;
}

export interface BuildConversationMarkdownOptions {
  history: SessionHistoryInput[];
  /** Rendered as the document's `#` heading when present. */
  title?: string;
  /** Provenance line for the header, e.g. `owner/repo · branch`. */
  source?: string;
  /**
   * Display names for user turns, keyed by `userId`. Names reach the per-turn
   * headings only when the conversation actually has more than one human in it;
   * repeating one name on every turn of a solo session is pure noise.
   */
  participants?: Record<string, string>;
  maxChars?: number;
  maxTokens?: number;
  recentEntryCount?: number;
  /** Append a one-line note naming what was trimmed. Default true. */
  includeTrimNotice?: boolean;
}

/**
 * Approximate the token count of `text`.
 *
 * Latin script averages ~4 characters per token; CJK and other ideographic
 * scripts average ~1. This is deliberately a cheap heuristic — it only has to be
 * good enough to keep a paste under a context window, not to match a tokenizer.
 */
export function estimateTokenCount(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (const char of text) {
    if (isWideScriptCodePoint(char.codePointAt(0) ?? 0)) {
      wide += 1;
    } else {
      narrow += 1;
    }
  }
  return wide + Math.ceil(narrow / 4);
}

function isWideScriptCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) || // Hangul Jamo
    (codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK radicals, Kangxi, punctuation
    (codePoint >= 0x3041 && codePoint <= 0x33ff) || // Kana, Hangul compat, CJK compat
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Ext A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified
    (codePoint >= 0xa960 && codePoint <= 0xa97f) || // Hangul Jamo Ext A
    (codePoint >= 0xac00 && codePoint <= 0xd7ff) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compat ideographs
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK compat forms
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // Fullwidth forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3ffff) // CJK Ext B+
  );
}

interface LevelConfig {
  /**
   * `Infinity` = uncapped. Never 0: thinking degrades by capping so the
   * receiving conversation always inherits some of the reasoning.
   */
  thinkingCap: number;
  includeTerminalOutput: boolean;
  terminalTailChars: number;
  /** `Infinity` = uncapped, `0` = drop the body entirely. */
  toolTextCap: number;
  collapseToolCalls: boolean;
}

const LEVELS: readonly LevelConfig[] = [
  {
    thinkingCap: Infinity,
    includeTerminalOutput: true,
    terminalTailChars: Infinity,
    toolTextCap: Infinity,
    collapseToolCalls: false,
  },
  {
    thinkingCap: Infinity,
    includeTerminalOutput: true,
    terminalTailChars: 2048,
    toolTextCap: 4000,
    collapseToolCalls: false,
  },
  {
    thinkingCap: Infinity,
    includeTerminalOutput: true,
    terminalTailChars: 512,
    toolTextCap: 1000,
    collapseToolCalls: false,
  },
  {
    thinkingCap: Infinity,
    includeTerminalOutput: false,
    terminalTailChars: 0,
    toolTextCap: 300,
    collapseToolCalls: false,
  },
  {
    thinkingCap: Infinity,
    includeTerminalOutput: false,
    terminalTailChars: 0,
    toolTextCap: 0,
    collapseToolCalls: true,
  },
  {
    thinkingCap: 2000,
    includeTerminalOutput: false,
    terminalTailChars: 0,
    toolTextCap: 0,
    collapseToolCalls: true,
  },
  {
    thinkingCap: 500,
    includeTerminalOutput: false,
    terminalTailChars: 0,
    toolTextCap: 0,
    collapseToolCalls: true,
  },
];

const MAX_LEVEL = LEVELS.length - 1;

/**
 * Pass order: exhaust the older turns first (raise their level to the floor),
 * only then start degrading the recent tail.
 */
function buildPassSequence(): Array<{ oldLevel: number; recentLevel: number }> {
  const passes: Array<{ oldLevel: number; recentLevel: number }> = [];
  for (let level = 0; level <= MAX_LEVEL; level += 1) {
    passes.push({ oldLevel: level, recentLevel: 0 });
  }
  for (let level = 1; level <= MAX_LEVEL; level += 1) {
    passes.push({ oldLevel: MAX_LEVEL, recentLevel: level });
  }
  return passes;
}

interface RenderTally {
  terminalOutputOmitted: boolean;
  terminalOutputTruncated: boolean;
  thinkingTruncated: boolean;
  toolResultsTruncated: number;
  toolCallsCollapsed: boolean;
}

interface CollectedPath {
  path: string;
  kind: 'read' | 'edit' | 'other';
}

function escapeInlineHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Single-line summary text: collapse newlines so `<summary>` stays one row. */
function toSummaryLine(text: string, maxChars = 120): string {
  const flattened = text.replace(/\s+/g, ' ').trim();
  return flattened.length > maxChars ? `${flattened.slice(0, maxChars - 1)}…` : flattened;
}

/** Turn headings are `##`, so prose headings have to start at `###`. */
const HEADING_SHIFT = 2;
const MAX_HEADING_LEVEL = 6;

/**
 * Push ATX headings inside a message body below the turn heading.
 *
 * Message text is reproduced verbatim, and agents emit `#` / `##` headings all
 * the time. Left alone they outrank the `## User` / `## Assistant` headings and
 * the document loses its turn structure entirely. Shifting the level is the one
 * edit allowed on prose: no characters are removed, only `#` markers added.
 *
 * Fenced blocks are skipped so a `# comment` inside a shell snippet survives.
 */
function demoteMarkdownHeadings(text: string): string {
  if (!text.includes('#')) {
    return text;
  }
  const lines = text.split('\n');
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (
        fenceMatch?.[1] &&
        fenceMatch[1][0] === fence[0] &&
        fenceMatch[1].length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch?.[1]) {
      fence = fenceMatch[1];
      continue;
    }
    const heading = /^( {0,3})(#{1,6})(?=\s|$)/.exec(line);
    if (!heading?.[2]) {
      continue;
    }
    const level = Math.min(MAX_HEADING_LEVEL, heading[2].length + HEADING_SHIFT);
    lines[index] = `${heading[1] ?? ''}${'#'.repeat(level)}${line.slice(heading[0].length)}`;
  }
  return lines.join('\n');
}

/**
 * Fence `text` with enough backticks to survive fences inside it, so a tool
 * result containing Markdown cannot break out of its block.
 */
function fenceCode(text: string, language = ''): string {
  const body = text.replace(/\s+$/, '');
  let longestRun = 0;
  for (const match of body.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, match[0].length);
  }
  const ticks = '`'.repeat(Math.max(3, longestRun + 1));
  return `${ticks}${language}\n${body}\n${ticks}`;
}

function detailsBlock(summary: string, body: string): string {
  return `<details>\n<summary>${escapeInlineHtml(summary)}</summary>\n\n${body}\n\n</details>`;
}

/** Keep the head and the tail of an oversized body; elide the middle. */
function clampMiddle(text: string, cap: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(cap) || text.length <= cap) {
    return { text, truncated: false };
  }
  const headChars = Math.max(1, Math.floor(cap * 0.6));
  const tailChars = Math.max(0, cap - headChars);
  const elided = text.length - headChars - tailChars;
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(-tailChars) : '';
  return {
    text: `${head}\n\n… ${elided} characters elided …\n\n${tail}`,
    truncated: true,
  };
}

function tailOf(text: string, cap: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(cap) || text.length <= cap) {
    return { text, truncated: false };
  }
  return {
    text: `… ${text.length - cap} characters elided …\n${text.slice(-cap)}`,
    truncated: true,
  };
}

type PlanEntries = Extract<MessageContent, { type: 'plan' }>['entries'];

function renderPlan(entries: PlanEntries): string {
  const lines = entries.map((entry) => {
    const box = entry.status === 'completed' ? '[x]' : '[ ]';
    const marker = entry.status === 'in_progress' ? ' _(in progress)_' : '';
    return `- ${box} ${entry.content}${marker}`;
  });
  return `**Plan**\n\n${lines.join('\n')}`;
}

function renderToolCallContent(
  block: ToolCallContent,
  level: LevelConfig,
  tally: RenderTally
): string | null {
  switch (block.type) {
    case 'terminal_command': {
      const command = [block.command, ...(block.args ?? [])].join(' ');
      return command ? `\`$ ${command}\`` : null;
    }

    case 'terminal_output': {
      if (!level.includeTerminalOutput) {
        if (block.output) {
          tally.terminalOutputOmitted = true;
        }
        return null;
      }
      const output = redactSensitiveTokens(block.output ?? '');
      if (!output) {
        return null;
      }
      const { text, truncated } = tailOf(output, level.terminalTailChars);
      if (truncated) {
        tally.terminalOutputTruncated = true;
      }
      return fenceCode(text);
    }

    case 'diff':
      // Path only. Reproducing full file contents would dominate the budget and
      // the diff is available in the session itself.
      return `_Diff:_ \`${block.path}\``;

    case 'content': {
      if (block.content?.type !== 'text' || !block.content.text) {
        return null;
      }
      if (level.toolTextCap === 0) {
        return null;
      }
      const { text, truncated } = clampMiddle(
        redactSensitiveTokens(block.content.text),
        level.toolTextCap
      );
      if (truncated) {
        tally.toolResultsTruncated += 1;
      }
      return fenceCode(text);
    }

    default:
      return null;
  }
}

function toolCallLabel(item: ToolCallItem): string {
  const base = item.title?.trim() || item.kind || 'Tool';
  const paths = (item.locations ?? []).map((location) => location.path).filter(Boolean);
  return paths.length > 0 && !paths.some((path) => base.includes(path))
    ? `${base} — ${paths.join(', ')}`
    : base;
}

/** The agent's own name for the tool, falling back to the ACP kind. */
function toolCallName(item: ToolCallItem): string {
  return item.toolName?.trim() || item.kind?.trim() || 'tool';
}

function renderToolCall(item: ToolCallItem, level: LevelConfig, tally: RenderTally): string | null {
  const label = toSummaryLine(toolCallLabel(item));

  const blocks: string[] = [];
  for (const block of item.content ?? []) {
    const rendered = renderToolCallContent(block, level, tally);
    if (rendered) {
      blocks.push(rendered);
    }
  }

  if (blocks.length === 0) {
    return `- **${label}**`;
  }
  return detailsBlock(label, blocks.join('\n\n'));
}

/**
 * Replace a turn's tool calls with a single counted summary.
 *
 * One line per call was the old floor and it was the worst trade in the ladder:
 * hundreds of bold, mid-word-truncated command strings that nobody can act on,
 * costing up to 120 characters each while every result was already gone. Counts
 * by tool name say the same thing in a fraction of the budget.
 */
function summarizeToolCalls(items: readonly ToolCallItem[], tally: RenderTally): string | null {
  if (items.length === 0) {
    return null;
  }
  tally.toolCallsCollapsed = true;
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = toolCallName(item);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const breakdown = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => `\`${name}\` ×${count}`)
    .join(' · ');
  const label = `${items.length} tool call${items.length === 1 ? '' : 's'} (details omitted)`;
  return detailsBlock(label, breakdown);
}

function renderItem(item: MessageContent, level: LevelConfig, tally: RenderTally): string | null {
  switch (item.type) {
    case 'text':
      // Message text is never trimmed; only heading levels move.
      return item.text?.trim() ? demoteMarkdownHeadings(item.text) : null;

    case 'proposed_plan':
      // Extracted out of the assistant text upstream, so dropping it would lose
      // prose the user can see in the transcript. Also never trimmed.
      if (item.status === 'cleared' || !item.markdown?.trim()) {
        return null;
      }
      return demoteMarkdownHeadings(item.markdown);

    case 'thought': {
      if (!item.text?.trim()) {
        return null;
      }
      const { text, truncated } = clampMiddle(demoteMarkdownHeadings(item.text), level.thinkingCap);
      if (truncated) {
        tally.thinkingTruncated = true;
      }
      // Named for the reader on the other side: this is prior reasoning carried
      // in from another session, not something the receiving agent produced.
      return detailsBlock('Thinking (from the original session)', text);
    }

    case 'plan':
      return item.entries?.length ? renderPlan(item.entries) : null;

    case 'tool_call':
      return renderToolCall(item, level, tally);

    case 'subagent_task': {
      if (item.skipTranscript) {
        return null;
      }
      const name =
        item.description?.trim() || item.subagentType || item.taskType || 'Subagent task';
      return `- **Subagent** ${toSummaryLine(name)} _(${item.status})_`;
    }

    default:
      return null;
  }
}

function collectPathsFromToolCall(item: ToolCallItem): CollectedPath[] {
  const kind: CollectedPath['kind'] =
    item.kind === 'read' ? 'read' : item.kind === 'edit' ? 'edit' : 'other';
  const paths: CollectedPath[] = (item.locations ?? []).map((location) => ({
    path: location.path,
    kind,
  }));
  for (const block of item.content ?? []) {
    if (block.type === 'diff' && block.path) {
      paths.push({ path: block.path, kind: 'edit' });
    }
  }
  return paths;
}

function renderPathsSection(paths: CollectedPath[]): { markdown: string; count: number } {
  if (paths.length === 0) {
    return { markdown: '', count: 0 };
  }
  const strongest = new Map<string, CollectedPath['kind']>();
  for (const entry of paths) {
    const existing = strongest.get(entry.path);
    if (!existing || entry.kind === 'edit' || (entry.kind === 'read' && existing === 'other')) {
      strongest.set(entry.path, entry.kind);
    }
  }
  const byKind = (kind: CollectedPath['kind']) =>
    [...strongest.entries()].filter(([, value]) => value === kind).map(([path]) => path);

  // Qualified on purpose: this list only sees paths an adapter attached to a
  // tool call. A session that worked through a shell reports almost nothing, and
  // an unqualified "Files referenced" would read as the complete set.
  const lines: string[] = ['## Files referenced (from tool call locations)', ''];
  const groups: Array<[string, string[]]> = [
    ['Edited', byKind('edit')],
    ['Read', byKind('read')],
    ['Other', byKind('other')],
  ];
  for (const [label, group] of groups) {
    if (group.length > 0) {
      lines.push(`- **${label}:** ${group.map((path) => `\`${path}\``).join(', ')}`);
    }
  }
  return { markdown: lines.join('\n'), count: strongest.size };
}

function describeTrim(tally: RenderTally): string[] {
  const notes: string[] = [];
  if (tally.toolCallsCollapsed) {
    // Says "results and terminal output" explicitly: a collapsed call never
    // reaches the block renderer, so those tallies stay at zero and would
    // otherwise understate what the reader is missing.
    notes.push('tool calls collapsed to per-turn summaries (results and terminal output omitted)');
  }
  if (tally.thinkingTruncated) {
    notes.push('thinking truncated');
  }
  if (tally.terminalOutputOmitted) {
    notes.push('terminal output omitted');
  } else if (tally.terminalOutputTruncated) {
    notes.push('terminal output truncated');
  }
  if (tally.toolResultsTruncated > 0) {
    notes.push(`${tally.toolResultsTruncated} tool result(s) truncated`);
  }
  return notes;
}

/** History timestamps are ISO strings on the wire but numeric in some fixtures. */
function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * `MM-DD HH:mm` in the reader's local zone. The header carries the full range,
 * so per-turn stamps only have to separate turns, not date them absolutely.
 */
function formatTurnTime(ms: number): string {
  const date = new Date(ms);
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatFullTime(ms: number): string {
  return `${new Date(ms).getFullYear()}-${formatTurnTime(ms)}`;
}

/** Compact working time. Sub-second turns get no stamp; the noise outweighs it. */
function formatDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 1_000) {
    return null;
  }
  const totalSeconds = Math.round(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${pad2(minutes)}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${pad2(seconds)}s`;
  }
  return `${seconds}s`;
}

/**
 * Effective agent working time for an assistant turn, per the `permissionWaitMs`
 * contract on `sessionHistorySchema`: elapsed time minus approval waiting.
 */
function turnDuration(entry: SessionHistoryInput, startedMs: number | null): string | null {
  if (startedMs === null || typeof entry.endedAt !== 'number') {
    return null;
  }
  return formatDuration(entry.endedAt - startedMs - (entry.permissionWaitMs ?? 0));
}

interface RenderResult {
  markdown: string;
  tally: RenderTally;
  entryCount: number;
  pathsCount: number;
}

function renderConversation(
  history: SessionHistoryInput[],
  options: {
    title?: string;
    source?: string;
    participants?: Record<string, string>;
    oldLevel: number;
    recentLevel: number;
    recentEntryCount: number;
    includeTrimNotice: boolean;
  }
): RenderResult {
  const tally: RenderTally = {
    terminalOutputOmitted: false,
    terminalOutputTruncated: false,
    thinkingTruncated: false,
    toolResultsTruncated: 0,
    toolCallsCollapsed: false,
  };

  const renderable = history.filter((entry) => entry.role === 'user' || entry.role === 'assistant');
  const recentFrom = Math.max(0, renderable.length - options.recentEntryCount);

  // A human name on every turn of a solo session is noise, so per-turn names are
  // gated on the conversation actually having more than one participant.
  const speakerIds = new Set<string>();
  for (const entry of renderable) {
    if (entry.role === 'user' && entry.userId) {
      speakerIds.add(entry.userId);
    }
  }
  const showSpeakerNames = speakerIds.size > 1;
  const participantNames = [...speakerIds]
    .map((userId) => options.participants?.[userId])
    .filter((name): name is string => Boolean(name));

  const bodySections: string[] = [];
  const allPaths: CollectedPath[] = [];
  const models = new Set<string>();
  let entryCount = 0;
  let turnNumber = 0;
  let firstMs: number | null = null;
  let lastMs: number | null = null;

  renderable.forEach((entry, index) => {
    const level = LEVELS[index >= recentFrom ? options.recentLevel : options.oldLevel];
    if (!level) {
      return;
    }

    // Turn numbers follow the conversation, not the rendered output, so a turn
    // that renders nothing does not shift the numbering of everything after it.
    if (entry.role === 'user' || turnNumber === 0) {
      turnNumber += 1;
    }

    const toolCalls = (entry.items ?? []).filter(
      (item): item is ToolCallItem => (item as MessageContent).type === 'tool_call'
    );

    const parts: string[] = [];
    let emittedToolSummary = false;
    for (const item of (entry.items ?? []) as MessageContent[]) {
      if (item.type === 'tool_call') {
        allPaths.push(...collectPathsFromToolCall(item));
        if (level.collapseToolCalls) {
          // One aggregate block, placed where the turn's first call was, so the
          // prose around it keeps its original order.
          if (!emittedToolSummary) {
            emittedToolSummary = true;
            const summary = summarizeToolCalls(toolCalls, tally);
            if (summary) {
              parts.push(summary);
            }
          }
          continue;
        }
      }
      const rendered = renderItem(item, level, tally);
      if (rendered) {
        parts.push(rendered);
      }
    }

    if (parts.length === 0) {
      return;
    }

    const startedMs = toEpochMs(entry.timestamp);
    if (startedMs !== null) {
      firstMs = firstMs === null ? startedMs : Math.min(firstMs, startedMs);
      lastMs = lastMs === null ? startedMs : Math.max(lastMs, startedMs);
    }

    const heading: string[] = [`${turnNumber} · ${entry.role === 'user' ? 'User' : 'Assistant'}`];
    if (showSpeakerNames && entry.role === 'user') {
      const name = entry.userId ? options.participants?.[entry.userId] : undefined;
      if (name) {
        heading.push(name);
      }
    }
    if (startedMs !== null) {
      heading.push(formatTurnTime(startedMs));
    }
    if (entry.role === 'assistant') {
      const model = resolveTurnModelName(entry);
      if (model) {
        models.add(model);
        heading.push(model);
      }
      const duration = turnDuration(entry, startedMs);
      if (duration) {
        heading.push(duration);
      }
    }

    // A rule before each new user turn chunks the transcript into rounds; two
    // sibling `##` headings alone read as one undifferentiated stream.
    if (bodySections.length > 0 && entry.role === 'user') {
      bodySections.push('---');
    }
    bodySections.push(`## ${heading.join(' · ')}`);
    bodySections.push(parts.join('\n\n'));
    entryCount += 1;
  });

  const paths = renderPathsSection(allPaths);
  if (paths.markdown) {
    bodySections.push('---');
    bodySections.push(paths.markdown);
  }

  const sections: string[] = [];
  if (options.title?.trim()) {
    sections.push(`# ${options.title.trim()}`);
  }

  // Header, not footer: whoever reads this next — a person or another agent —
  // needs to know the transcript is incomplete before reading it, not after.
  const headerLines: string[] = [];
  const summary = ['Lody session'];
  if (firstMs !== null && lastMs !== null) {
    summary.push(
      firstMs === lastMs
        ? formatFullTime(firstMs)
        : `${formatFullTime(firstMs)} → ${formatFullTime(lastMs)}`
    );
  }
  summary.push(`${entryCount} message${entryCount === 1 ? '' : 's'}`);
  headerLines.push(summary.join(' · '));
  if (options.source?.trim()) {
    headerLines.push(options.source.trim());
  }
  if (participantNames.length > 1) {
    headerLines.push(`Participants: ${participantNames.join(', ')}`);
  }
  if (models.size > 0) {
    headerLines.push(`Models: ${[...models].join(', ')}`);
  }
  if (options.includeTrimNotice) {
    const notes = describeTrim(tally);
    if (notes.length > 0) {
      headerLines.push(`**Trimmed to fit the copy budget:** ${notes.join('; ')}.`);
    }
  }
  if (bodySections.length > 0) {
    sections.push(headerLines.map((line) => `> ${line}`).join('\n>\n'));
    sections.push('---');
  }
  sections.push(...bodySections);

  return {
    markdown: `${sections.join('\n\n')}\n`,
    tally,
    entryCount,
    pathsCount: paths.count,
  };
}

/**
 * Render session history as Markdown, degrading non-prose content until it fits
 * the character and token budget. Message text is always reproduced in full, so
 * a conversation whose prose alone exceeds the budget returns `overBudget`.
 */
export function buildConversationMarkdown(
  options: BuildConversationMarkdownOptions
): ConversationMarkdownResult {
  const {
    history,
    title,
    source,
    participants,
    maxChars = CONVERSATION_MARKDOWN_MAX_CHARS,
    maxTokens = CONVERSATION_MARKDOWN_MAX_TOKENS,
    recentEntryCount = CONVERSATION_MARKDOWN_RECENT_ENTRIES,
    includeTrimNotice = true,
  } = options;

  let last: RenderResult | null = null;
  let estimatedTokens = 0;

  for (const pass of buildPassSequence()) {
    const result = renderConversation(history, {
      title,
      source,
      participants,
      oldLevel: pass.oldLevel,
      recentLevel: pass.recentLevel,
      recentEntryCount,
      includeTrimNotice,
    });
    last = result;

    if (result.markdown.length > maxChars) {
      continue;
    }
    estimatedTokens = estimateTokenCount(result.markdown);
    if (estimatedTokens <= maxTokens) {
      return toResult(result, estimatedTokens, false);
    }
  }

  // Every level exceeded the budget: message text alone is over. Ship it whole
  // rather than mangling prose — the caller reports this to the user.
  const fallback = last ?? {
    markdown: '',
    tally: {
      terminalOutputOmitted: false,
      terminalOutputTruncated: false,
      thinkingTruncated: false,
      toolResultsTruncated: 0,
      toolCallsCollapsed: false,
    },
    entryCount: 0,
    pathsCount: 0,
  };
  return toResult(fallback, estimateTokenCount(fallback.markdown), true);
}

function toResult(
  result: RenderResult,
  estimatedTokens: number,
  overBudget: boolean
): ConversationMarkdownResult {
  return {
    markdown: result.markdown,
    stats: {
      chars: result.markdown.length,
      estimatedTokens,
      entryCount: result.entryCount,
      terminalOutputOmitted: result.tally.terminalOutputOmitted,
      terminalOutputTruncated: result.tally.terminalOutputTruncated,
      thinkingTruncated: result.tally.thinkingTruncated,
      toolResultsTruncated: result.tally.toolResultsTruncated,
      toolCallsCollapsed: result.tally.toolCallsCollapsed,
      pathsCount: result.pathsCount,
      overBudget,
    },
  };
}
