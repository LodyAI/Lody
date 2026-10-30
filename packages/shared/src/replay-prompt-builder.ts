/**
 * Replay Prompt Builder
 *
 * When ACP native resume is unavailable, this module constructs a "replay prompt"
 * from the persisted session history (LoroDoc) to restore conversation context.
 *
 * ## Output Format
 *
 * The generated prompt follows this structure:
 *
 * ```
 * === Previous Conversation Context ===
 *
 * [User]
 * User message text...
 *
 * [Assistant]
 * Assistant response text...
 *
 * <thinking>
 * Assistant's thought process (if included)...
 * </thinking>
 *
 * [Tool: Tool Name]
 * [Command] npm install
 * [Terminal Output]
 * ...output (tail 1024 chars, prefixed with '...' if truncated)...
 *
 * [Diff: path/to/file.ts]
 *
 * [Plan]
 * - [completed] Task 1
 * - [in_progress] Task 2
 *
 * === Files Referenced ===
 * Read: path/a.ts, path/b.ts
 * Edit: path/c.ts
 * Other: config.json
 *
 * === End of Previous Context ===
 * ```
 *
 * ## Multi-Pass Budget Strategy
 *
 * When the prompt exceeds maxChars (default 100k):
 * - Pass A: Include all content with terminal tail (1024 chars)
 * - Pass B: Omit terminal output entirely (terminal_output, terminal_command)
 * - Pass C: Also omit thinking content (<thinking> blocks)
 * - Pass D: Truncate from oldest messages, prefix with "[Earlier context truncated]"
 *
 * ## Sensitive Token Redaction
 *
 * Terminal output is automatically redacted for:
 * - GitHub tokens: ghp_xxx → ghp_***
 * - GitHub PAT: github_pat_xxx → github_pat_***
 * - Bearer tokens: Bearer xxx → Bearer ***
 * - OpenAI keys: sk-xxx → sk-***
 * - URL auth: https://user:pass@host → https://***@host
 */

import type { MessageContent, ToolCallContent, ResumeFromExternalChatHistoryMeta } from './ai';
import type { SessionHistoryInput } from './schema';

export const DEFAULT_MAX_CHARS = 100_000;
export const DEFAULT_TERMINAL_TAIL_CHARS = 1024;

/**
 * Statistics from the replay prompt generation
 */
export interface ReplayPromptStats {
  /** Total characters used in the generated prompt */
  usedChars: number;
  /** Whether history was truncated to fit the budget */
  truncated: boolean;
  /** Whether terminal output was completely omitted */
  terminalOmitted: boolean;
  /** Whether terminal output was tail-truncated (to 1024 chars) */
  terminalTailApplied: boolean;
  /** Whether thinking/thought content was omitted */
  thinkingOmitted: boolean;
  /** Number of unique file paths collected */
  pathsCount: number;
  /** Number of history entries included in the prompt */
  messagesIncluded: number;
}

/**
 * Result of the replay prompt generation
 */
export interface ReplayPromptResult {
  /** The generated replay prompt text */
  promptText: string;
  /** Statistics about the generation process */
  stats: ReplayPromptStats;
  /** Metadata for the system_notice that should be written to history */
  noticeMeta: ResumeFromExternalChatHistoryMeta;
}

/**
 * Options for building a replay prompt
 */
export interface BuildReplayPromptOptions {
  /** Session history entries (sorted by timestamp ascending) */
  history: SessionHistoryInput[];
  /** History ID to exclude (typically the current user message) */
  excludeTurnId?: string;
  /** Maximum characters for the prompt (default: 100,000) */
  maxChars?: number;
  /** Maximum characters for terminal output tail (default: 1024) */
  terminalTailChars?: number;
}

/**
 * Generation pass configuration
 */
interface GenerationPass {
  includeTerminal: boolean;
  includeThinking: boolean;
  terminalTailChars: number;
}

/**
 * Collected file path with its kind
 */
interface CollectedPath {
  path: string;
  kind: 'read' | 'edit' | 'other';
}

/**
 * Redact sensitive tokens from text.
 *
 * Also used by `conversation-markdown.ts`, which renders the same history for
 * the clipboard.
 */
