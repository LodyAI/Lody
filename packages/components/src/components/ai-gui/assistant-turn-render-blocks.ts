import type { MessageContent } from '@lody/shared';
import {
  buildAssistantMessageRenderItems,
  type AssistantMessageRenderItem,
} from './assistant-message-render-items';
import { shouldCollapseAssistantMessageItem } from './message-copy';

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;
type ThoughtMessage = Extract<MessageContent, { type: 'thought' }>;

export type AssistantToolCallRenderItem = Omit<AssistantMessageRenderItem, 'content'> & {
  content: ToolCallMessage;
};

export type AssistantThoughtRenderItem = Omit<AssistantMessageRenderItem, 'content'> & {
  content: ThoughtMessage;
};

export type AssistantActivityRenderItem = AssistantToolCallRenderItem | AssistantThoughtRenderItem;

export type AssistantActivitySummary = {
  hasThought: boolean;
  commandCount: number;
  readFileCount: number;
  editFileCount: number;
  searchCount: number;
  fetchCount: number;
  otherCount: number;
};

export type AssistantTurnRenderBlock =
  | {
      kind: 'content';
      key: string;
      entry: AssistantMessageRenderItem;
    }
  | {
      kind: 'activity_group';
      key: string;
      entries: AssistantActivityRenderItem[];
      summary: AssistantActivitySummary;
    };

/**
 * One independently foldable region of an assistant turn.
 *
 * A turn is usually one segment. Approving a plan splits it: the agent asks to
 * leave plan mode from INSIDE a running turn, so the same turn goes on to
 * implement the plan it just proposed. A single region would fold the whole
 * implementation into the plan's `Worked for …` row — an approved plan would
 * appear to produce nothing.
 *
 * `blockRange` is a half-open `[start, end)` index range into `blocks`.
 */
export type AssistantTurnRenderSegment = {
  key: string;
  blockRange: readonly [number, number];
  workBlockKeys: ReadonlySet<string>;
  /** Index into `blocks` where this segment's work group goes; -1 if none. */
  firstWorkBlockIndex: number;
};

export type AssistantTurnRenderLayout = {
  blocks: AssistantTurnRenderBlock[];
  segments: readonly AssistantTurnRenderSegment[];
  workBlockKeys: ReadonlySet<string>;
  firstWorkBlockIndex: number;
  entries: readonly AssistantMessageRenderItem[];
};

const getToolFilePaths = (toolCall: ToolCallMessage): string[] => {
  const paths = new Set<string>();
  for (const location of toolCall.locations ?? []) {
    if (location.path) paths.add(location.path);
  }
  for (const block of toolCall.content ?? []) {
    if (block.type === 'diff' && block.path) paths.add(block.path);
  }
  return [...paths];
};

export const summarizeAssistantActivity = (
  entries: readonly AssistantActivityRenderItem[]
): AssistantActivitySummary => {
  const readPaths = new Set<string>();
  const editPaths = new Set<string>();
  let readCallsWithoutPaths = 0;
  let editCallsWithoutPaths = 0;
  let commandCount = 0;
  let searchCount = 0;
  let fetchCount = 0;
  let otherCount = 0;

  let hasThought = false;

  for (const { content } of entries) {
    if (content.type === 'thought' || content.kind === 'think') {
      hasThought = true;
      continue;
    }
    const toolCall = content;
    const paths = getToolFilePaths(toolCall);
    switch (toolCall.kind) {
      case 'execute':
      case 'bash':
        commandCount += 1;
        break;
      case 'read':
        if (paths.length === 0) {
          readCallsWithoutPaths += 1;
        } else {
          for (const path of paths) readPaths.add(path);
        }
        break;
      case 'edit':
      case 'write':
      case 'delete':
      case 'move':
        if (paths.length === 0) {
          editCallsWithoutPaths += 1;
        } else {
          for (const path of paths) editPaths.add(path);
        }
        break;
      case 'search':
        searchCount += 1;
        break;
      case 'fetch':
        fetchCount += 1;
        break;
      default: {
        const hasTerminalContent = toolCall.content?.some(
          (block) => block.type === 'terminal_command' || block.type === 'terminal_output'
        );
        if (hasTerminalContent) {
          commandCount += 1;
        } else {
          otherCount += 1;
        }
      }
    }
  }

  return {
    hasThought,
    commandCount,
    readFileCount: readPaths.size + readCallsWithoutPaths,
    editFileCount: editPaths.size + editCallsWithoutPaths,
    searchCount,
    fetchCount,
    otherCount,
  };
};

const isActivityGroupEntry = (
  entry: AssistantMessageRenderItem
): entry is AssistantActivityRenderItem =>
  entry.content.type === 'thought' ||
  (entry.content.type === 'tool_call' &&
    entry.content.kind !== 'switch_mode' &&
    entry.content.activityKind === undefined);

const buildActivityGroupKey = (messageId: string, first: AssistantActivityRenderItem): string => {
  const suffix = first.content.type === 'tool_call' ? first.content.toolCallId : first.itemIndex;
  return `activity-group:${messageId}:${first.itemIndex}:${suffix}`;
};

