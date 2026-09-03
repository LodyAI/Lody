import type { MessageContent, SessionHistory, SessionHistoryParsed, SessionId } from '@lody/shared';
import type { ConversationView, TurnIndexRow } from '@/lib/conversation-view';
import type { ChatStreamItem, SessionMessageItem, TurnPlaceholderItem } from './view';
import { normalizeMessageContent } from './message-content-guards';

export type BuildChatStreamItemsCache = ReadonlyMap<string, CachedChatStreamMessageItem>;

export type BuildChatStreamItemsResult = {
  items: ChatStreamItem[];
  lastAssistantMessageId: string | null;
  lastCompletedAssistantMessageId: string | null;
  cache: BuildChatStreamItemsCache;
};

type CachedChatStreamMessageItem = {
  readonly item: SessionMessageItem;
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

/** The same rule read from an index row, for a turn that is not hydrated. */
const isEmptyAssistantRow = (row: TurnIndexRow): boolean =>
  row.role === 'assistant' && (row.itemCount ?? 0) === 0 && (row.planCount ?? 0) === 0;

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
    item: { type: 'message', sessionId, turnIndex, message },
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

/**
 * Placeholders are keyed by index ROW: `ConversationView` hands out the same
 * row object until the turn changes, so an unchanged placeholder keeps its
 * identity across rebuilds and the memoized row components stay quiet.
 */
const placeholderByRow = new WeakMap<TurnIndexRow, TurnPlaceholderItem>();

const placeholderItem = (
  row: TurnIndexRow,
  sessionId: SessionId,
  turnIndex: number
): TurnPlaceholderItem => {
  const cached = placeholderByRow.get(row);
  if (cached && cached.sessionId === sessionId && cached.turnIndex === turnIndex) return cached;
  const item: TurnPlaceholderItem = { type: 'placeholder', sessionId, turnIndex, row };
  placeholderByRow.set(row, item);
  return item;
};

type Builder = {
  items: ChatStreamItem[];
  seenIds: Set<string>;
  cache: Map<string, CachedChatStreamMessageItem>;
  previousCache: BuildChatStreamItemsCache | undefined;
  sessionId: SessionId;
  lastAssistantMessageId: string | null;
  lastCompletedAssistantMessageId: string | null;
  /** Config from the latest user turn — attached to the following assistant
   *  so the model meta row can show the full turn run-config on demand. */
  lastUserInputConfig: SessionHistoryParsed['inputConfig'] | undefined;
};

const createBuilder = (
  sessionId: SessionId,
  previousCache: BuildChatStreamItemsCache | undefined
): Builder => ({
  items: [],
  seenIds: new Set(),
  cache: new Map(),
  previousCache,
  sessionId,
  lastAssistantMessageId: null,
  lastCompletedAssistantMessageId: null,
  lastUserInputConfig: undefined,
});

const noteAssistant = (builder: Builder, id: string, finished: boolean | undefined): void => {
  builder.lastAssistantMessageId = id;
  if (finished === true) builder.lastCompletedAssistantMessageId = id;
};

const pushHydratedEntry = (builder: Builder, entry: SessionHistory, turnIndex: number): void => {
  if (entry.role === 'user' && entry.inputConfig) {
    builder.lastUserInputConfig = entry.inputConfig;
  }

  const expectedInputConfig =
    entry.role === 'user'
      ? entry.inputConfig
      : entry.role === 'assistant'
        ? (entry.inputConfig ?? builder.lastUserInputConfig)
        : entry.inputConfig;

  const cached = builder.previousCache?.get(entry.id);
  if (canReuseCachedMessageItem(cached, entry, builder.sessionId, turnIndex, expectedInputConfig)) {
    if (builder.seenIds.has(entry.id)) return;
    builder.seenIds.add(entry.id);
    if (entry.role === 'assistant') noteAssistant(builder, entry.id, entry.finished);
    builder.cache.set(entry.id, cached);
    builder.items.push(cached.item);
    return;
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

  if (isEmptyAssistantMessage(message)) return;
  if (builder.seenIds.has(message.id)) return;
  builder.seenIds.add(message.id);

  const cachedMessageItem = createCachedMessageItem(entry, builder.sessionId, turnIndex, message);
  builder.cache.set(message.id, cachedMessageItem);
  if (message.role === 'assistant') noteAssistant(builder, message.id, message.finished);
  builder.items.push(cachedMessageItem.item);
};

const finish = (builder: Builder): BuildChatStreamItemsResult => {
  if (!builder.items.length) {
    return {
      items: [EMPTY_CHAT_STREAM_ITEM],
      lastAssistantMessageId: null,
      lastCompletedAssistantMessageId: null,
      cache: builder.cache,
    };
  }
  return {
    items: builder.items,
    lastAssistantMessageId: builder.lastAssistantMessageId,
    lastCompletedAssistantMessageId: builder.lastCompletedAssistantMessageId,
    cache: builder.cache,
  };
};

/**
 * Build the Virtua VList item list from raw session history.
 *
 * Two defensive normalizations keep the virtual list robust against histories
 * left in an unusual shape by interrupted / bad-network turns. Such shapes
 * corrupt Virtua's index-keyed size cache and make its absolutely-positioned
 * rows overlap ("explode") deterministically — a stable, per-conversation bug:
 *
 *  1. Drop empty assistant entries (no items, no plan). They render to `null`,
 *     i.e. a virtual row with no DOM for Virtua's ResizeObserver to measure, so
 *     Virtua keeps a stale/estimated size and every offset after it drifts.
 *  2. De-duplicate by `id`. The VList keys rows by `history.id`; a duplicate id
 *     produces duplicate React keys and desyncs Virtua's element↔index map. Ids
 *     are random UUIDs so collisions are improbable, but this is cheap insurance
 *     so a single corrupt doc cannot permanently break the layout.
 *
 * `lastAssistantMessageId` is computed over the normalized list so context-window
 * usage / quick actions attach to the last *rendered* assistant message.
 *
 * This is the rollback path (no `ConversationView`); `turnIndex` is the
 * position in `history`.
 */
export function buildChatStreamItems(
  history: readonly SessionHistory[],
  sessionId: SessionId,
  previousCache?: BuildChatStreamItemsCache
): BuildChatStreamItemsResult {
  const builder = createBuilder(sessionId, previousCache);
  for (let turnIndex = 0; turnIndex < history.length; turnIndex += 1) {
    const entry = history[turnIndex];
    if (entry) pushHydratedEntry(builder, entry, turnIndex);
  }
  return finish(builder);
}

/**
 * The same list read through a `ConversationView`: one item per turn, a
 * full message item where the turn is hydrated and a placeholder built from
 * the index row everywhere else. Both carry the turn's index and share the
 * entry id as their Virtua key, so hydration swaps content under a stable
 * key. The normalizations above apply to placeholders from their index row
 * (`itemCount` / `planCount`), and the last-assistant ids come from index
 * rows too, so they never wait on hydration.
 *
 * O(turnCount) in cheap work per rebuild; the only `toJSON` cost is what the
 * caller already hydrated.
 */
export function buildChatStreamItemsFromView(
  view: ConversationView,
  sessionId: SessionId,
  previousCache?: BuildChatStreamItemsCache
): BuildChatStreamItemsResult {
  const builder = createBuilder(sessionId, previousCache);
  for (let turnIndex = 0; turnIndex < view.turnCount; turnIndex += 1) {
    const entry = view.turn(turnIndex);
    if (entry) {
      pushHydratedEntry(builder, entry, turnIndex);
      continue;
    }
    const row = view.index(turnIndex);
    if (!row?.id || isEmptyAssistantRow(row) || builder.seenIds.has(row.id)) continue;
    builder.seenIds.add(row.id);
    if (row.role === 'assistant') noteAssistant(builder, row.id, row.finished);
    builder.items.push(placeholderItem(row, sessionId, turnIndex));
  }
  return finish(builder);
}
