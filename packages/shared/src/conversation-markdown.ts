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
 * The copied text targets ~20k tokens / 50k characters so it can be pasted into
 * another chat without blowing its context. Character count alone is not enough:
 * CJK text is roughly one token per character, so 50k CJK characters is ~50k
 * tokens, not 20k. `estimateTokenCount` approximates both scripts and the output
 * must satisfy BOTH bounds.
 *
 * ## What gets trimmed — and what never does
 *
 * **Message text is never trimmed.** User text, assistant text, and proposed
 * plans are reproduced verbatim at every level; if they alone exceed the budget
 * the result goes over and reports `overBudget`. Everything the agent produced
 * *around* the prose degrades instead, in this order:
 *
 * | Level | Effect |
 * | ----- | ------ |
 * | 0 | Everything, uncapped |
 * | 1 | Tool results capped at 4000 chars, terminal tail 2048 |
 * | 2 | Tool results capped at 1000 chars, terminal tail 512 |
 * | 3 | Terminal output dropped (command kept), tool results capped at 300 |
 * | 4 | Thinking dropped |
 * | 5 | Tool calls collapsed to one-line summaries |
 *
 * Degradation is recency-weighted: levels are raised on OLD turns first and the
 * last `recentEntryCount` turns keep their detail as long as possible, because
 * the tail of a conversation is what people actually paste elsewhere.
 */

import type { MessageContent, ToolCallContent } from './ai';
import {
  formatCommentReferenceForPrompt,
  formatVisualAnnotationReferenceForPrompt,
} from './comment-reference-format';
import type { SessionHistoryInput } from './schema';
import { redactSensitiveTokens } from './replay-prompt-builder';

/** Character ceiling for the copied Markdown. */
export const CONVERSATION_MARKDOWN_MAX_CHARS = 50_000;
/** Estimated-token ceiling for the copied Markdown. */
export const CONVERSATION_MARKDOWN_MAX_TOKENS = 20_000;
/** Trailing turns that keep full detail while older ones degrade first. */
export const CONVERSATION_MARKDOWN_RECENT_ENTRIES = 4;

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
        modelName: entry.modelInfo?.name || entry.modelInfo?.modelId || entry.inputConfig?.modelId,
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
  /** Terminal output was dropped from at least one tool call. */
  terminalOutputOmitted: boolean;
  /** Terminal output was tail-truncated in at least one tool call. */
  terminalOutputTruncated: boolean;
  /** Thinking blocks were dropped from at least one turn. */
  thinkingOmitted: boolean;
  /** Tool result bodies that were truncated. */
  toolResultsTruncated: number;
  /** Tool calls were collapsed to one-line summaries. */
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
  includeThinking: boolean;
  includeTerminalOutput: boolean;
  terminalTailChars: number;
  /** `Infinity` = uncapped, `0` = drop the body entirely. */
  toolTextCap: number;
  collapseToolCalls: boolean;
}

