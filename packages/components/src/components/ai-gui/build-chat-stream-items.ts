import type { MessageContent, SessionHistory, SessionHistoryParsed, SessionId } from '@lody/shared';
import {
  isEmptyAssistantIndexRow,
  resolveLastAssistantTurnIds,
  type ConversationView,
  type TurnIndexRow,
} from '@/lib/conversation-view';
import type { ChatStreamItem, PlaceholderSessionItem } from './view';
import { normalizeMessageContent } from './message-content-guards';

export type BuildChatStreamItemsCache = ReadonlyMap<string, CachedChatStreamMessageItem>;

export type BuildChatStreamItemsResult = {
  items: ChatStreamItem[];
  lastAssistantMessageId: string | null;
  lastCompletedAssistantMessageId: string | null;
  cache: BuildChatStreamItemsCache;
};

type CachedChatStreamMessageItem = {
  readonly item: ChatStreamItem & { type: 'message' };
  readonly rawEntry: SessionHistory;
  readonly rawAcpTurnId: unknown;
  readonly rawItems: unknown;
  readonly rawStatus: unknown;
  readonly rawModelInfo: unknown;
  readonly rawFileDiff: unknown;
  readonly rawPlan: unknown;
  /** Preceding user-turn config attached for assistant header display. */
  readonly rawTurnInputConfig: unknown;
};

const EMPTY_CHAT_STREAM_ITEM: ChatStreamItem = { type: 'empty' };

const parseHistoryItemsForRender = (rawItems: unknown): MessageContent[] => {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .map((item) => normalizeMessageContent(item))
    .filter((item): item is MessageContent => item !== null);
};

/**
 * An assistant entry with no items and no plan renders to `null` (see `ChatItem`
 * in view.tsx). Interrupted / aborted turns leave exactly these behind.
 */
const isEmptyAssistantMessage = (message: SessionHistoryParsed): boolean =>
  message.role === 'assistant' &&
  !message.items.length &&
  !(message.plan && message.plan.length > 0);

function canReuseCachedMessageItem(
  cached: CachedChatStreamMessageItem | undefined,
  entry: SessionHistory,
  sessionId: SessionId,
  turnIndex: number,
  /** Resolved config we would attach to this message (user's own or inherited). */
  expectedInputConfig: SessionHistoryParsed['inputConfig']
): cached is CachedChatStreamMessageItem {
  return (
    cached !== undefined &&
    cached.item.sessionId === sessionId &&
    cached.item.turnIndex === turnIndex &&
    cached.rawEntry === entry &&
    cached.rawAcpTurnId === entry.acpTurnId &&
    cached.rawItems === entry.items &&
    cached.item.message.id === entry.id &&
    cached.item.message.role === entry.role &&
    cached.rawStatus === entry.status &&
    cached.item.message.read === (entry.read ?? false) &&
    cached.item.message.timestamp === entry.timestamp &&
    cached.item.message.endedAt === entry.endedAt &&
    cached.item.message.userId === entry.userId &&
    cached.rawModelInfo === entry.modelInfo &&
    cached.rawFileDiff === entry.fileDiff &&
    cached.item.message.finished === entry.finished &&
    cached.rawPlan === entry.plan &&
    cached.rawTurnInputConfig === expectedInputConfig
  );
}

function createCachedMessageItem(
  entry: SessionHistory,
  sessionId: SessionId,
  turnIndex: number,
  message: SessionHistoryParsed
): CachedChatStreamMessageItem {
  return {
    item: { type: 'message', sessionId, message, turnIndex },
    rawEntry: entry,
    rawAcpTurnId: entry.acpTurnId,
    rawItems: entry.items,
    rawStatus: entry.status,
    rawModelInfo: entry.modelInfo,
    rawFileDiff: entry.fileDiff,
    rawPlan: entry.plan,
    rawTurnInputConfig: message.inputConfig,
  };
}

// Placeholder items are keyed by the index row object: the view hands out a
// new row whenever the turn's index facts change, so identity is the change
// signal and unchanged placeholders keep their item (and Virtua row) identity.
const placeholderItemCache = new WeakMap<TurnIndexRow, PlaceholderSessionItem>();

const placeholderItemFor = (row: TurnIndexRow, turnIndex: number): PlaceholderSessionItem => {
  const cached = placeholderItemCache.get(row);
  if (cached && cached.turnIndex === turnIndex) return cached;
  const item: PlaceholderSessionItem = { type: 'placeholder', row, turnIndex };
  placeholderItemCache.set(row, item);
  return item;
};

