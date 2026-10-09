import type { SessionHistory } from '@lody/shared';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { unified } from 'unified';

/**
 * In-conversation search indexes PROSE ONLY: what the user typed and what the
 * agent wrote as body text — including the progress text, thinking, and plan
 * markdown folded inside the collapsed "Worked for …" workflow group.
 *
 * Tool calls are deliberately NOT indexed (titles, file paths, JSON
 * input/output, terminal command/output, diffs) and neither are the structured
 * ACP status items (plan checklists, goals) or worktree script output. They are
 * agent-API payloads, not conversation text; indexing them buried real matches
 * under hundreds of hits from logs, file paths, and JSON. Do not add them back
 * — filter noise out of the index, not out of the result list.
 */
export type SessionSearchBlockType = 'assistant_markdown' | 'thought' | 'user_text';

export type SessionSearchBlock = {
  blockId: string;
  messageId: string;
  messageIndex: number;
  itemIndex: number;
  blockType: SessionSearchBlockType;
  text: string;
};

export type SessionSearchResult = {
  resultId: string;
  blockId: string;
  messageId: string;
  messageIndex: number;
  itemIndex: number;
  blockType: SessionSearchBlockType;
  localIndex: number;
  start: number;
  end: number;
};

export type SessionSearchTextPart = {
  text: string;
  resultId: string | null;
  isMatch: boolean;
  isActive: boolean;
};

const normalizeNewlines = (value: string) => value.replace(/\r\n?/g, '\n');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const searchMarkdownParser = unified().use(remarkParse).use(remarkGfm).freeze();

type SearchMarkdownNode = {
  type: string;
  value?: string;
  alt?: string | null;
  children?: SearchMarkdownNode[];
};

const markdownNodeText = (node: SearchMarkdownNode): string => {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'code':
    case 'html':
      return node.value ?? '';
    case 'image':
    case 'imageReference':
      return node.alt ?? '';
    case 'break':
      return '\n';
    case 'definition':
      return '';
    default:
      // Keep inline runs contiguous, but never invent a word across blocks.
      return (node.children ?? [])
        .map(markdownNodeText)
        .join(
          ['root', 'blockquote', 'list', 'listItem', 'table', 'tableRow'].includes(node.type)
            ? '\n'
            : ''
        );
  }
};

/**
 * Extract CommonMark/GFM prose and code text. Parsing distinguishes formatting
 * delimiters from literal punctuation, including intraword underscores and
 * every character inside code. The outline passes only its bounded prefix.
 * Renderer-specific widgets (math, diagrams, image state) remain approximate.
 */
export const getSearchableMarkdownText = (value: string): string =>
  markdownNodeText(searchMarkdownParser.parse(normalizeNewlines(value))).trim();

const pushBlock = (
  blocks: SessionSearchBlock[],
  block: Omit<SessionSearchBlock, 'text'> & { text: string | null | undefined }
) => {
  const text = normalizeNewlines(block.text ?? '').trim();
  if (!text) {
    return;
  }
  blocks.push({ ...block, text });
};

export const getMessageItemPrefix = (messageId: string, itemIndex: number) =>
  `message:${messageId}:item:${itemIndex}`;

export const getTextSearchBlockId = (messageId: string, itemIndex: number) =>
  `${getMessageItemPrefix(messageId, itemIndex)}:text`;

export const getThoughtSearchBlockId = (messageId: string, itemIndex: number) =>
  `${getMessageItemPrefix(messageId, itemIndex)}:thought`;

export const getProposedPlanSearchBlockId = (messageId: string, itemIndex: number) =>
  `${getMessageItemPrefix(messageId, itemIndex)}:proposed-plan`;

/**
 * Extract search blocks from a single message at a given index.
 * This is the building block for both batch and incremental extraction.
 */
