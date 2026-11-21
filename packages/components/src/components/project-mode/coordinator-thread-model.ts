import {
  COORDINATOR_LINKED_SESSIONS_MAX_COUNT,
  extractActionLinkedSessionIds,
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

export function resolveAssistantCausalTurnId(
  assistantTurnId: string,
  explicitUserTurnId?: string
): string | undefined {
  if (explicitUserTurnId && explicitUserTurnId.trim().length > 0) {
    return explicitUserTurnId.trim();
  }
  if (assistantTurnId.startsWith('assistant:')) {
    const rest = assistantTurnId.slice('assistant:'.length).trim();
    if (rest.length > 0) return rest;
  }
  return undefined;
}

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
  const rowById = new Map<string, TurnIndexRow>();
  const assistantIdsByCausalId = new Map<string, string[]>();

  for (const row of indexRows) {
    if (!row?.id) continue;
    rowById.set(row.id, row);
    if (row.role === 'assistant') {
      const causalId = resolveAssistantCausalTurnId(row.id, row.userTurnId);
      if (causalId) {
        const list = assistantIdsByCausalId.get(causalId);
        if (list) list.push(row.id);
        else assistantIdsByCausalId.set(causalId, [row.id]);
      }
    }
  }

  const pushUnique = (seen: Set<string>, list: string[], turnId: string | undefined) => {
    if (!turnId || seen.has(turnId)) return;
    seen.add(turnId);
    list.push(turnId);
  };

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
        if (rootAnchor.kind === 'coordinator_bubble') {
          const assistantRow = rowById.get(rootAnchor.turnId);
          const causalId = resolveAssistantCausalTurnId(
            rootAnchor.turnId,
            assistantRow?.userTurnId
          );
          const causalRow = causalId ? rowById.get(causalId) : undefined;
          if (
            causalRow?.role === 'user' &&
            parseThreadRootsScalar(causalRow.threadRoots).length === 0
          ) {
            pushUnique(seen, list, causalRow.id);
          }
          pushUnique(seen, list, rootAnchor.turnId);
        } else {
          pushUnique(seen, list, rootAnchor.turnId);
          for (const assistantId of assistantIdsByCausalId.get(rootAnchor.turnId) ?? []) {
            pushUnique(seen, list, assistantId);
          }
        }
      }
    }
    pushUnique(seen, list, turnId);
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
 * `threadRootId`, keeping the root message/bubble (plus its opening causal pair
 * when starting from an unthreaded exchange), matching user/coordinator replies,
 * and matching task progress/completion strips while dropping unrelated messages.
 */
export function filterThreadStreamItems(
  items: readonly ChatStreamItem[],
  threadRootId: string
): ChatStreamItem[] {
  const rootAnchor = parseCoordinatorAnchorId(threadRootId);
  if (!rootAnchor) return [];
  const canonicalRootId = formatCoordinatorAnchorId(rootAnchor);

  let openingCausalUserTurnId: string | undefined;
  if (rootAnchor.kind === 'coordinator_bubble') {
    const rootAssistantItem = items.find(
      (
        candidate
      ): candidate is Extract<ChatStreamItem, { type: 'message' }> =>
        candidate.type === 'message' &&
        candidate.message.id === rootAnchor.turnId &&
        candidate.message.role === 'assistant'
    );
    const rootBubble = rootAssistantItem?.message.items.find(
      (entry) => entry.type === 'coordinator_message' && entry.id === rootAnchor.bubbleId
    );
    const rootBubbleReplyTo =
      rootBubble && rootBubble.type === 'coordinator_message' ? rootBubble.replyTo : undefined;
    if (!rootBubbleReplyTo) {
      openingCausalUserTurnId = resolveAssistantCausalTurnId(
        rootAnchor.turnId,
        rootAssistantItem?.message.userTurnId
      );
    }
  }

  const filtered: ChatStreamItem[] = [];
  for (const item of items) {
    if (item.type !== 'message') continue;
    const msg = item.message;

    if (openingCausalUserTurnId && msg.id === openingCausalUserTurnId && msg.role === 'user') {
      const config = normalizeSessionTurnInputConfig(msg.inputConfig);
      const roots = parseThreadRootsScalar(msg.threadRoots);
      if (!config?.replyTo && roots.length === 0) {
        filtered.push(item);
        continue;
      }
    }

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

    if (
      rootAnchor.kind === 'user_turn' &&
      msg.role === 'assistant' &&
      resolveAssistantCausalTurnId(msg.id, msg.userTurnId) === rootAnchor.turnId
    ) {
      const isLiveTurn = msg.finished !== true && typeof msg.endedAt !== 'number';
      const keptItems = msg.items.filter((entry) => {
        if (entry.type === 'coordinator_status') {
          return isLiveTurn;
        }
        if (entry.type !== 'coordinator_message') return false;
        return !entry.replyTo || entry.replyTo.threadRootId === canonicalRootId;
      });
      if (keptItems.length > 0) {
        filtered.push({
          ...item,
          message: { ...msg, items: keptItems },
        });
      }
      continue;
    }

    if (msg.role === 'user') {
      const config = normalizeSessionTurnInputConfig(msg.inputConfig);
      const roots = parseThreadRootsScalar(msg.threadRoots);
      if (config?.replyTo?.threadRootId === canonicalRootId || roots.includes(canonicalRootId)) {
        filtered.push(item);
      }
      continue;
    }

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
        for (const id of extractActionLinkedSessionIds(item.actions)) push(id);
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