/**
 * Build the Virtua VList item list from a `ConversationView`: one item per turn
 * in conversation order — a parsed message for hydrated turns, a placeholder
 * carrying the index row for the rest. Both carry `turnIndex`, the absolute
 * position every scroll target and outline anchor is expressed in.
 *
 * Two defensive normalizations keep the virtual list robust against histories
 * left in an unusual shape by interrupted / bad-network turns. Such shapes
 * corrupt Virtua's index-keyed size cache and make its absolutely-positioned
 * rows overlap ("explode") deterministically — a stable, per-conversation bug:
 *
 *  1. Drop empty assistant entries (no items, no plan). They render to `null`,
 *     i.e. a virtual row with no DOM for Virtua's ResizeObserver to measure, so
 *     Virtua keeps a stale/estimated size and every offset after it drifts.
 *     The same rule applies to placeholders through the index row's counts.
 *  2. De-duplicate by `id`. The VList keys rows by `history.id`; a duplicate id
 *     produces duplicate React keys and desyncs Virtua's element↔index map. Ids
 *     are random UUIDs so collisions are improbable, but this is cheap insurance
 *     so a single corrupt doc cannot permanently break the layout.
 *
 * `lastAssistantMessageId` / `lastCompletedAssistantMessageId` come from the
 * index over the WHOLE conversation with the same empty-entry rule, so
 * context-window usage / quick actions attach to the last rendered assistant
 * message whether or not it is hydrated.
 */
export function buildChatStreamItems(
  view: ConversationView | null,
  sessionId: SessionId,
  previousCache?: BuildChatStreamItemsCache
): BuildChatStreamItemsResult {
  const items: ChatStreamItem[] = [];
  const seenIds = new Set<string>();
  const cache = new Map<string, CachedChatStreamMessageItem>();
  if (!view) {
    return {
      items: [EMPTY_CHAT_STREAM_ITEM],
      lastAssistantMessageId: null,
      lastCompletedAssistantMessageId: null,
      cache,
    };
  }
  const { lastAssistantMessageId, lastCompletedAssistantMessageId } =
    resolveLastAssistantTurnIds(view);
  /** Config from the latest user turn — attached to the following assistant
   *  so the model meta row can show the full turn run-config on demand. A
   *  non-hydrated user turn resets it: the header then shows nothing rather
   *  than an older turn's configuration. */
  let lastUserInputConfig: SessionHistoryParsed['inputConfig'] | undefined;

  for (let turnIndex = 0; turnIndex < view.turnCount; turnIndex += 1) {
    const row = view.index(turnIndex);
    if (!row) continue;
    const entry = view.turn(turnIndex);

    if (!entry) {
      if (row.role === 'user') lastUserInputConfig = undefined;
      if (isEmptyAssistantIndexRow(row)) continue;
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      items.push(placeholderItemFor(row, turnIndex));
      continue;
    }

    if (entry.role === 'user') {
      lastUserInputConfig = entry.inputConfig;
    }

    const expectedInputConfig =
      entry.role === 'user'
        ? entry.inputConfig
        : entry.role === 'assistant'
          ? (entry.inputConfig ?? lastUserInputConfig)
          : entry.inputConfig;

    const cached = previousCache?.get(entry.id);
    if (canReuseCachedMessageItem(cached, entry, sessionId, turnIndex, expectedInputConfig)) {
      if (seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      cache.set(entry.id, cached);
      items.push(cached.item);
      continue;
    }

    const message: SessionHistoryParsed = {
      id: entry.id,
      items: parseHistoryItemsForRender(entry.items),
      role: entry.role,
      status: entry.status,
      read: entry.read ?? false,
      timestamp: entry.timestamp,
      endedAt: entry.endedAt,
      userId: entry.userId,
      acpTurnId: entry.acpTurnId,
      modelInfo: entry.modelInfo,
      fileDiff: entry.fileDiff,
      finished: entry.finished,
      plan: entry.plan,
      // User turns keep their own config; assistant turns inherit the
      // preceding user's so the header can list mode / effort / plan / fast.
      inputConfig: expectedInputConfig,
    };

    if (isEmptyAssistantMessage(message)) continue;
    if (seenIds.has(message.id)) continue;
    seenIds.add(message.id);

    const cachedMessageItem = createCachedMessageItem(entry, sessionId, turnIndex, message);
    cache.set(message.id, cachedMessageItem);
    items.push(cachedMessageItem.item);
  }

  if (!items.length) {
    return {
      items: [EMPTY_CHAT_STREAM_ITEM],
      lastAssistantMessageId: null,
      lastCompletedAssistantMessageId: null,
      cache,
    };
  }
  return { items, lastAssistantMessageId, lastCompletedAssistantMessageId, cache };
}
