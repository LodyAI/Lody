import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionId } from '@lody/shared';
import {
  buildChatStreamItems,
  type BuildChatStreamItemsCache,
  type BuildChatStreamItemsResult,
} from '@/components/ai-gui/build-chat-stream-items';
import type { VisibleTurnRange } from '@/components/ai-gui/view';
import type { ConversationView } from '@/lib/conversation-view';
import { useConversationVersion, useTurnRange } from './use-conversation-view';

const CHAT_STREAM_ITEMS_CACHE_LIMIT = 20;
const chatStreamItemsCacheBySessionId = new Map<SessionId, BuildChatStreamItemsCache>();

/** Turns hydrated before the viewport reports anything (the conversation opens at its end). */
const INITIAL_WINDOW_TURNS = 40;
/** A viewport shorter than this many turns still prefetches as if it held this many. */
const MIN_SCREEN_TURNS = 8;
/** Screens of turns hydrated on each side of the viewport. */
const PREFETCH_SCREENS = 2;
/** The viewport must move this many turns before the window is recomputed. */
const VISIBLE_RANGE_HYSTERESIS_TURNS = 4;

function getChatStreamItemsCache(sessionId: SessionId): BuildChatStreamItemsCache | undefined {
  return chatStreamItemsCacheBySessionId.get(sessionId);
}

function setChatStreamItemsCache(sessionId: SessionId, cache: BuildChatStreamItemsCache): void {
  chatStreamItemsCacheBySessionId.delete(sessionId);
  chatStreamItemsCacheBySessionId.set(sessionId, cache);
  while (chatStreamItemsCacheBySessionId.size > CHAT_STREAM_ITEMS_CACHE_LIMIT) {
    const oldestSessionId = chatStreamItemsCacheBySessionId.keys().next().value;
    if (oldestSessionId === undefined) break;
    chatStreamItemsCacheBySessionId.delete(oldestSessionId);
  }
}

/**
 * The hydrated window: the viewport plus `PREFETCH_SCREENS` screens on each
 * side, or the conversation's tail before the viewport has reported. The tail
 * itself stays hydrated regardless (the view owns that), so streaming never
 * waits on this window.
 */
export const resolveHydrationWindow = (
  turnCount: number,
  visible: VisibleTurnRange | null
): VisibleTurnRange => {
  if (!visible) return { from: Math.max(0, turnCount - INITIAL_WINDOW_TURNS), to: turnCount };
  const span = Math.max(visible.to - visible.from, MIN_SCREEN_TURNS);
  return {
    from: Math.max(0, visible.from - PREFETCH_SCREENS * span),
    to: Math.min(turnCount, visible.to + PREFETCH_SCREENS * span),
  };
};

export type ConversationStreamItems = BuildChatStreamItemsResult & {
  /** Feed to `SessionChatStreamView.onVisibleTurnRangeChange`. */
  onVisibleTurnRangeChange: (range: VisibleTurnRange) => void;
  /** Feed to `SessionChatStreamView.onOutlinePreviewRound`. */
  onOutlinePreviewRound: (turnIndex: number) => void;
};

/**
 * Everything `SessionChatStreamView` needs from a `ConversationView`: the
 * item list (rebuilt once per frame of view changes), the last-assistant ids,
 * and the two callbacks that drive hydration from the viewport and the
 * outline. Viewport reports arrive per scroll event; the window only moves
 * once the viewport has drifted by the hysteresis, so a settled reader does
 * not churn hydration (and React) on sub-turn scrolling.
 */
export function useConversationStreamItems(
  view: ConversationView | null,
  sessionId: SessionId
): ConversationStreamItems {
  const version = useConversationVersion(view);
  const turnCount = view?.turnCount ?? 0;

  const [visibleRange, setVisibleRange] = useState<VisibleTurnRange | null>(null);
  const onVisibleTurnRangeChange = useCallback((next: VisibleTurnRange) => {
    setVisibleRange((current) => {
      if (
        current &&
        Math.abs(current.from - next.from) < VISIBLE_RANGE_HYSTERESIS_TURNS &&
        Math.abs(current.to - next.to) < VISIBLE_RANGE_HYSTERESIS_TURNS
      ) {
        return current;
      }
      return next;
    });
  }, []);
  const hydrationWindow = useMemo(
    () => resolveHydrationWindow(turnCount, visibleRange),
    [turnCount, visibleRange]
  );
  useTurnRange(view, hydrationWindow.from, hydrationWindow.to, {
    extendToPrecedingUserTurn: true,
  });

  const onOutlinePreviewRound = useCallback(
    (turnIndex: number) => {
      if (!view) return;
      // Hydrating fills the row's summary; the turn may then be evicted again.
      void view.ensureRange(turnIndex, turnIndex + 1).then(() => {
        view.release(turnIndex, turnIndex + 1);
      });
    },
    [view]
  );

  const cacheRef = useRef<BuildChatStreamItemsCache | undefined>(undefined);
  if (cacheRef.current === undefined) {
    cacheRef.current = getChatStreamItemsCache(sessionId);
  }
  const result = useMemo(
    () => buildChatStreamItems(view, sessionId, cacheRef.current),
    // `version` is the change signal for the view's contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, version, sessionId]
  );
  cacheRef.current = result.cache;
  useEffect(() => {
    setChatStreamItemsCache(sessionId, result.cache);
  }, [result.cache, sessionId]);

  return useMemo(
    () => ({ ...result, onVisibleTurnRangeChange, onOutlinePreviewRound }),
    [result, onVisibleTurnRangeChange, onOutlinePreviewRound]
  );
}