export function redactSensitiveTokens(text: string): string {
  let output = text;

  // GitHub tokens (classic + fine-grained)
  output = output.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, 'ghp_***');
  output = output.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_***');

  // Generic bearer tokens
  output = output.replace(/\bBearer\s+[A-Za-z0-9\-_.=]{20,}\b/gi, 'Bearer ***');

  // OpenAI-style API keys
  output = output.replace(/\bsk-[A-Za-z0-9]{20,}\b/g, 'sk-***');

  // Basic URL auth redaction: https://user:pass@host -> https://***@host
  output = output.replace(/(https?:\/\/)[^@\s]+@/gi, '$1***@');

  return output;
}

/**
 * Get the tail of a string (last N characters)
 */
function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return '...' + text.slice(-maxChars);
}

/**
 * Extract text content from a message item
 */
function extractTextFromItem(item: MessageContent, pass: GenerationPass): string | null {
  switch (item.type) {
    case 'text':
      return item.text;

    case 'thought':
      if (!pass.includeThinking) {
        return null;
      }
      return `<thinking>\n${item.text}\n</thinking>`;

    case 'tool_call':
      return extractTextFromToolCall(item, pass);

    case 'plan':
      // Summarize plan entries
      if (!item.entries?.length) return null;
      const planLines = item.entries.map((e) => `- [${e.status}] ${e.content}`);
      return `[Plan]\n${planLines.join('\n')}`;

    case 'image':
    case 'image_group':
    case 'available_commands':
    case 'system_notice':
    case 'worktree_script':
      // Skip these in replay prompt
      return null;

    default:
      return null;
  }
}

/**
 * Extract text from a tool_call item
 */