const buildAssistantTurnRenderBlocksFromEntries = (
  messageId: string,
  entries: readonly AssistantMessageRenderItem[]
): AssistantTurnRenderBlock[] => {
  const blocks: AssistantTurnRenderBlock[] = [];
  let pendingActivityEntries: AssistantActivityRenderItem[] = [];

  const flushActivityGroup = () => {
    const first = pendingActivityEntries[0];
    if (!first) return;
    blocks.push({
      kind: 'activity_group',
      key: buildActivityGroupKey(messageId, first),
      entries: pendingActivityEntries,
      summary: summarizeAssistantActivity(pendingActivityEntries),
    });
    pendingActivityEntries = [];
  };

  for (const entry of entries) {
    if (entry.content.type === 'available_commands') {
      continue;
    }
    if (isActivityGroupEntry(entry)) {
      pendingActivityEntries.push(entry);
      continue;
    }

    flushActivityGroup();
    blocks.push({
      kind: 'content',
      key: `content:${messageId}:${entry.itemIndex}:${entry.content.type}`,
      entry,
    });
  }

  flushActivityGroup();
  return blocks;
};

export const buildAssistantTurnRenderBlocks = (
  messageId: string,
  items: readonly MessageContent[]
): AssistantTurnRenderBlock[] =>
  buildAssistantTurnRenderBlocksFromEntries(messageId, buildAssistantMessageRenderItems(items));

/**
 * The plan-approval card, which closes a segment (see `AssistantTurnRenderSegment`).
 *
 * Matched on the ACP tool KIND, never on a title — the bundled adapters word it
 * differently for the same event (Claude's `ExitPlanMode` renders "Ready to
 * code?", Codex's plan review renders "Implement this plan?"), and both are the
 * one thing this cares about: the user was asked to let a running turn start
 * implementing. An agent that emits `switch_mode` for some other mode change
 * just gets an extra region, which is harmless.
 */
const isPlanExitBlock = (block: AssistantTurnRenderBlock | undefined): boolean =>
  block?.kind === 'content' &&
  block.entry.content.type === 'tool_call' &&
  block.entry.content.kind === 'switch_mode';

/**
 * Half-open `[start, end)` block ranges, cut AFTER each plan-exit card so the
 * card stays with the plan it closes and the approved work starts a new region.
 */
const buildSegmentBlockRanges = (
  blocks: readonly AssistantTurnRenderBlock[]
): Array<readonly [number, number]> => {
  const ranges: Array<readonly [number, number]> = [];
  let start = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    if (isPlanExitBlock(blocks[index])) {
      ranges.push([start, index + 1]);
      start = index + 1;
    }
  }
  // A turn ending exactly on the card leaves no trailing segment to add.
  if (start < blocks.length) {
    ranges.push([start, blocks.length]);
  }
  return ranges.length > 0 ? ranges : [[0, blocks.length]];
};

const collectSegmentEntries = (
  blocks: readonly AssistantTurnRenderBlock[],
  [start, end]: readonly [number, number]
): AssistantMessageRenderItem[] => {
  const entries: AssistantMessageRenderItem[] = [];
  for (let index = start; index < end; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    if (block.kind === 'content') {
      entries.push(block.entry);
    } else {
      entries.push(...block.entries);
    }
  }
  return entries;
};

export const buildAssistantTurnRenderLayout = (
  messageId: string,
  items: readonly MessageContent[],
  isTurnFinished: boolean
): AssistantTurnRenderLayout => {
  const entries = buildAssistantMessageRenderItems(items);
  const blocks = buildAssistantTurnRenderBlocksFromEntries(messageId, entries);
  const ranges = buildSegmentBlockRanges(blocks);

  // Nothing folds while the turn streams, but the segment shape does not depend
  // on that — keep it stable so only the fold state changes at turn end.
  const segments: AssistantTurnRenderSegment[] = ranges.map((blockRange, segmentIndex) => {
    const key = `segment:${messageId}:${segmentIndex}`;
    if (!isTurnFinished) {
      return { key, blockRange, workBlockKeys: new Set<string>(), firstWorkBlockIndex: -1 };
    }

    // The "keep the final contiguous text run visible" rule is applied PER
    // SEGMENT: each region has its own answer tail. Applied across the whole
    // turn, the plan would be demoted to process output just because
    // implementation followed it.
    const segmentEntries = collectSegmentEntries(blocks, blockRange);
    const segmentContents = segmentEntries.map((entry) => entry.content);
    const collapsibleItemIndexes = new Set<number>();
    segmentEntries.forEach((entry, indexInSegment) => {
      if (
        shouldCollapseAssistantMessageItem({
          content: entry.content,
          index: indexInSegment,
          items: segmentContents,
          isTurnFinished,
        })
      ) {
        collapsibleItemIndexes.add(entry.itemIndex);
      }
    });

    const segmentWorkBlockKeys = new Set<string>();
    let firstWorkBlockIndex = -1;
    for (let index = blockRange[0]; index < blockRange[1]; index += 1) {
      const block = blocks[index];
      if (!block) continue;
      if (block.kind === 'activity_group' || collapsibleItemIndexes.has(block.entry.itemIndex)) {
        segmentWorkBlockKeys.add(block.key);
        if (firstWorkBlockIndex === -1) {
          firstWorkBlockIndex = index;
        }
      }
    }
    return { key, blockRange, workBlockKeys: segmentWorkBlockKeys, firstWorkBlockIndex };
  });

  const workBlockKeys = new Set<string>();
  for (const segment of segments) {
    for (const key of segment.workBlockKeys) {
      workBlockKeys.add(key);
    }
  }

  return {
    blocks,
    segments,
    workBlockKeys,
    firstWorkBlockIndex: blocks.findIndex((block) => workBlockKeys.has(block.key)),
    entries,
  };
};