export const extractSearchBlocksForMessage = (
  message: SessionHistory,
  messageIndex: number
): SessionSearchBlock[] => {
  const blocks: SessionSearchBlock[] = [];
  const rawItems = Array.isArray(message.items) ? message.items : [];
  rawItems.forEach((item, itemIndex) => {
    if (!isRecord(item) || typeof item.type !== 'string') {
      return;
    }

    switch (item.type) {
      case 'text':
        pushBlock(blocks, {
          blockId: getTextSearchBlockId(message.id, itemIndex),
          messageId: message.id,
          messageIndex,
          itemIndex,
          blockType: message.role === 'user' ? 'user_text' : 'assistant_markdown',
          text:
            message.role === 'user'
              ? getString(item.text)
              : getSearchableMarkdownText(getString(item.text) ?? ''),
        });
        return;
      case 'thought':
        pushBlock(blocks, {
          blockId: getThoughtSearchBlockId(message.id, itemIndex),
          messageId: message.id,
          messageIndex,
          itemIndex,
          blockType: 'thought',
          text: getSearchableMarkdownText(getString(item.text) ?? ''),
        });
        return;
      case 'proposed_plan':
        pushBlock(blocks, {
          blockId: getProposedPlanSearchBlockId(message.id, itemIndex),
          messageId: message.id,
          messageIndex,
          itemIndex,
          blockType: 'assistant_markdown',
          text: getSearchableMarkdownText(getString(item.markdown) ?? ''),
        });
        return;
      default:
        return;
    }
  });
  return blocks;
};

export const extractSessionSearchBlocks = (
  history: readonly SessionHistory[] | undefined
): SessionSearchBlock[] => {
  if (!history?.length) {
    return [];
  }

  const blocks: SessionSearchBlock[] = [];
  history.forEach((message, messageIndex) => {
    blocks.push(...extractSearchBlocksForMessage(message, messageIndex));
  });

  return blocks;
};

export const normalizeSessionSearchQuery = (query: string): string => query.trim().toLowerCase();

export const findSessionSearchOccurrences = (
  text: string,
  query: string
): Array<{ start: number; end: number }> => {
  const normalizedQuery = normalizeSessionSearchQuery(query);
  if (!normalizedQuery) {
    return [];
  }

  const haystack = text.toLowerCase();
  const matches: Array<{ start: number; end: number }> = [];
  let cursor = 0;

  while (cursor < haystack.length) {
    const start = haystack.indexOf(normalizedQuery, cursor);
    if (start === -1) {
      break;
    }
    matches.push({ start, end: start + normalizedQuery.length });
    cursor = start + normalizedQuery.length;
  }

  return matches;
};

export const buildSessionSearchResults = (
  blocks: readonly SessionSearchBlock[],
  query: string
): SessionSearchResult[] => {
  const normalizedQuery = normalizeSessionSearchQuery(query);
  if (!normalizedQuery) {
    return [];
  }

  return blocks.flatMap((block) =>
    findSessionSearchOccurrences(block.text, normalizedQuery).map((match, localIndex) => ({
      resultId: `${block.blockId}:match:${localIndex}`,
      blockId: block.blockId,
      messageId: block.messageId,
      messageIndex: block.messageIndex,
      itemIndex: block.itemIndex,
      blockType: block.blockType,
      localIndex,
      start: match.start,
      end: match.end,
    }))
  );
};

export const buildSessionSearchTextParts = ({
  text,
  query,
  resultIds,
  activeOccurrenceIndex,
}: {
  text: string;
  query: string;
  resultIds: readonly string[];
  activeOccurrenceIndex: number | null;
}): SessionSearchTextPart[] => {
  const matches = findSessionSearchOccurrences(text, query);
  if (!matches.length) {
    return [{ text, resultId: null, isMatch: false, isActive: false }];
  }

  const parts: SessionSearchTextPart[] = [];
  let cursor = 0;

  matches.forEach((match, index) => {
    if (match.start > cursor) {
      parts.push({
        text: text.slice(cursor, match.start),
        resultId: null,
        isMatch: false,
        isActive: false,
      });
    }

    parts.push({
      text: text.slice(match.start, match.end),
      resultId: resultIds[index] ?? null,
      isMatch: true,
      isActive: activeOccurrenceIndex === index,
    });

    cursor = match.end;
  });

  if (cursor < text.length) {
    parts.push({
      text: text.slice(cursor),
      resultId: null,
      isMatch: false,
      isActive: false,
    });
  }

  return parts;
};