function extractTextFromToolCall(
  item: Extract<MessageContent, { type: 'tool_call' }>,
  pass: GenerationPass
): string | null {
  const parts: string[] = [];

  // Add title if available
  if (item.title) {
    parts.push(`[Tool: ${item.title}]`);
  } else if (item.kind) {
    parts.push(`[Tool: ${item.kind}]`);
  }

  // Process content blocks - always iterate, let extractTextFromToolContent decide what to include
  if (item.content) {
    for (const block of item.content) {
      const blockText = extractTextFromToolContent(block, pass);
      if (blockText) {
        parts.push(blockText);
      }
    }
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Extract text from a tool call content block
 */
function extractTextFromToolContent(block: ToolCallContent, pass: GenerationPass): string | null {
  switch (block.type) {
    case 'terminal_output':
      if (!pass.includeTerminal) {
        return null;
      }
      const output = redactSensitiveTokens(block.output || '');
      const tailedOutput = tail(output, pass.terminalTailChars);
      return tailedOutput ? `[Terminal Output]\n${tailedOutput}` : null;

    case 'terminal_command':
      if (!pass.includeTerminal) {
        return null;
      }
      const cmdParts = [block.command, ...(block.args || [])];
      return `[Command] ${cmdParts.join(' ')}`;

    case 'diff':
      // Include file path info for diffs but not the full content
      return `[Diff: ${block.path}]`;

    case 'content':
      // Standard tool content - extract text if available
      if ('content' in block && block.content && 'type' in block.content) {
        if (block.content.type === 'text' && 'text' in block.content) {
          return block.content.text;
        }
      }
      return null;

    default:
      return null;
  }
}

/**
 * Collect file paths from a tool_call item
 */
function collectPathsFromToolCall(
  item: Extract<MessageContent, { type: 'tool_call' }>
): CollectedPath[] {
  const paths: CollectedPath[] = [];

  if (item.locations) {
    for (const location of item.locations) {
      const kind: 'read' | 'edit' | 'other' =
        item.kind === 'read' ? 'read' : item.kind === 'edit' ? 'edit' : 'other';
      paths.push({ path: location.path, kind });
    }
  }

  // Also extract paths from diff content
  if (item.content) {
    for (const block of item.content) {
      if (block.type === 'diff' && block.path) {
        paths.push({ path: block.path, kind: 'edit' });
      }
    }
  }

  return paths;
}

/**
 * Generate the replay prompt with given configuration
 */
function generatePrompt(
  history: SessionHistoryInput[],
  pass: GenerationPass,
  excludeTurnId?: string
): { text: string; paths: CollectedPath[]; messagesIncluded: number } {
  const lines: string[] = [];
  const allPaths: CollectedPath[] = [];
  let messagesIncluded = 0;

  // Add header
  lines.push('=== Previous Conversation Context ===');
  lines.push('');

  for (const entry of history) {
    // Skip the current message if specified
    if (excludeTurnId && entry.id === excludeTurnId) {
      continue;
    }

    // Skip system messages in replay
    if (entry.role === 'system') {
      continue;
    }

    const roleLabel = entry.role === 'user' ? '[User]' : '[Assistant]';
    const entryParts: string[] = [];

    if (entry.items) {
      for (const item of entry.items as MessageContent[]) {
        // Collect paths from tool calls
        if (item.type === 'tool_call') {
          const paths = collectPathsFromToolCall(item);
          allPaths.push(...paths);
        }

        // Extract text content
        const text = extractTextFromItem(item, pass);
        if (text) {
          entryParts.push(text);
        }
      }
    }

    if (entryParts.length > 0) {
      lines.push(roleLabel);
      lines.push(entryParts.join('\n\n'));
      lines.push('');
      messagesIncluded++;
    }
  }

  // Add files referenced section
  if (allPaths.length > 0) {
    const uniquePaths = new Map<string, 'read' | 'edit' | 'other'>();
    for (const p of allPaths) {
      // Keep the "strongest" kind (edit > read > other)
      const existing = uniquePaths.get(p.path);
      if (!existing || p.kind === 'edit' || (p.kind === 'read' && existing === 'other')) {
        uniquePaths.set(p.path, p.kind);
      }
    }

    lines.push('=== Files Referenced ===');
    const readPaths = [...uniquePaths.entries()].filter(([, k]) => k === 'read').map(([p]) => p);
    const editPaths = [...uniquePaths.entries()].filter(([, k]) => k === 'edit').map(([p]) => p);
    const otherPaths = [...uniquePaths.entries()].filter(([, k]) => k === 'other').map(([p]) => p);

    if (readPaths.length > 0) {
      lines.push(`Read: ${readPaths.join(', ')}`);
    }
    if (editPaths.length > 0) {
      lines.push(`Edit: ${editPaths.join(', ')}`);
    }
    if (otherPaths.length > 0) {
      lines.push(`Other: ${otherPaths.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('=== End of Previous Context ===');
  lines.push('');

  return {
    text: lines.join('\n'),
    paths: allPaths,
    messagesIncluded,
  };
}

/**
 * Truncate prompt from the beginning (oldest messages first) to fit within budget
 */
function truncatePrompt(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  // Find a good breaking point (after === End of Previous Context ===)
  const endMarker = '=== End of Previous Context ===';
  const endIndex = text.lastIndexOf(endMarker);

  if (endIndex === -1) {
    // No marker found, just truncate from the start
    return {
      text: '... [Earlier context truncated] ...\n\n' + text.slice(-maxChars + 50),
      truncated: true,
    };
  }

  // Keep the end marker and files section
  const suffix = text.slice(endIndex);
  const budgetForContent = maxChars - suffix.length - 50; // 50 for truncation notice

  if (budgetForContent <= 0) {
    return {
      text: '... [Context truncated due to length] ...\n\n' + suffix,
      truncated: true,
    };
  }

  const contentPart = text.slice(0, endIndex);
  const truncatedContent = contentPart.slice(-budgetForContent);

  return {
    text: '... [Earlier context truncated] ...\n\n' + truncatedContent + suffix,
    truncated: true,
  };
}

/**
 * Build a replay prompt from session history.
 *
 * Uses a multi-pass approach:
 * 1. Pass A: Include terminal output (tail 1024), include thinking
 * 2. Pass B: Omit terminal output, include thinking
 * 3. Pass C: Omit terminal output, omit thinking
 * 4. Pass D: Truncate from oldest messages
 */
export function buildReplayPromptFromHistory(
  options: BuildReplayPromptOptions
): ReplayPromptResult {
  const {
    history,
    excludeTurnId,
    maxChars = DEFAULT_MAX_CHARS,
    terminalTailChars = DEFAULT_TERMINAL_TAIL_CHARS,
  } = options;

  // Pass A: Full content with terminal tail
  const passA: GenerationPass = {
    includeTerminal: true,
    includeThinking: true,
    terminalTailChars,
  };

  let result = generatePrompt(history, passA, excludeTurnId);
  let terminalOmitted = false;
  let thinkingOmitted = false;
  let truncated = false;
  let terminalTailApplied = true; // We always apply tail when including terminal

  if (result.text.length <= maxChars) {
    // Fits in Pass A
    return {
      promptText: result.text,
      stats: {
        usedChars: result.text.length,
        truncated: false,
        terminalOmitted: false,
        terminalTailApplied: true,
        thinkingOmitted: false,
        pathsCount: new Set(result.paths.map((p) => p.path)).size,
        messagesIncluded: result.messagesIncluded,
      },
      noticeMeta: {},
    };
  }

  // Pass B: Omit terminal output
  const passB: GenerationPass = {
    includeTerminal: false,
    includeThinking: true,
    terminalTailChars,
  };

  result = generatePrompt(history, passB, excludeTurnId);
  terminalOmitted = true;
  terminalTailApplied = false;

  if (result.text.length <= maxChars) {
    return {
      promptText: result.text,
      stats: {
        usedChars: result.text.length,
        truncated: false,
        terminalOmitted: true,
        terminalTailApplied: false,
        thinkingOmitted: false,
        pathsCount: new Set(result.paths.map((p) => p.path)).size,
        messagesIncluded: result.messagesIncluded,
      },
      noticeMeta: { terminalOmitted: true },
    };
  }

  // Pass C: Omit terminal and thinking
  const passC: GenerationPass = {
    includeTerminal: false,
    includeThinking: false,
    terminalTailChars,
  };

  result = generatePrompt(history, passC, excludeTurnId);
  thinkingOmitted = true;

  if (result.text.length <= maxChars) {
    return {
      promptText: result.text,
      stats: {
        usedChars: result.text.length,
        truncated: false,
        terminalOmitted: true,
        terminalTailApplied: false,
        thinkingOmitted: true,
        pathsCount: new Set(result.paths.map((p) => p.path)).size,
        messagesIncluded: result.messagesIncluded,
      },
      noticeMeta: { terminalOmitted: true, thinkingOmitted: true },
    };
  }

  // Pass D: Truncate from oldest
  const { text: truncatedText, truncated: wasTruncated } = truncatePrompt(result.text, maxChars);
  truncated = wasTruncated;

  return {
    promptText: truncatedText,
    stats: {
      usedChars: truncatedText.length,
      truncated,
      terminalOmitted,
      terminalTailApplied,
      thinkingOmitted,
      pathsCount: new Set(result.paths.map((p) => p.path)).size,
      messagesIncluded: result.messagesIncluded,
    },
    noticeMeta: {
      ...(truncated ? { truncated: true } : {}),
      ...(terminalOmitted ? { terminalOmitted: true } : {}),
      ...(thinkingOmitted ? { thinkingOmitted: true } : {}),
    },
  };
}

/** A single traversal preserves the A/B/C/D decisions while retaining at most
 * the prompt budget per candidate, plus the required unique file paths. */
export function createReplayPromptBuilder(options: Omit<BuildReplayPromptOptions, 'history'> = {}) {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const terminalTailChars = options.terminalTailChars ?? DEFAULT_TERMINAL_TAIL_CHARS;
  const capacity = Number.isFinite(maxChars) ? Math.max(0, Math.ceil(maxChars)) : Infinity;
  const candidates = [
    { includeTerminal: true, includeThinking: true, terminalTailChars },
    { includeTerminal: false, includeThinking: true, terminalTailChars },
    { includeTerminal: false, includeThinking: false, terminalTailChars },
  ].map((pass) => ({ pass, length: 0, head: '', tail: '', messages: 0 }));
  type Candidate = (typeof candidates)[number];
  const append = (candidate: Candidate, text: string) => {
    candidate.length += text.length;
    if (candidate.length <= capacity) candidate.head += text;
    else candidate.head = '';
    if (candidate === candidates[2])
      candidate.tail =
        capacity === Infinity
          ? candidate.tail + text
          : text.length >= capacity
            ? text.slice(-capacity || text.length)
            : (candidate.tail + text).slice(-capacity || text.length);
  };
  for (const candidate of candidates)
    append(candidate, '=== Previous Conversation Context ===\n\n');
  const paths = new Map<string, 'read' | 'edit' | 'other'>();
  return {
    add(entry: SessionHistoryInput): void {
      if ((options.excludeTurnId && entry.id === options.excludeTurnId) || entry.role === 'system')
        return;
      for (const item of entry.items ?? [])
        if (item.type === 'tool_call')
          for (const path of collectPathsFromToolCall(item)) {
            const prior = paths.get(path.path);
            if (!prior || path.kind === 'edit' || (path.kind === 'read' && prior === 'other'))
              paths.set(path.path, path.kind);
          }
      for (const candidate of candidates) {
        let parts = 0;
        for (const item of entry.items ?? []) {
          const text = extractTextFromItem(item as MessageContent, candidate.pass);
          if (!text) continue;
          append(candidate, parts ? '\n\n' : entry.role === 'user' ? '[User]\n' : '[Assistant]\n');
          append(candidate, text);
          parts++;
        }
        if (parts) {
          append(candidate, '\n\n');
          candidate.messages++;
        }
      }
    },
    finish(): ReplayPromptResult {
      let footer = '';
      if (paths.size) {
        footer = '=== Files Referenced ===\n';
        for (const [kind, label] of [
          ['read', 'Read'],
          ['edit', 'Edit'],
          ['other', 'Other'],
        ] as const) {
          const values = [...paths].filter(([, value]) => value === kind).map(([path]) => path);
          if (values.length) footer += `${label}: ${values.join(', ')}\n`;
        }
        footer += '\n';
      }
      const end = '=== End of Previous Context ===\n';
      for (const candidate of candidates) append(candidate, footer);
      const index = candidates.findIndex((candidate) => candidate.length + end.length <= maxChars);
      const chosen = candidates[index < 0 ? 2 : index]!;
      let text = chosen.head + end,
        truncated = false;
      if (index < 0) {
        truncated = true;
        const budget = maxChars - end.length - 50;
        text =
          budget <= 0
            ? '... [Context truncated due to length] ...\n\n' + end
            : '... [Earlier context truncated] ...\n\n' + chosen.tail.slice(-budget) + end;
      }
      const terminalOmitted = index !== 0,
        thinkingOmitted = index < 0 || index === 2;
      return {
        promptText: text,
        stats: {
          usedChars: text.length,
          truncated,
          terminalOmitted,
          terminalTailApplied: !terminalOmitted,
          thinkingOmitted,
          pathsCount: paths.size,
          messagesIncluded: chosen.messages,
        },
        noticeMeta: {
          ...(truncated ? { truncated: true } : {}),
          ...(terminalOmitted ? { terminalOmitted: true } : {}),
          ...(thinkingOmitted ? { thinkingOmitted: true } : {}),
        },
      };
    },
  };
}

/**
 * Check if the last entry before the latest user message is already a resume notice.
 * This prevents duplicate notices when the user sends multiple messages in quick succession
 * without any assistant response in between, but allows new notices on each resume.
 */
export function hasRecentResumeNotice(
  history: SessionHistoryInput[],
  _lookbackCount = 5 // deprecated, kept for API compatibility
): boolean {
  // Find the last user message index
  let lastUserIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry && entry.role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  // Check if the entry immediately before the last user message is a resume notice
  if (lastUserIndex > 0) {
    const prevEntry = history[lastUserIndex - 1];
    if (prevEntry && prevEntry.role === 'system' && prevEntry.items) {
      for (const item of prevEntry.items as MessageContent[]) {
        if (item.type === 'system_notice' && item.name === 'resume_from_external_chat_history') {
          return true;
        }
      }
    }
  }

  return false;
}
