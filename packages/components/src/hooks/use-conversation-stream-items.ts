import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionId } from '@lody/shared';
import {
  buildChatStreamItems,
  type BuildChatStreamItemsCache,
  type BuildChatStreamItemsResult,
} from '@/components/ai-gui/build-chat-stream-items';
import type { VisibleTurnRange } from '@/components/ai-gui/view';
import type { ConversationView } from '@/lib/conversation-view';
import { LRUCache } from '@/lib/lru-cache';
import { useConversationVersion, useTurnRange } from './use-conversation-view';

/** Per-turn render items survive a tab switch; 20 sessions is the working set. */
const chatStreamItemsCacheBySessionId = new LRUCache<SessionId, BuildChatStreamItemsCache>(20);

/** Turns hydrated before the viewport reports anything (the conversation opens at its end). */
const INITIAL_WINDOW_TURNS = 40;
/** A viewport shorter than this many turns still prefetches as if it held this many. */
const MIN_SCREEN_TURNS = 8;
/** Screens of turns hydrated on each side of the viewport. */
const PREFETCH_SCREENS = 2;
/** The viewport must move this many turns before the window is recomputed. */
const VISIBLE_RANGE_HYSTERESIS_TURNS = 4;

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
  /** Initial window has settled; later window changes do not hide the stream. */
  initialWindowReady: boolean;
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

  // Projection wrappers change as accepted turns reconcile. Only replacing the
  // underlying conversation starts a new initial load or resets its read window.
  const source = view?.factSource ?? view;
  const initialRef = useRef({ source, ready: false });
  if (initialRef.current.source !== source) initialRef.current = { source, ready: false };
  const [visible, setVisibleRange] = useState<{
    source: ConversationView;
    range: VisibleTurnRange;
  } | null>(null);
  const visibleRange = visible?.source === source ? visible.range : null;
  const onVisibleTurnRangeChange = useCallback(
    (next: VisibleTurnRange) => {
      if (!source || !initialRef.current.ready) return;
      setVisibleRange((current) => {
        if (
          current?.source === source &&
          Math.abs(current.range.from - next.from) < VISIBLE_RANGE_HYSTERESIS_TURNS &&
          Math.abs(current.range.to - next.to) < VISIBLE_RANGE_HYSTERESIS_TURNS
        ) {
          return current;
        }
        return { source, range: next };
      });
    },
    [source]
  );
  const hydrationWindow = useMemo(
    () => resolveHydrationWindow(turnCount, visibleRange),
    [turnCount, visibleRange]
  );
  const rangeReady = useTurnRange(view, hydrationWindow.from, hydrationWindow.to, {
    extendToPrecedingUserTurn: true,
  });
  if (rangeReady) initialRef.current.ready = true;
  const initialWindowReady = !!view && initialRef.current.ready;

  const previewRangeRef = useRef<ReturnType<ConversationView['acquireRange']> | null>(null);
  useEffect(
    () => () => {
      previewRangeRef.current?.release();
      previewRangeRef.current = null;
    },
    [view]
  );
  const onOutlinePreviewRound = useCallback(
    (turnIndex: number) => {
      if (!view || !view.index(turnIndex)) return;
      previewRangeRef.current?.release();
      // A round includes its user question and replies up to the next user.
      let end = turnIndex + 1;
      while (end < view.turnCount && view.index(end)?.role !== 'user') end++;
      const range = view.acquireRange(turnIndex, end);
      previewRangeRef.current = range;
      const release = () => {
        range.release();
        if (previewRangeRef.current === range) previewRangeRef.current = null;
      };
      // A failed preview must not become an unhandled rejected promise.
      void range.ready.then(release, release);
    },
    [view]
  );

  const cacheRef = useRef<BuildChatStreamItemsCache | undefined>(undefined);
  if (cacheRef.current === undefined) {
    cacheRef.current = chatStreamItemsCacheBySessionId.get(sessionId);
  }
  const previousResultRef = useRef<BuildChatStreamItemsResult | null>(null);
  const result = useMemo(() => {
    const next = buildChatStreamItems(view, sessionId, cacheRef.current);
    // Virtual rows, the outline and its anchors all recompute on this array's
    // identity, and the view's version bumps at token rate. Per-turn items are
    // already memoized, so an unchanged conversation rebuilds an array of the
    // same entries — hand back the previous array instead and the whole chain
    // below it short-circuits.
    const previous = previousResultRef.current;
    const reusable =
      previous !== null &&
      previous.lastAssistantMessageId === next.lastAssistantMessageId &&
      previous.lastCompletedAssistantMessageId === next.lastCompletedAssistantMessageId &&
      previous.items.length === next.items.length &&
      previous.items.every((item, index) => item === next.items[index]);
    const settled = reusable ? previous : next;
    previousResultRef.current = settled;
    return settled;
    // `version` is the change signal for the view's contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, version, sessionId]);
  cacheRef.current = result.cache;
  useEffect(() => {
    chatStreamItemsCacheBySessionId.set(sessionId, result.cache);
  }, [result.cache, sessionId]);

  return useMemo(
    () => ({ ...result, initialWindowReady, onVisibleTurnRangeChange, onOutlinePreviewRound }),
    [result, initialWindowReady, onVisibleTurnRangeChange, onOutlinePreviewRound]
  );
}
