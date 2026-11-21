import {
  COORDINATOR_LINKED_SESSIONS_MAX_COUNT,
  extractLinkedSessionIdsFromText,
  formatCoordinatorAnchorId,
  normalizeSessionTurnInputConfig,
  parseCoordinatorAnchorId,
  parseThreadRootsScalar,
  type MessageContent,
  type OperationCompletionContent,
  type SessionHistoryParsed,
  type SessionId,
} from '@lody/shared';
import type { ChatStreamItem } from '@/components/ai-gui/view';
import type { TurnIndexRow } from '@/lib/conversation-view';

export const COORDINATOR_THREAD_PANEL_TAB_PREFIX = 'coordinator-thread:';

export function getCoordinatorThreadPanelTabId(threadRootId: string): string {
  return `${COORDINATOR_THREAD_PANEL_TAB_PREFIX}${threadRootId}`;
}

export function parseCoordinatorThreadPanelTabId(tabId: string): string | null {
  if (!tabId.startsWith(COORDINATOR_THREAD_PANEL_TAB_PREFIX)) return null;
  const raw = tabId.slice(COORDINATOR_THREAD_PANEL_TAB_PREFIX.length).trim();
  const parsed = parseCoordinatorAnchorId(raw);
  return parsed ? formatCoordinatorAnchorId(parsed) : null;
}

export type CoordinatorThreadDirectoryIndex = {
  readonly replyCountByRootId: ReadonlyMap<string, number>;
  readonly turnIdsByRootId: ReadonlyMap<string, readonly string[]>;
};

/**
 * Builds the O(N) directory-only index for coordinator threads without forcing
 * turn-body hydration across long conversations.
 */
export function buildCoordinatorThreadDirectoryIndex(
  indexRows: readonly TurnIndexRow[]
): CoordinatorThreadDirectoryIndex {
  const replyCountByRootId = new Map<string, number>();
  const turnIdsByRootId = new Map<string, string[]>();
  const seenTurnIdsByRootId = new Map<string, Set<string>>();

  const addTurn = (rootId: string, turnId: string) => {
    let seen = seenTurnIdsByRootId.get(rootId);
    let list = turnIdsByRootId.get(rootId);
    if (!seen || !list) {
      seen = new Set<string>();
      list = [];
      seenTurnIdsByRootId.set(rootId, seen);
      turnIdsByRootId.set(rootId, list);
      const rootAnchor = parseCoordinatorAnchorId(rootId);
      if (rootAnchor) {
        seen.add(rootAnchor.turnId);
        list.push(rootAnchor.turnId);
      }
    }
    if (!seen.has(turnId)) {
      seen.add(turnId);
      list.push(turnId);
    }
  };

  for (const row of indexRows) {
    if (!row?.id) continue;
    const roots = parseThreadRootsScalar(row.threadRoots);
    if (roots.length === 0) continue;
    for (const rootId of roots) {
      addTurn(rootId, row.id);
      if (row.role === 'user' || row.role === 'assistant') {
        replyCountByRootId.set(rootId, (replyCountByRootId.get(rootId) ?? 0) + 1);
      }
    }
  }

  return { replyCountByRootId, turnIdsByRootId };
}

/**
 * Projects a sequence of `ChatStreamItem`s down to the single thread named by
 * `threadRootId`, keeping the root message/bubble, matching user/coordinator
 * replies, and matching task progress/completion strips while dropping
 * unrelated messages.
 */