const LEVELS: readonly LevelConfig[] = [
  {
    includeThinking: true,
    includeTerminalOutput: true,
    terminalTailChars: Infinity,
    toolTextCap: Infinity,
    collapseToolCalls: false,
  },
  {
    includeThinking: true,
    includeTerminalOutput: true,
    terminalTailChars: 2048,
    toolTextCap: 4000,
    collapseToolCalls: false,
  },
  {
    includeThinking: true,
    includeTerminalOutput: true,
    terminalTailChars: 512,
    toolTextCap: 1000,
    collapseToolCalls: false,
  },
  {
    includeThinking: true,
    includeTerminalOutput: false,
    terminalTailChars: 0,
    toolTextCap: 300,
    collapseToolCalls: false,
  },
  {
    includeThinking: false,
    includeTerminalOutput: false,
    terminalTailChars: 0,
    toolTextCap: 300,
    collapseToolCalls: false,
  },
  {
    includeThinking: false,
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
  thinkingOmitted: boolean;
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

function toolCallLabel(item: Extract<MessageContent, { type: 'tool_call' }>): string {
  const base = item.title?.trim() || item.kind || 'Tool';
  const paths = (item.locations ?? []).map((location) => location.path).filter(Boolean);
  return paths.length > 0 && !paths.some((path) => base.includes(path))
    ? `${base} — ${paths.join(', ')}`
    : base;
}

function renderToolCall(
  item: Extract<MessageContent, { type: 'tool_call' }>,
  level: LevelConfig,
  tally: RenderTally
): string | null {
  const label = toSummaryLine(toolCallLabel(item));

  if (level.collapseToolCalls) {
    tally.toolCallsCollapsed = true;
    return `- **${label}**`;
  }

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

function renderItem(item: MessageContent, level: LevelConfig, tally: RenderTally): string | null {
  switch (item.type) {
    case 'text':
      // Message text is never trimmed.
      return item.text?.trim() ? item.text : null;

    case 'file':
      return `- **Attachment:** ${toSummaryLine(item.fileName)} (${item.sizeBytes} bytes). _File contents not included._`;

    case 'image':
      return `- **Image:** ${item.fileName ? toSummaryLine(item.fileName) : 'Attached image'} (${item.mimeType}, ${item.sizeBytes} bytes). _Image contents not included._`;

    case 'comment_reference':
      return fenceCode(formatCommentReferenceForPrompt(item), 'xml');

    case 'visual_annotation_reference':
      return fenceCode(formatVisualAnnotationReferenceForPrompt(item), 'xml');

    case 'image_group':
      return `- **Images:** ${item.images.length}. _Image contents not included._`;

    case 'proposed_plan':
      // Extracted out of the assistant text upstream, so dropping it would lose
      // prose the user can see in the transcript. Also never trimmed.
      if (item.status === 'cleared' || !item.markdown?.trim()) {
        return null;
      }
      return item.markdown;

    case 'thought': {
      if (!item.text?.trim()) {
        return null;
      }
      if (!level.includeThinking) {
        tally.thinkingOmitted = true;
        return null;
      }
      return detailsBlock('Thinking', item.text);
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

function collectPathsFromToolCall(
  item: Extract<MessageContent, { type: 'tool_call' }>
): CollectedPath[] {
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

  const lines: string[] = ['## Files referenced', ''];
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
    notes.push('tool call details collapsed');
  }
  if (tally.thinkingOmitted) {
    notes.push('thinking omitted');
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
    oldLevel: number;
    recentLevel: number;
    recentEntryCount: number;
    includeTrimNotice: boolean;
  }
): RenderResult {
  const tally: RenderTally = {
    terminalOutputOmitted: false,
    terminalOutputTruncated: false,
    thinkingOmitted: false,
    toolResultsTruncated: 0,
    toolCallsCollapsed: false,
  };

  const renderable = history.filter((entry) => entry.role === 'user' || entry.role === 'assistant');
  const recentFrom = Math.max(0, renderable.length - options.recentEntryCount);

  const sections: string[] = [];
  if (options.title?.trim()) {
    sections.push(`# ${options.title.trim()}`);
  }

  const allPaths: CollectedPath[] = [];
  let entryCount = 0;

  renderable.forEach((entry, index) => {
    const level = LEVELS[index >= recentFrom ? options.recentLevel : options.oldLevel];
    if (!level) {
      return;
    }

    const parts: string[] = [];
    for (const item of (entry.items ?? []) as MessageContent[]) {
      if (item.type === 'tool_call') {
        allPaths.push(...collectPathsFromToolCall(item));
      }
      const rendered = renderItem(item, level, tally);
      if (rendered) {
        parts.push(rendered);
      }
    }

    if (parts.length === 0) {
      return;
    }
    sections.push(`## ${entry.role === 'user' ? 'User' : 'Assistant'}`);
    sections.push(parts.join('\n\n'));
    entryCount += 1;
  });

  const paths = renderPathsSection(allPaths);
  if (paths.markdown) {
    sections.push(paths.markdown);
  }

  if (options.includeTrimNotice) {
    const notes = describeTrim(tally);
    if (notes.length > 0) {
      sections.push(`---\n\n_Trimmed to fit the copy budget: ${notes.join('; ')}._`);
    }
  }

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
      thinkingOmitted: false,
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
      thinkingOmitted: result.tally.thinkingOmitted,
      toolResultsTruncated: result.tally.toolResultsTruncated,
      toolCallsCollapsed: result.tally.toolCallsCollapsed,
      pathsCount: result.pathsCount,
      overBudget,
    },
  };
}