export function filterThreadStreamItems(
  items: readonly ChatStreamItem[],
  threadRootId: string
): ChatStreamItem[] {
  const rootAnchor = parseCoordinatorAnchorId(threadRootId);
  if (!rootAnchor) return [];
  const canonicalRootId = formatCoordinatorAnchorId(rootAnchor);

  const filtered: ChatStreamItem[] = [];
  for (const item of items) {
    if (item.type !== 'message') continue;
    const msg = item.message;

    // 1. Root turn itself
    if (msg.id === rootAnchor.turnId) {
      if (rootAnchor.kind === 'user_turn' && msg.role === 'user') {
        filtered.push(item);
        continue;
      }
      if (rootAnchor.kind === 'coordinator_bubble' && msg.role === 'assistant') {
        const keptItems = msg.items.filter((entry) => {
          if (entry.type === 'coordinator_status') {
            return msg.finished !== true && typeof msg.endedAt !== 'number';
          }
          if (entry.type !== 'coordinator_message') return false;
          if (entry.id === rootAnchor.bubbleId) return true;
          return entry.replyTo?.threadRootId === canonicalRootId;
        });
        if (keptItems.length > 0) {
          filtered.push({
            ...item,
            message: { ...msg, items: keptItems },
          });
        }
        continue;
      }
    }

    // 2. Subsequent user turns
    if (msg.role === 'user') {
      const config = normalizeSessionTurnInputConfig(msg.inputConfig);
      const roots = parseThreadRootsScalar(msg.threadRoots);
      if (config?.replyTo?.threadRootId === canonicalRootId || roots.includes(canonicalRootId)) {
        filtered.push(item);
      }
      continue;
    }

    // 3. Subsequent assistant turns (keep only bubbles belonging to this thread)
    if (msg.role === 'assistant') {
      const roots = parseThreadRootsScalar(msg.threadRoots);
      const isLiveThreadTurn =
        msg.finished !== true && typeof msg.endedAt !== 'number' && roots.includes(canonicalRootId);
      const keptItems = msg.items.filter((entry) => {
        if (entry.type === 'coordinator_status') {
          return isLiveThreadTurn;
        }
        if (entry.type === 'system_notice') {
          return roots.includes(canonicalRootId);
        }
        if (entry.type !== 'coordinator_message') return false;
        return entry.replyTo?.threadRootId === canonicalRootId;
      });
      if (keptItems.length > 0) {
        filtered.push({
          ...item,
          message: { ...msg, items: keptItems },
        });
      }
      continue;
    }

    // 4. System turns (`operation_progress`, `operation_completion`, `operation_completion_batch`)
    if (msg.role === 'system') {
      const keptSystemItems: MessageContent[] = [];
      for (const entry of msg.items) {
        if (entry.type === 'operation_progress') {
          if (entry.originThreadId === canonicalRootId) {
            keptSystemItems.push(entry);
          }
        } else if (entry.type === 'operation_completion') {
          if (entry.originThreadId === canonicalRootId) {
            keptSystemItems.push(entry);
          }
        } else if (entry.type === 'operation_completion_batch') {
          const matchingMembers = (entry.members ?? []).filter(
            (member) => member.originThreadId === canonicalRootId
          );
          if (matchingMembers.length > 0) {
            keptSystemItems.push({
              ...entry,
              memberCount: matchingMembers.length,
              members: matchingMembers,
            });
          }
        }
      }
      if (keptSystemItems.length > 0) {
        filtered.push({
          ...item,
          message: { ...msg, items: keptSystemItems },
        });
      }
    }
  }

  return filtered;
}

function collectCompletionTargets(
  completion: OperationCompletionContent['completion'] | undefined,
  push: (id: SessionId) => void
) {
  const resultItems =
    completion?.type === 'result'
      ? completion.value.items
      : completion?.type === 'cancelled'
        ? (completion.partial?.items ?? [])
        : [];
  for (const res of resultItems) {
    if ('target' in res && res.target?.sessionId) {
      push(res.target.sessionId);
    }
  }
}

/**
 * Extracts all child `SessionId`s linked inside a filtered thread's turns (via
 * `operation_progress`, `operation_completion`, `linkedSessionIds`, or
 * `lody://session/...` Markdown links).
 */
export function collectThreadLinkedSessionIds(
  threadMessages: readonly SessionHistoryParsed[]
): SessionId[] {
  const ids: SessionId[] = [];
  const seen = new Set<string>();
  const push = (id: SessionId | undefined) => {
    if (!id || seen.has(id) || ids.length >= COORDINATOR_LINKED_SESSIONS_MAX_COUNT) return;
    seen.add(id);
    ids.push(id);
  };

  for (const msg of threadMessages) {
    for (const item of msg.items) {
      if (item.type === 'coordinator_message') {
        for (const id of item.linkedSessionIds ?? []) push(id);
        for (const id of extractLinkedSessionIdsFromText(item.body)) push(id);
      } else if (item.type === 'operation_progress') {
        for (const entry of item.items) {
          push(entry.target.sessionId);
        }
      } else if (item.type === 'operation_completion') {
        collectCompletionTargets(item.completion, push);
      } else if (item.type === 'operation_completion_batch') {
        for (const member of item.members ?? []) {
          collectCompletionTargets(member.completion, push);
        }
      } else if (item.type === 'text') {
        for (const id of extractLinkedSessionIdsFromText(item.text)) push(id);
      }
    }
  }

  return ids;
}
